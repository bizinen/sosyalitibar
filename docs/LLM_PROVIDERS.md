# LLM sağlayıcı bağlantıları

`/settings/llm` ekranından OpenAI, Google Gemini, OpenRouter veya Runware seçilir. Model kimliği serbest metindir; katalog veya model listesi zorunlu tutulmaz. API anahtarı girilip **Kaydet ve etkinleştir** seçildiğinde sonraki analiz ve çeviri çağrıları bu ayarı kullanır. Her kaydetme seçili sağlayıcıyı etkinleştirir; diğer sağlayıcıların kayıtları korunur. Anahtarı boş bırakmak yalnız aynı uç veya seçili sağlayıcının kayıtlı anahtarını kullanır.

Anahtarlar AES-256-GCM ile şifrelenir; panel yalnız kayıt durumunu ve model kimliğini alır. Ayar değişikliği revision kontrolü ve transaction içindeki mevcut advisory lock ile korunur. API yanıtlarına/audit kaydına anahtar yazılmaz. Mevcut özel OpenAI uyumlu URL ve sunucu fallback ayarları korunur; özel URL değişikliğinde tekrar anahtar gerekir.

## Resmî API sözleşmeleri

| Sağlayıcı | Base URL | Model kimliği |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | OpenAI metin modeli kimliği |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` | Gemini metin modeli kimliği |
| OpenRouter | `https://openrouter.ai/api/v1` | Yayıncı/model kimliği |
| Runware | `https://api.runware.ai/v1` | Runware AIR kimliği |

Hepsinde POST `/chat/completions` ve `Authorization: Bearer` kullanılır. OpenAI ve Runware için `max_completion_tokens`, Gemini/OpenRouter için `max_tokens` gönderilir. Bilinen sağlayıcılarda token tavanı en az 8192'dir; görünür yanıtla birlikte reasoning bütçesi için alan bırakır. Bu üst sınır maliyeti etkileyebilir; desteklenen model sınırları ve hesabın kotası sağlayıcıya bağlıdır. Bilinen sağlayıcılara sabit temperature gönderilmez; kısıtlı reasoning modelleriyle parametre uyuşmazlığı önlenir. Özel uçların önceki parametreleri korunur.

JSON modu ve yerel strict Zod sözleşmesi korunur. OpenRouter'da `require_parameters: true` ile JSON parametresini destekleyen uçlar istenir. Model metin, sistem talimatı ve JSON çıktısı sunmalıdır; görüntü, embedding veya yalnız başka API kullanan modeller bu akışa uygun değildir. Model bulunamaması, erişim/kota, güvenlik nedeniyle engelleme, kesilmiş yanıt ve geçersiz çıktı başarı kabul edilmez. Çeviri ve eski ayrıntılı analizde retry/fallback korunur. Yeni toplu ön eleme yalnız seçili modeli kullanır; sınırları ve hata davranışı için [toplu analiz akışı](BATCH_TRIAGE.md) geçerlidir.

- [OpenAI Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Gemini OpenAI uyumluluğu](https://ai.google.dev/gemini-api/docs/openai)
- [OpenRouter provider routing](https://openrouter.ai/docs/guides/routing/provider-selection)
- [Runware compatible APIs](https://runware.ai/docs/tools/compatible-apis)

## Migration ve geri dönüş

`0020_llm_provider_profiles.sql` mevcut `primary` kaydını silmeden izin verilen kayıt kimliklerini genişletir ve bilinen sağlayıcıya ait mevcut ayarı ayrı profile kopyalar. Yeni tablo/sütun veya veri silme yoktur. Önce migration, sonra uygulama yayını yapılır. Eski uygulama yalnız `primary` okuduğundan kod geri dönüşü genişletilmiş şemayla çalışabilir; provider kayıtlarını silmek veya constraint'i daraltmak geri dönüş için gerekli değildir.

Migration yerel veritabanına uygulandı (`applied 0020_llm_provider_profiles.sql`). Sağlayıcı çağrı sözleşmeleri ve geçersiz analiz reddi için mock test senaryoları eklendi; çalıştırılmadı. Bu değişiklikte canlı sağlayıcı çağrısı, test, lint, typecheck, build veya tarayıcı doğrulaması çalıştırılmadı. Kaydetmek anahtarın geçerli olduğunu veya bağlantının denenmiş olduğunu göstermez.
