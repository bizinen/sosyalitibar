"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";

export function MetaSettingsForm({ appId, loginConfigId, publicOrigin, graphVersion, hasSecret, hasVerifyToken, revision, scopes }: { appId: string; loginConfigId: string; publicOrigin: string; graphVersion: string; hasSecret: boolean; hasVerifyToken: boolean; revision: number; scopes: string[] }) {
  const router = useRouter();
  const [id, setId] = useState(appId);
  const [configId, setConfigId] = useState(loginConfigId);
  const [origin, setOrigin] = useState(publicOrigin.startsWith("https://") ? publicOrigin : "");
  const [graph, setGraph] = useState(graphVersion);
  const [secret, setSecret] = useState("");
  const [token, setToken] = useState("");
  const [version, setVersion] = useState(revision);
  const [savedSecret, setSavedSecret] = useState(hasSecret);
  const [savedToken, setSavedToken] = useState(hasVerifyToken);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  let address = "";
  try { const url = new URL(origin); if (url.protocol === "https:" && !url.username && !url.password && url.pathname === "/" && !url.search && !url.hash) address = url.origin; } catch { /* Incomplete input has no callback preview. */ }

  async function copy(value: string, label: string) {
    try { await navigator.clipboard.writeText(value); setMessage(`${label} kopyalandı.`); setError(""); }
    catch { setError("Panoya erişilemiyor. Alanın içeriğini seçip elle kopyalayabilirsin."); }
  }
  async function copyToken() {
    if (token) return copy(token, "Doğrulama anahtarı (henüz kaydedilmemiş olabilir)");
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/settings/meta", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.verifyToken) throw new Error("Kayıtlı doğrulama anahtarı alınamadı.");
      setToken(data.verifyToken);
      await copy(data.verifyToken, "Kayıtlı doğrulama anahtarı");
    } catch { setError("Kayıtlı doğrulama anahtarı alınamadı. Sayfayı yenileyip tekrar dene."); }
    finally { setBusy(false); }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault(); setBusy(true); setMessage(""); setError("");
    try {
      const response = await fetch("/api/settings/meta", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ appId: id, loginConfigId: configId, appSecret: secret, verifyToken: token, publicOrigin: origin, graphVersion: graph, revision: version }) });
      const data = await response.json();
      const errors: Record<string, string> = { conflict: "Ayarlar başka bir ekranda değişti. Sayfayı yenile.", public_https_required: "Dışarıdan erişilen HTTPS adresini gir. Localhost veya adresin sonuna bir yol ekleme.", app_secret_required: "Bu uygulamanın App Secret değerini gir.", verify_token_required: "En az 16 karakterli doğrulama anahtarı gir veya oluştur.", app_change_requires_disconnect: "Kayıtlı Meta hesapları varken App ID değiştirilemez. Farklı uygulamaya geçiş, mevcut yetkilendirmelerin ayrıca kaldırılmasını gerektirir." };
      if (!response.ok) throw new Error(errors[data.error] || "Kaydedilemedi. Alanları kontrol edip tekrar dene.");
      setVersion(data.revision); setSavedSecret(true); setSavedToken(true); setSecret(""); setToken("");
      setMessage("Ayarlar kaydedildi. Aşağıdaki adresleri ve kayıtlı doğrulama anahtarını Meta paneline ekledikten sonra hesap bağlayabilirsin."); router.refresh();
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Kaydedilemedi."); }
    finally { setBusy(false); }
  }
  const callbacks = [
    { label: "Valid OAuth Redirect URI", value: address ? `${address}/api/meta/callback` : "" },
    { label: "Webhook Callback URL", value: address ? `${address}/api/webhooks/meta` : "" },
    { label: "App Domains", value: address ? new URL(address).hostname : "" },
  ];
  return <div className="meta-setup">
    <p className="small muted">Facebook Login ile sayfalarını ve onlara bağlı Instagram Business / Creator hesaplarını bağla. Kullanıcı ve sayfa access tokenları izin verdiğinde otomatik alınır; şifreli saklanır.</p>
    <form onSubmit={save} aria-busy={busy}><fieldset disabled={busy} className="llm-fields">
      <label><span className="small muted">Facebook Login for Business · Configuration ID</span><input className="input" inputMode="numeric" pattern="[0-9]*" maxLength={64} value={configId} onChange={(e) => setConfigId(e.target.value)} placeholder="Facebook Login for Business → Configurations" /><span className="small muted">Business Login için User access token yapılandırması oluştur. Klasik Facebook Login kullanıyorsan boş bırak.</span></label>
      <label><span className="small muted">Meta App ID</span><input className="input" required inputMode="numeric" pattern="[0-9]+" maxLength={64} value={id} onChange={(e) => setId(e.target.value)} placeholder="Meta uygulama kimliği" /></label>
      <label><span className="small muted">App Secret {savedSecret ? "· kayıtlı" : "· gerekli"}</span><input className="input" type="password" autoComplete="new-password" required={!savedSecret} minLength={16} maxLength={4096} value={secret} onChange={(e) => setSecret(e.target.value)} placeholder={savedSecret ? "Boş bırakırsan mevcut değer korunur" : "Settings → Basic → App Secret"} /></label>
      <label><span className="small muted">Panelin HTTPS adresi</span><input className="input" type="url" required maxLength={500} value={origin} onChange={(e) => setOrigin(e.target.value)} placeholder="https://panel.alanadin.com" /><span className="small muted">Bu uygulamaya yönlenen alan adı veya tunnel adresi.</span></label>
      <label><span className="small muted">Graph API sürümü</span><input className="input" required pattern="v[0-9]+\.[0-9]+" maxLength={12} value={graph} onChange={(e) => setGraph(e.target.value)} /><span className="small muted">Meta uygulamanın desteklediği sürümü kullan.</span></label>
      <label><span className="small muted">Webhook Verify Token {savedToken ? "· kayıtlı" : "· gerekli"}</span><input className="input" type="password" autoComplete="new-password" required={!savedToken} minLength={16} maxLength={256} value={token} onChange={(e) => setToken(e.target.value)} placeholder={savedToken ? "Boş bırakırsan mevcut anahtar korunur" : "Kendin belirle veya güvenli anahtar oluştur"} /><span className="meta-token-actions"><button type="button" className="btn" onClick={() => { setToken(Array.from(crypto.getRandomValues(new Uint8Array(32)), (v) => v.toString(16).padStart(2, "0")).join("")); setMessage("Yeni doğrulama anahtarı oluşturuldu. Kullanmak için kaydet."); }}>Anahtar oluştur</button><button type="button" className="btn" disabled={!token && !savedToken} onClick={copyToken}>Anahtarı kopyala</button></span></label>
      <p className="small muted">App Secret ve doğrulama anahtarı veritabanında şifrelenir. Verify Token, webhook adresini doğrulamak için senin belirlediğin anahtardır; access token değildir. Değiştirirsen Meta panelinde de güncelle.</p>
      {error ? <div className="notice" role="alert">{error}</div> : null}
      {message ? <p className="small" role="status">{message}</p> : null}
      <button type="submit" className="btn primary">{busy ? "Kaydediliyor…" : "Bağlantı ayarlarını kaydet"}</button>
    </fieldset></form>
    <div className="meta-dashboard"><h3>Meta paneline eklenecek bilgiler</h3><p className="small muted">Adresler formdaki HTTPS alanından üretilir. Önce ayarlarını kaydet. Adres girmek uygulamayı internete açmaz; alan adı veya tunnel bu sunucuya erişebilmelidir.</p><div className="form-grid">{callbacks.map((item) => <label key={item.label}><span className="small muted">{item.label}</span><span className="meta-copy-row"><input className="input" readOnly value={item.value} placeholder="Önce HTTPS adresini gir" /><button className="btn" type="button" disabled={!item.value} onClick={() => copy(item.value, item.label)}>Kopyala</button></span></label>)}</div>
    <ol className="meta-steps"><li><a className="text-link" href="https://developers.facebook.com/apps/" target="_blank" rel="noreferrer">Meta uygulama panelini aç</a>. App ID ve App Secret değerlerini buraya gir.</li><li>Facebook Login ayarlarına yukarıdaki OAuth adresini birebir ekle. İzin akışını kullanacak Facebook hesabına uygulama rolü ve ilgili sayfalara erişim ver. Instagram hesabının profesyonel ve sayfaya bağlı olduğundan emin ol.</li><li>Webhooks bölümünde Callback URL ve aynı Verify Token ile doğrulama yap. Page için <strong>feed</strong>, Instagram için <strong>comments</strong> alanlarını etkinleştir. Sayfa aboneliği hesap bağlama sırasında ayrıca istenir.</li><li>Aşağıdaki izinleri Meta uygulamanda etkinleştir. Meta’nın gösterdiği erişim seviyesi, uygulama incelemesi ve işletme doğrulaması gereksinimlerini tamamla.</li><li>Kaydettikten sonra paneli HTTPS adresinden açıp giriş yap; “Meta ile hesap bağla” ile hesaplarını seç ve izin ver.</li></ol>
    <p className="small muted">Configuration ID kullanıyorsan bu izinleri Meta’daki yapılandırmaya ekle ve token türünü User access token seç. İzinler o yapılandırmadan alınır. System User token ve doğrudan Instagram Login bu bağlantı akışının kapsamında değildir.</p><p className="small muted">Kendi yönettiğin ve Meta App Dashboard’a eklediğin Instagram profesyonel hesaplarında Standard Access kullanılabilir. Diğer hesaplar için Advanced Access gerekir; her izin için Meta panelindeki koşulları ayrıca kontrol et.</p><div className="meta-scopes">{scopes.map((scope) => <span className="badge" key={scope}>{scope}</span>)}</div><p className="small muted">Bağlantı durumu ve token izinleri hesap kartlarında görünür. Bu akış yorum analizi ve alarm içindir. <a className="text-link" href="https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api?entity=request-23987686-db99ce99-bf76-475c-8b76-718576c11cae" target="_blank" rel="noreferrer">Meta’nın resmi Instagram API rehberi</a></p>
    </div>
  </div>;
}
