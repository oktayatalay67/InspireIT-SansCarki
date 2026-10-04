-- Aşama 5 göçü: görev/ünvan, cihaz ve kişi sınırları, test kullanıcısı, şüpheli işareti.
-- BİR KEZ çalıştırılır (ALTER TABLE ADD COLUMN tekrar çalışmaz). Mevcut kayıtlara dokunmaz, yalnızca doldurur.

ALTER TABLE participants ADD COLUMN title TEXT;
ALTER TABLE participants ADD COLUMN email_norm TEXT;
ALTER TABLE participants ADD COLUMN device_id TEXT;
ALTER TABLE participants ADD COLUMN suspect TEXT;
ALTER TABLE participants ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0;

UPDATE participants SET email_norm = lower(trim(email)) WHERE email_norm IS NULL;

-- Aynı e-posta/telefonla 3 kayda izin verildiği için benzersizlik kuralları kalkıyor.
DROP INDEX IF EXISTS ux_participants_phone_norm;
DROP INDEX IF EXISTS ux_participants_email;

CREATE INDEX IF NOT EXISTS ix_participants_email_norm ON participants(email_norm);
CREATE INDEX IF NOT EXISTS ix_participants_phone_norm ON participants(phone_norm);
CREATE INDEX IF NOT EXISTS ix_participants_device ON participants(device_id);
