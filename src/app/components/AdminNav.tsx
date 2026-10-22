"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { BrandMark, UiIcon } from "@/app/components/UiIcon";

export function AdminNav() {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const links = [
    { href: "/", label: "Yorumlar", icon: "comments" as const },
    { href: "/settings/meta", label: "Hesaplarım", icon: "accounts" as const },
    { href: "/settings/videos", label: "İzlenen videolar", icon: "comments" as const },
    { href: "/settings/alerts", label: "Alarmlar", icon: "bell" as const },
    { href: "/settings/llm", label: "AI ayarları", icon: "spark" as const },
    { href: "/settings/integrations", label: "Bağlantı ayarları", icon: "settings" as const },
    { href: "/settings/operations", label: "Sistem durumu", icon: "settings" as const },
  ];
  const title = links.find((link) => link.href === pathname)?.label ?? "Çalışma alanı";
  return <><aside className="topbar">
    <div className="topbar-inner">
      <Link className="brand" href="/"><BrandMark /><span>Sosyal İtibar<small>Kendi hesapların, tek bir alan.</small></span></Link>
      <div className="navigation-menu"><button className="mobile-menu-label" type="button" aria-expanded={menuOpen} aria-controls="workspace-navigation" onClick={() => setMenuOpen(!menuOpen)}>Menü <span>{title}</span></button><nav className={`nav ${menuOpen ? "is-open" : ""}`} id="workspace-navigation" aria-label="Yönetim">
        {links.map((link) => <Link key={link.href} className={`${pathname === link.href ? "active" : ""}${link.href === "/settings/llm" ? " nav-settings-start" : ""}`} aria-current={pathname === link.href ? "page" : undefined} href={link.href} onClick={() => setMenuOpen(false)}><UiIcon name={link.icon} /><span>{link.label}</span></Link>)}
      </nav></div>
      <div className="nav-footer"><div className="workspace-note"><UiIcon name="shield" /><div><strong>Senin kontrolünde</strong><p>Yorumlar analiz edilir.<br />İnceleme kararı sende kalır.</p></div></div><form action="/api/auth/logout" method="post"><button className="logout-button" type="submit" aria-label="Çıkış yap"><UiIcon name="logout" /><span className="logout-label">Çıkış yap</span></button></form></div>
    </div>
  </aside><header className="workspace-header"><div className="header-breadcrumb"><span>Çalışma alanım</span><span aria-hidden="true">/</span><strong>{title}</strong></div><Link className="header-add" href="/settings/meta#connect"><UiIcon name="plus" size={17} />Hesap ekle</Link></header></>;
}
