# Meta bağlantısını panelden kurma

Hesaplarım → Meta uygulaması ve bağlantı kurulumu alanından App ID, App Secret, panelin dışarıdan erişilebilir HTTPS origin adresi, Graph sürümü ve Webhook Verify Token kaydedilir. Facebook Login for Business kullanılıyorsa Configuration ID de girilir. Bu yapılandırma **User access token** üretmelidir; mevcut `/me/accounts` keşfi System User token için tasarlanmamıştır. Klasik Facebook Login için Configuration ID boş bırakılır.

Panel OAuth redirect, webhook callback ve App Domains değerlerini üretir. Bu adresleri Meta Dashboard'a ekle; Webhooks doğrulamasında kayıtlı Verify Token'ı kullan. Page `feed` ve Instagram `comments` alanlarını etkinleştir. Page aboneliği ayrıca OAuth callback sırasında `/{page-id}/subscribed_apps` üzerinden istenir. Adres girmek DNS, tunnel, TLS veya reverse proxy kurulumu yapmaz. Proxy public Host başlığını korumalıdır.

İzinler: `pages_show_list`, `pages_read_engagement`, `pages_read_user_content`, `pages_manage_metadata`, `instagram_basic`, `instagram_manage_comments`. Configuration ID varsa izinler Meta'daki yapılandırmaya eklenir; OAuth URL'sine ayrıca `scope` eklenmez. Facebook Login için Instagram Business/Creator hesabının Facebook sayfasına bağlı olması gerekir. Instagram Login'in `instagram_business_*` izinleri bu akışa karıştırılmaz. Meta Dashboard'da kendi hesaplarını, uygulama rollerini ve her iznin erişim şartlarını tamamla; dış hesaplara yönelik Advanced Access/App Review gereksinimleri ayrıca değerlendirilir.

Kaydettikten sonra HTTPS panel adresinde giriş yap ve Meta ile hesap bağla düğmesine bas. Facebook hesabının ve Page'lerin access tokenları OAuth üzerinden alınır, app/token kimliği denetlenir ve AES-256-GCM ile şifreli saklanır. App Secret istemciye geri gönderilmez. Verify Token yalnızca yöneticinin kopyalama isteğinde alınır. Eksik izinler, token sağlığı ve Page abonelik hataları bağlantı durumuna yansır. Yorum silme/gizleme yapılmaz.

`0014_meta_settings.sql` ve `0015_meta_login_config.sql` yerel veritabanına uygulandı. Diğer ortamlarda normal migration runner kullanılmalıdır. Ayarlar revision kontrolü ve transaction ile kaydedilir; değişiklikler bekleyen OAuth state kayıtlarını geçersiz kılar. Mevcut yetkilendirme/bağlantı kayıtları varken App ID değişikliği engellenir. Uygulama değiştirmek ayrı, kontrollü bir geçiş gerektirir.

Kaydetme, HTTPS ulaşılabilirliğini veya Meta API bağlantısını denemez. Gerçek OAuth, FB/IG webhook, token revoke ve reconciliation kabul testleri ayrıca yapılmalıdır. Bu değişiklikte test/lint/typecheck/build çalıştırılmadı. Tarayıcı incelemesi için Chrome bağlantısı `Debugger unattached` hatası verdi; yeni formun görsel doğrulaması tamamlanmadı.

1 Ekim 2026'da erişilen birincil kaynaklar:

- [Facebook Login for Business](https://developers.facebook.com/docs/facebook-login/facebook-login-for-business/): manuel OAuth için Configuration ID ve token türü.
- [Page Webhooks](https://developers.facebook.com/docs/pages-api/webhooks-for-pages/): Page token, `pages_manage_metadata` ve `subscribed_apps`.
- [Instagram yorum yönetimi](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login/comment-moderation/): izinler, webhook alanları ve Standard/Advanced Access.
- [Meta resmi Instagram koleksiyonu](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-db99ce99-bf76-475c-8b76-718576c11cae): profesyonel Instagram hesabı, bağlı Page ve Page token keşfi.

Meta Developer sayfaları web aracında erişim hatası verdi; ilk üç belgenin HTML içeriği doğrudan HTTPS üzerinden okunabildi. Graph sürümü otomatik yükseltilmedi; panelde mevcut yapılandırılmış sürüm gösterilir.
