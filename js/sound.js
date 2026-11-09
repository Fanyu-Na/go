/* 界面音效: WebAudio 合成点击 / 落子 / 提子 / 终局声, 不依赖任何音频文件.
   浏览器自动播放策略要求音频上下文在首次用户手势后创建; init() 会在
   pointerdown / keydown 时被调用, 失败时静默降级 (音效按钮显示「无」). */

(function (global) {
  "use strict";

  var RATE = 44100;
  var VOLUME = 0.35;

  var ctx = null;
  var available = false;
  var enabled = true;
  var buffers = {};

  function ensureCtx() {
    if (ctx) {
      if (ctx.state === "suspended") { ctx.resume(); }
      return ctx;
    }
    try {
      var AC = global.AudioContext || global.webkitAudioContext;
      if (!AC) { return null; }
      ctx = new AC();
    } catch (err) {
      ctx = null;
    }
    return ctx;
  }

  /* 移植自桌面版 sound.py: 正弦音 + 噪声质感 + 指数衰减包络. */
  function synth(duration, notes, noise) {
    var length = Math.max(1, Math.round(duration * RATE));
    var wave = new Float64Array(length);
    var i;
    for (i = 0; i < length; i++) { wave[i] = Math.random() * 2 - 1; }
    var noiseArr = Float64Array.from(wave);
    var clean = new Float64Array(length);
    notes.forEach(function (note) {
      var start = Math.round(note[0] * RATE);
      var freq = note[1];
      var decay = note[2];
      var count = Math.min(Math.round(0.45 * RATE), length - start);
      if (count <= 0) { return; }
      for (var k = 0; k < count; k++) {
        var t = k / RATE;
        var envelope = Math.exp(-decay * t);
        clean[start + k] += Math.sin(2 * Math.PI * freq * t) * envelope;
      }
    });
    var peak = 0;
    for (i = 0; i < length; i++) {
      wave[i] = (1 - noise) * clean[i] + noise * noiseArr[i];
      var abs = Math.abs(wave[i]);
      if (abs > peak) { peak = abs; }
    }
    if (peak > 0) {
      for (i = 0; i < length; i++) { wave[i] = wave[i] / peak * 0.8; }
    }
    return wave;
  }

  function init() {
    if (!enabled || available) { return; }
    if (!ensureCtx()) { return; }
    var specs = {
      click: synth(0.05, [[0, 880, 70]], 0.25),
      stone: synth(0.09, [[0, 430, 38], [0, 1250, 85]], 0.45),
      capture: synth(0.16, [[0, 620, 42], [0.06, 390, 35]], 0.35),
      end: synth(0.55, [[0, 523.25, 9], [0.13, 659.25, 8], [0.28, 783.99, 7]], 0)
    };
    Object.keys(specs).forEach(function (name) {
      var wave = specs[name];
      var buf = ctx.createBuffer(1, wave.length, RATE);
      buf.getChannelData(0).set(wave);
      buffers[name] = buf;
    });
    available = true;
  }

  function play(name) {
    if (!enabled || !available || !ensureCtx()) { return; }
    var buf = buffers[name];
    if (!buf) { return; }
    var src = ctx.createBufferSource();
    src.buffer = buf;
    var gain = ctx.createGain();
    gain.gain.value = VOLUME;
    src.connect(gain);
    gain.connect(ctx.destination);
    src.start();
  }

  function toggle() {
    enabled = !enabled;
    if (enabled) { init(); }
    return enabled;
  }

  global.Sound = {
    init: init,
    play: play,
    toggle: toggle,
    get enabled() { return enabled; },
    get available() { return available; }
  };
})(window);
