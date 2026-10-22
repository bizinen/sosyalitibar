"use client";

import { useRef, useState } from "react";
import type { socialItems } from "@/db/schema";
import { commentDisplay } from "@/lib/comment-display";

export function CommentIntervention({ item }: { item: typeof socialItems.$inferSelect }) {
  const [composing, setComposing] = useState(false);
  const [reply, setReply] = useState("");
  const [message, setMessage] = useState("");
  const [downloading, setDownloading] = useState(false);
  const replyRef = useRef<HTMLTextAreaElement>(null);
  const platform = item.platform === "youtube" ? "YouTube" : item.platform === "instagram" ? "Instagram" : "Facebook";
  const post = commentDisplay(item.raw).source_post;
  const commentUrl = (() => {
    if (!item.permalink) return null;
    try {
      const url = new URL(item.permalink);
      if (url.protocol !== "https:" || url.username || url.password
        || !/(^|\.)(facebook\.com|instagram\.com|youtube\.com|youtu\.be)$/.test(url.hostname)
        || [...url.searchParams.keys()].some((key) => /token|secret/i.test(key))) return null;
      return url.href;
    } catch { return null; }
  })();
  const directComment = commentUrl && ((item.platform === "facebook" && new URL(commentUrl).searchParams.has("comment_id"))
    || (item.platform === "instagram" && /\/c\/\d+\/?$/.test(new URL(commentUrl).pathname))
    || (item.platform === "youtube" && new URL(commentUrl).searchParams.has("lc")));
  const sourceUrl = commentUrl ?? post.permalink;
  async function copyReply() {
    try { await navigator.clipboard.writeText(reply); setMessage("Yanıt kopyalandı. Kaynak platformda ilgili yoruma yapıştırıp gönderebilirsin."); }
    catch { replyRef.current?.focus(); replyRef.current?.select(); setMessage("Tarayıcı panoya erişim vermedi. Metni seçtim; Ctrl+C veya ⌘C ile kopyalayabilirsin."); }
  }
  async function evidence() {
    setDownloading(true); setMessage("");
    try {
      const response = await fetch(`/api/items/${item.id}/evidence?revision=${item.analysisRevision}`, { cache: "no-store" });
      if (!response.ok) throw new Error(response.status === 409 ? "Yorum değişti. Güncel yorumu yükleyip tekrar indir." : "Kanıt kaydı indirilemedi.");
      const url = URL.createObjectURL(await response.blob());
      const link = document.createElement("a");
      link.href = url; link.download = `yorum-kaydi-${item.id}.json`; link.hidden = true; document.body.appendChild(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      setMessage("Yorum, paylaşım bilgisi ve değerlendirme kayıtları indirildi. Bu işlem şikâyet göndermez.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "İndirme başarısız."); }
    finally { setDownloading(false); }
  }
  return <section className="comment-intervention" aria-label="Yorum işlemleri">
    <div className="intervention-heading"><h3>Yorum işlemleri</h3></div>
    {!sourceUrl ? <p className="small muted">Bu yorumun kaynak bağlantısı alınmamış.</p> : null}
    <div className="btn-row">
      {sourceUrl ? <a className="btn primary" href={sourceUrl} target="_blank" rel="noopener noreferrer">{directComment ? `Yorumu ${platform}’da aç` : `${platform} paylaşımını aç`}</a> : null}
      <button className="btn" onClick={() => setComposing(!composing)} aria-expanded={composing}>{composing ? "Taslağı kapat" : "Yanıt taslağı yaz"}</button>
      <button className="btn" disabled={downloading} onClick={evidence}>{downloading ? "İndiriliyor…" : "Yorum kaydını indir"}</button>
    </div>
    {sourceUrl ? <p className="small muted">Yanıt vermek veya yorumu bildirmek için {platform}’daki yorumu aç. Bu ekrandan platforma işlem gönderilmiyor.</p> : null}
    {composing ? <div className="intervention-composer">
      <label>Yanıt taslağın<textarea ref={replyRef} className="input" rows={4} maxLength={2000} value={reply} onChange={(event) => setReply(event.target.value)} placeholder="Yanıtını yaz, kopyala ve kaynak yorumun altına yapıştır…" /></label>
      <div className="btn-row"><button className="btn" disabled={!reply.trim()} onClick={copyReply}>Taslağı kopyala</button></div>
    </div> : null}
    {message ? <p className="small" role="status">{message}</p> : null}
  </section>;
}
