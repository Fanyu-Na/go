/* 联机对战模块: 信令走公共 MQTT broker (EMQX, 大陆访问快) + WebRTC 点对点直传
   + 联机大厅界面. 无需自建后端, 任意静态托管 (含 Vercel) 可用.
   - 信令: 双方订阅同一 MQTT 主题交换 SDP (offer/answer), 采用非 trickle ICE:
     候选收集完毕后一次性互发完整 SDP, 免去逐条 candidate 转发, 握手往返最少.
   - 棋局: RTCPeerConnection DataChannel 直传 JSON, 不经过任何服务器.
   - 房主机为权威端, 每次变更广播 {t:"state"} 完整局面 (见 main.js). */

(function (global) {
  "use strict";

  /* 房间码字符表: 去掉 0/O/1/I/L 等易混字符 */
  var ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  var CODE_LEN = 5;

  /* 信令节点按序尝试 (超时自动换下一个). 双方必须落在同一节点才能握手,
     因此两端使用完全相同的尝试顺序; 首选大陆可达的 EMQX 节点. */
  var SIGNAL_SERVERS = [
    "wss://broker-cn.emqx.io:8084/mqtt",
    "wss://broker.emqx.io:8084/mqtt",
    "wss://test.mosquitto.org:8081/mqtt"
  ];
  var TOPIC_ROOT = "go-gomoku-web-v3";
  var SERVER_TIMEOUT_MS = 7000;      // 单个信令节点连接超时
  var HANDSHAKE_TIMEOUT_MS = 12000;  // 加入 -> 数据通道打通的总时限
  var GATHER_TIMEOUT_MS = 2500;      // ICE 候选收集兜底时限
  var HEARTBEAT_MS = 4000;
  var STALE_MS = 15000;

  /* STUN 选大陆可达的公共节点 (Google STUN 在大陆不可达, 会拖慢探测) */
  function rtcConfig() {
    return {
      iceServers: [
        { urls: "stun:stun.miwifi.com:3478" },
        { urls: "stun:stun.cloudflare.com:3478" }
      ]
    };
  }

  function libAvailable() {
    return !!(global.mqtt && typeof global.mqtt.connect === "function");
  }

  function decodePayload(p) {
    try {
      if (global.TextDecoder) { return new TextDecoder().decode(p); }
    } catch (e) { /* 退化到 toString */ }
    return String(p);
  }

  function genCode() {
    var s = "";
    for (var i = 0; i < CODE_LEN; i++) {
      s += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    }
    return s;
  }

  function friendlyError(type) {
    switch (type) {
      case "lib": return "联机组件 (MQTT.js) 加载失败，请检查网络后刷新页面";
      case "signal": return "无法连接信令节点，请检查网络后重试";
      case "no-host": return "未找到该房间：请确认房间码，且房主页面保持打开";
      case "webrtc": return "直连建立失败：当前网络可能不支持点对点连接，请换网络重试";
      default: return "联机出现错误（" + type + "）";
    }
  }

  /* ---------------- Net: 信令 + WebRTC 封装 ----------------
     对外接口与事件与旧版一致, main.js 无感知:
     事件 (onEvent): waiting / connected / closed / error / join-failed / peer-alive
     消息 (onMessage): 对方经数据通道发来的业务消息 {t: ...} */

  function Net(opts) {
    opts = opts || {};
    this.role = null;            // host | guest
    this.code = null;
    this.topic = null;
    this.myId = TOPIC_ROOT + "-" + Math.random().toString(36).slice(2, 10);
    this.client = null;          // MQTT 信令客户端
    this.pc = null;              // RTCPeerConnection
    this.dc = null;              // DataChannel
    this.alive = true;           // 心跳判定: 对方是否响应
    this.destroyed = false;
    this.onEvent = opts.onEvent || function () {};
    this.onMessage = opts.onMessage || function () {};
    this._serverIdx = 0;
    this._everUp = false;        // 信令是否连上过 (区分首连失败与闪断)
    this._falling = false;       // 正在切换信令节点
    this._guestId = null;        // 房主: 当前握手中的 guest id
    this._answered = false;      // 房主: 已收到 answer, 忽略重复
    this._joinSends = 0;         // 客机: join 重发计数
    this._lastSeen = 0;
    this._hbTimer = null;
    this._checkTimer = null;
    this._watchTimer = null;
    this._joinTimer = null;
  }

  Net.prototype.isReady = function () {
    return !this.destroyed && !!this.dc && this.dc.readyState === "open";
  };

  Net.prototype.send = function (msg) {
    if (this.isReady()) {
      try { this.dc.send(JSON.stringify(msg)); } catch (e) { /* 通道正在关闭 */ }
    }
  };

  Net.prototype.host = function () {
    this.role = "host";
    this._begin(genCode(), 0);
  };

  Net.prototype.join = function (code) {
    this.role = "guest";
    this.code = code;
    this._begin(code, 0);
  };

  /* 连接信令节点; 首连失败自动换下一个节点 */
  Net.prototype._begin = function (code, serverIdx) {
    var self = this;
    if (this.destroyed) { return; }
    if (!libAvailable()) {
      this.onEvent({ type: "error", message: friendlyError("lib") });
      return;
    }
    this.code = code;
    this.topic = TOPIC_ROOT + "/" + code + "/r";
    this._serverIdx = serverIdx;
    this._falling = false;
    clearTimeout(this._watchTimer);
    this._watchTimer = setTimeout(function () {
      self._onHandshakeTimeout();
    }, HANDSHAKE_TIMEOUT_MS);

    var client = global.mqtt.connect(SIGNAL_SERVERS[serverIdx], {
      clientId: TOPIC_ROOT + "-c-" + Math.random().toString(36).slice(2, 12),
      keepalive: 30,
      clean: true,
      connectTimeout: SERVER_TIMEOUT_MS,
      reconnectPeriod: 2000
    });
    this.client = client;
    client.on("connect", function () { self._onSignalUp(); });
    client.on("message", function (topic, payload) {
      self._onSignal(topic, payload);
    });
    client.on("error", function () { self._onSignalDown(); });
    client.on("close", function () { self._onSignalDown(); });
  };

  Net.prototype._onSignalUp = function () {
    var self = this;
    if (this.destroyed || !this.client) { return; }
    this._everUp = true;
    this.client.subscribe(this.topic, { qos: 0 }, function (err) {
      if (err || self.destroyed || !self.client) { return; }
      if (self.role === "host") {
        clearTimeout(self._watchTimer);   // 房主就绪, 不再受握手总时限约束
        self.onEvent({ type: "waiting", code: self.code });
      } else {
        self._startJoining();
      }
    });
  };

  /* 信令断开: 首连失败 -> 换下一个节点; 已连上后的闪断交由 mqtt.js
     自动重连 (数据通道不受影响), 不打扰对局. */
  Net.prototype._onSignalDown = function () {
    var self = this;
    if (this.destroyed || this._everUp || this._falling) { return; }
    this._falling = true;
    if (this.client) { try { this.client.end(true); } catch (e) { /* 忽略 */ } }
    this.client = null;
    var next = this._serverIdx + 1;
    if (next < SIGNAL_SERVERS.length) {
      setTimeout(function () {
        if (!self.destroyed) { self._begin(self.code, next); }
      }, 300);
    } else {
      this.onEvent({
        type: this.role === "guest" ? "join-failed" : "error",
        message: friendlyError("signal")
      });
      this.destroy();
    }
  };

  /* 客机: 发 join, 短暂无响应则重发 (最多 3 次) */
  Net.prototype._startJoining = function () {
    var self = this;
    clearTimeout(this._joinTimer);
    this._joinSends = 0;
    var tryJoin = function () {
      if (self.destroyed || self.pc) { return; }
      self._joinSends += 1;
      self._pub({ t: "join", from: self.myId });
      if (self._joinSends < 3) {
        self._joinTimer = setTimeout(tryJoin, 4000);
      }
    };
    tryJoin();
  };

  Net.prototype._pub = function (msg) {
    if (this.client && this.client.connected) {
      try {
        this.client.publish(this.topic, JSON.stringify(msg), { qos: 0 });
      } catch (e) { /* 信令瞬断, 重发机制兜底 */ }
    }
  };

  Net.prototype._onSignal = function (topic, payload) {
    if (this.destroyed || topic !== this.topic) { return; }
    var msg;
    try { msg = JSON.parse(decodePayload(payload)); } catch (e) { return; }
    if (!msg || typeof msg.t !== "string") { return; }
    if (msg.from === this.myId) { return; }
    if (msg.to && msg.to !== this.myId) { return; }
    switch (msg.t) {
      case "join":
        if (this.role === "host") { this._onGuestJoin(msg.from); }
        break;
      case "offer":
        if (this.role === "guest") { this._onOffer(msg); }
        break;
      case "answer":
        if (this.role === "host") { this._onAnswer(msg); }
        break;
      case "bye":
        this._peerDown();
        break;
    }
  };

  /* 房主: 收到 join -> 与该 guest 握手. 同一 guest 的重发 join 忽略;
     不同 guest (对手刷新重连 / 新对手) 则拆掉旧连接重新握手. */
  Net.prototype._onGuestJoin = function (fromId) {
    if (this.destroyed) { return; }
    if (this._guestId === fromId && this.pc) { return; }
    this._guestId = fromId;
    this._teardownPeer();
    var self = this;
    var pc = new RTCPeerConnection(rtcConfig());
    this.pc = pc;
    this._answered = false;
    this._bindDc(pc.createDataChannel("game", { ordered: true }));
    this._watchPc(pc);
    pc.createOffer()
      .then(function (offer) { return pc.setLocalDescription(offer); })
      .then(function () {
        self._gatherThen(pc, function () {
          if (!self.destroyed) {
            self._pub({ t: "offer", from: self.myId, to: fromId,
              sdp: pc.localDescription.sdp });
          }
        });
      })
      .catch(function () { self._peerDown(); });
  };

  /* 房主: 收到 answer, 收尾握手 */
  Net.prototype._onAnswer = function (msg) {
    if (this.destroyed || !this.pc || this._answered) { return; }
    this._answered = true;
    var self = this;
    this.pc.setRemoteDescription({ type: "answer", sdp: msg.sdp })
      .catch(function () { self._peerDown(); });
  };

  /* 客机: 收到 offer -> 回 answer */
  Net.prototype._onOffer = function (msg) {
    if (this.destroyed || this.pc) { return; }
    var self = this;
    var pc = new RTCPeerConnection(rtcConfig());
    this.pc = pc;
    pc.ondatachannel = function (e) { self._bindDc(e.channel); };
    this._watchPc(pc);
    pc.setRemoteDescription({ type: "offer", sdp: msg.sdp })
      .then(function () { return pc.createAnswer(); })
      .then(function (answer) { return pc.setLocalDescription(answer); })
      .then(function () {
        self._gatherThen(pc, function () {
          if (!self.destroyed) {
            self._pub({ t: "answer", from: self.myId, to: msg.from,
              sdp: pc.localDescription.sdp });
          }
        });
      })
      .catch(function () { self._peerDown(); });
  };

  /* 连接级失败 (ICE 失败等) -> 视为对端掉线 */
  Net.prototype._watchPc = function (pc) {
    var self = this;
    pc.onconnectionstatechange = function () {
      if (!self.destroyed && pc.connectionState === "failed") {
        self._peerDown();
      }
    };
  };

  /* 非 trickle ICE: 候选收齐 (或兜底超时) 后再回调, 完整 SDP 一次发出 */
  Net.prototype._gatherThen = function (pc, cb) {
    var done = false;
    var self = this;
    function finish() {
      if (done) { return; }
      done = true;
      pc.removeEventListener("icegatheringstatechange", onChange);
      cb();
    }
    function onChange() {
      if (pc.iceGatheringState === "complete") { finish(); }
    }
    pc.addEventListener("icegatheringstatechange", onChange);
    setTimeout(function () {
      if (!self.destroyed) { finish(); }
    }, GATHER_TIMEOUT_MS);
  };

  Net.prototype._bindDc = function (dc) {
    var self = this;
    this.dc = dc;
    dc.onopen = function () {
      if (self.destroyed) { return; }
      clearTimeout(self._watchTimer);
      clearTimeout(self._joinTimer);
      self.alive = true;
      self._lastSeen = Date.now();
      self._startHeartbeat();
      self.onEvent({ type: "connected" });
    };
    dc.onmessage = function (e) {
      if (self.destroyed) { return; }
      var d;
      try { d = JSON.parse(e.data); } catch (err) { return; }
      if (!d || typeof d !== "object") { return; }
      self._lastSeen = Date.now();
      if (d.t === "ping") { self.send({ t: "pong" }); return; }
      if (d.t === "pong") { return; }
      if (d.t === "bye") { self._peerDown(); return; }
      self.onMessage(d);
    };
    dc.onclose = function () { self._peerDown(); };
    dc.onerror = function () { self._peerDown(); };
  };

  Net.prototype._peerDown = function () {
    if (this.destroyed) { return; }
    this._stopHeartbeat();
    this._teardownPeer();
    this.onEvent({ type: "closed" });
  };

  Net.prototype._teardownPeer = function () {
    this._stopHeartbeat();
    if (this.dc) {
      this.dc.onclose = null;
      this.dc.onerror = null;
      try { this.dc.close(); } catch (e) { /* 忽略 */ }
      this.dc = null;
    }
    if (this.pc) {
      try { this.pc.close(); } catch (e) { /* 忽略 */ }
      this.pc = null;
    }
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

  Net.prototype._onHandshakeTimeout = function () {
    if (this.destroyed || this.isReady() || !this._everUp) { return; }
    var noHost = this.role === "guest" && !this.pc;
    this.onEvent({
      type: noHost ? "join-failed" : "error",
      message: friendlyError(noHost ? "no-host" : "webrtc")
    });
    this.destroy();
  };

  Net.prototype.destroy = function () {
    this.destroyed = true;
    clearTimeout(this._watchTimer);
    clearTimeout(this._joinTimer);
    this._teardownPeer();
    if (this.client) {
      try {
        if (this.client.connected) { this._pub({ t: "bye", from: this.myId }); }
        this.client.end(true);
      } catch (e) { /* 忽略 */ }
      this.client = null;
    }
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
        '仅房间号握手经由公共信令节点。少数受限网络下可能无法建立连接，可换网络重试。</div>';
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
    peerAvailable: libAvailable
  };
})(window);
