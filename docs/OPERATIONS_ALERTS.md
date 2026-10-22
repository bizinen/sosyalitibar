# Pipeline izleme ve müdahale

`ops/prometheus-alerts.yml` mevcut `/api/metrics` isimleriyle hazırlanmış alarm kurallarıdır. Kurulum ve doğrulama yapılmadı; dosyanın eklenmesi alarm teslimatını etkinleştirmez.

Prometheus scrape job adını `sosyal-itibar`, metrics path'i `/api/metrics` olarak ayarlayın. Bearer kimlik bilgisini `CRON_SECRET` içeren secret dosyasından okuyun (`authorization.credentials_file`); değeri repo veya scrape URL'sine yazmayın. Target adresini dağıtımdaki app adresine göre tanımlayın. Rule dosyasını Prometheus `rule_files` listesine ekleyin; bildirim alıcıları mevcut Alertmanager kurulumunda ayrıca tanımlanmalıdır. Secret ve scrape erişimi yalnız izleme servisinde olmalıdır.

Eşikler başlangıç operasyon değerleridir: webhook/teslimat kuyruğunda 120 saniye, analiz kuyruğunda 300 saniye runnable iş gecikmesi. Metrik ileri zamana planlanan retry işlerini gecikme hesabına dahil etmez. Kuyruk sayıları anlık gauge değerleridir. LLM latency metriği tüm saklanan analizler üzerinden hesaplandığından bu dosyada rolling latency SLO alarmı olarak kullanılmaz.

| Alarm | İlk müdahale |
|---|---|
| Metrics unavailable | App ve DB erişimini, scrape ağ yolunu ve Bearer secret eşleşmesini inceleyin. |
| Webhook backlog | Operations ekranında webhook hata/lease kayıtlarını, worker sürecini ve Meta token durumunu inceleyin. |
| Analysis backlog | LLM ayarlarını, timeout/rate-limit hatalarını ve workerın analysis görevini inceleyin. |
| Alert delivery backlog | Alerts ekranındaki HTTP/timeout nedenini inceleyin; receiver HMAC ve idempotency contract'ını koruyun. |
| Dead-letter | Kaydın hatasını giderin; yalnız ilgili kayıtları yeniden kuyruğa alın. |
| Revoked connection | Yeniden OAuth authorization yapın; disabled kaynağı izinsiz açmayın. |

Teslimat timeout'u receiver'ın isteği işlemediğinin kanıtı değildir. Requeue sırasında aynı idempotency anahtarıyla gelen teslimatı receiver tek işlem olarak ele almalıdır. Geçersiz eski revision alarmını yeni bir alarmmış gibi yeniden göndermeyin.

İzleme servisi devre dışı kalırsa kendi kuralları bildirim üretemez; Prometheus/Alertmanager sağlığı dağıtımın mevcut dış izleme mekanizmasında ayrıca izlenmelidir.
