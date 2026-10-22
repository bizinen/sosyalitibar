import { BrandMark, UiIcon } from "@/app/components/UiIcon";

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const p = await searchParams;
  return <main className="login-wrap"><div className="login-layout"><section className="login-story"><div className="brand"><BrandMark /><span>Sosyal İtibar</span></div><h1>Yorumların arasında<br />netliği bul.</h1><p>Hesapların, farklı dillerdeki yorumların ve AI değerlendirmeleri aynı çalışma alanında. Öncelikleri gör, incelemeyi sen yönet.</p><div className="login-visual" aria-hidden="true"><span className="flow-icon"><UiIcon name="accounts" size={26} /></span><span className="flow-connector" /><span className="flow-icon ai"><UiIcon name="spark" size={26} /></span><span className="flow-connector" /><span className="flow-icon review"><UiIcon name="shield" size={26} /></span></div></section><section className="login-card">
    <div className="badge blue" style={{marginBottom:18}}>Kişisel çalışma alanın</div>
    <h2>Tekrar hoş geldin.</h2>
    <p className="muted small">Yorum akışını incelemek için giriş yap.</p>
    {p.error ? <div className="notice" role="alert">Kullanıcı adı veya şifre hatalı. Tekrarlanan başarısız girişler geçici olarak engellenir.</div> : null}
    <form action="/api/auth/login" method="post" className="form-grid">
      <label><div className="small muted">Kullanıcı adı</div><input className="input" name="username" autoComplete="username" required /></label>
      <label><div className="small muted">Şifre</div><input className="input" name="password" type="password" autoComplete="current-password" required /></label>
      <button className="btn primary" type="submit">Giriş yap</button>
    </form>
  </section></div></main>;
}

