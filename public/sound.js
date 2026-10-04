// Çark sesleri: dosyasız, tarayıcıda Web Audio ile üretilir (telif sorunu yok).
// Büyük ekran ve telefon aynı modülü kullanır. Ses düşük tutulur; ana ses seviyesi tek yerden ayarlanır.
(function (root) {
  'use strict';
  var ctx = null, master = null, on = false, muted = false, volume = 0.6, KEY = 'sc_muted';

  try { muted = localStorage.getItem(KEY) === '1'; } catch (e) {}

  function ensure() {
    if (ctx) return true;
    try {
      var AC = root.AudioContext || root.webkitAudioContext;
      if (!AC) return false;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : volume;
      var comp = ctx.createDynamicsCompressor();   // ani tepeleri yumuşatır, kulağı yormaz
      comp.threshold.value = -18; comp.ratio.value = 6;
      master.connect(comp); comp.connect(ctx.destination);
      return true;
    } catch (e) { return false; }
  }

  // Tıklama (dokunma) içinden çağrılır; tarayıcı kuralı gereği ses ancak böyle açılır.
  function enable() {
    if (!ensure()) return false;
    try { if (ctx.state === 'suspended') ctx.resume(); } catch (e) {}
    on = true;
    return true;
  }

  function live() { return on && ctx && ctx.state !== 'closed' && !muted; }

  function env(g, t0, peak, attack, dur) {
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  }

  function note(freq, dur, type, vol, when, attack) {
    if (!live()) return;
    var t0 = ctx.currentTime + (when || 0), o = ctx.createOscillator(), g = ctx.createGain();
    o.type = type || 'sine'; o.frequency.setValueAtTime(freq, t0);
    env(g, t0, vol, attack || 0.012, dur);
    o.connect(g); g.connect(master); o.start(t0); o.stop(t0 + dur + 0.03);
  }

  var noiseBuf = null;
  function noise() {
    if (noiseBuf) return noiseBuf;
    var len = ctx.sampleRate * 1, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
    for (var i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return (noiseBuf = b);
  }

  // Çarkın dilim geçişi: kısa, yumuşak "tık". Çok yüksek frekans yorucu olur, bu yüzden bandpass kullanılır.
  function tick(strength) {
    if (!live()) return;
    var t0 = ctx.currentTime, s = strength == null ? 1 : strength;
    var src = ctx.createBufferSource(); src.buffer = noise();
    var f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.frequency.value = 1800; f.Q.value = 3;
    var g = ctx.createGain(); env(g, t0, 0.22 * s, 0.002, 0.04);
    src.connect(f); f.connect(g); g.connect(master); src.start(t0, Math.random() * 0.5); src.stop(t0 + 0.06);
    note(950, 0.035, 'triangle', 0.05 * s, 0, 0.002);
  }

  // Geri sayım bipi (3, 2, 1)
  function count(n) { note(n === 1 ? 880 : 660, 0.18, 'sine', 0.14); }

  // Çark kalkarken kısa yükselen "vııt"
  function whoosh() {
    if (!live()) return;
    var t0 = ctx.currentTime;
    var src = ctx.createBufferSource(); src.buffer = noise(); src.loop = true;
    var f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
    f.frequency.setValueAtTime(300, t0); f.frequency.exponentialRampToValueAtTime(2200, t0 + 0.7);
    var g = ctx.createGain(); env(g, t0, 0.12, 0.25, 0.8);
    src.connect(f); f.connect(g); g.connect(master); src.start(t0); src.stop(t0 + 0.85);
  }

  // Kazanma müziği: yaklaşık 6 saniye. Yükselen fanfar, ana tema, uzayan son akor ve parıltı.
  function win() {
    if (!live()) return;
    var C5 = 523.25, D5 = 587.33, E5 = 659.25, F5 = 698.46, G5 = 783.99, A5 = 880, B5 = 987.77, C6 = 1046.5, E6 = 1318.5, G6 = 1568;
    // 1) Yükselen arpej (0 - 1 sn)
    [C5, E5, G5, C6, E6].forEach(function (f, i) { note(f, 0.34, 'triangle', 0.16, i * 0.11); });
    // 2) Ana tema (1 - 3.5 sn): "do-re-mi-sol, mi-sol-la-sol"
    var theme = [[C6, 0.28], [B5, 0.14], [C6, 0.28], [G5, 0.5], [E5, 0.25], [G5, 0.25], [A5, 0.25], [G5, 0.55]];
    var t = 1.0;
    theme.forEach(function (n) { note(n[0], n[1] * 1.15, 'triangle', 0.15, t); note(n[0] / 2, n[1] * 1.15, 'sine', 0.07, t); t += n[1] * 0.8 + 0.06; });
    // 3) Altı çizili zafer vurgusu ve uzun son akor (3.5 - 6 sn)
    var t2 = t;
    [[C5, E5, G5], [F5, A5, C6], [G5, B5, D5 * 2]].forEach(function (ch, i) {
      ch.forEach(function (f) { note(f, 0.45, 'triangle', 0.1, t2 + i * 0.32); });
    });
    var t3 = t2 + 0.95;
    [C5, E5, G5, C6].forEach(function (f) { note(f, 1.6, 'triangle', 0.1, t3, 0.05); });
    note(C5 / 2, 1.6, 'sine', 0.12, t3, 0.05);
    // 4) Parıltı
    for (var i = 0; i < 7; i++) note([E6, G6, C6 * 2][i % 3], 0.16, 'sine', 0.05, t3 + 0.1 + i * 0.18);
  }

  function lose() { note(330, 0.3, 'sawtooth', 0.05); note(247, 0.55, 'sawtooth', 0.05, 0.28); }
  function again() { note(520, 0.18, 'triangle', 0.12); note(780, 0.3, 'triangle', 0.12, 0.16); }

  function setMuted(m) {
    muted = !!m;
    try { localStorage.setItem(KEY, muted ? '1' : '0'); } catch (e) {}
    if (master) master.gain.value = muted ? 0 : volume;
  }

  root.ScSound = {
    enable: enable,
    isOn: function () { return on && !muted; },
    isMuted: function () { return muted; },
    setMuted: setMuted,
    setVolume: function (v) { volume = Math.max(0, Math.min(1, v)); if (master && !muted) master.gain.value = volume; },
    tick: tick, count: count, whoosh: whoosh, win: win, lose: lose, again: again,
    result: function (type) { if (type === 'gift') win(); else if (type === 'lose') lose(); else again(); }
  };
})(typeof self !== 'undefined' ? self : this);
