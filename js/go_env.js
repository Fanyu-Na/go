/* 围棋规则引擎 (纯前端, 移植自 GO_v1/env/go_env.py + go_rules.py).
   中国规则数子 (子 + 单方围空 + 贴目), 简单劫, 禁自杀, 双 pass 终局.
   动作 0..n-1 对应 row*boardSize+col (row 0 在棋盘顶部), 动作 n 表示 pass. */

(function (global) {
  "use strict";

  var BLACK = 1;
  var WHITE = 2;

  function GoEnv(opts) {
    opts = opts || {};
    var boardSize = opts.boardSize || 9;
    this.boardSize = boardSize;
    this.numPoints = boardSize * boardSize;
    this.passAction = this.numPoints;
    this.komi = typeof opts.komi === "number" ? opts.komi : 5.5;
    this.maxMoves = opts.maxMoves || 2 * this.numPoints;
    this.board = new Int8Array(this.numPoints);
    this.toPlay = BLACK;
    this.moveCount = 0;
    this.done = false;
    this.winner = null;          // BLACK / WHITE / null (和棋)
    this.koPoint = -1;           // 当前劫禁点, 仅约束下一手
    this.consecutivePasses = 0;
    this.captures = { 1: 0, 2: 0 };  // 各色累计提子数
  }

  GoEnv.BLACK = BLACK;
  GoEnv.WHITE = WHITE;

  GoEnv.prototype.copy = function () {
    var e = new GoEnv({
      boardSize: this.boardSize,
      komi: this.komi,
      maxMoves: this.maxMoves
    });
    e.board.set(this.board);
    e.toPlay = this.toPlay;
    e.moveCount = this.moveCount;
    e.done = this.done;
    e.winner = this.winner;
    e.koPoint = this.koPoint;
    e.consecutivePasses = this.consecutivePasses;
    e.captures = { 1: this.captures[1], 2: this.captures[2] };
    return e;
  };

  GoEnv.prototype.neighbors = function (point) {
    var size = this.boardSize;
    var row = Math.floor(point / size);
    var col = point % size;
    var out = [];
    if (row > 0) { out.push(point - size); }
    if (row < size - 1) { out.push(point + size); }
    if (col > 0) { out.push(point - 1); }
    if (col < size - 1) { out.push(point + 1); }
    return out;
  };

  /* 返回 {stones: [点], liberties: Set(空点)} */
  GoEnv.prototype.group = function (point, board) {
    board = board || this.board;
    var color = board[point];
    var stones = [];
    var libs = {};
    var seen = {};
    var stack = [point];
    seen[point] = true;
    while (stack.length) {
      var p = stack.pop();
      stones.push(p);
      var nbrs = this.neighbors(p);
      for (var i = 0; i < nbrs.length; i++) {
        var n = nbrs[i];
        var v = board[n];
        if (v === 0) {
          libs[n] = true;
        } else if (v === color && !seen[n]) {
          seen[n] = true;
          stack.push(n);
        }
      }
    }
    return { stones: stones, liberties: libs };
  };

  /* 放子后自身无气, 且不能提任何对方子 => 自杀, 非法. */
  GoEnv.prototype.isSuicide = function (point, color) {
    var board = this.board;
    board[point] = color;
    var own = this.group(point, board);
    var ok = Object.keys(own.liberties).length > 0;
    if (!ok) {
      var nbrs = this.neighbors(point);
      for (var i = 0; i < nbrs.length; i++) {
        var n = nbrs[i];
        if (board[n] !== 0 && board[n] !== color) {
          var g = this.group(n, board);
          if (Object.keys(g.liberties).length === 0) { ok = true; break; }
        }
      }
    }
    board[point] = 0;
    return !ok;
  };

  GoEnv.prototype.isLegal = function (action) {
    if (this.done) { return false; }
    if (action === this.passAction) { return true; }
    if (typeof action !== "number" || action < 0 || action >= this.numPoints) { return false; }
    if (this.board[action] !== 0) { return false; }
    if (action === this.koPoint) { return false; }
    return !this.isSuicide(action, this.toPlay);
  };

  GoEnv.prototype.play = function (action) {
    if (!this.isLegal(action)) {
      throw new Error("非法动作: " + action);
    }
    var player = this.toPlay;
    this.koPoint = -1;
    var capturedCells = [];
    if (action === this.passAction) {
      this.consecutivePasses += 1;
      this.moveCount += 1;
      if (this.consecutivePasses >= 2) { this._endByScore(); }
    } else {
      this.consecutivePasses = 0;
      var board = this.board;
      board[action] = player;
      var capturedSet = {};
      var nbrs = this.neighbors(action);
      for (var i = 0; i < nbrs.length; i++) {
        var n = nbrs[i];
        if (board[n] !== 0 && board[n] !== player && !capturedSet[n]) {
          var g = this.group(n, board);
          if (Object.keys(g.liberties).length === 0) {
            for (var k = 0; k < g.stones.length; k++) { capturedSet[g.stones[k]] = true; }
          }
        }
      }
      capturedCells = Object.keys(capturedSet).map(Number);
      for (var c = 0; c < capturedCells.length; c++) { board[capturedCells[c]] = 0; }
      this.captures[player] += capturedCells.length;

      var own = this.group(action, board);
      var ownLibs = Object.keys(own.liberties).map(Number);
      if (capturedCells.length === 1 && own.stones.length === 1 && ownLibs.length === 1) {
        if (ownLibs[0] === capturedCells[0]) {
          this.koPoint = capturedCells[0];  // 简单劫: 禁止下一手立即回提
        }
      }
      this.moveCount += 1;
      if (this.moveCount >= this.maxMoves) { this._endByScore(); }
    }
    this.toPlay = 3 - player;
    return { player: player, captured: capturedCells };
  };

  GoEnv.prototype._endByScore = function () {
    this.done = true;
    var s = this.scoreDetail();
    if (s.blackScore > s.whiteScore) { this.winner = BLACK; }
    else if (s.blackScore < s.whiteScore) { this.winner = WHITE; }
    else { this.winner = null; }
  };

  /* 空点归属: 洪水填充每片空域, 只接触一种颜色即归该色 (Tromp-Taylor). */
  GoEnv.prototype.territoryMap = function () {
    var map = new Int8Array(this.numPoints);
    var board = this.board;
    var seen = new Uint8Array(this.numPoints);
    for (var p = 0; p < this.numPoints; p++) {
      if (board[p] !== 0 || seen[p]) { continue; }
      var region = [];
      var borders = {};
      var stack = [p];
      seen[p] = 1;
      while (stack.length) {
        var q = stack.pop();
        region.push(q);
        var nbrs = this.neighbors(q);
        for (var i = 0; i < nbrs.length; i++) {
          var n = nbrs[i];
          if (board[n] === 0) {
            if (!seen[n]) { seen[n] = 1; stack.push(n); }
          } else {
            borders[board[n]] = true;
          }
        }
      }
      var keys = Object.keys(borders);
      if (keys.length === 1) {
        var owner = Number(keys[0]);
        for (var r = 0; r < region.length; r++) { map[region[r]] = owner; }
      }
    }
    return map;
  };

  GoEnv.prototype.scoreDetail = function () {
    var blackStones = 0;
    var whiteStones = 0;
    var p;
    for (p = 0; p < this.numPoints; p++) {
      if (this.board[p] === BLACK) { blackStones++; }
      else if (this.board[p] === WHITE) { whiteStones++; }
    }
    var map = this.territoryMap();
    var blackTerritory = 0;
    var whiteTerritory = 0;
    for (p = 0; p < this.numPoints; p++) {
      if (map[p] === BLACK) { blackTerritory++; }
      else if (map[p] === WHITE) { whiteTerritory++; }
    }
    var blackScore = blackStones + blackTerritory;
    var whiteScore = whiteStones + whiteTerritory + this.komi;
    return {
      blackStones: blackStones,
      blackTerritory: blackTerritory,
      blackScore: blackScore,
      whiteStones: whiteStones,
      whiteTerritory: whiteTerritory,
      komi: this.komi,
      whiteScore: whiteScore,
      neutralPoints: this.numPoints - blackStones - whiteStones -
        blackTerritory - whiteTerritory
    };
  };

  global.GoEnv = GoEnv;
})(window);
