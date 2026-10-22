import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertOutbox, alertSettings, connectionTargets, itemReviewEvents, metaAuthAccounts, oauthNonces, monitoringTargets, socialAnalyses, socialConnections, socialItems, watchedVideos, webhookEvents } from "@/db/schema";
import { encodeItemCursor, decodeItemCursor } from "@/lib/cursor";
import { env } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { analyzeClaimedItem, beginSourceRead, claimAnalysisJobs, markSourceUnavailable, requeueStaleAnalysisLocks, upsertSocialItem } from "@/lib/ingest";
import { claimAlertJobs, processClaimedAlert } from "@/lib/alerts";
import { checkConnectionHealth } from "@/lib/connection-health";
import { syncAllConnections } from "@/lib/sync";
import { MetaApiError } from "@/lib/meta";
import { createOAuthState, consumeOAuthState } from "@/lib/oauth-state";
import { PUT as mapTargets } from "@/app/api/connections/[id]/targets/route";
import { PATCH as patchTarget, DELETE as deleteTarget } from "@/app/api/targets/[id]/route";
import { PATCH as patchConnection, DELETE as disconnect } from "@/app/api/connections/[id]/route";
import { POST as maintenance } from "@/app/api/jobs/maintenance/route";
import { rotateStoredTokens } from "@/lib/token-rotation";
import { claimWebhookJobs, processClaimedWebhook, processMetaWebhookPayload } from "@/lib/webhook-processing";
import { GET as metrics } from "@/app/api/metrics/route";
import { recordItemReview } from "@/lib/item-review";
import { PUT as saveAiPolicy } from "@/app/api/settings/ai-policy/route";
import { defaultAiPolicy } from "@/lib/triage-contract";
import { auditLogs } from "@/db/schema";
import { commentRows, sourceKey } from "@/lib/comment-feed";
import { commentSources } from "@/lib/comment-sources";
import { PUT as saveMetaSettings } from "@/app/api/settings/meta/route";
import { GET as oauthCallback } from "@/app/api/meta/callback/route";
import { PATCH as configureVideo } from "@/app/api/videos/[id]/route";
import { POST as pollUpdates, GET as pollLegacyUpdates } from "@/app/api/items/updates/route";
import * as auditModule from "@/lib/audit";
import { POST as retryDeadAnalysis } from "@/app/api/admin/dead-letter/analysis/[id]/route";

const mocks = vi.hoisted(() => ({ analyze: vi.fn(), debug: vi.fn(), posts: vi.fn(), comments: vi.fn(), replies: vi.fn(),
  exchange: vi.fn(), longToken: vi.fn(), user: vi.fn(), scopes: vi.fn(), pages: vi.fn(), subscribe: vi.fn() }));
vi.mock("@/lib/llm", async (original) => ({ ...await original<typeof import("@/lib/llm")>(), analyzeComment: mocks.analyze }));
vi.mock("@/lib/meta", async (original) => ({ ...await original<typeof import("@/lib/meta")>(), debugToken: mocks.debug,
  getFacebookPosts: mocks.posts, getFacebookComments: mocks.comments, getFacebookReplies: mocks.replies,
  exchangeCode: mocks.exchange, exchangeLongLivedUserToken: mocks.longToken, getMetaUser: mocks.user,
  getGrantedScopes: mocks.scopes, getManagedPages: mocks.pages, subscribeFacebookPage: mocks.subscribe }));
vi.mock("@/lib/auth", () => ({ isAdmin: async () => true }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function request(body?: object) {
  return new Request("http://localhost:3000/api/test", {
    method: "POST", headers: { origin: "http://localhost:3000", "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function params(id: string) { return { params: Promise.resolve({ id }) }; }
function result() {
  return { data: { target_match: true, target_confidence: 0.9, matched_target: "Hedef", sentiment: "negative" as const,
    category: "threat" as const, severity: 95, contains_insult: false, contains_threat: true, contains_claim: false,
    claim_text: null, needs_review: true, summary: "İnceleme gerekli." },
  model: "test", provider: "test", promptVersion: "test", inputHash: "a".repeat(64), latencyMs: 1, raw: {} };
}
async function connection(status = "active") {
  const [row] = await db.insert(socialConnections).values({ platform: "facebook", externalAccountId: "page-1",
    displayName: "Hedef", encryptedAccessToken: encryptSecret("fixture-token"), status }).returning();
  return row!;
}
async function item(connectionId?: string) {
  return (await upsertSocialItem({ connectionId, platform: "facebook", externalId: "comment-1", text: "ilk yorum" })).item;
}
async function analyzed(connectionId?: string) {
  const source = await item(connectionId);
  const [job] = await claimAnalysisJobs(1);
  expect(await analyzeClaimedItem(job!.id, job!.lockId)).toEqual({ processed: true });
  return source;
}
async function pausedAnalysis(connectionId?: string) {
  const source = await item(connectionId);
  const entered = deferred<void>();
  const release = deferred<ReturnType<typeof result>>();
  mocks.analyze.mockImplementationOnce(() => { entered.resolve(); return release.promise; });
  const [job] = await claimAnalysisJobs(1);
  const work = analyzeClaimedItem(job!.id, job!.lockId);
  await entered.promise;
  return { source, job: job!, work, release };
}

describe.runIf(Boolean(process.env.TEST_DATABASE_URL))("PostgreSQL pipeline invariants", { timeout: 15000 }, () => {
  beforeAll(async () => {
    if (!process.env.TEST_DATABASE_URL?.endsWith("/sosyal_itibar_test")) throw new Error("Dedicated sosyal_itibar_test database required");
    vi.stubEnv("DATABASE_URL", process.env.TEST_DATABASE_URL);
    for (const [key, value] of Object.entries({
      APP_URL: "http://localhost:3000", ADMIN_PASSWORD: "test-password-only", SESSION_SECRET: "s".repeat(40),
      CRON_SECRET: "c".repeat(40), AUDIT_HASH_SECRET: "a".repeat(40), META_APP_ID: "1", META_APP_SECRET: "test",
      META_GRAPH_VERSION: "v26.0", META_REDIRECT_URI: "http://localhost:3000/api/meta/callback",
      META_WEBHOOK_VERIFY_TOKEN: "v".repeat(20), TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
      LLM_API_KEY: "fixture", LLM_MODEL: "fixture", ALERT_WEBHOOK_URL: "http://receiver.test/alerts", ALERT_WEBHOOK_SECRET: "w".repeat(40),
    })) vi.stubEnv(key, value);
    const database = await db.execute(sql`select current_database() as name`);
    expect(database[0]?.name).toBe("sosyal_itibar_test");
  });
  beforeEach(async () => {
    await db.execute(sql`truncate audit_logs, webhook_events, alert_outbox, social_analyses, social_items,
      connection_targets, social_connections, meta_auth_accounts, monitoring_targets, oauth_nonces, auth_rate_limits, alert_settings, worker_heartbeats, ai_policy, meta_settings, llm_settings cascade`);
    mocks.analyze.mockReset().mockResolvedValue(result());
    mocks.debug.mockReset().mockResolvedValue({ isValid: true, scopes: ["pages_read_engagement", "pages_read_user_content", "pages_manage_metadata"], expiresAt: null });
    mocks.posts.mockReset().mockResolvedValue({ data: [] });
    mocks.comments.mockReset().mockResolvedValue({ data: [] });
    mocks.replies.mockReset().mockResolvedValue({ data: [] });
    mocks.exchange.mockReset().mockResolvedValue({ accessToken: "short-token" });
    mocks.longToken.mockReset().mockResolvedValue({ accessToken: "long-token" });
    mocks.user.mockReset().mockResolvedValue({ id: "owner-1", name: "Owner" });
    mocks.scopes.mockReset().mockResolvedValue(["pages_read_engagement", "pages_read_user_content", "pages_manage_metadata"]);
    mocks.pages.mockReset().mockResolvedValue([{ id: "new-page", name: "New page", access_token: "page-token" }]);
    mocks.subscribe.mockReset().mockResolvedValue(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 200 })));
  });
  afterAll(async () => { await db.$client.end(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

  it.each(["inceleme_gerekmiyor", "insan_incelemesi_gerekli", "acil_inceleme"] as const)("persists %s without invented analysis fields and only alerts urgent triage", async (label) => {
    const source = await item();
    const [job] = await claimAnalysisJobs(1);
    const analyze = vi.fn(async () => ({ ...result(), data: { label } }));
    expect(await analyzeClaimedItem(job!.id, job!.lockId, analyze)).toEqual({ processed: true });
    const stored = await db.query.socialAnalyses.findFirst({ where: eq(socialAnalyses.itemId, source.id) });
    expect(stored).toMatchObject({ triageLabel: label, category: null, severity: null, summary: null,
      targetMatch: null, targetConfidence: null, containsThreat: null, needsReview: label !== "inceleme_gerekmiyor" });
    const alerts = await db.select().from(alertOutbox).where(eq(alertOutbox.itemId, source.id));
    expect(alerts).toHaveLength(label === "acil_inceleme" ? 1 : 0);
    if (alerts[0]) expect(alerts[0].payload).toMatchObject({ rule: "triage-v1", reason: "acil_inceleme", analysis: { label, needs_review: true } });
    expect(await analyzeClaimedItem(job!.id, job!.lockId, analyze)).toEqual({ processed: false, reason: "lost_lock" });
    expect(analyze).toHaveBeenCalledTimes(1);
  });

  it("rejects stale policy saves and does not enqueue completed comments after a prompt edit", async () => {
    const source = await analyzed();
    const changed = { ...defaultAiPolicy, targetContext: "Ahmet Hoca" };
    const saved = await saveAiPolicy(request({ policy: changed, revision: 0 }));
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ revision: 1 });
    expect((await saveAiPolicy(request({ policy: defaultAiPolicy, revision: 0 }))).status).toBe(409);
    expect(await db.query.socialItems.findFirst({ where: eq(socialItems.id, source.id) })).toMatchObject({
      analysisRevision: source.analysisRevision, analysisStatus: "complete" });
    expect(await claimAnalysisJobs(10)).toEqual([]);
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.action, "ai.policy_updated"));
    expect(logs).toHaveLength(1);
    expect(logs[0]!.metadata).toMatchObject({ revision: 1, settings: { targetContext: "Ahmet Hoca" } });
  });

  it("isolates malformed changes from healthy changes in a durable webhook batch", async () => {
    await db.insert(webhookEvents).values({ dedupeKey: "batch-fixture", payload: { object: "page", entry: [{ id: "page-1",
      changes: [{ field: "feed", value: { item: "comment" } }, { field: "unrelated", value: {} }],
    }] } });
    const [parent] = await claimWebhookJobs(1);
    expect(await processClaimedWebhook(parent!.id, parent!.lockId)).toMatchObject({ ok: true });
    const children = await claimWebhookJobs(2);
    expect(children).toHaveLength(2);
    const results = [];
    for (const child of children) results.push(await processClaimedWebhook(child.id, child.lockId));
    expect(results.some((entry) => entry.ok)).toBe(true);
    expect(results.some((entry) => !entry.ok && entry.reason === "retry")).toBe(true);
    expect((await db.select().from(webhookEvents)).filter((entry) => entry.status === "processed")).toHaveLength(2);
  });

  it("defers early unknown-account events without spending source retries and stops deferring after five minutes", async () => {
    await db.insert(webhookEvents).values({ dedupeKey: "unknown-account", payload: { object: "instagram", entry: [{ id: "not-yet-connected",
      changes: [{ field: "comments", value: { id: "early-comment" } }],
    }] } });
    const [job] = await claimWebhookJobs(1);
    expect(await processClaimedWebhook(job!.id, job!.lockId)).toMatchObject({ ok: false, reason: "retry" });
    const waiting = (await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.id, job!.id) }))!;
    expect(waiting.attempts).toBe(0);
    await db.update(webhookEvents).set({ receivedAt: new Date(Date.now() - 6 * 60000), availableAt: new Date() }).where(eq(webhookEvents.id, job!.id));
    const [expired] = await claimWebhookJobs(1);
    expect(await processClaimedWebhook(expired!.id, expired!.lockId)).toMatchObject({ ok: true, ignoredChanges: 1 });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an earlier source read even when it finishes after a newer read", async () => {
    const older = await beginSourceRead();
    const newer = await beginSourceRead();
    const current = await upsertSocialItem({ platform: "facebook", externalId: "ordered-comment", text: "new text", sourceReadVersion: newer });
    const stale = await upsertSocialItem({ platform: "facebook", externalId: "ordered-comment", text: "old text", sourceReadVersion: older });
    expect(stale).toMatchObject({ changed: false, item: { text: "new text", analysisRevision: current.item.analysisRevision, sourceReadVersion: newer } });
    expect(await upsertSocialItem({ platform: "facebook", externalId: "ordered-comment", text: "replayed snapshot", sourceReadVersion: newer }))
      .toMatchObject({ changed: false, item: { text: "new text" } });
  });

  it("invalidates unavailable sources without declaring deletion and reanalyzes recovered sources", async () => {
    const source = await connection();
    const existing = await analyzed(source.id);
    expect(await db.select().from(alertOutbox)).toHaveLength(1);
    const version = await beginSourceRead();
    await markSourceUnavailable(existing.id, version, async () => {});
    const unavailable = (await db.query.socialItems.findFirst({ where: eq(socialItems.id, existing.id) }))!;
    expect(unavailable.deletedAt).toBeNull();
    expect(unavailable.sourceUnavailableAt).toBeInstanceOf(Date);
    expect(await db.query.socialAnalyses.findFirst({ where: eq(socialAnalyses.itemId, existing.id) })).toBeUndefined();
    expect((await db.select().from(alertOutbox)).every((row) => row.status === "cancelled")).toBe(true);
    const restored = await upsertSocialItem({ connectionId: source.id, platform: "facebook", externalId: existing.externalId, text: existing.text });
    expect(restored).toMatchObject({ changed: true, item: { sourceUnavailableAt: null, analysisStatus: "pending" } });
    await markSourceUnavailable(existing.id, version, async () => {});
    expect((await db.query.socialItems.findFirst({ where: eq(socialItems.id, existing.id) }))?.sourceUnavailableAt).toBeNull();
  });

  it("preserves pending alerts when delivery is disabled before claiming", async () => {
    await analyzed();
    await db.insert(alertSettings).values({ id: "primary", enabled: false,
      webhookUrl: "https://receiver.test/alerts", secretEncrypted: encryptSecret("w".repeat(40)),
    });
    expect(await claimAlertJobs(1)).toEqual([]);
    expect((await db.select().from(alertOutbox))[0]).toMatchObject({ status: "pending", lockId: null, attempts: 0 });
    await db.update(alertSettings).set({ enabled: true }).where(eq(alertSettings.id, "primary"));
    expect(await claimAlertJobs(1)).toHaveLength(1);
  });

  it("keeps human corrections separate, records snapshots and guards undo against concurrent reviews", async () => {
    const source = await analyzed();
    const reviewed = await recordItemReview(source.id, { reviewStatus: "reviewed", expectedReviewStatus: "new", analysisRevision: source.analysisRevision, expectedReviewId: null });
    if ("error" in reviewed) throw new Error(reviewed.error);
    const corrected = await recordItemReview(source.id, { reviewStatus: "reviewed", expectedReviewStatus: "reviewed", analysisRevision: source.analysisRevision,
      expectedReviewId: reviewed.reviewEventId, assessment: { verdict: "criticism", category: "criticism", severity: 20, targetMatch: false, matchedTarget: null, reason: "Normal eleştiri; tehdit içermiyor." } });
    if ("error" in corrected) throw new Error(corrected.error);
    expect(await db.query.socialAnalyses.findFirst({ where: eq(socialAnalyses.itemId, source.id) })).toMatchObject({ category: "threat", severity: 95 });
    const events = await db.select().from(itemReviewEvents).where(eq(itemReviewEvents.itemId, source.id)).orderBy(desc(itemReviewEvents.sequence));
    expect(events[0]).toMatchObject({ action: "correction", sourceText: source.text, llmSnapshot: { category: "threat", severity: 95 }, assessment: { verdict: "criticism" } });
    expect(await recordItemReview(source.id, { reviewStatus: "new", expectedReviewStatus: "reviewed", analysisRevision: source.analysisRevision,
      expectedReviewId: reviewed.reviewEventId, undoEventId: reviewed.reviewEventId! })).toEqual({ error: "review_conflict" });
    const undone = await recordItemReview(source.id, { reviewStatus: "reviewed", expectedReviewStatus: "reviewed", analysisRevision: source.analysisRevision,
      expectedReviewId: corrected.reviewEventId, undoEventId: corrected.reviewEventId! });
    expect(undone).not.toHaveProperty("error");
    const [latest] = await db.select().from(itemReviewEvents).where(eq(itemReviewEvents.itemId, source.id)).orderBy(desc(itemReviewEvents.sequence));
    expect(latest).toMatchObject({ action: "undo", assessment: null, undoOf: corrected.reviewEventId });
    expect(await db.select().from(itemReviewEvents)).toHaveLength(3);
  });

  it("rejects a human review of an edited comment while preserving its earlier review history", async () => {
    const source = await item();
    const reviewed = await recordItemReview(source.id, { reviewStatus: "reviewed", expectedReviewStatus: "new", analysisRevision: source.analysisRevision, expectedReviewId: null });
    if ("error" in reviewed) throw new Error(reviewed.error);
    await upsertSocialItem({ platform: "facebook", externalId: source.externalId, text: "değişen yorum" });
    expect(await recordItemReview(source.id, { reviewStatus: "ignored", expectedReviewStatus: "reviewed", analysisRevision: source.analysisRevision,
      expectedReviewId: reviewed.reviewEventId })).toEqual({ error: "review_conflict" });
    expect((await db.select().from(itemReviewEvents))[0]).toMatchObject({ sourceText: source.text, analysisRevision: source.analysisRevision });
  });

  it("requires human review instead of classifying an empty comment as spam", async () => {
    const source = await upsertSocialItem({ platform: "facebook", externalId: "empty-comment", text: " " });
    const [job] = await claimAnalysisJobs(1);
    expect(await analyzeClaimedItem(job!.id, job!.lockId)).toEqual({ processed: true });
    expect(await db.query.socialAnalyses.findFirst({ where: eq(socialAnalyses.itemId, source.item.id) }))
      .toMatchObject({ triageLabel: "insan_incelemesi_gerekli", category: null, severity: null, needsReview: true, model: "deterministic" });
    expect(mocks.analyze).not.toHaveBeenCalled();
  });

  it("resumes overflow comments from encrypted state without restarting the first post page", async () => {
    const source = await connection();
    const cfg = env(); const previousLimit = cfg.SYNC_RUN_MAX_STEPS;
    cfg.SYNC_RUN_MAX_STEPS = 5;
    mocks.posts.mockResolvedValue({ data: [{ id: "post-1", message: "post context" }] });
    mocks.comments.mockResolvedValue({ data: Array.from({ length: 3 }, (_, index) => ({ id: `comment-${index}`, message: "comment" })) });
    try {
      await syncAllConnections(source.id);
      const pending = await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, source.id) });
      expect(typeof pending?.syncState.continuation).toBe("string");
      expect(JSON.stringify(pending?.syncState)).not.toContain("post context");
      expect((await db.select().from(socialItems))).toHaveLength(2);
      await syncAllConnections(source.id);
      expect((await db.select().from(socialItems))).toHaveLength(3);
      expect(mocks.posts).toHaveBeenCalledTimes(1);
      expect((await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, source.id) }))?.syncState.continuation).toBeNull();
    } finally { cfg.SYNC_RUN_MAX_STEPS = previousLimit; }
  });

  it("isolates exhausted reply fetches while continuing to ingest healthy sibling comments", async () => {
    const source = await connection();
    const cfg = env(); const previousRetries = cfg.SYNC_MAX_RETRIES;
    cfg.SYNC_MAX_RETRIES = 1;
    mocks.posts.mockResolvedValue({ data: [{ id: "post-1", message: "context" }] });
    mocks.comments.mockResolvedValue({ data: [{ id: "bad-parent", message: "first" }, { id: "good-parent", message: "second" }] });
    mocks.replies.mockImplementation((id: string) => id === "bad-parent"
      ? Promise.reject(new MetaApiError("fixture permission error", 400, 10)) : Promise.resolve({ data: [] }));
    try {
      expect((await syncAllConnections(source.id))[0]).toMatchObject({ ok: true, failedTasks: 1, coverageLimited: true });
      expect((await db.select().from(socialItems)).map((row) => row.externalId).sort()).toEqual(["bad-parent", "good-parent"]);
      const saved = (await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, source.id) }))!;
      const state = JSON.parse(decryptSecret(String(saved.syncState.continuation)));
      expect(state.tasks).toHaveLength(0);
      expect(state.deadTasks).toHaveLength(1);
      expect(state.deadTasks[0]).toMatchObject({ kind: "replies", parent: { id: "bad-parent" }, fetchPending: true });
    } finally { cfg.SYNC_MAX_RETRIES = previousRetries; }
  });

  it("preserves sync failures through successful token health checks until reconciliation succeeds", async () => {
    const source = await connection();
    await db.update(socialConnections).set({ webhookSubscribed: true, status: "degraded", lastError: "sync_error:fixture",
      syncState: { syncError: "sync_error:fixture" } }).where(eq(socialConnections.id, source.id));
    mocks.debug.mockResolvedValue({ isValid: true, appId: env().META_APP_ID,
      scopes: ["pages_read_engagement", "pages_read_user_content", "pages_manage_metadata"], expiresAt: null });
    let current = (await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, source.id) }))!;
    expect(await checkConnectionHealth(current)).toMatchObject({ status: "degraded" });
    current = (await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, source.id) }))!;
    expect(current.lastError).toBe("sync_error:fixture");
    await syncAllConnections(source.id);
    current = (await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, source.id) }))!;
    expect(await checkConnectionHealth(current)).toMatchObject({ status: "active" });
    expect((await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, source.id) }))?.lastError).toBeNull();
  });

  it("rotates OAuth owner and disabled connection tokens without changing status", async () => {
    const source = await connection("disabled");
    await db.insert(metaAuthAccounts).values({ metaUserId: "owner-1", encryptedUserAccessToken: encryptSecret("owner-fixture") });
    const cfg = env(); const old = cfg.TOKEN_ENCRYPTION_KEY;
    cfg.TOKEN_ENCRYPTION_KEY_PREVIOUS = old; cfg.TOKEN_ENCRYPTION_KEY = Buffer.alloc(32, 2).toString("base64");
    try {
      expect(await rotateStoredTokens()).toEqual({ rotated: 2, failed: 0, remaining: 0 });
      cfg.TOKEN_ENCRYPTION_KEY_PREVIOUS = undefined;
      const changed = await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, source.id) });
      expect(changed?.status).toBe("disabled");
      expect(decryptSecret(changed!.encryptedAccessToken)).toBe("fixture-token");
      expect(decryptSecret((await db.query.metaAuthAccounts.findFirst())!.encryptedUserAccessToken)).toBe("owner-fixture");
    } finally { cfg.TOKEN_ENCRYPTION_KEY = old; cfg.TOKEN_ENCRYPTION_KEY_PREVIOUS = undefined; }
  });

  it("bounds retention batches and preserves recent records", async () => {
    await db.execute(sql`insert into oauth_nonces (nonce_hash, expires_at)
      select 'expired-' || n, now() - interval '3 days' from generate_series(1, 1001) n`);
    await db.execute(sql`insert into social_items (platform, external_id, text, raw, ingested_at)
      select 'facebook', 'old-' || n, 'fixture', '{}'::jsonb, now() - interval '100 days' from generate_series(1, 1001) n`);
    const recent = await item();
    await db.update(socialItems).set({ raw: { fixture: true } }).where(eq(socialItems.id, recent.id));
    await db.insert(oauthNonces).values({ nonceHash: "recent", expiresAt: new Date(Date.now() + 60_000) });
    const call = () => maintenance(new Request("http://localhost:3000/api/jobs/maintenance", {
      method: "POST", headers: { authorization: `Bearer ${env().CRON_SECRET}` },
    }));
    expect(await (await call()).json()).toMatchObject({ oauthNonces: 1000, rawItemsCleared: 1000, batchMayHaveMore: true });
    expect(await (await call()).json()).toMatchObject({ oauthNonces: 1, rawItemsCleared: 1, batchMayHaveMore: false });
    expect(await db.query.oauthNonces.findFirst()).toMatchObject({ nonceHash: "recent" });
    expect((await db.query.socialItems.findFirst({ where: eq(socialItems.id, recent.id) }))?.raw).toEqual({ fixture: true });
  });

  it("paginates PostgreSQL timestamps within one millisecond without losing rows", async () => {
    await db.execute(sql`insert into social_items (platform, external_id, text, ingested_at)
      values ('facebook', 'micro-1', 'fixture', '2026-01-01T12:00:00.123900Z'),
      ('facebook', 'micro-2', 'fixture', '2026-01-01T12:00:00.123800Z'),
      ('facebook', 'micro-3', 'fixture', '2026-01-01T12:00:00.123700Z')`);
    const rows = await db.select({ id: socialItems.id, at: socialItems.ingestedAt,
      preciseAt: sql<string>`to_char(${socialItems.ingestedAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    }).from(socialItems).orderBy(desc(socialItems.ingestedAt), desc(socialItems.id)).limit(1);
    const cursor = decodeItemCursor(encodeItemCursor(rows[0]!))!;
    const boundary = sql`${cursor.preciseAt}::timestamptz`;
    const remaining = await db.select({ externalId: socialItems.externalId }).from(socialItems).where(or(
      lt(socialItems.ingestedAt, boundary), and(eq(socialItems.ingestedAt, boundary), lt(socialItems.id, cursor.id)),
    )).orderBy(desc(socialItems.ingestedAt), desc(socialItems.id));
    expect(remaining.map((row) => row.externalId)).toEqual(["micro-2", "micro-3"]);
  });

  it("retains external source identity without reopening reviewed comments or duplicating alerts", async () => {
    const [video] = await db.insert(watchedVideos).values({ platform: "youtube", externalId: "video-1", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }).returning();
    const input = { platform: "youtube" as const, externalId: "external-comment", rootExternalId: "video-1", text: "Unchanged comment",
      raw: { external_source: true, watched_video_id: video!.id, source_channel: "Channel",
        source_post: { id: "video-1", text: "Post context" }, context_incomplete: false, provider_detail: "discard" } };
    const { item: source } = await upsertSocialItem(input);
    const [job] = await claimAnalysisJobs(1);
    await analyzeClaimedItem(job!.id, job!.lockId, async () => ({ ...result(), data: { label: "acil_inceleme" } }));
    await recordItemReview(source.id, { reviewStatus: "reviewed", expectedReviewStatus: "new", analysisRevision: source.analysisRevision });
    await db.update(socialItems).set({ ingestedAt: new Date(Date.now() - 100 * 86400000) }).where(eq(socialItems.id, source.id));
    const run = () => maintenance(new Request("http://localhost:3000/api/jobs/maintenance", {
      method: "POST", headers: { authorization: `Bearer ${env().CRON_SECRET}` },
    }));
    expect(await (await run()).json()).toMatchObject({ rawItemsCleared: 1 });
    expect((await db.query.socialItems.findFirst())?.raw).toEqual({ external_source: true, watched_video_id: video!.id,
      source_channel: "Channel", source_post: { id: "video-1", text: "Post context" } });
    expect(await (await run()).json()).toMatchObject({ rawItemsCleared: 0 });
    expect(await upsertSocialItem(input)).toMatchObject({ changed: false, item: { analysisRevision: source.analysisRevision, analysisStatus: "complete", reviewStatus: "reviewed" } });
    expect(await db.select().from(alertOutbox)).toHaveLength(1);
    expect(await db.select().from(itemReviewEvents)).toHaveLength(1);
    expect((await db.query.socialAnalyses.findFirst())?.triageLabel).toBe("acil_inceleme");
  });

  it("uses the same pending definition for source counts and the linked comment list", async () => {
    const source = await connection();
    for (const [index, label] of ["inceleme_gerekmiyor", "insan_incelemesi_gerekli", "acil_inceleme"].entries()) {
      await upsertSocialItem({ connectionId: source.id, platform: "facebook", externalId: `source-${index}`, rootExternalId: "post-1", text: "Comment" });
      const [job] = await claimAnalysisJobs(1);
      await analyzeClaimedItem(job!.id, job!.lockId, async () => ({ ...result(), data: { label: label as "inceleme_gerekmiyor" | "insan_incelemesi_gerekli" | "acil_inceleme" } }));
    }
    await upsertSocialItem({ connectionId: source.id, platform: "facebook", externalId: "waiting-analysis", rootExternalId: "post-1", text: "Pending analysis" });
    const page = await commentSources({});
    const pending = await commentRows({ source: sourceKey("facebook", "post-1"), view: "pending" });
    expect(page.rows[0]).toMatchObject({ comments: 4, pending: 2 });
    expect(pending).toHaveLength(page.rows[0]!.pending);
    expect(pending.map((row) => row.item.externalId).sort()).toEqual(["source-1", "source-2"]);
  });

  it("filters triage by owned account context while giving human decisions precedence", async () => {
    const source = await connection();
    const [target] = await db.insert(monitoringTargets).values({ name: "Hedef" }).returning();
    await db.insert(connectionTargets).values({ connectionId: source.id, targetId: target!.id });
    const saved = await item(source.id);
    const [job] = await claimAnalysisJobs(1);
    await analyzeClaimedItem(job!.id, job!.lockId, async () => ({ ...result(), data: { label: "insan_incelemesi_gerekli" } }));
    expect(await commentRows({ target: "Hedef" })).toHaveLength(1);
    expect((await db.query.socialAnalyses.findFirst())?.matchedTarget).toBeNull();
    await recordItemReview(saved.id, { reviewStatus: "reviewed", expectedReviewStatus: "new", analysisRevision: saved.analysisRevision,
      assessment: { verdict: "criticism", category: "criticism", severity: 0, targetMatch: false, matchedTarget: null, reason: "Different subject" } });
    expect(await commentRows({ target: "Hedef" })).toHaveLength(0);
    await db.delete(itemReviewEvents);
    await db.update(socialItems).set({ raw: { external_source: true } });
    expect(await commentRows({ target: "Hedef" })).toHaveLength(0);
    await recordItemReview(saved.id, { reviewStatus: "reviewed", expectedReviewStatus: "reviewed", analysisRevision: saved.analysisRevision,
      assessment: { verdict: "attack", category: "insult", severity: 70, targetMatch: true, matchedTarget: "Hedef", reason: "Explicit target" } });
    expect(await commentRows({ target: "Hedef" })).toHaveLength(1);
    expect(await commentRows({ target: "Hedef", view: "confirmed" })).toHaveLength(1);
  });

  it("switches Meta apps only after disconnect and removes unused old OAuth credentials", async () => {
    const [owner] = await db.insert(metaAuthAccounts).values({ metaUserId: "owner-1", encryptedUserAccessToken: encryptSecret("old-owner-token") }).returning();
    const source = await connection();
    await db.update(socialConnections).set({ authAccountId: owner!.id }).where(eq(socialConnections.id, source.id));
    const saved = await item(source.id);
    const settings = { appId: "2", appSecret: "new-app-secret-value", publicOrigin: "https://example.test", graphVersion: "v26.0", revision: 0 };
    expect(await (await saveMetaSettings(request(settings))).json()).toEqual({ error: "app_change_requires_disconnect" });
    await disconnect(request(), params(source.id));
    expect(await (await saveMetaSettings(request({ ...settings, appSecret: "" }))).json()).toEqual({ error: "app_secret_required" });
    expect(await db.select().from(metaAuthAccounts)).toHaveLength(1);
    expect((await saveMetaSettings(request(settings))).status).toBe(200);
    expect(await db.select().from(metaAuthAccounts)).toHaveLength(0);
    expect(await db.query.socialItems.findFirst({ where: eq(socialItems.id, saved.id) })).toMatchObject({ connectionId: null, text: saved.text });
    const current = await db.query.metaSettings.findFirst();
    expect(current).toMatchObject({ appId: "2", revision: 1 });
    expect(decryptSecret(current!.appSecretEncrypted)).toBe(settings.appSecret);
  });

  it("fences an OAuth callback when settings change after the owner has been saved", async () => {
    const entered = deferred<void>();
    const release = deferred<{ isValid: boolean; appId: string; scopes: string[] }>();
    mocks.debug.mockResolvedValueOnce({ isValid: true, appId: "1", userId: "owner-1", expiresAt: null })
      .mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const state = await createOAuthState();
    const callback = oauthCallback(new Request(`http://localhost:3000/api/meta/callback?code=fixture&state=${encodeURIComponent(state)}`));
    await entered.promise;
    expect(await db.select().from(metaAuthAccounts)).toHaveLength(1);
    expect((await saveMetaSettings(request({ appId: "1", appSecret: "rotated-app-secret", publicOrigin: "https://example.test", graphVersion: "v26.0", revision: 0 }))).status).toBe(200);
    release.resolve({ isValid: true, appId: "1", scopes: await mocks.scopes() });
    const response = await callback;
    expect(response.headers.get("location")).toContain("meta_error=connect_failed");
    expect(await db.select().from(socialConnections)).toHaveLength(0);
    expect(mocks.subscribe).not.toHaveBeenCalled();
    expect((await db.query.metaSettings.findFirst())?.revision).toBe(1);
  });

  it.each(["facebook", "instagram"] as const)("handles explicit %s delete without reviving a tombstone", async (platform) => {
    const source = await connection();
    await db.update(socialConnections).set({ platform }).where(eq(socialConnections.id, source.id));
    const saved = (await upsertSocialItem({ connectionId: source.id, platform, externalId: "comment-1", text: "delete fixture" })).item;
    const [job] = await claimAnalysisJobs(1); await analyzeClaimedItem(job!.id, job!.lockId);
    const payload = { object: platform === "facebook" ? "page" : "instagram", entry: [{ id: source.externalAccountId,
      changes: [{ field: platform === "facebook" ? "feed" : "comments", value: { id: saved.externalId, comment_id: saved.externalId, item: "comment", verb: "remove" } }],
    }] };
    expect(await processMetaWebhookPayload(payload)).toMatchObject({ processedChanges: 1 });
    expect((await db.query.socialItems.findFirst())?.deletedAt).toBeInstanceOf(Date);
    expect(await db.query.socialAnalyses.findFirst()).toBeUndefined();
    expect((await db.query.alertOutbox.findFirst())?.status).toBe("cancelled");
    await upsertSocialItem({ connectionId: source.id, platform, externalId: saved.externalId, text: "late reconciliation" });
    expect((await db.query.socialItems.findFirst())?.deletedAt).toBeInstanceOf(Date);
  });

  it("serializes concurrent ingestion of one external comment without duplicate errors", async () => {
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => item()));
    expect(new Set(outcomes.map((row) => row.id)).size).toBe(1);
    expect(await db.select().from(socialItems)).toHaveLength(1);
  });

  it("rejects the old LLM result after a comment edit", async () => {
    const pending = await pausedAnalysis();
    await upsertSocialItem({ platform: "facebook", externalId: "comment-1", text: "yeni yorum" });
    pending.release.resolve(result());
    expect(await pending.work).toEqual({ processed: false, reason: "lost_lock" });
    expect(await db.select().from(socialAnalyses)).toHaveLength(0);
    expect(await db.select().from(alertOutbox)).toHaveLength(0);
    const row = await db.query.socialItems.findFirst();
    expect(row?.analysisStatus).toBe("pending");
    expect(row?.analysisRevision).toBe(2);
  });

  it("rejects stale LLM results after mapping changes and does not requeue unchanged mappings", async () => {
    const source = await connection();
    const [target] = await db.insert(monitoringTargets).values({ name: "Hedef" }).returning();
    const pending = await pausedAnalysis(source.id);
    const change = await mapTargets(request({ targetIds: [target!.id] }), params(source.id));
    expect(change.status).toBe(200);
    pending.release.resolve(result());
    expect(await pending.work).toEqual({ processed: false, reason: "lost_lock" });
    expect(await db.select().from(socialAnalyses)).toHaveLength(0);
    const same = await mapTargets(request({ targetIds: [target!.id] }), params(source.id));
    expect((await same.json()).requeued).toBe(0);
    expect((await mapTargets(request({ targetIds: [], reanalyzeExisting: false }), params(source.id))).status).toBe(400);
  });

  it("invalidates decisions when a target is disabled and its mapping when deleted", async () => {
    const source = await connection();
    const [target] = await db.insert(monitoringTargets).values({ name: "Hedef" }).returning();
    await db.insert(connectionTargets).values({ connectionId: source.id, targetId: target!.id });
    await analyzed(source.id);
    expect((await patchTarget(request({ enabled: false }), params(target!.id))).status).toBe(200);
    expect(await db.select().from(socialAnalyses)).toHaveLength(0);
    expect((await db.query.alertOutbox.findFirst())?.status).toBe("cancelled");
    expect((await deleteTarget(request(), params(target!.id))).status).toBe(200);
    expect(await db.select().from(connectionTargets)).toHaveLength(0);
  });

  it("preserves history but fences old source context on disconnect", async () => {
    const source = await connection();
    const pending = await pausedAnalysis(source.id);
    expect((await disconnect(request(), params(source.id))).status).toBe(200);
    pending.release.resolve(result());
    expect(await pending.work).toEqual({ processed: false, reason: "lost_lock" });
    const row = await db.query.socialItems.findFirst();
    expect(row?.id).toBe(pending.source.id);
    expect(row?.connectionId).toBeNull();
    expect(await db.select().from(socialAnalyses)).toHaveLength(0);
  });

  it("cancels already-claimed superseded alerts before the HTTP request", async () => {
    await analyzed();
    const [job] = await claimAlertJobs(1);
    await upsertSocialItem({ platform: "facebook", externalId: "comment-1", text: "yeni yorum" });
    expect((await processClaimedAlert(job!.id, job!.lockId)).delivered).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
    expect((await db.query.alertOutbox.findFirst())?.status).toBe("cancelled");
  });

  it("records signed delivery and retains the same idempotency key on retry", async () => {
    await analyzed();
    const [first] = await claimAlertJobs(1);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 429 }));
    expect((await processClaimedAlert(first!.id, first!.lockId)).reason).toBe("retry");
    const firstHeaders = new Headers(vi.mocked(fetch).mock.calls[0]![1]?.headers);
    await db.update(alertOutbox).set({ availableAt: new Date(0) });
    const [second] = await claimAlertJobs(1);
    expect((await processClaimedAlert(second!.id, second!.lockId)).delivered).toBe(true);
    const nextHeaders = new Headers(vi.mocked(fetch).mock.calls[1]![1]?.headers);
    expect(nextHeaders.get("idempotency-key")).toBe(firstHeaders.get("idempotency-key"));
    expect(nextHeaders.get("x-sosyal-itibar-signature-256")).toMatch(/^sha256=[a-f0-9]{64}$/);
    expect((await db.query.alertOutbox.findFirst())?.status).toBe("delivered");
  });

  it("dead-letters nonretryable receiver failures and retries network timeouts", async () => {
    await analyzed();
    let [job] = await claimAlertJobs(1);
    vi.mocked(fetch).mockRejectedValueOnce(new DOMException("Timed out", "AbortError"));
    expect((await processClaimedAlert(job!.id, job!.lockId)).reason).toBe("retry");
    await db.update(alertOutbox).set({ availableAt: new Date(0) });
    [job] = await claimAlertJobs(1);
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 400 }));
    expect((await processClaimedAlert(job!.id, job!.lockId)).reason).toBe("dead");
  });

  it("accepts dispatch once and records its result after a concurrent edit", async () => {
    const source = await analyzed();
    const [job] = await claimAlertJobs(1);
    const entered = deferred<void>(); const release = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const delivery = processClaimedAlert(job!.id, job!.lockId);
    await entered.promise;
    const accepted = await db.query.alertOutbox.findFirst();
    expect(accepted?.dispatchStartedAt).toBeInstanceOf(Date);
    expect(await processClaimedAlert(job!.id, job!.lockId)).toMatchObject({ delivered: false });
    await upsertSocialItem({ platform: "facebook", externalId: source.externalId, text: "edited during accepted delivery" });
    expect((await db.query.alertOutbox.findFirst())?.status).toBe("processing");
    await processClaimedAlert(job!.id, job!.lockId);
    expect((await db.query.alertOutbox.findFirst())?.status).toBe("processing");
    release.resolve(new Response(null, { status: 200 }));
    expect(await delivery).toMatchObject({ delivered: true });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect((await db.query.alertOutbox.findFirst())?.status).toBe("delivered");
  });

  it("does not retry an accepted old delivery after its source changes", async () => {
    const source = await analyzed(); const [job] = await claimAlertJobs(1);
    const entered = deferred<void>(); const release = deferred<Response>();
    vi.mocked(fetch).mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const delivery = processClaimedAlert(job!.id, job!.lockId); await entered.promise;
    await upsertSocialItem({ platform: "facebook", externalId: source.externalId, text: "changed" });
    release.resolve(new Response(null, { status: 503 }));
    expect(await delivery).toMatchObject({ reason: "retry" });
    await db.update(alertOutbox).set({ availableAt: new Date(0) });
    const [retry] = await claimAlertJobs(1);
    expect(await processClaimedAlert(retry!.id, retry!.lockId)).toMatchObject({ reason: "cancelled" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not reactivate a paused connection when a health response arrives late", async () => {
    const source = await connection();
    const entered = deferred<void>(); const release = deferred<{ isValid: boolean; scopes: string[] }>();
    mocks.debug.mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const work = checkConnectionHealth(source);
    await entered.promise;
    expect((await patchConnection(request({ status: "disabled" }), params(source.id))).status).toBe(200);
    release.resolve({ isValid: true, scopes: ["pages_read_engagement", "pages_read_user_content", "pages_manage_metadata"] });
    await work;
    expect((await db.query.socialConnections.findFirst())?.status).toBe("disabled");
  });

  it("does not reactivate a paused connection when reconciliation completes late", async () => {
    const source = await connection();
    const entered = deferred<void>(); const release = deferred<{ data: never[] }>();
    mocks.posts.mockImplementationOnce(() => { entered.resolve(); return release.promise; });
    const work = syncAllConnections(source.id);
    await entered.promise;
    await patchConnection(request({ status: "disabled" }), params(source.id));
    release.resolve({ data: [] }); await work;
    const row = await db.query.socialConnections.findFirst();
    expect(row?.status).toBe("disabled"); expect(row?.syncLockId).toBeNull();
  });

  it("requires reauthorization for revoked connections", async () => {
    const source = await connection("revoked");
    await checkConnectionHealth(source);
    expect(mocks.debug).not.toHaveBeenCalled();
    expect((await patchConnection(request({ status: "active" }), params(source.id))).status).toBe(409);
    expect((await db.query.socialConnections.findFirst())?.status).toBe("revoked");
  });

  it("surfaces reply reconciliation failures instead of reporting a successful empty sync", async () => {
    const source = await connection();
    mocks.posts.mockResolvedValue({ data: [{ id: "post-1" }] });
    mocks.comments.mockResolvedValue({ data: [{ id: "comment-1", message: "yorum" }] });
    mocks.replies.mockRejectedValue(new Error("reply timeout"));
    expect((await syncAllConnections(source.id))[0]).toMatchObject({ ok: true, coverageLimited: true, retryTasks: 1, items: 1 });
    expect((await db.query.socialConnections.findFirst())?.status).toBe("degraded");
  });

  it("fences stale analysis locks after recovery", async () => {
    const pending = await pausedAnalysis();
    await db.update(socialItems).set({ analysisLockedAt: new Date(0) }).where(eq(socialItems.id, pending.source.id));
    expect(await requeueStaleAnalysisLocks()).toBe(1);
    const [newJob] = await claimAnalysisJobs(1);
    expect(newJob?.lockId).not.toBe(pending.job.lockId);
    expect(await analyzeClaimedItem(newJob!.id, newJob!.lockId)).toEqual({ processed: true });
    pending.release.resolve({ ...result(), inputHash: "old" });
    expect(await pending.work).toEqual({ processed: false, reason: "lost_lock" });
    expect((await db.query.socialAnalyses.findFirst())?.inputHash).toBe("a".repeat(64));
  });

  it("recovers at most 100 authentication failures and preserves human and unavailable records", async () => {
    const rows = await db.insert(socialItems).values(Array.from({ length: 101 }, (_, index) => ({
      platform: "youtube", externalId: `dead-${index}`, text: "sentetik", analysisStatus: "dead", analysisError: "LLM HTTP 401", analysisAttempts: 5,
    }))).returning();
    const [reviewed] = await db.insert(socialItems).values({ platform: "youtube", externalId: "reviewed", text: "insan inceledi",
      analysisStatus: "dead", analysisError: "LLM HTTP 401", reviewStatus: "reviewed" }).returning();
    await db.insert(socialItems).values([
      { platform: "youtube", externalId: "other-error", text: "sentetik", analysisStatus: "dead", analysisError: "LLM HTTP 429" },
      { platform: "youtube", externalId: "unavailable", text: "sentetik", analysisStatus: "dead", analysisError: "LLM HTTP 401", sourceUnavailableAt: new Date() },
    ]);
    const response = await retryDeadAnalysis(request(), params("auth-failures"));
    expect(await response.json()).toEqual({ ok: true, count: 100 });
    const pending = await db.select().from(socialItems).where(eq(socialItems.analysisStatus, "pending"));
    expect(pending).toHaveLength(100);
    expect(pending.every((row) => row.analysisRevision === 2 && row.analysisAttempts === 0 && row.analysisError === null)).toBe(true);
    expect((await db.query.socialItems.findFirst({ where: eq(socialItems.id, reviewed!.id) }))?.reviewStatus).toBe("reviewed");
    const recoveryAudit = await db.query.auditLogs.findFirst({ where: eq(auditLogs.action, "dead_letter.analysis_requeue") });
    expect(recoveryAudit?.metadata.reason).toBe("authentication_recovery");
    expect((recoveryAudit?.metadata.ids as string[])).toHaveLength(100);
    const [left] = rows.filter((row) => !pending.some((candidate) => candidate.id === row.id));
    expect(left).toBeDefined();
    expect(await (await retryDeadAnalysis(request(), params("auth-failures"))).json()).toEqual({ ok: true, count: 1 });
    expect(await (await retryDeadAnalysis(request(), params("auth-failures"))).json()).toEqual({ ok: true, count: 0 });
  });

  it("rolls back a requeue when its audit write fails", async () => {
    const source = await item();
    await db.update(socialItems).set({ analysisStatus: "dead", analysisError: "LLM HTTP 401" }).where(eq(socialItems.id, source.id));
    const spy = vi.spyOn(auditModule, "audit").mockRejectedValueOnce(new Error("audit unavailable"));
    try { await expect(retryDeadAnalysis(request(), params(source.id))).rejects.toThrow("audit unavailable"); }
    finally { spy.mockRestore(); }
    expect(await db.query.socialItems.findFirst({ where: eq(socialItems.id, source.id) })).toMatchObject({ analysisStatus: "dead", analysisRevision: 1 });
  });

  it("serializes duplicate requeues without advancing the revision twice", async () => {
    const source = await item();
    await db.update(socialItems).set({ analysisStatus: "dead" }).where(eq(socialItems.id, source.id));
    const responses = await Promise.all([retryDeadAnalysis(request(), params(source.id)), retryDeadAnalysis(request(), params(source.id))]);
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    expect(await db.query.socialItems.findFirst({ where: eq(socialItems.id, source.id) })).toMatchObject({ analysisStatus: "pending", analysisRevision: 2 });
  });

  it("polls older loaded comments in bounded POST batches and rejects unsafe requests", async () => {
    const rows = await db.insert(socialItems).values(Array.from({ length: 1005 }, (_, index) => ({
      platform: "youtube", externalId: `loaded-${index}`, text: "sentetik",
    }))).returning();
    const after = encodeItemCursor({ at: new Date("2100-01-01"), id: rows[0]!.id });
    const make = (ids: string[], origin = "http://localhost:3000") => new Request("http://localhost:3000/api/items/updates", {
      method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify({ after, ids }),
    });
    const first = await pollUpdates(make(rows.slice(0, 1000).map((row) => row.id)));
    expect(first.status).toBe(200); expect((await first.json()).updates).toHaveLength(1000);
    await db.update(socialItems).set({ reviewStatus: "reviewed" }).where(eq(socialItems.id, rows[1004]!.id));
    const tail = await (await pollUpdates(make(rows.slice(1000).map((row) => row.id)))).json();
    expect(tail.updates.find((row: { id: string }) => row.id === rows[1004]!.id).reviewStatus).toBe("reviewed");
    expect((await pollUpdates(make(rows.map((row) => row.id)))).status).toBe(400);
    expect((await pollUpdates(make([], "https://evil.test"))).status).toBe(403);
    expect((await pollUpdates(request({ after, ids: [], extra: "x".repeat(65536) }))).status).toBe(400);
    expect((await pollLegacyUpdates(new Request(`http://localhost:3000/api/items/updates?after=${after}&ids=${rows[0]!.id}`))).status).toBe(200);
  });

  it("edits scan limits without deleting history, resuming a pause or replacing a running scan", async () => {
    const [video] = await db.insert(watchedVideos).values({ platform: "instagram", provider: "apify", externalId: "public:instagram:AuditPost",
      url: "https://www.instagram.com/p/AuditPost", status: "paused", lastSyncedAt: new Date(), availableAt: new Date(Date.now() + 3600000) }).returning();
    const settings = { resultsLimit: 5000, maxChargeCents: 200, pollMinutes: 120 };
    const response = await configureVideo(request({ action: "configure", revision: 1, settings }), params(video!.id));
    expect(response.status).toBe(200);
    const saved = await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, video!.id) });
    expect(saved).toMatchObject({ ...settings, status: "paused", revision: 2 });
    expect((await configureVideo(request({ action: "configure", revision: 1, settings }), params(video!.id))).status).toBe(409);
    await db.update(watchedVideos).set({ progressEncrypted: encryptSecret("unfinished") }).where(eq(watchedVideos.id, video!.id));
    expect((await configureVideo(request({ action: "configure", revision: 2, settings }), params(video!.id))).status).toBe(409);
    expect((await configureVideo(request({ action: "configure", revision: 2, settings: { ...settings, resultsLimit: 10001 } }), params(video!.id))).status).toBe(400);
    expect(mocks.analyze).not.toHaveBeenCalled();
  });

  it("exposes overdue source coverage without leaking source credentials or checkpoints", async () => {
    await db.insert(watchedVideos).values({ platform: "instagram", provider: "apify", externalId: "public:instagram:AuditPost",
      url: "https://www.instagram.com/p/AuditPost", apiKeyEncrypted: encryptSecret("do-not-expose"),
      availableAt: new Date(Date.now() - 3600000), lastSyncedAt: new Date(Date.now() - 7200000) });
    const page = await commentSources({});
    expect(page.rows[0]?.scan).toMatchObject({ overdue: true, provider: "apify", resultsLimit: 1000, maxChargeCents: 100, running: false });
    expect(JSON.stringify(page)).not.toContain("do-not-expose");
    expect(JSON.stringify(page)).not.toContain("api_key_encrypted");
    const connected = await connection("disabled");
    await upsertSocialItem({ connectionId: connected.id, platform: "facebook", externalId: "meta-comment", rootExternalId: "meta-post", text: "sentetik" });
    const metaPage = await commentSources({ platform: "facebook" });
    expect(metaPage.rows[0]?.scan).toMatchObject({ provider: "meta", status: "paused" });
  });

  it("accepts an OAuth nonce once, including parallel replay attempts", async () => {
    const state = await createOAuthState();
    const accepted = await Promise.all([consumeOAuthState(state), consumeOAuthState(state)]);
    expect(accepted.filter(Boolean)).toHaveLength(1);
  });

  it("scrapes real PostgreSQL metrics with empty, future and runnable queues", async () => {
    const req = new Request("http://localhost:3000/api/metrics", { headers: { authorization: `Bearer ${env().CRON_SECRET}` } });
    expect((await metrics(req)).status).toBe(200);
    await db.insert(webhookEvents).values({ dedupeKey: "future", payload: {}, status: "retry", availableAt: new Date(Date.now() + 60_000) });
    let response = await metrics(req); expect(await response.text()).toContain('queue="webhook"} 0');
    await db.insert(webhookEvents).values({ dedupeKey: "ready", payload: {}, availableAt: new Date(Date.now() - 60_000) });
    response = await metrics(req);
    const age = Number((await response.text()).match(/sosyal_itibar_queue_oldest_age_seconds\{queue="webhook"\} ([\d.]+)/)?.[1]);
    expect(age).toBeGreaterThan(55);
    expect(age).toBeLessThan(70);
  });
});
