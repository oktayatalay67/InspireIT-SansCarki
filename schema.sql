CREATE TABLE IF NOT EXISTS slices (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  stock INTEGER NOT NULL DEFAULT 0,
  weight REAL NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS participants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  company TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  prize TEXT,
  prize_type TEXT,
  spin_count INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  participant_id INTEGER,
  slice_id TEXT,
  slice_name TEXT,
  slice_type TEXT,
  created_at INTEGER NOT NULL
);

INSERT OR IGNORE INTO slices (id, type, name, stock, weight, sort_order, active, created_at) VALUES
  ('s1',  'gift',  'Bluetooth Kulaklık',      2,   1.0, 1,  1, unixepoch()),
  ('s2',  'gift',  'Termos',                  3,   1.0, 2,  1, unixepoch()),
  ('s3',  'gift',  'Powerbank',               3,   1.0, 3,  1, unixepoch()),
  ('s4',  'gift',  'Notebook',                8,   1.0, 4,  1, unixepoch()),
  ('s5',  'gift',  'Kalem Seti',              6,   1.0, 5,  1, unixepoch()),
  ('s6',  'gift',  'Çanta',                   2,   1.0, 6,  1, unixepoch()),
  ('s7',  'lose',  'Üzgünüz, Kaybettiniz',    999, 1.6, 7,  1, unixepoch()),
  ('s8',  'lose',  'Bir Daha Dene',           999, 1.6, 8,  1, unixepoch()),
  ('s9',  'lose',  'Boş Çıktı 🙈',            999, 1.6, 9,  1, unixepoch()),
  ('s10', 'lose',  'Şanssız Gün ☁️',          999, 1.6, 10, 1, unixepoch()),
  ('s11', 'again', 'Tekrar Çevir 🔄',         999, 1.0, 11, 1, unixepoch()),
  ('s12', 'again', 'Bir Hak Daha! 🎟️',        999, 1.0, 12, 1, unixepoch()),
  ('s13', 'task',  'Şarkı Söyle → +1 Çevir',  999, 0.8, 13, 1, unixepoch()),
  ('s14', 'task',  'Dans Et → +1 Çevir',      999, 0.8, 14, 1, unixepoch()),
  ('s15', 'task',  'Selfie Çek → +1 Çevir',   999, 0.8, 15, 1, unixepoch()),
  ('s16', 'task',  'InspireIT’i Anlat → +1',  999, 0.8, 16, 1, unixepoch());