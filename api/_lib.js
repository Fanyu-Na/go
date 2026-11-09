/* 联机中继共享逻辑 (api/ 下以 _ 开头的文件不会暴露为 HTTP 接口).
   架构: 房间状态整体存 Vercel Blob (强一致), 着法序列 + 协商元数据;
   在线心跳存独立的 .presence.json, 避免高频心跳写入与落子写入互相覆盖.
   服务器用与前端完全相同的规则引擎 (js/go_env.js / js/gomoku_env.js,
   均已兼容 Node require) 重放动作序列来校验着法, 天然防作弊. */

"use strict";

const crypto = require("crypto");
const { put, get, del } = require("@vercel/blob");

require("../js/go_env.js");
require("../js/gomoku_env.js");

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

async function readText(blob) {
  if (blob && typeof blob.text === "function") { return blob.text(); }
  return String(blob && blob.body != null ? blob.body : "");
}

async function loadRoom(code) {
  checkBlobConfigured();
  const blob = await get(roomPath(code));
  return JSON.parse(await readText(blob));
}

async function loadPresence(code) {
  try {
    const blob = await get(presencePath(code));
    const p = JSON.parse(await readText(blob));
    return p && typeof p === "object" ? p : {};
  } catch (e) {
    return {};      // 无心跳文件 = 双方都还没活动过
  }
}

async function saveRoom(state) {
  checkBlobConfigured();
  await put(roomPath(state.code), JSON.stringify(state), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json"
  });
}

async function savePresence(code, presence) {
  await put(presencePath(code), JSON.stringify(presence), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json"
  });
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

module.exports = {
  ALPHABET: ALPHABET,
  GO_SIZES: GO_SIZES,
  GO_KOMI: GO_KOMI,
  GOMOKU_SIZE: GOMOKU_SIZE,
  genCode: genCode,
  genToken: genToken,
  newEnv: newEnv,
  replay: replay,
  loadRoom: loadRoom,
  loadPresence: loadPresence,
  saveRoom: saveRoom,
  savePresence: savePresence,
  delRoom: delRoom,
  publicState: publicState,
  parseBody: parseBody,
  json: json
};
