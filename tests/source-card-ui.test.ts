import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { SourceCardActions } from "@/app/components/SourceCardActions";
import { CommentSource } from "@/app/components/CommentSource";

const settingsHref = "/settings/videos?video=00000000-0000-4000-8000-000000000001#video-00000000-0000-4000-8000-000000000001";
const props = { title: "Örnek paylaşım", commentsHref: "/?mode=comments&source=fixture", permalink: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", settingsHref,
  sourceKey: "fixture", commentsCount: 462,
  watch: { id: "00000000-0000-4000-8000-000000000001", revision: 3, status: "active", provider: "official", channelPaused: false, running: false, continuing: false } };

it("keeps the three main actions in the footer and tracking controls in a closed labelled menu", () => {
  const html = renderToStaticMarkup(createElement(SourceCardActions, props));
  expect(html).toContain("Yorumları incele");
  expect(html).toContain("Paylaşımı aç");
  expect(html).toContain("Ayarlar");
  expect(html).toContain(`href="${settingsHref}"`);
  expect(html).toContain('aria-label="Örnek paylaşım: diğer işlemler"');
  expect(html.match(/<details[^>]*>/)?.[0]).not.toMatch(/\sopen(?:\s|=|>)/);
  expect(html).toContain("Yorum alımını duraklat");
  expect(html).toContain("Takipten çıkar…");
  expect(html).toContain("Yorumlarıyla birlikte sil…");
  expect(html).not.toContain("Evet, takibi kaldır");
});

it("does not offer removal or pause for a source without its own tracking record", () => {
  const html = renderToStaticMarkup(createElement(SourceCardActions, { ...props, watch: null, permalink: null, settingsHref: "/settings/meta" }));
  expect(html).toContain('aria-disabled="true"');
  expect(html).toContain("Takip ayarlarını yönet");
  expect(html).not.toContain("Takipten çıkar");
  expect(html).not.toContain("duraklat");
  expect(html).toContain("Yorumlarıyla birlikte sil…");
});

it("allows deleting retained history after unfollowing without offering a resume shortcut", () => {
  const html = renderToStaticMarkup(createElement(SourceCardActions, { ...props, watch: { ...props.watch, status: "removed" } }));
  expect(html).toContain("Yorumlarıyla birlikte sil…");
  expect(html).toContain("Paylaşımı yeniden ekle");
  expect(html).not.toContain("Takipten çıkar…");
  expect(html).not.toContain("Yorum alımına devam et");
});

it("routes a stopped paid scraper to its settings instead of offering a new run in the card", () => {
  const html = renderToStaticMarkup(createElement(SourceCardActions, { ...props, watch: { ...props.watch, provider: "apify", status: "blocked", continuing: true } }));
  expect(html).toContain("Taramayı ayarlardan yönet");
  expect(html).not.toContain("Yorumları şimdi kontrol et");
  expect(html).not.toContain("Taramayı yeniden dene");
});

it("moves the source link out of library previews while preserving it in the full comment view", () => {
  const input = { raw: { source_post: { text: "Video başlığı", permalink: props.permalink } }, platform: "youtube", rootId: "dQw4w9WgXcQ" };
  expect(renderToStaticMarkup(createElement(CommentSource, { ...input, showPermalink: false }))).not.toContain("Paylaşımı aç");
  expect(renderToStaticMarkup(createElement(CommentSource, input))).toContain("Paylaşımı aç");
});
