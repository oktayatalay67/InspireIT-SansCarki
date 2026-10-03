# InspireIT-SansCarki
Hediye dağıtmak için InspireIT İventlerinde kullanılacak Şans Çarkı (Cloudflare Worker + D1).

## Kurulum / yayın
1. Yönetici parolasını tanımla (kaynak koda yazılmaz):
   `npx wrangler secret put ADMIN_PASSWORD`
2. Yayınla: `npx wrangler deploy`
3. Yerel geliştirme: proje klasöründe `.dev.vars` dosyasına `ADMIN_PASSWORD=...` yaz, sonra `npx wrangler dev --local`.

## Veritabanı
- Sıfırdan kurulum: `schema.sql`
- Mevcut veritabanı: `migrations/` altındaki dosyalar sırayla (001 uygulandı; 002 etkinlikten hemen önce).

## Kurallar
- Sonucu yalnızca sunucu belirler; her kişi kayıtta gizli bir anahtar (token) alır.
- Kişi başına en fazla 1 hediye. "Tekrar çevir" ve "görev" dilimleri +1 hak verir.
- Son hediyede yarış olmaz: stok atomik düşer.
