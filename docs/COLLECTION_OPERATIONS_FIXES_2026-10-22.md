# Yorum toplama ve operasyon düzeltmeleri — 22 Ekim 2026

Review branch: `fix/collection-operations`; temel: `fix/production-audit-pr` (`a9713c6`). Önceki denetim PR'ı #1 açık olduğundan bu değişiklikler onun üzerine ayrı PR olarak hazırlanmıştır. Kullanıcının mevcut çalışma ağacındaki diğer değişiklikler korunmuştur.

## Davranış değişiklikleri

| Sorun | Uygulanan düzeltme |
| --- | --- |
| HTTP sunucusu açıkken worker'ın çalışmaması | Yerel `npm run dev`, Next ve scheduler'ı birlikte yönetir. Worker DB readiness bekler, kapanırsa sınırlı backoff ile yeniden başlar ve üst süreç kapanınca durur. Production app/worker ayrılığı korunur; Docker worker heartbeat healthcheck eklendi. |
| Anahtar düzelse de eski 401 işlerinin dead kalması | Operatör kontrollü, en fazla 100 kayıtlık kurtarma eklendi. Yalnız henüz incelenmemiş, erişilebilir 401 kayıtları seçilir. Revizyon, analiz/teslim edilmemiş alarm iptali ve audit aynı transaction içindedir. |
| Sağlayıcının A→B→A sayfa döngüsü | Şifreli checkpoint'te sayfa kimliği hash'leri tutulur. Döngü veya 10.000 sayfalık güvenlik sınırı açık hata üretir. Yanıt sayfalaması üst yorum ve kök sayfa bağlamına ayrılır; farklı sayfalarda tekrar gelen meşru yorumlar yanlışlıkla engellenmez. |
| Yalnız ilk 100 yüklenen yorumun değişiklik kontrolü | Tüm yüklenen yorumlar en fazla 1.000 kimlik içeren sıralı POST paketleriyle kontrol edilir. Kimlik sayısı, body boyutu, auth, Origin ve toplam istek süresi sınırlıdır; eski GET korunur. |
| Kaynak kartlarının kapsam ve güncelliği saklaması | Son tarama, devam eden/geciken/duraklatılan/engellenen durumlar ve Apify limit/bütçesi görünür. İçe aktarılmış dataset, tüm platform geçmişi olarak gösterilmez. |
| Mevcut Apify kaynağının limitlerinin düzenlenememesi | Revizyon kontrollü ayar güncellemesi eklendi. Süren/checkpoint'li iş değiştirilmez; pause ve geçmiş kayıtlar korunur. Güncelleme yeni ücretli Actor çalışması başlatmaz. |
| Video sayacının sıfır görünmesi | Correlated SQL alt sorgusunda dış tablo sütunları açıkça nitelendirildi; yorum ve yanıtlar doğru sayılır. |
| Runware'e sayısal model kimliği kaydedilebilmesi | AIR model kimliği biçimi kayıt öncesinde doğrulanır. Geçerli model seçimi bir allowlist ile kısıtlanmaz. |
| GPT-OSS 120B'nin HTTP 200 ile geçersiz JSON döndürmesi | Canlı sentetik denemelerde bu modelin Runware JSON modunda bozuk önek döndürdüğü tekrarlandı. Yalnız Runware `openai:gpt-oss@120b` için `response_format` gönderilmez. Uygulamanın JSON/Zod, tam kimlik ve etiket kontrolleri ile prompt injection koruması korunur; bozuk çıktı düzeltilerek kabul edilmez. |

## Doğrulama

- Windows: 23 test dosyasında **165 test geçti**, PostgreSQL entegrasyonları atlanmadı. Tip kontrolü ve lint geçti.
- Son uygulama koduyla Node 22 Alpine production Docker derlemesi geçti. Dependency kurulumu mevcut lockfile üzerinden `npm ci`; yeni dependency veya migration yok.
- İzole PostgreSQL 17 ve sentetik sağlayıcılarla ölçek kontrolü: YouTube 1.005 üst yorum + 101 yanıt; listede 12 sayfada 1.106 benzersiz kayıt; Meta checkpoint'leriyle 1.105 yorum; Apify dataset'inde 1.000 üst yorum + 205 yanıt. Eksik/tekrar listelenen kimlik yok. Bunlar canlı Meta kabulü değildir.
- Regresyonlar: checkpoint'ler arası döngü, farklı üst yorumlarda aynı token, kök sayfalar arasında tekrar eden üst yorum, gerçek server sayacı, 1.005 yüklenmiş yorumun poll paketleri, 100 kayıt kurtarma sınırı, audit başarısızlığında rollback, eşzamanlı kurtarma, pause/revizyon/busy koruması ve strict model çıktı reddi.
- Tarayıcı: kaynak kartı kapsam/güncellik metinleri, limit formu ve 100→200 yorum sayfalaması doğrulandı; bu kontrol sırasında insan inceleme kararları değiştirilmedi.

## Yerel canlı sonuç ve ücretli isteklerin anlamı

Yerel DB için kurtarma öncesi yedek alındı; testler ayrı DB üzerinde çalıştı. Yerel web/worker birlikte çalışıyor. 22 Ekim 12:34 TSI kontrolünde önceki **15 adet 401 dead kaydın tamamı complete** oldu; kalan bir dead kaydın kaynağı erişilemez durumda. Bu kayıt başarıya zorlanmadı. Yedi worker heartbeat'i güncel; alarm görevi alıcı yapılandırılmadığı için başarısız durumunu dürüstçe bildiriyor.

Kullanıcının son model seçimi `openai:gpt-oss@120b`, ayar revizyonu 10 korunmuştur. Gerçek ürün analiz koduyla sentetik üç yorum HTTP 200 ve üç geçerli etiket döndürdü (yaklaşık 1,55 sn, 906 token).

Yeni YouTube kaynağında 12:27 TSI tamamlanan tarama **2.259** yorum/yanıt kaydetti. Daha sonraki salt okunur sağlayıcı kontrolünde **2.304** erişilebilir benzersiz kimlik görüldü; önceki DB'den 45 fazlaydı. Bu zamansal fark tüm yorumların kalıcı olarak alındığı iddiası değildir. Sonraki otomatik taramada kayıt sayısı 12:39 TSI itibarıyla **2.307** oldu; yeni yorumlar mevcut kuyrukla işlendi. Mevcut resmi YouTube akışı, tamamlanan taramadan 10 dakika sonra yeniden çalışır; devam eden tarama 15 saniyelik checkpoint aralıklarıyla sürer. Anlık webhook garantisi yoktur.

12:37 TSI DB örneğinde GPT-OSS ile 2.201 analiz kaydı **117 ayrı başarılı batch** kimliğine bağlıydı; Nano ile 100 kayıt 5 batch'teydi. Politika paket başına 20 yorum, 24.000 karakter ve 3 saniye bekleme kullanıyor. İlk büyük aktarım bu nedenle yüzlerce yorum başına birden fazla ücretli istek üretir. Bozuk JSON döneminde uygulama geçersiz yanıtları reddedip sınırlı tekrarlar yaptı; bunlar ek istek oluşturdu. Runware HTTP başarısı, uygulama çıktı sözleşmesi başarısı değildir. Kalıcı kayıtlar yalnız sonuçlanan analizleri tuttuğu için bütün başarısız denemelerin veya faturalandırmanın kesin toplamı DB'den çıkarılamaz; Runware kullanım kaydı esas alınmalıdır. Bu çalışma model/batch/bütçe sınırlarını otomatik artırmadı.

## Kapsam sınırları ve deploy

- Apify tekrar taraması önceki Actor'ın tarihsel devamı değildir. Instagram üst yorum limiti ve ek yanıt davranışı [resmî input şemasına](https://apify.com/apify/instagram-comment-scraper/input-schema) bağlıdır. Kapsam ve bütçeyi artırmak bütün geçmişin alınmasını garanti etmez.
- Eski, değişmemiş yorumlar ingestion'da tekilleştirilir; yeni yorum, içerik/bağlam değişikliği veya açık yeniden analiz işlemi analiz kuyruğu oluşturabilir. Kaynak taraması ile ücretli analiz aynı işlem değildir.
- Meta ayarı/bağlantısı ve alarm alıcısı yok. Gerçek Meta OAuth/webhook/edit/delete/reconciliation/revoke, alarm HMAC/idempotency/retry alıcı kabulü ve yayın ortamında TLS/secret store doğrulaması açık. Bu PR production-ready veya deploy onayı değildir.
- Yeni migration yok; mevcut 24 migration gerekir. Önce #1, ardından bu PR sırası korunmalıdır. Production'da ayrı app ve worker servisleri kullanılır.
- Geri dönüşte worker'ı durdurun; yeni `seen` alanını taşıyan resmi sağlayıcı checkpoint'lerini bu sürümle tamamlamadan eski strict checkpoint okuyucusuna dönmeyin. Veri/analiz geçmişini silmeyin. Batch model uyumluluk düzeltmesini geri almak GPT-OSS JSON hatasını yeniden açabilir; aynı modelle kontrollü doğrulama gerekir.

Ayrıntılı ilk denetim yerel `OPERATIONS_COLLECTION_AUDIT_2026-10-22.md` dosyasında; operasyon adımları `OPERATIONS.md` içindedir. Anahtarlar, ham gerçek yorumlar, dump ve geçici tanı çıktıları review değişikliğine dahil edilmemiştir.
