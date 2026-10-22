import { z } from "zod";
import { getMetaSettings } from "@/lib/meta-settings";
import { log, safeErrorMessage } from "@/lib/log";
import { readResponseBody } from "@/lib/http-body";

const retryableStatuses = new Set([429, 500, 502, 503, 504]);

async function graphBase(): Promise<string> {
  return `https://graph.facebook.com/${(await getMetaSettings()).META_GRAPH_VERSION}`;
}

export class MetaApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: number,
    public readonly subcode?: number,
    public readonly transient?: boolean,
  ) {
    super(message);
    this.name = "MetaApiError";
  }
}

async function parseMetaError(res: Response): Promise<MetaApiError> {
  const text = await res.text();
  try {
    const body = JSON.parse(text) as { error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean } };
    const code = typeof body.error?.code === "number" && Number.isFinite(body.error.code) ? body.error.code : undefined;
    const subcode = typeof body.error?.error_subcode === "number" && Number.isFinite(body.error.error_subcode) ? body.error.error_subcode : undefined;
    return new MetaApiError(`Meta API HTTP ${res.status}; code=${code ?? "unknown"}; subcode=${subcode ?? "none"}`, res.status, code, subcode, body.error?.is_transient === true);
  } catch {
    return new MetaApiError(`Meta API HTTP ${res.status}: invalid error response`, res.status);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


async function metaFetch(url: string, init: RequestInit = {}, retries = 2): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20_000);
    try {
      const response = await fetch(url, { ...init, signal: controller.signal, cache: "no-store", redirect: "error" });
      const body = await readResponseBody(response, 4 * 1024 * 1024);
      const res = new Response([204, 205, 304].includes(response.status) ? null : body, { status: response.status, headers: response.headers });
      if (res.ok) return res;
      const apiError = await parseMetaError(res);
      lastError = apiError;
      if (attempt >= retries || (!retryableStatuses.has(res.status) && !apiError.transient)) throw apiError;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 500 * 2 ** attempt);
    } catch (error) {
      lastError = error instanceof MetaApiError ? error : new Error("Meta API ağ isteği başarısız");
      if (attempt >= retries || (error instanceof MetaApiError && !retryableStatuses.has(error.status) && !error.transient)) throw lastError;
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Meta API isteği başarısız");
}

export async function metaAuthorizeUrl(state: string): Promise<string> {
  const cfg = await getMetaSettings();
  const q = new URLSearchParams({
    client_id: cfg.META_APP_ID,
    redirect_uri: cfg.META_REDIRECT_URI,
    state,
    response_type: "code",
    auth_type: "rerequest",
  });
  if (cfg.metaLoginConfigId) q.set("config_id", cfg.metaLoginConfigId);
  else q.set("scope", cfg.META_SCOPES);
  return `https://www.facebook.com/${cfg.META_GRAPH_VERSION}/dialog/oauth?${q}`;
}

export async function exchangeCode(code: string): Promise<{ accessToken: string; expiresIn?: number }> {
  const cfg = await getMetaSettings();
  const q = new URLSearchParams({ client_id: cfg.META_APP_ID, client_secret: cfg.META_APP_SECRET, redirect_uri: cfg.META_REDIRECT_URI, code });
  const res = await metaFetch(`${await graphBase()}/oauth/access_token?${q}`, {}, 1);
  const data = z.object({ access_token: z.string(), expires_in: z.number().optional() }).parse(await res.json());
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/** Facebook Login: exchange short-lived user token for a long-lived token when available. */
export async function exchangeLongLivedUserToken(shortToken: string): Promise<{ accessToken: string; expiresIn?: number }> {
  const cfg = await getMetaSettings();
  const q = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: cfg.META_APP_ID,
    client_secret: cfg.META_APP_SECRET,
    fb_exchange_token: shortToken,
  });
  const res = await metaFetch(`${await graphBase()}/oauth/access_token?${q}`, {}, 1);
  const data = z.object({ access_token: z.string(), expires_in: z.number().optional() }).parse(await res.json());
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export type GraphPaging = { next?: string; cursors?: { before?: string; after?: string } };
export type GraphList<T> = { data: T[]; paging?: GraphPaging | null };

export async function graphGet<T>(path: string, accessToken: string, params: Record<string, string> = {}): Promise<T> {
  const cleanPath = path.replace(/^\//, "");
  const q = new URLSearchParams({ ...params, access_token: accessToken });
  const res = await metaFetch(`${await graphBase()}/${cleanPath}?${q}`);
  return (await res.json()) as T;
}

export async function graphPost<T>(path: string, accessToken: string, form: Record<string, string> = {}): Promise<T> {
  const cleanPath = path.replace(/^\//, "");
  const body = new URLSearchParams({ ...form, access_token: accessToken });
  const res = await metaFetch(`${await graphBase()}/${cleanPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return (await res.json()) as T;
}

/** Follows paging.next exactly as returned by Meta. Access token is already embedded in that URL. */
export async function graphGetAbsolute<T>(url: string): Promise<T> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || (parsed.port && parsed.port !== "443") || !["graph.facebook.com", "graph.instagram.com"].includes(parsed.hostname)) {
    throw new Error("Meta pagination URL host doğrulaması başarısız");
  }
  const res = await metaFetch(parsed.toString());
  return (await res.json()) as T;
}

export async function getMetaUser(userToken: string): Promise<{ id: string; name?: string }> {
  return z.object({ id: z.string(), name: z.string().optional() }).parse(await graphGet("me", userToken, { fields: "id,name" }));
}

export async function getGrantedScopes(userToken: string): Promise<string[]> {
  const schema = z.object({ data: z.array(z.object({ permission: z.string(), status: z.string() })) });
  const data = schema.parse(await graphGet("me/permissions", userToken));
  return data.data.filter((x) => x.status === "granted").map((x) => x.permission).sort();
}

export type TokenDebug = {
  isValid: boolean;
  appId?: string;
  userId?: string;
  expiresAt?: Date | null;
  dataAccessExpiresAt?: Date | null;
  scopes: string[];
};

export async function debugToken(token: string): Promise<TokenDebug> {
  const cfg = await getMetaSettings();
  const appAccessToken = `${cfg.META_APP_ID}|${cfg.META_APP_SECRET}`;
  const q = new URLSearchParams({ input_token: token, access_token: appAccessToken });
  const res = await metaFetch(`${await graphBase()}/debug_token?${q}`, {}, 1);
  const parsed = z.object({
    data: z.object({
      is_valid: z.boolean(),
      app_id: z.string().optional(),
      user_id: z.string().optional(),
      expires_at: z.number().optional(),
      data_access_expires_at: z.number().int().nonnegative().optional(),
      scopes: z.array(z.string()).optional(),
    }),
  }).parse(await res.json());
  return {
    isValid: parsed.data.is_valid,
    appId: parsed.data.app_id,
    userId: parsed.data.user_id,
    expiresAt: parsed.data.expires_at === undefined ? undefined : parsed.data.expires_at > 0 ? new Date(parsed.data.expires_at * 1000) : null,
    dataAccessExpiresAt: parsed.data.data_access_expires_at ? new Date(parsed.data.data_access_expires_at * 1000) : null,
    scopes: parsed.data.scopes || [],
  };
}

export type ManagedPage = {
  id: string;
  name: string;
  access_token: string;
  tasks?: string[];
  instagram_business_account?: { id: string; username?: string };
};

export async function getManagedPages(userToken: string): Promise<ManagedPage[]> {
  const schema = z.object({
    data: z.array(z.object({
      id: z.string(),
      name: z.string(),
      access_token: z.string(),
      tasks: z.array(z.string()).optional(),
      instagram_business_account: z.object({ id: z.string(), username: z.string().optional() }).optional(),
    })),
    paging: z.object({ next: z.string().optional() }).optional(),
  });

  const pages: ManagedPage[] = [];
  let response = schema.parse(await graphGet("me/accounts", userToken, {
    fields: "id,name,access_token,tasks,instagram_business_account{id,username}",
    limit: "100",
  }));
  pages.push(...response.data);
  let next = response.paging?.next;
  const seenPages = new Set<string>();
  while (next && pages.length < 1000) {
    if (seenPages.has(next) || seenPages.size >= 1000) throw new Error("Meta account pagination did not advance");
    seenPages.add(next);
    response = schema.parse(await graphGetAbsolute(next));
    pages.push(...response.data);
    next = response.paging?.next;
  }
  if (next) throw new Error("Meta account discovery limit reached; result incomplete");
  return pages;
}

export async function subscribeFacebookPage(pageId: string, pageToken: string): Promise<boolean> {
  try {
    const data = z.object({ success: z.union([z.boolean(), z.string()]).optional() }).parse(
      await graphPost(`${pageId}/subscribed_apps`, pageToken, { subscribed_fields: "feed" }),
    );
    return data.success === true || data.success === "true";
  } catch (error) {
    log.warn("meta.page.subscribe_failed", { pageId, message: safeErrorMessage(error) });
    return false;
  }
}

export async function getFacebookPosts(pageId: string, token: string, limit = 50): Promise<GraphList<{ id: string; message?: string; permalink_url?: string; created_time?: string }>> {
  return graphGet(`${pageId}/feed`, token, { fields: "id,message,permalink_url,created_time", limit: String(limit) });
}

export async function getFacebookPost(postId: string, token: string) {
  return z.object({ id: z.string().min(1), message: z.string().optional(), permalink_url: z.string().optional() })
    .parse(await graphGet(postId, token, { fields: "id,message,permalink_url" }));
}

export async function getFacebookComments(postId: string, token: string, limit = 100): Promise<GraphList<{
  id: string;
  message?: string;
  from?: { id?: string; name?: string };
  created_time?: string;
  permalink_url?: string;
  parent?: { id?: string };
}>> {
  return graphGet(`${postId}/comments`, token, { fields: "id,message,from,created_time,permalink_url,parent{id}", filter: "stream", limit: String(limit) });
}

export async function getFacebookComment(commentId: string, token: string) {
  return graphGet<{
    id: string;
    message?: string;
    from?: { id?: string; name?: string };
    created_time?: string;
    permalink_url?: string;
    parent?: { id?: string };
  }>(commentId, token, { fields: "id,message,from,created_time,permalink_url,parent{id}" }).then((data) => z.object({
    id: z.string().trim().min(1),
    message: z.string().optional(),
    from: z.object({ id: z.string().optional(), name: z.string().optional() }).optional(),
    created_time: z.string().optional(),
    permalink_url: z.string().optional(),
    parent: z.object({ id: z.string().trim().min(1).optional() }).optional(),
  }).passthrough().parse(data));
}

export async function getInstagramMedia(igId: string, token: string, limit = 50): Promise<GraphList<{ id: string; caption?: string; permalink?: string; timestamp?: string }>> {
  return graphGet(`${igId}/media`, token, { fields: "id,caption,permalink,timestamp", limit: String(limit) });
}

export async function getInstagramMediaItem(mediaId: string, token: string) {
  return z.object({ id: z.string().min(1), caption: z.string().optional(), permalink: z.string().optional() })
    .parse(await graphGet(mediaId, token, { fields: "id,caption,permalink" }));
}

export async function getInstagramComments(mediaId: string, token: string, limit = 100): Promise<GraphList<{
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
  like_count?: number;
  replies?: GraphList<{ id: string; text?: string; username?: string; timestamp?: string }>;
}>> {
  return graphGet(`${mediaId}/comments`, token, { fields: "id,text,username,timestamp,like_count,replies.limit(100){id,text,username,timestamp}", limit: String(limit) });
}

export async function getInstagramComment(commentId: string, token: string) {
  return graphGet<{
    id: string;
    text?: string;
    username?: string;
    timestamp?: string;
    like_count?: number;
    media?: { id?: string; permalink?: string };
    parent_id?: string;
  }>(commentId, token, { fields: "id,text,username,timestamp,like_count,media{id,permalink},parent_id" }).then((data) => z.object({
    id: z.string().trim().min(1),
    text: z.string().optional(),
    username: z.string().optional(),
    timestamp: z.string().optional(),
    like_count: z.number().int().nonnegative().optional(),
    media: z.object({ id: z.string().trim().min(1).optional(), permalink: z.string().optional() }).optional(),
    parent_id: z.string().trim().min(1).optional(),
  }).passthrough().parse(data));
}

export async function getInstagramReplies(commentId: string, token: string, limit = 100): Promise<GraphList<{
  id: string;
  text?: string;
  username?: string;
  timestamp?: string;
}>> {
  return graphGet(`${commentId}/replies`, token, { fields: "id,text,username,timestamp", limit: String(limit) });
}

export async function getFacebookReplies(commentId: string, token: string, limit = 100): Promise<GraphList<{
  id: string;
  message?: string;
  from?: { id?: string; name?: string };
  created_time?: string;
  permalink_url?: string;
  parent?: { id?: string };
}>> {
  return graphGet(`${commentId}/comments`, token, { fields: "id,message,from,created_time,permalink_url,parent{id}", filter: "stream", limit: String(limit) });
}
