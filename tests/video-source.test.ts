import { expect, it } from "vitest";
import { videoSource } from "@/lib/video-source";

it.each([
  "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=13",
  "https://youtu.be/dQw4w9WgXcQ?si=tracking",
  "https://www.youtube.com/shorts/dQw4w9WgXcQ",
  "https://www.youtube.com/live/dQw4w9WgXcQ",
])("deduplicates different links to the same YouTube video: %s", (url) => {
  expect(videoSource("youtube", url)).toEqual({ externalId: "dQw4w9WgXcQ", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" });
});

it.each(["https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ", "https://www.youtube.com@evil.test/watch?v=dQw4w9WgXcQ",
  "http://www.youtube.com/watch?v=dQw4w9WgXcQ", "https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ",
  "https://www.youtube.com/playlist?list=dQw4w9WgXcQ", "https://www.instagram.com/reel/dQw4w9WgXcQ/",
])("rejects an unsafe or non-video YouTube link: %s", (url) => {
  expect(() => videoSource("youtube", url)).toThrow("invalid_video_url");
});

it("does not invent an Instagram media ID from a public shortcode", () => {
  expect(() => videoSource("instagram", "https://www.instagram.com/reel/AbCdEF/")).toThrow("meta_resource_id_required");
  expect(videoSource("instagram", "https://www.instagram.com/reel/AbCdEF/?igsh=tracking", "1234567890"))
    .toEqual({ externalId: "1234567890", url: "https://www.instagram.com/reel/AbCdEF/" });
});

it("keeps the page and post identity for Facebook story links", () => {
  expect(videoSource("facebook", "https://www.facebook.com/story.php?story_fbid=123&id=456&tracking=ignored"))
    .toEqual({ externalId: "456_123", url: "https://www.facebook.com/story.php?story_fbid=123&id=456" });
});

it("rejects a Facebook identity that contradicts the linked video", () => {
  expect(() => videoSource("facebook", "https://www.facebook.com/channel/videos/123/", "456"))
    .toThrow("source_identity_mismatch");
});

it("accepts public Instagram URLs without inventing a numeric Meta identity", () => {
  const source = videoSource("instagram", "https://instagram.com/reels/AbCd/?igsh=tracking", undefined, true);
  expect(source.url).toBe("https://www.instagram.com/reel/AbCd");
  expect(source.externalId).toBe("public:instagram:AbCd");
  expect(videoSource("instagram", "https://www.instagram.com/reel/AbCd/", undefined, true)).toEqual(source);
  expect(videoSource("instagram", "https://www.instagram.com/p/AbCd/", undefined, true).externalId).toBe(source.externalId);
});

it("accepts Facebook pfbid posts but rejects arbitrary profile URLs", () => {
  expect(videoSource("facebook", "https://m.facebook.com/channel/posts/pfbidAbCd/?tracking=1", undefined, true).url)
    .toBe("https://www.facebook.com/channel/posts/pfbidAbCd");
  expect(() => videoSource("facebook", "https://www.facebook.com/channel/", undefined, true)).toThrow("invalid_video_url");
});
