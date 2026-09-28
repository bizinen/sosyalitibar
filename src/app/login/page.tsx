export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const p = await searchParams;
  return <main className="login-wrap"><section className="login-card">
    <div className="badge blue" style={{marginBottom:14}}>Yönetim</div>
    <h1>Sosyal İtibar</h1>
    <p className="muted">Facebook ve Instagram yorum izleme paneline giriş yap.</p>
    {p.error ? <div className="notice">Kullanıcı adı veya şifre hatalı. Tekrarlanan başarısız girişler geçici olarak engellenir.</div> : null}
    <form action="/api/auth/login" method="post" className="form-grid">
      <label><div className="small muted">Kullanıcı</div><input className="input" name="username" autoComplete="username" required /></label>
      <label><div className="small muted">Şifre</div><input className="input" name="password" type="password" autoComplete="current-password" required /></label>
      <button className="btn primary" type="submit">Giriş yap</button>
    </form>
  </section></main>;
}
