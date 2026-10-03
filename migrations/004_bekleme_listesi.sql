-- Aşama 4: çark meşgulken oyuncuları sıraya alan bekleme listesi (eklemeli, güvenli)
CREATE TABLE IF NOT EXISTS spin_queue (
  participant_id INTEGER PRIMARY KEY,
  pressed_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL
);
