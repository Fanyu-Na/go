/* POST /api/room   body: {game: "go"|"gomoku", size, komi}
   -> {code, token, color}
   创建房间: 生成唯一 5 位房间码并把初始状态写入 Vercel Blob. */
const lib = require("./_lib.js");

module.exports = async (req, res) => {
  try {
    if (req.method !== "POST") { return lib.json(res, 405, { error: "Method Not Allowed" }); }
    const body = lib.parseBody(req);
    const game = body.game === "gomoku" ? "gomoku" : "go";
    let size = parseInt(body.size, 10);
    if (game === "go") {
      if (lib.GO_SIZES.indexOf(size) < 0) { size = 9; }
    } else {
      size = lib.GOMOKU_SIZE;
    }
    const komi = game === "go"
      ? (typeof body.komi === "number" ? body.komi : lib.GO_KOMI[size])
      : 0;

    /* 随机房间码需查重 (覆盖到已有房间会顶掉别人的棋局) */
    let code = null;
    for (let i = 0; i < 6 && !code; i++) {
      const cand = lib.genCode();
      try { await lib.loadRoom(cand); } catch (e) { code = cand; }
    }
    if (!code) { return lib.json(res, 500, { error: "创建房间失败，请重试" }); }

    const now = Date.now();
    const state = {
      code: code,
      game: game,
      size: size,
      komi: komi,
      blackToken: lib.genToken(),
      whiteToken: null,       // 白方席位在 join 时分配
      moves: [],
      resigned: null,
      req: null,              // {kind: "undo"|"restart", from: 1|2}
      reqResult: null,        // {kind, accepted} 请求方的回执
      resultVersion: 0,
      version: 1,
      created: now
    };
    await lib.saveRoom(state);
    await lib.savePresence(code, { blackSeen: now });
    lib.json(res, 200, { code: code, token: state.blackToken, color: 1 });
  } catch (e) {
    lib.json(res, 500, { error: (e && e.message) || "创建房间失败" });
  }
};
