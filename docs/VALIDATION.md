## Panel kullanım düzeltmeleri — 2026-10-01

Önceki tasarımın tarayıcı incelemesindeki bulgular düzeltildi: yorum ekranı sıkıştırıldı, mobil menü açılır hale getirildi, kurulum bağlantısı details bölümünü açar, geçersiz Meta App ID "Ayarlanmadı" gösterilir ve başlıklar kısaltıldı. Chrome'da masaüstü ve 390 px mobil görünüm incelendi; mobil yorum alanı yaklaşık 1325 px'den 644 px'e taşındı. Menü açma/kapatma ve kurulum ayrıntılarını açma tarayıcıda görüldü.

AI sağlayıcı/model/anahtar kayıt formu ve admin + same-origin korumalı API eklendi. 0013_llm_settings.sql yerel DB'ye uygulandı. Anahtar AES-256-GCM ile saklanır; API/istemciye geri dönmez; audit kaydı anahtar içermez. Revision ile eş zamanlı düzenleme korunur, sağlayıcı origin değişiminde yeni anahtar gerekir. Worker, manuel analiz ve ekranlar aynı DB yapılandırmasını okur. Uzun yorumun bölümleri aynı ayar snapshot'ını kullanır. Mevcut anahtar rotasyonu LLM anahtarını da kapsar. Ayarlar yeni analizlere uygulanır; geçmiş kararlar yeniden analiz edilmez. Sunucu env ayarları DB kaydı bulunmadığında kullanılır.

Anahtarsız kayıt tarayıcı üzerinden denendi ve "API anahtarı gerekli" yanıtı görüldü; deneme modeli kaydedilmedi. Gerçek anahtarla başarılı kayıt/LLM çağrısı, dolu hesap/yorum ekranları, test, lint, typecheck ve build doğrulanmadı. Önceki salt okunur AI ekranı ve "migration eklenmedi" ifadeleri tarihsel tasarım turuna aittir.

## Açık renkli panel tasarımı — 2026-10-01 — çalışma zamanında doğrulanmadı

Menü/header, yorum–AI değerlendirme kartları, hesap arama ve platform filtresi, hesap sahipliği, alarm teslimatları, sistem durumu, kişi/kurum formları ve giriş ekranı açık renklerle düzenlendi. Mevcut API işlemleri, kimlik doğrulama, cursor sayfalaması ve moderasyon kapsamı korundu. Yeni AI ayarları sayfası mevcut sunucu yapılandırmasını salt okunur gösterir; panelden model/anahtar kaydetme eklenmedi. Hesap kartına yalnız gerekli alanlar aktarılır; şifreli tokenlar client props içine alınmaz. Mobil düzen ve reduced-motion CSS kuralları eklendi.

Kullanıcının talebi doğrultusunda test, lint, typecheck, build, tarayıcı/görsel veya canlı entegrasyon doğrulaması çalıştırılmadı. Kaynak kod üzerinden render, prop ve işlem bağlantıları yeniden okundu; bu inceleme çalışma zamanı veya production kabul kanıtı değildir. Bu tasarım için migration veya yeni bağımlılık eklenmedi.

## Yorum akışı geliştirmesi — 2026-10-01 — doğrulanmadı

Yerel migration durumu — 2026-10-01: kullanıcı talebiyle sosyal_itibar DB'sinde eksik 0009–0012 uygulandı. Önce custom-format pg_dump backup alındı ve arşiv listesi okunabildi. Sonrasında 12/12 migration kaydı ve dosya checksum'ları, source_read_version kolonu, source read sequence, parent index ve eski prompt analizi kalmadığı DB'den kontrol edildi. Eksik migration/checksum farkı yok. Bu yalnız migration/DB şeması kontrolüdür; test, lint, typecheck, build, canlı Meta/LLM veya backup restore testi çalıştırılmadı. Aşağıdaki 'uygulanmadı' ifadeleri önceki geliştirme turunun tarihsel kayıtlarıdır.

Son patch: çoklu webhook değişiklikleri bağımsız durable işlere bölündü; limitin ötesindeki posts/comments/replies şifreli syncState devamıyla işlenir. Graph okuması öncesi DB sequence watermark eski okumaların yeni kayıt üzerine yazılmasını engeller. Prompt v2.5 uzun yorumun bütün bölümlerini işler; başarısız bölümde aggregate persist edilmez. Metinsiz içerik other/needs_review=true olur. Health ve sync hata alanları atomik JSON güncellemeleriyle ayrı korunur. Continuation key rotation'a dahil; embedded IG reply paging debug raw'a yazılmaz.

0011_source_read_order.sql ve 0012_complete_comment_analysis.sql hazırlandı, uygulanmadı. 0009–0012 sırayla uygulanmadan yeni kod deployment'ı yapılmamalı: source_read_version kolonu ve sequence yeni schema/ingestion için zorunlu. 0012 eski kararları yeniden analiz kuyruğuna alır; geri dönüş eski analiz/review kayıtları için backup gerektirir. Smoke beklentisi 12 migration ve yeni source watermark kolonunu içerir. Regresyon testleri yazıldı ancak çalıştırılmadı. Test, lint, typecheck, build, migration veya canlı/provider doğrulaması yapılmadı.

Patch sonrası kaynak incelemesinde retention → sync bağlam silme/geri yazma regresyonu bulundu. Raw cleanup artık yalnız source_post.id/text analiz bağlamını korur ve zaten minimal bağlama indirgenmiş kaydı tekrar seçmez. Bu, raw debug retention politikasının açık bir istisnasıdır. Stale sync lease due interval beklemeden reclaim edilebilir. Scheduler ardışık endpoint hatalarında bounded backoff kullanır. Mapping PUT targetIds alanı zorunludur; {} artık eşlemeleri temizlemez. İlgili kod ve caller'lar tekrar okundu; çalışma zamanı doğrulaması yapılmadı.

Kendi çok dilli hesapları için yeniden inceleme: analiz + alarm kapsamı korundu; yorum gizleme/silme eklenmedi. Prompt v2.4 çok dilli semantik, özgün dilde claim ve Türkçe operatör özeti kullanır. Tek karakterli anlamlı metin LLM'e gider. Kesilmiş veya eksik kaynak/post/parent bağlamı zorunlu insan incelemesi olarak işaretlenir; panel needsReview filtresi eklendi. Reconciliation paylaşım metnini mevcut raw kaydında source_post olarak saklar; sonraki webhook bu bağlamı korur, değişmesi revision/re-analysis tetikler. Raw retention sonrası kaybolan bağlam tam veri gibi sunulmaz.

Scheduled reconciliation hesap başına due filtresi ve aktif gruplar arasında kısa polling kullanır; kaynak sayısı her grup için ayrı 15 dakika beklemeye zorlanmaz. Eski paylaşım sırf yaşı nedeniyle atlanmaz. Bounded tarama sınırına ulaşınca coverageLimited, yaş penceresi dışındaki paylaşım sayısı outsideLookbackParents döner. Manuel sync yalnız işlediği grubu ve bu sınırları gösterir. App/worker RECONCILE_INTERVAL_MS ayarı ortak olmalıdır.

Alarm URL'si eksikken kritik karar artık atılmaz; outbox'a kaydedilir. Delivery job yapılandırma yokken claim yapmaz; manuel queue işlemi alertBlocked döndürür. Alarm worker claim sayısı concurrency ile sınırlandırılır; early cancellation/configuration sonuçları da sahiplik CAS sonucunu dikkate alır. LLM Retry-After beklemeleri scheduler HTTP timeout bütçesine eklendi. Bozuk scrypt hash'in sıfır byte karşılaştırmayla parola kabul etme yolu kapatıldı.

0010_multilingual_analysis_context.sql eski prompt analizlerini yeniden kuyruğa alır ve kabul edilmemiş eski alarm kararlarını iptal eder. Migration hazırlanmıştır, uygulanmamıştır. Backup ve durdurulmuş worker ile 0009 ardından uygulanmalıdır. Eski analiz/review kararlarını geri getirmek backup gerektirir. Yeni kolon eklenmedi. Smoke migration beklentisi 10'a çıkarıldı; hiçbir doğrulama çalıştırılmadı.

Kullanıcı talebiyle bu kod geliştirme turunda test, lint, typecheck, build, migration veya canlı entegrasyon doğrulaması çalıştırılmadı. Aşağıdaki önceki sonuçlar yeni değişikliklerin doğrulandığı anlamına gelmez.

- Yorum kaydı oluşmadan gelen silme olayı tombstone olarak saklanır; geç ingestion bu kaydı yeniden analize açmaz.
- Webhook lease sahipliği, yorum yazma/silme transaction'ında kilitlenir; uzun payload işlerken her değişiklikte lease yenilenir. Claim sayısı concurrency ile sınırlandırılır.
- OAuth denial da one-time state tüketir. Kullanıcı tokenı app/user kimliğiyle eşleşmelidir; Page health veya subscription başarısızlığı active olarak gösterilmez.
- OAuth yeniden bağlantısında hesap adı, Instagram kullanıcı adı veya parent Page değişirse connection güncellemesiyle aynı context-kilitli transaction içinde bağlı yorumların eski analizleri geçersiz kılınır. Yalnız token yenilemesi yeniden analiz başlatmaz.
- Meta response body 4 MiB ile sınırlanır ve 20 saniyelik istek timeout'u body okumasını da kapsar. Redirect takibi kapalıdır; pagination URL'lerinde userinfo ve farklı port reddedilir.
- Health boş scope sonucunu eski izinlerle doldurmaz; expiry, app kimliği ve Facebook subscription eksikliği durum kararına katılır. Superseded sonuçlar başarılı güncelleme gibi döndürülmez.
- Eksik Meta yapılandırması OAuth'u durdurur; eksik LLM yapılandırması analysis claim'i durdurup yorumları kuyrukta korur. Panel kısmi başarısızlıkları ve yapılandırma eksikliğini gösterir.

Facebook webhook aboneliğini yeniden kurmak için admin + same-origin korumalı connection subscribe endpointi ve panel işlemi eklendi. Disabled/revoked kaynaklarda işlem reddedilir; token/izin sağlığı değerlendirilir, abonelik sonucu eski tokenı ezmeden koşullu kaydedilir ve ardından sağlık durumu yenilenir. Operatörün durdurulmuş bağlantıyı açması, sağlık yenilenene kadar degraded olarak kaydedilir.

Reconciliation yorum yazmaları connection lease/status koşulunu kısa transaction içinde paylaşılmış kilitle korur; item → connection kilit sırası korunur. Token rotation CAS başarısızlığında eski worker durur. Başarılı sync token/subscription sağlık durumunu active yapmaz ve sağlık hata mesajını silmez; yalnız kendi sync hata mesajını temizler. Completion lease kaybını başarı gibi döndürmez. Liste ve reply pagination döngülerinde tekrar eden URL ve ilerlememe sınırı eklendi; bozuk liste yanıtı hata olarak ele alınır.

Meta/LLM bounded body okuması ortak HTTP body yardımcı fonksiyonunu kullanır; LLM response envelope ve usage metadata sınırlandırılır, kesilmiş finish_reason tamamlanmış analiz sayılmaz. Provider redirect takibi kapalıdır. LLM ve alarm retry davranışı Retry-After saniye/tarih değerini sınırlandırarak dikkate alır; alarm backoff'una jitter eklenmiştir. Alarm completion/failure update'i lock sahipliği kaybedilmişse başarı/retry diye raporlanmaz. Kuyruk ve provider hata mesajları DB query parametreleri veya bilinen environment secret'larını yaymadan saklanır; logger nested secret alanlarını da filtreler.

Yanıt analizine üst yorum metni bounded ve untrusted bağlam olarak eklendi (prompt v2.3). Parent insert/edit/delete, doğrudan bağlı yanıtların analysis revision'ını artırıp eski kararlarını ve dispatch öncesi alarmlarını geçersiz kılar. Item type/parent ilişkisi değişikliği de yeniden analiz sebebidir. Kısa ingestion transaction'ı context write lock kullanır; LLM ve provider HTTP çağrıları bu lock dışında kalır. Self-parent ilişkisi reddedilir.

Facebook reconciliation, stream listesindeki kaydın parent.id değerini korur; üst yoruma bağlı kayıtları reply olarak yazar. Reply listesindeki açık parent.id de korunur. Böylece stream'de görülen bir yanıtın ilişkisi post'a taşınıp üst yorum bağlamı kaybedilmez. Bu değişiklik doğrulanmadı.

Facebook/Instagram webhook ayrıntısında root/parent kimliği eksik olduğunda mevcut item type değiştirilmez; bağlamı bilinmeyen güncelleme önceden bilinen reply kaydını comment'e düşürmez. Yeni kayıtlar mevcut comment varsayılanını kullanır. Bu değişiklik doğrulanmadı.

Webhook detail kimliği istenen yorum kimliğiyle eşleşmeden ingestion yapılmaz. Ortak ingestion girişinde boş/geçersiz externalId ve string olmayan metin transaction başlamadan reddedilir; bozuk provider yanıtları kayıt/analiz üretmek yerine mevcut kuyruk hata akışına gider. Bu değişiklik doğrulanmadı.

Desteklenen webhook object'lerinde bozuk entry/changes yapısı, yorum value nesnesi veya yorum kimliği sessizce processed/ignored sayılmaz; worker retry/dead-letter'a yönlendirir. Yorum dışı feed alanları ve changes içermeyen mesajlaşma entry'leri mevcut kapsam dışında kalır. HTTP durable ACK akışı değişmez. Bu değişiklik doğrulanmadı.

Facebook/Instagram tek yorum detail yanıtları Zod ile çalışma zamanında parse edilir: kimlik, metin, author, tarih, parent/media ve like_count alan tipleri değerlendirilir. Bilinmeyen üst alanlar raw kayıt için korunur; eksik opsiyonel alanlar kabul edilir. Bozuk yapılar mevcut retry/dead-letter akışına gider. Bu değişiklik doğrulanmadı.

Reconciliation listelerinin kayıt kimliği, metin, author, tarih, parent ve paging.next tipleri ortak Zod şemasıyla değerlendirilir. İlk sayfa, devam sayfaları ve embedded Instagram reply listeleri aynı korumayı kullanır; orijinal raw kayıtlar değiştirilmez. Bozuk liste sayfası başarılı sync olarak işaretlenmez. Bu değişiklik doğrulanmadı.

Webhook yorum yazma/silme transaction'ı connection token/status sahipliğini paylaşılmış kilitle yeniden değerlendirir. Provider isteği sırasında pause, disconnect veya token değişikliği olursa eski sonuç commit edilmez. Revoked kaynağın silme olayları kabul edilmeye devam eder; disabled kaynak korunur. Silmede de item → connection kilit sırası korunur. Bu değişiklik doğrulanmadı.

0009_parent_analysis_context.sql yeni parent lookup index'ini ve geçmiş reply kayıtlarının yeniden analizini hazırlar. Migration uygulanmadı. Yayında worker'ları durdurup backup aldıktan sonra uygulanmalıdır; eski reply analizlerini geri getirmek için backup gerekir. Smoke script yeni migration/index gereksinimine göre güncellendi ama çalıştırılmadı.

Gerçek Meta ve LLM erişim bilgileri ve uçtan uca kabul çalışması hâlâ açık işlerdir. Bu bölümdeki tüm yeni kod değişiklikleri doğrulanmamıştır; production-ready doğrulaması iddia edilmez.

Manuel review PATCH artık analysisRevision ve expectedReviewStatus gerektirir; eski ekran revizyonu veya başka operatörün güncellemesi 409 döndürür. Panel kaydı yenileyip çatışmayı gösterir. Yorum/analiz bağlamı değişince review_status new olarak sıfırlanır; audit önceki durumu ve kararın revizyonunu içerir. Eski API istemcileri iki yeni alanı göndermelidir. Şema migration'ı gerekmez; değişiklik doğrulanmadı.

Analysis dead-letter requeue aynı context write lock sırasını kullanır, silinmiş yorumları tekrar analize almaz ve review durumunu new yapar. Analysis/webhook/alert requeue endpointleri geçersiz UUID'yi DB sorgusu öncesinde 400 ile reddeder. Bu değişiklikler doğrulanmadı.

Analysis hata/silinmiş kayıt completion yolları processing + lock + revision koşuluyla günceller ve RETURNING sonucu boşsa lost_lock raporlar. Webhook hata yolu da processing + lock sahipliği ve RETURNING ile korunur. Sahipliği kaybeden worker yeni işin durumunu retry/dead diye raporlamaz veya ilgili hata logunu üretmez. Bu değişiklikler doğrulanmadı.

## Reliability fixes — 2026-10-01

Önceki rapor aşağıda tarihsel kayıt olarak korunmuştur. Bu düzeltme turunda gerçek npm kurulumu/lockfile, lint, typecheck, 82 test (22 izole PostgreSQL entegrasyon testi dahil), secretsiz Next production build, fresh DB migration/rerun/smoke ve Docker image build başarılıdır. PostgreSQL 17 test veritabanının dump/restore denemesinde sekiz migration geri yüklenmiştir. Asıl klasörde npm ci, test, lint, typecheck ve production build yeniden başarılıdır. Docker app health, admin login, beş authenticated sayfa render, metrics scrape ve worker smoke başarılıdır.

- Analysis revision + lock ownership: geç gelen LLM sonucu, yorum/hedef/eşleme değişikliği sonrası analysis veya alarm yazamaz. Analysis commit ve outbox enqueue aynı kısa DB transaction içindedir; provider çağrısı transaction dışındadır.
- Alarm dispatch kabulü source → outbox row lock sırasıyla atomik kaydedilir. Kabul öncesi eski karar iptal edilir. Kabul edilmiş HTTP gönderimi geri alınamaz; sonucu eski revision ile audit kaydında tutulur. Crash-after-send retry için receiver idempotency gereklidir.
- Analysis heartbeat ve concurrency kadar claim, bekleyen işin lease süresini tüketmesini önler. Reconciliation pause/revoked durumunu korur; reply fetch hatası başarı sayılmaz.
- Target create/edit/delete, mapping ve disconnect eski analizleri geçersiz kılar; disconnect geçmişi silmez.
- Metrics SQL, streaming webhook body limiti, bağımsız scheduler döngüleri, canonical LLM contract ve runtime provider hata sanitization düzeltildi.
- Hedef düzenleme, görünür review hataları, kaynak/hedef/tarih/analiz filtreleri, üst yorum detayları ve kayıpsız mikro-saniye cursor pagination eklendi.
- TRUST_PROXY varsayılan kapalıdır. Etkinleştirme için app yalnız güvenilir reverse proxy üzerinden erişilebilir olmalı ve proxy IP header'larını overwrite etmelidir.
- Maintenance cleanup tablo başına en fazla 1000 kayıt; batchMayHaveMore=true ise tekrar çalıştırılır. Kilitli kayıtlar sonraki çalışmaya kalabilir; false global boşluk kanıtı değildir.
- Token rotation owner ve disabled/revoked bağlantılar dahil tablo başına 100 kayıt işler; previous key ancak tokenRotation.remaining=0 ve failed=0 doğrulandıktan sonra kaldırılır.

Deploy: 0007_analysis_revision.sql geçmiş analysis kararlarını silip yeniden kuyruğa alır ve gönderilmemiş eski alarmları iptal eder; 0008_alert_dispatch_boundary.sql dispatch kabul zamanını ekler. Önce backup alın, worker'ları durdurun, migration ve app/worker sürümünü birlikte yayınlayın. Geri dönüş eski analizleri geri getirmez; gerekiyorsa backup restore gerekir. Bu migration'lar yalnız izole DB'de uygulandı.

Açık kabul kapıları: gerçek Meta OAuth/FB/IG/edit/delete/reconciliation, gerçek LLM kalite/prompt injection değerlendirmesi, canlı alarm receiver, TLS/reverse proxy ve browser desktop/mobile E2E. Bunlar tamamlanmadan production-ready verified etiketi verilmez. Yeni Instagram Login/mention/RBAC ürün kapsamları bu hata düzeltmelerine dahil değildir.

İlk asıl-klasör testinde queue age testinin tam 60 saniye beklentisi 59.97 saniyelik DB/client saat farkıyla başarısız oldu; sayısal toleransla düzeltilen tekrar koşusu geçti.

Git: sağlanan asıl klasörde Git metadata/remote yoktu. Yerel supplied-source snapshot üzerinden fix/reliability-hardening branch'i hazırlandı; remote/integration branch bilinmeden fetch/push/MR yapılamaz.

---

# Validation Report — 2026-09-28

Sürüm: `0.4.0`

Bu dosya, bu teslimatta **gerçekten çalıştırılan** kontroller ile ortam nedeniyle çalıştırılamayan kontrolleri ayırır.

## Başarılı statik kontroller

- TypeScript parser ile `src/`, `tests/` ve root TS config dosyaları tarandı.
  - dosya: 71
  - parse error: 0
- Yerel import resolver taraması:
  - taranan TS/TSX/MJS dosya: 77
  - unresolved local import: 0
- `scripts/*.mjs` ve `eslint.config.mjs` için `node --check`: başarılı
- `.github/workflows/ci.yml`: YAML parse başarılı
- `docker-compose.yml`: YAML parse başarılı
- `package.json`: JSON geçerli
- `tsconfig.tsbuildinfo` teslimat ağacından kaldırıldı ve `.gitignore`a eklendi

## Bu sürümde eklenen doğrulama otomasyonu

CI artık PostgreSQL 17 service ile:

```bash
npm run db:migrate
npm run db:smoke
npm run lint
npm run typecheck
npm test
npm run build
```

çalışacak şekilde hazırlanmıştır.

`db:smoke` şu invariant'ları kontrol eder:

- beklenen production tabloları
- en az 6 migration'ın uygulanması
- `pgcrypto`
- `pg_trgm`
- kritik queue/search/sync-lease indexleri
- `connection_targets` unique indexi
- `social_items.connection_id` FK `ON DELETE SET NULL`

## Bu ortamda çalıştırılamayan kontroller

### Dependency install / lockfile

Komut:

```bash
npm install --package-lock-only --ignore-scripts --no-audit --no-fund
```

45 saniyelik timeout içinde npm registry yanıtı tamamlanmadı. Daha önceki install denemelerinde de aynı ortam kısıtı görüldü.

Bu nedenle bu teslimatta:

- `package-lock.json` oluşturulmadı,
- `npm ci` çalıştırılmadı,
- dependency-resolved TypeScript typecheck çalıştırılamadı,
- Vitest gerçek dependency setiyle çalıştırılamadı,
- Next production build çalıştırılamadı,
- Docker image build doğrulanamadı.

Lockfile/integrity değeri elle uydurulmamıştır.

### PostgreSQL runtime

Bu çalışma container'ında PostgreSQL/Docker servisi bulunmadığından migration + `db:smoke` burada runtime olarak çalıştırılamadı. CI bunun için gerçek Postgres 17 service açacak şekilde hazırlanmıştır.

### Meta E2E

Gerçek Meta App credentials/token/webhook fixture verilmediği için aşağıdakiler burada doğrulanmadı:

- Facebook Page comment webhook
- Instagram comment webhook
- edit/delete webhook
- token revoke/reauthorize
- App Review scope davranışı
- reconciliation gerçek Graph pagination

Bunlar `docs/CODEX_HANDOFF.md` P0 kabul testidir.

## İlk gerçek geliştirme ortamında zorunlu komutlar

```bash
rm -rf node_modules .next
npm install
npm run db:migrate
npm run db:smoke
npm run lint
npm run typecheck
npm test
npm run build
```

Tümü başarılı olduktan sonra `package-lock.json` commit edilmeli; CI ve Docker `npm install` fallback'inden çıkarılıp yalnız `npm ci` kullanmalıdır.
