// InspireIT Şans Çarkı - sunucu (Cloudflare Worker + D1)
// Aşama 1: güvenli çevirme akışı, 1 kişi = 1 hediye, atomik stok, olaylar D1'de.

import { parseSettings, isConfigured, computeAllowance, activeElapsedSec, totalActiveSec, eventEndSec } from './pacing.js';
import { MAX_PER_DEVICE, MAX_PER_CONTACT, checkPhone, checkEmail, checkText, parseDomainList, DEFAULT_BLOCKED_DOMAINS } from './validate.js';

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
      if (path === '/api/admin/participants' && method === 'GET') {
        if (!(await isAdmin(request, env))) return json({ error: 'Yetkisiz' }, 401);
        return await adminParticipants(url, env);
      }
      if (path === '/api/admin/spins' && method === 'GET') {
        if (!(await isAdmin(request, env))) return json({ error: 'Yetkisiz' }, 401);
        return await adminSpins(url, env);
      }
      if (path === '/api/admin/test' && method === 'GET') {
        if (!(await isAdmin(request, env))) return json({ error: 'Yetkisiz' }, 401);
        return await adminTest(env);
      }
      if (path === '/api/admin/test/users' && method === 'POST') {
        if (!(await isAdmin(request, env))) return json({ error: 'Yetkisiz' }, 401);
        return await createTestUsers(request, env);
      }
      if (path === '/api/admin/test/users' && method === 'DELETE') {
        if (!(await isAdmin(request, env))) return json({ error: 'Yetkisiz' }, 401);
        return await deleteTestData(env);
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
      if (err instanceof HttpError) return json(err.field ? { error: err.message, field: err.field } : { error: err.message }, err.status);
      console.error('Beklenmeyen hata:', err && err.stack ? err.stack : err);
      return json({ error: 'Sunucu hatası, lütfen tekrar deneyin' }, 500);
    }
  }
};

/* ---------------------------------------------------------------- yardımcılar */

class HttpError extends Error {
  constructor(message, status = 400, field = null) { super(message); this.status = status; this.field = field; }
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
  const p = await env.DB.prepare(`SELECT COUNT(*) AS c FROM participants WHERE is_test = 0`).first();
  const g = await env.DB.prepare(`SELECT COUNT(*) AS c FROM spins s LEFT JOIN participants p ON p.id = s.participant_id WHERE s.slice_type = 'gift' AND COALESCE(p.is_test, 0) = 0`).first();
  return json({ participants: p.c, gifts: g.c });
}

// Yalnızca hediye kazananlar, isim maskeli (Ahmet K.)
async function getLastWinners(env) {
  const { results } = await env.DB.prepare(
    `SELECT p.name AS name, s.slice_name AS prize, s.created_at AS created_at
       FROM spins s JOIN participants p ON p.id = s.participant_id
      WHERE s.slice_type = 'gift' AND p.is_test = 0 ORDER BY s.id DESC LIMIT 8`
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

  const fail = (msg, field, status = 400) => { throw new HttpError(msg, status, field); };
  const name = checkText(body.name, 'Ad Soyad', 3, 80, { fullName: true });
  if (name.error) fail(name.error, 'name');
  const company = checkText(body.company, 'Firma ünvanı', 2, 100);
  if (company.error) fail(company.error, 'company');
  const title = checkText(body.title, 'Görev / Ünvan', 2, 60);
  if (title.error) fail(title.error, 'title');
  const phone = checkPhone(body.phone);
  if (phone.error) fail(phone.error, 'phone');
  const extra = await env.DB.prepare(`SELECT v FROM settings WHERE k = 'blocked_domains'`).first();
  const mail = checkEmail(body.email, extra ? parseDomainList(extra.v) || [] : []);
  if (mail.error) fail(mail.error, 'email');
  const deviceId = String(body.deviceId ?? '');
  if (!/^[A-Za-z0-9-]{16,64}$/.test(deviceId)) fail('Cihaz tanımlanamadı, sayfayı yenileyip tekrar deneyin', null);
  if (body.terms !== true || body.consent !== true) fail('Katılım koşulları ve iletişim izni onaylanmalı', null);

  const suspect = [...name.suspect, ...company.suspect, ...title.suspect, ...mail.suspect].join('; ') || null;
  const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
  const now = nowSec();

  // Sınır kontrolü ve ekleme tek atomik INSERT...SELECT: paralel isteklerde sınır aşılmaz.
  const ins = await env.DB.prepare(
    `INSERT INTO participants (name, company, title, phone, email, phone_norm, email_norm, device_id, suspect, token,
                               spins_left, has_gift, spin_count, is_test, terms_at, consent_at, created_at)
     SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?5, ?7, ?8, ?9, 1, 0, 0, 0, ?10, ?10, ?10
      WHERE (SELECT COUNT(*) FROM participants WHERE email_norm = ?5 AND is_test = 0) < ?11
        AND (SELECT COUNT(*) FROM participants WHERE phone_norm = ?6 AND is_test = 0) < ?11
        AND (SELECT COUNT(*) FROM participants WHERE device_id = ?7 AND is_test = 0) < ?12`
  ).bind(name.value, company.value, title.value, '0' + phone.norm, mail.email, phone.norm, deviceId, suspect, token, now,
         MAX_PER_CONTACT, MAX_PER_DEVICE).run();

  const c = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM participants WHERE email_norm = ?1 AND is_test = 0) AS ce,
            (SELECT COUNT(*) FROM participants WHERE phone_norm = ?2 AND is_test = 0) AS cp,
            (SELECT COUNT(*) FROM participants WHERE device_id = ?3 AND is_test = 0) AS cd`
  ).bind(mail.email, phone.norm, deviceId).first();

  if (!ins.meta.changes) {
    if (c.ce >= MAX_PER_CONTACT) fail(`Bu e-posta adresi ${MAX_PER_CONTACT} kez kullanıldı, daha fazla kullanılamaz`, 'email', 409);
    if (c.cp >= MAX_PER_CONTACT) fail(`Bu telefon numarası ${MAX_PER_CONTACT} kez kullanıldı, daha fazla kullanılamaz`, 'phone', 409);
    if (c.cd >= MAX_PER_DEVICE) fail(`Bu cihazdan en fazla ${MAX_PER_DEVICE} kişi katılabilir`, null, 403);
    throw new HttpError('Kayıt yapılamadı, lütfen tekrar deneyin', 409);
  }

  // Bu kayıt e-posta veya telefon için son hak mıydı?
  let warning = null;
  if (c.ce >= MAX_PER_CONTACT || c.cp >= MAX_PER_CONTACT) {
    warning = `Bu ${c.ce >= MAX_PER_CONTACT ? 'e-posta adresi' : 'telefon numarası'} ${MAX_PER_CONTACT}. kez kullanıldı; bir daha kullanılamaz. Aynı kişi yalnızca 1 hediye kazanabilir.`;
  } else if (c.ce > 1 || c.cp > 1) {
    warning = `Bu ${c.ce > 1 ? 'e-posta adresi' : 'telefon numarası'} ${Math.max(c.ce, c.cp)}. kez kullanılıyor (en fazla ${MAX_PER_CONTACT}). Aynı kişi yalnızca 1 hediye kazanabilir.`;
  }
  return json({ token, name: name.value, warning, deviceLeft: MAX_PER_DEVICE - c.cd });
}

async function getMe(request, env) {
  const token = request.headers.get('X-Participant-Token') || '';
  if (token.length < 32) throw new HttpError('Geçersiz oturum', 401);
  const p = await env.DB.prepare(
    `SELECT name, spins_left, has_gift, prize, prize_type, device_id, is_test FROM participants WHERE token = ?`
  ).bind(token).first();
  if (!p) throw new HttpError('Geçersiz oturum', 401);
  // Test kullanıcısı yalnızca test modu açıkken geçerlidir
  if (p.is_test && !(await loadSettings(env)).testMode) throw new HttpError('Test modu kapalı', 401);
  // Cihazın kalan kayıt hakkı: istemcinin gönderdiği cihaz kimliği, yoksa kaydın kendi cihaz kimliği
  const dev = request.headers.get('X-Device-Id') || p.device_id || '';
  let deviceLeft = MAX_PER_DEVICE;
  if (/^[A-Za-z0-9-]{16,64}$/.test(dev)) {
    const c = await env.DB.prepare(`SELECT COUNT(*) AS c FROM participants WHERE device_id = ? AND is_test = 0`).bind(dev).first();
    deviceLeft = Math.max(0, MAX_PER_DEVICE - c.c);
  }
  return json({ name: p.name, spinsLeft: p.spins_left, hasGift: !!p.has_gift, prize: p.prize, prizeType: p.prize_type, deviceLeft, isTest: !!p.is_test });
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
    `SELECT id, name, has_gift, spins_left, email_norm, phone_norm, is_test FROM participants WHERE token = ?`
  ).bind(token).first();
  if (!participant) throw new HttpError('Geçersiz oturum', 401);

  const dropRow = () => env.DB.prepare(`DELETE FROM spin_queue WHERE participant_id = ?`).bind(participant.id).run();

  const settings = await loadSettings(env);
  if (participant.is_test && !settings.testMode) { await dropRow(); throw new HttpError('Test modu kapalı', 403); }
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

async function contactHasGift(env, p) {
  if (!p.email_norm && !p.phone_norm) return false;
  const r = await env.DB.prepare(
    `SELECT 1 AS x FROM participants WHERE has_gift = 1 AND id != ?1 AND ((?2 != '' AND email_norm = ?2) OR (?3 != '' AND phone_norm = ?3)) LIMIT 1`
  ).bind(p.id, p.email_norm || '', p.phone_norm || '').first();
  return !!r;
}

async function performSpin(env, participant, settings) {
  // Çevirme hakkını atomik tüket: paralel isteklerde yalnızca biri geçer.
  // Test kullanıcısının hakkı sınırsızdır: hak düşülmez.
  const isTest = !!participant.is_test;
  if (!isTest) {
    const claim = await env.DB.prepare(
      `UPDATE participants SET spins_left = spins_left - 1 WHERE id = ? AND spins_left > 0`
    ).bind(participant.id).run();
    if (!claim.meta.changes) throw new HttpError('Çevirme hakkınız kalmadı', 403);
  }

  let reservedGiftId = null;
  try {
    const { results: slices } = await env.DB.prepare(
      `SELECT id, type, name, stock, weight, sort_order FROM slices WHERE active = 1 AND stock > 0 ORDER BY sort_order ASC, id ASC`
    ).all();
    if (!slices.length) throw new HttpError('Şu anda çark hazır değil', 503);

    // Hediye bütçesi: stoklu hediyeler yalnızca zaman payı doluysa çekilebilir.
    const pacing = await giftPacing(env, settings, nowSec());
    // 1 kişi = en fazla 1 hediye. Aynı e-posta veya telefonla kayıtlı başka biri hediye aldıysa o da sayılır.
    const alreadyWon = !isTest && (participant.has_gift || await contactHasGift(env, participant));
    let pool = slices.filter(s => {
      if (s.type !== 'gift') return true;
      if (isTest) return true;          // test kullanıcısı mod, bütçe ve 1 hediye kuralından bağımsız hediye görebilir
      if (alreadyWon) return false;
      if (s.stock >= UNLIMITED_STOCK) return true; // sınırsız hediye bütçeye tabi değil
      return pacing.allowed;
    });
    if (!pool.length) throw new HttpError('Şu anda çark hazır değil', 503);

    let chosen = null;
    while (pool.length) {
      const c = pickWeighted(pool);
      if (c.type !== 'gift' || c.stock >= UNLIMITED_STOCK || (isTest && !settings.testStock)) { chosen = c; break; }
      // Hediye stoğunu atomik rezerve et; başkası son hediyeyi aldıysa yeniden çek.
      const dec = await env.DB.prepare(
        `UPDATE slices SET stock = stock - 1 WHERE id = ? AND stock > 0 AND active = 1`
      ).bind(c.id).run();
      if (dec.meta.changes) { chosen = c; reservedGiftId = c.id; break; }
      pool = pool.filter(s => s.id !== c.id);
    }
    if (!chosen) throw new HttpError('Şu anda çark hazır değil', 503);

    const now = nowSec();
    const grant = (!isTest && (chosen.type === 'again' || chosen.type === 'task')) ? 1 : 0;
    const isGift = chosen.type === 'gift' && !isTest;

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
      hasGift: !!after.has_gift,
      isTest
    };
  } catch (err) {
    // Başarısız çevirmede hakkı ve rezerve edilen stoğu geri ver.
    try {
      if (!isTest) await env.DB.prepare(`UPDATE participants SET spins_left = spins_left + 1 WHERE id = ?`).bind(participant.id).run();
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
    `SELECT datetime(created_at, 'unixepoch', '+3 hours') AS tarih, name, company, title, phone, email,
            prize, prize_type, spin_count, consent_at, suspect
       FROM participants WHERE is_test = 0 ORDER BY id ASC`
  ).all();
  const header = ['Tarih', 'Ad Soyad', 'Firma', 'Görev / Ünvan', 'GSM', 'Email', 'Son Sonuç / Hediye', 'Tür', 'Çevirme', 'İzin', 'Şüpheli'];
  const rows = results.map(p => [p.tarih, p.name, p.company, p.title, p.phone, p.email, p.prize, p.prize_type, p.spin_count, p.consent_at ? 'Evet' : 'Hayır', p.suspect]);
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
  const m = Object.fromEntries(results.map(r => [r.k, r.v]));
  return { ...parseSettings(results), testMode: m.test_mode === '1', testStock: m.test_stock === '1' };
}

// Etkinlik başlangıcından beri verilen ve kalan stoklu hediyelere göre bütçe durumu.
// Test çevirmeleri 'verilen' sayılmaz; test stoktan düşüyorsa yalnızca kalan stok azalır (bütçe kalan stoğa göre yeniden hesaplanır).
async function giftPacing(env, settings, now) {
  const since = settings.start || 0;
  const g = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM spins s JOIN slices sl ON sl.id = s.slice_id
       LEFT JOIN participants p ON p.id = s.participant_id
      WHERE s.slice_type = 'gift' AND sl.stock < ? AND s.created_at >= ? AND COALESCE(p.is_test, 0) = 0`
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

function clampInt(v, def, min, max) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

// Katılımcı listesi: arama (ad, firma, GSM, e-posta) ve sayfalama. Yalnızca yönetici görür.
async function adminParticipants(url, env) {
  const q = cleanText(url.searchParams.get('q') || '', 60);
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
  const offset = clampInt(url.searchParams.get('offset'), 0, 0, 1000000);
  const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
  const where = q ? `WHERE p.name LIKE ?1 ESCAPE '\\' OR p.company LIKE ?1 ESCAPE '\\' OR p.title LIKE ?1 ESCAPE '\\' OR p.email LIKE ?1 ESCAPE '\\' OR p.phone LIKE ?1 ESCAPE '\\'` : '';
  const bind = q ? [like] : [];
  const total = await env.DB.prepare(`SELECT COUNT(*) AS c FROM participants p ${where}`).bind(...bind).first();
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.company, p.title, p.phone, p.email, p.prize, p.prize_type, p.spin_count, p.spins_left, p.has_gift,
            p.suspect, p.is_test, p.created_at,
            (SELECT COUNT(*) FROM participants x WHERE x.id != p.id AND x.is_test = 0 AND p.is_test = 0
               AND ((p.email_norm IS NOT NULL AND x.email_norm = p.email_norm) OR (p.phone_norm IS NOT NULL AND x.phone_norm = p.phone_norm))) AS same_contact
       FROM participants p ${where} ORDER BY p.id DESC LIMIT ${limit} OFFSET ${offset}`
  ).bind(...bind).all();
  return json({ total: total.c, limit, offset, items: results.map(p => ({ ...p, has_gift: !!p.has_gift, is_test: !!p.is_test })) });
}

// Son çevirmeler (tam adla)
async function adminSpins(url, env) {
  const limit = clampInt(url.searchParams.get('limit'), 50, 1, 200);
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.created_at, s.slice_name, s.slice_type, p.name, p.company, p.is_test
       FROM spins s LEFT JOIN participants p ON p.id = s.participant_id
      ORDER BY s.id DESC LIMIT ${limit}`
  ).all();
  return json({ items: results });
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
  const p = await env.DB.prepare(`SELECT COUNT(*) AS c FROM participants WHERE is_test = 0`).first();
  const bd = await env.DB.prepare(`SELECT v FROM settings WHERE k = 'blocked_domains'`).first();
  const realSpin = `FROM spins s LEFT JOIN participants p ON p.id = s.participant_id WHERE COALESCE(p.is_test, 0) = 0`;
  const sp = await env.DB.prepare(`SELECT COUNT(*) AS c ${realSpin}`).first();
  const gifts = await env.DB.prepare(`SELECT COUNT(*) AS c ${realSpin} AND s.slice_type = 'gift'`).first();
  const tu = await env.DB.prepare(`SELECT COUNT(*) AS c FROM participants WHERE is_test = 1`).first();
  const ts = await env.DB.prepare(`SELECT COUNT(*) AS c FROM spins s JOIN participants p ON p.id = s.participant_id WHERE p.is_test = 1`).first();
  const qlen = await env.DB.prepare(`SELECT COUNT(*) AS c FROM spin_queue WHERE last_seen >= ?`).bind(Date.now() - QUEUE_STALE_MS).first();
  const { results: givenRows } = await env.DB.prepare(`SELECT s.slice_id AS slice_id, COUNT(*) AS c FROM spins s LEFT JOIN participants p ON p.id = s.participant_id WHERE COALESCE(p.is_test, 0) = 0 GROUP BY s.slice_id`).all();
  const givenBy = Object.fromEntries(givenRows.map(r => [r.slice_id, r.c]));
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
    slices: slices.map(x => ({ id: x.id, type: x.type, name: x.name, stock: x.stock, weight: x.weight, given: givenBy[x.id] || 0 })),
    queueLength: qlen.c,
    participants: p.c,
    spins: sp.c,
    giftSpins: gifts.c,
    queueFreeAt: s.nextFree,
    testMode: s.testMode,
    testStock: s.testStock,
    testUsers: tu.c,
    testSpins: ts.c,
    blockedDomains: bd ? bd.v : '',
    defaultBlockedDomains: DEFAULT_BLOCKED_DOMAINS
  });
}

const TEST_USER_MAX = 20;

// Test kullanıcıları: sınırsız çevirme hakkı, bağlantıyla giriş. Yalnızca yönetici görür.
async function adminTest(env) {
  const s = await loadSettings(env);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.name, p.token, p.created_at,
            (SELECT COUNT(*) FROM spins x WHERE x.participant_id = p.id) AS spins
       FROM participants p WHERE p.is_test = 1 ORDER BY p.id ASC`
  ).all();
  return json({ testMode: s.testMode, testStock: s.testStock, max: TEST_USER_MAX, users: results });
}

async function createTestUsers(request, env) {
  const body = await readJson(request);
  const count = clampInt(body.count, 1, 1, 10);
  const have = await env.DB.prepare(`SELECT COUNT(*) AS c, COALESCE(MAX(id), 0) AS m FROM participants WHERE is_test = 1`).first();
  if (have.c + count > TEST_USER_MAX) throw new HttpError(`En fazla ${TEST_USER_MAX} test kullanıcısı olabilir (şu an ${have.c})`);
  const now = nowSec();
  const stmts = [];
  for (let i = 1; i <= count; i++) {
    const token = crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '');
    stmts.push(env.DB.prepare(
      `INSERT INTO participants (name, company, title, phone, email, phone_norm, email_norm, device_id, suspect, token,
                                 spins_left, has_gift, spin_count, is_test, terms_at, consent_at, created_at)
       VALUES (?, 'TEST', 'TEST', '00000000000', 'test@test.invalid', NULL, NULL, NULL, NULL, ?, 1, 0, 0, 1, ?, ?, ?)`
    ).bind(`Test Kullanıcı ${have.c + i}`, token, now, now, now));
  }
  await env.DB.batch(stmts);
  return await adminTest(env);
}

// Yalnızca test kullanıcılarını ve onların çevirmelerini siler; gerçek kayıtlara dokunmaz. Stok geri yüklenmez.
async function deleteTestData(env) {
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM spin_queue WHERE participant_id IN (SELECT id FROM participants WHERE is_test = 1)`),
    env.DB.prepare(`DELETE FROM spins WHERE participant_id IN (SELECT id FROM participants WHERE is_test = 1)`),
    env.DB.prepare(`DELETE FROM participants WHERE is_test = 1`)
  ]);
  return await adminTest(env);
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
  if (body.testMode !== undefined) {
    if (typeof body.testMode !== 'boolean') throw new HttpError('testMode true/false olmalı');
    set('test_mode', body.testMode ? '1' : '0');
  }
  if (body.testStock !== undefined) {
    if (typeof body.testStock !== 'boolean') throw new HttpError('testStock true/false olmalı');
    set('test_stock', body.testStock ? '1' : '0');
  }
  if (body.blockedDomains !== undefined) {
    const list = parseDomainList(body.blockedDomains);
    if (list === null) throw new HttpError('Engelli alan adı listesinde geçersiz giriş var (örnek: sahte.com)');
    if (list.length > 200) throw new HttpError('En fazla 200 alan adı eklenebilir');
    set('blocked_domains', list.join(','));
  }
  if (!upserts.length) throw new HttpError('Değiştirilecek ayar yok');
  await env.DB.batch(upserts);
  return await adminStatus(env);
}
