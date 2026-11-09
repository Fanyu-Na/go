/* SGF 棋谱: 保存 / 下载 / 解析 (纯前端实现, 不依赖 sgfmill).
   围棋 GM[1] 中国规则带 KM/RU/OT; 五子棋 GM[4] RU[Freestyle].
   SGF 坐标: 小写字母, 列在前行在后, 左上角原点; pass 记 tt (<=19 路) 或空值.
   解析只取主变 —— 每个分叉跟随第一个孩子, 与 sgfmill.get_main_sequence 一致. */

(function (global) {
  "use strict";

  var LETTERS = "abcdefghijklmnopqrstuvwxyz";

  function pad2(v) { return v < 10 ? "0" + v : "" + v; }

  function coord(action, size, passAction) {
    if (action === passAction) { return size <= 19 ? "tt" : ""; }
    var row = Math.floor(action / size);
    var col = action % size;
    return LETTERS.charAt(col) + LETTERS.charAt(row);
  }

  function coordToAction(value, size, passAction) {
    var v = (value || "").trim().toLowerCase();
    if (v === "") { return passAction; }
    if (v === "tt" && size <= 19) { return passAction; }
    if (v.length !== 2) { throw new Error("坐标「" + value + "」无法解析"); }
    var col = v.charCodeAt(0) - 97;
    var row = v.charCodeAt(1) - 97;
    if (!(col >= 0 && col < size && row >= 0 && row < size)) {
      throw new Error("坐标「" + value + "」超出 " + size + " 路棋盘");
    }
    return row * size + col;
  }

  function save(meta) {
    var isGo = meta.game === "go";
    var head = "(;GM[" + (isGo ? "1" : "4") + "]FF[4]CA[UTF-8]AP[GoFrontend]ST[2]" +
      "SZ[" + meta.size + "]";
    if (isGo) {
      head += "KM[" + meta.komi + "]RU[Chinese]OT[?]";
    } else {
      head += "RU[Freestyle]";
    }
    var body = "";
    meta.moves.forEach(function (m) {
      body += ";" + (m.player === 1 ? "B" : "W") + "[" +
        coord(m.action, meta.size, meta.passAction) + "]";
    });
    return head + body + ")";
  }

  function filename() {
    var d = new Date();
    return "game_" + d.getFullYear() + pad2(d.getMonth() + 1) + pad2(d.getDate()) +
      "_" + pad2(d.getHours()) + pad2(d.getMinutes()) + pad2(d.getSeconds()) + ".sgf";
  }

  function download(fname, text) {
    var blob = new Blob([text], { type: "application/x-go-sgf" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = fname;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      if (a.parentNode) { a.parentNode.removeChild(a); }
      URL.revokeObjectURL(url);
    }, 0);
  }

  /* 读取 [ ... ] 属性值, 处理 \] 与 \\ 转义 */
  function readValue(text, i, n) {
    i++;
    var out = "";
    while (i < n) {
      var ch = text.charAt(i);
      if (ch === "\\") {
        if (i + 1 < n) { out += text.charAt(i + 1); i += 2; continue; }
        i++;
        continue;
      }
      if (ch === "]") { i++; break; }
      out += ch;
      i++;
    }
    return { value: out, next: i };
  }

  function parse(text) {
    if (typeof text !== "string" || !text.length) {
      throw new Error("文件内容为空");
    }
    var n = text.length;
    var i = 0;
    while (i < n && text.charAt(i) !== ";") { i++; }
    if (i >= n) { throw new Error("未找到 SGF 节点，格式无效"); }

    var root = {};
    var moves = [];
    var depth = 0;
    var childCount = {};
    var skipping = false;
    var skipOpen = 0;
    var rootSeen = false;
    var firstNode = true;

    while (i < n) {
      var ch = text.charAt(i);
      if (ch === ";") {
        i++;
        if (!rootSeen) { rootSeen = true; } else { firstNode = false; }
        continue;
      }
      if (ch === "(") {
        childCount[depth] = (childCount[depth] || 0) + 1;
        depth += 1;
        if (!skipping && childCount[depth - 1] > 1) {
          skipping = true;
          skipOpen = depth;
        }
        i++;
        continue;
      }
      if (ch === ")") {
        depth -= 1;
        if (skipping && depth < skipOpen) { skipping = false; }
        i++;
        continue;
      }
      if (ch === "[") {
        i = readValue(text, i, n).next;
        continue;
      }
      if (/\s/.test(ch)) { i++; continue; }
      var start = i;
      while (i < n && /[A-Za-z]/.test(text.charAt(i))) { i++; }
      if (i === start) { i++; continue; }
      var key = text.slice(start, i).toUpperCase();
      var values = [];
      while (i < n) {
        while (i < n && /\s/.test(text.charAt(i))) { i++; }
        if (text.charAt(i) === "[") {
          var res = readValue(text, i, n);
          values.push(res.value);
          i = res.next;
        } else { break; }
      }
      if (skipping) { continue; }
      if (key === "B" || key === "W") {
        if (values.length) {
          moves.push({ player: key === "B" ? 1 : 2, coord: values[0] });
        }
      } else if (values.length && firstNode) {
        if (!(key in root)) { root[key] = values[0]; }
      }
    }

    var gm = root.GM != null ? String(root.GM).trim() : "";
    var game;
    if (gm === "1" || gm === "") { game = "go"; }
    else if (gm === "4") { game = "gomoku"; }
    else { throw new Error("暂不支持 GM[" + gm + "] 对应的棋种"); }

    var size = parseInt(root.SZ || "", 10);
    if (!(size >= 2 && size <= 26)) { size = game === "gomoku" ? 15 : 19; }

    var komi = null;
    if (game === "go" && root.KM != null && root.KM !== "") {
      var k = parseFloat(root.KM);
      if (!isNaN(k)) { komi = k; }
    }

    var passAction = size * size;
    var out = [];
    for (var m = 0; m < moves.length; m++) {
      out.push({
        player: moves[m].player,
        action: coordToAction(moves[m].coord, size, passAction)
      });
    }
    if (!out.length) { throw new Error("棋谱中没有着法"); }
    return { game: game, size: size, komi: komi, moves: out };
  }

  global.SGF = {
    save: save,
    parse: parse,
    coord: coord,
    coordToAction: coordToAction,
    download: download,
    filename: filename
  };
})(window);
