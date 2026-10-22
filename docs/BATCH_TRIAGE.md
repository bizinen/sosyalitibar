# Toplu yorum ön elemesi

Yeni yorum kuyruğu seçili sağlayıcı/model ile normal bir Chat Completions isteğinde
en fazla 20 yorum gönderir (AI ayarlarında 1–50). Sağlayıcıların saatler sürebilen
asenkron Batch API'si kullanılmaz. Her grubun paylaşıma ait ortak bağlamı bir kez,
yorum ve varsa üst yorum metinleri ayrı kimliklerle gönderilir.

Çıktı yalnız `{"results":[{"id":"c1","label":"insan_incelemesi_gerekli"}]}` biçimindedir.
Kimlikler istek içinde üretilir; kalıcı yorum kimliği ve revizyonu sunucu tarafından
eşleştirilir. Üç etiket:

- `inceleme_gerekmiyor`: tüm yorumlarda kalır.
- `insan_incelemesi_gerekli`: insan inceleme görünümüne girer.
- `acil_inceleme`: insan incelemesine ve mevcut imzalı, idempotent alarm kuyruğuna girer.

Etiket kaydında kategori, puan, ton, hedef güveni veya gerekçe uydurulmaz; bu
sütunlar NULL saklanır. Eski ayrıntılı analizler aynı tabloda okunmaya devam eder.
İnsan değerlendirmesi ve inceleme geçmişi AI sonucundan ayrıdır.

## Hata ve maliyet sınırları

Grup varsayılan olarak 24.000 serileştirilmiş veri karakteriyle sınırlıdır.
Bu bir token/para sınırı değildir; sabit talimatlar ayrıca gönderilir. Sığmayan
grup bölünür; tek başına sığmayan yorum kesilmeden, model çağrısı yapılmadan insan
incelemesine ayrılır. Metinsiz yorumlar da yerel olarak incelemeye ayrılır.

Hazırlanan yorumlar en fazla 3 saniye birbirini bekler; grubun tamamı hazırsa
daha erken gönderilir. Bu süre kaynak taraması, worker aralığı, kuyrukta bekleme
ve model yanıt süresini kapsamaz. Özellikle periyodik video taraması nedeniyle
platforma yazıldığı anda tespit garantisi yoktur.

Eksik/tekrarlanan kimlikler yeniden denenirken geçerli sonuçlar tekrar gönderilmez.
Bilinmeyen kimlik, fazladan alan, hatalı JSON ve kesilmiş yanıt kabul edilmez.
Tamamen geçersiz grup en fazla iki alt gruba ayrılarak bir ek tur denenir.
Ağ/HTTP hataları aynı istekte alt gruplara çoğaltılmaz; mevcut gecikmeli kuyruk
tekrarına bırakılır. Kuyruk en fazla 5 denemeden sonra dead-letter durumuna geçer.
Her hazırlanan grup için toplam sağlayıcı süre bütçesi istek süresi sınırının
üç katıdır. Toplu ön elemede pahalı yedek modele otomatik geçiş yoktur.

Provider token kullanım bilgisi sonuçlarda grup kapsamıyla saklanır; bu kayıtlar
başarısız isteklerin tamamını veya sağlayıcı faturasını temsil etmez.
Değişmemiş, tamamlanmış yorumlar tekrar tarandı diye yeniden analiz edilmez.
Yorum veya kaynak bağlamı değişikliği mevcut revizyon geçersizleştirmesini kullanır.
Model çağrıları transaction dışında kalır; kayıt ve alarm üretimi revizyon/kilit
sahipliğiyle korunur. Tek grup içindeki sağlayıcı istekleri sıralıdır.

## AI ayarları

`/settings/llm` içinde etiketleme talimatı, izlenen kişi bağlamı, ortak kaynak
bağlamı, çeviri talimatı ve korunmuş eski ayrıntılı analiz talimatı düzenlenebilir.
JSON sözleşmesi ve kaynak içeriklerini talimat olarak uygulamama koruması kodda
sabittir. Paylaşım ve üst yorumun gerçek metni veri olarak ayrıca eklenir.

Ayar kaydı iyimser revizyon kontrolü ve transaction kilidiyle korunur; eski
ekran yeni kaydı ezemez. Talimatlar audit kaydında, sürüm/hash analiz kaydında
tutulur. Yeni ayarlar sonraki gruplara uygulanır; işlemdeki grup aldığı ayar
görüntüsüyle tamamlanabilir. Kaydetme geçmiş yorumları topluca yeniden analize
göndermez. Çeviri önbelleği etkin çeviri talimatının hash'iyle eşleştirilir.

## Şema, dağıtım ve durum

`0024_batch_triage.sql` önce uygulanmalıdır. Yerel veritabanına bu çalışma
sırasında uygulandı. Yeni tablo/sütunlar eklendi, ayrıntılı alanlar nullable
yapıldı ve etiket kayıtlarının tutarlılığı CHECK ile korundu; eski veriler silinmedi.
Eski uygulamaya kör geri dönüş uygun değildir: etiketli kayıtların ayrıntılı
alanları NULL olduğundan eski UI uyumlu olmayabilir. Geri dönüşte etiket okuyabilen
kod korunmalı; veri silerek veya sahte puan ekleyerek NOT NULL geri getirilmemeli.

Toplu kimlik eşleştirme, kısmi çıktı, truncation, HTTP hata, giriş sınırı, bekleme,
bağlam eksikliği ve prompt hash testleri eklendi. PostgreSQL senaryolarına etiket/
alarm tutarlılığı ve ayar revizyonu eklendi. Kullanıcının talimatı gereği test,
lint, typecheck, build, tarayıcı veya canlı sağlayıcı doğrulaması çalıştırılmadı.
Kod incelemesi yapıldı; model doğruluğu, tasarruf oranı ve üretim E2E başarısı
ölçülmüş kabul edilmemelidir.
