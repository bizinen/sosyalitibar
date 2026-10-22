# Kendi hesapları için analiz ve alarm incelemesi

Tarih: 2026-10-01. Kapsam: sahibinin farklı dillerdeki Facebook/Instagram hesapları; hesap sayısı sabit değildir. Yorum gizleme/silme ve dış müşteriye açılan SaaS/RBAC bu çalışma kapsamında değildir. Kullanıcı talebiyle test, lint, typecheck, build, migration ve canlı entegrasyon çalıştırılmadı.

## Kaynak koddan bulunan ve değiştirilen davranışlar

| Sorun | Değişiklik | Modül |
|---|---|---|
| Türkçe odaklı prompt çok dilli amaçla uyuşmuyordu | Çok dilli semantik, özgün dilde iddia, kanonik hedef ve Türkçe operatör özeti | `src/lib/llm.ts` |
| Tek karakterli yorum doğrudan spam oluyordu | Deterministic yol yalnız boş metinde; anlamlı tek karakter LLM'e gider | `src/lib/ingest.ts` |
| Yorum/parent/hedef/alias kesilmesi sessizdi | Coverage bilgisi prompt ve metadata'da; eksik girdide zorunlu insan incelemesi | `src/lib/llm.ts` |
| Paylaşım metni analize verilmiyordu | Sync source_post bağlamını raw içinde korur; webhook bu bağlamı ezmez; değişiklik yeniden analiz edilir | `src/lib/sync.ts`, `src/lib/ingest.ts` |
| Eşlenmemiş hesaplar güvenilir doğrudan hedef bağlamı olmadan normal sonuç üretebiliyordu | Açık kaynak eşleme uyarısı ve eksik bağlam incelemesi | `src/app/settings/meta/page.tsx`, `src/lib/llm.ts` |
| needs_review sonuçları doğrudan filtrelenemiyordu | İnsan incelemesi gerektiren sonuç filtresi | `src/app/page.tsx` |
| İki kaynaklık her sync grubu arasında 15 dakika bekleniyordu | DB due filtresi hesap başına uygulanır; hazır gruplar kısa aralıkla işlenir | `src/lib/sync.ts`, `scripts/scheduler.mjs` |
| Eski paylaşımın yeni yorumları yaş kontrolüyle atlanıyordu | Fetched paylaşımlar yaş nedeniyle atlanmaz; yaş dışı kaynaklar raporlanır | `src/lib/sync.ts` |
| Tarama limitleri tam sync gibi gösteriliyordu | coverageLimited ve gerçek grup sayısı operatöre bildirilir | `src/lib/sync.ts`, `src/app/components/OperationsActions.tsx` |
| Alarm endpointi eksikken kritik karar kayboluyordu | Outbox kaydı korunur; yapılandırma yokken delivery claim yapılmaz | `src/lib/alerts.ts`, queue endpointleri |
| LLM Retry-After beklemeleri scheduler bütçesinde yoktu | Provider retry bekleme süresi timeout hesabına dahil edildi | `scripts/scheduler.mjs` |
| Bozuk scrypt hash sıfır uzunlukla parola karşılaştırmasına girebiliyordu | Hash/salt biçimi ve decode uzunluğu fail-closed kontrol edilir | `src/lib/auth.ts` |

## Açık sınırlar

- Yerel sosyal_itibar DB'sinde 0009–0012, 2026-10-01 tarihinde backup alındıktan sonra uygulandı. 12 migration'ın tamamı kayıtlı; dosya checksum'ları eşleşiyor. source_read_version kolonu, source read sequence ve parent index DB'de mevcut. Başka ortamlarda deploy öncesi migration gerekir; uygulama/LLM/Meta akışı bu işlemle doğrulanmış değildir.
- Paylaşım metni sync ile alınır; webhook'un ilk analizinde metin bulunmayabilir. Eksiklik açıkça insan incelemesine yönlendirilir. Raw retention provider debug payload'ını kaldırır, fakat yeniden analiz için source_post.id/text bağlamını korur. Görsel/video içeriği verilmez; prompt bu içeriği görmüş gibi davranmayı yasaklar.
- Bounded reconciliation her invocation'da limitli çalışır; kalan sayfa ve taşan kayıtlar şifreli syncState.continuation içinde saklanır. Posts/comments/replies devam işleri sonraki invocation'larda işlenir. Başarılı bir grup tamamlanmadan checkpoint ilerlemez; crash sonrası aynı grup tekrar okunabilir. Gerçek provider cursor ömrü ve outage telafisi doğrulanmadı; tam geçmişin geri kazanıldığı iddia edilmez.
- Provider yanıtları mutlak kaynak sürümü garantisi taşımaz. DB sequence'den Graph okuması öncesinde alınan sourceReadVersion eski başlayan okumaların daha yeni kaydı ezmesini engeller; şifreli devam kayıtları başlangıç sırasını korur. Bu konservatif sıra provider'ın eventual consistency davranışını çözmez; eski bir backfill grubunun mevcut kayıt güncellemesi sonraki taze taramaya kalabilir.
- Çok dilli sınıflandırma kalitesi, gerçek Meta izinleri/webhookları ve gerçek alarm receiver HMAC/idempotency davranışı kod incelemesiyle kanıtlanamaz. Son kod için doğrulama sonucu yoktur.

Bu belge düzeltmeleri ve açık sınırları kaydeder; production-ready doğrulaması değildir.

## Patch sonrası yeniden kaynak incelemesi

Son eklenen paylaşım bağlamı ile retention arasında bir regresyon bulundu: retention bağlamı siliyor, sonraki sync bağlamı geri yazarken aynı yorumu tekrar pending/new yapabiliyordu. Maintenance artık yalnız source_post.id/text alanlarını korur ve zaten bu minimal biçimde olan satırları tekrar seçmez. Bu saklama politikası istisnası bilinçlidir: RETENTION_RAW_ITEM_DAYS ham provider/debug verisi içindir; paylaşım metni yorum analizinin bağlamı olarak korunur.

Due filtresinin süresi dolmuş lease kurtarmasını uzun reconcile aralığına bağlama ihtimali giderildi. Worker'ın ardışık endpoint hatalarında kısa aralıklarla sürekli istek üretmesi bounded backoff ile azaltıldı; başarılı yanıtta backoff sıfırlanır. Mapping PUT gövdesinde targetIds zorunlu hale geldi; boş gövde artık bütün eşlemeleri silmez. Mevcut UI açık targetIds dizisi gönderiyor.

Bu patch'lerin ardından ilgili source kodu, ingestion bağlam karşılaştırması, scheduler bekleme yolu ve mapping UI çağrısı tekrar okundu. Bu statik incelemedir; SQL veya uygulama çalışma zamanı doğrulaması yapılmadı.

## Altı bulgu için patch ve tekrar okuma — 2026-10-01

Çoklu webhook paketi işlemci içinde tek değişiklikli durable alt işlere ayrılır; alt iş insert'leri ve parent completion aynı sahiplik transaction'ındadır. Her alt iş bağımsız retry/dead-letter olur. Reconciliation sınırda kalan sayfaları ve taşan kayıtları mevcut şifreleme katmanıyla saklar; checkpoint yalnız sahipliği süren worker tarafından başarılı grup sonunda yazılır. OAuth yeni token kaydettiğinde eski tokenlı cursor devamı temizlenir. Token key rotation şifreli continuation kayıtlarını da kapsar.

Uzun yorumun tamamı 6000 karakterlik, 500 karakter örtüşen bölümlerde sırayla analiz edilir. Bütün bölümler başarıyla bitmeden sonuç kaydedilmez; aggregate aynı hedefin risk göstergelerini birleştirir ve insan incelemesi ister. Input hash tam metni içerir. Bölümler arasında dil/ironi/hedef bağlamının doğru yorumlandığı runtime/LLM değerlendirmesiyle kanıtlanmadı. Metinsiz kayıt spam sayılmaz; other/needs_review=true döner.

Health ve sync kendi hata alanlarını mevcut syncState JSON'unda atomik günceller. Başarılı token kontrolü çözülmemiş sync hatasını temizlemez ve active raporlamaz. Sync başarısı health hatasını korur. Instagram embedded replies debug raw içine yazılmaz; paging URL'sindeki olası tokenın plaintext saklanması önlenir, 0012 mevcut raw.replies verisini de kaldırır.

Tekrar okumada continuation'ın sağlık alanlarını ezmesi, key rotation dışında kalması ve reply continuation'ın parent sayacını artırması giderildi. İlk sayfa/tail/next cursor, retry-before-checkpoint, source watermark, pause/OAuth ownership, segment failure ve iki hata alanının eşzamanlı güncelleme yolları kaynak koddan değerlendirildi. Regresyon testleri eklendi; hiçbiri çalıştırılmadı.
