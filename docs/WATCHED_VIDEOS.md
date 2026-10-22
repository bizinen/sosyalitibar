# İzlenen videolar

Panel: `/settings/videos`. Bir kişi/kurum veya hesap sahipliği seçimi istenmez. YouTube video/Shorts/canlı yayın bağlantısı ile Instagram/Facebook paylaşım bağlantısı ayrı izleme kayıtlarına dönüştürülür.

## Erişim

- YouTube: Google Cloud projesinde YouTube Data API v3 etkin olmalı. API anahtarı formdan girilir ve AES-256-GCM ile saklanır. Son kayıtlı YouTube anahtarı yeni video için boş bırakılan anahtarda kullanılabilir. Her video kendi şifrelenmiş anahtar kopyasını tutar. API anahtarı LLM/Gemini anahtarı olarak varsayılmaz.
- Instagram/Facebook: Aktif Meta bağlantısı yalnız erişim yetkisi kaynağıdır. Bağlantının hesabı harici yayıncı veya korunan kişi olarak kaydedilmez. Instagram'da sayısal medya kimliği gereklidir; kısa koddan API kimliği uydurulmaz. Facebook'ta bağlantıdan kimlik çıkarılamazsa Graph paylaşım/video kimliği gerekir.
- Resmî Meta API her üçüncü taraf yayının yorumlarına erişim sağlamaz. Yetkisiz kaynak `blocked` olur; boş yorum veya başarılı tarama gibi gösterilmez.
- Apify: Instagram/Facebook için formdaki **Yorum erişimi → Apify** seçilir. API tokenı panelden girilir ve mevcut AES-256-GCM katmanında saklanır; YouTube anahtarıyla karıştırılmaz. Sayısal Meta medya kimliği veya hesap yetkilendirmesi gerekmez. Apify'nin bakımını yaptığı `apify/instagram-comment-scraper` ve `apify/facebook-comments-scraper` kullanılır. Başka bir Actor veya serbest endpoint seçimi yoktur.

## Apify taraması ve bütçe

Apify hesabı ve Actor erişimi/bakiye gerekir. Formdan yorum sınırı, tarama aralığı ve USD cinsinden tarama başına bütçe sınırı girilir. Başlangıç değerleri 1.000 üst yorum, 60 dakika, 1 USD'dir. Her başarılı taramadan sonra seçili aralıkta yeni ücretli tarama başlar; yorumlar tekrar geldiklerinde ingestion kimlikleriyle birleştirilir. Ücretlendirme sağlayıcıya aittir; `maxTotalChargeUsd` sınırı Actor başlatma isteğine iletilir, aylık toplam bütçe sınırı değildir. Yanıtlar ayrıca istenir ve üst yorum limitini aşabilir.

Yalnız herkese açık ve sağlayıcının erişebildiği yorumlar alınır. Instagram giriş yapmamış kullanıcıya görünen içerikle sınırlanabilir; Facebook yorum/reply kapsamı da gönderi ve görünürlük koşullarına bağlıdır. Son tarama tamamlandı ifadesi tüm platform yorumlarının alındığını değil, başarılı Actor dataset'inin yerel aktarımının bittiğini belirtir. Sıfır sonuç açıkça sıfır sonuç olarak gösterilir; yorum olmadığı sonucu çıkarılmaz.

Tarama asenkron başlatılır, Run ID ve dataset ilerlemesi şifreli checkpoint ile korunur. Yalnız `SUCCEEDED` çalışma sonuçları sayfalanır; başarısız Actor başarılı tarama sayılmaz. Sağlayıcı hata satırları yorum diye kaydedilmez. Tek tarama boyunca sabit kaynak okuma sürümü, eski dataset'in daha yeni ingestion verisini ezmesini önler. Yanıtların ebeveyni mevcutsa korunur; eksik ebeveyn bağlamı `context_incomplete` olur. Instagram'ın sunduğu doğrulanabilir doğrudan yorum linkleri ve Facebook yorum linkleri inceleme ekranına aktarılır.

Actor POST isteği öncesinde kalıcı `starting` işareti yazılır. Ağ hatası/işçi çökmesiyle çalışma başlatma sonucu belirsizse otomatik yeni ücretli POST yapılmaz; kayıt bloke olur. Panelde Run ID girilerek aynı çalışma kurtarılabilir. Actor kimliği, çalışma başlangıç zamanı ve INPUT içindeki tek kaynak URL'si doğrulanmadan sonuç aktarılmaz. Operatör ayrıca bütçe uyarısını kabul ederek yeni tarama başlatabilir.

Duraklatma/kaldırma yerel lease'i geçersiz kılar; bilinen, doğrulanmış, devam eden Apify çalışması transaction dışında iptal edilmeye çalışılır. İptal sonucuna erişilemiyorsa panel Console kontrolü gerektiğini açıklar. POST sonucu henüz bilinmiyorsa otomatik iptal garantisi yoktur. Duraklatılmış bir çalışmanın iptal edilmesi nedeniyle yeniden başlatma gerekebilir. Anahtarlar kayıt başına tutulur; yeni token mevcut kayıtlara kendiliğinden uygulanmaz. Mevcut kaydı yeni tokenla yeniden eklemek için önce izlemeyi kaldırmak gerekir; geçmiş yorumlar korunur.

Apify Instagram yorum verisi paylaşım açıklamasını garanti etmez. İsteğe bağlı yayıncı adı/paylaşım bağlamı formdan verilebilir; eksik bağlam LLM'e eksik olarak aktarılır. Facebook `postTitle` gelirse metin bağlamı olarak kullanılır. Video sesi/görüntüsü transkribe edilmez.

## Kuyruk ve yorum akışı

`scripts/scheduler.mjs`, `/api/jobs/process-videos` işini çalıştırır. Kayıt ekleme ve **Yorumları al** yalnız kuyruğa alır; webhook isteğine ağ/LLM işi eklenmez. Başarılı tam tarama sonrası 10 dakika beklenir. Devam eden sayfalar bir sonraki worker turunda sürdürülür.

Kaynaklar `FOR UPDATE SKIP LOCKED` ile claim edilir. En fazla iki kaynak ve `SYNC_CONCURRENCY` sınırı kullanılır. Lease kimliği kayıt yazımı ve checkpoint'te doğrulanır; sayfa içindeki uzun DB işlemlerinde lease yenilenir. Sayfalama ilerlemesi (Meta'nın token içerebilen URL'leri dahil) şifreli saklanır. Kalıcı hata durumu, sınırlı retry, kota beklemesi ve manuel yeniden deneme vardır.

YouTube üst yorumları `commentThreads.list`, yanıtlar ayrıca `comments.list` ile sayfalanır. Meta'da mevcut Graph yorum/yanıt okuyucuları kullanılır. Başlık/açıklama, kaynak bağlantısı, kanal adı mevcutsa ve yazar bilgileri yorumla saklanır. Aynı platform/yorum kimliği mevcut ingestion üzerinden birleştirilir; düzenlenen metin önceki analizi geçersiz kılar. Yorumlar mevcut analiz ve alarm kuyruklarına ayrı olarak girer.

Harici yayınlarda Meta erişim bağlantısının `connection_targets` eşleştirmesi kullanılmaz. Kaynak metni ve yayıncı bağlamı LLM'e verilir; belirsiz hedef bağlamı inceleme gerektirir. Mevcut korunan hedef tanımları/LLM sözleşmesi bu değişiklikte değiştirilmedi.

İzlemeyi kaldırma soft delete'tir; yorum ve insan incelemesi geçmişi silinmez. Yorum ekranında YouTube filtresi ve videoya göre filtre vardır. YouTube yorum bağlantıları `lc` ile kaynak platforma açılır. Kaynak video kaydı pause/remove olunca eski worker yeni yorum yazamaz.

## Uygulama ve sınırlar

`0021_watched_videos.sql` ve `0022_watched_video_provider.sql` yerel veritabanına uygulandı. Deploy sonrası scheduler/worker yeniden başlatılmalıdır; eski process yeni iş listesini kendiliğinden yüklemez. Video eklemek kaynak erişiminin doğrulandığını göstermez. Worker çalışmazsa kayıt ilk tarama bekliyor olarak kalır.

Bu sürüm alınabilen yorumları/yanıtları ve metin güncellemelerini toplar. API'den kaybolan yorumları otomatik silinmiş olarak işaretlemez. Video görseli/sesi transkribe edilmez; LLM yalnız alınan metin bağlamını görür. Instagram medya kimliği ve API'den dönen permalink girilen URL ile eşleştirilir; kısa koddan medya kimliği keşfi yoktur. Facebook Video node'u Post node'unun `message` alanına sahip olmadığından doğrudan video kimliğinde metin bağlamı eksik sayılır ve insan incelemesi istenir. Meta yayıncı adı erişimi bu sürümde yoktur; arayüz genel platform kaynak etiketini kullanır. `fb.watch` kısa bağlantılarının kaynak kimliğiyle eşleşmesini çözümleyen yönlendirme entegrasyonu yoktur.

Canlı platform çağrısı, test, typecheck, lint, build veya tarayıcı doğrulaması çalıştırılmadı. URL kimliği, kaynak sınırları, sahte Instagram ID üretmeme, sağlayıcı hata satırları, yanıt ebeveynleri, doğrudan yorum bağlantıları ve güvenli kaynak eşleşmesi için test senaryoları eklendi; çalıştırılmadı.

Resmî kaynaklar: [YouTube yorum thread listesi](https://developers.google.com/youtube/v3/docs/commentThreads/list),
[YouTube yanıt listesi](https://developers.google.com/youtube/v3/docs/comments/list),
[Video metadatası](https://developers.google.com/youtube/v3/docs/videos/list).

Apify kaynakları: [Instagram Actor ve kapsam sınırları](https://apify.com/apify/instagram-comment-scraper),
[Instagram giriş sözleşmesi](https://apify.com/apify/instagram-comment-scraper/input-schema),
[Instagram çıktı sözleşmesi](https://apify.com/apify/instagram-comment-scraper/output-schema),
[Facebook Actor](https://apify.com/apify/facebook-comments-scraper),
[Facebook giriş sözleşmesi](https://apify.com/apify/facebook-comments-scraper/input-schema),
[Facebook çıktı sözleşmesi](https://apify.com/apify/facebook-comments-scraper/output-schema),
[Actor başlatma/bütçe API](https://docs.apify.com/api/v2/actors-runs-post),
[Dataset sayfalama API](https://docs.apify.com/api/v2/dataset-items-get).
