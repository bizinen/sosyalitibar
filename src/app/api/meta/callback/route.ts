import { NextResponse } from "next/server";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { metaAuthAccounts, metaSettings, socialConnections, socialItems } from "@/db/schema";
import { invalidateAnalyses, lockAnalysisContext } from "@/lib/analysis-state";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
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
import { log, safeErrorMessage } from "@/lib/log";
import { getMetaSettings } from "@/lib/meta-settings";

export async function GET(req: Request) {
  if (!(await isAdmin())) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const cfg = await getMetaSettings();
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const denied = url.searchParams.get("error");
  if (!state || !(await consumeOAuthState(state)) || (!code && !denied)) {
    await audit({ request: req, actor: "admin", action: "meta.oauth.invalid_callback" });
    return NextResponse.json({ error: "invalid_oauth_callback" }, { status: 400 });
  }
  if (denied) {
    await audit({ request: req, actor: "admin", action: "meta.oauth.denied" });
    return NextResponse.redirect(new URL("/?meta_error=oauth_denied", cfg.metaPublicOrigin));
  }

  try {
    const short = await exchangeCode(code!);
    let userToken = short.accessToken;
    let expiresIn = short.expiresIn;
    try {
      const long = await exchangeLongLivedUserToken(short.accessToken);
      userToken = long.accessToken;
      expiresIn = long.expiresIn ?? expiresIn;
    } catch (error) {
      log.warn("meta.oauth.long_lived_exchange_failed", { message: safeErrorMessage(error) });
    }

    const [user, scopes, userDebug, pages] = await Promise.all([
      getMetaUser(userToken),
      getGrantedScopes(userToken),
      debugToken(userToken),
      getManagedPages(userToken),
    ]);
    if (!userDebug.isValid || userDebug.appId !== cfg.META_APP_ID || userDebug.userId !== user.id
      || (userDebug.dataAccessExpiresAt && userDebug.dataAccessExpiresAt.getTime() <= Date.now())) {
      throw new Error("Meta OAuth token identity mismatch or invalid token");
    }
    const tokenExpiresAt = userDebug.expiresAt !== undefined ? userDebug.expiresAt : (expiresIn ? new Date(Date.now() + expiresIn * 1000) : null);
    if (!pages.length) {
      await audit({ request: req, actor: "admin", action: "meta.oauth.no_pages" });
      return NextResponse.redirect(new URL("/?meta_error=no_pages", cfg.metaPublicOrigin));
    }

    const [authAccount] = await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_meta_settings'))`);
      const [settings] = await tx.select({ revision: metaSettings.revision }).from(metaSettings).where(eq(metaSettings.id, "primary"));
      if ((settings?.revision ?? 0) !== cfg.metaSettingsRevision) throw new Error("Meta settings changed during authorization; reconnect required");
      return tx.insert(metaAuthAccounts).values({
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
    });
    if (!authAccount) throw new Error("Meta auth hesabı kaydedilemedi");

    let connected = 0;
    for (const page of pages) {
      const pageDebug = await debugToken(page.access_token).catch(() => null);
      const pageScopes = pageDebug?.scopes?.length ? pageDebug.scopes : scopes;
      const pageExpiry = pageDebug?.expiresAt !== undefined ? pageDebug.expiresAt : tokenExpiresAt;
      const pageDataAccessExpired = Boolean(pageDebug?.dataAccessExpiresAt && pageDebug.dataAccessExpiresAt.getTime() <= Date.now());
      let subscribed = false;
      const missingPageScopes = ["pages_read_engagement", "pages_read_user_content", "pages_manage_metadata"].filter((scope) => !pageScopes.includes(scope));
      const missingInstagramScopes = ["instagram_basic", "instagram_manage_comments", "pages_read_engagement"].filter((scope) => !pageScopes.includes(scope));
      const pageStatus = pageDebug?.isValid && pageDebug.appId === cfg.META_APP_ID && !pageDataAccessExpired && subscribed && !missingPageScopes.length ? "active" : "degraded";
      const pageError = !pageDebug ? "Page token health unavailable" : !pageDebug.isValid || pageDebug.appId !== cfg.META_APP_ID || pageDataAccessExpired
        ? "Page token invalid or belongs to another app" : !subscribed ? "Page webhook subscription failed" : missingPageScopes.length ? `missing_scope:${missingPageScopes.join(",")}` : null;

      await db.transaction(async (tx) => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_meta_settings'))`);
        const [settings] = await tx.select({ revision: metaSettings.revision }).from(metaSettings).where(eq(metaSettings.id, "primary"));
        if ((settings?.revision ?? 0) !== cfg.metaSettingsRevision) throw new Error("Meta settings changed during authorization; reconnect required");
        await lockAnalysisContext(tx, true);
        const [previous] = await tx.select().from(socialConnections).where(and(
          eq(socialConnections.platform, "facebook"), eq(socialConnections.externalAccountId, page.id),
        )).limit(1);
      await tx.insert(socialConnections).values({
        authAccountId: authAccount.id,
        platform: "facebook",
        externalAccountId: page.id,
        displayName: page.name,
        parentPageId: null,
        encryptedAccessToken: encryptSecret(page.access_token),
        grantedScopes: pageScopes,
        tokenExpiresAt: pageExpiry,
        status: pageStatus,
        lastError: pageError,
        healthCheckedAt: new Date(),
        webhookSubscribed: subscribed,
      }).onConflictDoUpdate({
        target: [socialConnections.platform, socialConnections.externalAccountId],
        set: {
          authAccountId: authAccount.id,
          syncLockId: null,
          syncLockedAt: null,
          syncState: sql`${socialConnections.syncState} - 'continuation' - 'syncPending' - 'syncDead' - 'syncRetryAt' - 'syncError' - 'healthError'`,
          displayName: page.name,
          encryptedAccessToken: encryptSecret(page.access_token),
          grantedScopes: pageScopes,
          tokenExpiresAt: pageExpiry,
          status: sql`case when ${socialConnections.status} = 'disabled' then 'disabled' else ${pageStatus} end`,
          lastError: pageError,
          healthCheckedAt: new Date(),
          webhookSubscribed: subscribed,
          updatedAt: new Date(),
        },
      });
        if (previous && previous.displayName !== page.name) {
          await invalidateAnalyses(tx, eq(socialItems.connectionId, previous.id));
        }
      });
      connected++;

      if (page.instagram_business_account?.id) {
        const username = page.instagram_business_account.username || `ig-${page.instagram_business_account.id}`;
        await db.transaction(async (tx) => {
          await tx.execute(sql`select pg_advisory_xact_lock(hashtext('sosyal_itibar_meta_settings'))`);
          const [settings] = await tx.select({ revision: metaSettings.revision }).from(metaSettings).where(eq(metaSettings.id, "primary"));
          if ((settings?.revision ?? 0) !== cfg.metaSettingsRevision) throw new Error("Meta settings changed during authorization; reconnect required");
          await lockAnalysisContext(tx, true);
          const [previous] = await tx.select().from(socialConnections).where(and(
            eq(socialConnections.platform, "instagram"),
            eq(socialConnections.externalAccountId, page.instagram_business_account!.id),
          )).limit(1);
        await tx.insert(socialConnections).values({
          authAccountId: authAccount.id,
          platform: "instagram",
          externalAccountId: page.instagram_business_account!.id,
          displayName: username,
          username: page.instagram_business_account!.username ?? null,
          parentPageId: page.id,
          encryptedAccessToken: encryptSecret(page.access_token),
          grantedScopes: pageScopes,
          tokenExpiresAt: pageExpiry,
          status: pageDebug?.isValid && pageDebug.appId === cfg.META_APP_ID && !pageDataAccessExpired && !missingInstagramScopes.length ? "active" : "degraded",
          lastError: !pageDebug || !pageDebug.isValid || pageDebug.appId !== cfg.META_APP_ID || pageDataAccessExpired ? "Instagram source token health unavailable or invalid" : missingInstagramScopes.length ? `missing_scope:${missingInstagramScopes.join(",")}` : null,
          healthCheckedAt: new Date(),
          // Instagram webhook field subscription is configured on the Meta App/Webhooks product.
          webhookSubscribed: false,
        }).onConflictDoUpdate({
          target: [socialConnections.platform, socialConnections.externalAccountId],
          set: {
            authAccountId: authAccount.id,
            syncLockId: null,
            syncLockedAt: null,
            syncState: sql`${socialConnections.syncState} - 'continuation' - 'syncPending' - 'syncDead' - 'syncRetryAt' - 'syncError' - 'healthError'`,
            displayName: username,
            username: page.instagram_business_account!.username ?? null,
            parentPageId: page.id,
            encryptedAccessToken: encryptSecret(page.access_token),
            grantedScopes: pageScopes,
            tokenExpiresAt: pageExpiry,
            status: sql`case when ${socialConnections.status} = 'disabled' then 'disabled' else ${pageDebug?.isValid && pageDebug.appId === cfg.META_APP_ID && !pageDataAccessExpired && !missingInstagramScopes.length ? "active" : "degraded"} end`,
            lastError: !pageDebug || !pageDebug.isValid || pageDebug.appId !== cfg.META_APP_ID || pageDataAccessExpired ? "Instagram source token health unavailable or invalid" : missingInstagramScopes.length ? `missing_scope:${missingInstagramScopes.join(",")}` : null,
            healthCheckedAt: new Date(),
            updatedAt: new Date(),
          },
        });
          if (previous && (previous.displayName !== username
            || previous.username !== (page.instagram_business_account!.username ?? null)
            || previous.parentPageId !== page.id)) {
            await invalidateAnalyses(tx, eq(socialItems.connectionId, previous.id));
          }
        });
        connected++;
      }
      const savedPage = await db.query.socialConnections.findFirst({ where: and(
        eq(socialConnections.platform, "facebook"), eq(socialConnections.externalAccountId, page.id),
      ) });
      if (savedPage && savedPage.status !== "disabled" && decryptSecret(savedPage.encryptedAccessToken) === page.access_token) {
        subscribed = await subscribeFacebookPage(page.id, page.access_token);
        const healthyToken = Boolean(pageDebug?.isValid && pageDebug.appId === cfg.META_APP_ID && !pageDataAccessExpired);
        const subscriptionError = !healthyToken ? pageError : !subscribed ? "Page webhook subscription failed" : missingPageScopes.length ? `missing_scope:${missingPageScopes.join(",")}` : null;
        await db.update(socialConnections).set({ webhookSubscribed: subscribed,
          status: sql`case when ${healthyToken && subscribed && !missingPageScopes.length} and ${socialConnections.syncState}->>'syncError' is null then 'active' else 'degraded' end`,
          lastError: sql`nullif(concat_ws('; ', ${socialConnections.syncState}->>'syncError', ${subscriptionError}::text), '')`,
          syncState: sql`${socialConnections.syncState} || jsonb_build_object('healthError', ${subscriptionError}::text)`,
          updatedAt: new Date(),
        }).where(and(eq(socialConnections.id, savedPage.id), eq(socialConnections.encryptedAccessToken, savedPage.encryptedAccessToken),
          inArray(socialConnections.status, ["active", "degraded"])));
      }
    }

    await audit({ request: req, actor: "admin", action: "meta.oauth.connected", entityType: "meta_auth_account", entityId: authAccount.id, metadata: { connections: connected } });
    return NextResponse.redirect(new URL(`/?connected=${connected}`, cfg.metaPublicOrigin));
  } catch (error) {
    log.error("meta.oauth.callback_failed", { message: safeErrorMessage(error) });
    await audit({ request: req, actor: "admin", action: "meta.oauth.failed" });
    return NextResponse.redirect(new URL("/?meta_error=connect_failed", cfg.metaPublicOrigin));
  }
}
