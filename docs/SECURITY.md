# Security Notes

## Secret management

Production secretlarını repoya commit etmeyin. Coolify/Kubernetes/secret manager environment secret kullanın.

Hassas değerler:

- `META_APP_SECRET`
- Meta access token ciphertext keyleri
- `TOKEN_ENCRYPTION_KEY` / previous
- `SESSION_SECRET`
- `CRON_SECRET`
- `AUDIT_HASH_SECRET`
- `ALERT_WEBHOOK_SECRET`
- `LLM_API_KEY`
- `LLM_FALLBACK_API_KEY`
- `ADMIN_PASSWORD_HASH`
- `DATABASE_URL`

## Startup validation

Production açılışında:

- `APP_URL` + callback HTTPS
- callback aynı origin'de exact `/api/meta/callback`
- encryption key decoded = exactly 32 byte
- admin hash = scrypt format
- alert URL varsa HTTPS + secret
- LLM fallback üçlüsü ya tamamen var ya tamamen yok

## Admin auth

Admin şifresi scrypt hashlenir. Production `ADMIN_PASSWORD_HASH` olmadan açılmaz. Login brute-force sayacı PostgreSQL atomic UPSERT kullanır.

Session:

- HttpOnly
- Secure (production)
- SameSite=Lax
- imzalı
- 8 saat TTL

Bu sürüm tek-admin modelidir. Çok kullanıcılı SaaS için MFA/RBAC ayrı P1'dir.

## CSRF / same-origin

Cookie-auth state-changing endpointler fail-closed same-origin Origin/Referer kontrolü yapar. `Sec-Fetch-Site` varsa doğrulanır. Server-to-server worker/metrics endpointleri Bearer `CRON_SECRET` kullanır.

## Redirect origin hardening

Login/logout ve Meta OAuth callback redirectleri request Host değerinden türetilmez; startup'ta doğrulanmış `APP_URL` origin'ine sabitlenir.

## OAuth replay

OAuth state HMAC imzalıdır ve DB'de tek kullanımlık nonce vardır. Callback'ten sonra reuse reddedilir.

## Meta webhook

- `X-Hub-Signature-256` zorunlu
- App Secret HMAC-SHA256
- 1 MiB body cap
- invalid JSON reject
- SHA-256 dedupe
- ağır iş yok, durable queue

## Token storage / lifecycle

Access token plaintext DB'ye yazılmaz. AES-256-GCM ciphertext key-id içerir ve previous-key rotation destekler.

`disabled` connection operatör iradesidir; background health/sync tarafından active'e çevrilmez. `revoked` yeniden authorization ister.

Connection silinince geçmiş yorumlar cascade silinmez (`ON DELETE SET NULL`). Bu hem audit/history hem de yanlışlıkla veri kaybı açısından önemlidir.

## LLM trust boundary

Yorum metni **untrusted input** kabul edilir. System contract yorum içindeki:

- rol değiştir
- system promptu göster
- JSON schema'yı boz
- önceki kuralları unut

gibi talimatları veri olarak sınıflandırır, talimat olarak uygulamaz.

LLM output strict Zod schema ile parse edilir. LLM:

- iddianın doğru/yanlış olduğuna karar vermez,
- kişinin psikolojisi/suçluluğu hakkında çıkarım yapmaz,
- normal eleştiriyi otomatik hakaret saymamalıdır.

`severity` enforcement/hukuki karar değil, human-review priority'dir.

## Source-target mapping

`connection_targets`, yorumun doğrudan hangi kişi/kurum hesabında yapıldığını modele iletir. Bir mapping değişince eski model kararının bağlamı geçersiz sayılır; yeniden analiz edilir. Pending eski alertler iptal edilir.

## Alert webhook

Raw request body `ALERT_WEBHOOK_SECRET` ile HMAC-SHA256 imzalanır. Receiver constant-time compare kullanmalıdır. `Idempotency-Key` receiver tarafından persist edilmelidir.

Alarm payload'ı yorum text snippet'i/analysis özeti taşıyabileceğinden notification gateway de PII barındıran sistemdir.

## Queue isolation / DoS control

Webhook, analysis, alert, sync ve token health concurrency ayrı env limitleriyle bounded çalışır. Sınırsız `Promise.all` kullanılmaz. Bu hem downstream rate-limit hem DB kaynak tükenmesini azaltır.

## PII minimization / retention

- audit IP plaintext yok; HMAC hash
- raw Meta webhook payloadları süreli
- social item raw süre sonunda null
- old delivered/dead/cancelled alerts temizlenir
- full LLM prompt/provider raw response dump saklanmaz

Yorum text'i ürün fonksiyonu için saklanır; kurumsal kullanımda retention/deletion politikasını hukuk/gizlilik gereksinimine göre ayrıca belirleyin.

## Metrics endpoint

`/api/metrics` public değildir; Bearer `CRON_SECRET` gerekir. Reverse proxy'de ayrıca private network/IP allowlist önerilir.

## Response security

- CSP
- HSTS production
- frame deny
- nosniff
- referrer policy
- permissions policy
- COOP/CORP

## Human review

Otomatik silme, ban, platform şikâyeti veya hukuki hüküm uygulanmaz. Kritik içerik alarm üretir ama nihai aksiyon insan incelemesidir.
