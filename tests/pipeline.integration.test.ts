import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { alertOutbox, alertSettings, analysisProviderState, connectionTargets, itemReviewEvents, itemTranslations, metaAuthAccounts, oauthNonces, monitoringTargets, socialAnalyses, socialConnections, socialItems, watchedVideos, webhookEvents } from "@/db/schema";
import { encodeItemCursor, decodeItemCursor } from "@/lib/cursor";
import { env } from "@/lib/config";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { analyzeClaimedItem, beginSourceRead, claimAnalysisJobs, markSourceUnavailable, processAnalysisJobs, requeueStaleAnalysisLocks, upsertSocialItem } from "@/lib/ingest";
import { analysisProviderKey } from "@/lib/batch-triage";
import { getLlmSettings } from "@/lib/llm-settings";
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
import { loadCommentPage } from "@/app/actions/comment-feed";
import { commentSources } from "@/lib/comment-sources";
import { PUT as saveMetaSettings } from "@/app/api/settings/meta/route";
import { GET as oauthCallback } from "@/app/api/meta/callback/route";
import { PUT as saveLlmSettings } from "@/app/api/settings/llm/route";
import VideosPage from "@/app/settings/videos/page";
import { POST as addYouTubeChannel } from "@/app/api/youtube/channels/route";
import { PUT as saveYouTubeSettings } from "@/app/api/settings/youtube/route";
import { POST as addVideo } from "@/app/api/videos/route";
import { invalidateAnalyses } from "@/lib/analysis-state";
import { collectWatchedVideos } from "@/lib/watched-videos";
import { PATCH as configureVideo } from "@/app/api/videos/[id]/route";
import { DELETE as purgeSource } from "@/app/api/sources/[key]/route";
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

async function within<T>(work: Promise<T>, milliseconds = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Concurrent worker unexpectedly blocked")), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
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
  return (await upsertSocialItem({ connectionId, platform: "facebook", externalId: "comment-1", text: "ilk yorum" })).item!;
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
    await db.execute(sql`truncate analysis_provider_state, audit_logs, webhook_events, alert_outbox, social_analyses, social_items,
      connection_targets, social_connections, meta_auth_accounts, monitoring_targets, oauth_nonces, auth_rate_limits, alert_settings, worker_heartbeats, ai_policy, meta_settings, llm_settings, youtube_settings cascade`);
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
    expect(stale).toMatchObject({ changed: false, item: { text: "new text", analysisRevision: current.item!.analysisRevision, sourceReadVersion: newer } });
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
    expect(await db.query.socialAnalyses.findFirst({ where: eq(socialAnalyses.itemId, source.item!.id) }))
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

  it.each(["recent", "oldest"])("paginates comment sort %s with tied microsecond timestamps and active filters", async commentSort => {
    const account = await connection();
    await db.execute(sql`insert into social_items (id, connection_id, platform, external_id, root_external_id, text, ingested_at, analysis_excluded, analysis_status)
      select ('00000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid, ${account.id}::uuid, 'facebook', 'sort-' || n, 'sort-post', 'fixture',
        '2026-01-01T12:00:00.123000Z'::timestamptz + (n / 3) * interval '1 microsecond', true, 'complete'
      from generate_series(0, 107) n`);
    await db.insert(socialItems).values([
      { platform: "facebook", externalId: "outside-account", rootExternalId: "sort-post", text: "fixture", ingestedAt: new Date("2026-01-01"), analysisExcluded: true, analysisStatus: "complete" },
      { platform: "facebook", externalId: "outside-source", connectionId: account.id, rootExternalId: "other-post", text: "fixture", ingestedAt: new Date("2026-01-01"), analysisExcluded: true, analysisStatus: "complete" },
      { platform: "facebook", externalId: "outside-query", connectionId: account.id, rootExternalId: "sort-post", text: "other", ingestedAt: new Date("2026-01-01"), analysisExcluded: true, analysisStatus: "complete" },
    ]);
    const filters = { commentSort, source: sourceKey("facebook", "sort-post"), connection: account.id, q: "fixture", from: "2026-01-01", to: "2026-01-01", view: "history", review: "new" };
    const first = await commentRows(filters);
    expect(first).toHaveLength(101);
    const visible = first.slice(0, 100); const last = visible.at(-1)!;
    const next = await loadCommentPage({ ...filters, cursor: encodeItemCursor({ at: last.item.ingestedAt, id: last.item.id, preciseAt: last.cursorAt }) });
    expect(next.rows).toHaveLength(8); expect(next.nextCursor).toBeNull();
    const actual = [...visible, ...next.rows].map(row => row.item.externalId);
    const expected = Array.from({ length: 108 }, (_, n) => `sort-${n}`);
    expect(actual).toEqual(commentSort === "oldest" ? expected : expected.reverse());
    expect(new Set(actual).size).toBe(108);
    const fallback = await commentRows({ ...filters, commentSort: "unknown" });
    expect(fallback[0]!.item.externalId).toBe("sort-107");
  });

  it("retains external source identity without reopening reviewed comments or duplicating alerts", async () => {
    const [video] = await db.insert(watchedVideos).values({ platform: "youtube", externalId: "video-1", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }).returning();
    const input = { platform: "youtube" as const, externalId: "external-comment", rootExternalId: "video-1", text: "Unchanged comment",
      raw: { external_source: true, watched_video_id: video!.id, source_channel: "Channel",
        source_post: { id: "video-1", text: "Post context" }, context_incomplete: false, provider_detail: "discard" } };
    const { item: source } = await upsertSocialItem(input);
    expect.assert(source);
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
    await db.insert(watchedVideos).values({ platform: "youtube", externalId: "EmptySrc001", url: "https://youtu.be/EmptySrc001" });
    expect((await commentSources({ sourceFilter: "pending" })).rows.map(row => row.source_id)).toEqual(["post-1"]);
    expect((await commentSources({ sourceFilter: "risk" })).rows.map(row => row.source_id)).toEqual(["post-1"]);
    const empty = await commentSources({ sourceFilter: "empty" });
    expect(empty.total).toBe(1);
    expect(empty.rows[0]?.source_id).toBe("EmptySrc001");
    expect((await commentSources({ source: sourceKey("facebook", "post-1"), sourceFilter: "empty" }, true)).rows[0]?.source_id).toBe("post-1");
  });

  it.each(["recent", "oldest", "comments", "pending", "risk"])("paginates source sort %s with tied timestamps and scopes cursors to the active filters", async sourceSort => {
    const inserted = await db.insert(socialItems).values(Array.from({ length: 28 }, (_, group) => Array.from({ length: group % 3 + 1 }, (_, item) => ({
      platform: group % 2 ? "facebook" : "youtube", externalId: `sort-${group}-${item}`, rootExternalId: group === 0 ? null : `post-${String(group).padStart(2, "0")}`,
      text: "Sentetik sıralama yorumu", analysisStatus: "complete", ingestedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, Math.floor(group / 3))),
    }))).flat()).returning({ id: socialItems.id });
    await db.insert(socialAnalyses).values(inserted.map((item, index) => ({ itemId: item.id, model: "fixture", promptVersion: "fixture", inputHash: "a".repeat(64),
      needsReview: index % 2 === 0, severity: index % 4 === 0 ? 80 : 0 })));
    const first = await commentSources({ sourceSort });
    const second = await commentSources({ sourceSort, sourceAfter: first.next! });
    const all = [...first.rows, ...second.rows];
    expect(first.rows).toHaveLength(24);
    expect(first.total).toBe(28);
    expect(second.rows).toHaveLength(4);
    expect(second.next).toBeNull();
    expect(new Set(all.map(row => row.key)).size).toBe(28);
    const values = all.map(row => sourceSort === "comments" ? row.comments : sourceSort === "pending" ? row.pending : sourceSort === "risk" ? row.risk : new Date(row.latest_at).getTime());
    expect(values).toEqual([...values].sort((a, b) => sourceSort === "oldest" ? a - b : b - a));
    const changedSort = sourceSort === "oldest" ? "recent" : "oldest";
    expect((await commentSources({ sourceSort: changedSort, sourceAfter: first.next! })).rows.map(row => row.key))
      .toEqual((await commentSources({ sourceSort: changedSort })).rows.map(row => row.key));
    expect((await commentSources({ sourceSort, sourceFilter: "pending", sourceAfter: first.next! })).rows.map(row => row.key))
      .toEqual((await commentSources({ sourceSort, sourceFilter: "pending" })).rows.map(row => row.key));
    expect(mocks.analyze).not.toHaveBeenCalled();
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
    const saved = (await upsertSocialItem({ connectionId: source.id, platform, externalId: "comment-1", text: "delete fixture" })).item!;
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

  it("purges a source with analyses, translations, reviews and alerts while preserving other sources", async () => {
    const root = "dQw4w9WgXcQ";
    const [watch] = await db.insert(watchedVideos).values({ platform: "youtube", externalId: root, url: `https://www.youtube.com/watch?v=${root}`,
      title: "Private title", sourceText: "Private context", apiKeyEncrypted: encryptSecret("private-key") }).returning();
    const rows = await db.insert(socialItems).values([
      { platform: "youtube", externalId: "purge-parent", rootExternalId: root, text: "private comment" },
      { platform: "youtube", externalId: "purge-reply", rootExternalId: root, parentExternalId: "purge-parent", itemType: "reply", text: "private reply" },
      { platform: "youtube", externalId: "keep-other", rootExternalId: "other-root", text: "keep" },
      { platform: "facebook", externalId: "keep-platform", rootExternalId: root, text: "keep" },
    ]).returning();
    await db.insert(socialAnalyses).values({ itemId: rows[0]!.id, model: "fixture", promptVersion: "fixture", inputHash: "a", needsReview: true });
    await db.insert(itemTranslations).values({ itemId: rows[0]!.id, analysisRevision: 1, text: "private translation", model: "fixture" });
    await recordItemReview(rows[0]!.id, { reviewStatus: "reviewed", expectedReviewStatus: "new", analysisRevision: 1 });
    await db.insert(alertOutbox).values(["pending", "processing", "retry", "dead", "delivered"].map(status => ({ itemId: rows[0]!.id,
      dedupeKey: `purge-${status}`, ruleKey: "fixture", status, payload: { text: "private alert" } })));
    const key = { params: Promise.resolve({ key: sourceKey("youtube", root) }) };
    expect((await purgeSource(request({ confirm: "delete_source", revision: 2 }), key)).status).toBe(409);
    expect(await db.select().from(socialItems)).toHaveLength(4);
    const removed = await purgeSource(request({ confirm: "delete_source", revision: 1 }), key);
    expect(removed.status).toBe(200); expect(await removed.json()).toMatchObject({ deleted: true, commentsDeleted: 2 });
    expect((await db.select().from(socialItems)).map(row => row.externalId).sort()).toEqual(["keep-other", "keep-platform"]);
    for (const table of [socialAnalyses, itemTranslations, itemReviewEvents, alertOutbox]) expect(await db.select().from(table)).toHaveLength(0);
    expect(await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, watch!.id) })).toMatchObject({ status: "removed", revision: 2,
      url: "", title: null, sourceText: null, apiKeyEncrypted: null, progressEncrypted: null });
    expect((await commentSources({ platform: "youtube" })).rows.some(row => row.source_id === root)).toBe(false);
    expect(await db.select().from(auditLogs).where(eq(auditLogs.entityId, rows[0]!.id))).toHaveLength(0);
    expect((await db.query.auditLogs.findFirst({ where: eq(auditLogs.action, "source.purged") }))?.metadata).toEqual({ commentsDeleted: 2 });
    expect(await upsertSocialItem({ platform: "youtube", externalId: "late-comment", rootExternalId: root, text: "late" }))
      .toMatchObject({ suppressed: true, item: null });
    expect((await saveYouTubeSettings(request({ apiKey: "fixture-key", revision: 0 }))).status).toBe(200);
    expect((await addVideo(request({ platform: "youtube", url: `https://www.youtube.com/watch?v=${root}` }))).status).toBe(201);
    expect((await upsertSocialItem({ platform: "youtube", externalId: "fresh-comment", rootExternalId: root, text: "fresh" })).created).toBe(true);
    expect((await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, watch!.id) }))?.purgedAt).toBeNull();
  });

  it("purges retained history after unfollowing and rejects an in-flight analysis result", async () => {
    const root = "dQw4w9WgXcQ";
    const [watch] = await db.insert(watchedVideos).values({ platform: "facebook", externalId: root, url: "https://www.facebook.com/fixture" }).returning();
    const source = await item();
    await db.update(socialItems).set({ rootExternalId: root }).where(eq(socialItems.id, source.id));
    const entered = deferred<void>(); const release = deferred<ReturnType<typeof result>>();
    const [job] = await claimAnalysisJobs(1);
    const analysis = analyzeClaimedItem(job!.id, job!.lockId, async () => { entered.resolve(); return release.promise; });
    await entered.promise;
    await configureVideo(request({ action: "remove", revision: 1 }), params(watch!.id));
    expect((await commentSources({ platform: "facebook" })).rows[0]?.watch).toMatchObject({ id: watch!.id, status: "removed", revision: 2 });
    const removed = await purgeSource(request({ confirm: "delete_source", revision: 2 }), { params: Promise.resolve({ key: sourceKey("facebook", root) }) });
    expect(removed.status).toBe(200);
    release.resolve(result());
    expect(await analysis).toEqual({ processed: false, reason: "lost_lock" });
    expect(await db.select().from(socialAnalyses)).toHaveLength(0);
    expect(await db.select().from(alertOutbox)).toHaveLength(0);
  });

  it("purges native Meta source queues without removing other changes or resuming a disabled account", async () => {
    const account = await connection("disabled");
    await upsertSocialItem({ connectionId: account.id, platform: "facebook", externalId: "purge-comment", rootExternalId: "purge-post", text: "private" });
    const keep = { field: "feed", value: { post_id: "keep-post", comment_id: "keep-comment", message: "keep" } };
    const remove = { field: "feed", value: { post_id: "purge-post", comment_id: "purge-comment", message: "private" } };
    await db.insert(webhookEvents).values({ dedupeKey: "mixed", objectType: "page", status: "processing", lockId: "old-worker",
      payload: { object: "page", entry: [{ id: "page-1", changes: [remove, keep] }] } });
    await db.insert(webhookEvents).values({ dedupeKey: "only-purge", objectType: "page",
      payload: { object: "page", entry: [{ id: "page-1", changes: [remove] }] } });
    const task = (id: string) => ({ kind: "comments", root: { id }, page: { data: [{ id: `${id}-comment`, message: id }] }, sourceReadVersion: 1 });
    await db.update(socialConnections).set({ syncLockId: "stale", syncState: { continuation: encryptSecret(JSON.stringify({ tasks: [task("purge-post"), task("keep-post")], deadTasks: [] })) } }).where(eq(socialConnections.id, account.id));
    const key = { params: Promise.resolve({ key: sourceKey("facebook", "purge-post") }) };
    expect((await purgeSource(request({ revision: null }), key)).status).toBe(400);
    expect((await purgeSource(new Request("http://localhost:3000/api/test", { method: "DELETE", headers: { origin: "https://evil.test" } }), key)).status).toBe(403);
    expect((await purgeSource(request({ confirm: "delete_source", revision: null }), key)).status).toBe(200);
    const mixed = await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.dedupeKey, "mixed") });
    expect(mixed).toMatchObject({ status: "pending", lockId: null, payload: { object: "page", entry: [{ id: "page-1", changes: [keep] }] } });
    const single = await db.query.webhookEvents.findFirst({ where: eq(webhookEvents.dedupeKey, "only-purge") });
    expect(single).toMatchObject({ status: "processed", payload: { object: "page", entry: [] } });
    const saved = await db.query.socialConnections.findFirst({ where: eq(socialConnections.id, account.id) });
    expect(saved).toMatchObject({ status: "disabled", syncLockId: null });
    expect(JSON.parse(decryptSecret(String(saved!.syncState.continuation)))).toMatchObject({ tasks: [task("keep-post")], deadTasks: [] });
    expect(await upsertSocialItem({ platform: "facebook", externalId: "purge-comment", rootExternalId: "purge-post", text: "late webhook" })).toMatchObject({ suppressed: true });
    expect((await purgeSource(request({ confirm: "delete_source", revision: null }), { params: Promise.resolve({ key: sourceKey("facebook", null) }) })).status).toBe(400);
  });

  it("requeues only failed official videos of the selected channel without duplicate scheduling or history loss", async () => {
    const channels = await db.insert(watchedVideos).values(["selected", "other"].map(name => ({ platform: "youtube", sourceKind: "channel", externalId: `UC${(name === "selected" ? "a" : "b").repeat(22)}`, url: `https://www.youtube.com/@${name}`, uploadsPlaylistId: "uploads-fixture", analysisAfter: new Date("2026-01-01") }))).returning();
    const channel = channels[0]!; const cutoff = new Date("2026-01-01");
    const children = await db.insert(watchedVideos).values([
      { platform: "youtube", channelId: channel.id, externalId: "failed-1", url: "fixture", status: "blocked", revision: 3, attempts: 8, lastError: "source_pagination_stalled", progressEncrypted: encryptSecret("old checkpoint"), analysisAfter: cutoff },
      { platform: "youtube", channelId: channel.id, externalId: "failed-2", url: "fixture", status: "blocked", analysisAfter: cutoff },
      { platform: "youtube", channelId: channel.id, externalId: "completed", url: "fixture", status: "active", lastSyncedAt: cutoff },
      { platform: "youtube", channelId: channel.id, externalId: "waiting", url: "fixture", status: "active" },
      { platform: "youtube", channelId: channel.id, externalId: "paused", url: "fixture", status: "paused" },
      { platform: "youtube", channelId: channel.id, externalId: "removed", url: "fixture", status: "removed", purgedAt: cutoff },
      { platform: "youtube", channelId: channels[1]!.id, externalId: "other-channel", url: "fixture", status: "blocked" },
    ].map(child => ({ ...child, analysisAfter: cutoff }))).returning();
    const saved = (await upsertSocialItem({ platform: "youtube", externalId: "saved-history", rootExternalId: "failed-1", text: "history", analysisExcluded: true })).item!;
    expect((await configureVideo(request({ action: "retry_failed", revision: 2 }), params(channel.id))).status).toBe(409);
    const responses = await Promise.all([1, 2].map(() => configureVideo(request({ action: "retry_failed", revision: 1 }), params(channel.id))));
    expect(responses.every(response => response.status === 200)).toBe(true);
    const results = await Promise.all(responses.map(response => response.json()));
    expect(results.map(body => body.queued).sort()).toEqual([0, 2]);
    const updated = await db.select().from(watchedVideos).where(eq(watchedVideos.channelId, channel.id));
    expect(updated.find(row => row.externalId === "failed-1")).toMatchObject({ status: "active", revision: 4, attempts: 0, lastError: null, progressEncrypted: null, lockId: null, analysisAfter: cutoff });
    expect(updated.find(row => row.externalId === "failed-2")).toMatchObject({ status: "active", revision: 2, analysisAfter: cutoff });
    for (const child of children.slice(2)) expect(await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, child.id) })).toEqual(child);
    expect(await db.query.socialItems.findFirst({ where: eq(socialItems.id, saved.id) })).toMatchObject({ text: "history", analysisExcluded: true, analysisStatus: "complete" });
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "youtube_channel.retry_failed_videos"));
    expect(audits).toHaveLength(1); expect(audits[0]!.metadata).toEqual({ count: 2 });
    expect(fetch).not.toHaveBeenCalled(); expect(mocks.analyze).not.toHaveBeenCalled();
  });

  it("rejects channel failure retries while paused or blocked and never resumes the channel implicitly", async () => {
    const [channel] = await db.insert(watchedVideos).values({ platform: "youtube", sourceKind: "channel", externalId: `UC${"c".repeat(22)}`, url: "fixture", uploadsPlaylistId: "uploads-fixture", analysisAfter: new Date("2026-01-01"), status: "paused" }).returning();
    const [child] = await db.insert(watchedVideos).values({ platform: "youtube", channelId: channel!.id, externalId: "failed-child", url: "fixture", analysisAfter: new Date("2026-01-01"), status: "blocked" }).returning();
    for (const status of ["paused", "blocked"]) {
      await db.update(watchedVideos).set({ status }).where(eq(watchedVideos.id, channel!.id));
      const response = await configureVideo(request({ action: "retry_failed", revision: 1 }), params(channel!.id));
      expect(response.status).toBe(409); expect(await response.json()).toMatchObject({ error: "channel_paused" });
      expect((await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, channel!.id) }))?.status).toBe(status);
    }
    expect(await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, child!.id) })).toEqual(child);
    expect((await configureVideo(request({ action: "retry_failed", revision: 1 }), params(child!.id))).status).toBe(409);
    expect((await configureVideo(new Request("http://localhost:3000/api/test", { method: "PATCH", headers: { origin: "https://evil.test" } }), params(channel!.id))).status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
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
    expect(page.rows[0]?.watch).toMatchObject({ revision: 1, status: "active", provider: "apify", channelPaused: false, running: false });
    expect(JSON.stringify(page)).not.toContain("do-not-expose");
    expect(JSON.stringify(page)).not.toContain("api_key_encrypted");
    const connected = await connection("disabled");
    await upsertSocialItem({ connectionId: connected.id, platform: "facebook", externalId: "meta-comment", rootExternalId: "meta-post", text: "sentetik" });
    const metaPage = await commentSources({ platform: "facebook" });
    expect(metaPage.rows[0]?.scan).toMatchObject({ provider: "meta", status: "paused" });
    expect(metaPage.rows[0]?.watch).toBeNull();
    expect(metaPage.rows[0]?.connection_id).toBe(connected.id);
  });

  it("opens source settings for exactly the requested tracking record", async () => {
    const rows = await db.insert(watchedVideos).values(["dQw4w9WgXcQ", "7vk8aYpKBT0"].map(externalId => ({ platform: "youtube", externalId,
      url: `https://www.youtube.com/watch?v=${externalId}`, title: externalId }))).returning();
    const page = await VideosPage({ searchParams: Promise.resolve({ video: rows[0]!.id }) });
    const videos = page.props.children[1].props.children[1].props.videos as Array<{ id: string }>;
    expect(videos.map(video => video.id)).toEqual([rows[0]!.id]);
    expect(page.props.children[1].props.children[1].props.showAddForm).toBe(false);
  });

  it.each([false, true])("blocks cursor cycles, including across worker checkpoints: %s", async (acrossRuns) => {
    const [video] = await db.insert(watchedVideos).values({ platform: "youtube", externalId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", apiKeyEncrypted: encryptSecret("fixture-key"),
      progressEncrypted: encryptSecret(JSON.stringify({ phase: "comments", token: null, nextComments: null, parents: [], text: "Sentetik kaynak", channel: "Sentetik" })) }).returning();
    let requests = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input); const token = Number(url.searchParams.get("pageToken") ?? 0); requests++;
      return Response.json({ items: [{ id: `thread-${token}`, snippet: { totalReplyCount: 0,
        topLevelComment: { id: `comment-${token}`, snippet: { textDisplay: "sentetik", publishedAt: "2026-10-22T00:00:00Z" } } } }],
        nextPageToken: String(token >= (acrossRuns ? 12 : 2) ? 1 : token + 1) });
    }));
    let [result] = await collectWatchedVideos();
    if (acrossRuns) {
      expect(result).toMatchObject({ completed: false });
      const pending = await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, video!.id) });
      expect(JSON.parse(decryptSecret(pending!.progressEncrypted!)).seen).toHaveLength(12);
      await db.update(watchedVideos).set({ availableAt: new Date() }).where(eq(watchedVideos.id, video!.id));
      [result] = await collectWatchedVideos();
    }
    expect(result).toMatchObject({ error: "source_pagination_stalled" });
    expect((await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, video!.id) }))?.status).toBe("blocked");
    expect(requests).toBe(acrossRuns ? 13 : 3);
  });

  it("accepts a repeated reply token under different parents without reporting a cursor cycle", async () => {
    await db.insert(watchedVideos).values({ platform: "youtube", externalId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", apiKeyEncrypted: encryptSecret("fixture-key"),
      progressEncrypted: encryptSecret(JSON.stringify({ phase: "comments", token: null, nextComments: null, parents: [], text: "kaynak", channel: "sentetik" })) });
    const comment = (id: string) => ({ id, snippet: { textDisplay: "sentetik", publishedAt: "2026-10-22T00:00:00Z" } });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input); const parent = url.searchParams.get("parentId");
      if (!parent) return Response.json({ items: ["parent-1", "parent-2"].map(id => ({ id, snippet: { topLevelComment: comment(id), totalReplyCount: 2 } })) });
      return Response.json({ items: [comment(`${parent}-${url.searchParams.get("pageToken") || "first"}`)],
        ...(!url.searchParams.get("pageToken") ? { nextPageToken: "same-token" } : {}) });
    }));
    expect((await collectWatchedVideos())[0]).toMatchObject({ completed: true });
    expect(await db.select().from(socialItems)).toHaveLength(6);
  });

  it("deduplicates parents repeated across comment pages without falsely blocking reply pagination", async () => {
    await db.insert(watchedVideos).values({ platform: "youtube", externalId: "dQw4w9WgXcQ",
      url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", apiKeyEncrypted: encryptSecret("fixture-key"),
      progressEncrypted: encryptSecret(JSON.stringify({ phase: "comments", token: null, nextComments: null, parents: [], text: "kaynak", channel: "sentetik" })) });
    const comment = (id: string) => ({ id, snippet: { textDisplay: "sentetik", publishedAt: "2026-10-22T00:00:00Z" } });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.searchParams.get("parentId")) return Response.json({ items: [comment("reply")] });
      return Response.json({ items: [1, 2].map(() => ({ id: "thread", snippet: { topLevelComment: comment("parent"), totalReplyCount: 1 } })),
        ...(!url.searchParams.get("pageToken") ? { nextPageToken: "next-threads" } : {}) });
    }));
    expect((await collectWatchedVideos())[0]).toMatchObject({ completed: true });
    expect(await db.select().from(socialItems)).toHaveLength(2);
    const page = await VideosPage({ searchParams: Promise.resolve({}) });
    const videos = page.props.children[1].props.children[1].props.videos as Array<{ count: number }>;
    expect(videos[0]?.count).toBe(2);
  });

  it("rejects invalid Runware models before changing stored settings", async () => {
    const response = await saveLlmSettings(request({ provider: "runware", baseUrl: "https://api.runware.ai/v1", model: "1", apiKey: "fixture", revision: 0 }));
    expect(response.status).toBe(400); expect(await response.json()).toEqual({ error: "invalid_model" });
    expect((await db.execute(sql`select count(*)::int as count from llm_settings`))[0]?.count).toBe(0);
  });

  it("adds a channel through the account API with encrypted credentials and an immutable history cutoff", async () => {
    const id = `UC${"a".repeat(22)}`;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ items: [{ id, snippet: { title: "Kanal", thumbnails: { medium: { url: "https://yt3.ggpht.com/profile" } } }, contentDetails: { relatedPlaylists: { uploads: "uploads-fixture" } } }] })));
    expect((await addYouTubeChannel(request({ url: "https://www.youtube.com/@kanal", apiKey: "fixture-key" }))).status).toBe(400);
    expect((await addYouTubeChannel(request({ url: "https://www.youtube.com/@kanal" }))).status).toBe(400);
    expect((await saveYouTubeSettings(request({ apiKey: "fixture-key", revision: 0 }))).status).toBe(200);
    expect((await addYouTubeChannel(request({ url: "https://www.youtube.com/@kanal" }))).status).toBe(201);
    const channel = await db.query.watchedVideos.findFirst();
    expect(channel).toMatchObject({ sourceKind: "channel", externalId: id, status: "active" });
    expect(channel!.analysisAfter).toBeInstanceOf(Date);
    expect(channel!.apiKeyEncrypted).toBeNull();
    expect(channel!.profileImageUrl).toBe("https://yt3.ggpht.com/profile");
    expect(channel!.metadataCheckedAt).toBeInstanceOf(Date);
    expect(decryptSecret((await db.query.youtubeSettings.findFirst())!.apiKeyEncrypted)).toBe("fixture-key");
    expect((await addYouTubeChannel(request({ url: "https://www.youtube.com/@kanal" }))).status).toBe(409);
    expect((await addYouTubeChannel(request({ url: "https://youtube.com.evil.test/@kanal" }))).status).toBe(400);
    expect((await addYouTubeChannel(new Request("http://localhost:3000/api/youtube/channels", { method: "POST", headers: { origin: "https://evil.test" } }))).status).toBe(403);
    await configureVideo(request({ action: "remove", revision: 1 }), params(channel!.id));
    expect((await addYouTubeChannel(request({ url: "https://www.youtube.com/@kanal" }))).status).toBe(201);
    expect((await db.query.watchedVideos.findFirst())!.analysisAfter).toEqual(channel!.analysisAfter);
  });

  it("saves central YouTube credentials with CAS, origin protection and secret-free responses/audits", async () => {
    expect((await saveYouTubeSettings(new Request("http://localhost:3000/api/settings/youtube", { method: "PUT", headers: { origin: "https://evil.test" } }))).status).toBe(403);
    expect((await saveYouTubeSettings(request({ apiKey: "invalid key", revision: 0 }))).status).toBe(400);
    const saved = await saveYouTubeSettings(request({ apiKey: "central-fixture-secret", revision: 0 }));
    expect(await saved.json()).toEqual({ saved: true, revision: 1 });
    const current = await db.query.youtubeSettings.findFirst();
    expect(current!.apiKeyEncrypted).not.toContain("central-fixture-secret");
    expect(decryptSecret(current!.apiKeyEncrypted)).toBe("central-fixture-secret");
    expect((await saveYouTubeSettings(request({ apiKey: "stale", revision: 0 }))).status).toBe(409);
    const results = await Promise.all(["replacement-one", "replacement-two"].map(apiKey => saveYouTubeSettings(request({ apiKey, revision: 1 }))));
    expect(results.map(response => response.status).sort()).toEqual([200, 409]);
    expect((await db.query.youtubeSettings.findFirst())!.revision).toBe(2);
    const audits = await db.select().from(auditLogs).where(eq(auditLogs.action, "youtube.settings_updated"));
    expect(audits.map(row => row.metadata)).toEqual([{ revision: 1 }, { revision: 2 }]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("adds videos using central settings and applies key replacement on the next source read", async () => {
    expect((await addVideo(request({ platform: "youtube", url: "https://youtu.be/dQw4w9WgXcQ", apiKey: "inline" }))).status).toBe(400);
    expect((await addVideo(request({ platform: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" }))).status).toBe(400);
    await saveYouTubeSettings(request({ apiKey: "old-central", revision: 0 }));
    expect((await addVideo(request({ platform: "youtube", url: "https://youtu.be/dQw4w9WgXcQ" }))).status).toBe(201);
    const video = (await db.query.watchedVideos.findFirst())!;
    expect(video.apiKeyEncrypted).toBeNull();
    await db.update(watchedVideos).set({ apiKeyEncrypted: encryptSecret("legacy-key") }).where(eq(watchedVideos.id, video.id));
    await saveYouTubeSettings(request({ apiKey: "new-central", revision: 1 }));
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input); expect(url.searchParams.get("key")).toBe("new-central");
      return Response.json(url.pathname.endsWith("/videos") ? { items: [{ id: video.externalId, snippet: { title: "Video", description: "", channelTitle: "Kanal" } }] } : { items: [] });
    }));
    expect(await collectWatchedVideos()).toMatchObject([{ completed: true }]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect((await db.query.youtubeSettings.findFirst())!.revision).toBe(2);
  });

  it.each([false, true])("caches a daily channel profile refresh and keeps discovery running when optional metadata fails: %s", async failed => {
    const [channel] = await db.insert(watchedVideos).values({ platform: "youtube", sourceKind: "channel", externalId: `UC${"a".repeat(22)}`,
      url: "https://www.youtube.com/@kanal", uploadsPlaylistId: "uploads-fixture", analysisAfter: new Date(), apiKeyEncrypted: encryptSecret("fixture-key"),
      profileImageUrl: "https://yt3.ggpht.com/old", metadataCheckedAt: new Date("2020-01-01") }).returning();
    const fetchMock = vi.fn(async (input: string) => {
      if (new URL(input).pathname.endsWith("/channels")) {
        if (failed) return Response.json({}, { status: 503 });
        return Response.json({ items: [{ id: channel!.externalId, snippet: { title: "Güncel kanal", thumbnails: { medium: { url: "https://yt3.ggpht.com/new" } } } }] });
      }
      return Response.json({ items: [] });
    });
    vi.stubGlobal("fetch", fetchMock);
    expect((await collectWatchedVideos())[0]).toMatchObject({ completed: true });
    const saved = await db.query.watchedVideos.findFirst();
    expect(saved!.profileImageUrl).toBe(`https://yt3.ggpht.com/${failed ? "old" : "new"}`);
    expect(saved!.metadataCheckedAt!.getTime()).toBeGreaterThan(Date.now() - 10000);
    expect(saved!.lastError).toBeNull();
    await db.update(watchedVideos).set({ availableAt: new Date("2020-01-01") }).where(eq(watchedVideos.id, channel!.id));
    expect((await collectWatchedVideos())[0]).toMatchObject({ completed: true });
    expect(fetchMock.mock.calls.filter(([input]) => new URL(input).pathname.endsWith("/channels"))).toHaveLength(1);
  });

  it("does not save optional profile metadata after the channel is paused during refresh", async () => {
    const [channel] = await db.insert(watchedVideos).values({ platform: "youtube", sourceKind: "channel", externalId: `UC${"a".repeat(22)}`,
      url: "https://www.youtube.com/@kanal", uploadsPlaylistId: "uploads-fixture", analysisAfter: new Date(), apiKeyEncrypted: encryptSecret("fixture-key") }).returning();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (new URL(input).pathname.endsWith("/channels")) {
        await configureVideo(request({ action: "pause", revision: 1 }), params(channel!.id));
        return Response.json({ items: [{ id: channel!.externalId, snippet: { title: "Güncel kanal", thumbnails: { medium: { url: "https://yt3.ggpht.com/new" } } } }] });
      }
      return Response.json({ items: [] });
    }));
    await collectWatchedVideos();
    expect(await db.query.watchedVideos.findFirst()).toMatchObject({ status: "paused", profileImageUrl: null, metadataCheckedAt: null });
  });

  it("keeps comment collection moving while multiple channel archives remain due", async () => {
    await saveYouTubeSettings(request({ apiKey: "central-key", revision: 0 }));
    const channels = await db.insert(watchedVideos).values(["a", "b"].map(letter => ({ platform: "youtube", sourceKind: "channel", metadataCheckedAt: new Date(), externalId: `UC${letter.repeat(22)}`,
      url: `https://www.youtube.com/@${letter}`, uploadsPlaylistId: `uploads-${letter}`, analysisAfter: new Date(), availableAt: new Date("2020-01-01") }))).returning();
    const [video] = await db.insert(watchedVideos).values({ platform: "youtube", externalId: "dQw4w9WgXcQ", url: "https://youtu.be/dQw4w9WgXcQ",
      channelId: channels[0]!.id, analysisAfter: channels[0]!.analysisAfter }).returning();
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      return Response.json(url.pathname.endsWith("/playlistItems") ? { items: [], nextPageToken: "more-archive" }
        : url.pathname.endsWith("/videos") ? { items: [{ id: video!.externalId, snippet: { title: "Video", description: "", channelTitle: "Kanal" } }] } : { items: [] });
    }));
    const results = await collectWatchedVideos();
    expect(results).toHaveLength(2);
    expect(results).toContainEqual({ id: video!.id, completed: true });
    expect(results).toContainEqual(expect.objectContaining({ discovered: 0, completed: false }));
  });

  it("discovers every playlist page without overriding existing video pauses or exposing channel rows as posts", async () => {
    const [channel] = await db.insert(watchedVideos).values({ platform: "youtube", sourceKind: "channel", metadataCheckedAt: new Date(), externalId: `UC${"a".repeat(22)}`,
      url: "https://www.youtube.com/@kanal", uploadsPlaylistId: "uploads-fixture", analysisAfter: new Date(), apiKeyEncrypted: encryptSecret("fixture-key") }).returning();
    await db.insert(watchedVideos).values({ platform: "youtube", externalId: "dQw4w9WgXcQ", url: "https://youtu.be/dQw4w9WgXcQ", status: "paused" });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input); expect(url.pathname).toContain("playlistItems");
      return Response.json({ items: [{ snippet: { title: "Video", videoOwnerChannelId: channel!.externalId,
        resourceId: { videoId: url.searchParams.get("pageToken") ? "7vk8aYpKBT0" : "dQw4w9WgXcQ" } } }],
        ...(!url.searchParams.get("pageToken") ? { nextPageToken: "next-page" } : {}) });
    }));
    expect((await collectWatchedVideos())[0]).toMatchObject({ completed: false });
    const pending = await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, channel!.id) });
    expect(decryptSecret(pending!.progressEncrypted!)).toContain("next-page");
    await db.update(watchedVideos).set({ availableAt: new Date() }).where(eq(watchedVideos.id, channel!.id));
    expect((await collectWatchedVideos())[0]).toMatchObject({ completed: true });
    const rows = await db.select().from(watchedVideos);
    expect(rows).toHaveLength(3);
    expect(rows.find(row => row.externalId === "dQw4w9WgXcQ")!.status).toBe("paused");
    expect(rows.find(row => row.externalId === "7vk8aYpKBT0")).toMatchObject({ channelId: channel!.id, analysisAfter: channel!.analysisAfter, pollMinutes: 1440 });
    expect((await commentSources({})).rows.some(row => row.source_id === channel!.externalId)).toBe(false);
    expect((await commentSources({ connection: `youtube:${channel!.id}` })).rows.map(row => row.source_id)).toEqual(["7vk8aYpKBT0"]);
  });

  it("archives historical comments and replies while analyzing only comments created after channel tracking", async () => {
    const cutoff = new Date("2026-10-22T00:00:00Z");
    const [channel] = await db.insert(watchedVideos).values({ platform: "youtube", sourceKind: "channel", metadataCheckedAt: new Date(), externalId: `UC${"a".repeat(22)}`,
      url: "https://www.youtube.com/@kanal", uploadsPlaylistId: "uploads-fixture", analysisAfter: cutoff,
      availableAt: new Date("2100-01-01"), apiKeyEncrypted: encryptSecret("fixture-key") }).returning();
    await db.insert(watchedVideos).values({ platform: "youtube", externalId: "dQw4w9WgXcQ", url: "https://youtu.be/dQw4w9WgXcQ", channelId: channel!.id, analysisAfter: cutoff });
    const comment = (id: string, publishedAt: string) => ({ id, snippet: { textDisplay: "sentetik", publishedAt } });
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.pathname.endsWith("/videos")) return Response.json({ items: [{ id: "dQw4w9WgXcQ", snippet: { title: "Video", description: "Açıklama", channelTitle: "Kanal" } }] });
      if (url.pathname.endsWith("/comments")) return Response.json({ items: [comment("old-reply", cutoff.toISOString()), comment("new-reply", "2026-10-22T00:00:01Z")] });
      return Response.json({ items: [{ id: "old-thread", snippet: { topLevelComment: comment("old", "2026-10-21T23:59:59Z"), totalReplyCount: 2 } },
        { id: "new-thread", snippet: { topLevelComment: comment("new", "2026-10-22T00:00:01Z"), totalReplyCount: 0 } }] });
    }));
    expect((await collectWatchedVideos())[0]).toMatchObject({ completed: true });
    const historical = await commentRows({ view: "history" });
    expect(historical.map(row => row.item.externalId).sort()).toEqual(["old", "old-reply"]);
    expect(historical.every(row => row.item.analysisExcluded && row.item.analysisStatus === "complete" && !row.analysis)).toBe(true);
    const jobs = await claimAnalysisJobs(10);
    const all = await db.select().from(socialItems);
    expect(jobs.map(job => all.find(row => row.id === job.id)!.externalId).sort()).toEqual(["new", "new-reply"]);
    await upsertSocialItem({ platform: "youtube", externalId: "old", text: "düzenlendi" });
    await db.transaction(tx => invalidateAnalyses(tx));
    expect((await db.query.socialItems.findFirst({ where: eq(socialItems.externalId, "old") }))!.analysisStatus).toBe("complete");
    expect((await commentRows({ view: "history" }))).toHaveLength(2);
    expect(mocks.analyze).not.toHaveBeenCalled();
    expect(await db.select().from(alertOutbox)).toHaveLength(0);
    expect(await commentRows({ connection: `youtube:${channel!.id}` })).toHaveLength(4);
  });

  it("does not write discovered videos after a concurrent channel pause and preserves history on removal", async () => {
    const [channel] = await db.insert(watchedVideos).values({ platform: "youtube", sourceKind: "channel", metadataCheckedAt: new Date(), externalId: `UC${"a".repeat(22)}`,
      url: "https://www.youtube.com/@kanal", uploadsPlaylistId: "uploads-fixture", analysisAfter: new Date(), apiKeyEncrypted: encryptSecret("fixture-key") }).returning();
    const entered = deferred<void>(), release = deferred<Response>();
    vi.stubGlobal("fetch", vi.fn(() => { entered.resolve(); return release.promise; }));
    const running = collectWatchedVideos(); await entered.promise;
    expect((await configureVideo(request({ action: "pause", revision: 1 }), params(channel!.id))).status).toBe(200);
    release.resolve(Response.json({ items: [{ snippet: { title: "Video", resourceId: { videoId: "dQw4w9WgXcQ" } } }] }));
    await running;
    expect(await db.select().from(watchedVideos)).toHaveLength(1);
    expect((await db.query.watchedVideos.findFirst())!.status).toBe("paused");
    expect(await collectWatchedVideos()).toHaveLength(0);
    await db.insert(watchedVideos).values({ platform: "youtube", externalId: "dQw4w9WgXcQ", url: "https://youtu.be/dQw4w9WgXcQ", channelId: channel!.id, analysisAfter: channel!.analysisAfter });
    const saved = (await upsertSocialItem({ platform: "youtube", externalId: "saved", rootExternalId: "dQw4w9WgXcQ", text: "geçmiş", analysisExcluded: true })).item!;
    await configureVideo(request({ action: "remove", revision: 2 }), params(channel!.id));
    expect(await db.query.socialItems.findFirst({ where: eq(socialItems.id, saved.id) })).toBeDefined();
    expect(await collectWatchedVideos()).toHaveLength(0);
  });

  it("persists the channel discovery cursor during quota exhaustion and resumes the same page", async () => {
    const [channel] = await db.insert(watchedVideos).values({ platform: "youtube", sourceKind: "channel", metadataCheckedAt: new Date(), externalId: `UC${"a".repeat(22)}`,
      url: "https://www.youtube.com/@kanal", uploadsPlaylistId: "uploads-fixture", analysisAfter: new Date(), apiKeyEncrypted: encryptSecret("fixture-key") }).returning();
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ items: [], nextPageToken: "page-2" }))
      .mockResolvedValueOnce(Response.json({ error: { errors: [{ reason: "quotaExceeded" }] } }, { status: 403 }))
      .mockResolvedValueOnce(Response.json({ items: [] }));
    vi.stubGlobal("fetch", fetchMock);
    await collectWatchedVideos();
    await db.update(watchedVideos).set({ availableAt: new Date() }).where(eq(watchedVideos.id, channel!.id));
    expect((await collectWatchedVideos())[0]).toMatchObject({ error: "youtube_quota_exceeded" });
    const waiting = await db.query.watchedVideos.findFirst();
    expect(waiting).toMatchObject({ status: "active", attempts: 0 });
    expect(decryptSecret(waiting!.progressEncrypted!)).toContain("page-2");
    expect(waiting!.availableAt.getTime()).toBeGreaterThan(Date.now() + 3500000);
    await db.update(watchedVideos).set({ availableAt: new Date() }).where(eq(watchedVideos.id, channel!.id));
    expect((await collectWatchedVideos())[0]).toMatchObject({ completed: true });
    expect(new URL(fetchMock.mock.calls[2]![0]).searchParams.get("pageToken")).toBe("page-2");
  });

  it("blocks repeated channel discovery cursors instead of looping forever", async () => {
    const [channel] = await db.insert(watchedVideos).values({ platform: "youtube", sourceKind: "channel", metadataCheckedAt: new Date(), externalId: `UC${"a".repeat(22)}`,
      url: "https://www.youtube.com/@kanal", uploadsPlaylistId: "uploads-fixture", analysisAfter: new Date(), apiKeyEncrypted: encryptSecret("fixture-key") }).returning();
    const fetchMock = vi.fn(async () => Response.json({ items: [], nextPageToken: "same-page" })); vi.stubGlobal("fetch", fetchMock);
    for (let run = 0; run < 3; run++) {
      await db.update(watchedVideos).set({ availableAt: new Date() }).where(eq(watchedVideos.id, channel!.id));
      await collectWatchedVideos();
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(await db.query.watchedVideos.findFirst()).toMatchObject({ status: "blocked", lastError: "source_pagination_stalled" });
  });

  it("checks recent uploads during a long archive discovery without losing its older-page cursor", async () => {
    const [channel] = await db.insert(watchedVideos).values({ platform: "youtube", sourceKind: "channel", metadataCheckedAt: new Date(), externalId: `UC${"a".repeat(22)}`,
      url: "https://www.youtube.com/@kanal", uploadsPlaylistId: "uploads-fixture", analysisAfter: new Date(), apiKeyEncrypted: encryptSecret("fixture-key"),
      progressEncrypted: encryptSecret(JSON.stringify({ token: "archive-page", seen: [], headCheckedAt: 0 })) }).returning();
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ items: [{ snippet: { title: "Yeni video", resourceId: { videoId: "dQw4w9WgXcQ" } } }], nextPageToken: "head-page-2" }))
      .mockResolvedValueOnce(Response.json({ items: [] })); vi.stubGlobal("fetch", fetchMock);
    expect((await collectWatchedVideos())[0]).toMatchObject({ completed: false });
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.has("pageToken")).toBe(false);
    const saved = await db.query.watchedVideos.findFirst({ where: eq(watchedVideos.id, channel!.id) });
    expect(JSON.parse(decryptSecret(saved!.progressEncrypted!))).toMatchObject({ token: "archive-page", seen: [] });
    await db.update(watchedVideos).set({ status: "paused" }).where(eq(watchedVideos.externalId, "dQw4w9WgXcQ"));
    await db.update(watchedVideos).set({ availableAt: new Date() }).where(eq(watchedVideos.id, channel!.id));
    expect((await collectWatchedVideos())[0]).toMatchObject({ completed: true });
    expect(new URL(fetchMock.mock.calls[1]![0]).searchParams.get("pageToken")).toBe("archive-page");
  });

  it("enforces the historical no-analysis policy at the database boundary", async () => {
    const source = (await upsertSocialItem({ platform: "youtube", externalId: "historical", text: "eski", analysisExcluded: true })).item!;
    await expect(db.update(socialItems).set({ analysisStatus: "pending" }).where(eq(socialItems.id, source.id))).rejects.toThrow();
    expect(await claimAnalysisJobs(10)).toHaveLength(0);
  });

  it("accepts an OAuth nonce once, including parallel replay attempts", async () => {
    const state = await createOAuthState();
    const accepted = await Promise.all([consumeOAuthState(state), consumeOAuthState(state)]);
    expect(accepted.filter(Boolean)).toHaveLength(1);
  });

  it.each(["analysis", "webhook", "alert"] as const)("claims disjoint %s batches and skips a locked job without starving other workers", async (kind) => {
    let ids: string[];
    let table: string;
    let claim: (limit: number) => Promise<Array<{ id: string; lockId: string }>>;
    if (kind === "analysis") {
      ids = (await db.insert(socialItems).values(Array.from({ length: 24 }, (_, i) => ({
        platform: "facebook", externalId: `parallel-${i}`, text: "yorum",
      }))).returning({ id: socialItems.id })).map(row => row.id);
      table = "social_items"; claim = claimAnalysisJobs;
    } else if (kind === "webhook") {
      ids = (await db.insert(webhookEvents).values(Array.from({ length: 24 }, (_, i) => ({
        dedupeKey: `parallel-${i}`, payload: {},
      }))).returning({ id: webhookEvents.id })).map(row => row.id);
      table = "webhook_events"; claim = claimWebhookJobs;
    } else {
      const source = await item();
      ids = (await db.insert(alertOutbox).values(Array.from({ length: 24 }, (_, i) => ({
        itemId: source.id, dedupeKey: `parallel-${i}`, ruleKey: "test", payload: {},
      }))).returning({ id: alertOutbox.id })).map(row => row.id);
      table = "alert_outbox"; claim = claimAlertJobs;
    }
    const entered = deferred<void>(), release = deferred<void>();
    const held = db.transaction(async tx => {
      await tx.execute(sql`select id from ${sql.identifier(table)} where id = ${ids[0]}::uuid for update`);
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    try {
      const batches = await within(Promise.all([claim(8), claim(8), claim(8)]));
      const jobs = batches.flat();
      expect(jobs).toHaveLength(23);
      expect(new Set(jobs.map(job => job.id)).size).toBe(23);
      expect(new Set(jobs.map(job => job.lockId)).size).toBe(23);
      expect(jobs.some(job => job.id === ids[0])).toBe(false);
      expect(batches.every(batch => batch.length > 0)).toBe(true);
    } finally { release.resolve(); await held; }
    expect((await claim(8)).map(job => job.id)).toEqual([ids[0]]);
  });

  it("lets independent comments and siblings ingest while another item transaction is paused", async () => {
    const entered = deferred<void>(), release = deferred<void>();
    const slow = upsertSocialItem({ platform: "facebook", externalId: "slow", parentExternalId: "post", text: "bir" }, async () => {
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    try {
      const rows = await within(Promise.all([
        upsertSocialItem({ platform: "facebook", externalId: "sibling", parentExternalId: "post", text: "iki" }),
        upsertSocialItem({ platform: "facebook", externalId: "independent", parentExternalId: "other-post", text: "üç" }),
      ]));
      expect(rows.every(row => row.created)).toBe(true);
    } finally { release.resolve(); await slow; }
  });

  it("fences a parent edit behind a new child insertion and invalidates the child's revision", async () => {
    await upsertSocialItem({ platform: "facebook", externalId: "parent", text: "önce" });
    const entered = deferred<void>(), release = deferred<void>();
    const child = upsertSocialItem({ platform: "facebook", externalId: "child", parentExternalId: "parent", itemType: "reply", text: "cevap" }, async () => {
      entered.resolve(); await release.promise;
    });
    await entered.promise;
    let parentFinished = false;
    const parent = upsertSocialItem({ platform: "facebook", externalId: "parent", text: "sonra" }).then(row => { parentFinished = true; return row; });
    try {
      await within((async () => {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          const rows = await db.execute(sql`select 1 from pg_locks where locktype = 'advisory' and not granted
            and classid = hashtext('facebook')::oid and objid = hashtext('parent')::oid`);
          if (rows.length) return;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        throw new Error("Parent edit did not wait for the child's shared lock");
      })());
      expect(parentFinished).toBe(false);
    } finally { release.resolve(); await Promise.all([child, parent]); }
    const saved = await db.query.socialItems.findFirst({ where: eq(socialItems.externalId, "child") });
    expect(saved).toMatchObject({ analysisRevision: 2, analysisStatus: "pending" });
  });

  it("persists a provider cooldown across new claims without consuming item retry attempts", async () => {
    const source = await item();
    const cfg = await getLlmSettings();
    const key = analysisProviderKey(cfg);
    const jobs = await claimAnalysisJobs(1, key);
    const fetcher = vi.fn(async () => new Response("private", { status: 429, headers: { "retry-after": "600" } }));
    vi.stubGlobal("fetch", fetcher);
    expect(await processAnalysisJobs(jobs, cfg)).toEqual([{ processed: false, reason: "retry" }]);
    expect(await db.query.socialItems.findFirst({ where: eq(socialItems.id, source.id) })).toMatchObject({ analysisStatus: "retry", analysisAttempts: 0 });
    const [state] = await db.select().from(analysisProviderState).where(eq(analysisProviderState.key, key));
    expect(state!.availableAt.getTime()).toBeGreaterThan(Date.now() + 590000);
    await db.insert(analysisProviderState).values({ key: "f".repeat(64), availableAt: new Date(Date.now() + 900000), lastStatus: 401 });
    const metricsBody = await (await metrics(new Request("http://localhost/api/metrics", { headers: { authorization: `Bearer ${env().CRON_SECRET}` } }))).text();
    expect(Number(metricsBody.match(/sosyal_itibar_analysis_provider_backoff_seconds\{status="429"\} ([\d.]+)/)?.[1])).toBeGreaterThan(590);
    expect(metricsBody).not.toContain('sosyal_itibar_analysis_provider_backoff_seconds{status="401"}');
    await upsertSocialItem({ platform: "facebook", externalId: "new-during-outage", text: "yeni" });
    expect(await claimAnalysisJobs(10, key)).toHaveLength(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await claimAnalysisJobs(10, analysisProviderKey({ ...cfg, LLM_API_KEY: "replacement" }))).toHaveLength(1);
    await db.update(analysisProviderState).set({ availableAt: new Date(0) }).where(eq(analysisProviderState.key, key));
    await db.update(socialItems).set({ analysisAvailableAt: new Date(0) }).where(eq(socialItems.id, source.id));
    expect(await claimAnalysisJobs(1, key)).toHaveLength(1);
  });

  it.each([401, 400])("handles LLM HTTP %s according to provider versus item failure scope", async (status) => {
    const source = await item();
    const cfg = await getLlmSettings();
    vi.stubGlobal("fetch", vi.fn(async () => new Response("private", { status })));
    await processAnalysisJobs(await claimAnalysisJobs(1), cfg);
    const saved = await db.query.socialItems.findFirst({ where: eq(socialItems.id, source.id) });
    expect(saved).toMatchObject(status === 401 ? { analysisStatus: "retry", analysisAttempts: 0 } : { analysisStatus: "dead", analysisAttempts: 1 });
    expect(await db.select().from(analysisProviderState)).toHaveLength(status === 401 ? 1 : 0);
  });

  it("exports blocked sources and overdue collection separately from healthy worker heartbeats", async () => {
    await db.insert(watchedVideos).values([
      { platform: "youtube", externalId: "blocked", url: "https://example.test/blocked", status: "blocked" },
      { platform: "youtube", externalId: "overdue", url: "https://example.test/overdue", availableAt: new Date(Date.now() - 600000), lastSyncedAt: new Date(Date.now() - 3600000) },
    ]);
    const response = await metrics(new Request("http://localhost/api/metrics", { headers: { authorization: `Bearer ${env().CRON_SECRET}` } }));
    const body = await response.text();
    expect(body).toContain('sosyal_itibar_sources{platform="youtube",provider="official",kind="video",status="blocked"} 1');
    expect(Number(body.match(/sosyal_itibar_source_overdue_seconds\{[^\n]+\} ([\d.]+)/)?.[1])).toBeGreaterThan(590);
    expect(Number(body.match(/sosyal_itibar_source_scan_age_seconds\{[^\n]+\} ([\d.]+)/)?.[1])).toBeGreaterThan(3590);
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
