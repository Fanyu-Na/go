/* 应用控制器: 对局流程 / 侧栏渲染 / 键盘鼠标交互.
   移植自桌面版 scripts/play_gui.py, 不含任何模型或后端服务:
   - 围棋双人对战 (中国规则, 双停一手自动数子)
   - 五子棋双人对战 / 人机对战 (内置启发式 AI) */

(function (global) {
  "use strict";

  var BLACK = 1;
  var WHITE = 2;
  var KOMI = { 9: 5.5, 13: 6.5, 19: 7.5 };
  var PREDICTION_MS = 6000;
  var AI_DELAY_MS = 300;

  var app = null;

  function App() {
    this.view = "menu";          // menu | game
    this.game = "go";
    this.size = 9;
    this.mode = "pvp";           // pvp | ai
    this.humanColor = BLACK;
    this.env = null;
    this.ai = null;
    this.history = [];           // 每手之后的 env 快照, history[0] = 初始局面
    this.moves = [];             // {action, player, captured, pass}
    this.aiBusy = false;
    this.version = 0;            // 递增使过期的 setTimeout 失效
    this.prediction = null;      // {action, until}
    this.scoreMode = false;
    this.territory = null;
    this.resigned = null;        // 认输一方的颜色
    this.replaying = false;
    this.replayIndex = 0;
    this.flash = null;
    this.flashTimer = null;
    this.elapsedBase = 0;
    this.clockStart = 0;
    this.hover = null;
    this.boardCanvas = null;
    this.menu = null;
  }

  /* ---------------- 对局创建与视图切换 ---------------- */

  App.prototype.createGame = function (settings) {
    this.game = settings.game;
    this.size = settings.size;
    this.mode = settings.mode;
    this.humanColor = settings.humanColor || BLACK;
    if (this.game === "go") {
      var komi = KOMI[this.size] != null ? KOMI[this.size] : 5.5;
      this.env = new global.GoEnv({
        boardSize: this.size,
        komi: komi,
        maxMoves: 2 * this.size * this.size
      });
    } else {
      this.env = new global.GomokuEnv({ boardSize: this.size });
    }
    this.ai = (this.game === "gomoku" && this.mode === "ai") ?
      new global.GomokuAI() : null;
    this.history = [this.env.copy()];
    this.moves = [];
    this.aiBusy = false;
    this.version += 1;
    this.prediction = null;
    this.scoreMode = false;
    this.territory = null;
    this.resigned = null;
    this.replaying = false;
    this.replayIndex = 0;
    this.flash = null;
    this.elapsedBase = 0;
    this.clockStart = Date.now();
    this.hover = null;
    this.boardCanvas.setBoardSize(this.size);
    this.view = "game";
    this.showViews();
    this.renderSidebar();
    // 执白时 AI (黑) 先行
    if (this.mode === "ai" && this.ai && this.env.toPlay !== this.humanColor) {
      this.scheduleAi();
    }
  };

  App.prototype.showViews = function () {
    document.getElementById("menu-view").classList.toggle(
      "hidden", this.view !== "menu");
    document.getElementById("game-view").classList.toggle(
      "hidden", this.view !== "game");
  };

  App.prototype.showMenu = function () {
    this.version += 1;
    this.view = "menu";
    this.showViews();
    this.menu.render();
  };

  /* ---------------- 用时统计 ---------------- */

  App.prototype.clockPause = function () {
    if (this.clockStart) {
      this.elapsedBase += (Date.now() - this.clockStart) / 1000;
      this.clockStart = 0;
    }
  };

  App.prototype.clockResume = function () {
    if (!this.clockStart) { this.clockStart = Date.now(); }
  };

  App.prototype.elapsed = function () {
    return this.elapsedBase +
      (this.clockStart ? (Date.now() - this.clockStart) / 1000 : 0);
  };

  /* ---------------- 落子流程 ---------------- */

  App.prototype.canPlay = function () {
    return this.view === "game" && !this.env.done && this.resigned == null &&
      !this.replaying && !this.aiBusy && !UI.isDialogOpen();
  };

  App.prototype.applyMove = function (action) {
    var env = this.env;
    var info = env.play(action);
    this.history.push(env.copy());
    this.moves.push({
      action: action,
      player: info.player,
      captured: info.captured || [],
      pass: this.game === "go" && action === env.passAction
    });
    this.prediction = null;
    this.scoreMode = false;
    this.territory = null;
    if (env.done) {
      this.clockPause();
      if (info.captured && info.captured.length) { Sound.play("capture"); }
      Sound.play("end");
      if (this.game === "go") {          // 双停一手 / 下满: 自动展示领地
        this.scoreMode = true;
        this.territory = env.territoryMap();
      }
    } else if (info.captured && info.captured.length) {
      Sound.play("capture");
    } else if (!(this.game === "go" && action === env.passAction)) {
      Sound.play("stone");
    }
    this.renderSidebar();
  };

  App.prototype.humanClick = function (action) {
    if (!this.canPlay()) { return; }
    if (this.mode === "ai" && this.env.toPlay !== this.humanColor) { return; }
    if (!this.env.isLegal(action)) {
      this.flashStatus(this.game === "go" ?
        "此处不能落子（禁着点或已被占用）" : "此处已有棋子");
      return;
    }
    this.applyMove(action);
    if (this.mode === "ai" && !this.env.done) { this.scheduleAi(); }
  };

  App.prototype.flashStatus = function (text) {
    this.flash = { text: text, until: Date.now() + 1600 };
    this.renderSidebar();
    var self = this;
    if (this.flashTimer) { clearTimeout(this.flashTimer); }
    this.flashTimer = setTimeout(function () {
      self.flash = null;
      if (self.view === "game") { self.renderSidebar(); }
    }, 1600);
  };

  App.prototype.snapshot = function () {
    var env = this.replaying ? this.history[this.replayIndex] : this.env;
    var last = null;
    if (this.replaying) {
      if (this.replayIndex > 0) { last = this.moves[this.replayIndex - 1].action; }
    } else if (this.moves.length) {
      last = this.moves[this.moves.length - 1].action;
    }
    return {
      board: env.board,
      toPlay: env.toPlay,
      lastMove: last,
      koPoint: this.replaying ? -1 : this.env.koPoint,
      territory: this.replaying ? null : this.territory,
      winningLine: env.winningLine || null,
      hover: this.hover,
      prediction: this.prediction
    };
  };

  /* ---------------- AI / 预测 / 悔棋 / 复盘 ---------------- */

  App.prototype.scheduleAi = function () {
    var v = ++this.version;
    this.aiBusy = true;
    this.renderSidebar();
    var self = this;
    setTimeout(function () {
      if (v !== self.version || self.view !== "game" || self.env.done ||
          self.resigned != null || self.replaying) {
        self.aiBusy = false;
        return;
      }
      var move = self.ai.chooseMove(self.env.copy());
      if (v !== self.version) { return; }
      self.aiBusy = false;
      self.applyMove(move);
    }, AI_DELAY_MS);
  };

  App.prototype.predict = function () {
    if (this.game !== "gomoku" || this.mode !== "ai" || !this.canPlay() ||
        this.env.toPlay !== this.humanColor) {
      return;
    }
    var v = ++this.version;
    var self = this;
    setTimeout(function () {
      if (v !== self.version) { return; }
      var move = self.ai.chooseMove(self.env.copy());
      self.prediction = { action: move, until: Date.now() + PREDICTION_MS };
    }, 30);
  };

  App.prototype.pass = function () {
    if (this.game !== "go" || !this.canPlay()) { return; }
    if (this.mode === "ai" && this.env.toPlay !== this.humanColor) { return; }
    this.applyMove(this.env.passAction);
    if (this.mode === "ai" && !this.env.done) { this.scheduleAi(); }
  };

  App.prototype.undo = function () {
    if (this.view !== "game" || this.replaying || !this.history.length ||
        UI.isDialogOpen()) {
      return;
    }
    if (this.resigned != null) {          // 认输后的悔棋 = 撤销认输
      this.resigned = null;
      this.clockResume();
      this.renderSidebar();
      return;
    }
    if (this.history.length <= 1) { return; }
    this.version += 1;                    // 取消还在排队的 AI 应手
    this.aiBusy = false;
    do {
      this.history.pop();
      this.moves.pop();
    } while (this.mode === "ai" && this.history.length > 1 &&
             this.history[this.history.length - 1].toPlay !== this.humanColor);
    this.env = this.history[this.history.length - 1].copy();
    this.prediction = null;
    this.scoreMode = false;
    this.territory = null;
    this.hover = null;
    this.clockResume();
    this.renderSidebar();
  };

  App.prototype.replayToggle = function () {
    if (this.view !== "game" || !this.moves.length || UI.isDialogOpen()) { return; }
    this.replaying = !this.replaying;
    if (this.replaying) {
      this.version += 1;
      this.replayIndex = this.moves.length;
      this.hover = null;
    }
    this.renderSidebar();
  };

  App.prototype.replayStep = function (delta) {
    if (!this.replaying) { return; }
    var next = Math.min(this.moves.length, Math.max(0, this.replayIndex + delta));
    if (next !== this.replayIndex) {
      this.replayIndex = next;
      this.renderSidebar();
    }
  };

  App.prototype.scoreToggle = function () {
    if (this.game !== "go" || this.view !== "game" || this.replaying ||
        UI.isDialogOpen()) {
      return;
    }
    if (this.scoreMode) {
      this.scoreMode = false;
      this.territory = null;
    } else {
      this.scoreMode = true;
      this.territory = this.env.territoryMap();
    }
    this.renderSidebar();
  };

  App.prototype.scoreSummary = function () {
    var s = this.env.scoreDetail();
    return "黑 " + s.blackScore + " · 白 " + s.whiteScore + " (含贴目 " + s.komi + ")";
  };

  /* ---------------- 认输 / 新对局 / 交换执子 ---------------- */

  App.prototype.resign = function () {
    if (!this.canPlay()) { return; }
    if (this.mode === "ai" && this.env.toPlay !== this.humanColor) { return; }
    var self = this;
    var who = this.mode === "ai" ? "你" :
      (this.env.toPlay === BLACK ? "黑方" : "白方");
    UI.confirmDialog({
      title: "认输",
      message: who + "确定认输吗？当前对局将结束。",
      confirmText: "认输",
      danger: true
    }).then(function (ok) {
      if (!ok) { return; }
      self.resigned = self.env.toPlay;
      self.clockPause();
      Sound.play("end");
      self.renderSidebar();
    });
  };

  App.prototype.confirmNew = function () {
    if (this.view !== "game" || UI.isDialogOpen()) { return; }
    var self = this;
    if (!this.moves.length) {
      this.createGame({ game: this.game, size: this.size, mode: this.mode });
      return;
    }
    UI.confirmDialog({
      title: "新的一局",
      message: "开始新的一局吗？当前对局进度将被丢弃。",
      confirmText: "新的一局"
    }).then(function (ok) {
      if (ok) {
        self.createGame({
          game: self.game,
          size: self.size,
          mode: self.mode,
          humanColor: self.humanColor
        });
      }
    });
  };

  App.prototype.swapColor = function () {
    if (this.mode !== "ai" || this.game !== "gomoku" || UI.isDialogOpen()) {
      return;
    }
    var self = this;
    UI.confirmDialog({
      title: "交换执子",
      message: "交换执子将重新开始新对局，是否继续？"
    }).then(function (ok) {
      if (!ok) { return; }
      self.createGame({
        game: self.game,
        size: self.size,
        mode: self.mode,
        humanColor: 3 - self.humanColor
      });
    });
  };

  /* ---------------- 棋谱保存 / 导入 ---------------- */

  App.prototype.saveSgf = function () {
    if (this.view !== "game" || !this.moves.length || UI.isDialogOpen()) { return; }
    global.SGF.download(global.SGF.filename(), global.SGF.save({
      game: this.game,
      size: this.size,
      komi: this.game === "go" ? this.env.komi : null,
      passAction: this.game === "go" ? this.env.passAction : -1,
      moves: this.moves
    }));
  };

  App.prototype.loadSgf = function () {
    if (this.view !== "game" || UI.isDialogOpen()) { return; }
    var input = document.getElementById("sgf-input");
    input.value = "";
    input.click();
  };

  App.prototype._onSgfFile = function (file) {
    var self = this;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        self.buildFromParsed(global.SGF.parse(String(reader.result)));
      } catch (err) {
        UI.confirmDialog({
          title: "导入失败",
          message: String(err && err.message ? err.message : err),
          onlyOk: true
        });
        return;
      }
      self.renderSidebar();
    };
    reader.onerror = function () {
      UI.confirmDialog({ title: "导入失败", message: "读取文件失败", onlyOk: true });
    };
    reader.readAsText(file);
  };

  App.prototype.buildFromParsed = function (parsed) {
    var env;
    if (parsed.game === "go") {
      env = new global.GoEnv({
        boardSize: parsed.size,
        komi: parsed.komi != null ? parsed.komi :
          (KOMI[parsed.size] != null ? KOMI[parsed.size] : 5.5),
        maxMoves: 2 * parsed.size * parsed.size
      });
    } else {
      env = new global.GomokuEnv({ boardSize: parsed.size });
    }
    this.game = parsed.game;
    this.size = parsed.size;
    this.mode = "pvp";
    this.humanColor = BLACK;
    this.ai = null;
    this.env = env;
    this.history = [env.copy()];
    this.moves = [];
    for (var i = 0; i < parsed.moves.length; i++) {
      var m = parsed.moves[i];
      if (!env.isLegal(m.action)) {
        throw new Error("第 " + (i + 1) + " 着不合法，已取消导入");
      }
      var info = env.play(m.action);
      this.history.push(env.copy());
      this.moves.push({
        action: m.action,
        player: info.player,
        captured: info.captured || [],
        pass: parsed.game === "go" && m.action === env.passAction
      });
    }
    this.aiBusy = false;
    this.version += 1;
    this.prediction = null;
    this.scoreMode = false;
    this.territory = null;
    this.resigned = null;
    this.replaying = false;
    this.elapsedBase = 0;
    this.clockStart = Date.now();
    this.hover = null;
    this.boardCanvas.setBoardSize(this.size);
    if (this.env.done && this.game === "go") {
      this.scoreMode = true;
      this.territory = this.env.territoryMap();
      this.clockPause();
    }
  };

  /* ---------------- 返回主菜单 ---------------- */

  App.prototype.confirmMenu = function () {
    if (this.view !== "game" || UI.isDialogOpen()) { return; }
    if (this.replaying) {          // Esc: 第一段先退出复盘
      this.replaying = false;
      this.renderSidebar();
      return;
    }
    var self = this;
    if (!this.moves.length) { this.showMenu(); return; }
    UI.confirmDialog({
      title: "返回主菜单",
      message: "返回主菜单吗？当前对局进度将被丢弃。"
    }).then(function (ok) {
      if (ok) { self.showMenu(); }
    });
  };

  /* ---------------- 侧栏渲染 ---------------- */

  App.prototype.renderSidebar = function () {
    var env = this.env;
    var isGo = this.game === "go";
    var n = this.size;
    var sidebar = document.getElementById("sidebar");
    if (!env || this.view !== "game") { return; }

    var finished = env.done || this.resigned != null;

    /* 状态条 */
    var dotCls = "none";
    var first = "";
    var second = "";
    if (this.resigned != null) {
      var winnerColor = 3 - this.resigned;
      dotCls = winnerColor === BLACK ? "black" : "white";
      var winnerName = this.mode === "ai" ?
        (winnerColor === this.humanColor ? "你" : "AI") :
        (winnerColor === BLACK ? "黑方" : "白方");
      var loserName = this.mode === "ai" ?
        (this.resigned === this.humanColor ? "你" : "AI") :
        (this.resigned === BLACK ? "黑方" : "白方");
      first = winnerName + " 获胜";
      second = loserName + "认输 · 共 " + this.moves.length + " 手";
    } else if (env.done) {
      dotCls = env.winner === BLACK ? "black" : env.winner === WHITE ? "white" : "none";
      if (isGo) {
        var s = env.scoreDetail();
        var zi = (Math.abs(s.blackScore - s.whiteScore) / 2).toFixed(1);
        if (env.winner === BLACK) { first = "黑胜 " + zi + " 子"; }
        else if (env.winner === WHITE) { first = "白胜 " + zi + " 子"; }
        else { first = "和棋"; }
        second = "黑 " + s.blackScore + " · 白 " + s.whiteScore +
          " (含贴目 " + s.komi + ")";
      } else {
        var winName = env.winner == null ? null :
          (this.mode === "ai" ?
            (env.winner === this.humanColor ? "你" : "AI") :
            (env.winner === BLACK ? "黑方" : "白方"));
        first = winName ? winName + " 五连获胜" : "和棋（棋盘已下满）";
        second = "共 " + this.moves.length + " 手";
      }
    } else if (this.replaying) {
      dotCls = "none";
      first = "复盘中 " + this.replayIndex + " / " + this.moves.length;
      second = "空格 前进 · ← 后退 · Esc 退出";
    } else {
      var toPlay = env.toPlay;
      dotCls = toPlay === BLACK ? "black" : "white";
      if (this.aiBusy) {
        first = "AI 思考中…";
        second = "第 " + (this.moves.length + 1) + " 手";
      } else if (this.mode === "ai" && toPlay === this.humanColor) {
        first = "轮到你落子（" + (toPlay === BLACK ? "黑" : "白") + "）";
        second = isGo ?
          "第 " + (this.moves.length + 1) + " 手 · 点击落子或停一手" :
          "第 " + (this.moves.length + 1) + " 手 · 连成五子即胜";
      } else {
        first = "轮到 " + (toPlay === BLACK ? "黑方" : "白方");
        second = "第 " + (this.moves.length + 1) + " 手";
      }
    }
    if (this.scoreMode && isGo && !finished) {
      second = "数目 · " + this.scoreSummary();
    }
    if (this.flash && Date.now() < this.flash.until) { second = this.flash.text; }

    /* 玩家卡片 */
    var self = this;
    function pcard(color) {
      var name = self.mode === "ai" ?
        (color === self.humanColor ? "你" : "AI") :
        (color === BLACK ? "黑方" : "白方");
      var note = color === BLACK ? "执黑" : "执白";
      if (isGo && color === WHITE) { note += " · 贴目 " + env.komi; }
      var caps = isGo ? "提 " + env.captures[color] + " 子" : "";
      var active = !finished && !self.replaying && env.toPlay === color;
      return '<div class="pcard' + (active ? " active" : "") + '">' +
        '<span class="stone-ico ' + (color === BLACK ? "black" : "white") +
        '"></span><div class="pc-main"><div class="pc-label">' + name +
        '</div><div class="pc-note">' + note + '</div></div>' +
        (caps ? '<div class="pc-caps">' + caps + '</div>' : "") + "</div>";
    }

    /* 信息行 */
    function row(key, value, id) {
      return '<div class="row"><dt>' + key + '</dt><dd' +
        (id ? ' id="' + id + '"' : "") + ">" + value + "</dd></div>";
    }
    var lastText = "—";
    if (this.moves.length) {
      var lastMove = this.moves[this.moves.length - 1];
      lastText = lastMove.pass ? "停一手" :
        (lastMove.player === BLACK ? "黑 " : "白 ") +
        UI.coordText(lastMove.action, this.size);
    }
    var rows = row("棋种", (isGo ? "围棋 " : "五子棋 ") + n + "×" + n) +
      row("规则", isGo ? "中国规则 · 数子法" : "自由规则 · 无禁手") +
      row("手数", this.moves.length + " / " + (isGo ? env.maxMoves : n * n)) +
      row("用时", UI.formatDuration(this.elapsed()), "info-time") +
      row("最后落子", lastText);

    /* 按钮 */
    function btn(id, label, enabled) {
      return '<button data-btn="' + id + '"' + (enabled ? "" : " disabled") +
        ">" + label + "</button>";
    }
    var canAct = this.canPlay();
    var humanTurn = canAct && (this.mode !== "ai" || env.toPlay === this.humanColor);
    var groups = [];
    var g1 = [];
    if (isGo) { g1.push(btn("pass", "停一手", humanTurn)); }
    g1.push(btn("resign", "认输", humanTurn));
    if (isGo) { g1.push(btn("score", "数目", !this.replaying)); }
    if (g1.length) { groups.push(["对局", g1]); }
    if (this.mode === "ai" && this.game === "gomoku") {
      groups.push(["AI", [btn("predict", "预测着法",
        canAct && env.toPlay === this.humanColor)]]);
    }
    var g3 = [
      btn("new", "新的一局", !this.replaying),
      btn("undo", "悔棋", !this.replaying &&
        (this.history.length > 1 || this.resigned != null))
    ];
    if (this.mode === "ai") { g3.push(btn("color", "交换执子", true)); }
    groups.push(["操作", g3]);
    groups.push(["棋谱", [
      btn("replay", this.replaying ? "退出复盘" : "复盘", this.moves.length > 0),
      btn("save", "保存", this.moves.length > 0),
      btn("load", "导入", !this.replaying)
    ]]);
    groups.push(["其他", [
      btn("sound", "音效：" + (Sound.enabled ? "开" : (Sound.available ? "关" : "无")), true),
      btn("menu", "主菜单", true)
    ]]);
    var groupHtml = "";
    for (var g = 0; g < groups.length; g++) {
      groupHtml += '<div class="group-title">' + groups[g][0] + '</div>' +
        '<div class="btn-grid">' + groups[g][1].join("") + "</div>";
    }

    /* 着法记录 */
    var logHtml = "";
    for (var i = 0; i < this.moves.length; i++) {
      var m = this.moves[i];
      var text = m.pass ? "停一手" : UI.coordText(m.action, this.size);
      logHtml += "<li>" + (i + 1) + ". " + (m.player === BLACK ? "黑 " : "白 ") +
        text + "</li>";
    }

    var html = '<div class="side-title"><span class="stones-ico"></span>' +
      (isGo ? "围棋 " : "五子棋 ") + n + " 路</div>";
    html += '<div class="side-subtitle">' + (this.mode === "ai" ?
      "人机对战 · 你执" + (this.humanColor === BLACK ? "黑" : "白") : "双人对战") +
      "</div>";
    html += '<div class="side-sep"></div>';
    html += '<div class="player-cards">' + pcard(BLACK) + pcard(WHITE) + "</div>";
    html += '<div class="status-strip"><span class="dot ' + dotCls + '"></span>' +
      '<div><div class="status-first">' + first + '</div>' +
      '<div class="status-second">' + second + "</div></div></div>";
    html += '<div class="info-rows">' + rows + "</div>";
    html += '<div class="btn-groups">' + groupHtml + "</div>";
    html += '<div class="log-title">着法记录</div><div class="move-log">' +
      '<ol class="log-list">' + (logHtml || "<li>—</li>") + "</ol></div>";
    html += '<div class="side-hint">R 新对局 · U 悔棋 · D 数目 · P 复盘 · S 保存</div>';
    sidebar.innerHTML = html;
  };

  App.prototype.onButton = function (id) {
    switch (id) {
      case "pass": this.pass(); break;
      case "resign": this.resign(); break;
      case "score": this.scoreToggle(); break;
      case "predict": this.predict(); break;
      case "new": this.confirmNew(); break;
      case "undo": this.undo(); break;
      case "color": this.swapColor(); break;
      case "replay": this.replayToggle(); break;
      case "save": this.saveSgf(); break;
      case "load": this.loadSgf(); break;
      case "sound":
        Sound.toggle();
        this.renderSidebar();
        break;
      case "menu": this.confirmMenu(); break;
    }
  };

  /* ---------------- 输入事件 ---------------- */

  App.prototype.onMouseMove = function (e) {
    if (this.view !== "game" || !this.env) { return; }
    var rect = this.boardCanvas.canvas.getBoundingClientRect();
    var action = this.boardCanvas.pointToAction(
      e.clientX - rect.left, e.clientY - rect.top);
    var clickable = this.canPlay() &&
      (this.mode !== "ai" || this.env.toPlay === this.humanColor);
    this.hover = clickable ? action : null;
  };

  App.prototype.onClick = function (e) {
    Sound.init();
    if (this.view !== "game" || !this.env) { return; }
    var rect = this.boardCanvas.canvas.getBoundingClientRect();
    var action = this.boardCanvas.pointToAction(
      e.clientX - rect.left, e.clientY - rect.top);
    if (action == null) { return; }
    this.humanClick(action);
  };

  App.prototype.onKey = function (e) {
    Sound.init();
    if (UI.isDialogOpen()) { return; }
    if (this.menu.handleKey(e)) { return; }
    if (this.view !== "game" || !this.env) { return; }
    var key = e.key;
    if (this.replaying) {
      if (key === "Escape") {
        this.replaying = false;
        e.preventDefault();
        this.renderSidebar();
      } else if (key === " " || key === "ArrowRight") {
        this.replayStep(1);
        e.preventDefault();
      } else if (key === "ArrowLeft") {
        this.replayStep(-1);
        e.preventDefault();
      } else if (key === "p" || key === "P") {
        this.replayToggle();
        e.preventDefault();
      }
      return;
    }
    switch (key) {
      case "r": case "R": this.confirmNew(); break;
      case "u": case "U": case "Backspace": this.undo(); break;
      case "a": case "A": this.predict(); break;
      case "c": case "C": this.swapColor(); break;
      case "p": case "P": this.replayToggle(); break;
      case "d": case "D": this.scoreToggle(); break;
      case "s": case "S": this.saveSgf(); break;
      case "Escape": this.confirmMenu(); break;
      default: return;
    }
    e.preventDefault();
  };

  /* ---------------- 启动 ---------------- */

  function boot() {
    app = new App();
    app.boardCanvas = new UI.BoardCanvas(document.getElementById("board"));
    app.menu = new UI.MenuUI(document.getElementById("menu-view"),
      function (sel) { app.createGame(sel); });
    app.showMenu();

    /* 渲染循环: 仅对局视图绘制棋盘 (预测脉冲需要逐帧动画) */
    var loop = function () {
      if (app.view === "game" && app.env) {
        app.boardCanvas.render(app.snapshot());
      }
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);

    /* 用时行每秒刷新 (只改文本, 避免整栏重建) */
    setInterval(function () {
      if (app.view !== "game" || !app.env || !app.clockStart) { return; }
      var el = document.getElementById("info-time");
      if (el) { el.textContent = UI.formatDuration(app.elapsed()); }
    }, 1000);

    /* 音效: 首次用户手势解锁 WebAudio (浏览器自动播放策略) */
    window.addEventListener("pointerdown", function () { Sound.init(); });

    window.addEventListener("keydown", function (e) { app.onKey(e); });

    var canvas = document.getElementById("board");
    canvas.addEventListener("mousemove", function (e) { app.onMouseMove(e); });
    canvas.addEventListener("mouseleave", function () { app.hover = null; });
    canvas.addEventListener("click", function (e) { app.onClick(e); });

    var sidebar = document.getElementById("sidebar");
    sidebar.addEventListener("click", function (e) {
      var el = e.target.closest ? e.target.closest("[data-btn]") : null;
      if (!el || el.disabled) { return; }
      app.onButton(el.dataset.btn);
    });

    var input = document.getElementById("sgf-input");
    input.addEventListener("change", function () {
      if (input.files && input.files[0]) { app._onSgfFile(input.files[0]); }
    });

    window.addEventListener("beforeunload", function (e) {
      if (app.view === "game" && app.env && app.moves.length && !app.env.done &&
          app.resigned == null) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  boot();
})(window);
