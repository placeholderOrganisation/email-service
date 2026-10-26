import dotenv from "dotenv";

dotenv.config();

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (value === undefined) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

/** Ensures a URL has a scheme; "*" is passed through to allow all CORS origins. */
function normalizeUrl(value: string): string {
  const v = value.trim();
  if (!v || v === "*") return v;
  const withScheme = /^https?:\/\//.test(v) ? v : `https://${v}`;
  return withScheme.replace(/\/+$/, "");
}

function nonNegativeNumber(value: string | undefined, fallback: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

interface SmtpConfig {
  name: string;
  host: string;
  port: number;
  user: string;
  pass: string;
}

/** A provider is "configured" only once it has a host + credentials. */
export function isConfigured(c: SmtpConfig): boolean {
  return Boolean(c.host && c.user && c.pass);
}

export const env = {
  nodeEnv: process.env.NODE_ENV ?? "development",
  port: Number(process.env.PORT ?? 4100),
  clientOrigins: (process.env.CLIENT_ORIGIN ?? "*")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(normalizeUrl),

  mongoUri: required("MONGODB_URI", "mongodb://localhost:27017/email-service"),

  // Shared secret for the /admin dashboard + its JSON API. Unset = admin UI disabled.
  adminToken: process.env.ADMIN_TOKEN ?? "",

  // OpenAI powers review analysis + reply drafting. With no apiKey the AI
  // service falls back to a deterministic mock (dev/tests run token-free).
  openai: {
    apiKey: process.env.OPENAI_API_KEY ?? "",
    model: process.env.OPENAI_MODEL ?? "gpt-4o-mini",
    baseUrl: process.env.OPENAI_BASE_URL || undefined,
  },

  // Google Business Profile (review sync + reply posting). One operator Google
  // account (a Manager on every client profile) is connected via OAuth; its
  // refresh token is stored encrypted with tokenEncryptionKey. Any of the four
  // unset = Google features disabled (see isGoogleConfigured).
  google: {
    clientId: process.env.GOOGLE_OAUTH_CLIENT_ID ?? "",
    clientSecret: process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? "",
    redirectUri: process.env.GOOGLE_OAUTH_REDIRECT_URI ?? "",
    tokenEncryptionKey: process.env.GOOGLE_TOKEN_ENCRYPTION_KEY ?? "",
  },
  // How often the in-process worker syncs Google reviews. 0 disables the scheduler.
  reviewSyncIntervalMinutes: nonNegativeNumber(process.env.REVIEW_SYNC_INTERVAL_MINUTES, 360),

  // Ordered by preference: SES primary, Brevo failover. The provider layer
  // filters out any that aren't fully configured, so SES-only just works.
  smtp: {
    ses: {
      name: "ses",
      host: process.env.SES_SMTP_HOST ?? "",
      port: Number(process.env.SES_SMTP_PORT ?? 587),
      user: process.env.SES_SMTP_USER ?? "",
      pass: process.env.SES_SMTP_PASS ?? "",
    } satisfies SmtpConfig,
    brevo: {
      name: "brevo",
      host: process.env.BREVO_SMTP_HOST ?? "",
      port: Number(process.env.BREVO_SMTP_PORT ?? 587),
      user: process.env.BREVO_SMTP_USER ?? "",
      pass: process.env.BREVO_SMTP_PASS ?? "",
    } satisfies SmtpConfig,
  },
};

/** Google features require the full OAuth client + the token encryption key. Read at call time. */
export function isGoogleConfigured(): boolean {
  const g = env.google;
  return Boolean(g.clientId && g.clientSecret && g.redirectUri && g.tokenEncryptionKey);
}

export type { SmtpConfig };
