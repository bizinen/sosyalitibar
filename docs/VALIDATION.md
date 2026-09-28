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
