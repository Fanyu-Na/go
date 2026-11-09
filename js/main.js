/* 应用控制器: 对局流程 / 侧栏渲染 / 键盘鼠标交互 / 联机同步.
   移植自桌面版 scripts/play_gui.py, 不含任何模型或后端服务:
   - 围棋双人对战 (中国规则, 双停一手自动数子)
   - 五子棋双人对战 / 人机对战 (内置启发式 AI)
   - 联机对战 (WebRTC 点对点, 见 online.js): 房主机为权威端,
     每次变更广播完整动作序列, 客机确定性重放保持一致 */

(function (global) {
  "use strict";

  var BLACK = 1;
  var WHITE = 2;
  var KOMI = { 9: 5.5, 13: 6.5, 19: 7.5 };
  var PREDICTION_MS = 6000;
  var AI_DELAY_MS = 300;

  var app = null;

  function App() {
    this.view = "menu";          // menu | lobby | game
    this.game = "go";
    this.size = 9;
    this.mode = "pvp";           // pvp | ai | online
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
    /* 联机相关 */
    this.net = null;             // Online.RelayClient 实例, null = 本地对局
    this.myColor = BLACK;        // 联机中我方执子
    this.netStarted = false;     // 联机: 是否已应用过服务器棋局状态
    this.netReq = null;          // undo | restart, 等待对方应答的请求
    this.lobby = null;           // Online.LobbyUI 实例
    this.lobbySettings = null;   // 大厅对应的棋种/路数
    this.roomCode = null;
    this._lastVersion = 0;       // 已应用的服务器状态版本 (防旧包回放)
    this._lastResultVersion = 0; // 已展示过的请求回执版本
    this._reqSeenKey = "";       // 已弹过确认框的请求 (防重复弹窗)
  }

  /* ---------------- 对局创建与视图切换 ---------------- */

  App.prototype.createGame = function (settings) {
    this.game = settings.game;
    this.size = settings.size;
    this.mode = settings.mode;
    this.humanColor = settings.humanColor || BLACK;
    this.net = settings.net || null;
    this.myColor = settings.myColor || this.humanColor;
    this.netStarted = false;
    this.netReq = null;
    this._lastVersion = 0;
    this._lastResultVersion = 0;
    this._reqSeenKey = "";
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
    document.getElementById("lobby-view").classList.toggle(
      "hidden", this.view !== "lobby");
    document.getElementById("game-view").classList.toggle(
      "hidden", this.view !== "game");
  };

  App.prototype.showMenu = function () {
    this.version += 1;
    this.view = "menu";
    this.showViews();
    this.menu.render();
  };

  /* ---------------- 联机: 大厅与建立连接 ---------------- */

  App.prototype.openLobby = function (settings) {
    this.version += 1;
    this.lobbySettings = settings;
    this.view = "lobby";
    if (!this.lobby) {
      var self = this;
      this.lobby = new global.Online.LobbyUI(
        document.getElementById("lobby-view"), {
          onCreate: function () { self.startHosting(); },
          onJoin: function (code) { self.joinRoom(code); },
          onCancel: function () { self.lobbyBack(); },
          onBack: function () { self.lobbyBack(); },
          onShareLink: function (code, what) { self.shareRoom(code, what); }
        });
    }
    if (settings && settings.autoJoin) {
      this.lobby.setJoining(settings.autoJoin);
      this.joinRoom(settings.autoJoin);
      return;
    }
    this.lobby.show();
    this.showViews();
  };

  App.prototype.lobbyBack = function () {
    this.destroyNet();
    if (this.lobby && (this.lobby.stage === "choose")) {
      this.showMenu();
      return;
    }
    /* 从等待/加入界面回到大厅选择页 */
    this.lobby.show();
    this.view = "lobby";
    this.showViews();
  };

  App.prototype.destroyNet = function () {
    if (this.net) {
      this.net.destroy();
      this.net = null;
    }
    this.netStarted = false;
    this.netReq = null;
    this.roomCode = null;
    this._lastVersion = 0;
    this._lastResultVersion = 0;
    this._reqSeenKey = "";
  };

  App.prototype.startHosting = function () {
    var self = this;
    this.destroyNet();
    var s = this.lobbySettings || { game: "go", size: 9 };
    this.net = new global.Online.RelayClient({
      onEvent: function (ev) { self.onNetEvent(ev); },
      onState: function (st) { self.onRoomState(st); }
    });
    var komi = KOMI[s.size] != null ? KOMI[s.size] : 5.5;
    this.net.createRoom(s.game, s.size, komi)
      .catch(function (e) {
        if (self.lobby) {
          self.lobby.setError(String(e && e.message || e));
          self.lobby.busy = false;
          self.lobby.render();
        }
      });
    this.lobby.setStatus("正在创建房间", true);
  };

  App.prototype.joinRoom = function (code) {
    code = String(code || "").toUpperCase().trim();
    if (!/^[A-Z0-9]{5}$/.test(code)) {
      if (this.lobby) {
        this.lobby.setError("请输入 5 位房间码");
        this.lobby.busy = false;
        this.lobby.render();
      }
      return;
    }
    var self = this;
    this.destroyNet();
    this.lobby.setJoining(code);
    this.view = "lobby";
    this.showViews();
    this.net = new global.Online.RelayClient({
      onEvent: function (ev) { self.onNetEvent(ev); },
      onState: function (st) { self.onRoomState(st); }
    });
    this.net.join(code, global.Online.savedToken(code))
      .catch(function (e) {
        if (self.net && self.net.destroyed) { return; }
        self.onNetEvent({ type: "join-failed", message: String(e && e.message || e) });
        if (self.net) { self.net.destroy(); }
      });
    this.roomCode = code;
  };

  App.prototype.shareRoom = function (code, what) {
    var self = this;
    var isHttp = location.protocol === "http:" || location.protocol === "https:";
    var link = isHttp ?
      location.origin + location.pathname + "?room=" + code : "";
    var text = what === "link" && link ? link : code;
    if (what === "link" && !link) { text = code; }
    function done(ok) {
      if (self.lobby) {
        self.lobby.setStatus(ok ? "已复制，发给好友吧" : "复制失败，请手动复制");
        setTimeout(function () {
          if (self.lobby && self.lobby.stage === "hosting") {
            self.lobby.setStatus("等待对手加入", true);
          }
        }, 2500);
      }
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); },
        function () { done(false); });
    } else {
      try {
        var ta = document.createElement("textarea");
        ta.value = text;
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
        done(true);
      } catch (e) { done(false); }
    }
  };

  /* ---------------- 联机: 服务器状态同步 ---------------- */

  /* 服务器为权威端: 双方都以轮询拿到的房间快照驱动本端棋局.
     - 客队加入即立局; 房主等对方就座 (guestReady) 才进对局视图.
     - version 单调递增, 过期状态直接丢弃. */
  App.prototype.onRoomState = function (state) {
    if (!this.net) { return; }
    if (this.netStarted && state.version <= this._lastVersion) { return; }
    var self = this;

    if (this.view !== "game") {
      if (this.net.color === BLACK && !state.guestReady) {
        /* 房主刷新回到房间但对方未在: 切回等待对手界面 */
        if (this.lobby && this.lobby.stage === "joining" && this.roomCode) {
          this.lobby.setHosting(this.roomCode);
        }
        return;
      }
      if (this.lobby) { this.lobby.hide(); this.lobby = null; }
      this.createGame({
        game: state.game, size: state.size, mode: "online",
        humanColor: this.net.color, myColor: this.net.color, net: this.net
      });
      this.netStarted = true;
      this.flashStatus(this.net.color === BLACK ?
        "对手已就座，对局开始" : "已加入，正在同步棋局…");
    }

    this.applyRemoteState(state);
    this._lastVersion = state.version;

    /* 请求协商: 我发起的 -> 维持「等待应答」提示; 对方发来的 -> 弹窗 */
    var req = state.req;
    if (req && req.from === this.myColor) {
      this.netReq = req.kind;
    } else if (req && req.from !== this.myColor) {
      var key = state.version + ":" + req.kind;
      if (this._reqSeenKey !== key && !UI.isDialogOpen()) {
        this._reqSeenKey = key;
        var isUndo = req.kind === "undo";
        UI.confirmDialog({
          title: isUndo ? "悔棋请求" : "再来一局",
          message: isUndo ? "对方请求悔去最后一手，是否同意？" :
            "对方想开一局新的，是否接受？",
          confirmText: isUndo ? "同意悔棋" : "接受"
        }).then(function (ok) {
          if (self.net && !self.net.destroyed) {
            self.net.ack(ok).catch(function () { /* 状态轮询会纠正 */ });
          }
        });
      }
    }
    if (!req) { this._reqSeenKey = ""; }

    /* 我发起的请求被处理 -> 展示回执 (netReq 非空说明请求是我发的) */
    if (state.reqResult && state.resultVersion > this._lastResultVersion) {
      this._lastResultVersion = state.resultVersion;
      if (this.netReq) {
        this.netReq = null;
        var k = state.reqResult.kind;
        this.flashStatus(state.reqResult.accepted ?
          (k === "undo" ? "对方同意了悔棋" : "对方同意了再来一局") :
          (k === "undo" ? "对方拒绝了悔棋请求" : "对方拒绝了再来一局"));
      }
    }
  };

  /* 客机/重连者: 重放房主发来的动作序列, 重建本端棋局 */
  App.prototype.applyRemoteState = function (msg) {
    var env;
    var wasLen = this.moves.length;
    if (msg.game === "go") {
      env = new global.GoEnv({
        boardSize: msg.size,
        komi: msg.komi != null ? msg.komi :
          (KOMI[msg.size] != null ? KOMI[msg.size] : 5.5),
        maxMoves: 2 * msg.size * msg.size
      });
    } else {
      env = new global.GomokuEnv({ boardSize: msg.size });
    }
    this.game = msg.game;
    this.size = msg.size;
    this.env = env;
    this.history = [env.copy()];
    this.moves = [];
    var grew = msg.moves.length === wasLen + 1;
    for (var i = 0; i < msg.moves.length; i++) {
      var a = msg.moves[i];
      if (!env.isLegal(a)) { break; }   // 理论上不会发生; 防御
      var info = env.play(a);
      this.history.push(env.copy());
      this.moves.push({
        action: a, player: info.player,
        captured: info.captured || [],
        pass: this.game === "go" && a === env.passAction
      });
    }
    this.netStarted = true;
    this.version += 1;
    this.replaying = false;
    this.aiBusy = false;
    this.prediction = null;
    this.scoreMode = false;
    this.territory = null;
    this.hover = null;
    this.resigned = msg.resigned != null ? msg.resigned : null;
    if (this.boardCanvas.boardSize !== this.size) {
      this.boardCanvas.setBoardSize(this.size);
    }
    if (env.done) {
      this.clockPause();
      if (this.game === "go") {
        this.scoreMode = true;
        this.territory = env.territoryMap();
      }
      Sound.play("end");
    } else if (this.resigned != null) {
      this.clockPause();
      Sound.play("end");
    } else if (grew) {
      var lm = this.moves[this.moves.length - 1];
      if (lm.captured && lm.captured.length) { Sound.play("capture"); }
      else if (!lm.pass) { Sound.play("stone"); }
    }
    this.renderSidebar();
  };

  /* ---------------- 联机: 网络事件 / 消息协议 ---------------- */

  App.prototype.onNetEvent = function (ev) {
    switch (ev.type) {
      case "waiting":
      case "joined":
        this.roomCode = ev.code;
        global.Online.rememberToken(ev.code, this.net.token);
        /* 地址栏带上房间码: 刷新页面自动回到本房间并认回原席位 */
        try {
          history.replaceState(null, "",
            location.pathname + "?room=" + ev.code);
        } catch (err) { /* file:// 等环境忽略 */ }
        if (ev.type === "waiting" && this.lobby) {
          this.lobby.setHosting(ev.code);
        }
        break;
      case "join-failed":
        this.destroyNet();
        if (this.lobby) {
          this.lobby.setError(ev.message);
          this.lobby.busy = false;
          this.lobby.render();
        } else if (this.view === "game") {
          this.flashStatus("重连失败：" + ev.message);
        }
        break;
      case "closed":
        this.netReq = null;
        if (this.lobby) {
          this.lobby.setError("房间已关闭或不存在，请重试");
          this.lobby.busy = false;
          this.lobby.render();
        } else if (this.view === "game" && this.net) {
          this.flashStatus("对方已关闭房间");
          this.renderSidebar();
        }
        break;
      case "peer-alive":
        if (this.view === "game" && this.net) { this.renderSidebar(); }
        break;
      case "error":
        if (this.lobby) {
          this.lobby.setError(ev.message);
          this.lobby.busy = false;
          this.lobby.render();
        } else if (this.view === "game") {
          this.flashStatus(ev.message);
        }
        break;
    }
  };

  /* 断线重连: 凭会话里保存的席位 token 认回原席位并继续同步.
     棋局状态存于服务器, 重连即恢复整局, 与哪端先掉线无关. */
  App.prototype.reconnectOnline = function () {
    if (!this.roomCode) { return; }
    var code = this.roomCode;
    var self = this;
    this.destroyNet();
    this.net = new global.Online.RelayClient({
      onEvent: function (ev) { self.onNetEvent(ev); },
      onState: function (st) { self.onRoomState(st); }
    });
    this.roomCode = code;
    this.net.join(code, global.Online.savedToken(code))
      .catch(function () { /* join-failed 事件已处理提示 */ });
    this.flashStatus("正在重连…");
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
    if (this.net && (!this.net.isReady() || this.env.toPlay !== this.myColor)) {
      return false;
    }
    return this.view === "game" && !this.env.done && this.resigned == null &&
      !this.replaying && !this.aiBusy && !UI.isDialogOpen();
  };

  /* 联机时双方共用 nameOf: 你 / 对方 */
  App.prototype.nameOf = function (color) {
    if (this.net) { return color === this.myColor ? "你" : "对方"; }
    if (this.mode === "ai") { return color === this.humanColor ? "你" : "AI"; }
    return color === BLACK ? "黑方" : "白方";
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
    if (this.net) {
      if (this.env.toPlay !== this.myColor) {
        this.flashStatus("等待对方落子…");
        return;
      }
      if (!this.env.isLegal(action)) {
        this.flashStatus(this.game === "go" ?
          "此处不能落子（禁着点或已被占用）" : "此处已有棋子");
        return;
      }
      var self = this;
      this.net.move(action).catch(function (e) {
        self.flashStatus(String((e && e.message) || "落子失败，请重试"));
      });
      return;
    }
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
    if (this.net) {
      var selfNet = this;
      this.net.move(this.env.passAction).catch(function (e) {
        selfNet.flashStatus(String((e && e.message) || "操作失败，请重试"));
      });
      return;
    }
    if (this.mode === "ai" && this.env.toPlay !== this.humanColor) { return; }
    this.applyMove(this.env.passAction);
    if (this.mode === "ai" && !this.env.done) { this.scheduleAi(); }
  };

  App.prototype.undo = function () {
    if (this.view !== "game" || this.replaying || !this.history.length ||
        UI.isDialogOpen()) {
      return;
    }
    /* 联机: 悔棋需对方同意 (req / ack 协商, 服务器裁决) */
    if (this.net) {
      var self = this;
      if (this.resigned != null || !this.moves.length ||
          this.netReq != null || !this.net.isReady()) {
        return;
      }
      UI.confirmDialog({
        title: "悔棋",
        message: "向对方请求悔去最后一手吗？对方同意后才会生效。",
        confirmText: "发送请求"
      }).then(function (ok) {
        if (!ok || !self.net || !self.net.isReady() || self.netReq != null) {
          return;
        }
        self.net.req("undo").catch(function () { /* 状态轮询会纠正 */ });
        self.renderSidebar();
      });
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
    /* 联机: 认输上报服务器, 以状态回执为准 */
    if (this.net) {
      var selfNet = this;
      UI.confirmDialog({
        title: "认输",
        message: "确定认输吗？对局将结束，对方获胜。",
        confirmText: "认输",
        danger: true
      }).then(function (ok) {
        if (!ok || !selfNet.net || selfNet.resigned != null) { return; }
        selfNet.net.resign().catch(function (e) {
          selfNet.flashStatus(String((e && e.message) || "操作失败，请重试"));
        });
      });
      return;
    }
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
    /* 联机: 开新局需对方同意 (req / ack 协商, 服务器裁决) */
    if (this.net) {
      if (this.netReq != null || !this.net.isReady()) { return; }
      UI.confirmDialog({
        title: "再来一局",
        message: "向对方请求开一局新的吗？对方接受后才会重开。",
        confirmText: "发送请求"
      }).then(function (ok) {
        if (!ok || !self.net || !self.net.isReady() || self.netReq != null) {
          return;
        }
        self.net.req("restart").catch(function () { /* 状态轮询会纠正 */ });
        self.renderSidebar();
      });
      return;
    }
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
    if (this.net) {
      UI.confirmDialog({
        title: "断开联机",
        message: "断开并关闭房间，返回主菜单吗？对方将看到房间已关闭。",
        confirmText: "断开"
      }).then(function (ok) {
        if (ok) {
          self.net.close();       // 通知服务器删除房间
          self.destroyNet();
          self.showMenu();
          try { history.replaceState(null, "", location.pathname); } catch (err) { /* 忽略 */ }
        }
      });
      return;
    }
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
      first = this.nameOf(winnerColor) + " 获胜";
      second = this.nameOf(this.resigned) + "认输 · 共 " + this.moves.length + " 手";
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
        var winName = env.winner == null ? null : this.nameOf(env.winner);
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
      } else if (this.net) {
        var myTurn = toPlay === this.myColor;
        first = myTurn ?
          "轮到你落子（" + (toPlay === BLACK ? "黑" : "白") + "）" :
          "等待对方落子…";
        second = isGo ?
          "第 " + (this.moves.length + 1) + " 手" +
            (myTurn ? " · 点击落子或停一手" : "") :
          "第 " + (this.moves.length + 1) + " 手" +
            (this.game === "gomoku" && myTurn ? " · 连成五子即胜" : "");
        if (this.netReq) {
          second = this.netReq === "undo" ? "悔棋请求待对方应答…" : "开新局请求待对方应答…";
        } else if (!this.net.isReady()) {
          second = "对方已关闭房间";
        } else if (!this.net.alive) {
          second = "对方离线中…（棋局已保存，可继续落子）";
        }
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
      var name = self.nameOf(color);
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
    var netReady = !this.net || this.net.isReady();
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
      btn("new", this.net && finished ? "再来一局" : "新的一局",
        !this.replaying && netReady && this.netReq == null),
      btn("undo", "悔棋", !this.replaying && netReady && this.netReq == null &&
        (this.net ?
          (this.history.length > 1 && this.resigned == null) :
          (this.history.length > 1 || this.resigned != null)))
    ];
    if (this.mode === "ai") { g3.push(btn("color", "交换执子", true)); }
    groups.push(["操作", g3]);
    groups.push(["棋谱", [
      btn("replay", this.replaying ? "退出复盘" : "复盘", this.moves.length > 0),
      btn("save", "保存", this.moves.length > 0),
      btn("load", "导入", !this.replaying && !this.net)
    ]]);
    var gOthers = [
      btn("sound", "音效：" + (Sound.enabled ? "开" : (Sound.available ? "关" : "无")), true)
    ];
    if (this.net && !this.net.isReady()) { gOthers.push(btn("reconnect", "重连", true)); }
    gOthers.push(btn("menu", this.net ? "断开返回" : "主菜单", true));
    groups.push(["其他", gOthers]);
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
    var subtitle = this.mode === "ai" ?
      "人机对战 · 你执" + (this.humanColor === BLACK ? "黑" : "白") : "双人对战";
    if (this.net) {
      subtitle = "联机对战" +
        (this.roomCode ? " · 房间 " + this.roomCode : "") +
        " · 你执" + (this.myColor === BLACK ? "黑先行" : "白后手");
    }
    html += '<div class="side-subtitle">' + subtitle + "</div>";
    html += '<div class="side-sep"></div>';
    html += '<div class="player-cards">' + pcard(BLACK) + pcard(WHITE) + "</div>";
    if (this.net) {
      var pillCls = !this.net.isReady() ? "bad" : (this.net.alive ? "ok" : "warn");
      var pillText = !this.net.isReady() ? "对方已关闭房间" :
        (this.net.alive ? "对方在线 · 服务器中继" : "对方离线 · 棋局已保存");
      html += '<div class="net-pill ' + pillCls + '"><span class="np-dot"></span>' +
        pillText + "</div>";
    }
    html += '<div class="status-strip"><span class="dot ' + dotCls + '"></span>' +
      '<div><div class="status-first">' + first + '</div>' +
      '<div class="status-second">' + second + "</div></div></div>";
    html += '<div class="info-rows">' + rows + "</div>";
    html += '<div class="btn-groups">' + groupHtml + "</div>";
    html += '<div class="log-title">着法记录</div><div class="move-log">' +
      '<ol class="log-list">' + (logHtml || "<li>—</li>") + "</ol></div>";
    html += '<div class="side-hint">' + (this.net ?
      "R 再来一局 · U 悔棋 · D 数目 · P 复盘 · S 保存" :
      "R 新对局 · U 悔棋 · D 数目 · P 复盘 · S 保存") + "</div>";
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
      case "reconnect": this.reconnectOnline(); break;
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
    if (this.view === "lobby" && this.lobby) {
      this.lobby.handleKey(e);
      return;
    }
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
      function (sel) {
        if (sel.mode === "online") { app.openLobby(sel); return; }
        app.createGame(sel);
      });
    app.showMenu();

    /* ?room=XXXXX 链接直达: 跳过菜单, 直接进入加入流程 */
    var m = location.search.match(/[?&]room=([A-Za-z0-9]{1,10})/);
    if (m) {
      app.openLobby({ game: "go", size: 9, autoJoin: m[1].toUpperCase() });
    }

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
      /* 联机中刷新/关闭只作提醒: 棋局存在服务器, 凭 ?room= 链接和
         会话 token 刷新后可无缝认回席位继续下 */
      if (app.view === "game" && app.net && app.env && app.moves.length &&
          !app.env.done && app.resigned == null) {
        e.preventDefault();
        e.returnValue = "";
      }
    });
  }

  boot();
})(window);
