# Production incelemesi düzeltmeleri — 22 Ekim 2026

Yerel çalışma branch'i: `fix/production-audit`; review branch'i: `fix/production-audit-pr`. Çalışma başlangıcındaki değişiklikler korundu; karşılaştırma başlangıçtaki dosya görüntüsüne göre yapıldı. Yeni migration eklenmedi.

## Amaç ve değişiklikler

| Bulgu | Düzeltme ve kanıt |
| --- | --- |
| Bakım sonrası aynı yorumun yeniden analize alınması | Retention yalnız gerekli kaynak metnini ve harici kaynak kimliğini korur. Gerçek PostgreSQL testinde değişmemiş yorumun revizyonu, insan incelemesi, analiz ve tek alarm kaydı korundu; ikinci bakım tekrar veri temizlemedi. |
| Lint ve test hataları | Effect içindeki eşzamanlı durum sıfırlamaları kaldırıldı; sayfa değişiminde eski istekleri reddeden sürüm sayacı korundu. Video durumu sunucudan gelen DB zamanı ve istemci saatiyle hesaplanır. Geçersiz YouTube fixture kimlikleri ve eksik/eski mock beklentileri düzeltildi. |
| Güvenlik bildirimi bulunan üretim bağımlılıkları | Next.js ve ESLint yapılandırması 16.3.8, Drizzle ORM 0.45.4, source-map-js 1.2.2; Vitest 5.0.5 ve Vite 8.3.5. Lockfile Linux/Node 22 temiz ortamında npm ile doğrulandı. CI üretim bağımlılıklarını ayrıca audit eder. |
| Meta uygulama değişiminin eski OAuth sahibi kaydıyla engellenmesi | Bağlantılar varsa değişiklik reddedilir. Bağlantı kalmadığında yeni App Secret doğrulandıktan sonra kullanılmayan eski yetkilendirmeler aynı transaction içinde temizlenir. OAuth callback'in FB/IG kayıt adımları aynı ayar kilidi ve revizyonunu kontrol eder. Eşzamanlı ayar değişimi eski callback'in bağlantı yazmasını engeller. |
| Paylaşım sayacı ve açılan listenin farklı olması | Her ikisi de yeni, erişilebilir ve AI tarafından inceleme istenen yorumları kullanır. PostgreSQL testi ve tarayıcıda 30/30 eşleşmesi doğrulandı. |
| Kişi/kurum filtresinin yeni etiketli yorumları kaybetmesi | Güncel insan değerlendirmesi önceliklidir. Yoksa eski AI hedefi veya yeni etiketlerde doğrudan hesabın eşleştirilmiş bağlamı kullanılır. Harici yayınlara hesap sahipliği atfedilmez. Arayüz hesap bağlamının hedef doğrulaması olmadığını açıklar; AI kaydına sahte hedef eklenmez. |
| Avatarların CSP tarafından engellenmesi | Yalnız Google/YouTube ve Meta avatar CDN alanlarına HTTPS görsel izni eklendi; bütün HTTPS kaynaklarına genel izin verilmedi. Gerçek sağlayıcı avatarı için canlı kabul doğrulaması ayrıca gerekir. |
| Smoke kontrolünün yeni şemayı kapsamaması | Kontrol 19 tablo, 15 kritik sütun, 13 indeks, doğrulanmış triage/provider CHECK kuralları ve dosya adları/checksum üzerinden mevcut 24 migration'ı doğrular. Eksik son migration ve eksik triage CHECK negatif denemeleri başarısız oldu. |

Next.js güncellemesinin `next dev` sırasında proje kurallarını otomatik değiştirmesi `agentRules: false` ile kapatıldı; mevcut AGENTS.md korundu.

Drizzle Kit'in eski `@esbuild-kit/core-utils@3.3.2` zincirindeki esbuild, yalnız bu paket sürümü için `0.25.12` olarak sabitlendi. Önce geçici klasörde, sonra proje kurulumunda 19 tablonun ürettiği SQL bayt düzeyinde aynı kaldı (16.680 bayt); CommonJS TypeScript ve ESM/top-level await dönüşümleri doğrulandı. Böylece esbuild zincirinden gelen dört moderate paket bildirimi giderildi. Sürüm hedefi dar tutuldu; gelecekteki farklı core-utils sürümlerine eski esbuild zorlanmıyor.

## Doğrulama

- Windows/Node 24: lint hatasız ve uyarısız; typecheck başarılı; 20 dosyada 142 test başarılı.
- Linux/Node 22 Alpine: temiz `npm ci`, production build, lint ve 142 test başarılı. PostgreSQL testleri atlanmadı.
- Dar esbuild override'ından sonra Windows ve Linux'ta 142 test yeniden geçti; Linux'ta CommonJS, ESM/top-level await ve 16.680 baytlık aynı Drizzle SQL çıktısı ayrıca doğrulandı. Production Docker imajı yeni lockfile ile yeniden oluşturuldu. Karşılaştırma için üretilen SQL yalnız geçici klasörlerde kaldı; uygulama migration setine eklenmedi.
- PostgreSQL 17: boş DB'ye 24 migration; migration tekrar çalıştırma ve genişletilmiş `db:smoke` başarılı.
- `npm audit --omit=dev`: sıfır bildirim. Bu, bütün geliştirme bağımlılıklarının temiz olduğu anlamına gelmez.
- Docker production imajı oluşturuldu; uygulama `nextjs` kullanıcısıyla başladı ve DB readiness başarılı oldu.
- Production HTTP denemeleri: yetkisiz job/metrics reddi, yanlış Origin reddi, oturum açma, Secure/HttpOnly/SameSite cookie, CSP/HSTS, aynı imzalı webhook'un tek durable kayda dönüşmesi, ayrı worker ile işlenmesi ve metrics doğrulandı. Bunlar localhost üzerinde sentetik verilerle yapıldı; gerçek TLS reverse proxy testi değildir.
- Scheduler production imajında yedi görevin heartbeat'ini yazdı. Beş görevin HTTP isteği başarılı; LLM ve alarm alıcısı bulunmadığından analiz ve alarm görevleri beklenen 503 hata durumunu bildirdi. Bu görevler başarılı gösterilmedi.
- Tarayıcı: giriş, 30 inceleme bekleyen yorum, 100 kayıttan 145 kayda sayfalama, yorum ayrıntısı, insan inceleme durumu ve geçmiş kaydı doğrulandı.
- İzole dump/restore: 145 yorum, bir inceleme olayı, migration/checksum ve şifreli OAuth fixture tokenının çözülmesi doğrulandı. Gerçek production yedeği kullanılmadı.

## Açık kabul koşulları

- `.env.local` içindeki LLM değerleri placeholder olsa da yapılandırılmış veritabanında birincil Runware profili bulundu. Salt okunur kontrolden sonra gerçek kişi/yorum içermeyen tek bir sentetik toplu analiz çağrısı yapıldı; sağlayıcı HTTP 401 döndürdü. Kullanılan `/v1/chat/completions` ve Bearer biçimi [resmî Runware sözleşmesiyle](https://runware.ai/docs/tools/compatible-apis) uyumlu. Anahtar veya ham hata gövdesi çıktıya yazılmadı. LLM kabulü için geçerli sağlayıcı erişimi gerekir; önceki yalnız `.env.local` kontrolü, panelde kayıtlı profil bulunmadığını kanıtlamıyordu.
- Aynı salt okunur kontrolde Meta ayar kaydı ve etkin alarm alıcısı bulunmadı. Gerçek Meta OAuth, FB/IG webhook/edit/delete/reconciliation, App Review izinleri, revoke/reauthorize, gerçek Apify/LLM yanıtları ve alarm alıcısının HMAC/idempotency/retry kabul testleri tamamlanmış sayılmaz.
- Gerçek yayın ortamının secret store, TLS/reverse proxy, metrics scrape ve retention zamanlaması doğrulanmadı. `CODEX_HANDOFF.md` Definition of Done bütünüyle kapanmadı; production-ready etiketi verilmedi.
- Tam `npm audit` geliştirme araçlarında 5 high paket bildirimi gösteriyor; moderate bildirim kalmadı. Beş kayıt Next ESLint'in fast-glob/micromatch/braces zincirindeki aynı braces açığından kaynaklanıyor. Registry'deki braces sürümü 3.0.3; [resmî bildirimde düzeltmeli sürüm bulunmuyor](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm). Kör force-fix veya eski Next ESLint sürümüne downgrade uygulanmadı. Vitest/Vite bildirimleri patch sürümleriyle, esbuild zinciri yukarıdaki uyumluluk doğrulamasından sonra dar kapsamlı override ile giderildi.
- Kullanıcının verdiği `https://github.com/bizinen/sosyalitibar.git` remote'u doğrulandı; depo başlangıçta boştu. Kullanıcı ilk `main` kurulumu için açık izin verdi. Denetim öncesi görüntü ayrı bir temel commit'te korundu; düzeltmeler ayrı review branch'inde tutuldu. Uzak CI sonucu ayrıca doğrulanmalıdır.

## Deploy, uyumluluk ve geri dönüş

Üretime çıkmadan önce gerçek test ortamında açık kabul koşulları tamamlanmalı; uygun remote ve entegrasyon branch'i belirlenip yalnız ilgili değişiklikler review edilmelidir. Bu patch için yeni DB migration yoktur; mevcut 0024 dahil bütün migration'lar uygulanmalıdır. Yeni lockfile ile `npm ci` kullanın; CI ve Docker doğrulamalarını yayın ortamında da çalıştırın.

Kişi/kurum filtresi, insanın açık bir “eşleşme yok” kararını hesap bağlamıyla ezmez. Yeni etiketlerde hesap bağlamı kullanılması sınıflandırma doğruluğu iddiası değildir. Eski ayrıntılı analiz alanlarının nullable olması korunur.

Kod geri dönüşü, mevcut triage şemasını okuyabilen son doğrulanmış sürüme yapılmalıdır; 0024 şemasını veri silerek geri çevirmeyin. Meta App ID değişikliği önceki uygulamanın kullanılmayan OAuth credentials kayıtlarını temizler; eski uygulamaya dönülecekse yeniden yetkilendirme gerekir. Güvenlik açığı bulunan dependency sürümlerine kör geri dönüş yapılmamalıdır.
