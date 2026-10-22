import { expect, it, vi } from "vitest";

vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/ingest", () => ({ beginSourceRead: vi.fn(), upsertSocialItem: vi.fn() }));

import { normalizeApifyComments } from "@/lib/apify-videos";

it("keeps Instagram reply ancestry when the reply also appears as a flat dataset row", () => {
  const reply = { id: "200", text: "Bir yanıt", timestamp: "2026-10-04T10:00:00Z" };
  const records = normalizeApifyComments("instagram", [{ id: "100", text: "Yorum", replies: [reply] }, reply], "https://www.instagram.com/reel/AbCd/");
  expect(records).toHaveLength(2);
  expect(records.find((record) => record.id === "200")).toMatchObject({ parentId: "100", reply: true });
});

it("uses published Instagram direct comment and parent comment links", () => {
  const [record] = normalizeApifyComments("instagram", [{ id: "200", text: "Yanıt", postUrl: "https://www.instagram.com/p/AbCd/",
    commentUrl: "https://www.instagram.com/p/AbCd/c/200/", parentCommentUrl: "https://www.instagram.com/p/AbCd/c/100/" }], "https://www.instagram.com/p/AbCd/");
  expect(record).toMatchObject({ parentId: "100", reply: true, permalink: "https://www.instagram.com/p/AbCd/c/200/" });
});

it("maps Facebook replies to Graph comment identities instead of base64 IDs", () => {
  const [record] = normalizeApifyComments("facebook", [{ id: "opaque-base64", facebookId: "123", commentId: "200", text: "Yanıt",
    replyToCommentId: "100", threadingDepth: 1, commentUrl: "https://www.facebook.com/channel/videos/123/?comment_id=100&reply_comment_id=200" }],
  "https://www.facebook.com/channel/videos/123/");
  expect(record).toMatchObject({ id: "123_200", parentId: "123_100", reply: true });
});

it("rejects provider error objects and records from a different source", () => {
  expect(() => normalizeApifyComments("instagram", [{ error: "private post" }], "https://www.instagram.com/p/AbCd/"))
    .toThrow("apify_invalid_result");
  expect(() => normalizeApifyComments("instagram", [{ id: "100", text: "Yorum", postUrl: "https://www.instagram.com/p/Other/" }],
    "https://www.instagram.com/p/AbCd/")).toThrow("source_identity_mismatch");
});

it("rejects unsafe links and comments that refer to themselves as their parent", () => {
  expect(() => normalizeApifyComments("facebook", [{ facebookId: "123", commentId: "200", text: "Yorum", commentUrl: "https://evil.test/comment/200" }],
    "https://www.facebook.com/channel/videos/123/")).toThrow("apify_invalid_result");
  expect(() => normalizeApifyComments("instagram", [{ id: "100", text: "Yorum", parentCommentUrl: "https://www.instagram.com/p/AbCd/c/100/" }],
    "https://www.instagram.com/p/AbCd/")).toThrow("apify_invalid_result");
});
