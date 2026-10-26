import crypto from "node:crypto";
import { isGoogleConfigured } from "../../config/env.js";
import { GoogleConnection, GOOGLE_CONNECTION_KEY } from "../../models/GoogleConnection.js";
import { encrypt } from "../../utils/crypto.js";
import { clearGoogleTokenCache, getGoogleClient } from "./client.js";

const STATE_TTL_MS = 10 * 60_000;

export interface GoogleStatus {
  configured: boolean;
  connected: boolean;
  email: string | null;
  connectedAt: Date | null;
  lastError: string | null;
}

/** Operator-facing connection status. Never includes the token or the OAuth state. */
export async function getGoogleStatus(): Promise<GoogleStatus> {
  const conn = await GoogleConnection.findOne({ key: GOOGLE_CONNECTION_KEY });
  const connected = Boolean(conn?.refreshTokenEnc);
  return {
    configured: isGoogleConfigured(),
    connected,
    email: connected ? (conn?.email ?? null) : null,
    connectedAt: connected ? (conn?.connectedAt ?? null) : null,
    lastError: conn?.lastError ?? null,
  };
}

export async function isGoogleConnected(): Promise<boolean> {
  return Boolean(await GoogleConnection.exists({ key: GOOGLE_CONNECTION_KEY, refreshTokenEnc: { $type: "string" } }));
}

/** Creates (replacing any pending one) a random single-use OAuth state valid for 10 minutes. */
export async function createOAuthState(): Promise<string> {
  const state = crypto.randomBytes(32).toString("hex");
  await GoogleConnection.updateOne(
    { key: GOOGLE_CONNECTION_KEY },
    { $set: { oauthState: state, oauthStateExpiresAt: new Date(Date.now() + STATE_TTL_MS) } },
    { upsert: true },
  );
  return state;
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Validates + consumes the OAuth state from the callback. This is the callback's
 * ONLY authentication (it's a browser redirect, so no admin token is possible).
 * Constant-time compare against the stored value, then an atomic conditional
 * clear so a state can be used at most once even under concurrent callbacks.
 */
export async function consumeOAuthState(state: string | undefined): Promise<boolean> {
  if (!state) return false;
  const conn = await GoogleConnection.findOne({ key: GOOGLE_CONNECTION_KEY });
  const stored = conn?.oauthState;
  if (!stored || !conn?.oauthStateExpiresAt || conn.oauthStateExpiresAt.getTime() <= Date.now()) return false;
  if (!safeEqual(state, stored)) return false;
  const cleared = await GoogleConnection.findOneAndUpdate(
    { key: GOOGLE_CONNECTION_KEY, oauthState: stored },
    { $unset: { oauthState: 1, oauthStateExpiresAt: 1 } },
  );
  return Boolean(cleared);
}

/** Encrypts + stores the refresh token from a successful code exchange. */
export async function storeGoogleConnection(input: {
  refreshToken: string;
  email?: string;
  scopes: string[];
}): Promise<void> {
  await GoogleConnection.updateOne(
    { key: GOOGLE_CONNECTION_KEY },
    {
      $set: {
        refreshTokenEnc: encrypt(input.refreshToken),
        email: input.email,
        scopes: input.scopes,
        connectedAt: new Date(),
      },
      $unset: { lastError: 1 },
    },
    { upsert: true },
  );
  clearGoogleTokenCache();
}

/** Best-effort revoke at Google, then forget the connection entirely. */
export async function disconnectGoogle(): Promise<{ revoked: boolean }> {
  let revoked = false;
  if (await isGoogleConnected()) {
    try {
      await getGoogleClient().revoke();
      revoked = true;
    } catch {
      // Already revoked / network down — we still drop our copy below.
    }
  }
  await GoogleConnection.deleteOne({ key: GOOGLE_CONNECTION_KEY });
  clearGoogleTokenCache();
  return { revoked };
}
