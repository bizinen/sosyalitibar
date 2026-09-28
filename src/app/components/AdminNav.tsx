export function AdminNav() {
  return <div className="topbar">
    <div className="topbar-inner">
      <a className="brand" href="/">Sosyal İtibar</a>
      <nav className="nav" aria-label="Yönetim">
        <a href="/">İnceleme</a>
        <a href="/settings/targets">Hedefler</a>
        <a href="/settings/meta">Meta bağlantıları</a>
        <a href="/settings/alerts">Alarmlar</a>
        <a href="/settings/operations">Operasyon</a>
        <form action="/api/auth/logout" method="post"><button type="submit">Çıkış</button></form>
      </nav>
    </div>
  </div>;
}
