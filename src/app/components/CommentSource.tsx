"use client";

import { useState } from "react";
import Link from "next/link";
import { commentDisplay } from "@/lib/comment-display";
import { UiIcon } from "@/app/components/UiIcon";

export function CommentSource({ raw, platform, rootId, titleHref }: { raw: unknown; platform: string; rootId: string | null; titleHref?: string }) {
  const { source_post: post } = commentDisplay(raw);
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const label = platform === "youtube" ? "YouTube videosu" : platform === "instagram" ? "Instagram paylaşımı" : "Facebook paylaşımı";
  const thumbnail = platform === "youtube" && /^[A-Za-z0-9_-]{11}$/.test(rootId ?? "") ? `https://i.ytimg.com/vi/${rootId}/mqdefault.jpg` : null;
  const title = post.text?.split("\n")[0]?.trim() || label;
  return <section className="comment-source-preview" aria-label="Yorumun yapıldığı paylaşım">
    {thumbnail && thumbnail !== failedImage ?
      // eslint-disable-next-line @next/next/no-img-element
      <img className="comment-source-thumbnail" src={thumbnail} alt="" width={160} height={90} loading="lazy" onError={() => setFailedImage(thumbnail)} />
      : <span className="comment-source-symbol"><UiIcon name="comments" size={24} /></span>}
    <div><span className="small muted">{label}</span><h3 dir="auto" title={title}>{titleHref ? <Link href={titleHref} prefetch={false}>{title}</Link> : title}</h3>
      {post.permalink ? <a className="text-link" href={post.permalink} target="_blank" rel="noopener noreferrer">Paylaşımı aç <UiIcon name="arrow" size={14} /></a> : <p className="small muted">Kaynak bağlantısı alınamadı.</p>}
      {post.text && post.text !== title ? <details><summary>Paylaşımın açıklaması</summary><p dir="auto">{post.text}</p></details> : null}
    </div>
  </section>;
}
