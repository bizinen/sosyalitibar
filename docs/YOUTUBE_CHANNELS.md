# YouTube kanal takibi

Hesaplarım → Hesap ekle → **YouTube kanalı ekle** (`/settings/meta#youtube-channels`). Yalnız kanalın `@handle`, `/channel/UC…` veya eski `/user/…` bağlantısı girilir. Meta uygulama bilgileri ve YouTube Data API anahtarı ayrı **Bağlantı ayarları** sayfasında (`/settings/integrations`) yönetilir. Hesap ve YouTube video ekleme ekranlarında anahtar alanı yoktur; kanal API'si yalnız URL kabul eder. Anahtar ve sayfalama checkpoint'leri mevcut AES-256-GCM katmanında saklanır; Meta bağlantısı veya kanal sahipliği varsayılmaz.

## Toplama ve analiz politikası

- Kanal API ile doğrulanır, resmi uploads playlist kimliği alınır. Keşif mevcut `process-videos` kuyruğunda lease/ownership ve sınırlı concurrency ile çalışır. Yeni ayrı servis veya bağımlılık eklenmedi.
- Playlist sayfaları en fazla 50 video halinde keşfedilir. Her video mevcut yorum ve ayrı yanıt sayfalamasına girer. Keşif checkpoint'i ile oluşturulan video kayıtları aynı transaction içindedir; harici HTTP çağrısı transaction dışındadır.
- İlk büyük arşiv taraması sürerken de 15 dakikada bir ilk uploads sayfası kontrol edilir; yeni video keşfi eski sayfanın cursor'ını silmez. Normal keşif döngüsü tamamlandıktan 15 dakika sonra tekrar başlar.
- İki worker slotunda bir slot keşfe ayrılır, diğeri önce yorum toplamaya verilir; birden fazla uzun kanal arşivi yorum toplamasını bloke etmez. Tek slotta en eski zamanı gelen kaynak seçilir. Lease ve SKIP LOCKED koruması her seçimde korunur.
- Yakın zamanda yayınlanmış videolar ilk hafta saatlik, eski videolar günlük yeniden taranır. Devam eden yorum taramaları 15 saniyelik checkpoint aralıklarıyla sürer. Bunlar çalışma aralıklarıdır; kota ve kuyruk yoğunluğu nedeniyle kesin gecikme garantisi değildir.
- API kotası dolarsa checkpoint korunur ve bir saat sonra tekrar denenir. Dönen sayfa tokenı döngüsü veya 10.000 keşif sayfası sınırı müdahale gerektirir. Özel, silinmiş veya API'nin erişime açmadığı videolar/yorumlar için tamlık iddiası yoktur.

**Geçmiş yalnız kaydedilir; yeni yorumlar analiz edilir.** Kanal ilk eklendiğinde `analysis_after` sabitlenir. Yorumun ilk yayınlanma zamanı bu tarihten sonra ise analiz kuyruğuna girer. Öncesindeki veya eşit zamandaki yorum ve yanıtlar `analysis_excluded=true`, `analysis_status=complete` olarak saklanır; AI sonucu veya alarm uydurulmaz. Eski yoruma sonradan yazılmış yeni bir yanıt analiz edilebilir. Tarihi bilinmeyen kayıt otomatik ücretli analize açılmaz.

Geçmiş ayrımı içerik güncellemesinde, hedef/bağlam yeniden değerlendirmesinde ve retention sonrasında korunur. DB CHECK kuralı geçmiş kaydın pending/processing/retry/dead durumuna geçmesini engeller; worker claim'i ayrıca bu kayıtları dışlar. Arayüz bu kayıtları **Geçmiş kayıt · AI yok** olarak gösterir; **Geçmiş arşivi · AI yok** görünümüyle filtrelenebilir. İnsan incelemesi yapılabilir; arşiv kaydı modelin “inceleme gerekmiyor” kararı gibi gösterilmez.

Kanal, paylaşım/yorum listesindeki hesap filtresinden seçilebilir. Önceden elle izlenen video kayıtları, duraklatma ve ayrı analiz politikaları keşifle ezilmez; otomatik kanal video sayacına yalnız kanalın oluşturduğu kayıtlar dahildir. Yeni yorumların analizi normal Runware kullanımına tabidir; geçmiş arşiv için otomatik LLM isteği yapılmaz.

## Yaşam döngüsü

Kanalı duraklatmak/kaldırmak alt videolarda yeni kaynak okumasını ve devam eden geçersiz lease'in veri yazmasını durdurur. Önceden kuyruğa alınmış analizleri iptal etmez. Videolar, yorumlar ve insan incelemeleri korunur. Tek videonun manuel duraklatması, sonraki kanal keşfiyle kaldırılmaz. Kanal yeniden eklendiğinde ilk analiz başlangıç tarihi korunur.

## Migration ve doğrulama

`0025_youtube_channels.sql` mevcut `watched_videos` kaydına kaynak türü, kanal ilişkisi, uploads playlist ve analiz başlangıcı; `social_items` kaydına geçmiş ayrımı ekler. Mevcut kayıtlar video ve analiz edilebilir olarak kalır; eski izlemelerin davranışı değiştirilmez. Kanal alt kaydı için indeks ve doğrulanan CHECK kuralları eklenmiştir. Önce migration, ardından uygulama/worker sürümü uygulanmalıdır.

`0026_youtube_settings.sql` merkezi YouTube ayarını ekler; mevcut en son resmi YouTube anahtarını şifreli haliyle devralır. Yeni kaynaklarda anahtar kopyalanmaz. Worker sonraki claim'de merkezi anahtarı kullanır; eski kaynak anahtarı yalnız merkezi kayıt yoksa uyumluluk için kullanılır. Ayar kaydı revision/CAS ve transaction içinde audit ile korunur; sır audit/yanıt içine yazılmaz. Token rotation yeni tabloyu da kapsar. Anahtarın değiştirilmesi, operatörün duraklattığı veya hatadan bloke olmuş kaynağı otomatik başlatmaz.

İzole PostgreSQL 17 üzerinde migration ve DB smoke geçti. 184 test, lint ve tip kontrolü başarılı. Regresyonlar; merkezi ayarda eşzamanlı kayıt çakışması ve anahtar yenileme, kanal API kayıt/tekrar/Origin/şifreleme, sayfalı keşif, mevcut pause koruması, kanal filtresi, geçmiş ve yeni yanıt ayrımı, genel invalidation, DB CHECK, eşzamanlı pause, kota sonrası aynı sayfadan devam, token döngüsü, kuyruk ilerlemesi ve uzun arşiv sırasında yeni video keşfini kapsar. Gerçek bir kanalın bütün arşivi bu geliştirme doğrulamasında taranmadı.

Yerel uygulamaya migration uygulanmadan önce DB yedeği alındı. Yetkili HTTP sayfa kontrolünde Hesaplarım ve YouTube video formunda sıfır parola alanı, ayrı kurulum sayfasında Meta/YouTube ayarları ve mevcut anahtarın devralınması doğrulandı. Bu son düzenleme için görsel tarayıcı kontrolü, tarayıcı bağlantısının kullanılamaması nedeniyle tamamlanamadı. Deneme kanalı veya sahte yorum gerçek DB'ye eklenmedi; mevcut LLM seçimi değiştirilmedi.

Rollback için yeni kanal takibini durdurun ve checkpoint'leri koruyun. Geçmiş kayıtların analiz dışında tutulması zorunludur; bu korumayı bilmeyen eski worker'a doğrudan dönmeyin. Yeni kolonları veya arşiv kayıtlarını silerek rollback yapmayın; uyumlu worker sürümü kullanın. Uygulama eski sürüme dönse bile yeni kanal kaynaklarını eski video worker'ına açmayın.

Resmi kaynaklar: [kanal çözümleme](https://developers.google.com/youtube/data/reference/rest/v3/channels/list), [uploads playlist sayfalama](https://developers.google.com/youtube/data/reference/rest/v3/playlistItems/list), [yorum dizileri](https://developers.google.com/youtube/data/reference/rest/v3/commentThreads/list), [yanıtlar](https://developers.google.com/youtube/data/reference/rest/v3/comments/list).
