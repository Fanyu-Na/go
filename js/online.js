/* 联机对战模块: WebRTC 点对点 (PeerJS) + 联机大厅界面.
   无需自建后端: 建房/寻址走 PeerJS 公共信令服务器, 棋局数据
   通过 P2P DataConnection 直传; 房主机为权威端, 每次变更广播
   {t:"state"} 完整局面, 客机重放动作序列保持一致.
   仅依赖浏览器 API 与 PeerJS, 任意静态托管 (含 Vercel) 可用. */

(function (global) {
  "use strict";

  /* PeerJS 公共信令服务器上的 id 命名空间, 避免与其它应用撞号 */
  var NS = "go-gomoku-web-v2-";
  /* 房间码字符表: 去掉 0/O/1/I/L 等易混字符 */
  var ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  var CODE_LEN = 5;
  var HEARTBEAT_MS = 4000;
  var STALE_MS = 15000;

  function peerAvailable() { return typeof global.Peer === "function"; }

  function genCode() {
    var s = "";
    for (var i = 0; i < CODE_LEN; i++) {
      s += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    }
    return s;
  }

  function friendlyError(type) {
    switch (type) {
      case "browser-incompatible": return "当前浏览器不支持 WebRTC 联机";
      case "network": return "无法连接信令服务器，请检查网络后重试";
      case "server-error": return "信令服务器暂时不可用，请稍后重试";
      case "socket-error": return "信令连接中断，请重试";
      case "socket-closed": return "信令连接被关闭，请重试";
      case "peer-unavailable": return "未找到该房间，请确认房间码或等待房主在线";
      case "unavailable-id": return "房间码冲突，正在换码重试…";
      case "webrtc": return "WebRTC 连接失败，可能是当前网络不支持点对点直连";
      default: return "联机出现错误（" + type + "）";
    }
  }

  /* ---------------- Net: PeerJS 封装 ----------------
     事件 (onEvent): waiting / connected / closed / error / peer-alive
     消息 (onMessage): 对方发来的业务消息 {t: ...} */

  function Net(opts) {
    opts = opts || {};
    this.role = null;            // host | guest
    this.code = null;
    this.peer = null;
    this.conn = null;
    this.alive = true;           // 心跳判定: 对方是否响应
    this.destroyed = false;
    this.onEvent = opts.onEvent || function () {};
    this.onMessage = opts.onMessage || function () {};
    this._hbTimer = null;
    this._checkTimer = null;
    this._lastSeen = 0;
  }

  Net.prototype.isReady = function () {
    return !this.destroyed && !!this.conn && this.conn.open === true;
  };

  Net.prototype.send = function (msg) {
    if (this.isReady()) {
      try { this.conn.send(msg); } catch (e) { /* 通道正在关闭, 忽略 */ }
    }
  };

  Net.prototype.host = function () {
    this.role = "host";
    this._dial(genCode(), 0);
  };

  Net.prototype.join = function (code) {
    this.role = "guest";
    this.code = code;
    this._connectGuest(code, 0);
  };

  /* 房主: 注册以房间码为 id 的 Peer; id 撞号则自动换码重试 */
  Net.prototype._dial = function (code, attempt) {
    var self = this;
    if (this.destroyed) { return; }
    if (!peerAvailable()) {
      this.onEvent({ type: "error",
        message: "联机组件 (PeerJS) 加载失败，请检查网络后刷新页面" });
      return;
    }
    this.code = code;
    var peer = new global.Peer(NS + code, {
      debug: 0,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun.cloudflare.com:3478" }
        ]
      }
    });
    this.peer = peer;
    peer.on("open", function () {
      if (!self.destroyed) { self.onEvent({ type: "waiting", code: self.code }); }
    });
    peer.on("connection", function (conn) { self._accept(conn); });
    peer.on("disconnected", function () {
      if (!self.destroyed && self.peer) { self.peer.reconnect(); }
    });
    peer.on("error", function (err) {
      if (self.destroyed) { return; }
      if (err.type === "unavailable-id" && attempt < 4) {
        peer.destroy();
        self._dial(genCode(), attempt + 1);
        return;
      }
      self.onEvent({ type: "error", message: friendlyError(err.type) });
    });
  };

  /* 客机: 匿名 Peer + 连到房主的 id */
  Net.prototype._connectGuest = function (code, attempt) {
    var self = this;
    if (this.destroyed) { return; }
    if (!peerAvailable()) {
      this.onEvent({ type: "error",
        message: "联机组件 (PeerJS) 加载失败，请检查网络后刷新页面" });
      return;
    }
    var peer = new global.Peer({
      debug: 0,
      config: {
        iceServers: [
          { urls: "stun:stun.l.google.com:19302" },
          { urls: "stun:stun.cloudflare.com:3478" }
        ]
      }
    });
    this.peer = peer;
    peer.on("open", function () {
      if (self.destroyed) { return; }
      var conn = peer.connect(NS + code, { reliable: true });
      self._accept(conn);
    });
    peer.on("disconnected", function () {
      if (!self.destroyed && self.peer) { self.peer.reconnect(); }
    });
    peer.on("error", function (err) {
      if (self.destroyed) { return; }
      if (err.type === "peer-unavailable") {
        self.onEvent({ type: "join-failed", message: friendlyError(err.type) });
        self.destroy();          // 回到可重新发起状态
        return;
      }
      if (attempt < 2 && (err.type === "network" || err.type === "socket-error" ||
          err.type === "socket-closed")) {
        peer.destroy();
        self._connectGuest(code, attempt + 1);
        return;
      }
      self.onEvent({ type: "error", message: friendlyError(err.type) });
    });
  };

  /* 双方通用: 挂接已建立 (或 incoming) 的 DataConnection */
  Net.prototype._accept = function (conn) {
    var self = this;
    /* 房主: 若已有旧连接 (对方重连/刷新页面), 先关旧的保新的 */
    if (this.role === "host" && this.conn && this.conn !== conn) {
      try { this.conn.close(); } catch (e) { /* 忽略 */ }
    }
    this.conn = conn;
    conn.on("open", function () {
      if (self.destroyed) { conn.close(); return; }
      self.alive = true;
      self._lastSeen = Date.now();
      self._startHeartbeat();
      self.onEvent({ type: "connected" });
    });
    conn.on("data", function (data) {
      if (self.destroyed || !data || typeof data !== "object") { return; }
      self._lastSeen = Date.now();
      if (data.t === "ping") { self.send({ t: "pong" }); return; }
      if (data.t === "pong") { return; }
      self.onMessage(data);
    });
    conn.on("close", function () {
      if (!self.destroyed) {
        self._stopHeartbeat();
        self.onEvent({ type: "closed" });
      }
    });
    conn.on("error", function () {
      if (!self.destroyed) {
        self._stopHeartbeat();
        self.onEvent({ type: "closed" });
      }
    });
  };

  Net.prototype._startHeartbeat = function () {
    var self = this;
    this._stopHeartbeat();
    this._hbTimer = setInterval(function () { self.send({ t: "ping" }); },
      HEARTBEAT_MS);
    this._checkTimer = setInterval(function () {
      var nowAlive = (Date.now() - self._lastSeen) < STALE_MS;
      if (nowAlive !== self.alive) {
        self.alive = nowAlive;
        self.onEvent({ type: "peer-alive", alive: nowAlive });
      }
    }, HEARTBEAT_MS);
  };

  Net.prototype._stopHeartbeat = function () {
    if (this._hbTimer) { clearInterval(this._hbTimer); this._hbTimer = null; }
    if (this._checkTimer) { clearInterval(this._checkTimer); this._checkTimer = null; }
  };

  Net.prototype.destroy = function () {
    this.destroyed = true;
    this._stopHeartbeat();
    if (this.conn) { try { this.conn.close(); } catch (e) { /* 忽略 */ } }
    if (this.peer) { try { this.peer.destroy(); } catch (e) { /* 忽略 */ } }
    this.conn = null;
    this.peer = null;
  };

  /* ---------------- LobbyUI: 联机大厅界面 ----------------
     状态机: choose (创建/加入) -> hosting (等对手) / joining (输码)
     callbacks: { onCreate(), onJoin(code), onBack(), onShareLink(code) } */

  function LobbyUI(root, callbacks) {
    this.root = root;
    this.cb = callbacks || {};
    this.stage = "choose";       // choose | hosting | joining
    this.code = "";
    this.status = "";
    this.waiting = false;        // 状态行是否带动态省略号
    this.error = "";
    this.busy = false;
  }

  LobbyUI.prototype.show = function () {
    this.stage = "choose";
    this.status = "";
    this.waiting = false;
    this.error = "";
    this.busy = false;
    this.render();
  };

  LobbyUI.prototype.setHosting = function (code) {
    this.stage = "hosting";
    this.code = code;
    this.status = "等待对手加入";
    this.waiting = true;
    this.error = "";
    this.render();
  };

  LobbyUI.prototype.setJoining = function (code) {
    this.stage = "joining";
    this.code = code;
    this.status = "正在连接对方";
    this.waiting = true;
    this.error = "";
    this.busy = true;
    this.render();
  };

  LobbyUI.prototype.setStatus = function (text, waiting) {
    this.status = text;
    this.waiting = !!waiting;
    this.render();
  };

  LobbyUI.prototype.setError = function (text) {
    this.error = text;
    this.busy = false;
    this.waiting = false;
    this.render();
  };

  LobbyUI.prototype.hide = function () {
    this.root.innerHTML = "";
    this.root.classList.add("hidden");
  };

  LobbyUI.prototype.render = function () {
    var self = this;
    var html = '<div class="menu-brand">ONLINE · 点对点联机</div>';
    html += '<div class="menu-title">联机对战</div>';
    html += '<div class="menu-subtitle">' + this.subtitle() + '</div>';
    html += '<div class="menu-rule"></div>';

    if (this.stage === "choose") {
      html += '<div class="cards">';
      html += '<div class="card" data-act="create">' +
        '<canvas class="preview" width="300" height="196" data-pattern="go9" data-size="9"></canvas>' +
        '<span class="badge">房主</span>' +
        '<div class="card-label">创建对局</div>' +
        '<div class="card-desc">生成房间码 · 你执黑先行<br>把房间码或链接发给好友</div></div>';
      html += '<div class="card" data-act="join">' +
        '<canvas class="preview" width="300" height="196" data-pattern="gomoku" data-size="15"></canvas>' +
        '<span class="badge amber">客队</span>' +
        '<div class="card-label">加入对局</div>' +
        '<div class="card-desc">输入对方给你的房间码<br>你执白后手</div></div>';
      html += '</div>';
      html += '<div class="lobby-note">联机为浏览器点对点直连 (WebRTC)，无需服务器；' +
        '少数受限网络下可能无法建立连接，可换网络重试。</div>';
    } else if (this.stage === "hosting") {
      html += '<div class="lobby-panel">';
      html += '<div class="lobby-label">房间码 · 发给好友加入</div>';
      html += '<div class="lobby-code">' + this.code + '</div>';
      html += '<div class="lobby-status' + (this.waiting ? " waiting" : "") + '">' +
        this.status + (this.waiting ? '<span class="dots"><i>·</i><i>·</i><i>·</i></span>' : "") +
        '</div>';
      if (this.error) { html += '<div class="lobby-error">' + this.error + '</div>'; }
      html += '<div class="lobby-actions">' +
        '<button data-act="copy-link">复制链接</button>' +
        '<button data-act="copy-code">复制房间码</button>' +
        '<button data-act="cancel">取消</button></div>';
      html += '</div>';
    } else {
      html += '<div class="lobby-panel">';
      html += '<div class="lobby-label">对方房间码</div>';
      html += '<input id="lobby-code-input" class="lobby-input" ' +
        'maxlength="' + CODE_LEN + '" autocomplete="off" spellcheck="false" ' +
        'placeholder="如 K7F2Q" value="' + this.code + '">';
      html += '<div class="lobby-status' + (this.waiting ? " waiting" : "") + '">' +
        this.status + (this.waiting ? '<span class="dots"><i>·</i><i>·</i><i>·</i></span>' : "") +
        '</div>';
      if (this.error) { html += '<div class="lobby-error">' + this.error + '</div>'; }
      html += '<div class="lobby-actions">' +
        '<button data-act="go" ' + (this.busy ? "disabled" : "") + '>加入</button>' +
        '<button data-act="cancel">返回</button></div>';
      html += '</div>';
    }

    html += '<div class="menu-footer"><span><kbd>Esc</kbd> ' +
      (this.stage === "choose" ? "返回主菜单" : "返回上一步") + '</span></div>';
    if (this.stage === "choose") {
      html += '<button id="menu-back" title="返回主菜单">←</button>';
    }
    this.root.classList.remove("hidden");
    this.root.innerHTML = html;

    var canvases = this.root.querySelectorAll("canvas.preview");
    if (global.UI && global.UI.drawPreview) {
      for (var c = 0; c < canvases.length; c++) { global.UI.drawPreview(canvases[c]); }
    }

    var input = this.root.querySelector("#lobby-code-input");
    if (input) {
      input.addEventListener("input", function () {
        /* 只保留房间码字符表内的字符 (自动去易混的 I/L/O/0/1) */
        input.value = input.value.toUpperCase().replace(
          new RegExp("[^" + ALPHABET + "]", "g"), "");
        self.code = input.value;
      });
      input.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          self.cb.onJoin(self.code);
        } else if (e.key === "Escape") {
          e.preventDefault();
          self.cb.onCancel();
        }
        e.stopPropagation();
      });
      if (!this.busy) { input.focus(); }
    }

    var els = this.root.querySelectorAll("[data-act]");
    for (var i = 0; i < els.length; i++) {
      els[i].addEventListener("click", function (e) {
        var act = e.currentTarget.dataset.act;
        e.stopPropagation();
        if (act === "create") { self.cb.onCreate(); }
        else if (act === "join") { self.cb.onJoin(self.code); }
        else if (act === "copy-link") { self.cb.onShareLink(self.code, "link"); }
        else if (act === "copy-code") { self.cb.onShareLink(self.code, "code"); }
        else if (act === "cancel") { self.cb.onCancel(); }
        else if (act === "go") { self.cb.onJoin(self.code); }
      });
    }
    var back = this.root.querySelector("#menu-back");
    if (back) {
      back.addEventListener("click", function (e) {
        e.stopPropagation();
        self.cb.onBack();
      });
    }
  };

  LobbyUI.prototype.subtitle = function () {
    if (this.stage === "hosting") { return "已创建房间，等待对手"; }
    if (this.stage === "joining") { return "加入对方的房间"; }
    return "与好友通过网络远程对局";
  };

  /* Esc / Enter 键处理; 返回 true 表示已消费 */
  LobbyUI.prototype.handleKey = function (e) {
    if (this.root.classList.contains("hidden")) { return false; }
    if (e.key === "Escape") {
      e.preventDefault();
      this.cb.onCancel();
      return true;
    }
    if (e.key === "Enter" && this.stage === "joining") {
      e.preventDefault();
      this.cb.onJoin(this.code);
      return true;
    }
    return false;
  };

  global.Online = {
    Net: Net,
    LobbyUI: LobbyUI,
    genCode: genCode,
    CODE_LEN: CODE_LEN,
    peerAvailable: peerAvailable
  };
})(window);
