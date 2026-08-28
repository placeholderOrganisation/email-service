import nodemailer from "nodemailer";
import type SMTPTransport from "nodemailer/lib/smtp-transport/index.js";
import type { SmtpConfig } from "../config/env.js";

export interface OutgoingMessage {
  from: string;
  to: string;
  // Where replies go. For contact forms, set this to the submitter's address so
  // the recipient can reply directly to them (the From stays your verified sender).
  replyTo?: string;
  subject: string;
  html?: string;
  text?: string;
}

export interface Provider {
  name: string;
  send(msg: OutgoingMessage): Promise<{ messageId: string }>;
  close(): Promise<void>;
}

/** 465/2465 wrap TLS immediately; 587/2587 upgrade with STARTTLS. */
function isImplicitTls(port: number): boolean {
  return port === 465 || port === 2465;
}

/** SES publishes a second port pair so clients can dodge blocked 25/587/465. */
function sesAlternatePort(port: number): number | undefined {
  if (port === 587) return 2587;
  if (port === 2587) return 587;
  if (port === 465) return 2465;
  if (port === 2465) return 465;
  return undefined;
}

function isConnectFailure(err: unknown): boolean {
  const code = (err as { code?: string })?.code;
  if (
    code === "ETIMEDOUT" ||
    code === "ESOCKET" ||
    code === "ECONNECTION" ||
    code === "EHOSTUNREACH" ||
    code === "ENETUNREACH"
  ) {
    return true;
  }
  const message = err instanceof Error ? err.message : String(err);
  return /timeout|connect/i.test(message);
}

function annotate(err: unknown, host: string, port: number): unknown {
  if (err instanceof Error && !err.message.includes(host)) {
    err.message = `${err.message} (${host}:${port})`;
  }
  return err;
}

function createTransport(config: SmtpConfig, port: number) {
  return nodemailer.createTransport({
    host: config.host,
    port,
    secure: isImplicitTls(port),
    requireTLS: !isImplicitTls(port),
    auth: { user: config.user, pass: config.pass },
    pool: true,
    maxConnections: 5,
    // Be a good SES citizen: cap sends/sec so bursts don't trip the rate limit.
    rateLimit: 10,
    // Default connect timeout is 2 minutes, which leaves the row stuck in
    // `processing` with no logs. Fail over / retry sooner.
    connectionTimeout: 15_000,
    greetingTimeout: 15_000,
    socketTimeout: 30_000,
    // Prefer IPv4 — a broken IPv6 route to SES looks like a hang, then timeout.
    family: 4,
  } as SMTPTransport.Options);
}

/**
 * Wraps an SMTP provider (SES, Brevo, …) behind the common Provider interface.
 * The `nodemailer` transport is **pooled and created once** here, then reused for
 * every send — creating a transport per message would leak connections and ignore
 * SES's per-second send rate.
 *
 * For SES, a connect timeout on the configured port retries the AWS alternate
 * (587↔2587, 465↔2465) and sticks to whichever one worked. Render's free plan
 * blocks 25/465/587, which is why local sends work and the deployed worker times out.
 */
export function createSmtpProvider(config: SmtpConfig): Provider {
  const alternatePort = config.name === "ses" ? sesAlternatePort(config.port) : undefined;
  let port = config.port;
  let transport = createTransport(config, port);
  const fallback = alternatePort != null ? createTransport(config, alternatePort) : null;

  return {
    name: config.name,
    async send(msg) {
      try {
        const info = await transport.sendMail(msg);
        return { messageId: info.messageId };
      } catch (err) {
        if (fallback && fallback !== transport && isConnectFailure(err)) {
          console.warn(
            `[providers] ${config.name} ${config.host}:${port} connect failed, trying :${alternatePort}`,
          );
          try {
            const info = await fallback.sendMail(msg);
            transport.close();
            transport = fallback;
            port = alternatePort!;
            console.log(`[providers] ${config.name} stuck to port ${port}`);
            return { messageId: info.messageId };
          } catch (fallbackErr) {
            throw annotate(fallbackErr, config.host, alternatePort!);
          }
        }
        throw annotate(err, config.host, port);
      }
    },
    async close() {
      transport.close();
      if (fallback && fallback !== transport) fallback.close();
    },
  };
}
