/* 界面层: 公共工具 + 模态确认框 + 棋盘画布 + 主菜单.
   棋盘绘制移植自桌面版 gui/board_render.py (木纹 / 网格 / 星位 / 棋子 / 数子点
   / 劫点标记 / 悬停影子 / AI 预测脉冲), 几何参数与其完全一致. */

(function (global) {
  "use strict";

  var COL_LETTERS = "ABCDEFGHJKLMNOPQRSTUVWXYZ";   // 跳过字母 I
  var dialogCount = 0;

  function pad2(v) { return v < 10 ? "0" + v : "" + v; }

  /* 动作 -> 显示坐标 (字母列 + 自下而上行号), 例如 D4 */
  function coordText(action, size) {
    if (action == null || action < 0) { return "—"; }
    var row = Math.floor(action / size);
    var col = action % size;
    return COL_LETTERS.charAt(col) + (size - row);
  }

  /* 星位: >=15 路 3x3 九点, 否则四角 + 天元 (移植自桌面版) */
  function starPoints(size) {
    var edge = size >= 13 ? 3 : 2;
    var mid = (size - 1) / 2;
    var anchors = [edge, size - 1 - edge];
    if (size >= 15 && Number.isInteger(mid)) { anchors.push(mid); }
    var seen = {};
    var out = [];
    for (var r = 0; r < anchors.length; r++) {
      for (var c = 0; c < anchors.length; c++) {
        var key = anchors[r] * size + anchors[c];
        if (!seen[key]) { seen[key] = true; out.push(key); }
      }
    }
    if (size < 15 && Number.isInteger(mid)) {
      var center = mid * size + mid;
      if (!seen[center]) { seen[center] = true; out.push(center); }
    }
    return out;
  }

  function formatDuration(totalSec) {
    var s = Math.max(0, Math.round(totalSec));
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) { return h + ":" + pad2(m) + ":" + pad2(sec); }
    return pad2(m) + ":" + pad2(sec);
  }

  /* 模态确认框: resolve(true)=确认 / resolve(false)=取消 */
  function confirmDialog(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var root = document.getElementById("modal-root");
      var overlay = document.createElement("div");
      overlay.className = "modal-overlay";
      var panel = document.createElement("div");
      panel.className = "modal-panel" + (opts.danger ? " danger" : "");
      var title = document.createElement("h2");
      title.className = "modal-title";
      title.textContent = opts.title || "确认";
      var message = document.createElement("div");
      message.className = "modal-message";
      message.textContent = opts.message || "";
      var actions = document.createElement("div");
      actions.className = "modal-actions";
      if (!opts.onlyOk) {
        var cancelBtn = document.createElement("button");
        cancelBtn.type = "button";
        cancelBtn.textContent = opts.cancelText || "取消";
        cancelBtn.addEventListener("click", function () { finish(false); });
        actions.appendChild(cancelBtn);
      }
      var okBtn = document.createElement("button");
      okBtn.type = "button";
      okBtn.className = "primary";
      okBtn.textContent = opts.confirmText || (opts.onlyOk ? "知道了" : "确认");
      okBtn.addEventListener("click", function () { finish(true); });
      actions.appendChild(okBtn);
      panel.appendChild(title);
      panel.appendChild(message);
      panel.appendChild(actions);
      overlay.appendChild(panel);
      root.appendChild(overlay);

      var done = false;
      function finish(val) {
        if (done) { return; }
        done = true;
        document.removeEventListener("keydown", onKey, true);
        if (overlay.parentNode) { overlay.parentNode.removeChild(overlay); }
        dialogCount = Math.max(0, dialogCount - 1);
        resolve(val);
      }
      function onKey(e) {
        if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          finish(false);
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          finish(true);
        }
      }
      overlay.addEventListener("mousedown", function (e) {
        if (e.target === overlay) { finish(false); }
      });
      document.addEventListener("keydown", onKey, true);
      dialogCount += 1;
      okBtn.focus();
    });
  }

  function isDialogOpen() { return dialogCount > 0; }

  /* ---------------- 棋盘画布 ---------------- */

  var LINE_COLOR = "rgba(45, 30, 14, 0.9)";

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0;
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /* 几何: 与桌面版 board_render.py 相同的迭代式 margin/radius 计算 */
  function computeGeometry(side, n) {
    var margin = 34;
    var cell = side / n;
    var radius = cell * 0.46;
    margin = Math.max(34, (radius + 13) / 0.55);
    for (var i = 0; i < 4; i++) {
      cell = (side - 2 * margin) / (n - 1);
      radius = cell * 0.46;
      margin = Math.max(34, (radius + 13) / 0.55);
    }
    return { cell: cell, margin: margin, radius: radius };
  }

  function BoardCanvas(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.boardSize = 9;
    this.width = 0;
    this.height = 0;
    this.dpr = 1;
    this.cell = 0;
    this.margin = 0;
    this.radius = 0;
    this.originX = 0;
    this.originY = 0;
  }

  BoardCanvas.prototype._resize = function () {
    var wrap = this.canvas.parentElement;
    var w = Math.max(1, wrap.clientWidth);
    var h = Math.max(1, wrap.clientHeight);
    var dpr = window.devicePixelRatio || 1;
    if (w === this.width && h === this.height && dpr === this.dpr) { return; }
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + "px";
    this.canvas.style.height = h + "px";
    var side = Math.min(w, h);
    var geo = computeGeometry(side, this.boardSize);
    this.cell = geo.cell;
    this.margin = geo.margin;
    this.radius = geo.radius;
    this.originX = (w - side) / 2 + geo.margin;
    this.originY = (h - side) / 2 + geo.margin;
  };

  BoardCanvas.prototype.setBoardSize = function (size) {
    this.boardSize = size;
    this.width = 0;   // 下一帧强制重算几何
  };

  BoardCanvas.prototype.actionToPoint = function (action) {
    var size = this.boardSize;
    var row = Math.floor(action / size);
    var col = action % size;
    return {
      x: this.originX + col * this.cell,
      y: this.originY + row * this.cell
    };
  };

  BoardCanvas.prototype.pointToAction = function (x, y) {
    var size = this.boardSize;
    var col = Math.round((x - this.originX) / this.cell);
    var row = Math.round((y - this.originY) / this.cell);
    if (!(col >= 0 && col < size && row >= 0 && row < size)) { return null; }
    var px = this.originX + col * this.cell;
    var py = this.originY + row * this.cell;
    var dx = x - px;
    var dy = y - py;
    if (Math.sqrt(dx * dx + dy * dy) > this.radius * 1.45) { return null; }
    return row * size + col;
  };

  BoardCanvas.prototype._drawWood = function (w, h) {
    var ctx = this.ctx;
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#e6c48e");
    grad.addColorStop(1, "#d2ab6f");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    var rng = mulberry32(7);   // 固定种子: 木纹纹理稳定不闪烁
    var count = Math.round(h / 55);
    for (var i = 0; i < count; i++) {
      var y0 = rng() * h;
      var amp = 6 + rng() * 16;
      var alpha = 0.04 + rng() * 0.08;
      ctx.beginPath();
      ctx.moveTo(-20, y0);
      ctx.bezierCurveTo(w * 0.33, y0 - amp, w * 0.66, y0 + amp,
        w + 20, y0 + (rng() - 0.5) * 10);
      ctx.strokeStyle = "rgba(96, 60, 24, " + alpha.toFixed(3) + ")";
      ctx.lineWidth = 1 + rng() * 2.2;
      ctx.stroke();
    }
  };

  BoardCanvas.prototype._drawGrid = function () {
    var ctx = this.ctx;
    var n = this.boardSize;
    var x0 = this.originX;
    var y0 = this.originY;
    var span = (n - 1) * this.cell;
    ctx.strokeStyle = LINE_COLOR;
    for (var i = 0; i < n; i++) {
      ctx.lineWidth = (i === 0 || i === n - 1) ? 2 : 1;
      ctx.beginPath();
      ctx.moveTo(x0, y0 + i * this.cell);
      ctx.lineTo(x0 + span, y0 + i * this.cell);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x0 + i * this.cell, y0);
      ctx.lineTo(x0 + i * this.cell, y0 + span);
      ctx.stroke();
    }
    var stars = starPoints(n);
    ctx.fillStyle = LINE_COLOR;
    for (var s = 0; s < stars.length; s++) {
      var p = this.actionToPoint(stars[s]);
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(2, this.radius * 0.22), 0, Math.PI * 2);
      ctx.fill();
    }
  };

  BoardCanvas.prototype._drawCoords = function () {
    var ctx = this.ctx;
    var n = this.boardSize;
    var fontSize = Math.max(10, Math.min(14, this.radius * 0.62));
    ctx.fillStyle = "rgba(60, 42, 26, 0.85)";
    ctx.font = fontSize + "px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (var i = 0; i < n; i++) {
      ctx.fillText(COL_LETTERS.charAt(i),
        this.originX + i * this.cell,
        this.originY + (n - 1) * this.cell + this.margin * 0.58);
      ctx.fillText("" + (n - i),
        this.originX - this.margin * 0.58,
        this.originY + i * this.cell);
    }
  };

  BoardCanvas.prototype._drawStone = function (x, y, color, alpha) {
    var ctx = this.ctx;
    var r = this.radius;
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    if ((alpha == null || alpha >= 1)) {
      ctx.shadowColor = "rgba(0, 0, 0, 0.35)";
      ctx.shadowBlur = r * 0.4;
      ctx.shadowOffsetY = r * 0.12;
    }
    var grad = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.15, x, y, r);
    if (color === 1) {
      grad.addColorStop(0, "#6a6a72");
      grad.addColorStop(1, "#0a0a0c");
    } else {
      grad.addColorStop(0, "#fffdf6");
      grad.addColorStop(1, "#cfc8b8");
    }
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowColor = "transparent";
    ctx.shadowBlur = 0;
    if (color === 2) {
      ctx.strokeStyle = "rgba(120, 110, 95, 0.7)";
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  };

  /* 数子点: 空点归属色圆点 + 反色描边 (r = cell*0.14) */
  BoardCanvas.prototype._drawTerritory = function (map, board) {
    var ctx = this.ctx;
    var r = this.cell * 0.14;
    for (var p = 0; p < map.length; p++) {
      var owner = map[p];
      if (!owner || board[p] !== 0) { continue; }
      var pt = this.actionToPoint(p);
      ctx.beginPath();
      ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
      ctx.fillStyle = owner === 1 ? "#141414" : "#f6f6f6";
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = owner === 1 ? "rgba(246, 246, 246, 0.8)" : "rgba(20, 20, 20, 0.6)";
      ctx.stroke();
    }
  };

  /* 五连高亮: 金色连线 + 每颗子金色外圈 */
  BoardCanvas.prototype._drawWinLine = function (cells) {
    var ctx = this.ctx;
    ctx.strokeStyle = "rgba(201, 168, 106, 0.9)";
    ctx.lineWidth = Math.max(2, this.radius * 0.14);
    ctx.beginPath();
    for (var i = 0; i < cells.length; i++) {
      var pt = this.actionToPoint(cells[i]);
      if (i === 0) { ctx.moveTo(pt.x, pt.y); } else { ctx.lineTo(pt.x, pt.y); }
    }
    ctx.stroke();
    ctx.lineWidth = 2;
    for (var j = 0; j < cells.length; j++) {
      var p2 = this.actionToPoint(cells[j]);
      ctx.beginPath();
      ctx.arc(p2.x, p2.y, this.radius * 1.12, 0, Math.PI * 2);
      ctx.stroke();
    }
  };

  /* 每帧快照 s: { board, toPlay, lastMove, koPoint, territory, winningLine,
     hover, prediction: {action, until} | null } */
  BoardCanvas.prototype.render = function (s) {
    this._resize();
    var ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this._drawWood(this.width, this.height);
    this._drawGrid();
    this._drawCoords();
    var n = this.boardSize;
    var board = s.board;
    var p, pt;
    for (p = 0; p < n * n; p++) {
      if (board[p] !== 0) {
        pt = this.actionToPoint(p);
        this._drawStone(pt.x, pt.y, board[p], 1);
      }
    }
    if (s.winningLine && s.winningLine.length) { this._drawWinLine(s.winningLine); }
    if (s.lastMove != null && s.lastMove >= 0 && s.lastMove < n * n) {
      var lm = this.actionToPoint(s.lastMove);
      ctx.strokeStyle = board[s.lastMove] === 1 ?
        "rgba(255, 255, 255, 0.85)" : "rgba(20, 20, 20, 0.8)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(lm.x, lm.y, this.radius * 0.45, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (s.territory) { this._drawTerritory(s.territory, board); }
    if (s.koPoint != null && s.koPoint >= 0 && s.koPoint < n * n &&
        board[s.koPoint] === 0) {
      var kp = this.actionToPoint(s.koPoint);
      var k = this.radius * 0.42;
      ctx.strokeStyle = "rgba(190, 60, 40, 0.9)";
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(kp.x - k, kp.y - k);
      ctx.lineTo(kp.x + k, kp.y + k);
      ctx.moveTo(kp.x + k, kp.y - k);
      ctx.lineTo(kp.x - k, kp.y + k);
      ctx.stroke();
    }
    if (s.hover != null && s.hover >= 0 && board[s.hover] === 0) {
      var hp = this.actionToPoint(s.hover);
      this._drawStone(hp.x, hp.y, s.toPlay, 0.47);
    }
    if (s.prediction && s.prediction.action != null &&
        board[s.prediction.action] === 0 && Date.now() < s.prediction.until) {
      var now = Date.now();
      var pp = this.actionToPoint(s.prediction.action);
      var phase = (now % 1100) / 1100;
      var alpha = 0.35 + 0.35 * Math.sin(2 * Math.PI * phase);
      ctx.strokeStyle = "rgba(38, 186, 208, " + Math.max(0, alpha).toFixed(3) + ")";
      ctx.lineWidth = Math.max(2, this.radius * 0.16);
      ctx.beginPath();
      ctx.arc(pp.x, pp.y, this.radius * 1.18, 0, Math.PI * 2);
      ctx.stroke();
    }
  };

  /* ---------------- 主菜单 ---------------- */

  var MENU_PATTERNS = {
    go9: [[2, 2, 1], [2, 6, 2], [6, 2, 2], [6, 6, 1], [4, 4, 1], [4, 3, 2]],
    go13: [[3, 3, 1], [3, 9, 2], [9, 3, 2], [9, 9, 1], [6, 6, 1], [6, 7, 2], [5, 5, 1]],
    go19: [[3, 3, 1], [3, 15, 2], [15, 3, 2], [15, 15, 1], [9, 9, 1], [10, 9, 2], [8, 8, 1]],
    gomoku: [[7, 7, 1], [7, 8, 2], [8, 7, 2], [6, 6, 1], [8, 8, 1], [7, 6, 2]]
  };

  /* 迷你预览棋盘: 卡片内小 canvas (木纹 + 网格 + 星位 + 示例棋子) */
  function drawMiniBoard(canvas) {
    var n = Number(canvas.dataset.size);
    var stones = MENU_PATTERNS[canvas.dataset.pattern] || [];
    var ctx = canvas.getContext("2d");
    var w = canvas.width;
    var h = canvas.height;
    var side = Math.min(w, h);
    var cell = side / (n + 1);
    var x0 = (w - side) / 2 + cell;
    var y0 = (h - side) / 2 + cell;
    var grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, "#e6c48e");
    grad.addColorStop(1, "#d2ab6f");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
    var span = (n - 1) * cell;
    ctx.strokeStyle = "rgba(45, 30, 14, 0.85)";
    ctx.lineWidth = 1;
    for (var i = 0; i < n; i++) {
      ctx.beginPath();
      ctx.moveTo(x0, y0 + i * cell);
      ctx.lineTo(x0 + span, y0 + i * cell);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x0 + i * cell, y0);
      ctx.lineTo(x0 + i * cell, y0 + span);
      ctx.stroke();
    }
    ctx.fillStyle = "rgba(45, 30, 14, 0.85)";
    var stars = starPoints(n);
    for (var s = 0; s < stars.length; s++) {
      var sr = Math.floor(stars[s] / n);
      var sc = stars[s] % n;
      ctx.beginPath();
      ctx.arc(x0 + sc * cell, y0 + sr * cell, Math.max(1.5, cell * 0.09), 0, Math.PI * 2);
      ctx.fill();
    }
    var r = cell * 0.42;
    for (var m = 0; m < stones.length; m++) {
      var st = stones[m];
      var cx = x0 + st[1] * cell;
      var cy = y0 + st[0] * cell;
      var g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.4, r * 0.15, cx, cy, r);
      if (st[2] === 1) {
        g.addColorStop(0, "#6a6a72");
        g.addColorStop(1, "#0a0a0c");
      } else {
        g.addColorStop(0, "#fffdf6");
        g.addColorStop(1, "#cfc8b8");
      }
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* 阶段状态机: 棋种 -> (围棋) 路数 -> 对战模式; 五子棋直接到模式 */
  function MenuUI(root, onSelect) {
    this.root = root;
    this.onSelect = onSelect;
    this.stage = "game";
    this.game = null;
    this.size = null;
    this.focus = 0;
  }

  MenuUI.prototype.options = function () {
    if (this.stage === "game") {
      return [
        {
          id: "go", label: "围  棋", desc: "9 / 13 / 19 路 · 中国规则数子",
          badge: { text: "双人" }, pattern: "go9", previewSize: 9
        },
        {
          id: "gomoku", label: "五子棋", desc: "15 路 · 自由规则 · 可挑战内置 AI",
          badge: { text: "AI", amber: true }, pattern: "gomoku", previewSize: 15
        }
      ];
    }
    if (this.stage === "size") {
      return [
        { id: "9", label: "9 路棋盘", desc: "入门之选 · 节奏轻快", pattern: "go9", previewSize: 9 },
        { id: "13", label: "13 路棋盘", desc: "进阶之选 · 攻防平衡", pattern: "go13", previewSize: 13 },
        { id: "19", label: "19 路棋盘", desc: "标准之选 · 全局战场", pattern: "go19", previewSize: 19 }
      ];
    }
    if (this.game === "go") {
      var goPattern = this.size >= 19 ? "go19" : (this.size >= 13 ? "go13" : "go9");
      return [
        {
          id: "pvp", label: "双人对战",
          desc: "黑白轮流落子 · 双停一手后自动数子",
          pattern: goPattern, previewSize: this.size
        },
        {
          id: "online", label: "联机对战",
          desc: "与好友网络远程对局 · 生成房间码分享",
          badge: { text: "联机", teal: true }, pattern: goPattern,
          previewSize: this.size
        }
      ];
    }
    return [
      { id: "pvp", label: "双人对战", desc: "两人轮流落子 · 先连成五子者胜", pattern: "gomoku", previewSize: 15 },
      { id: "ai", label: "人机对战", desc: "对局内置启发式 AI · 你执黑先行", badge: { text: "AI", amber: true }, pattern: "gomoku", previewSize: 15 },
      { id: "online", label: "联机对战", desc: "与好友网络远程对局 · 生成房间码分享", badge: { text: "联机", teal: true }, pattern: "gomoku", previewSize: 15 }
    ];
  };

  MenuUI.prototype.subtitle = function () {
    if (this.stage === "game") { return "请选择棋种"; }
    if (this.stage === "size") { return "选择棋盘路数"; }
    return "选择对战模式";
  };

  MenuUI.prototype.render = function () {
    var opts = this.options();
    if (this.focus >= opts.length) { this.focus = 0; }
    var html = '<div class="menu-brand">GO · 纯前端版</div>';
    html += '<div class="menu-title">围棋 · 五子棋</div>';
    html += '<div class="menu-subtitle">' + this.subtitle() + '</div>';
    html += '<div class="menu-rule"></div>';
    html += '<div class="cards">';
    for (var i = 0; i < opts.length; i++) {
      var o = opts[i];
      html += '<div class="card' + (i === this.focus ? " focused" : "") +
        '" data-idx="' + i + '">';
      html += '<canvas class="preview" width="300" height="196" data-pattern="' +
        o.pattern + '" data-size="' + o.previewSize + '"></canvas>';
      if (o.badge) {
        html += '<span class="badge' + (o.badge.amber ? " amber" : "") + '">' +
          o.badge.text + '</span>';
      }
      html += '<div class="card-label">' + o.label + '</div>';
      html += '<div class="card-desc">' + o.desc + '</div>';
      html += '</div>';
    }
    html += '</div>';
    html += '<div class="menu-footer">';
    if (this.stage !== "game") { html += '<span><kbd>Esc</kbd> 返回</span>'; }
    html += '<span><kbd>←</kbd><kbd>→</kbd> 选择</span>';
    html += '<span><kbd>Enter</kbd> 确认</span>';
    html += '</div>';
    if (this.stage !== "game") {
      html += '<button id="menu-back" title="返回上一级">←</button>';
    }
    this.root.innerHTML = html;

    var self = this;
    var cards = this.root.querySelectorAll(".card");
    for (var c = 0; c < cards.length; c++) {
      (function (card) {
        card.addEventListener("click", function () {
          self.choose(Number(card.dataset.idx));
        });
        card.addEventListener("mousemove", function () {
          var idx = Number(card.dataset.idx);
          if (self.focus !== idx) {
            self.focus = idx;
            var all = self.root.querySelectorAll(".card");
            for (var k = 0; k < all.length; k++) {
              all[k].classList.toggle("focused", k === idx);
            }
          }
        });
      })(cards[c]);
    }
    var back = this.root.querySelector("#menu-back");
    if (back) {
      back.addEventListener("click", function (e) {
        e.stopPropagation();
        self.back();
      });
    }
    var previews = this.root.querySelectorAll("canvas.preview");
    for (var p = 0; p < previews.length; p++) { drawMiniBoard(previews[p]); }
  };

  MenuUI.prototype.choose = function (idx) {
    var opt = this.options()[idx];
    if (!opt) { return; }
    if (this.stage === "game") {
      this.game = opt.id;
      this.stage = opt.id === "go" ? "size" : "mode";
      this.focus = 0;
      this.render();
      return;
    }
    if (this.stage === "size") {
      this.size = Number(opt.id);
      this.stage = "mode";
      this.focus = 0;
      this.render();
      return;
    }
    this.onSelect({
      game: this.game,
      size: this.game === "go" ? this.size : 15,
      mode: opt.id
    });
  };

  MenuUI.prototype.back = function () {
    if (this.stage === "mode") {
      this.stage = this.game === "go" ? "size" : "game";
      if (this.stage === "game") { this.game = null; }
    } else if (this.stage === "size") {
      this.stage = "game";
      this.game = null;
    } else {
      return;
    }
    this.focus = 0;
    this.render();
  };

  MenuUI.prototype.moveFocus = function (delta) {
    var n = this.options().length;
    if (!n) { return; }
    this.focus = ((this.focus + delta) % n + n) % n;
    var cards = this.root.querySelectorAll(".card");
    for (var i = 0; i < cards.length; i++) {
      cards[i].classList.toggle("focused", i === this.focus);
    }
  };

  /* 返回 true 表示按键已被菜单消费 */
  MenuUI.prototype.handleKey = function (e) {
    if (this.root.classList.contains("hidden") || isDialogOpen()) { return false; }
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") {
      this.moveFocus(-1);
      e.preventDefault();
      return true;
    }
    if (e.key === "ArrowRight" || e.key === "ArrowDown") {
      this.moveFocus(1);
      e.preventDefault();
      return true;
    }
    if (e.key === "Enter" || e.key === " ") {
      this.choose(this.focus);
      e.preventDefault();
      return true;
    }
    if (e.key === "Escape") {
      this.back();
      e.preventDefault();
      return true;
    }
    return false;
  };

  global.UI = {
    BoardCanvas: BoardCanvas,
    MenuUI: MenuUI,
    confirmDialog: confirmDialog,
    isDialogOpen: isDialogOpen,
    coordText: coordText,
    starPoints: starPoints,
    formatDuration: formatDuration,
    drawPreview: drawMiniBoard,
    COL_LETTERS: COL_LETTERS
  };
})(window);
