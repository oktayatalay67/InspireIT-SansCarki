const ADMIN_TOKEN = 'inspireit-2026-oktay';
const events = [];
let eventIdCounter = 1;

function pushEvent(type, payload) {
  events.push({ id: eventIdCounter++, type, ...payload, ts: Date.now() });
  if (events.length > 100) events.shift();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    };
    if (request.method === 'OPTIONS') return new Response(null, { headers: cors });

    try {
      if (path === '/api/slices' && request.method === 'GET') return await getSlices(env, cors);
      if (path === '/api/spin' && request.method === 'POST') return await spinWheel(request, env, cors);
      if (path === '/api/events' && request.method === 'GET') return await getEvents(request, env, cors);
      if (path === '/api/last-winners' && request.method === 'GET') return await getLastWinners(env, cors);
      if (path === '/api/stats' && request.method === 'GET') return await getStats(env, cors);
      if (path === '/api/export.csv' && request.method === 'GET') return await exportCSV(request, env, cors);
      if (path === '/api/admin/slices' && request.method === 'PUT') return await updateSlices(request, env, cors);
      return env.ASSETS.fetch(request);
    } catch (err) {
      return json({ error: err.message }, 500, cors);
    }
  }
};

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders }
  });
}

async function getSlices(env, cors) {
  const { results } = await env.DB.prepare(
    `SELECT id, type, name, stock, weight FROM slices WHERE active = 1 AND stock > 0 ORDER BY sort_order ASC`
  ).all();
  return json({ slices: results }, 200, cors);
}

async function getLastWinners(env, cors) {
  const { results } = await env.DB.prepare(
    `SELECT name, prize, prize_type, created_at FROM participants WHERE prize_type = 'gift' ORDER BY id DESC LIMIT 5`
  ).all();
  return json({ winners: results }, 200, cors);
}

async function getStats(env, cors) {
  const p = await env.DB.prepare(`SELECT COUNT(*) as c FROM participants`).first();
  return json({ participants: p.c }, 200, cors);
}

async function getEvents(request, env, cors) {
  const url = new URL(request.url);
  const since = parseInt(url.searchParams.get('since') || '0', 10);
  const newEvents = events.filter(e => e.id > since);
  return json({ events: newEvents }, 200, cors);
}

function validateEmail(email) { return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email); }
function validatePhone(phone) { const d = phone.replace(/\D/g, ''); return d.length >= 10 && d.length <= 13; }

async function spinWheel(request, env, cors) {
  const body = await request.json();
  const now = Math.floor(Date.now() / 1000);

  if (!body.name || body.name.trim().length < 3) return json({ error: 'Ad Soyad en az 3 karakter olmalı' }, 400, cors);
  if (!body.company || body.company.trim().length < 2) return json({ error: 'Firma ünvanı geçersiz' }, 400, cors);
  if (!validatePhone(body.phone)) return json({ error: 'GSM numarası geçersiz (10-13 hane olmalı)' }, 400, cors);
  if (!validateEmail(body.email)) return json({ error: 'Email adresi geçersiz' }, 400, cors);

  const existing = await env.DB.prepare(
    `SELECT id FROM participants WHERE email = ? OR phone = ? LIMIT 1`
  ).bind(body.email.toLowerCase(), body.phone).first();
  if (existing && !body.participantId) {
    return json({ error: 'Bu email veya telefon ile zaten katıldınız' }, 400, cors);
  }

  const { results: slices } = await env.DB.prepare(
    `SELECT id, type, name, stock, weight FROM slices WHERE active = 1 AND stock > 0`
  ).all();
  if (slices.length === 0) return json({ error: 'Şu anda hediye kalmadı' }, 400, cors);

  const totalW = slices.reduce((sum, s) => sum + (s.weight || 1), 0);
  let r = Math.random() * totalW;
  let chosen = slices[0];
  for (const s of slices) { r -= (s.weight || 1); if (r <= 0) { chosen = s; break; } }

  let participantId;
  if (body.participantId) {
    participantId = body.participantId;
    await env.DB.prepare(`UPDATE participants SET spin_count = spin_count + 1 WHERE id = ?`).bind(participantId).run();
  } else {
    const ins = await env.DB.prepare(
      `INSERT INTO participants (name, company, phone, email, prize, prize_type, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(body.name, body.company, body.phone, body.email.toLowerCase(), chosen.name, chosen.type, now).run();
    participantId = ins.meta.last_row_id;
  }

  if (chosen.type === 'gift' && chosen.stock < 999 && chosen.stock > 0) {
    await env.DB.prepare(`UPDATE slices SET stock = stock - 1 WHERE id = ? AND stock > 0`).bind(chosen.id).run();
  }

  await env.DB.prepare(
    `INSERT INTO spins (participant_id, slice_id, slice_name, slice_type, created_at) VALUES (?, ?, ?, ?, ?)`
  ).bind(participantId, chosen.id, chosen.name, chosen.type, now).run();

  pushEvent('spin', { name: body.name, sliceId: chosen.id, sliceName: chosen.name, sliceType: chosen.type, participantId });

  return json({ participantId, slice: chosen, slices, playerName: body.name }, 200, cors);
}

async function updateSlices(request, env, cors) {
  const auth = request.headers.get('Authorization') || '';
  if (auth !== `Bearer ${ADMIN_TOKEN}`) return json({ error: 'Yetkisiz' }, 401, cors);
  const body = await request.json();
  const newSlices = body.slices || [];
  await env.DB.prepare(`UPDATE slices SET active = 0`).run();
  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < newSlices.length; i++) {
    const s = newSlices[i];
    await env.DB.prepare(
      `INSERT INTO slices (id, type, name, stock, weight, sort_order, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, stock = excluded.stock, weight = excluded.weight, sort_order = excluded.sort_order, active = 1`
    ).bind(s.id || `s${Date.now()}${i}`, s.type, s.name, parseInt(s.stock, 10) || 0, parseFloat(s.weight) || 1, i, now).run();
  }
  return json({ ok: true }, 200, cors);
}

async function exportCSV(request, env, cors) {
  const url = new URL(request.url);
  const token = url.searchParams.get('token');
  if (token !== ADMIN_TOKEN) return json({ error: 'Yetkisiz' }, 401, cors);
  const { results } = await env.DB.prepare(
    `SELECT datetime(created_at, 'unixepoch', 'localtime') as tarih, name as ad_soyad, company as firma, phone as gsm, email, prize as kazanilan, prize_type as tur, spin_count as cevirme FROM participants ORDER BY id ASC`
  ).all();
  const header = ['Tarih','Ad Soyad','Firma','GSM','Email','Kazanılan','Tür','Çevirme'];
  const rows = results.map(p => [p.tarih, p.ad_soyad, p.firma, p.gsm, p.email, p.kazanilan, p.tur, p.cevirme]);
  const csv = '\uFEFF' + [header, ...rows].map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\r\n');
  return new Response(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="inspireit-${new Date().toISOString().slice(0,10)}.csv"`,
      ...cors
    }
  });
}