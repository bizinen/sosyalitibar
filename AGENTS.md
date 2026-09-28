# AGENTS.md — Sosyal İtibar

Bu repo bağımsız bir production uygulamasıdır. Okur Gazetesi repo/DB'sine kod taşımayın veya bağımlılık eklemeyin.

## Değişmez mimari ilkeleri

1. Meta webhook HTTP isteği içinde Graph reconciliation veya LLM çağrısı yapma. Önce `webhook_events` kuyruğuna durable yaz ve hızlı ACK dön.
2. Yorum ingestion, LLM analizi ve alarm teslimatı üç ayrı retry/dead-letter kuyruğudur. Bunları tek transaction/HTTP zincirine birleştirme.
3. Meta access tokenlarını plaintext DB/log içine yazma. `src/lib/crypto.ts` AES-256-GCM katmanını kullan.
4. Facebook Page, Instagram account ve Meta OAuth sahibi ayrı varlıklardır. Tek connection kaydında birleştirme.
5. `connection_targets`, doğrudan izlenen hesabın hangi kişi/kuruma ait olduğunu belirtir. Bu bağlam LLM target matching için kritiktir; alias eşleşmesine indirgeme.
6. Yorum düzenlenince veya connection→target mapping değişince eski analysis/alarm kararlarını geçersiz kıl ve yeniden analiz et.
7. Connection silinince geçmiş `social_items` silinmez; FK `ON DELETE SET NULL` korunmalıdır.
8. `disabled` connection health/sync/OAuth refresh tarafından otomatik `active` yapılmamalı. Operatör pause durumu korunmalı. Revoked connection yeniden authorization ister.
9. Kuyruk workerlarında sınırsız `Promise.all` kullanma. `mapLimit` ve env concurrency limitlerini koru. Reconciliation DB lease + heartbeat + `FOR UPDATE SKIP LOCKED` invariantını bozma.
10. LLM yorum metnini untrusted data kabul eder. Prompt injection korumasını ve strict Zod output contract'ını gevşetme.
11. LLM bir iddianın doğru/yanlış olduğuna hükmetmez. Kategori/severity operasyonel triage içindir; otomatik hukuki veya siyasi hüküm üretme.
12. Critical alert delivery `alert_outbox` üzerinden idempotent + HMAC signed olmalı; LLM workerını bloklamamalı.

## İlk yapılacak doğrulama

Bu çalışma ortamında npm registry erişimi tamamlanamadığı için lockfile ve gerçek build doğrulaması eksik. İlk internet erişimli geliştirme ortamında:

```bash
npm install
npm run db:migrate
npm run db:smoke
npm run lint
npm run typecheck
npm test
npm run build
```

Başarılıysa `package-lock.json` commit et ve CI/Docker'ı sadece `npm ci` kullanacak hale getir. Dependency major sürümlerini build/test olmadan yükseltme.

## Meta gerçek E2E kabul testi

Production Meta App ile en az şunları doğrula:

- OAuth callback ve one-time state replay rejection
- `/me/accounts` ile FB Page discovery
- bağlı Instagram Professional discovery
- token scopes + expiry health
- FB yorum webhooku
- IG yorum webhooku
- edit/delete webhooku
- reconciliation ile webhook kaçırma telafisi
- connection→target mapping ve ikinci şahıs yorumu (`sen/siz`) target match
- token revoke → `revoked/degraded`

`instagram_business_manage_comments` için Instagram Login ayrı bir provider/use-case'tir. Facebook Login akışıyla permissionları karıştırma. Exact güncel Meta endpoint/scope dokümanını doğrulamadan endpoint uydurma.

## Deploy kriteri

`docs/CODEX_HANDOFF.md` içindeki Definition of Done tamamlanmadan production etiketi verme.
