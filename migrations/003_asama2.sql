-- Aşama 2 göçü: ayarlar tablosu (etkinlik zamanı, mod, duraklatma, çevirme sırası).
-- Yalnızca ekleme yapar. Güvenli varsayılan: mode = closed (hediye verilmez) ta ki etkinlik ayarlanana kadar.

CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
INSERT OR IGNORE INTO settings (k, v) VALUES ('mode', 'closed');
INSERT OR IGNORE INTO settings (k, v) VALUES ('paused', '0');
INSERT OR IGNORE INTO settings (k, v) VALUES ('event_days', '1');
INSERT OR IGNORE INTO settings (k, v) VALUES ('event_hours', '8');
INSERT OR IGNORE INTO settings (k, v) VALUES ('next_free', '0');
