# Sosyal İtibar

Facebook Page ve Instagram Professional hesaplarındaki yorumları webhook + reconciliation ile toplayan, yorumları LLM ile sınıflandıran ve kritik kayıtları güvenli bir alarm outbox'ı üzerinden ileten bağımsız sosyal medya itibar izleme uygulaması.

> Bu proje Okur Gazetesi'nden tamamen bağımsızdır. Okur repo/DB'sine bağlı değildir.

## Durum — V0.4 Production Architecture

Bu sürüm starter değildir. Production omurgası kodlandı; **gerçek Meta App ile uçtan uca kabul testi ve internet erişimli temiz dependency/build doğrulaması hâlâ zorunludur.**

### Uygulanan production katmanları

- Next.js `16.3.6` + React `19.3.0` + TypeScript strict
- PostgreSQL + Drizzle
- Facebook Login üzerinden Meta OAuth, tek kullanımlık HMAC state + DB nonce
- kısa ömürlü token → uzun ömürlü user token exchange
- Meta OAuth sahibi / Facebook Page / Instagram account ayrı veri modeli
- Facebook Page + bağlı Instagram Professional discovery
- access tokenları versioned AES-256-GCM ile şifreli saklama + previous-key rotation
- token debug, scope/expiry health ve `active/degraded/revoked/disabled` yaşam döngüsü
- kaynak hesabı izlenen kişi/kurumla bağlayan `connection_targets`
- Meta `X-Hub-Signature-256` doğrulaması, 1 MiB limit, event dedupe, hızlı ACK
- durable webhook queue: `pending/processing/retry/dead`
- Facebook comment/reply ve Instagram comment/reply reconciliation + cursor pagination
- düzenlenen/silinen yorumlarda analysis + pending alert invalidation
- async LLM queue; webhook request'inden tamamen ayrı
- LLM prompt-injection sertleştirmesi, strict Zod schema, model/provider/prompt/hash/latency kaydı
- primary LLM başarısızlığında opsiyonel ikinci OpenAI-compatible fallback provider
- critical `alert_outbox`: idempotency, HMAC signature, timeout, retry/backoff, dead-letter
- bounded concurrency: webhook / analysis / alert / sync / token-health workerları
- connection bazlı reconciliation batch scheduling; hatalı hesap diğerlerini bloke etmez
- çoklu worker için DB sync lease + `FOR UPDATE SKIP LOCKED`; heartbeat + stale lease güvenli reclaim
- connection pause/resume/disconnect; disconnect geçmiş yorumları silmez
- admin review queue: `new/reviewed/ignored/escalated`
- keyset/cursor pagination ve PostgreSQL trigram yorum arama indexi
- audit log, PII-minimized IP HMAC hash, retention/maintenance
- production admin auth: scrypt hash + PostgreSQL atomic brute-force throttle
- strict same-origin CSRF, CSP/HSTS ve güvenlik headerları
- Prometheus uyumlu `/api/metrics` (Bearer korumalı)
- readiness `/api/health`
- SQL migration runner: advisory lock + SHA-256 checksum
- CI için gerçek PostgreSQL migration + DB smoke testi
- Docker app + ayrı scheduler worker + PostgreSQL

## Mimari

```text
                         META
                    webhook / Graph
                         │
              ┌──────────┴───────────┐
              │                      │
        signed webhook          reconciliation
              │                      │
              ▼                      │
        webhook_events               │
              │                      │
         event worker                │
              └──────────┬───────────┘
                         ▼
                    social_items
                         │
                 async analysis queue
                         ▼
                     LLM primary
                         │ failure
                         └────► optional fallback
                         │
                         ▼
                  social_analyses
                         │
               critical rule evaluation
                         ▼
                    alert_outbox
                         │
               signed HTTPS webhook
                         ▼
             Telegram / n8n / email bridge
```

Webhook HTTP handler Graph taraması veya LLM çağrısı yapmaz. Önce kalıcı event kuyruğuna yazar ve Meta'ya hızlı yanıt döner.

## Hedef eşleştirme neden iki katmanlı?

Sadece isim/alias araması yeterli değildir. Kişinin kendi Instagram hesabına biri:

> “Sen yine insanları yanlış yönlendiriyorsun.”

şeklinde yorum yapabilir ve isim hiç geçmeyebilir. Bu yüzden her social connection, `/settings/meta` ekranından bir veya daha fazla `monitoring_target` ile eşleştirilir. LLM'e hem alias listesi hem de `source_targets` bağlamı gönderilir. Mapping değişirse mevcut analizler yeniden kuyruğa alınır ve teslim edilmemiş eski alarmlar iptal edilir.

## İlk kurulum

Node.js 22+ ve PostgreSQL gerekir.

```bash
cp .env.example .env.local
npm install
npm run auth:hash -- 'çok-uzun-ve-guclu-admin-sifresi'
# çıktıyı ADMIN_PASSWORD_HASH olarak yaz
npm run db:migrate
npm run db:smoke
npm run dev
```

Production'da `ADMIN_PASSWORD` kullanmayın. `SESSION_SECRET`, `CRON_SECRET`, `AUDIT_HASH_SECRET` için en az 32 karakter güçlü rastgele değer; `TOKEN_ENCRYPTION_KEY` için 32-byte base64 anahtar kullanın.

```bash
openssl rand -base64 48   # session/cron/audit secret
openssl rand -base64 32   # token encryption key
```

## Meta ayarları

Mevcut implementasyon **Instagram API with Facebook Login** yolunu kullanır. Uygulamanın gerçek onaylı permission setine göre `META_SCOPES` ayarlanır. Beklenen temel kapsam:

```text
pages_show_list
pages_read_engagement
pages_read_user_content
instagram_basic
instagram_manage_comments
```

Callback:

```text
https://DOMAIN/api/meta/callback
```

Webhook callback:

```text
https://DOMAIN/api/webhooks/meta
```

`META_GRAPH_VERSION` repoya sabitlenmez; Meta Developer Dashboard'da kullandığınız aktif sürümü production secret/config olarak verin.

`instagram_business_manage_comments`, Instagram Login yoluna aittir ve Facebook Login permissionı ile aynı şey değildir. Bu projede Instagram Login ikinci provider olarak henüz açılmamıştır; gerçek güncel Meta auth akışı doğrulanmadan endpoint tahmini yapılmamalıdır.

## Worker

`docker-compose.yml` ayrı `worker` servisi başlatır. Scheduler queue hatalarını birbirinden izole eder: webhook kuyruğu hata verse bile analysis/alarm/maintenance döngüsü çalışmaya devam eder.

Varsayılan görevler:

- webhook event queue
- LLM analysis queue
- alarm delivery queue
- kontrollü batch reconciliation
- token health
- retention/maintenance

Concurrency ve batch limitleri `.env` üzerinden ayarlanır; worker içinde sınırsız paralellik yoktur.

## Monitoring

Readiness:

```text
GET /api/health
```

Prometheus metrics:

```text
GET /api/metrics
Authorization: Bearer <CRON_SECRET>
```

Metrikler queue backlog/status, oldest runnable job age, LLM avg/p95 latency, connection health ve kritik/negatif kayıt sayılarını içerir.

## Docker

```bash
cp .env.example .env.production
# .env.production doldur
export POSTGRES_PASSWORD='guclu-db-sifresi'
docker compose up -d --build
```

App container migration runner'ı çalıştırır. Migration runner advisory lock ve checksum kullandığı için aynı anda açılan replica'lar migration yarışı oluşturmaz.

## Veri ve güvenlik

- Meta tokenları plaintext DB'ye yazılmaz.
- Sensitive anahtarlar structured logger tarafından redakte edilir.
- Raw webhook eventleri ve social item raw payloadları retention ile temizlenir.
- Audit IP plaintext tutulmaz.
- LLM yorum metnini untrusted data kabul eder; yorum içindeki prompt talimatlarını uygulamaması system contract'ında zorunludur.
- LLM iddianın doğru/yanlış olduğuna karar vermez.
- Severity hukuki hüküm değil, insan incelemesi için operasyonel öncelik skorudur.
- Otomatik silme, banlama, suçlama veya platforma şikâyet gönderme yoktur.

## Production doğrulama

```bash
npm run db:migrate
npm run db:smoke
npm run lint
npm run typecheck
npm test
npm run build
```

Bu çalışma ortamında npm registry erişimi tamamlanamadığı için `package-lock.json` ve gerçek dependency tabanlı build/test sonucu üretilemedi. İlk internet erişimli geliştirme ortamında `npm install` çalıştırın, yukarıdaki kontrolleri geçirin, lockfile'ı commit edin ve ardından CI/Docker kurulumunu yalnız `npm ci` kullanacak şekilde sıkılaştırın.

## Belgeler

- `AGENTS.md` — Codex/ajanlar için mimari guardrail'ler
- `docs/CODEX_HANDOFF.md` — mevcut durum, kalan P0/P1 işler ve Definition of Done
- `docs/OPERATIONS.md` — deploy/worker/incident runbook
- `docs/SECURITY.md` — güvenlik ve veri işleme notları
- `docs/VALIDATION.md` — bu teslimatta gerçekten çalıştırılan/çalıştırılamayan doğrulamalar
