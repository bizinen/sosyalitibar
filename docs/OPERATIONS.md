# Production Operations Runbook

## Trusted proxy and login rate limits

`TRUST_PROXY=false` is the default: forwarded IP headers are ignored and requests share the `unknown` IP rate-limit bucket. Enable `TRUST_PROXY=true` only when the app is inaccessible except through your trusted reverse proxy. That proxy must overwrite (not append to client-supplied) `X-Forwarded-For` and `X-Real-IP` with the verified client IP. The app accepts only IP literals and uses the first forwarded address. Do not expose the app port directly when this flag is enabled.

## Süreçler

Production'da iki uygulama prosesi çalıştırın:

1. `app`: Next.js HTTP server
2. `worker`: `node scripts/scheduler.mjs`

Yerel geliştirmede `npm run dev` web sunucusunu ve worker'ı birlikte yönetir. Worker DB readiness sonrasında başlar; beklenmeyen kapanışında sınırlı backoff ile yeniden başlatılır. Web sunucusu veya üst süreç kapatılınca worker da kapatılır. Port için `npm run dev -- --port 3001` kullanılabilir. Mevcut ayrı bir HTTP sunucusuna bağlanmak için `npm run worker` hâlâ kullanılabilir; yönetilen başlangıçla aynı anda ikinci worker başlatmak gerekmez.

Production'da ayrı `app` ve `worker` servisleri korunur. Worker container'ı `/api/metrics` üzerinden heartbeat liveness kontrolü yapar; restart policy süreç kapanmasını ele alır. `app` readiness HTTP 200 yanıtı yalnız DB erişimini gösterir. Güncel heartbeat de tek başına sağlayıcı/alarm teslimatı başarısı değildir; son başarısız görev ve kuyruk metriklerini ayrıca izleyin.

LLM erişimi düzeltildikten sonra Sistem durumu → Manuel işlemler → **401 hatalı analizleri yeniden kuyruğa al**, yalnız yeni/erişilebilir ve 401 nedeniyle dead olan en fazla 100 yorumu alır. İnsan incelemesi, silinmiş/erişilemeyen kayıtlar ve başka hata sınıfları topluca açılmaz. Revizyon, eski analiz/teslim edilmemiş alarm iptali ve audit aynı transaction içinde korunur. Sonuçları analiz kuyruğundan doğrulayın.

Video işçisinin heartbeat kaydı için `0023_video_worker_heartbeat.sql` migration'ı da uygulanmalıdır; önceki DB kuralı yalnız eski görevleri kabul eder.

Worker durursa webhook, analysis ve alarm işleri kaybolmaz; `pending/retry` bekler. `processing` durumunda ölü kalan locklar recovery ile tekrar kuyruğa alınır.

Scheduler görevleri hata açısından izoledir; webhook processor hatası aynı cycle'da analysis/alarm/maintenance görevlerini engellemez.

## Health / metrics

Readiness:

```text
GET /api/health
```

- `200`: app + DB erişilebilir
- `503`: DB erişimi yok

Prometheus:

```text
GET /api/metrics
Authorization: Bearer <CRON_SECRET>
```

İzlenecek temel metrikler:

- `sosyal_itibar_queue_items`
- `sosyal_itibar_queue_oldest_age_seconds`
- `sosyal_itibar_llm_latency_ms`
- `sosyal_itibar_connections`
- `sosyal_itibar_sync_leases`
- `sosyal_itibar_critical_items_total`

Önerilen ilk SLO alarmları, gerçek trafik ölçüldükten sonra ayarlanmalıdır. Başlangıç için oldest queue yaşının sürekli büyümesi en önemli sinyaldir.

## Queue durumları

Webhook:

```text
pending -> processing -> processed
                    -> retry -> processing
                    -> dead
```

LLM:

```text
pending -> processing -> complete
                    -> retry -> processing
                    -> dead
```

Alarm:

```text
pending -> processing -> delivered
                    -> retry -> processing
                    -> dead
                    -> cancelled
```

`cancelled`, kaynak yorum silindiğinde/değiştiğinde veya mapping değişikliği eski teslim edilmemiş alarmı geçersiz kıldığında kullanılır.

## Concurrency / backpressure

Kuyruklar sınırsız paralel çalışmaz:

```text
WEBHOOK_CONCURRENCY
ANALYSIS_CONCURRENCY
ALERT_CONCURRENCY
SYNC_CONCURRENCY
HEALTH_CHECK_CONCURRENCY
```

Yük artınca önce backlog/latency ölçün. Provider 429 veriyorsa concurrency yükseltmek yerine azaltın. DB CPU yüksekse batch/concurrency değerlerini birlikte küçültün.

## Connection → target mapping

Yeni Meta connection bağlandıktan sonra `/settings/meta` altında hesabı ilgili `monitoring_target` ile eşleyin. Mapping yoksa LLM yalnız isim/alias bağlamıyla çalışır ve `sen/siz` tarzı yorumları hedefe bağlamakta doğal olarak daha zayıf kalır.

Mapping değişikliği mevcut kayıtları yeniden analysis queue'ya alır; büyük hesaplarda bunu yoğun saat dışında yapın.

## Connection lifecycle

- `active`: normal çalışma
- `degraded`: scope/expiry/geçici hata; sync denenebilir
- `revoked`: yeniden OAuth gerekir
- `disabled`: operatör tarafından pause; health/sync/OAuth refresh otomatik aktifleştirmez

Disconnect geçmiş yorumları silmez. `social_items.connection_id` NULL olabilir; history korunur.

## Meta token sorunu

Connection `revoked` ise:

1. Meta Dashboard App/permission durumunu kontrol et.
2. `/settings/meta` üzerinden reauthorize/connect.
3. `Tokenları kontrol et`.
4. yorumları reconcile et.
5. queue backlog kontrol et.

`degraded` ise `last_error` içindeki missing scope/expiry/network sinyalini incele.

## Webhook gelmiyor

1. Meta callback verify başarılı mı?
2. `META_WEBHOOK_VERIFY_TOKEN` eşleşiyor mu?
3. Reverse proxy `X-Hub-Signature-256` headerını koruyor mu?
4. IG webhook comment subscription Dashboard'da açık mı?
5. FB Page `webhook_subscribed` beklenen durumda mı?
6. `webhook_events` event alıyor mu?
7. Event dead ise `/settings/operations` hata mesajını incele.
8. Kök neden düzeldikten sonra requeue et.

Webhook sorununda reconciliation veriyi telafi edebilir; ancak webhook arızasını gizlemek için reconciliation frekansını aşırı yükseltmeyin.

## Reconciliation

Worker küçük connection batch'leri seçer ve `sync_attempted_at` en eski/null olanı önce işler. Claim atomik `FOR UPDATE SKIP LOCKED` + DB lease kullanır; birden fazla worker replica aynı connection'ı eşzamanlı taramaz. Uzun taramada worker lease heartbeat yeniler; lease kaybedilirse eski worker işlemi durdurur. Worker ölürse lease `SYNC_LEASE_MS` sonrası reclaim edilebilir. Böylece tek arızalı connection tüm hesapları bloke etmez.

`RECONCILE_INTERVAL_MS` scheduled reconciliation için hesap başına minimum yeniden deneme aralığıdır; app ve worker aynı değeri almalıdır. Worker iş bulunan gruptan sonra `WORKER_POLL_MS` kadar bekleyip sıradaki zamanı gelmiş hesapları alır; boş kuyrukta en fazla 60 saniyelik idle polling kullanır. Endpoint hatasında tekrar deneme aralığı korunur. Manuel sync bu due filtresini atlar ama batch/concurrency ve lease sınırları geçerlidir; tek tıklama bütün hesapların tarandığı anlamına gelmez.

Eski paylaşımın altında yeni yorum olabileceği için fetched paylaşım yalnız yaşından dolayı atlanmaz. `SYNC_LOOKBACK_DAYS` dışındaki fetched paylaşım sayısı `outsideLookbackParents` olarak raporlanır; bu değer sert paylaşım kesme sınırı değildir. `SYNC_MAX_POSTS_PER_CONNECTION` ve `SYNC_MAX_COMMENTS_PER_PARENT` her grubun sınırlarıdır. Kalan sayfalar ve taşan kayıtlar `syncState.continuation` içinde şifreli saklanır; scheduled reconciliation başarılı grupların devamını reconcile interval beklemeden alır. Hatalı grup normal retry aralığına döner, checkpoint ilerlemez. `coverageLimited=true` sınır veya bekleyen devam işini bildirir; tam geçmiş taramasının tamamlandığını göstermez. OAuth yeni token kaydederken eski tokenlı devamı temizler; taze tarama başlar. Gerçek Meta cursor ömrü ve outage recovery doğrulanmadı.

Yük yüksekse:

- `SYNC_CONNECTION_BATCH_SIZE`
- `SYNC_CONCURRENCY`
- `SYNC_LEASE_MS`
- `SYNC_MAX_POSTS_PER_CONNECTION`
- `SYNC_MAX_COMMENTS_PER_PARENT`
- `SYNC_LOOKBACK_DAYS`

ayarlarını backlog ve Graph rate-limit verisine göre düşürün.

## LLM kesintisi / fallback

Primary LLM retry sonrası başarısız olursa, üç fallback env değeri birlikte tanımlıysa ikinci OpenAI-compatible provider denenir:

```text
LLM_FALLBACK_BASE_URL
LLM_FALLBACK_API_KEY
LLM_FALLBACK_MODEL
```

Hangi provider/modelin sonuç ürettiği analysis metadata'da tutulur. İki provider da başarısızsa item retry/dead queue'ya gider; yorum kaybolmaz.

## Alarm teslimatı

Alarm outbox yalnız `ALERT_WEBHOOK_URL` tanımlıysa teslim eder. Delivery:

- timeout
- 408/409/425/429/5xx retry
- network retry
- exponential backoff
- non-retryable 4xx → dead
- HMAC-SHA256 body signature
- idempotency key
- deleted/superseded item → cancelled

Receiver da idempotency key'i gerçekten uygulamalıdır; sender tek başına exactly-once garanti vermez.

## DB migration / smoke

Deploy öncesi veya CI'da:

```bash
npm run db:migrate
npm run db:smoke
```

Smoke test tablo, kritik index, `pgcrypto`, `pg_trgm` ve history-preserving FK invariant'ını doğrular.

Migration dosyası production'a çıktıktan sonra içeriğini değiştirmeyin; checksum koruması deploy'u durdurur. Yeni migration ekleyin.

## Backup

En az günlük PostgreSQL backup:

- targets
- auth accounts / connections
- source-target mappings
- social items / analyses
- alert outbox
- audit logs

DB backup tokenları ciphertext taşır. Encryption key ayrı secret store'da yedeklenmelidir.

## Encryption key rotation

1. Yeni 32-byte key üret.
2. eski key → `TOKEN_ENCRYPTION_KEY_PREVIOUS`
3. yeni key → `TOKEN_ENCRYPTION_KEY`
4. deploy
5. health/sync sırasında ciphertext yeni key'e rotate olur
6. tüm kayıtlar döndükten sonra previous key'i kaldır

Rotation öncesi/sonrası gerçek token decrypt smoke testi yapın.

## Incident: queue backlog büyüyor

1. `/api/metrics` oldest age + status count bak.
2. worker process/log sağlıklı mı?
3. DB latency/CPU?
4. Meta/LLM/alert receiver 429/5xx?
5. dead queue kayıtlarında ortak hata?
6. concurrency körlemesine artırma.
7. provider darboğazıysa concurrency azalt / fallback doğrula.
8. worker yatay ölçeklenecekse CAS lock davranışını yük testiyle doğrula.

## Deploy öncesi kısa kontrol

- clean dependency install
- migration + db smoke green
- lint/typecheck/test/build green
- Docker build green
- app health 200
- metrics scrape 200 (auth ile)
- worker cycle error yok
- Meta token health active
- connection→target mapping var
- gerçek FB + IG test yorumu panelde
- LLM analysis complete
- test alarm delivered
- dead-letter/requeue testi
- backup/restore testi
