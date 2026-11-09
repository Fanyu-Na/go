/* 联机对战模块: HTTPS 轮询中继 (Vercel Functions + Blob) + 联机大厅界面.
   不再做 WebRTC 点对点 —— 对称 NAT / 受限网络下打洞不可靠, 改为所有
   棋局数据经自家服务器中转, 任何网络环境都能加入.
   - RelayClient: 轮询 api/room/{code} 拉取权威状态; 落子等操作 POST 上去,
     服务器用同一套引擎校验后写入, 响应直接带回新状态 (己方落子零等待).
   - 服务器为权威端 (见 api/room/[code].js): 着法合法性 / 轮次 / 悔棋协商
     全部由服务器裁决, 双方仅凭 token 认席位, 刷新页面可凭会话恢复. */

(function (global) {
  "use strict";

  /* 房间码字符表: 去掉 0/O/1/I/L 等易混字符 */
  var ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  var CODE_LEN = 5;

  var POLL_FAST_MS = 450;    // 己方刚操作完 / 等对方应手时的高频轮询
  var POLL_SLOW_MS = 1200;   // 常规轮询
  var FAST_WINDOW_MS = 6000; // 操作后保持高频轮询的时长
  var OFFLINE_MS = 12000;    // 对方超过该时长无心跳即视为离线

  function httpOk() {
    return location.protocol === "http:" || location.protocol === "https:";
  }

  /* file:// 等非 HTTP 环境没有 API 可用: 统一走 rejected promise,
     让 lobby/侧栏拿到可展示的错误而不是抛异常 */
  function apiFail() {
    return Promise.reject(new Error(
      "联机需要 HTTP 环境：请部署到 Vercel 后访问（本地双人/人机对局不受影响）"));
  }

  function genCode() {
    var s = "";
    for (var i = 0; i < CODE_LEN; i++) {
      s += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    }
    return s;
  }

  /* ---------------- RelayClient: 轮询中继封装 ----------------
     事件 (onEvent): waiting / joined{code,color} / closed / error / join-failed
     状态 (onState): 服务器权威房间快照, 见 api/_lib.js publicState()
     字段: token/color/code/alive/meta/isReady()  (main.js 使用) */

  function RelayClient(opts) {
    opts = opts || {};
    this.token = null;
    this.color = 0;              // 1 = 黑 (房主), 2 = 白 (客队)
    this.code = null;
    this.meta = null;            // {game, size, komi} 创建时的对局设置
    this.alive = true;           // 对方是否在线 (依心跳判定)
    this.destroyed = false;
    this.onEvent = opts.onEvent || function () {};
    this.onState = opts.onState || function () {};
    this._timer = null;
    this._fastUntil = 0;
    this._busy = false;          // 正在进行一个请求 (串行化轮询)
    this._failCount = 0;
    this._failReported = false;
  }

  RelayClient.prototype.isReady = function () {
    return !this.destroyed && !!this.token && !!this.code;
  };

  /* ---- 底层请求: POST /api/room/{code}?..., 响应 {error} 视为失败 ---- */

  RelayClient.prototype._req = function (code, body, keepalive) {
    if (!httpOk()) { return apiFail(); }
    var init = {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    };
    if (keepalive) { init.keepalive = true; }
    return fetch("/api/room/" + code, init).then(function (res) {
      return res.json().catch(function () {
        throw new Error("服务器响应异常 (" + res.status + ")");
      }).then(function (data) {
        if (!res.ok) {
          var err = new Error((data && data.error) || "服务器错误 (" + res.status + ")");
          err.status = res.status;
          throw err;
        }
        return data;
      });
    });
  };

  RelayClient.prototype._handleState = function (state) {
    if (this.destroyed) { return; }
    this._failCount = 0;
    this._failReported = false;
    /* 对方在线判定: 用服务器时间换算对方最近心跳时刻 */
    var oppSeen = this.color === 1 ? state.whiteSeen : state.blackSeen;
    var oppOnline = oppSeen > 0 && (state.now - oppSeen) < OFFLINE_MS;
    if (oppOnline !== this.alive) {
      this.alive = oppOnline;
      this.onEvent({ type: "peer-alive", alive: oppOnline });
    }
    this.onState(state);
  };

  RelayClient.prototype._schedule = function () {
    if (this.destroyed) { return; }
    var self = this;
    var fast = Date.now() < this._fastUntil;
    this._timer = setTimeout(function () { self._poll(); },
      fast ? POLL_FAST_MS : POLL_SLOW_MS);
  };

  RelayClient.prototype._poll = function () {
    var self = this;
    if (this.destroyed || !this.isReady() || this._busy) {
      if (!this.destroyed) { this._schedule(); }
      return;
    }
    this._busy = true;
    this._req(this.code, { op: "poll", token: this.token })
      .then(function (data) {
        self._busy = false;
        if (self.destroyed) { return; }
        self._handleState(data.state);
        self._schedule();
      })
      .catch(function (e) {
        self._busy = false;
        if (self.destroyed) { return; }
        if (e && e.status === 404) {
          /* 房间已被对方关闭或删除 */
          self.onEvent({ type: "closed" });
          self.destroy();
          return;
        }
        self._failCount += 1;
        if (self._failCount >= 3 && !self._failReported) {
          self._failReported = true;
          self.onEvent({ type: "error",
            message: "与服务器连接不稳定，正在重试…" });
        }
        self._schedule();
      });
  };

  /* 立即拉一次并在短时间内高频轮询 (己方落子后调用, 让对方应手更快到达) */
  RelayClient.prototype.bumpPoll = function () {
    this._fastUntil = Date.now() + FAST_WINDOW_MS;
  };

  /* ---- 公开操作: 每个操作的响应都带回最新权威状态 ---- */

  RelayClient.prototype._act = function (body) {
    var self = this;
    this.bumpPoll();
    return this._req(this.code, Object.assign({ token: this.token }, body))
      .then(function (data) {
        if (!self.destroyed && data.state) { self._handleState(data.state); }
        return data;
      });
  };

  RelayClient.prototype.move = function (action) {
    return this._act({ op: "move", action: action });
  };

  RelayClient.prototype.resign = function () {
    return this._act({ op: "resign" });
  };

  RelayClient.prototype.req = function (kind) {
    return this._act({ op: "req", kind: kind });
  };

  RelayClient.prototype.ack = function (accept) {
    return this._act({ op: "ack", accept: !!accept });
  };

  /* ---- 建房 / 加入 ---- */

  /* 建房走单独接口 (无房间码); 与 _act 不同, 无需 code */
  RelayClient.prototype.createRoom = function (game, size, komi) {
    var self = this;
    this.meta = { game: game, size: size, komi: komi };
    if (!httpOk()) { return apiFail(); }
    return fetch("/api/room", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ game: game, size: size, komi: komi })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          throw new Error((data && data.error) || "创建房间失败 (" + res.status + ")");
        }
        return data;
      });
    }).then(function (data) {
      if (self.destroyed) { return data; }
      self.code = data.code;
      self.token = data.token;
      self.color = data.color || 1;
      self.onEvent({ type: "waiting", code: data.code });
      self._schedule();
      return data;
    });
  };

  RelayClient.prototype.join = function (code, savedToken) {
    var self = this;
    this.code = code;
    return this._req(code, { op: "join", token: savedToken || "" })
      .then(function (data) {
        if (self.destroyed) { return data; }
        self.token = data.token;
        self.color = data.color;
        self.onEvent({ type: "joined", code: code, color: data.color,
          state: data.state });
        self._handleState(data.state);
        self._schedule();
        return data;
      });
  };

  /* ---- 关闭 / 销毁 ---- */

  /* 显式断开 (返回主菜单): 通知服务器删除房间, 对方下一轮询即看到关闭 */
  RelayClient.prototype.close = function () {
    if (this.isReady()) {
      var code = this.code;
      var token = this.token;
      this.destroyed = true;   // 先停轮询, 再尽力发 close
      clearTimeout(this._timer);
      try {
        fetch("/api/room/" + code, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op: "close", token: token }),
          keepalive: true
        });
      } catch (e) { /* 尽力而为 */ }
    }
  };

  RelayClient.prototype.destroy = function () {
    this.destroyed = true;
    clearTimeout(this._timer);
    this._timer = null;
  };

  /* ---------------- LobbyUI: 联机大厅界面 ----------------
     状态机: choose (创建/加入) -> hosting (等对手) / joining (输码)
     callbacks: { onCreate(), onJoin(code), onBack(), onShareLink(code),
                  onCancel() } */

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
    this.status = "正在连接服务器";
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
    var html = '<div class="menu-brand">ONLINE · 服务器中继联机</div>';
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
      html += '<div class="lobby-note">联机经 Vercel 服务器中继（HTTPS 轮询），' +
        '任何网络环境均可加入，刷新页面可恢复棋局；需先在 Vercel 项目中关联 Blob 存储。</div>';
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

  /* 本页会话保存的房间席位 token (刷新页面后凭它认回原席位) */
  function savedToken(code) {
    try { return sessionStorage.getItem("goroom:" + code) || ""; }
    catch (e) { return ""; }
  }
  function rememberToken(code, token) {
    try { sessionStorage.setItem("goroom:" + code, token); } catch (e) { /* 忽略 */ }
  }

  global.Online = {
    RelayClient: RelayClient,
    LobbyUI: LobbyUI,
    genCode: genCode,
    CODE_LEN: CODE_LEN,
    savedToken: savedToken,
    rememberToken: rememberToken
  };
})(window);
