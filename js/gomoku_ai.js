/* 五子棋内置启发式 AI (纯前端, 移植自 GO_v1/gui/gomoku_ai.py).
   普通启发式代码, 不含任何神经网络:
   1. 自己下一手能连五 -> 直接获胜;
   2. 对手下一手能连五 -> 堵住;
   3. 否则对候选点做攻防棋型评分取最高 (少量随机打破平局).
   候选点限制在已有棋子周围两格内. */

(function (global) {
  "use strict";

  var BLACK = 1;
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];
  var WIN_SCORE = 1000000;
  var PATTERN_SCORES = {
    "4,2": 120000,
    "4,1": 25000,
    "3,2": 8000,
    "3,1": 800,
    "2,2": 600,
    "2,1": 60,
    "1,2": 20,
    "1,1": 5
  };

  function GomokuAI() {
    this.name = "gomoku";
    this.lastWarning = null;
  }

  GomokuAI.prototype.chooseMove = function (env) {
    this.lastWarning = null;
    var size = env.boardSize;
    var board = env.board;
    var me = env.toPlay;
    var opp = 3 - me;

    var candidates = this._candidates(board, size);
    if (!candidates.length) {
      for (var p = 0; p < board.length; p++) {
        if (board[p] === 0) { return p; }
      }
      return 0;
    }

    var i;
    for (i = 0; i < candidates.length; i++) {
      if (this._lineLength(board, candidates[i], me, size) >= 5) {
        return candidates[i];
      }
    }
    var blocks = [];
    for (i = 0; i < candidates.length; i++) {
      if (this._lineLength(board, candidates[i], opp, size) >= 5) {
        blocks.push(candidates[i]);
      }
    }
    if (blocks.length) { return this._bestByScore(board, blocks, me, size); }
    return this._bestByScore(board, candidates, me, size);
  };

  GomokuAI.prototype._candidates = function (board, size) {
    var hasStone = false;
    var mask = new Uint8Array(size * size);
    var p;
    for (p = 0; p < board.length; p++) {
      if (board[p] === 0) { continue; }
      hasStone = true;
      var r = Math.floor(p / size);
      var c = p % size;
      var r0 = Math.max(0, r - 2);
      var r1 = Math.min(size - 1, r + 2);
      var c0 = Math.max(0, c - 2);
      var c1 = Math.min(size - 1, c + 2);
      for (var rr = r0; rr <= r1; rr++) {
        for (var cc = c0; cc <= c1; cc++) { mask[rr * size + cc] = 1; }
      }
    }
    if (!hasStone) {
      var mid = Math.floor(size / 2);
      return [mid * size + mid];   // 空棋盘下天元
    }
    var out = [];
    for (p = 0; p < board.length; p++) {
      if (mask[p] && board[p] === 0) { out.push(p); }
    }
    return out;
  };

  GomokuAI.prototype._bestByScore = function (board, candidates, me, size) {
    var opp = 3 - me;
    var center = (size - 1) / 2;
    var best = -Infinity;
    var top = [];
    for (var i = 0; i < candidates.length; i++) {
      var action = candidates[i];
      var attack = this._patternScore(board, action, me, size);
      var defense = this._patternScore(board, action, opp, size);
      var row = Math.floor(action / size);
      var col = action % size;
      var dist = Math.abs(row - center) + Math.abs(col - center);
      var score = attack + defense * 0.92 - dist * 0.05 + Math.random() * 0.01;
      if (score > best + 1e-9) {
        best = score;
        top = [action];
      } else if (score >= best - 1e-9) {
        top.push(action);
      }
    }
    return top[Math.floor(Math.random() * top.length)];
  };

  /* 假设 color 落在 action 后, 经过该点的最长连子数. */
  GomokuAI.prototype._lineLength = function (board, action, color, size) {
    if (board[action] !== 0) { return 0; }
    board[action] = color;
    var row = Math.floor(action / size);
    var col = action % size;
    var longest = 1;
    for (var d = 0; d < DIRS.length; d++) {
      var dr = DIRS[d][0];
      var dc = DIRS[d][1];
      var count = 1;
      for (var sign = 1; sign >= -1; sign -= 2) {
        var step = 1;
        for (;;) {
          var r = row + sign * step * dr;
          var c = col + sign * step * dc;
          if (!(r >= 0 && r < size && c >= 0 && c < size) ||
              board[r * size + c] !== color) { break; }
          count += 1;
          step += 1;
        }
      }
      if (count > longest) { longest = count; }
    }
    board[action] = 0;
    return longest;
  };

  /* 假设 color 落在 action 后, 四方向棋型总分. */
  GomokuAI.prototype._patternScore = function (board, action, color, size) {
    if (board[action] !== 0) { return 0; }
    board[action] = color;
    var row = Math.floor(action / size);
    var col = action % size;
    var total = 0;
    for (var d = 0; d < DIRS.length; d++) {
      var dr = DIRS[d][0];
      var dc = DIRS[d][1];
      var run = 1;
      var openEnds = 0;
      for (var sign = 1; sign >= -1; sign -= 2) {
        var step = 1;
        for (;;) {
          var r = row + sign * step * dr;
          var c = col + sign * step * dc;
          if (!(r >= 0 && r < size && c >= 0 && c < size) ||
              board[r * size + c] !== color) {
            if (r >= 0 && r < size && c >= 0 && c < size &&
                board[r * size + c] === 0) {
              openEnds += 1;
            }
            break;
          }
          run += 1;
          step += 1;
        }
      }
      if (run >= 5) {
        total += WIN_SCORE;
      } else {
        total += (PATTERN_SCORES[run + "," + openEnds] || 0);
      }
    }
    board[action] = 0;
    return total;
  };

  global.GomokuAI = GomokuAI;
})(window);
