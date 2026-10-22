# Worker güvenilirlik ve kapasite düzeltmeleri

Kapsam: worker incelemesindeki altı bulgu. Mevcut webhook → yorum → analiz → alarm ayrımı, kaynak revizyonu, lock sahipliği ve dispatch sınırı korunur.

## Davranış değişiklikleri

1. Heartbeat artık HTTP başarısının yanında yanıt içindeki iş hatalarını da değerlendirir. Video endpointi claimed/succeeded/failed sayıları döndürür. Kaynakların blocked durumu sistem durumu ekranında, kaynak sayısı/tarama gecikmesi/son tam tarama yaşı Prometheus'ta görünür. Tam tarama yaşı, son tamamlanmış tarama yoksa kaynağın yaşıdır; veri kapsamı garantisi değildir.
2. Bakımda tablo başına 1.000 kayıt sınırı kalır. Devamı varsa worker günlük aralığı beklemez: paketler normal poll aralığıyla devam eder, her on pakette 60 saniye ara verir. Döndürülemeyen anahtarlar tek başına hızlı sonsuz döngü oluşturmaz.
3. Toplu LLM analizinde Retry-After saniye ve HTTP-date olarak okunur; bekleme en fazla 24 saattir. Ağ hataları, 408/409/425/429/5xx ve 401/403/404 için sağlayıcı/model/anahtar parmak izine bağlı DB beklemesi bütün worker'larda korunur. Yapılandırma hatalarında en az beş dakika, diğerlerinde en az 30 saniye beklenir. Bu hatalar yorumun beş denemelik hakkını tüketmez. Geçersiz diğer HTTP istek hataları dead-letter olur; geçersiz model çıktısının mevcut sınırlı retry akışı kalır. Aynı gruptaki sonraki paketler sağlayıcı hatasından sonra yeni istek açmaz. Yedek ücretli modele otomatik geçiş eklenmez.
4. Başarılı dolu kuyruk paketleri 100 ms sonra devam eder; boş kuyruk normal poll aralığına döner. İşlem concurrency sınırları artmaz. İlerleme sağlamayan hatalarda mevcut sınırlı exponential backoff kullanılır.
5. Webhook, analiz ve alarm claim işlemleri seçim + SKIP LOCKED + durum/UUID lease güncellemesini tek SQL statement içinde yapar. Sıralama kolonlarıyla eşleşen üç kısmi indeks yalnız pending/retry kayıtlarını kapsar. Alarm ayarlarının shared kilidi korunur. Kuyruk uygunluk zamanında mevcut uygulama saati semantiği korunur.
6. Ingestion global context kilidini shared alır. Yorumun kendi kimliği exclusive, parent kimliği shared advisory lock ile korunur; anahtarlar hash sırasıyla alınır. Bağımsız yorumlar ve kardeş reply'lar ilerleyebilir. Parent düzenlemesi yeni child insert'inin commit'ini bekleyerek yeni child'ı da invalidation kapsamına alır. Hedef/mapping/silme gibi global context yazıcıları exclusive kalır.

## İzleme

Yeni metrikler: `sosyal_itibar_sources`, `sosyal_itibar_source_overdue_seconds`, `sosyal_itibar_source_scan_age_seconds`, `sosyal_itibar_analysis_provider_backoff_seconds`, `sosyal_itibar_analysis_provider_configuration_error`.

Sağlayıcı bekleme metriği yalnız seçili sağlayıcı parmak izine aittir. Model/anahtar değişikliği eski sağlayıcının beklemesini devralmaz. Ayarlar çözülemezse diğer kuyruk metrikleri sunulmaya devam eder ve configuration_error=1 olur. Anahtar, yorum metni ve sağlayıcı hata gövdesi metriklere eklenmez. Container healthcheck liveness kontrolüdür; kaynak/sağlayıcı arızaları Prometheus kuralları ve ilgili kuyruk/kaynak ekranlarıyla takip edilir.

## Dağıtım ve geri alma

- Önce `npm run db:migrate` ile `0029_analysis_provider_backoff.sql` ve `0030_worker_claim_indexes.sql` uygulanmalı; ardından app ve scheduler aynı sürümle yeniden başlatılmalı. Eski app örnekleri yeni bekleme tablosunu kullanmaz.
- İndeks migration'ı mevcut transaction runner'ı kullanır: CREATE INDEX sırasında yazma kilidi gerektirir. Büyük/canlı tablolarda bakım penceresi planlayın. Kilit bekleme sınırı 5 saniye, statement sınırı 120 saniyedir; aşılırsa migration transaction'ı geri alınır ve runner başarı kaydı yazmaz. Uzun bir kilidi zorlamak yerine yük/kilit nedeni giderildikten sonra migration tekrar çalıştırılmalıdır.
- Yeni tablo yalnız hash parmak izi, bekleme zamanı ve HTTP durumunu tutar; geçmiş yorum/analiz/alarm verisi taşınmaz veya silinmez. Migration transaction ve mevcut checksum runner ile uygulanır.
- Prometheus kuralları yeniden yüklenmeli. Kaynak etiketleri platform/provider/kind/status ile sınırlıdır; kaynak ID'si etiket olarak kullanılmaz.
- Geri almada app ve worker önceki sürüme döndürülebilir; ek tablo ve indeksleri bırakmak güvenlidir. Tabloyu düşürmek veya geçmiş verileri geri yüklemek gerekmez. Eski sürüm sağlayıcı cooldown'unu uygulamaz.

## Doğrulama

- Son tam Vitest paketi (`npm test -- --maxWorkers=1 --silent`): 26 dosya, 236 test başarılı; 89 PostgreSQL senaryosu dahil. Son scheduler düzenlemesi ayrıca 6 testle, parent kilit bekleyişinin test temizliği ayrıca ilgili PostgreSQL testiyle doğrulandı. İndeks migration'ı da son tam koşuya dahil.
- Lint ve typecheck başarılı.
- PostgreSQL 17: 30 migration uygulandı ve tekrar çalıştırıldı; smoke test 21 tablo, 17 kritik indeks ve mevcut veri sözleşmelerini doğruladı.
- Node 22 Linux deps aşamasında cache kullanılmadan temiz `npm ci`: 395 paket kuruldu. Next production build ve Docker runner image oluşturma başarılı.
- Production modunda, dış internet erişimi olmayan ayrı ağda app health ve worker'ın 7 görev heartbeat'i başarılı. Sentetik durable webhook işlendi; boş yorumun yerel insan incelemesi yolu tamamlandı. SIGTERM ile worker exit code 0, `worker.stopped` logu ve kuyruklarda 0 processing kayıt doğrulandı. Container scheduler dosyası çalışma alanıyla SHA-256 üzerinden eşleşti.
- Prometheus 3.5.0 `promtool check rules`: 11 kural başarılı.
- İndeks kontrolünde her kuyruk için 10.000 sentetik kayıt transaction içinde eklendi ve geri alındı. Analiz claim seçimi önce Seq Scan + Sort ile 10.002 kaydı tarıyordu (213 shared buffer hit, 28,977 ms execution); indeks sonrası Index Scan ile Sort olmadan 8 kayıt seçti (17 shared buffer hit, 0,186 ms). Webhook/alarm da kendi claim indeksini Sort olmadan kullandı. Bunlar tek sentetik, cache ve ortam koşullarına bağlı ölçümlerdir; production kapasitesi veya genel hızlanma garantisi değildir.

Ara koşulardan biri 231/236 ile bitti: timeout, sonraki test temizliğiyle kilit çakışması ve video fixture seçim hataları görüldü. PostgreSQL logu, timeout sonrası devam eden fixture INSERT'iyle sonraki TRUNCATE arasında deadlock gösterdi. Aynı beş senaryo ayrı koşuda, ardından tam paket tek worker ile başarılı oldu. Test süreleri ve işlevsel assertion'lar gevşetilmedi. Bu geçmiş, tüm ortamlarda performans garantisi olarak yorumlanmamalıdır.

Testler yalnız ayrı test veritabanlarında, canlı Meta/LLM/Apify istekleri mock edilerek veya dış erişimi kapatılmış ağda sentetik kayıtlarla çalıştırıldı. Gerçek Meta E2E, model doğruluğu veya production deploy bu çalışmada doğrulanmadı. Kullanıcının mevcut canlı/geliştirme veritabanına migration uygulanmadı.
