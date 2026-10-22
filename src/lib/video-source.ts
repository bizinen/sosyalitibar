import { z } from "zod";

export const videoScanSettingsSchema = z.object({
  resultsLimit: z.number().int().min(1).max(10000),
  pollMinutes: z.number().int().min(15).max(10080),
  maxChargeCents: z.number().int().min(10).max(10000),
}).strict();

export type VideoPlatform = "youtube" | "facebook" | "instagram";

export function youtubeChannelReference(value: string): { id?: string; forHandle?: string; forUsername?: string } {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash
    || !["youtube.com", "www.youtube.com", "m.youtube.com"].includes(url.hostname)) throw new Error("invalid_channel_url");
  let parts = decodeURIComponent(url.pathname).replace(/\/$/, "").split("/").slice(1);
  if (["videos", "shorts", "streams", "featured"].includes(parts.at(-1) ?? "")) parts = parts.slice(0, -1);
  if (parts.length === 2 && parts[0] === "channel" && /^UC[A-Za-z0-9_-]{22}$/.test(parts[1]!)) return { id: parts[1]! };
  if (parts.length === 1 && /^@[^\s/@?#]{1,100}$/.test(parts[0]!)) return { forHandle: parts[0]! };
  if (parts.length === 2 && parts[0] === "user" && /^[A-Za-z0-9_.-]{1,100}$/.test(parts[1]!)) return { forUsername: parts[1]! };
  throw new Error("invalid_channel_url");
}

export function videoSource(platform: VideoPlatform, value: string, resourceId?: string, publicSource = false) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) throw new Error("invalid_video_url");
  const host = url.hostname.toLowerCase();
  if (platform === "youtube") {
    if (!["youtube.com", "www.youtube.com", "m.youtube.com", "youtu.be"].includes(host)) throw new Error("invalid_video_url");
    const id = host === "youtu.be" ? url.pathname.split("/")[1] : url.pathname === "/watch" ? url.searchParams.get("v")
      : /^\/(shorts|live|embed)\//.test(url.pathname) ? url.pathname.split("/")[2] : null;
    if (!id || !/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error("invalid_video_url");
    return { externalId: id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  const validHost = platform === "instagram" ? ["instagram.com", "www.instagram.com"].includes(host)
    : ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com", "fb.watch"].includes(host);
  if (!validHost || [...url.searchParams.keys()].some((key) => /token|secret|authorization/i.test(key))) throw new Error("invalid_video_url");
  if (platform === "instagram" && !/^\/(p|reel|reels|tv)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)) throw new Error("invalid_video_url");
  const story = url.searchParams.get("story_fbid");
  const page = url.searchParams.get("id");
  const inferredId = platform === "facebook" ? story && page ? `${page}_${story}`
    : url.pathname.match(/\/(?:videos|posts)\/(\d+)/)?.[1] || url.searchParams.get("v") : null;
  if (publicSource) {
    if (platform === "facebook" && !inferredId && !/^\/(?:[^/]+\/)?(?:posts|videos|reel)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
      && !(host === "fb.watch" && /^\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))) throw new Error("invalid_video_url");
    url.hostname = platform === "instagram" ? "www.instagram.com" : host === "fb.watch" ? "fb.watch" : "www.facebook.com";
    if (platform === "instagram") url.pathname = url.pathname.replace(/^\/(reels|tv)\//, "/reel/");
    url.pathname = url.pathname.replace(/\/$/, "");
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) if (!["story_fbid", "id", "v"].includes(key)) url.searchParams.delete(key);
    const publicId = platform === "instagram" ? `public:instagram:${url.pathname.split("/")[2]}`
      : url.pathname.match(/\/posts\/(pfbid[A-Za-z0-9_-]+)/)?.[1];
    return { externalId: inferredId || publicId || `public:${url.hostname}${url.pathname}${url.search}`, url: url.toString() };
  }
  if (resourceId?.trim() && inferredId && resourceId.trim() !== inferredId) throw new Error("source_identity_mismatch");
  const id = resourceId?.trim() || inferredId;
  if (!id || !(platform === "facebook" ? /^\d+(?:_\d+)?$/ : /^\d+$/).test(id)) throw new Error("meta_resource_id_required");
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) if (!["story_fbid", "id", "v"].includes(key)) url.searchParams.delete(key);
  return { externalId: id, url: url.toString() };
}
