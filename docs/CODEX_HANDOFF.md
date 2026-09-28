# CODEX HANDOFF — Sosyal İtibar

Tarih: 2026-09-28
Durum: **V0.4 Production Architecture implemented; clean dependency build + real Meta E2E pending**
Proje: bağımsız repo; Okur Gazetesi'ne bağlı değil.

## 1. Codex'e kısa özet

Bu proje artık starter değildir. Ana pipeline:

```text
Meta webhook / reconciliation
        ↓
durable event ingestion
        ↓
social_items
        ↓
async bounded LLM queue
        ↓
social_analyses
        ↓
critical-rule evaluation
        ↓
alert_outbox
        ↓
HMAC-signed notification webhook
```

Webhook request içinde Graph reconciliation/LLM yoktur. Facebook Page, Instagram account ve Meta OAuth sahibi ayrı kayıtlardır. Meta tokenları versioned AES-GCM ile encrypted tutulur. Webhook, LLM ve alarm üç bağımsız durable queue'dur.

Kökteki `AGENTS.md` mimari guardrail'dir; değişiklikten önce oku.

## 2. Stack

- Next.js `16.3.6`
- React `19.3.0`
- Node.js 22+
- TypeScript strict
- PostgreSQL 17 hedefi
- Drizzle ORM
- Zod
- Vitest
- Docker app + worker + PostgreSQL

`package.json` sürümü: `0.4.0`.

## 3. Tamamlanan production işleri

### 3.1 Data model

`src/db/schema.ts`:

- `monitoring_targets`
- `meta_auth_accounts`
- `social_connections`
- `connection_targets`
- `oauth_nonces`
- `webhook_events`
- `social_items`
- `social_analyses`
- `alert_outbox`
- `auth_rate_limits`
- `audit_logs`

Migration seti:

- `0001_production_core.sql`
- `0002_connection_targets.sql`
- `0003_search_and_queue_indexes.sql`
- `0004_sync_scheduling.sql`
- `0005_preserve_history_on_disconnect.sql`
- `0006_sync_leases.sql`

Migration runner SHA-256 checksum + PostgreSQL advisory lock kullanır. `scripts/smoke-db.mjs` kritik tablo, extension, index ve `social_items.connection_id → ON DELETE SET NULL` invariant'ını kontrol eder.

### 3.2 Meta OAuth / account discovery

Mevcut provider: **Facebook Login + Instagram API with Facebook Login**.

- HMAC signed OAuth state
- DB backed one-time nonce / replay protection
- auth code → short user token
- short → long-lived user token
- `/me`
- `/me/permissions`
- `/debug_token`
- `/me/accounts` cursor pagination
- Page token encrypted storage
- FB Page + linked IG Professional ayrı `social_connections`
- Page webhook subscription denemesi
- token scope/expiry health
- `active/degraded/revoked/disabled`
- disabled source health/sync/OAuth token refresh tarafından otomatik aktifleştirilmez; operatör pause kararı korunur

`instagram_business_manage_comments` için Instagram Login **ayrı provider olarak henüz implement edilmedi**. Exact güncel Meta auth/token endpointleri doğrulanmadan tahmin ederek ekleme.

### 3.3 Connection → target context

`connection_targets` kritik doğruluk katmanıdır.

Sebep: hedef kişinin kendi hesabına gelen yorumda isim geçmeyebilir:

```text
"Sen yine yanlış konuşuyorsun."
```

Bu durumda alias search tek başına hedefi bulamaz. `/settings/meta` üzerinden connection bir veya daha fazla `monitoring_target` ile eşlenir. LLM'e `source_targets` gönderilir.

Mapping değiştiğinde:

- geçmiş analysis kayıtları geçersizleşir,
- social item'lar yeniden analysis queue'ya alınır,
- henüz teslim edilmemiş eski alarmlar cancelled olur.

### 3.4 Webhook ingestion

`/api/webhooks/meta`:

- Meta GET verify
- `X-Hub-Signature-256`
- 1 MiB request limit
- invalid JSON rejection
- raw SHA-256 dedupe
- hızlı ACK
- durable `webhook_events`

Worker:

- FB Page `feed` comment payloadları
- IG `comments/live_comments` payloadları
- Graph detail fetch
- edit/delete handling
- pending/processing/retry/dead
- CAS lock
- stale lock recovery
- exponential backoff
- bounded concurrency (`WEBHOOK_CONCURRENCY`)

### 3.5 Reconciliation

`src/lib/sync.ts`:

- FB Page feed pagination
- FB post comment pagination
- reply pagination
- IG media/comment/reply pagination
- configurable lookback/limits
- `(platform, external_id)` dedupe/upsert
- edit → analysis reset
- token error → degraded/revoked
- küçük connection batch'leri
- en uzun süredir denenmeyen connection önce
- `SYNC_CONCURRENCY` ile bounded parallelism
- `sync_attempted_at` sayesinde arızalı kaynak diğerlerini starvation'a sokmaz
- DB-backed sync lease + `FOR UPDATE SKIP LOCKED` ile çoklu worker aynı connection'ı eşzamanlı reconcile etmez
- uzun sync sırasında lease heartbeat yenilenir; lease kaybedilirse eski worker durur
- stale lease `SYNC_LEASE_MS` sonrası reclaim edilir; eski worker yeni lease'i temizleyemez veya yeni worker'ın statusunu ezemez

Webhook kaybının güvenlik ağıdır.

### 3.6 LLM analysis

`src/lib/ingest.ts`, `src/lib/llm.ts`:

- async analysis queue
- strict Zod contract
- target match + canonical target
- source-target context
- sentiment/category/severity
- insult/threat/claim flags
- claim truth hakkında hüküm vermeme
- normal eleştiriyi hakaret saymama
- prompt injection: comment = untrusted data
- timeout + exponential retry
- primary + optional OpenAI-compatible fallback provider
- provider/model/prompt version/input hash/latency/usage metadata
- full prompt/provider raw response dump saklamama
- empty/deleted item deterministic path
- edit/delete/mapping change invalidation
- bounded concurrency (`ANALYSIS_CONCURRENCY`)

Saf context builder testi: `tests/llm-context.test.ts`.

### 3.7 Critical alert outbox

- yalnız target-match + severity/threat policy sonrası
- `ALERT_SEVERITY_THRESHOLD` default 75
- `ALERT_ON_THREAT=true`
- LLM worker'dan bağımsız
- HMAC-SHA256 raw body signature
- `Idempotency-Key`
- timeout
- retryable HTTP: 408/409/425/429/5xx/network
- exponential backoff
- max attempts
- non-retryable 4xx → dead
- stale lock recovery
- source item deleted/superseded ise `cancelled`
- `/settings/alerts` requeue UI
- bounded delivery concurrency

### 3.8 Review UI / pagination

- `/` review queue
- sentiment/category/severity/review filters
- substring search için `pg_trgm` GIN index
- keyset/cursor pagination (`ingested_at`, `id`), offset yok
- `new/reviewed/ignored/escalated`
- `/settings/targets`
- `/settings/meta`
- `/settings/alerts`
- `/settings/operations`

### 3.9 Connection lifecycle

- pause (`disabled`)
- resume (revoked hariç)
- revoked → reauthorization
- disconnect
- disconnect geçmiş social item'ları **silmez**; FK `SET NULL`
- last sync + last sync attempt görünürlüğü

### 3.10 Security

- production admin password = scrypt hash
- DB atomic login throttling
- strict fail-closed Origin/Referer CSRF
- login/logout/OAuth redirectleri yalnız doğrulanmış `APP_URL` origin'ine gider
- `Sec-Fetch-Site`
- signed 8h HttpOnly/Secure/SameSite=Lax session
- audit HMAC IP hash
- AES-256-GCM token encryption
- key id + previous key rotation
- production config validation
- CSP/HSTS/frame deny/nosniff/referrer/permissions/COOP/CORP
- webhook HMAC
- alert webhook HMAC
- no secrets in logs

### 3.11 Observability

`/api/health`:

- DB readiness + latency

`/api/metrics` (Bearer `CRON_SECRET`):

- ingested total
- negative total
- severity >= 70 total
- LLM avg/p95 latency
- webhook/analysis/alert queue status counts
- oldest pending/retry age
- connection platform/status counts
- active sync lease count + oldest lease age

Prometheus text exposition format.

### 3.12 Retention

Daily maintenance:

- expired OAuth nonce
- stale auth rate-limit rows
- processed raw webhook events
- old audit rows
- old `social_items.raw` nulling
- alert delivered/dead/cancelled retention

### 3.13 Scheduler fault isolation

`scripts/scheduler.mjs`:

- queues ayrı ayrı çağrılır
- bir endpoint failure diğer queue/maintenance görevlerini atlatmaz
- interval attempt zamanı request öncesi kaydedilir; persistent failure 5 saniyede bir spam yapmaz
- structured JSON logs
- request timeout
- SIGTERM/SIGINT graceful stop

### 3.14 CI / DB validation

CI artık PostgreSQL 17 service açar:

```text
npm install / npm ci
npm run db:migrate
npm run db:smoke
npm run lint
npm run typecheck
npm test
npm run build
```

Lockfile olmadığı için geçici install fallback vardır. P0'da lockfile oluşturulduktan sonra kaldırılmalıdır.

## 4. P0 — Codex'in ilk yapacağı işler

### P0.1 Clean install + lockfile + full verify

Bu çalışma ortamında npm registry timeout verdi. İlk internet erişimli makinede:

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

Hepsi yeşil olduktan sonra:

1. `package-lock.json` commit et.
2. `.github/workflows/ci.yml` install adımını yalnız `npm ci` yap.
3. Dockerfile deps stage:

```dockerfile
COPY package.json package-lock.json ./
RUN npm ci --omit=dev=false
```

şeklinde immutable install'a geçir.
4. Docker image build et.

**Lockfile'ı elle üretme / integrity değeri uydurma.**

### P0.2 Real Meta E2E

Gerçek production/test Meta App ile test et:

1. OAuth connect
2. state replay rejection
3. FB Page discovery
4. linked IG Professional discovery
5. connection→target mapping
6. FB yeni yorum webhook
7. IG yeni yorum webhook
8. yorum edit webhook
9. yorum delete webhook
10. webhook kapat → reconciliation aynı yorumu getiriyor mu
11. ikinci şahıs yorumunda (`sen/siz`) mapped target match
12. duplicate webhook iki kayıt üretmiyor mu
13. revoked token health sonucu
14. disabled connection health/sync skip
15. reconnect/reauthorize

Fixture olarak gerçek webhook JSON örneklerini sanitize edip `tests/fixtures/meta/` altına commit et ve normalizer contract testleri yaz.

### P0.3 Permission matrix

Meta Developer Dashboard gerçek izin durumunu belgele:

| Provider | Feature | Permission | App Review | Tested |
|---|---|---|---|---|
| Facebook Login | Page discovery | `pages_show_list` | ? | ? |
| Facebook Login | Page content/comments | `pages_read_engagement`, `pages_read_user_content` | ? | ? |
| Facebook Login | linked IG | `instagram_basic` | ? | ? |
| Facebook Login | IG comments | `instagram_manage_comments` | ? | ? |
| Instagram Login | IG comments | `instagram_business_manage_comments` | ? | ? |

Dashboard gerçekliği dokümanlardan daha önemlidir; app-specific durum kayda alınmalı.

### P0.4 Alert receiver contract E2E

Gerçek alarm gateway ile:

- signature validation
- idempotency
- 429 retry
- 400 dead-letter
- timeout retry
- deleted/superseded source alert cancellation

test et.

### P0.5 Backup/restore drill

- PostgreSQL dump
- boş DB restore
- migrations table/checksum kontrol
- token encryption key ile restore sonrası token decrypt
- previous-key rotation testi

## 5. P1 — Sonraki geliştirmeler

### P1.1 Instagram Login provider

Kullanıcının Meta App'inde `instagram_business_manage_comments` olduğu belirtiliyor. Bunu ikinci provider olarak ekle; Facebook Login ile scope/token akışını karıştırma.

Önce **güncel resmi Meta dokümanından** kesin olarak doğrula:

- authorize URL
- token exchange URL
- long-lived token davranışı
- webhook subscription
- account discovery
- required scopes
- token refresh/expiry

Sonra data modeline `auth_provider`/provider-specific metadata ekle. Mevcut Facebook Login yolunu bozma.

### P1.2 Mention/public surfaces

Kendi hesap yorumları dışındaki izin verilen yüzeyler için exact resmi API yüzeyini doğruladıktan sonra:

- `@mention`
- uygun hashtag/public media yüzeyleri

eklenebilir. “Tüm Instagram/Facebook'u sınırsız keyword crawl” olarak pazarlama; Meta API sınırlarını UI'da açık göster.

### P1.3 Multi-admin / RBAC / MFA

Tek admin auth yerine production SaaS gerekiyorsa:

- managed auth
- TOTP/WebAuthn
- roles
- audit actor id
- session revocation

### P1.4 SLO alerts

Prometheus üzerinden örnek alarm eşikleri:

- oldest webhook queue > 120s
- oldest analysis queue > 300s
- dead queue > 0
- revoked connection > 0
- LLM p95 > beklenen SLO

### P1.5 Data export / subject privacy operations

Kurumsal kullanım için retention override, export/delete workflows ve yetkili audit süreçleri eklenebilir.

## 6. Definition of Done — production launch

Aşağıdakiler tamamlanmadan “production-ready verified” deme:

- [ ] clean `npm ci`
- [ ] package-lock committed
- [ ] lint green
- [ ] typecheck green
- [ ] unit tests green
- [ ] PostgreSQL migration + db smoke green
- [ ] Next production build green
- [ ] Docker app image green
- [ ] Docker worker green
- [ ] fresh DB migration green
- [ ] migration rerun idempotent
- [ ] real FB comment webhook test
- [ ] real IG comment webhook test
- [ ] edit/delete test
- [ ] reconciliation recovery test
- [ ] connection→target second-person test
- [ ] Meta App Review/permission matrix documented
- [ ] token revoke/reauthorize test
- [ ] alert receiver HMAC/idempotency/retry test
- [ ] metrics scrape test
- [ ] backup restore drill
- [ ] secret store configured
- [ ] TLS + reverse proxy header test
- [ ] retention job verified

## 7. Bilinçli kapsam dışı

- tüm Instagram/Facebook üzerinde sınırsız keyword crawler
- scraper tabanlı ban-riskli login automation
- otomatik yorum silme/ban/şikâyet
- LLM ile suçluluk/doğruluk/hukuki hüküm

Bunlar ayrı ürün/policy kararlarıdır; mevcut monitoring pipeline'a gizlice eklenmemelidir.
