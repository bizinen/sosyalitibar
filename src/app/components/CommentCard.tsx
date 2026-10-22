import { triageLabels } from "@/lib/triage-contract";
import { ReviewActions } from "@/app/components/ReviewActions";
import { UiIcon } from "@/app/components/UiIcon";
import type { socialAnalyses, socialItems } from "@/db/schema";
import { ProfileAvatar } from "@/app/components/ProfileAvatar";
import { commentDisplay } from "@/lib/comment-display";
import { CommentSource } from "@/app/components/CommentSource";

export const categoryLabels: Record<string, string> = { criticism: "Eleştiri", insult: "Hakaret", accusation: "İddia", threat: "Tehdit", mockery: "Alay", spam: "Spam", support: "Destek", other: "Diğer" };
const reviewLabels: Record<string, string> = { new: "Yeni", reviewed: "İncelendi", ignored: "Dikkate alınmadı", escalated: "Önceliklendirildi" };
const analysisLabels: Record<string, string> = { pending: "Analiz bekliyor", processing: "Analiz ediliyor", retry: "Tekrar denenecek", dead: "Analiz tamamlanamadı", complete: "Analiz kaydı yok" };

export function CommentCard({ item, analysis, connectionName, parentText, showActions = true }: {
  item: typeof socialItems.$inferSelect;
  analysis: typeof socialAnalyses.$inferSelect | null;
  connectionName: string | null;
  parentText: string | null;
  showActions?: boolean;
}) {
  const tone = analysis ? analysis.triageLabel ? analysis.triageLabel === "acil_inceleme" ? "danger" : analysis.triageLabel === "insan_incelemesi_gerekli" ? "warn" : "ok" : (analysis.severity ?? 0) >= 70 ? "danger" : (analysis.severity ?? 0) >= 50 ? "warn" : "ok" : "pending";
  const author = item.authorName || "İsmi paylaşılmayan kullanıcı";
  const display = commentDisplay(item.raw);
  return <article className={`comment-card tone-${tone}`}>
    <div className="comment-main">
      <div className="comment-author"><ProfileAvatar name={author} src={display.author_avatar_url} /><div><strong>{author}</strong><div className="comment-source"><span className={`review-platform ${item.platform}`}>{item.platform === "youtube" ? "YouTube" : item.platform === "instagram" ? "Instagram" : "Facebook"}</span><span>{display.source_channel || connectionName || "Hesap bağlantısı kaldırılmış"}</span></div></div><time className="comment-time" dateTime={(item.sourceCreatedAt || item.ingestedAt).toISOString()}>{(item.sourceCreatedAt || item.ingestedAt).toLocaleString("tr-TR", { timeZone: "Europe/Istanbul", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}</time></div>
      <CommentSource raw={item.raw} platform={item.platform} rootId={item.rootExternalId} />
      {item.raw && typeof item.raw === "object" && (item.raw as { context_incomplete?: unknown }).context_incomplete ? <p className="notice">Kaynak bağlamının bir bölümü alınamadı. Kararı özgün yorum ve paylaşım üzerinden inceleyin.</p> : null}
      {parentText ? <details className="parent-context"><summary>Yanıt verilen yorumu gör</summary><p className="comment-text" dir="auto">{parentText}</p></details> : item.itemType === "reply" ? <p className="small muted">Üst yorumun bağlamına erişilemiyor.</p> : null}
      <div className="comment-text" dir="auto">{item.text || <em>Bu yorumda metin bulunmuyor.</em>}</div>
      <div className="comment-foot">{showActions || item.itemType !== "comment" ? <span className="badge">{item.itemType === "reply" ? "Yanıt" : item.itemType === "mention" ? "Bahsetme" : "Yorum"}</span> : null}{showActions ? <span className="badge">{reviewLabels[item.reviewStatus] || item.reviewStatus}</span> : null}</div>
    </div>
    <details className="ai-decision" open={showActions || undefined}>
      <summary className="ai-decision-head"><span className="ai-label"><UiIcon name="spark" size={17} />AI değerlendirmesi</span>{item.sourceUnavailableAt ? <span className="badge">Kaynağa erişilemiyor</span> : analysis ? <span className={`badge ${tone}`}>{analysis.triageLabel ? triageLabels[analysis.triageLabel] : `${categoryLabels[analysis.category ?? ""] || analysis.category} · ${analysis.severity}/100`}</span> : <span className="badge">{analysisLabels[item.analysisStatus] || item.analysisStatus}</span>}</summary>
      {item.sourceUnavailableAt ? <div className="analysis-waiting"><strong>Meta’da yoruma erişilemiyor</strong><p>Silindiği doğrulanmadı. Önceki değerlendirme geçersiz kılındı; kaynak yeniden erişilebilir olduğunda analiz yenilenecek.</p></div> : analysis?.triageLabel ? <div className="analysis-detail"><p>{triageLabels[analysis.triageLabel]}</p>{analysis.provider === "local" ? <p className="small muted">Metin veya veri sınırı nedeniyle model kararı üretilemedi; insan incelemesine ayrıldı.</p> : null}<dl><div><dt>Model</dt><dd>{analysis.model}</dd></div><div><dt>Talimat sürümü</dt><dd>{analysis.promptVersion}</dd></div><div><dt>Analiz zamanı</dt><dd>{analysis.analyzedAt.toLocaleString("tr-TR", { timeZone: "Europe/Istanbul" })}</dd></div></dl></div> : analysis ? <><div className="risk-reading"><strong>{analysis.severity}<small>/100</small></strong><span>{(analysis.severity ?? 0) >= 70 ? "Yüksek öncelik" : (analysis.severity ?? 0) >= 50 ? "Dikkat gerektiriyor" : "Düşük öncelik"}</span></div><div className="risk-track" role="meter" aria-label="İnceleme önceliği" aria-valuemin={0} aria-valuemax={100} aria-valuenow={analysis.severity ?? undefined}><span style={{ width: `${analysis.severity}%` }} /></div><p className="ai-summary">{analysis.summary}</p>{analysis.matchedTarget ? <div className="matched-target"><UiIcon name="target" size={15} />{analysis.matchedTarget}</div> : <div className="small muted">İzlenen kişi veya kurumla eşleşme yok.</div>}{analysis.needsReview && item.reviewStatus === "new" ? <div className="review-prompt">İnsan incelemesi gerekiyor</div> : null}<details className="analysis-detail"><summary>Kararın ayrıntıları</summary><dl><div><dt>Hedef eşleşme güveni</dt><dd>%{Math.round((analysis.targetConfidence ?? 0) * 100)}</dd></div><div><dt>Yorumun tonu</dt><dd>{analysis.sentiment === "negative" ? "Olumsuz" : analysis.sentiment === "positive" ? "Olumlu" : "Nötr"}</dd></div><div><dt>Model</dt><dd>{analysis.model}</dd></div><div><dt>Sağlayıcı</dt><dd>{analysis.provider}</dd></div></dl>{analysis.containsClaim && analysis.claimText ? <p className="claim-text" dir="auto"><strong>İddia içeren ifade</strong>{analysis.claimText}</p> : null}<p className="small muted">Bu değerlendirme inceleme önceliğini belirler; iddianın doğruluğuna karar vermez.</p></details></> : <div className="analysis-waiting"><span className={item.analysisStatus === "processing" ? "working-dot" : "status-dot"} /><strong>{analysisLabels[item.analysisStatus] || item.analysisStatus}</strong><p>{item.analysisStatus === "dead" ? "Sistem durumu ekranından hata bilgisini inceleyip yeniden deneyebilirsin." : "AI sonucu hazır olduğunda bu alanda görünecek."}</p></div>}
    </details>
    {showActions ? <div className="comment-actions"><ReviewActions itemId={item.id} current={item.reviewStatus} analysisRevision={item.analysisRevision} /></div> : null}
  </article>;
}
