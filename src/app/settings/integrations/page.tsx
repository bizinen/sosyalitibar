import { redirect } from "next/navigation";
import Link from "next/link";
import { isAdmin } from "@/lib/auth";
import { getMetaSettings } from "@/lib/meta-settings";
import { getYouTubeSettings } from "@/lib/youtube-settings";
import { AdminNav } from "@/app/components/AdminNav";
import { MetaSettingsForm } from "@/app/components/MetaSettingsForm";
import { YouTubeSettingsForm } from "@/app/components/YouTubeSettingsForm";

export default async function IntegrationsPage() {
  if (!(await isAdmin())) redirect("/login");
  const [metaCfg, youtubeCfg] = await Promise.all([getMetaSettings(), getYouTubeSettings()]);
  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>Bağlantı ayarları</h1><p className="muted">Meta ve YouTube kurulumunu bir kez tamamla; hesaplarını Hesaplarım sayfasından ekle.</p></div><Link className="btn" href="/settings/meta">Hesaplarıma git</Link></div>
    <section className="panel" id="youtube"><div className="panel-head"><h2>YouTube kurulumu</h2></div><YouTubeSettingsForm hasKey={Boolean(youtubeCfg)} revision={youtubeCfg?.revision ?? 0} /></section>
    <section className="panel" id="meta"><div className="panel-head"><h2>Facebook / Instagram · Meta kurulumu</h2></div><div className="panel-body"><MetaSettingsForm loginConfigId={metaCfg.metaLoginConfigId} appId={/^\d+$/.test(metaCfg.META_APP_ID) ? metaCfg.META_APP_ID : ""} publicOrigin={metaCfg.metaPublicOrigin} graphVersion={metaCfg.META_GRAPH_VERSION} hasSecret={metaCfg.META_APP_SECRET !== "local-not-configured" && metaCfg.META_APP_SECRET.length >= 16} hasVerifyToken={metaCfg.META_WEBHOOK_VERIFY_TOKEN.length >= 16} revision={metaCfg.metaSettingsRevision} scopes={metaCfg.META_SCOPES.split(",")} /></div></section>
  </main></div>;
}
