// Çark çekirdeği: büyük ekran ve mobil AYNI hesabı kullanır, böylece aynı şeyi gösterir.
// Tarayıcıda window.WheelCore, Node'da module.exports olarak yüklenir.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.WheelCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  var TWO_PI = 2 * Math.PI;

  // Renkler InspireIT logosundaki magenta, mor ve mavilerle uyumlu. Hediye dilimleri canlı, kaybetme dilimleri sönük.
  var COLOR_BY_TYPE = {
    gift:  ['#E5287A', '#F59E0B', '#14B8A6', '#4A8CCB', '#9B4F9E', '#FF6B4A', '#2FB67C', '#6C5CE7'],
    lose:  ['#2A3A74', '#34468A', '#25336A', '#3D4E92'],
    again: ['#38BDF8', '#0EA5E9', '#22D3EE'],
    task:  ['#C026D3', '#A855F7', '#D946EF', '#8B5CF6']
  };

  function mod(a, n) { return ((a % n) + n) % n; }
  function clamp01(t) { return t < 0 ? 0 : t > 1 ? 1 : t; }
  function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }

  // Dilim i'nin rengi, tür ve o türün kaçıncı dilimi olduğuna göre (iki ekranda aynı).
  function sliceColors(slices) {
    var seen = {};
    return slices.map(function (s) {
      var pal = COLOR_BY_TYPE[s.type] || COLOR_BY_TYPE.gift;
      seen[s.type] = (seen[s.type] || 0);
      var c = pal[seen[s.type] % pal.length];
      seen[s.type]++;
      return c;
    });
  }

  // Ok üstte (-90°). Dilim idx'in offsetFrac (0..1) noktası okun altında dursun diye gereken dönüş açısı.
  function finalAngle(n, idx, offsetFrac) {
    var arc = TWO_PI / n;
    return mod(-Math.PI / 2 - idx * arc - arc * offsetFrac, TWO_PI);
  }

  // from açısından başlayıp 'turns' tam tur atıp hedefte durur.
  function targetRotation(from, n, idx, offsetFrac, turns) {
    return from + turns * TWO_PI + mod(finalAngle(n, idx, offsetFrac) - from, TWO_PI);
  }

  function rotationAt(from, target, t) {
    return from + (target - from) * easeOutCubic(clamp01(t));
  }

  // Verilen açıda okun altındaki dilim
  function sliceAtPointer(rotation, n) {
    var arc = TWO_PI / n;
    return Math.floor(mod(-Math.PI / 2 - rotation, TWO_PI) / arc) % n;
  }

  // Sunucu saatine göre geçen oran (0..1+). startAt/duration ms, now() sunucu saati ms.
  function progress(nowMs, startAt, duration) {
    return (nowMs - startAt) / duration;
  }

  // Sunucu saat farkını ölçer; en düşük gecikmeli örneği kullanır.
  function createClock(timeUrl) {
    var offset = 0;
    var clock = {
      now: function () { return Date.now() + offset; },
      set: function (serverNow, t0, t1) { offset = serverNow - (t0 + t1) / 2; },
      offset: function () { return offset; },
      sync: async function (samples) {
        var best = null;
        for (var i = 0; i < (samples || 4); i++) {
          try {
            var t0 = Date.now();
            var r = await fetch(timeUrl || '/api/time', { cache: 'no-store' });
            var d = await r.json();
            var t1 = Date.now();
            var rtt = t1 - t0;
            if (!best || rtt < best.rtt) best = { rtt: rtt, serverNow: d.now, t0: t0, t1: t1 };
          } catch (e) { /* bağlantı yoksa mevcut farkı koru */ }
        }
        if (best) clock.set(best.serverNow, best.t0, best.t1);
        return best ? best.rtt : null;
      }
    };
    return clock;
  }

  function drawWheel(canvas, rotation, slices, opts) {
    var fontScale = (opts && opts.fontScale) || 1;
    var ctx = canvas.getContext('2d');
    var W = canvas.width, H = canvas.height;
    var cx = W / 2, cy = H / 2;
    var radius = Math.min(W, H) / 2 - 10;
    ctx.clearRect(0, 0, W, H);
    var n = slices.length;
    if (n === 0) {
      ctx.fillStyle = '#334155';
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, TWO_PI); ctx.fill();
      return;
    }
    var arc = TWO_PI / n;
    var colors = sliceColors(slices);
    for (var i = 0; i < n; i++) {
      var start = rotation + i * arc;
      var end = start + arc;
      var s = slices[i];
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, radius, start, end);
      ctx.closePath();
      ctx.fillStyle = colors[i];
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = W * 0.004;
      ctx.stroke();
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(start + arc / 2);
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.shadowColor = 'rgba(0,0,0,0.7)';
      ctx.shadowBlur = 6;
      var fontSize = fontScale * Math.max(W * 0.018, Math.min(W * 0.030, W * 0.35 / n + W * 0.012));
      var family = (opts && opts.fontFamily) || 'sans-serif';
      var weight = (opts && opts.fontWeight) || 900;
      var avail = radius * 0.95 - W * 0.085 * 1.4; // kenardan göbeğe kadar kullanılabilir uzunluk
      var fs = fontSize, minFs = fontSize * 0.68, txt = s.name;
      ctx.font = weight + ' ' + fs + 'px ' + family;
      while (ctx.measureText(txt).width > avail && fs > minFs) { fs -= 1; ctx.font = weight + ' ' + fs + 'px ' + family; }
      if (ctx.measureText(txt).width > avail) {
        while (txt.length > 2 && ctx.measureText(txt + '…').width > avail) txt = txt.slice(0, -1);
        txt = txt.replace(/\s+$/, '') + '…';
      }
      ctx.fillText(txt, radius * 0.95, 0);
      ctx.restore();
    }
    ctx.beginPath();
    ctx.arc(cx, cy, W * 0.085, 0, TWO_PI);
    ctx.fillStyle = '#0f172a';
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = W * 0.009;
    ctx.stroke();
  }

  // Statik çarkı bir kez çizip her karede yalnızca döndürerek basar (shadowBlur'lü metni her karede çizmek pahalıdır).
  function createRenderer(canvas) {
    var off = document.createElement('canvas');
    off.width = canvas.width; off.height = canvas.height;
    var key = '';
    return {
      draw: function (rotation, slices) {
        var ctx = canvas.getContext('2d');
        var k = slices.map(function (s) { return s.id + ':' + s.type + ':' + s.name; }).join('|');
        if (k !== key) { key = k; drawWheel(off, 0, slices); }
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.save();
        ctx.translate(canvas.width / 2, canvas.height / 2);
        ctx.rotate(rotation);
        ctx.drawImage(off, -canvas.width / 2, -canvas.height / 2);
        ctx.restore();
      }
    };
  }

  return {
    createRenderer: createRenderer,
    TWO_PI: TWO_PI, mod: mod, easeOutCubic: easeOutCubic, sliceColors: sliceColors,
    finalAngle: finalAngle, targetRotation: targetRotation, rotationAt: rotationAt,
    sliceAtPointer: sliceAtPointer, progress: progress, createClock: createClock, drawWheel: drawWheel
  };
});
