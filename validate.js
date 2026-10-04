// Kayıt formu doğrulamaları: sahte telefon / e-posta / metin yakalama.
// Sunucu (worker.js) tek yetkili kaynaktır; kurallar burada tek yerde toplanır ve birim testle sınanır.

export const MAX_PER_DEVICE = 3;   // bir cihazdan en fazla kaç kişi katılabilir
export const MAX_PER_CONTACT = 3;  // aynı e-posta veya aynı telefonla en fazla kaç kayıt
export const MIN_EMAIL_LOCAL = 5;  // e-postada @ öncesi en az karakter

// Açıkça sahte ya da tek kullanımlık alan adları. Panelden ek alan adı eklenebilir.
export const DEFAULT_BLOCKED_DOMAINS = [
  'xyz.com', 'abc.com', 'abcd.com', 'abc123.com', 'test.com', 'test.test', 'testmail.com',
  'example.com', 'example.org', 'example.net', 'domain.com', 'deneme.com', 'sahte.com', 'fake.com',
  'asd.com', 'asdf.com', 'qwe.com', 'qwerty.com', 'aaa.com', 'zzz.com', 'xxx.com', '123.com', '1234.com',
  'mailinator.com', 'guerrillamail.com', '10minutemail.com', 'yopmail.com', 'tempmail.com', 'temp-mail.org',
  'trashmail.com', 'sharklasers.com', 'getnada.com', 'dispostable.com', 'maildrop.cc', 'fakeinbox.com',
  'throwawaymail.com'
];

// 10 haneli GSM (5XXXXXXXXX) döndürür, geçersizse null
export function normalizePhone(raw) {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('0090') && d.length === 14) d = d.slice(4);
  else if (d.startsWith('90') && d.length === 12) d = d.slice(2);
  else if (d.startsWith('0') && d.length === 11) d = d.slice(1);
  return /^5\d{9}$/.test(d) ? d : null;
}

// d: 10 haneli rakam dizisi. En uzun artan/azalan (ardışık) dizinin uzunluğu.
function longestStep(d, step) {
  let best = 1, run = 1;
  for (let i = 1; i < d.length; i++) {
    if (d.charCodeAt(i) - d.charCodeAt(i - 1) === step) { run++; if (run > best) best = run; } else run = 1;
  }
  return best;
}

function hasPeriod(s, p) {
  for (let i = p; i < s.length; i++) if (s[i] !== s[i - p]) return false;
  return true;
}

// Sahte görünen telefon için neden döndürür, makul görünüyorsa null.
export function fakePhoneReason(d) {
  if (/(\d)\1{4,}/.test(d)) return 'aynı rakam tekrarı';
  if (longestStep(d, 1) >= 6 || longestStep(d, -1) >= 6) return 'ardışık rakamlar';
  if (/(\d)\1(\d)\2(\d)\3/.test(d)) return 'ikili tekrar';
  const tail = d.slice(3);
  if (hasPeriod(tail, 1) || hasPeriod(tail, 2)) return 'tekrarlayan desen';
  return null;
}

export function checkPhone(raw) {
  const d = normalizePhone(raw);
  if (!d) return { error: 'GSM numarası geçersiz (05XX XXX XX XX biçiminde olmalı)' };
  if (fakePhoneReason(d)) return { error: 'Bu numara gerçek görünmüyor, lütfen kendi GSM numaranızı yazın' };
  return { norm: d };
}

// Virgül, boşluk veya satır sonuyla ayrılmış alan adı listesini temizler.
export function parseDomainList(str) {
  const out = [];
  for (const part of String(str ?? '').toLowerCase().split(/[\s,;]+/)) {
    const d = part.replace(/^@/, '').trim();
    if (!d) continue;
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(d)) return null;
    if (!out.includes(d)) out.push(d);
  }
  return out;
}

function isSequentialAlnum(s) {
  // abcde, 12345, edcba gibi 5+ ardışık harf/rakam
  let up = 1, down = 1;
  for (let i = 1; i < s.length; i++) {
    const diff = s.charCodeAt(i) - s.charCodeAt(i - 1);
    up = diff === 1 ? up + 1 : 1;
    down = diff === -1 ? down + 1 : 1;
    if (up >= 5 || down >= 5) return true;
  }
  return false;
}

const FAKE_LOCAL = /^(test|deneme|asdf|asdasd|qwert|qweqwe|sahte|fake|xxxx|aaaa)/;

// extraBlocked: panelden eklenen alan adları. Dönüş: { error } | { email, suspect[] }
export function checkEmail(raw, extraBlocked = []) {
  const email = String(raw ?? '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 120) return { error: 'E-posta adresi geçersiz' };
  const at = email.lastIndexOf('@');
  const local = email.slice(0, at), domain = email.slice(at + 1);
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain)) return { error: 'E-posta adresi geçersiz' };

  if (local.length < MIN_EMAIL_LOCAL) return { error: `E-posta adının @ işaretinden önceki kısmı en az ${MIN_EMAIL_LOCAL} karakter olmalı` };
  const fakeMsg = 'Bu e-posta adresi gerçek görünmüyor, lütfen kendi e-posta adresinizi yazın';
  if (local.startsWith('123')) return { error: fakeMsg };
  if (/(.)\1{3,}/.test(local)) return { error: fakeMsg };
  if (isSequentialAlnum(local.replace(/[^a-z0-9]/g, ''))) return { error: fakeMsg };
  if (FAKE_LOCAL.test(local)) return { error: fakeMsg };

  const blocked = new Set([...DEFAULT_BLOCKED_DOMAINS, ...extraBlocked]);
  for (const b of blocked) {
    if (domain === b || domain.endsWith('.' + b)) return { error: 'Bu alan adındaki e-posta adresleri kabul edilmiyor, lütfen kurumsal veya kişisel gerçek adresinizi yazın' };
  }
  const label = domain.split('.')[0];
  if (/^(.)\1+$/.test(label) && label.length >= 3) return { error: fakeMsg };

  const suspect = [];
  if (/^\d+$/.test(local.replace(/[._-]/g, ''))) suspect.push('e-posta adı yalnızca rakam');
  if (/^\d+$/.test(label)) suspect.push('alan adı yalnızca rakam');
  return { email, suspect };
}

const JUNK_WORD = /^(test|deneme|asd|asdf|qwe|qwerty|xxx|abc|fake|sahte|yok|var|a+|x+|-+|\.+)$/i;

// Ad, firma, görev gibi serbest metin. Dönüş: { error } | { value, suspect[] }
export function checkText(raw, label, min, max, opts = {}) {
  const value = String(raw ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (value.length < min || value.length > max) return { error: `${label} ${min}-${max} karakter olmalı` };
  if (!/\p{L}/u.test(value)) return { error: `${label} geçerli görünmüyor` };
  if (/(.)\1{3,}/u.test(value.toLowerCase())) return { error: `${label} geçerli görünmüyor` };
  const suspect = [];
  if (JUNK_WORD.test(value)) suspect.push(`${label.toLowerCase()} anlamsız görünüyor`);
  if (opts.fullName && !/\s/.test(value)) suspect.push('ad tek kelime');
  return { value, suspect };
}
