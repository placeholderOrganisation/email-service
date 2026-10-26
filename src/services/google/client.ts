// Google Business Profile + OAuth over plain `fetch`. This module is the ONLY
// place that talks to Google; tests swap the whole client via
// setGoogleClientForTests() (or just `fetch` via setGoogleFetchForTests()).
// Tokens are never logged.

import { env } from "../../config/env.js";
import { GoogleConnection, GOOGLE_CONNECTION_KEY } from "../../models/GoogleConnection.js";
import { decrypt } from "../../utils/crypto.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const ACCOUNTS_URL = "https://mybusinessaccountmanagement.googleapis.com/v1/accounts";
const BUSINESS_INFO_BASE = "https://mybusinessbusinessinformation.googleapis.com/v1";
const V4_BASE = "https://mybusiness.googleapis.com/v4";

export const GOOGLE_SCOPES = "https://www.googleapis.com/auth/business.manage openid email";
export const BUSINESS_MANAGE_SCOPE = "https://www.googleapis.com/auth/business.manage";

// Refresh the cached access token this long before Google says it expires.
const EXPIRY_SKEW_MS = 60_000;
const MAX_LIST_PAGES = 50; // accounts/locations pagination safety cap

/**
 * - not_connected: no stored refresh token
 * - reconnect:     the grant is revoked/expired/undecryptable (401, invalid_grant)
 * - transient:     429 / 5xx / network — safe to retry later
 * - rejected:      any other non-2xx (Google refused the request)
 */
export type GoogleErrorKind = "not_connected" | "reconnect" | "transient" | "rejected";

export class GoogleApiError extends Error {
  kind: GoogleErrorKind;
  status?: number;

  constructor(kind: GoogleErrorKind, message: string, status?: number) {
    super(message);
    this.kind = kind;
    this.status = status;
    Object.setPrototypeOf(this, GoogleApiError.prototype);
  }

  get reconnectRequired(): boolean {
    return this.kind === "reconnect" || this.kind === "not_connected";
  }
}

export interface GoogleTokenExchange {
  accessToken: string;
  expiresIn: number; // seconds
  refreshToken?: string;
  scopes: string[];
  email?: string;
}

export interface GoogleAccount {
  name: string; // "accounts/{id}"
  accountName?: string; // display name
  type?: string;
}

export interface GoogleLocation {
  name: string; // "locations/{id}"
  title?: string;
  storefrontAddress?: {
    addressLines?: string[];
    locality?: string;
    administrativeArea?: string;
    postalCode?: string;
    regionCode?: string;
  };
  metadata?: { placeId?: string };
}

export type GoogleStarRating = "ONE" | "TWO" | "THREE" | "FOUR" | "FIVE" | "STAR_RATING_UNSPECIFIED";

export interface GoogleReviewReply {
  comment: string;
  updateTime: string;
}

export interface GoogleReview {
  name: string; // "accounts/A/locations/L/reviews/R"
  reviewId?: string;
  reviewer?: { displayName?: string; isAnonymous?: boolean; profilePhotoUrl?: string };
  starRating?: GoogleStarRating;
  comment?: string;
  createTime: string;
  updateTime: string;
  reviewReply?: GoogleReviewReply;
}

export interface GoogleReviewsPage {
  reviews: GoogleReview[];
  nextPageToken?: string;
  totalReviewCount?: number;
}

export interface GoogleClient {
  getAuthUrl(state: string): string;
  exchangeCode(code: string): Promise<GoogleTokenExchange>;
  getAccessToken(): Promise<string>;
  revoke(): Promise<void>;
  listAccounts(): Promise<GoogleAccount[]>;
  listLocations(accountName: string): Promise<GoogleLocation[]>;
  listReviews(accountName: string, locationName: string, pageToken?: string): Promise<GoogleReviewsPage>;
  updateReply(reviewName: string, comment: string): Promise<GoogleReviewReply>;
}

// ---- injection hooks ----

let fetchImpl: typeof fetch = (input, init) => globalThis.fetch(input, init);
let clientOverride: GoogleClient | null = null;

/** Test hook: replace `fetch` used by the default client (null restores the global). */
export function setGoogleFetchForTests(fn: typeof fetch | null): void {
  fetchImpl = fn ?? ((input, init) => globalThis.fetch(input, init));
}

/** Test hook: replace the whole client (null restores the real one). */
export function setGoogleClientForTests(client: GoogleClient | null): void {
  clientOverride = client;
}

export function getGoogleClient(): GoogleClient {
  return clientOverride ?? defaultGoogleClient;
}

// ---- access-token cache (in memory, per process) ----

let cachedToken: { token: string; expiresAt: number; source: string } | null = null;

export function clearGoogleTokenCache(): void {
  cachedToken = null;
}

// ---- HTTP helpers ----

async function send(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetchImpl(url, init);
  } catch (err) {
    throw new GoogleApiError("transient", `Could not reach Google: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Google's own error text: `error.message` (APIs) or `error_description` / `error` (OAuth). */
async function errorFrom(res: Response): Promise<GoogleApiError> {
  const json = (await res.json().catch(() => ({}))) as {
    error?: string | { message?: string; status?: string };
    error_description?: string;
  };
  let message = res.statusText || `HTTP ${res.status}`;
  if (typeof json.error === "object" && json.error?.message) message = json.error.message;
  else if (json.error_description) message = json.error_description;
  else if (typeof json.error === "string") message = json.error;

  const oauthCode = typeof json.error === "string" ? json.error : undefined;
  let kind: GoogleErrorKind = "rejected";
  if (res.status === 401 || oauthCode === "invalid_grant") kind = "reconnect";
  else if (res.status === 429 || res.status >= 500) kind = "transient";
  return new GoogleApiError(kind, message, res.status);
}

function form(params: Record<string, string>): RequestInit {
  return {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  };
}

/** The id_token comes straight from Google's token endpoint over TLS — decoded for display only. */
function emailFromIdToken(idToken: string | undefined): string | undefined {
  const payload = idToken?.split(".")[1];
  if (!payload) return undefined;
  try {
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { email?: unknown };
    return typeof claims.email === "string" ? claims.email : undefined;
  } catch {
    return undefined;
  }
}

async function loadRefreshTokenEnc(): Promise<string> {
  const conn = await GoogleConnection.findOne({ key: GOOGLE_CONNECTION_KEY });
  if (!conn?.refreshTokenEnc) throw new GoogleApiError("not_connected", "Google is not connected");
  return conn.refreshTokenEnc;
}

async function recordConnectionError(message: string): Promise<void> {
  await GoogleConnection.updateOne({ key: GOOGLE_CONNECTION_KEY }, { $set: { lastError: message } }).catch(
    () => undefined,
  );
}

async function refreshAccessToken(): Promise<string> {
  const enc = await loadRefreshTokenEnc();
  if (cachedToken && cachedToken.source === enc && cachedToken.expiresAt - EXPIRY_SKEW_MS > Date.now()) {
    return cachedToken.token;
  }

  let refreshToken: string;
  try {
    refreshToken = decrypt(enc);
  } catch {
    const msg = "Stored Google token could not be decrypted (was GOOGLE_TOKEN_ENCRYPTION_KEY changed?) - reconnect Google";
    await recordConnectionError(msg);
    throw new GoogleApiError("reconnect", msg);
  }

  const res = await send(
    TOKEN_URL,
    form({
      client_id: env.google.clientId,
      client_secret: env.google.clientSecret,
      refresh_token: refreshToken,
      grant_type: "refresh_token",
    }),
  );
  if (!res.ok) {
    const err = await errorFrom(res);
    if (err.kind === "reconnect") await recordConnectionError(`Token refresh failed: ${err.message}`);
    throw err;
  }
  const json = (await res.json()) as { access_token: string; expires_in?: number };
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000,
    source: enc,
  };
  await GoogleConnection.updateOne(
    { key: GOOGLE_CONNECTION_KEY, lastError: { $type: "string" } },
    { $unset: { lastError: 1 } },
  ).catch(() => undefined);
  return cachedToken.token;
}

/** Authenticated JSON call. A 401 drops the cached token and retries once with a fresh one. */
async function googleJson<T>(method: string, url: string, body?: unknown): Promise<T> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await refreshAccessToken();
    const res = await send(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    if (res.ok) return (await res.json().catch(() => ({}))) as T;
    if (res.status === 401 && attempt === 0) {
      clearGoogleTokenCache();
      continue;
    }
    const err = await errorFrom(res);
    if (err.kind === "reconnect") await recordConnectionError(err.message);
    throw err;
  }
  throw new GoogleApiError("reconnect", "Google rejected the access token");
}

// ---- the real client ----

export const defaultGoogleClient: GoogleClient = {
  getAuthUrl(state) {
    const params = new URLSearchParams({
      client_id: env.google.clientId,
      redirect_uri: env.google.redirectUri,
      response_type: "code",
      scope: GOOGLE_SCOPES,
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
      state,
    });
    return `${AUTH_URL}?${params.toString()}`;
  },

  async exchangeCode(code) {
    const res = await send(
      TOKEN_URL,
      form({
        code,
        client_id: env.google.clientId,
        client_secret: env.google.clientSecret,
        redirect_uri: env.google.redirectUri,
        grant_type: "authorization_code",
      }),
    );
    if (!res.ok) throw await errorFrom(res);
    const json = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      refresh_token?: string;
      scope?: string;
      id_token?: string;
    };
    return {
      accessToken: json.access_token,
      expiresIn: json.expires_in ?? 3600,
      refreshToken: json.refresh_token,
      scopes: (json.scope ?? "").split(/\s+/).filter(Boolean),
      email: emailFromIdToken(json.id_token),
    };
  },

  getAccessToken: refreshAccessToken,

  async revoke() {
    const enc = await loadRefreshTokenEnc();
    const token = decrypt(enc);
    const res = await send(`${REVOKE_URL}?token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    clearGoogleTokenCache();
    if (!res.ok) throw await errorFrom(res);
  },

  async listAccounts() {
    const out: GoogleAccount[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < MAX_LIST_PAGES; i++) {
      const url = `${ACCOUNTS_URL}?pageSize=20${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ""}`;
      const page = await googleJson<{ accounts?: GoogleAccount[]; nextPageToken?: string }>("GET", url);
      out.push(...(page.accounts ?? []));
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  },

  async listLocations(accountName) {
    const out: GoogleLocation[] = [];
    let pageToken: string | undefined;
    for (let i = 0; i < MAX_LIST_PAGES; i++) {
      const url =
        `${BUSINESS_INFO_BASE}/${accountName}/locations?readMask=name,title,storefrontAddress,metadata&pageSize=100` +
        (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
      const page = await googleJson<{ locations?: GoogleLocation[]; nextPageToken?: string }>("GET", url);
      out.push(...(page.locations ?? []));
      pageToken = page.nextPageToken;
      if (!pageToken) break;
    }
    return out;
  },

  async listReviews(accountName, locationName, pageToken) {
    const url =
      `${V4_BASE}/${accountName}/${locationName}/reviews?pageSize=50&orderBy=updateTime%20desc` +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const page = await googleJson<Partial<GoogleReviewsPage>>("GET", url);
    return {
      reviews: page.reviews ?? [],
      nextPageToken: page.nextPageToken || undefined,
      totalReviewCount: page.totalReviewCount,
    };
  },

  async updateReply(reviewName, comment) {
    return googleJson<GoogleReviewReply>("PUT", `${V4_BASE}/${reviewName}/reply`, { comment });
  },
};
