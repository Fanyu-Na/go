/* 联机中继共享逻辑 (api/ 下以 _ 开头的文件不会暴露为 HTTP 接口).
   注意: package.json 声明了 "type": "module", 本目录全部按 ESM 解析;
   js/go_env.js、js/gomoku_env.js 是无 import/export 的经典脚本,
   被当作 ESM 导入时同样会执行并把引擎挂到 globalThis (浏览器行为一致).
   房间状态整体存 Vercel Blob (强一致); 在线心跳存独立的 .presence.json,
   避免高频心跳写入与落子写入互相覆盖. 服务器用与前端同一套引擎重放
   动作序列校验着法, 天然防作弊. */

import crypto from "node:crypto";
import { put, get, del, head } from "@vercel/blob";
import "../js/go_env.js";
import "../js/gomoku_env.js";

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";   // 去掉 0/O/1/I/L 易混字符
const GO_SIZES = [9, 13, 19];
const GO_KOMI = { 9: 5.5, 13: 6.5, 19: 7.5 };
const GOMOKU_SIZE = 15;

function genCode() {
  let s = "";
  for (let i = 0; i < 5; i++) { s += ALPHABET[crypto.randomInt(ALPHABET.length)]; }
  return s;
}

function genToken() {
  return crypto.randomBytes(16).toString("hex");
}

function roomPath(code) { return "rooms/" + code + ".json"; }
function presencePath(code) { return "rooms/" + code + ".presence.json"; }

function checkBlobConfigured() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    throw new Error("未连接 Blob 存储：请在 Vercel 项目 → Storage 里关联一个 Blob Store（见 README），重新部署即可联机");
  }
}

/* Blob Store 的访问类型: 初始猜测取环境变量 BLOB_ACCESS (默认 private),
   若与 Store 实际配置不符会自动切换并记住 —— 公有/私有 Store 都能工作. */
let _blobAccess = process.env.BLOB_ACCESS === "public" ? "public" : "private";

async function putBlob(pathname, body) {
  const order = _blobAccess === "public" ? ["public", "private"] : ["private", "public"];
  let lastErr = null;
  for (let i = 0; i < order.length; i++) {
    try {
      return await put(pathname, body, {
        access: order[i],
        addRandomSuffix: false,
        contentType: "application/json"
      });
    } catch (e) {
      lastErr = e;
      /* 仅当是「访问类型不匹配」时才换另一种重试; 其他错误原样抛出 */
      if (!/access/i.test(String(e && e.message || ""))) { throw e; }
    }
  }
  _blobAccess = order[0];   // 两种都失败则还原猜测, 下次再试
  throw lastErr;
}

function newEnv(meta) {
  if (meta.game === "go") {
    return new globalThis.GoEnv({
      boardSize: meta.size,
      komi: meta.komi,
      maxMoves: 2 * meta.size * meta.size
    });
  }
  return new globalThis.GomokuEnv({ boardSize: meta.size });
}

/* 从动作序列重建引擎 (校验着法用) */
function replay(meta, moves) {
  const env = newEnv(meta);
  for (let i = 0; i < moves.length; i++) { env.play(moves[i]); }
  return env;
}

/* 从 Blob 结果对象里取出文本; 单种形态失败返回 "" 由上层换下一种 */
async function textOf(blob) {
  try {
    if (typeof blob === "string") {              // 极少数版本直接返回 URL
      const res = await fetch(blob);
      return await res.text();
    }
    if (blob && typeof blob.text === "function") {
      const t = await blob.text();
      if (t && String(t).trim()) { return String(t); }
    }
    if (blob && typeof blob.url === "string") {  // 经 (签名/公有) URL 取内容
      const res = await fetch(blob.url);
      return await res.text();
    }
    if (blob && typeof blob.body === "string") { return blob.body; }
  } catch (e) { /* 落到空串 */ }
  return "";
}

/* 读取 Blob 文本, 兼容各版本 SDK 的返回形态与必填参数:
   1) get(path) 无参 → 2) get(path, {access: 已记住的类型}) → 3) head(path)+fetch.
   每种形态会打到 Vercel Logs, 便于定位. 房间不存在 (BlobNotFoundError) 直接抛. */
async function readBlobText(pathname) {
  const tries = [
    function () { return get(pathname); },
    function () { return get(pathname, { access: _blobAccess }); },
    function () { return head(pathname); }
  ];
  let lastErr = null;
  for (let i = 0; i < tries.length; i++) {
    let blob = null;
    try {
      blob = await tries[i]();
    } catch (e) {
      lastErr = e;
      if (!/missing options|access/i.test(String(e && e.message || ""))) { throw e; }
      continue;
    }
    console.log("[blob] 读取", pathname, "形态" + i + ":",
      blob === null || blob === undefined ? String(blob) :
        (typeof blob === "string" ? "url-string" : Object.keys(blob).join(",")));
    const raw = await textOf(blob);
    if (raw && raw.trim()) { return raw; }
    lastErr = new Error("读取 " + pathname + " 内容为空 (形态 " + i + ")");
  }
  throw lastErr;
}

async function loadRoom(code) {
  checkBlobConfigured();
  return JSON.parse(await readBlobText(roomPath(code)));
}

async function loadPresence(code) {
  try {
    const p = JSON.parse(await readBlobText(presencePath(code)));
    return p && typeof p === "object" ? p : {};
  } catch (e) {
    return {};      // 无心跳文件 = 双方都还没活动过
  }
}

async function saveRoom(state) {
  checkBlobConfigured();
  await putBlob(roomPath(state.code), JSON.stringify(state));
}

async function savePresence(code, presence) {
  await putBlob(presencePath(code), JSON.stringify(presence));
}

async function delRoom(code) {
  try { await del(roomPath(code)); } catch (e) { /* 已不存在 */ }
  try { await del(presencePath(code)); } catch (e) { /* 已不存在 */ }
}

/* 客户端可见的房间快照 (不暴露 token); now 为服务器时间戳,
   客户端用它换算对方最后活跃时刻 (免受本机时钟偏差影响). */
function publicState(state, presence) {
  presence = presence || {};
  return {
    version: state.version,
    game: state.game,
    size: state.size,
    komi: state.komi,
    moves: state.moves,
    resigned: state.resigned,
    req: state.req,
    reqResult: state.reqResult,
    resultVersion: state.resultVersion,
    guestReady: !!state.whiteToken,
    blackSeen: presence.blackSeen || 0,
    whiteSeen: presence.whiteSeen || 0,
    now: Date.now()
  };
}

function parseBody(req) {
  try {
    if (typeof req.body === "string") { return JSON.parse(req.body); }
  } catch (e) { /* 落入默认 */ }
  return req.body && typeof req.body === "object" ? req.body : {};
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

export {
  ALPHABET, GO_SIZES, GO_KOMI, GOMOKU_SIZE,
  genCode, genToken, newEnv, replay,
  loadRoom, loadPresence, saveRoom, savePresence, delRoom,
  publicState, parseBody, json
};
