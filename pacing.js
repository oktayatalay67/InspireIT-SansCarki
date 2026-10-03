// Hediye bütçesi: stoğu etkinlik süresine yayar. Saf fonksiyonlar (veritabanı yok), kolay test edilir.
//
// Etkinlik: başlangıç anı + gün sayısı + günlük saat. Her gün başlangıçtan 24 saat arayla
// "hediye saatlerini" açar. Geçen aktif süre oranı f (0..1) ise o ana kadar dağıtılabilecek
// toplam hediye = ceil(toplam * f). Dağıtılan bunun altındaysa hediye dilimleri çekilebilir,
// değilse çark "hediye yok" diliminde durur.

export const DEFAULT_SETTINGS = { mode: 'closed', paused: false, start: null, days: 1, hours: 8, nextFree: 0 };

export function parseSettings(rows) {
  const m = {};
  for (const r of rows || []) m[r.k] = r.v;
  const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d; };
  const num = (v, d) => { const n = Number.parseFloat(v); return Number.isFinite(n) ? n : d; };
  const mode = ['auto', 'open', 'closed'].includes(m.mode) ? m.mode : 'closed';
  const start = m.event_start ? int(m.event_start, null) : null;
  return {
    mode,
    paused: m.paused === '1',
    start,
    days: Math.max(1, int(m.event_days, DEFAULT_SETTINGS.days)),
    hours: Math.max(0.25, num(m.event_hours, DEFAULT_SETTINGS.hours)),
    nextFree: int(m.next_free, 0)
  };
}

export function isConfigured(s) {
  return !!(s && s.start && s.days >= 1 && s.hours > 0);
}

// Etkinliğin toplam aktif süresi (sn)
export function totalActiveSec(s) {
  return s.days * s.hours * 3600;
}

// nowSec anına kadar geçen aktif süre (sn); günler arası boşluklar sayılmaz.
export function activeElapsedSec(nowSec, s) {
  if (!isConfigured(s)) return 0;
  const len = s.hours * 3600;
  let total = 0;
  for (let i = 0; i < s.days; i++) {
    const ws = s.start + i * 86400;
    total += Math.min(Math.max(nowSec - ws, 0), len);
  }
  return total;
}

export function eventEndSec(s) {
  return isConfigured(s) ? s.start + (s.days - 1) * 86400 + s.hours * 3600 : null;
}

// given: etkinlik başlangıcından beri verilen (stoklu) hediye sayısı
// remaining: kalan stoklu hediye sayısı
export function computeAllowance(s, nowSec, given, remaining) {
  const total = given + remaining;
  const base = { total, given, remaining, fraction: 0, target: 0, allowance: 0, allowed: false };
  if (s.mode === 'open') return { ...base, fraction: 1, target: total, allowance: remaining, allowed: remaining > 0 };
  if (s.mode !== 'auto' || !isConfigured(s) || total <= 0) return base;
  const f = Math.min(1, activeElapsedSec(nowSec, s) / totalActiveSec(s));
  const target = Math.min(total, Math.ceil(total * f));
  const allowance = Math.max(0, Math.min(remaining, target - given));
  return { ...base, fraction: f, target, allowance, allowed: allowance > 0 };
}
