/* 房间操作接口: POST /api/room/{code}   body: {op, token, ...}
   op = join | poll | move | resign | req | ack | close
   服务器为权威端: 每次落子都重放完整动作序列, 「轮到谁 / 是否合法 /
   终局与否」全部由引擎判定; 双方仅凭 token 认席位, 刷新页面可恢复. */
const lib = require("../_lib.js");

async function touchPresence(code, color, now) {
  const p = await lib.loadPresence(code);
  if (color === 1) { p.blackSeen = now; } else { p.whiteSeen = now; }
  await lib.savePresence(code, p);
  return p;
}

async function okState(res, state, presence) {
  lib.json(res, 200, {
    state: lib.publicState(state, presence || await lib.loadPresence(state.code))
  });
}

module.exports = async (req, res) => {
  try {
    const code = String((req.query && req.query.code) || "").toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) {
      return lib.json(res, 400, { error: "房间码格式不正确" });
    }

    let state;
    try {
      state = await lib.loadRoom(code);
    } catch (e) {
      if (!process.env.BLOB_READ_WRITE_TOKEN) {
        return lib.json(res, 500, {
          error: "未连接 Blob 存储：请在 Vercel 项目 → Storage 里关联一个 Blob Store（见 README），重新部署即可联机"
        });
      }
      return lib.json(res, 404, { error: "房间不存在或已关闭" });
    }

    const body = lib.parseBody(req);
    const op = body.op || "";
    const token = String(body.token || "");
    const color = state.blackToken === token ? 1 :
      (state.whiteToken === token ? 2 : 0);
    const now = Date.now();

    switch (op) {
      /* ---- 加入 / 重连: 有 token 则认回原席位 ---- */
      case "join": {
        if (color) {
          const presence = await touchPresence(code, color, now);
          return lib.json(res, 200, {
            token: token,
            color: color,
            state: lib.publicState(state, presence)
          });
        }
        if (state.whiteToken) {
          return lib.json(res, 409, { error: "房间已满（黑白双方已就座）" });
        }
        state.whiteToken = lib.genToken();
        state.version += 1;
        await lib.saveRoom(state);
        const presence = await lib.loadPresence(code);
        presence.whiteSeen = now;
        await lib.savePresence(code, presence);
        return lib.json(res, 200, {
          token: state.whiteToken,
          color: 2,
          state: lib.publicState(state, presence)
        });
      }

      /* ---- 轮询: 返回最新状态; 顺带刷新心跳 (>5s 才写, 控制写入量) ---- */
      case "poll": {
        if (!color) { return lib.json(res, 401, { error: "会话无效，请重新加入房间" }); }
        const p = await lib.loadPresence(code);
        const key = color === 1 ? "blackSeen" : "whiteSeen";
        if (now - (p[key] || 0) > 5000) {
          p[key] = now;
          await lib.savePresence(code, p);
        }
        return lib.json(res, 200, { state: lib.publicState(state, p) });
      }

      /* ---- 落子 / 停一手: 服务器校验后生效, 响应直接带回新状态 ---- */
      case "move": {
        if (!color) { return lib.json(res, 401, { error: "会话无效，请重新加入房间" }); }
        if (state.resigned != null) {
          return lib.json(res, 409, { error: "对局已结束" });
        }
        const action = typeof body.action === "number" ? body.action : NaN;
        const env = lib.replay(state, state.moves);
        if (env.done) { return lib.json(res, 409, { error: "对局已结束" }); }
        if (env.toPlay !== color) { return lib.json(res, 409, { error: "还没轮到你落子" }); }
        if (!env.isLegal(action)) {
          return lib.json(res, 400, { error: "此处不能落子" });
        }
        env.play(action);
        state.moves.push(action);
        state.version += 1;
        await lib.saveRoom(state);
        const presence = await touchPresence(code, color, now);
        return await okState(res, state, presence);
      }

      /* ---- 认输 ---- */
      case "resign": {
        if (!color) { return lib.json(res, 401, { error: "会话无效，请重新加入房间" }); }
        if (state.resigned != null) { return lib.json(res, 409, { error: "对局已结束" }); }
        state.resigned = color;
        state.req = null;
        state.version += 1;
        await lib.saveRoom(state);
        const presence = await touchPresence(code, color, now);
        return await okState(res, state, presence);
      }

      /* ---- 悔棋 / 再来一局: 发起请求, 对方 ack ---- */
      case "req": {
        if (!color) { return lib.json(res, 401, { error: "会话无效，请重新加入房间" }); }
        const kind = body.kind === "undo" || body.kind === "restart" ? body.kind : null;
        if (!kind) { return lib.json(res, 400, { error: "未知请求类型" }); }
        if (state.resigned != null) {
          return lib.json(res, 409, { error: "对局已结束，无法发起请求" });
        }
        if (state.req) { return lib.json(res, 409, { error: "已有待对方处理的请求" }); }
        if (kind === "undo" && !state.moves.length) {
          return lib.json(res, 400, { error: "还没有可悔的棋" });
        }
        state.req = { kind: kind, from: color };
        state.version += 1;
        await lib.saveRoom(state);
        return await okState(res, state);
      }

      case "ack": {
        if (!color) { return lib.json(res, 401, { error: "会话无效，请重新加入房间" }); }
        if (!state.req) { return lib.json(res, 409, { error: "没有待处理的请求" }); }
        if (state.req.from === color) {
          return lib.json(res, 400, { error: "不能应答自己的请求" });
        }
        const kind = state.req.kind;
        const accept = !!body.accept;
        if (accept && kind === "undo" && state.moves.length) {
          state.moves.pop();
        }
        if (accept && kind === "restart") {
          state.moves = [];
          state.resigned = null;
        }
        state.reqResult = { kind: kind, accepted: accept };
        state.resultVersion = state.version;
        state.req = null;
        state.version += 1;
        await lib.saveRoom(state);
        return await okState(res, state);
      }

      /* ---- 关闭房间 (主动断开时调用, 对方下一轮询将看到 404) ---- */
      case "close": {
        if (!color) { return lib.json(res, 401, { error: "会话无效，请重新加入房间" }); }
        await lib.delRoom(code);
        return lib.json(res, 200, { ok: true });
      }

      default:
        return lib.json(res, 400, { error: "未知操作" });
    }
  } catch (e) {
    lib.json(res, 500, { error: (e && e.message) || "服务器错误" });
  }
};
