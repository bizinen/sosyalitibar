import { NextResponse } from "next/server";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { workerHeartbeats } from "@/db/schema";
import { env } from "@/lib/config";
import { safeEqual } from "@/lib/security";
import { readResponseBody } from "@/lib/http-body";
import { WORKER_JOBS } from "@/lib/worker-health";

const schema = z.object({ job: z.enum(WORKER_JOBS), succeeded: z.boolean(),
  intervalMs: z.number().int().min(2000).max(2147483647), timeoutMs: z.number().int().min(1000).max(86400000),
}).strict();

export async function POST(req: Request) {
  if (!safeEqual(req.headers.get("authorization") || "", `Bearer ${env().CRON_SECRET}`)) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  let body: unknown;
  try { body = JSON.parse(new TextDecoder().decode(await readResponseBody(new Response(req.body), 1024))); }
  catch { return NextResponse.json({ error: "invalid_body" }, { status: 400 }); }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  const value = parsed.data;
  const now = new Date();
  await db.insert(workerHeartbeats).values({ job: value.job, lastAttemptAt: now,
    lastSuccessAt: value.succeeded ? now : null, lastSucceeded: value.succeeded,
    staleAfterMs: Math.min(2147483647, value.intervalMs + value.timeoutMs + 60000),
  }).onConflictDoUpdate({ target: workerHeartbeats.job, set: { lastAttemptAt: now,
    lastSuccessAt: value.succeeded ? now : sql`${workerHeartbeats.lastSuccessAt}`, lastSucceeded: value.succeeded,
    staleAfterMs: Math.min(2147483647, value.intervalMs + value.timeoutMs + 60000),
  } });
  return NextResponse.json({ recorded: true });
}
