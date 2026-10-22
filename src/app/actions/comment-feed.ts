"use server";

import { z } from "zod";
import { isAdmin } from "@/lib/auth";
import { commentRows, type CommentParams } from "@/lib/comment-feed";
import { decodeItemCursor, encodeItemCursor } from "@/lib/cursor";
import { commentDisplay } from "@/lib/comment-display";

export async function loadCommentPage(params: CommentParams) {
  if (!(await isAdmin())) throw new Error("Oturumun sona erdi. Tekrar giriş yap.");
  const input = z.record(z.string().max(40), z.string().max(2048)).safeParse(params);
  if (!input.success || Object.keys(input.data).length > 25 || !decodeItemCursor(input.data.cursor)) throw new Error("Yorum listesi yüklenemedi. Sayfayı yenile.");
  const result = await commentRows(input.data);
  const visible = result.slice(0, 100);
  const last = visible.at(-1);
  return { rows: visible.map(({ item, analysis, connectionName, parentText }) => ({ item: { ...item, raw: commentDisplay(item.raw) },
    analysis: analysis ? { ...analysis, raw: null } : null, connectionName, parentText })),
    nextCursor: result.length > 100 && last ? encodeItemCursor({ at: last.item.ingestedAt, id: last.item.id, preciseAt: last.cursorAt }) : null };
}
