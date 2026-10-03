// InspireIT Şans Çarkı - sunucu (Cloudflare Worker + D1)
// Aşama 1: güvenli çevirme akışı, 1 kişi = 1 hediye, atomik stok, olaylar D1'de.

import { parseSettings, isConfigured, computeAllowance, activeElapsedSec, totalActiveSec, eventEndSec } from './pacing.js';

const SLICE_TYPES = ['gift', 'lose', 'again', 'task'];
// Çevirme zamanlaması (ms): her çevirme büyük ekranda sırayla oynar, çakışmaz.
const SPIN_LEAD_MS = 2500;      // sonuç gelince animasyon bu kadar sonra başlar (iki ekran aynı anda başlasın)
const SPIN_DURATION_MS = 5500;  // çark dönme süresi
const SPIN_HOLD_MS = 7000;      // sonuç ekranda kalma süresi
const SPIN_PREROLL_MS = 3000;   // sıradaki çevirme öncesi 3-2-1 geri sayım payı
const QUEUE_STALE_MS = 20000;   // bu kadar süre sinyal vermeyen oyuncu bekleme listesinden düşer
const QUEUE_TIE_MS = 300;       // bu farktan az basış 'aynı anda' sayılır; kayıt sırası (id) belirler
const QUEUE_MAX = 40;           // bekleme listesi üst sınırı
const MODES = ['auto', 'open', 'closed'];
const SESSION_TTL = 12 * 3600; // admin oturumu (sn)
const COOKIE_NAME = 'isc_admin';
const EVENT_REPLAY_WINDOW = 30; // since=0 ile gelen ekran yalnızca son 30 sn'yi görür
const UNLIMITED_STOCK = 999; // bu değer ve üstü: stok düşülmez

const enc = new TextEncoder();

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    try {
      // Herkese açık
      if (path === '/api/slices' && method === 'GET') return await getSlices(env);
      if (path === '/api/register' && method === 'POST') return await register(request, env);
      if (path === '/api/spin' && method === 'POST') return await spinWheel(request, env);
      if (path === '/api/me' && method === 'GET') return await getMe(request, env);
      if (path === '/api/time' && method === 'GET') return json({ now: Date.now() });
      if (path === '/api/state' && method === 'GET') return await getState(env);
      if (path === '/api/events' && method === 'GET') return await getEvents(request, env);
      if (path === '/api/last-winners' && method === 'GET') return await getLastWinners(env);
      if (path === '/api/stats' && method === 'GET') return await getStats(env);

      // Admin
      if (path === '/api/admin/login' && method === 'POST') return await adminLogin(request, env);
      if (path === '/api/admin/logout' && method === 'POST') return adminLogout();
      if (path === '/api/admin/slices' && method === 'PUT') {
        if (!(await isAdmin(request, env))) return json({ error: 'Yetkisiz' }, 401);
        return await updateSlices(request, env);
      }
      if (path === '/api/admin/status' && method === 'GET') {
        if (!(await isAdmin(request, env))) return json({ error: 'Yetkisiz' }, 401);
        return await adminStatus(env);
      }
      if (path === '/api/admin/settings' && method === 'PUT') {
        if (!(await isAdmin(request, env))) return json({ error: 'Yetkisiz' }, 401);
        return await updateSettings(request, env);
      }
      if (path === '/api/export.csv' && method === 'GET') {
        if (!(await isAdmin(request, env))) return json({ error: 'Yetkisiz' }, 401);
        return await exportCSV(env);
      }

      // Kısa adres: QR kodu daha seyrek (uzaktan okunması kolay) olsun diye /m -> mobil sayfa
      if (path === '/m' || path === '/m/') return Response.redirect(new URL('/mobil.html', request.url).toString(), 302);

      if (path.startsWith('/api/')) return json({ error: 'Bulunamadı' }, 404);
      return env.ASSETS.fetch(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('Beklenmeyen hata:', err && err.stack ? err.stack : err);
      return json({ error: 'Sunucu hatası, lütfen tekrar deneyin' }, 500);
    }
  }
};

/* ---------------------------------------------------------------- yardımcılar */

class HttpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...extraHeaders }
  });
}

async function readJson(request) {
  try { return await request.json(); }
  catch { throw new HttpError('Geçersiz istek'); }
}

const nowSec = () => Math.floor(Date.now() / 1000);

// Kriptografik rastgele sayı, [0,1)
function secureRandom() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 4294967296;
}

function cleanText(v, max) {
  return String(v ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max + 1);
}

// 10 haneli GSM (5XXXXXXXXX) döndürür, geçersizse null
function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('0090') && d.length === 14) d = d.slice(4);
  else if (d.startsWith('90') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  return /^5\d{9}$/.test(d) ? d : null;
}

function validEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e); }

function maskName(name) {
  const parts = String(name || '').trim().split(/\s+/);
  if (parts.length < 2) return parts[0] || '';
  return `${parts[0]} ${parts[parts.length - 1][0].toLocaleUpperCase('tr')}.`;
}

function publicSlice(s) { return { id: s.id, type: s.type, name: s.name }; }

/* ------------------------------------------------------------------ admin auth */

async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(msg));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

function safeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let r = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) r |= (x[i] || 0) ^ (y[i] || 0);
  return r === 0;
}

function getCookie(request, name) {
  const h = request.headers.get('Cookie') || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return '';
}

// Parola tanımlı değilse tüm admin uçları kapalıdır.
async function isAdmin(request, env) {
  const pw = env.ADMIN_PASSWORD;
  if (!pw) return false;
  const auth = request.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ') && safeEqual(auth.slice(7), pw)) return true;
  const cookie = getCookie(request, COOKIE_NAME);
  const dot = cookie.indexOf('.');
  if (dot < 1) return false;
  const exp = parseInt(cookie.slice(0, dot), 10);
  if (!exp || exp < nowSec()) return false;
  return safeEqual(cookie.slice(dot + 1), await hmacHex(pw, 'admin:' + exp));
}

async function adminLogin(request, env) {
  if (!env.ADMIN_PASSWORD) throw new HttpError('Yönetici parolası tanımlı değil', 503);
  const body = await readJson(request);
  const ok = safeEqual(String(body.password ?? ''), env.ADMIN_PASSWORD);
  if (!ok) {
    await new Promise(r => setTimeout(r, 800)); // kaba kuvveti yavaşlat
    return json({ error: 'Parola hatalı' }, 401);
  }
  const exp = nowSec() + SESSION_TTL;
  const sig = await hmacHex(env.ADMIN_PASSWORD, 'admin:' + exp);
  return json({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE_NAME}=${exp}.${sig}; Path=/; Max-Age=${SESSION_TTL}; HttpOnly; Secure; SameSite=Strict`
  });
}

function adminLogout() {
  return json({ ok: true }, 200, {
    'Set-Cookie': `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`
  });
}

/* ------------------------------------------------------------------ herkese açık */

async function getSlices(env) {
  const { results } = await env.DB.prepare(
    `SELECT id, type, name FROM slices WHERE active = 1 AND stock > 0 ORDER BY sort_order ASC, id ASC`
  ).all();
  return json({ slices: results });
}

async function getStats(env) {
  const p = await env.DB.prepare(`SELECT COUNT(*) AS c FROM participants`).first();
  const g = await env.DB.prepare(`SELECT COUNT(*) AS c FROM spins WHERE slice_type = 'gift'`).first();
  return json({ participants: p.c, gifts: g.c });
}

// Yalnızca hediye kazananlar, isim maskeli (Ahmet K.)
async function getLastWinners(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.name AS name, s.slice_name AS prize, s.created_at AS created_at
       FROM spins s JOIN participants p ON p.id = s.participant_id
      WHERE s.slice_type = 'gift' ORDER BY s.id DESC LIMIT 8`
  ).all();
  return json({ winners: results.map(r => ({ name: maskName(r.name), prize: r.prize, created_at: r.created_at })) });
}

async function getEvents(request, env) {
  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get('since') || '0', 10) || 0;
  const minTs = nowSec() - EVENT_REPLAY_WINDOW;
  let rows;
  if (since > 0) {
    ({ results: rows } = await env.DB.prepare(
      `SELECT id, type, payload, created_at FROM events WHERE id > ? ORDER BY id ASC LIMIT 50`
    ).bind(since).all());
  } else {
    // İlk yükleme: yalnızca en yeni birkaç olay (eskiden yeniye sıralı)
    const { results } = await env.DB.prepare(
      `SELECT id, type, payload, created_at FROM events WHERE created_at >= ? ORDER BY id DESC LIMIT 5`
    ).bind(minTs).all();
    rows = results.reverse();
  }
  const events = rows.map(e => {
    let p = {};
    try { p = JSON.parse(e.payload); } catch { /* bozuk kayıt yok sayılır */ }
    return { id: e.id, type: e.type, ts: e.created_at * 1000, ...p };
  });
  const lastRow = await env.DB.prepare(`SELECT MAX(id) AS m FROM events`).first();
  return json({ events, last: lastRow.m || 0, serverNow: Date.now() });
}

async function register(request, env) {
  const body = await readJson(request);

  const name = cleanText(body.name, 80);
  const company = cleanText(body.company, 100);
  const email = cleanText(body.email, 120).toLowerCase();
  const phoneNorm = normalizePhone(body.phone);

  if (name.length < 3 || name.length > 80) throw new HttpError('Ad Soyad en az 3 karakter olmalı');
  if (company.length < 2 || company.length > 100) throw new HttpError('Firma ünvanı geçersiz');
  if (!phoneNorm) throw new HttpError('GSM numarası geçersiz (05XX XXX XX XX biçiminde olmalı)');
  if (!validEmail(email) || email.length > 120) throw new HttpError('Email adresi geçersiz');
  if (body.terms !== true || body.consent !== true) throw new HttpError('Katılım koşulları ve iletişim izni onaylanmalı');

  const dup = await env.DB.prepare(
    `SELECT id FROM participants WHERE email = ? OR phone_norm = ? LIMIT 1`
  ).bind(email, phoneNorm).first();
  if (dup) throw new HttpError('Bu email veya telefon ile zaten katıldınız', 409);

  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const now = nowSec();
  try {
    await env.DB.prepare(
      `INSERT INTO participants (name, company, phone, email, phone_norm, token, spins_left, has_gift, spin_count, terms_at, consent_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, 0, 0, ?, ?, ?)`
    ).bind(name, company, '0' + phoneNorm, email, phoneNorm, token, now, now, now).run();
  } catch (err) {
    if (String(err && err.message).includes('UNIQUE')) throw new HttpError('Bu email veya telefon ile zaten katıldınız', 409);
    throw err;
  }
  return json({ token, name });
}

async function getMe(request, env) {
  const token = request.headers.get('X-Participant-Token') || '';
  if (token.length < 32) throw new HttpError('Geçersiz oturum', 401);
  const p = await env.DB.prepare(
    `SELECT name, spins_left, has_gift, prize, prize_type FROM participants WHERE token = ?`
  ).bind(token).first();
  if (!p) throw new HttpError('Geçersiz oturum', 401);
  return json({ name: p.name, spinsLeft: p.spins_left, hasGift: !!p.has_gift, prize: p.prize, prizeType: p.prize_type });
}

/* ------------------------------------------------------------------ çevirme */

function pickWeighted(pool) {
  const total = pool.reduce((s, x) => s + (x.weight > 0 ? x.weight : 1), 0);
  let r = secureRandom() * total;
  for (const s of pool) {
    r -= (s.weight > 0 ? s.weight : 1);
    if (r < 0) return s;
  }
  return pool[pool.length - 1];
}

class BusyError extends Error {}

// Bir çevirmenin çarkı tuttuğu süre: dönüş + sonuç ekranı + sıradaki için geri sayım payı.
// (Yalnızca testlerde SPIN_SLOT_MS ortam değişkeniyle kısaltılır; canlıda tanımlı değildir.)
function slotMs(env) {
  const t = Number.parseInt(env && env.SPIN_SLOT_MS, 10);
  return Number.isFinite(t) && t >= 0 ? t : SPIN_DURATION_MS + SPIN_HOLD_MS + SPIN_PREROLL_MS;
}

// Bekleme listesi: çark meşgulken basan oyuncu sıraya girer; çark boşalınca en erken basan (300 ms içinde
// eşitse formu önce dolduran) çevirir. Oyuncu bu uç noktayı aralıklarla tekrar çağırarak 'hayattayım' der.
async function spinWheel(request, env) {
  const body = await readJson(request);
  const token = String(body.token ?? '');
  if (token.length < 32) throw new HttpError('Geçersiz oturum', 401);

  const participant = await env.DB.prepare(
    `SELECT id, name, has_gift, spins_left FROM participants WHERE token = ?`
  ).bind(token).first();
  if (!participant) throw new HttpError('Geçersiz oturum', 401);

  const dropRow = () => env.DB.prepare(`DELETE FROM spin_queue WHERE participant_id = ?`).bind(participant.id).run();

  const settings = await loadSettings(env);
  if (settings.paused) { await dropRow(); throw new HttpError('Çark kısa bir süre durduruldu, lütfen biraz sonra tekrar deneyin', 503); }
  if (participant.spins_left <= 0) { await dropRow(); throw new HttpError('Çevirme hakkınız kalmadı', 403); }

  const nowMs = Date.now();
  await env.DB.prepare(`DELETE FROM spin_queue WHERE last_seen < ?`).bind(nowMs - QUEUE_STALE_MS).run();
  const q = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM spin_queue) AS c, (SELECT 1 FROM spin_queue WHERE participant_id = ?) AS mine`
  ).bind(participant.id).first();
  if (!q.mine && q.c >= QUEUE_MAX) throw new HttpError('Bekleme listesi dolu, birkaç saniye sonra tekrar deneyin', 429);
  await env.DB.prepare(
    `INSERT INTO spin_queue (participant_id, pressed_at, last_seen) VALUES (?, ?, ?)
       ON CONFLICT(participant_id) DO UPDATE SET last_seen = excluded.last_seen`
  ).bind(participant.id, nowMs, nowMs).run();

  const st = await queueState(env, participant.id, nowMs);
  if (st.position === 1 && st.freeInMs <= 0) {
    try {
      return json(await performSpin(env, participant, settings));
    } catch (err) {
      if (err instanceof BusyError) return json(await queuedReply(env, participant.id), 202);
      await dropRow();
      throw err;
    }
  }
  return json(await queuedReply(env, participant.id), 202);
}

async function queuedReply(env, participantId) {
  const nowMs = Date.now();
  const st = await queueState(env, participantId, nowMs);
  const slot = slotMs(env);
  return {
    queued: true, position: st.position, total: st.total,
    waitMs: st.freeInMs + (st.position - 1) * slot, freeInMs: st.freeInMs, serverNow: nowMs
  };
}

// Sıradaki kişi: en erken basanla 300 ms içinde basanlar arasında en küçük kayıt numarası.
async function queueState(env, participantId, nowMs) {
  const me = await env.DB.prepare(`SELECT pressed_at FROM spin_queue WHERE participant_id = ?`).bind(participantId).first();
  const agg = await env.DB.prepare(`SELECT COUNT(*) AS c, MIN(pressed_at) AS m FROM spin_queue`).first();
  const nf = await env.DB.prepare(`SELECT v FROM settings WHERE k = 'next_free'`).first();
  const nextFree = nf ? Number.parseInt(nf.v, 10) || 0 : 0;
  const freeInMs = Math.max(0, nextFree - SPIN_LEAD_MS - nowMs);
  if (!me || !agg.c) return { position: 1, total: agg.c || 0, freeInMs };
  const head = await env.DB.prepare(
    `SELECT participant_id FROM spin_queue WHERE pressed_at <= ? ORDER BY participant_id ASC LIMIT 1`
  ).bind(agg.m + QUEUE_TIE_MS).first();
  let position = 1;
  if (head.participant_id !== participantId) {
    const ahead = await env.DB.prepare(
      `SELECT COUNT(*) AS c FROM spin_queue
        WHERE participant_id != ? AND (pressed_at < ? OR (pressed_at <= ? AND participant_id < ?))`
    ).bind(participantId, me.pressed_at - QUEUE_TIE_MS, me.pressed_at + QUEUE_TIE_MS, participantId).first();
    position = Math.max(2, ahead.c + 1);
  }
  return { position, total: agg.c, freeInMs };
}

async function performSpin(env, participant, settings) {
  // Çevirme hakkını atomik tüket: paralel isteklerde yalnızca biri geçer.
  const claim = await env.DB.prepare(
    `UPDATE participants SET spins_left = spins_left - 1 WHERE id = ? AND spins_left > 0`
  ).bind(participant.id).run();
  if (!claim.meta.changes) throw new HttpError('Çevirme hakkınız kalmadı', 403);

  let reservedGiftId = null;
  try {
    const { results: slices } = await env.DB.prepare(
      `SELECT id, type, name, stock, weight, sort_order FROM slices WHERE active = 1 AND stock > 0 ORDER BY sort_order ASC, id ASC`
    ).all();
    if (!slices.length) throw new HttpError('Şu anda çark hazır değil', 503);

    // Hediye bütçesi: stoklu hediyeler yalnızca zaman payı doluysa çekilebilir.
    const pacing = await giftPacing(env, settings, nowSec());
    // 1 kişi = en fazla 1 hediye
    let pool = slices.filter(s => {
      if (s.type !== 'gift') return true;
      if (participant.has_gift) return false;
      if (s.stock >= UNLIMITED_STOCK) return true; // sınırsız hediye bütçeye tabi değil
      return pacing.allowed;
    });
    if (!pool.length) throw new HttpError('Şu anda çark hazır değil', 503);

    let chosen = null;
    while (pool.length) {
      const c = pickWeighted(pool);
      if (c.type !== 'gift' || c.stock >= UNLIMITED_STOCK) { chosen = c; break; }
      // Hediye stoğunu atomik rezerve et; başkası son hediyeyi aldıysa yeniden çek.
      const dec = await env.DB.prepare(
        `UPDATE slices SET stock = stock - 1 WHERE id = ? AND stock > 0 AND active = 1`
      ).bind(c.id).run();
      if (dec.meta.changes) { chosen = c; reservedGiftId = c.id; break; }
      pool = pool.filter(s => s.id !== c.id);
    }
    if (!chosen) throw new HttpError('Şu anda çark hazır değil', 503);

    const now = nowSec();
    const grant = (chosen.type === 'again' || chosen.type === 'task') ? 1 : 0;
    const isGift = chosen.type === 'gift';

    // Zamanlama: tüm çevirmeler tek bir sıraya girer (atomik), iki ekran aynı anda başlar.
    const snapshot = slices.map(publicSlice);
    const idx = snapshot.findIndex(s => s.id === chosen.id);
    const turns = 5 + Math.floor(secureRandom() * 3);
    const offsetFrac = 0.15 + secureRandom() * 0.7;
    const startAt = await reserveSlot(env);
    const timing = { startAt, duration: SPIN_DURATION_MS, hold: SPIN_HOLD_MS, turns, offsetFrac, idx, slices: snapshot };
    // Herkese açık olay akışında tam ad yerine maskeli ad (Ayşe Y.) yayınlanır.
    const payload = JSON.stringify({ name: maskName(participant.name), sliceId: chosen.id, sliceName: chosen.name, sliceType: chosen.type, ...timing });

    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO spins (participant_id, slice_id, slice_name, slice_type, created_at) VALUES (?, ?, ?, ?, ?)`
      ).bind(participant.id, chosen.id, chosen.name, chosen.type, now),
      // Hediye kazanıldıysa kalıcı yazılır; sonraki sonuçlar hediyenin üzerine yazmaz.
      env.DB.prepare(
        `UPDATE participants
            SET spin_count = spin_count + 1,
                spins_left = spins_left + ?,
                prize = CASE WHEN has_gift = 1 THEN prize ELSE ? END,
                prize_type = CASE WHEN has_gift = 1 THEN prize_type ELSE ? END,
                has_gift = CASE WHEN ? = 1 THEN 1 ELSE has_gift END
          WHERE id = ?`
      ).bind(grant, chosen.name, chosen.type, isGift ? 1 : 0, participant.id),
      env.DB.prepare(`INSERT INTO events (type, payload, created_at) VALUES ('spin', ?, ?)`).bind(payload, now),
      env.DB.prepare(`DELETE FROM events WHERE created_at < ?`).bind(now - 86400),
      env.DB.prepare(`DELETE FROM spin_queue WHERE participant_id = ?`).bind(participant.id)
    ]);

    const after = await env.DB.prepare(`SELECT spins_left, has_gift FROM participants WHERE id = ?`).bind(participant.id).first();
    return {
      slice: publicSlice(chosen),
      slices: snapshot,
      ...timing,
      serverNow: Date.now(),
      spinsLeft: after.spins_left,
      hasGift: !!after.has_gift
    };
  } catch (err) {
    // Başarısız çevirmede hakkı ve rezerve edilen stoğu geri ver.
    try {
      await env.DB.prepare(`UPDATE participants SET spins_left = spins_left + 1 WHERE id = ?`).bind(participant.id).run();
      if (reservedGiftId) await env.DB.prepare(`UPDATE slices SET stock = stock + 1 WHERE id = ?`).bind(reservedGiftId).run();
    } catch (e2) { console.error('Geri alma başarısız:', e2); }
    throw err;
  }
}

/* ------------------------------------------------------------------ admin */

async function updateSlices(request, env) {
  const body = await readJson(request);
  const list = Array.isArray(body.slices) ? body.slices : null;
  if (!list || !list.length || list.length > 24) throw new HttpError('Dilim sayısı 1-24 arasında olmalı');

  const now = nowSec();
  const rows = list.map((s, i) => {
    const type = String(s.type ?? '');
    const name = cleanText(s.name, 40);
    const stock = Number.parseInt(s.stock, 10);
    const weight = Number.parseFloat(s.weight);
    if (!SLICE_TYPES.includes(type)) throw new HttpError(`Dilim ${i + 1}: tür geçersiz`);
    if (name.length < 1 || name.length > 40) throw new HttpError(`Dilim ${i + 1}: ad 1-40 karakter olmalı`);
    if (!Number.isFinite(stock) || stock < 0 || stock > 100000) throw new HttpError(`Dilim ${i + 1}: stok geçersiz`);
    if (!Number.isFinite(weight) || weight <= 0 || weight > 100) throw new HttpError(`Dilim ${i + 1}: ağırlık 0-100 arasında olmalı`);
    let id = s.id ? String(s.id) : '';
    if (id && !/^[A-Za-z0-9_-]{1,40}$/.test(id)) throw new HttpError(`Dilim ${i + 1}: kimlik geçersiz`);
    if (!id) id = 's_' + crypto.randomUUID().slice(0, 8);
    return { id, type, name, stock, weight, order: i + 1 };
  });
  if (new Set(rows.map(r => r.id)).size !== rows.length) throw new HttpError('Dilim kimlikleri tekrar ediyor');

  // Tek batch = tek işlem: hata olursa çark yarım kalmaz.
  const stmts = [env.DB.prepare(`UPDATE slices SET active = 0`)];
  for (const r of rows) {
    stmts.push(env.DB.prepare(
      `INSERT INTO slices (id, type, name, stock, weight, sort_order, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, stock = excluded.stock,
         weight = excluded.weight, sort_order = excluded.sort_order, active = 1`
    ).bind(r.id, r.type, r.name, r.stock, r.weight, r.order, now));
  }
  await env.DB.batch(stmts);
  return json({ ok: true, count: rows.length });
}

// Tablo programlarında formül olarak yorumlanmasın diye = + - @ ile başlayanlar önlenir.
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

async function exportCSV(env) {
  // Türkiye saati (UTC+3, yaz saati uygulaması yok)
  const { results } = await env.DB.prepare(
    `SELECT datetime(created_at, 'unixepoch', '+3 hours') AS tarih, name, company, phone, email,
            prize, prize_type, spin_count, consent_at
       FROM participants ORDER BY id ASC`
  ).all();
  const header = ['Tarih', 'Ad Soyad', 'Firma', 'GSM', 'Email', 'Son Sonuç / Hediye', 'Tür', 'Çevirme', 'İzin'];
  const rows = results.map(p => [p.tarih, p.name, p.company, p.phone, p.email, p.prize, p.prize_type, p.spin_count, p.consent_at ? 'Evet' : 'Hayır']);
  const csv = '﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n');
  const day = new Date(Date.now() + 3 * 3600 * 1000).toISOString().slice(0, 10);
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inspireit-${day}.csv"`,
      'Cache-Control': 'no-store'
    }
  });
}

/* ------------------------------------------------------------------ ayarlar, hediye bütçesi, sıra */

async function loadSettings(env) {
  const { results } = await env.DB.prepare(`SELECT k, v FROM settings`).all();
  return parseSettings(results);
}

// Etkinlik başlangıcından beri verilen ve kalan stoklu hediyelere göre bütçe durumu.
async function giftPacing(env, settings, now) {
  const since = settings.start || 0;
  const g = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM spins s JOIN slices sl ON sl.id = s.slice_id
      WHERE s.slice_type = 'gift' AND sl.stock < ? AND s.created_at >= ?`
  ).bind(UNLIMITED_STOCK, since).first();
  const r = await env.DB.prepare(
    `SELECT COALESCE(SUM(stock), 0) AS c FROM slices WHERE active = 1 AND type = 'gift' AND stock > 0 AND stock < ?`
  ).bind(UNLIMITED_STOCK).first();
  return computeAllowance(settings, now, g.c, r.c);
}

// Çarkta bir yer ayırır (tek atomik UPDATE): çark ancak önceki çevirme tamamen bittiyse boştur.
// Meşgulse BusyError; çağıran hakkı ve stoğu iade eder, oyuncu bekleme listesinde kalır.
async function reserveSlot(env) {
  const nowMs = Date.now();
  const slot = slotMs(env);
  const row = await env.DB.prepare(
    `UPDATE settings SET v = CAST(MAX(CAST(v AS INTEGER), ?) + ? AS TEXT)
      WHERE k = 'next_free' AND CAST(v AS INTEGER) <= ?
      RETURNING CAST(v AS INTEGER) - ? AS start_at`
  ).bind(nowMs + SPIN_LEAD_MS, slot, nowMs + SPIN_LEAD_MS, slot).first();
  if (!row) throw new BusyError('busy');
  return row.start_at;
}

async function getState(env) {
  const s = await loadSettings(env);
  return json({ now: Date.now(), paused: s.paused });
}

function eventPhase(s, now) {
  if (!isConfigured(s)) return 'unconfigured';
  if (now < s.start) return 'not_started';
  if (now >= eventEndSec(s)) return 'ended';
  const len = s.hours * 3600;
  for (let i = 0; i < s.days; i++) {
    const ws = s.start + i * 86400;
    if (now >= ws && now < ws + len) return 'running';
  }
  return 'break';
}

async function adminStatus(env) {
  const s = await loadSettings(env);
  const now = nowSec();
  const pacing = await giftPacing(env, s, now);
  const { results: slices } = await env.DB.prepare(
    `SELECT id, type, name, stock, weight FROM slices WHERE active = 1 ORDER BY sort_order ASC, id ASC`
  ).all();
  const live = slices.filter(x => x.stock > 0);
  const eligible = live.filter(x => x.type !== 'gift' || x.stock >= UNLIMITED_STOCK || pacing.allowed);
  const wAll = eligible.reduce((a, x) => a + x.weight, 0);
  const wGift = eligible.filter(x => x.type === 'gift').reduce((a, x) => a + x.weight, 0);
  const p = await env.DB.prepare(`SELECT COUNT(*) AS c FROM participants`).first();
  const sp = await env.DB.prepare(`SELECT COUNT(*) AS c FROM spins`).first();
  const gifts = await env.DB.prepare(`SELECT COUNT(*) AS c FROM spins WHERE slice_type = 'gift'`).first();
  return json({
    now: Date.now(),
    mode: s.mode,
    paused: s.paused,
    configured: isConfigured(s),
    phase: eventPhase(s, now),
    schedule: isConfigured(s)
      ? { start: s.start, days: s.days, hoursPerDay: s.hours, end: eventEndSec(s), totalHours: totalActiveSec(s) / 3600, elapsedHours: activeElapsedSec(now, s) / 3600 }
      : null,
    gifts: {
      total: pacing.total, given: pacing.given, remaining: pacing.remaining,
      target: pacing.target, allowance: pacing.allowance, allowed: pacing.allowed, fraction: pacing.fraction
    },
    giftChancePercent: wAll > 0 ? Math.round((wGift / wAll) * 1000) / 10 : 0,
    slices: slices.map(x => ({ id: x.id, type: x.type, name: x.name, stock: x.stock, weight: x.weight })),
    participants: p.c,
    spins: sp.c,
    giftSpins: gifts.c,
    queueFreeAt: s.nextFree
  });
}

function parseEventStart(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.floor(v);
  let str = String(v ?? '').trim();
  if (/^\d{9,11}$/.test(str)) return parseInt(str, 10);
  str = str.replace(' ', 'T');
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(str)) str += ':00';
  if (!/(Z|[+-]\d{2}:\d{2})$/.test(str)) str += '+03:00'; // saat dilimi yoksa Türkiye saati
  const ms = Date.parse(str);
  if (!Number.isFinite(ms)) return null;
  return Math.floor(ms / 1000);
}

async function updateSettings(request, env) {
  const body = await readJson(request);
  const upserts = [];
  const set = (k, v) => upserts.push(env.DB.prepare(
    `INSERT INTO settings (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`
  ).bind(k, String(v)));

  if (body.mode !== undefined) {
    if (!MODES.includes(body.mode)) throw new HttpError('Mod auto, open veya closed olmalı');
    set('mode', body.mode);
  }
  if (body.paused !== undefined) {
    if (typeof body.paused !== 'boolean') throw new HttpError('paused true/false olmalı');
    set('paused', body.paused ? '1' : '0');
  }
  if (body.eventStart !== undefined) {
    const t = parseEventStart(body.eventStart);
    const now = nowSec();
    if (t === null || t < now - 400 * 86400 || t > now + 800 * 86400) throw new HttpError('Etkinlik başlangıcı geçersiz');
    set('event_start', t);
  }
  if (body.days !== undefined) {
    const d = Number.parseInt(body.days, 10);
    if (!Number.isFinite(d) || d < 1 || d > 14) throw new HttpError('Gün sayısı 1-14 arasında olmalı');
    set('event_days', d);
  }
  if (body.hoursPerDay !== undefined) {
    const h = Number.parseFloat(body.hoursPerDay);
    if (!Number.isFinite(h) || h < 0.25 || h > 24) throw new HttpError('Günlük süre 0,25-24 saat arasında olmalı');
    set('event_hours', h);
  }
  if (!upserts.length) throw new HttpError('Değiştirilecek ayar yok');
  await env.DB.batch(upserts);
  return await adminStatus(env);
}
