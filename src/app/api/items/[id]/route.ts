import { NextResponse } from "next/server";
import { z } from "zod";
import { isAdmin } from "@/lib/auth";
import { assertSameOrigin } from "@/lib/security";
import { humanAssessmentSchema, reviewStatusSchema } from "@/lib/review-contract";
import { recordItemReview } from "@/lib/item-review";
import { readResponseBody } from "@/lib/http-body";

const schema = z.object({ reviewStatus: reviewStatusSchema, expectedReviewStatus: reviewStatusSchema, analysisRevision: z.number().int().positive(),
  expectedReviewId: z.string().uuid().nullable().optional(), assessment: humanAssessmentSchema.optional(), undoEventId: z.string().uuid().optional(),
}).strict().refine((value) => !(value.assessment && value.undoEventId))
  .refine((value) => !(value.assessment || value.undoEventId) || value.expectedReviewId !== undefined);

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (!(await assertSameOrigin(req))) return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  const { id } = await ctx.params;
  if (!z.string().uuid().safeParse(id).success) return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 16384))); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const result = await recordItemReview(id, parsed.data, req);
  if ("error" in result) return NextResponse.json({ error: result.error }, { status: result.error === "not_found" ? 404 : result.error === "target_not_found" ? 400 : 409 });
  return NextResponse.json({ ...result.item, reviewEventId: result.reviewEventId });
}
