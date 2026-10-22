import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
import { ConnectionActions } from "@/app/components/ConnectionActions";
import { AccountsWorkspace } from "@/app/components/AccountsWorkspace";
import { YouTubeChannels } from "@/app/components/YouTubeChannels";

it("opens account creation only on request and keeps credential fields out of the accounts page", () => {
  const html = renderToStaticMarkup(createElement(AccountsWorkspace, { accounts: [], channels: [], targets: [], metaConnectUrl: null, hasYouTubeKey: true, checkedAt: 0 }));
  expect(html).toContain('aria-haspopup="dialog"');
  expect(html.match(/<dialog[^>]*>/)?.[0]).not.toMatch(/\sopen(?:\s|=|>)/);
  expect(html).toContain("İlk hesabını bağla.");
  expect(html).not.toContain('type="password"');
  expect(html).not.toContain('name="youtubeChannelUrl"');
});

it("uses the configured public OAuth address for revoked connections rather than offering a status resume", () => {
  const html = renderToStaticMarkup(createElement(ConnectionActions, { id: "fixture", status: "revoked", displayName: "Hesap", reconnectUrl: "https://panel.example.test/api/meta/connect" }));
  expect(html).toContain('href="https://panel.example.test/api/meta/connect"');
  expect(html).toContain("Yeniden bağla");
  expect(html).not.toContain("Takibe devam et");
});

it("directs reconnection to provider settings when Meta setup is missing", () => {
  const html = renderToStaticMarkup(createElement(ConnectionActions, { id: "fixture", status: "revoked", displayName: "Hesap", reconnectUrl: null }));
  expect(html).toContain('href="/settings/integrations#meta"');
  expect(html).not.toContain('href="/api/meta/connect"');
});

it("keeps channel creation out of the list and does not claim a blocked channel is following automatically", () => {
  const html = renderToStaticMarkup(createElement(YouTubeChannels, { mode: "list", hasKey: true, channels: [{ id: "fixture", title: "Kanal", url: "https://youtube.com/@kanal", status: "blocked", revision: 1, count: 2, analysisAfter: null, lastSyncedAt: null, continuing: false, lastError: "youtube_http_403" }] }));
  expect(html).toContain("Kanal takibi durmuş.");
  expect(html).toContain("Yeniden dene");
  expect(html).not.toContain('name="youtubeChannelUrl"');
  expect(html).not.toContain("otomatik takip edilir");
});
