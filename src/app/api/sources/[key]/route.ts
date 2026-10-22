import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { readResponseBody } from "@/lib/http-body";
import { readSourceKey } from "@/lib/comment-feed";
import { deleteSource } from "@/lib/source-deletion";
import { abortApifyRun } from "@/lib/apify-videos";

export async function DELETE(req: Request, context: { params: Promise<{ key: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const source = readSourceKey((await context.params).key);
  if (!source?.id) return NextResponse.json({ error: "invalid_source" }, { status: 400 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 2048))); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = z.object({ confirm: z.literal("delete_source"), revision: z.number().int().positive().nullable() }).strict().safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  try {
    const result = await deleteSource(source.platform, source.id, parsed.data.revision);
    if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : 409 });
    let warning = result.abortUnconfirmed ? "apify_abort_unconfirmed" : undefined;
    if (result.abort) {
      try { await abortApifyRun(result.abort.runId, result.abort.key); }
      catch { warning = "apify_abort_unconfirmed"; }
    }
    return NextResponse.json({ deleted: true, commentsDeleted: result.commentsDeleted, warning });
  } catch { return NextResponse.json({ error: "source_delete_failed" }, { status: 500 }); }
}
