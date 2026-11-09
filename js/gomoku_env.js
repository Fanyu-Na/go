/* 五子棋规则环境 (默认 15 路, 自由规则; 移植自 GO_v1/env/gomoku_env.py).
   无提子 / 无 pass / 无禁手; 任意方向连成五子即胜, 棋盘下满为和棋. */

(function (global) {
  "use strict";

  var BLACK = 1;
  var WHITE = 2;
  var DIRS = [[0, 1], [1, 0], [1, 1], [1, -1]];

  function GomokuEnv(opts) {
    opts = opts || {};
    var boardSize = opts.boardSize || 15;
    this.boardSize = boardSize;
    this.numPoints = boardSize * boardSize;
    this.board = new Int8Array(this.numPoints);
    this.toPlay = BLACK;
    this.moveCount = 0;
    this.done = false;
    this.winner = null;        // BLACK / WHITE / null (和棋)
    this.winningLine = [];     // 获胜五连 (用于高亮)
  }

  GomokuEnv.BLACK = BLACK;
  GomokuEnv.WHITE = WHITE;
  GomokuEnv.DIRECTIONS = DIRS;

  GomokuEnv.prototype.copy = function () {
    var e = new GomokuEnv({ boardSize: this.boardSize });
    e.board.set(this.board);
    e.toPlay = this.toPlay;
    e.moveCount = this.moveCount;
    e.done = this.done;
    e.winner = this.winner;
    e.winningLine = this.winningLine.slice();
    return e;
  };

  GomokuEnv.prototype.isLegal = function (action) {
    return !this.done && action >= 0 && action < this.numPoints &&
      this.board[action] === 0;
  };

  GomokuEnv.prototype.play = function (action) {
    if (!this.isLegal(action)) {
      throw new Error("非法动作: " + action);
    }
    var player = this.toPlay;
    var size = this.boardSize;
    this.board[action] = player;
    this.moveCount += 1;

    var row = Math.floor(action / size);
    var col = action % size;
    for (var d = 0; d < DIRS.length; d++) {
      var dr = DIRS[d][0];
      var dc = DIRS[d][1];
      var cells = [action];
      for (var sign = 1; sign >= -1; sign -= 2) {
        var r = row + dr * sign;
        var c = col + dc * sign;
        while (r >= 0 && r < size && c >= 0 && c < size &&
            this.board[r * size + c] === player) {
          cells.push(r * size + c);
          r += dr * sign;
          c += dc * sign;
        }
      }
      if (cells.length >= 5) {
        cells.sort(function (a, b) { return a - b; });
        this.winningLine = cells;
        this.done = true;
        this.winner = player;
        break;
      }
    }
    if (!this.done && this.moveCount >= this.numPoints) {
      this.done = true;
      this.winner = null;   // 和棋
    }
    this.toPlay = 3 - player;
    return { player: player, captured: [] };
  };

  global.GomokuEnv = GomokuEnv;
})(window);
