import { z } from "zod";
import { env } from "@/lib/config";
import { log } from "@/lib/log";

const retryableStatuses = new Set([429, 500, 502, 503, 504]);

function graphBase(): string {
  return `https://graph.facebook.com/${env().META_GRAPH_VERSION}`;
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
    return new MetaApiError(body.error?.message || `Meta API HTTP ${res.status}`, res.status, body.error?.code, body.error?.error_subcode, body.error?.is_transient);
  } catch {
    return new MetaApiError(`Meta API HTTP ${res.status}: ${text.slice(0, 500)}`, res.status);
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
      const res = await fetch(url, { ...init, signal: controller.signal, cache: "no-store" });
      if (res.ok) return res;
      const apiError = await parseMetaError(res);
      lastError = apiError;
      if (attempt >= retries || (!retryableStatuses.has(res.status) && !apiError.transient)) throw apiError;
      const retryAfter = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter * 1000, 10_000) : 500 * 2 ** attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= retries || (error instanceof MetaApiError && !retryableStatuses.has(error.status) && !error.transient)) throw error;
      await sleep(500 * 2 ** attempt);
    } finally {
      clearTimeout(timeout);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Meta API isteği başarısız");
}

export function metaAuthorizeUrl(state: string): string {
  const cfg = env();
  const q = new URLSearchParams({
    client_id: cfg.META_APP_ID,
    redirect_uri: cfg.META_REDIRECT_URI,
    state,
    scope: cfg.META_SCOPES,
    response_type: "code",
    auth_type: "rerequest",
  });
  return `https://www.facebook.com/${cfg.META_GRAPH_VERSION}/dialog/oauth?${q}`;
}

export async function exchangeCode(code: string): Promise<{ accessToken: string; expiresIn?: number }> {
  const cfg = env();
  const q = new URLSearchParams({ client_id: cfg.META_APP_ID, client_secret: cfg.META_APP_SECRET, redirect_uri: cfg.META_REDIRECT_URI, code });
  const res = await metaFetch(`${graphBase()}/oauth/access_token?${q}`, {}, 1);
  const data = z.object({ access_token: z.string(), expires_in: z.number().optional() }).parse(await res.json());
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

/** Facebook Login: exchange short-lived user token for a long-lived token when available. */
export async function exchangeLongLivedUserToken(shortToken: string): Promise<{ accessToken: string; expiresIn?: number }> {
  const cfg = env();
  const q = new URLSearchParams({
    grant_type: "fb_exchange_token",
    client_id: cfg.META_APP_ID,
    client_secret: cfg.META_APP_SECRET,
    fb_exchange_token: shortToken,
  });
  const res = await metaFetch(`${graphBase()}/oauth/access_token?${q}`, {}, 1);
  const data = z.object({ access_token: z.string(), expires_in: z.number().optional() }).parse(await res.json());
  return { accessToken: data.access_token, expiresIn: data.expires_in };
}

export type GraphPaging = { next?: string; cursors?: { before?: string; after?: string } };
export type GraphList<T> = { data: T[]; paging?: GraphPaging };

export async function graphGet<T>(path: string, accessToken: string, params: Record<string, string> = {}): Promise<T> {
  const cleanPath = path.replace(/^\//, "");
  const q = new URLSearchParams({ ...params, access_token: accessToken });
  const res = await metaFetch(`${graphBase()}/${cleanPath}?${q}`);
  return (await res.json()) as T;
}

export async function graphPost<T>(path: string, accessToken: string, form: Record<string, string> = {}): Promise<T> {
  const cleanPath = path.replace(/^\//, "");
  const body = new URLSearchParams({ ...form, access_token: accessToken });
  const res = await metaFetch(`${graphBase()}/${cleanPath}`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return (await res.json()) as T;
}

/** Follows paging.next exactly as returned by Meta. Access token is already embedded in that URL. */
export async function graphGetAbsolute<T>(url: string): Promise<T> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || !["graph.facebook.com", "graph.instagram.com"].includes(parsed.hostname)) {
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
  scopes: string[];
};

export async function debugToken(token: string): Promise<TokenDebug> {
  const cfg = env();
  const appAccessToken = `${cfg.META_APP_ID}|${cfg.META_APP_SECRET}`;
  const q = new URLSearchParams({ input_token: token, access_token: appAccessToken });
  const res = await metaFetch(`${graphBase()}/debug_token?${q}`, {}, 1);
  const parsed = z.object({
    data: z.object({
      is_valid: z.boolean(),
      app_id: z.string().optional(),
      user_id: z.string().optional(),
      expires_at: z.number().optional(),
      scopes: z.array(z.string()).optional(),
    }),
  }).parse(await res.json());
  return {
    isValid: parsed.data.is_valid,
    appId: parsed.data.app_id,
    userId: parsed.data.user_id,
    expiresAt: parsed.data.expires_at && parsed.data.expires_at > 0 ? new Date(parsed.data.expires_at * 1000) : null,
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
  while (next && pages.length < 1000) {
    response = schema.parse(await graphGetAbsolute(next));
    pages.push(...response.data);
    next = response.paging?.next;
  }
  return pages;
}

export async function subscribeFacebookPage(pageId: string, pageToken: string): Promise<boolean> {
  try {
    const data = z.object({ success: z.union([z.boolean(), z.string()]).optional() }).parse(
      await graphPost(`${pageId}/subscribed_apps`, pageToken, { subscribed_fields: "feed" }),
    );
    return data.success === true || data.success === "true";
  } catch (error) {
    log.warn("meta.page.subscribe_failed", { pageId, message: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export async function getFacebookPosts(pageId: string, token: string, limit = 50): Promise<GraphList<{ id: string; message?: string; permalink_url?: string; created_time?: string }>> {
  return graphGet(`${pageId}/feed`, token, { fields: "id,message,permalink_url,created_time", limit: String(limit) });
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
  }>(commentId, token, { fields: "id,message,from,created_time,permalink_url,parent{id}" });
}

export async function getInstagramMedia(igId: string, token: string, limit = 50): Promise<GraphList<{ id: string; caption?: string; permalink?: string; timestamp?: string }>> {
  return graphGet(`${igId}/media`, token, { fields: "id,caption,permalink,timestamp", limit: String(limit) });
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
  }>(commentId, token, { fields: "id,text,username,timestamp,like_count,media{id,permalink},parent_id" });
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
