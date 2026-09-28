import { redirect } from "next/navigation";
import { asc } from "drizzle-orm";
import { isAdmin } from "@/lib/auth";
import { db } from "@/lib/db";
import { monitoringTargets } from "@/db/schema";
import { AdminNav } from "@/app/components/AdminNav";
import { TargetManager } from "@/app/components/TargetManager";

export default async function TargetsPage() {
  if (!(await isAdmin())) redirect("/login");
  const targets = await db.select().from(monitoringTargets).orderBy(asc(monitoringTargets.name));
  return <div className="shell"><AdminNav /><main className="container">
    <div className="page-head"><div><h1>İzleme hedefleri</h1><p className="muted" style={{margin:"6px 0 0"}}>Kişi/kurum adları, kullanıcı adları ve yaygın yazım varyasyonları LLM'e bağlam olarak verilir.</p></div></div>
    <TargetManager targets={targets.map((x) => ({ id:x.id,name:x.name,aliases:x.aliases,notes:x.notes,enabled:x.enabled }))} />
  </main></div>;
}
