-- ETKİNLİKTEN HEMEN ÖNCE, onayla çalıştırılacak. HENÜZ UYGULANMADI.
-- Test verisini siler (dilimler, stok ve ayarlar korunur). Önce 005 uygulanmış olmalı.
-- Not: eski sürümdeki "email için benzersiz indeks" kaldırıldı; aynı e-posta/telefon 3 kayda kadar serbesttir.

DELETE FROM events;
DELETE FROM spin_queue;
UPDATE settings SET v = '0' WHERE k = 'next_free';
DELETE FROM spins;
DELETE FROM participants;
DELETE FROM sqlite_sequence WHERE name IN ('events', 'spins', 'participants');
