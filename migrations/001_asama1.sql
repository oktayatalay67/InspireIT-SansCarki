-- Aşama 1 göçü (CANLI VERİTABANINA UYGULANDI: 03.10.2026)
-- Yalnızca ekleme yapar, mevcut kayıtlara dokunmaz.
-- Not: email için unique indeks burada YOK; test kayıtlarında tekrar eden email var.
--      Test verisi silindikten sonra migrations/002 ile eklenecek.

ALTER TABLE participants ADD COLUMN phone_norm TEXT;
ALTER TABLE participants ADD COLUMN token TEXT;
ALTER TABLE participants ADD COLUMN spins_left INTEGER NOT NULL DEFAULT 0;
ALTER TABLE participants ADD COLUMN has_gift INTEGER NOT NULL DEFAULT 0;
ALTER TABLE participants ADD COLUMN terms_at INTEGER;
ALTER TABLE participants ADD COLUMN consent_at INTEGER;

CREATE UNIQUE INDEX IF NOT EXISTS ux_participants_phone_norm ON participants(phone_norm);
CREATE UNIQUE INDEX IF NOT EXISTS ux_participants_token ON participants(token);
CREATE INDEX IF NOT EXISTS ix_spins_participant ON spins(participant_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
