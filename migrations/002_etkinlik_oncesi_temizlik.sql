-- ETKİNLİKTEN HEMEN ÖNCE, onayla çalıştırılacak. HENÜZ UYGULANMADI.
-- Test verisini siler (dilimler ve stok korunur), sonra email için unique indeksi ekler.

DELETE FROM events;
DELETE FROM spin_queue;
UPDATE settings SET v = '0' WHERE k = 'next_free';
DELETE FROM spins;
DELETE FROM participants;
DELETE FROM sqlite_sequence WHERE name IN ('events', 'spins', 'participants');

CREATE UNIQUE INDEX IF NOT EXISTS ux_participants_email ON participants(email);
