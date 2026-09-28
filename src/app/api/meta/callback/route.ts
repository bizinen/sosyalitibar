import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { metaAuthAccounts, socialConnections } from "@/db/schema";
import { encryptSecret } from "@/lib/crypto";
import {
  debugToken,
  exchangeCode,
  exchangeLongLivedUserToken,
  getGrantedScopes,
  getManagedPages,
  getMetaUser,
  subscribeFacebookPage,
} from "@/lib/meta";
import { consumeOAuthState } from "@/lib/oauth-state";
import { isAdmin } from "@/lib/auth";
import { audit } from "@/lib/audit";
import { log } from "@/lib/log";
import { appOrigin } from "@/lib/config";

export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");
  if (denied) {
    await audit({ request: req, actor: "admin", action: "meta.oauth.denied", metadata: { error: denied } });
    return NextResponse.redirect(new URL("/?meta_error=oauth_denied", appOrigin()));
  }
  if (!code || !state || !(await consumeOAuthState(state))) {
    await audit({ request: req, actor: "admin", action: "meta.oauth.invalid_callback" });
    return NextResponse.json({ error: "invalid_oauth_callback" }, { status: 400 });
  }

  try {
    const short = await exchangeCode(code);
    let userToken = short.accessToken;
    let expiresIn = short.expiresIn;
    try {
      const long = await exchangeLongLivedUserToken(short.accessToken);
      userToken = long.accessToken;
      expiresIn = long.expiresIn ?? expiresIn;
    } catch (error) {
      log.warn("meta.oauth.long_lived_exchange_failed", { message: error instanceof Error ? error.message : String(error) });
    }

    const [user, scopes, userDebug, pages] = await Promise.all([
      getMetaUser(userToken),
      getGrantedScopes(userToken),
      debugToken(userToken),
      getManagedPages(userToken),
    ]);
    const tokenExpiresAt = userDebug.expiresAt ?? (expiresIn ? new Date(Date.now() + expiresIn * 1000) : null);

    const [authAccount] = await db.insert(metaAuthAccounts).values({
      metaUserId: user.id,
      metaUserName: user.name ?? null,
      encryptedUserAccessToken: encryptSecret(userToken),
      grantedScopes: scopes,
      tokenExpiresAt,
      tokenLastCheckedAt: new Date(),
      status: userDebug.isValid ? "active" : "degraded",
      lastError: userDebug.isValid ? null : "Meta token debug is_valid=false",
    }).onConflictDoUpdate({
      target: metaAuthAccounts.metaUserId,
      set: {
        metaUserName: user.name ?? null,
        encryptedUserAccessToken: encryptSecret(userToken),
        grantedScopes: scopes,
        tokenExpiresAt,
        tokenLastCheckedAt: new Date(),
        status: userDebug.isValid ? "active" : "degraded",
        lastError: userDebug.isValid ? null : "Meta token debug is_valid=false",
        updatedAt: new Date(),
      },
    }).returning();
    if (!authAccount) throw new Error("Meta auth hesabı kaydedilemedi");

    let connected = 0;
    for (const page of pages) {
      const pageDebug = await debugToken(page.access_token).catch(() => null);
      const pageScopes = pageDebug?.scopes?.length ? pageDebug.scopes : scopes;
      const pageExpiry = pageDebug?.expiresAt ?? tokenExpiresAt;
      const subscribed = await subscribeFacebookPage(page.id, page.access_token);
      const pageStatus = pageDebug && !pageDebug.isValid ? "degraded" : "active";

      await db.insert(socialConnections).values({
        authAccountId: authAccount.id,
        platform: "facebook",
        externalAccountId: page.id,
        displayName: page.name,
        parentPageId: null,
        encryptedAccessToken: encryptSecret(page.access_token),
        grantedScopes: pageScopes,
        tokenExpiresAt: pageExpiry,
        status: pageStatus,
        lastError: pageDebug && !pageDebug.isValid ? "Page token invalid" : null,
        healthCheckedAt: new Date(),
        webhookSubscribed: subscribed,
      }).onConflictDoUpdate({
        target: [socialConnections.platform, socialConnections.externalAccountId],
        set: {
          authAccountId: authAccount.id,
          displayName: page.name,
          encryptedAccessToken: encryptSecret(page.access_token),
          grantedScopes: pageScopes,
          tokenExpiresAt: pageExpiry,
          status: sql`case when ${socialConnections.status} = 'disabled' then 'disabled' else ${pageStatus} end`,
          lastError: pageDebug && !pageDebug.isValid ? "Page token invalid" : null,
          healthCheckedAt: new Date(),
          webhookSubscribed: subscribed,
          updatedAt: new Date(),
        },
      });
      connected++;

      if (page.instagram_business_account?.id) {
        const username = page.instagram_business_account.username || `ig-${page.instagram_business_account.id}`;
        await db.insert(socialConnections).values({
          authAccountId: authAccount.id,
          platform: "instagram",
          externalAccountId: page.instagram_business_account.id,
          displayName: username,
          username: page.instagram_business_account.username ?? null,
          parentPageId: page.id,
          encryptedAccessToken: encryptSecret(page.access_token),
          grantedScopes: pageScopes,
          tokenExpiresAt: pageExpiry,
          status: pageStatus,
          lastError: pageDebug && !pageDebug.isValid ? "Page token invalid" : null,
          healthCheckedAt: new Date(),
          // Instagram webhook field subscription is configured on the Meta App/Webhooks product.
          webhookSubscribed: false,
        }).onConflictDoUpdate({
          target: [socialConnections.platform, socialConnections.externalAccountId],
          set: {
            authAccountId: authAccount.id,
            displayName: username,
            username: page.instagram_business_account.username ?? null,
            parentPageId: page.id,
            encryptedAccessToken: encryptSecret(page.access_token),
            grantedScopes: pageScopes,
            tokenExpiresAt: pageExpiry,
            status: sql`case when ${socialConnections.status} = 'disabled' then 'disabled' else ${pageStatus} end`,
            lastError: pageDebug && !pageDebug.isValid ? "Page token invalid" : null,
            healthCheckedAt: new Date(),
            updatedAt: new Date(),
          },
        });
        connected++;
      }
    }

    await audit({ request: req, actor: "admin", action: "meta.oauth.connected", entityType: "meta_auth_account", entityId: authAccount.id, metadata: { connections: connected } });
    return NextResponse.redirect(new URL(`/?connected=${connected}`, appOrigin()));
  } catch (error) {
    log.error("meta.oauth.callback_failed", { message: error instanceof Error ? error.message : String(error) });
    await audit({ request: req, actor: "admin", action: "meta.oauth.failed" });
    return NextResponse.redirect(new URL("/?meta_error=connect_failed", appOrigin()));
  }
}
