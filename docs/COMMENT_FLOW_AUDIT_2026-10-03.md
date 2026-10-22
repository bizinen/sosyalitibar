# Gerçek yorum akışı — kod incelemesi, 3 Ekim 2026

Bu kayıt kod incelemesini ve bu incelemede yapılan değişiklikleri ayırır. Test, lint, typecheck, build, gerçek Meta/LLM çağrısı veya alarm teslimatı çalıştırılmadı. Eksiksiz çalışma ya da production kabulü kanıtlanmış değildir. Yeni migration eklenmedi.

## Bu incelemede değiştirilen davranışlar

- `src/lib/webhook-processing.ts`: webhook workerı yorumla birlikte gönderi metnini ve yanıtın üst yorumunu getirir. Başarılı kaynak cevaplarının kimliği kontrol edilir. Bağlam isteği başarısız olursa yorum kaybolmaz; `context_incomplete` işareti taşınır. DB ve sahiplik hataları retry akışında kalır. Webhook HTTP isteğine Graph veya LLM çağrısı eklenmedi.
- `src/lib/ingest.ts`, `src/lib/llm.ts`: bağlam eksikliği değişince analiz geçersiz kılınır; eksik bağlam LLM girişinde belirtilir ve sonuç insan incelemesi gerektirir. Boş gönderi/üst yorum metni de eksik bağlam sayılır. Prompt sürümü `reputation-v2.6` oldu; çıktı bütçesi 1800 tokena yükseltildi. Bu bütçe her dil/model için yeterlilik garantisi değildir; tamamlanmamış cevap reddi korunur.
- `src/app/api/jobs/maintenance/route.ts`: ham payload temizlenirken `context_incomplete=true` korunur; geçmiş verinin sonradan tam bağlamlı sanılması önlenir.
- `src/lib/meta.ts`: hesap keşfi güvenlik sınırına ulaşıp devam sayfası kaldığında kısmi hesap listesi başarı olarak dönmez.
- `src/lib/meta.ts`, `src/lib/connection-health.ts`, `src/app/api/meta/callback/route.ts`: `data_access_expires_at` OAuth ve bağlantı sağlığında dikkate alınır. Açık `expires_at=0` cevabı ile eksik alan ayrılır; açık süresiz cevap başka tokenın son kullanma tarihine düşmez. Veri erişiminin bitiş tarihi ayrı bir DB sütununa eklenmedi; sağlık hata nedeni kaydedilir.
- `src/app/api/meta/callback/route.ts`: ilk OAuth sahibi kaydedilirken Meta ayarlarının kilidi ve revision kontrolü kullanılır. Yetkilendirme sürerken değişmiş ayarlarla hesap kaydı yapılması reddedilir. Ağ çağrıları DB transaction dışında kalır.

Değişiklikler tekrar kaynak üzerinden okundu: HTTP ACK sınırı, revision geçersizleştirme, ham veri saklama, bağlantı pause durumu ve OAuth ayar kilidi değerlendirildi. Bu, çalıştırılmış test yerine geçmez. Abonelik hata kodlarında önce bildirilen uyuşmazlık kaynakta bulunmadı; düzeltilmiş hata olarak sayılmıyor.

## Açık kalan işler — önem sırasıyla

### 1. Düzenli tarama için toplam iş bütçesi ve ara ilerleme kaydı

`src/lib/sync.ts:60`, `:93`, `:169`, `:266`, `:275`.

Sayfa ve üst yorum başına sınırlar, continuation ve lease/heartbeat mevcut. Ancak iç içe gönderi/yorum/yanıt taramasının toplam süre ve toplam kayıt bütçesi yok. Continuation DB'ye bütün platform taraması başarıyla dönünce yazılıyor. Yarıda kesilme veya sürekli hatalı kayıt aynı bölümü yeniden işletebilir. Upsert idempotency mükerrer kayıt riskini azaltır; kota tüketimi ve ilerleme kaybını çözmez.

Gereken: her sınırlı iş diliminden sonra sahiplik kontrollü, şifreli checkpoint; süre/kayıt bütçesi; bir kayıt hatasının diğer kayıtları sonsuza kadar engellememesi. Erken checkpoint işlenmemiş kayıtları atlamamalıdır.

### 2. Kaçırılmış silme olayının telafisi

`src/lib/webhook-processing.ts:109`, `:179`; `src/lib/sync.ts:93`, `:169`.

Silme webhooku işlenince kayıt ve kararlar geçersizleştiriliyor. Düzenli tarama mevcut yorumları upsert ediyor; daha önce bilinen ancak silme olayı kaçırılmış yorumun silindiğini teyit eden mekanizma yok. Tarihsel karar canlı yorum gibi kalabilir.

Gereken: sağlayıcının yetki kaybı ile kesin silinmeyi ayıran kaynak doğrulama stratejisi. Bir yorumu listede görememek veya Graph hatası almak tek başına silindiğinin kanıtı değildir.

### 3. İlk bağlantı kurulurken erken webhook yarışı

`src/app/api/meta/callback/route.ts:101`; `src/lib/webhook-processing.ts:105`, `:175`.

Facebook aboneliği bağlantı satırı kaydedilmeden önce isteniyor. O aralıkta işlenen bildirim, bağlantı bulunamadığı için yok sayılabilir. Sonraki tarama hâlâ mevcut yorumu bulabilir; her olayı telafi edeceği garanti değil. Disabled bağlantının bilinçli yok sayılması bu problemden ayrılmalıdır.

Gereken: kayıt/abonelik sırasını ve sınırlı erteleme davranışını birlikte düzenlemek; hiç izlenmeyen veya kaldırılmış hesapları sonsuz retry'a sokmamak.

### 4. Worker çalışırlığını kuyruk boşken de göstermek

`scripts/scheduler.mjs:87`; `src/app/api/metrics/route.ts`; `ops/prometheus-alerts.yml`.

Job logları, kuyruk metrikleri ve alarm kuralları mevcut. Ancak workerın her görev için son başarılı çalışmasını kalıcı izleyen heartbeat yok. Uygulama ayakta ve kuyruk boşken workerın durması kuyruk birikimi alarmından önce görünmeyebilir.

Gereken: görev bazında son başarılı çalışma zamanı ve bayat heartbeat alarmı; boş kuyruk ile durmuş workerı ayırmak.

### 5. Alarm kanalının panelden kurulması

`src/app/settings/alerts/page.tsx:31`, `:58`; `src/lib/alerts.ts`.

HMAC imzalı, idempotent, ayrı outbox teslimat akışı mevcut. Endpoint, imza anahtarı ve kurallar hâlâ env üzerinden ayarlanıyor; panel bunları gösteriyor ancak düzenlemiyor. Hazır e-posta/Telegram alıcısı kurulmuş kabul edilemez.

Gereken: kullanılacak alıcıyı belirlemek, gerekiyorsa panelde şifreli ayarlar eklemek ve alıcının imza/idempotency sözleşmesini uygulamak.

## Kod incelemesinin kanıtlayamadıkları

Gerçek Meta izinleri ve HTTPS erişimi, FB/IG yorum/yanıt/edit/delete bildirimleri, token iptali, kaçırılan olayların telafisi, gerçek LLM cevapları ve çok dilli karar kalitesi, alarm alıcısının teslimatı bu turda doğrulanmadı. Görsel/video içeriği analiz edilmiyor; bağlam metinle sınırlı. Eski analizlerin tamamını yeni prompt sürümüyle otomatik yeniden değerlendirme yapılmadı.

Meta'nın ayrı token ve veri erişimi son kullanma alanları: https://developers.facebook.com/docs/graph-api/reference/debug_token/
