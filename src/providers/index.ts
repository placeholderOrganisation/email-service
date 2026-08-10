import { env, isConfigured } from "../config/env.js";
import { createSmtpProvider, type OutgoingMessage, type Provider } from "./smtpProvider.js";

export type { OutgoingMessage, Provider } from "./smtpProvider.js";

/**
 * A failure the worker must NOT retry or fail over on — the message itself is bad
 * (invalid recipient, rejected content, missing template). Retrying it wastes
 * attempts and, worse, repeatedly bouncing off SES raises your bounce rate and
 * can get the SES account paused.
 */
export class PermanentSendError extends Error {
  constructor(
    message: string,
    public cause?: unknown,
  ) {
    super(message);
    this.name = "PermanentSendError";
  }
}

/** A failure worth retrying / failing over: connection, timeout, throttling, 5xx-server. */
export class TransientSendError extends Error {
  constructor(
    message: string,
    public failures: Array<{ provider: string; error: string }> = [],
  ) {
    super(message);
    this.name = "TransientSendError";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * An SMTP 5xx is a permanent rejection (bad recipient, message refused). 4xx
 * (greylisting/busy), connection errors, timeouts and auth failures are transient
 * — worth trying the next provider or retrying later.
 */
function isPermanent(err: unknown): boolean {
  const code = (err as { responseCode?: number })?.responseCode;
  return typeof code === "number" && code >= 500 && code < 600;
}

// Providers are built lazily so tests can run without SMTP env, and so config is
// read after dotenv has loaded. Ordered by preference: SES first, Brevo second.
let cached: Provider[] | null = null;

export function getProviders(): Provider[] {
  if (!cached) {
    cached = [env.smtp.ses, env.smtp.brevo].filter(isConfigured).map(createSmtpProvider);
    if (cached.length === 0) {
      console.warn("[providers] no SMTP provider configured — sends will fail until one is set");
    } else {
      console.log(`[providers] active: ${cached.map((p) => p.name).join(", ")}`);
    }
  }
  return cached;
}

export async function closeProviders(): Promise<void> {
  if (cached) {
    await Promise.all(cached.map((p) => p.close()));
    cached = null;
  }
}

/**
 * Sends through providers in order. Permanent errors abort immediately (no
 * failover). Transient errors move on to the next provider; if all providers
 * fail transiently, throws TransientSendError so the worker schedules a retry.
 * `providers` is injectable for tests.
 */
export async function sendWithFailover(
  msg: OutgoingMessage,
  providers: Provider[] = getProviders(),
): Promise<{ provider: string; messageId: string }> {
  if (providers.length === 0) {
    throw new TransientSendError("no SMTP provider configured");
  }

  const failures: Array<{ provider: string; error: string }> = [];
  for (const provider of providers) {
    try {
      const { messageId } = await provider.send(msg);
      return { provider: provider.name, messageId };
    } catch (err) {
      if (isPermanent(err)) {
        throw new PermanentSendError(`${provider.name} permanently rejected the message`, err);
      }
      failures.push({ provider: provider.name, error: errorMessage(err) });
    }
  }

  throw new TransientSendError(
    `all providers failed: ${failures.map((f) => `${f.provider}(${f.error})`).join("; ")}`,
    failures,
  );
}
