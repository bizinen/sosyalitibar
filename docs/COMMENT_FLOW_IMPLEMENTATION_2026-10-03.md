# Açık yorum akışı işlerinin uygulanması — 3 Ekim 2026

Önceki `COMMENT_FLOW_AUDIT_2026-10-03.md` inceleme anının kaydıdır. Bu belge sonraki değişiklikleri ve kanıt sınırını belirtir.

## 1. Sınırlı tarama ve devam kaydı

`src/lib/sync.ts`, `src/lib/config.ts`, `.env.example`.

- Gönderi, yorum, yanıt ve bilinen yorum kontrolü mevcut şifreli continuation içinde ayrı adımlardır.
- Varsayılan dilim bütçesi 120 saniye ve 500 adımdır. Yeni ağ işi bütçe bittikten sonra başlamaz; başlamış Graph isteği kendi timeout/retry sınırına kadar sürebilir.
- Sayfa geçişi, alt iş oluşturma, kaynak kontrolü ve kaynak hatası sonrasında checkpoint yazılır. Sadece kayıt işleyen adımlarda en fazla 25 adımlık tekrar olabilir. Checkpoint DB yazısı connection lease/token/status sahipliğine bağlıdır.
- Retry gecikmesi 30 saniyeden başlayarak artar; varsayılan 5 başarısız denemeden sonra iş continuation içinde ayrı `deadTasks` olarak kalır. Başka yorumlar ilerler. DB/checkpoint hatası kaynak hatası gibi dead-letter yapılmaz.
- `syncPending`, `syncDead`, `syncRetryAt` operatör durumu ve due selection için saklanır. Taraması bütçe nedeniyle devam eden hesap tamamlanmış sayılmaz.
- Hesap işlemindeki “Taramayı yeniden dene” düğmesi o hesaptaki tükenmiş işleri yeniden açar. Token revoke ve pause korumaları sürer.

## 2. Kaçırılmış silme ve erişilemeyen kaynak

`src/lib/sync.ts`, `src/lib/ingest.ts`, `src/lib/analysis-state.ts`, `src/lib/alerts.ts`, yorum kartı.

- En az bir saattir kaynakta kontrol edilmemiş eski yorumlar, hesap başına en fazla 25 yeni kontrol işiyle taramaya eklenir. Her beş adımda kaynak kontrolüne öncelik verilir; normal tarama ilerlerken de bu kontroller çalışır.
- `100/33` transient olmayan kaynak erişim hatası yorumu `sourceUnavailableAt` ile işaretler. Bu durum kesin silinme iddiası değildir. Diğer sağlayıcı/ağ hataları retry/dead-letter yoluna girer.
- Eski analiz geçersizleşir, gönderimi başlamamış alarmlar iptal olur; devam eden eski analiz revision/lock koruması nedeniyle sonucu yazamaz. Erişilemeyen üst yorum LLM bağlamına taşınmaz.
- Kaynak yeniden okunursa unavailable durumu kaldırılır ve analiz tekrar açılır. Eski bir okuma daha yeni webhook verisini geçersizleştiremez.
- Açık silme webhooku mevcut `deletedAt` tombstone akışındadır. Belirsiz erişim cevabından tombstone üretilmez.
- Kontroller anlık veya bütün tarihsel kayıtlar için tek turda değildir; süre/kayıt bütçesi içinde ilerler. Başlamış alarmın alıcıya ulaşmış olması geriye alınamaz.

## 3. İlk abonelik yarışı

`src/app/api/meta/callback/route.ts`.

Facebook ve bağlı Instagram kayıtları durable yazıldıktan sonra Facebook aboneliği istenir. Abonelik sonucunun geç yazımı aynı token ve aktif/degraded statüyle sınırlandırılır; pause/revoke ve eşzamanlı sync hatası ezilmez. Instagram App/Webhooks alan aboneliği Meta Dashboard ayarı olmaya devam eder.

Önceden açık Instagram app aboneliği gibi daha erken bildirimler için durable worker, henüz kaydı olmayan hesapların olaylarını ilk alınma zamanından itibaren en fazla 5 dakika boyunca 15 saniye arayla erteler. Bu bekleme kaynak retry bütçesini tüketmez. Beş dakikadan sonra hâlâ izlenmeyen hesap yok sayılır; disabled hesap beklemeye sokulmaz. Bölünmüş olaylarda orijinal `receivedAt` korunur.

## 4. Worker heartbeat

`scripts/scheduler.mjs`, `/api/jobs/heartbeat`, `src/lib/worker-health.ts`, metrics ve operations ekranı, `ops/prometheus-alerts.yml`.

Her scheduler görevi HTTP denemesinden sonra authenticated heartbeat gönderir. Son deneme, son başarılı HTTP çalışma ve beklenen gecikme DB'dedir. Kuyruk boş olsa da hiç gelmeyen/bayat heartbeat alarm üretir; başarısız HTTP görevi ayrıca görünür. Geçerlilik aralığı görev periyodu + HTTP timeout + 60 saniyedir. Bu sinyal her yorumun veya alarmın başarılı işlendiği anlamına gelmez; kuyruk ve teslimat durumları ayrı izlenir.

## 5. Panelden alarm ayarları

`/settings/alerts`, `/api/settings/alerts`, `src/lib/alert-settings.ts`, alert worker ve manuel kuyruk çalıştırma, token rotation.

Teslimat aç/kapat, HTTPS alıcı adresi, HMAC anahtarı, 0–100 eşik ve tehdit kuralı panelden kaydedilir. Secret AES-256-GCM ile saklanır; form mevcut secretı almaz. Eşzamanlı ayar kaydı revision ile korunur. Ayar yazımı ve alarm claim işlemleri aynı advisory lock üzerinde exclusive/shared kullanır; processing alarm varken ayar değişmez. Yeni alıcı yeni anahtar ister. Ayarlar kaydedilmemişse env davranışı sürer.

Alıcı biliniyorsa enqueue sırasında, ilk kurulumun bekleyen kayıtlarında ise ilk dispatch sırasında alıcı URL hashini alarma bağlar. Eski alıcıya bağlı alarm farklı alıcıya sessizce taşınmaz; böyle bir kayıt dead durumunda operatöre gösterilir. İlk panel kaydında eski pending/retry/dead kayıtlarının boş alıcı bağları önceki endpoint'e bağlanır; eski crash/requeue geçmişi kaybolmuş kayıtlar da bu korumaya girer. Kural değişiklikleri yeni analizlere uygulanır; geçmiş kararlar topluca değiştirilmez. E-posta/Telegram alıcısı kurulmuş veya gerçek teslimat yapılmış değildir.

## Migration ve inceleme durumu

- `0016_source_availability.sql`, `0017_worker_heartbeats.sql`, `0018_alert_settings.sql`: `node --env-file=.env.local scripts/migrate.mjs` ile 127.0.0.1:5432 / sosyal_itibar üzerinde uygulandı; komut üç migration için `applied` döndürdü.
- Mevcut kesinti/continuation testi yeni toplam adım bütçesine uyarlandı; unavailable → analiz/alarm geçersizleştirme → geri kazanım → eski okuma reddi, erken hesap bildiriminin sınırlı ertelenmesi ve hatalı yanıt getirme işinin sağlıklı yorumları bloke etmemesi senaryoları eklendi. Testler çalıştırılmadı.
- DB smoke beklentilerine yeni tablolar/kolon/index eklendi; smoke çalıştırılmadı.
- Kod, checkpoint sırası, child task retry, probe starvation, source revision, subscriber update, alert setting/claim kilit sırası ve receiver değişimi yönünden yeniden okundu; bulunan yan etkiler düzeltildi.
- Test/lint/typecheck/build/browser/Meta/LLM/alarm alıcısı doğrulaması kullanıcı isteği doğrultusunda yapılmadı. “Hatasız”, “gerçek E2E tamamlandı” veya “production kabulü geçti” iddiası yoktur.
- Şema değişiklikleri eklemelidir. Kod rollback'inde yeni tabloları/kolonları silmek gerekli değildir; kaynak ve teslimat geçmişi korunmalıdır. Worker scheduler değişikliği mevcut çalışan proses kendiliğinden yeniden başlamaz; bu çalışmada restart/deploy yapılmadı.

## Sonraki kod incelemesi

- Alarm teslimatını kapatma yarışı düzeltildi: job HTTP handler ayarı okuduktan sonra panelden teslimat kapatılırsa eski akış pending/retry kayıtları processing yapıp configuration_missing nedeniyle dead yapabiliyordu. `claimAlertJobs` şimdi ayar değişikliğiyle ortak advisory lock içinde güncel teslimat yapılandırmasını okur; teslimat kapalı/eksikse kayıt sahiplenmez. Sahiplenme önce tamamlanırsa mevcut settings endpoint'i processing kaydı nedeniyle ayar değişikliğini reddeder. Her iki işlem sırası kaynak üzerinden tekrar okundu.
- Bu davranış için pending alarmın kapalıyken korunmasını ve açılınca sahiplenilebilmesini kapsayan integration test eklendi. Scheduler hata testinde altı ek heartbeat isteği ve ilk hata sonrası 10 saniyelik backoff beklentileri güncellendi. Testler çalıştırılmadı; başarılı oldukları iddia edilmiyor.
- Açık işlevsel eksik: connection DELETE OAuth sahibi kaydını silmiyor; Meta settings PUT App ID değişiminde hem connection hem owner varlığını engelliyor. Panelde owner yetkilendirmesini kaldırma işlemi yok. Bu nedenle bütün kaynaklar kaldırıldıktan sonra bile farklı Meta App'e panelden geçiş tamamlanamıyor. Aynı App ile mevcut yorum akışından ayrı olan bu yönetim eksikliği bu patch'te giderilmedi; kayıt/token silme davranışı eklenmedi.
- Webhook ACK/worker, reconciliation continuation/retry, analiz context/revision, alarm dispatch/ayar kilitleri, bağlantı sağlık/pause ve OAuth kaynakları incelendi. Bu sınırlı statik incelemede başka kesinleşmiş yeni çalışma zamanı hatası kaydedilmedi; bütün kodun kusursuzluğu veya çalışma başarısı kanıtlanmış değildir. Yeni migration, test/lint/typecheck/build, canlı sağlayıcı çağrısı veya restart/deploy yapılmadı.
