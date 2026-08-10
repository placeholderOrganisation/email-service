import nodemailer from "nodemailer";
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

/**
 * Wraps an SMTP provider (SES, Brevo, …) behind the common Provider interface.
 * The `nodemailer` transport is **pooled and created once** here, then reused for
 * every send — creating a transport per message would leak connections and ignore
 * SES's per-second send rate.
 */
export function createSmtpProvider(config: SmtpConfig): Provider {
  const transport = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.port === 465, // 465 = implicit TLS; 587 = STARTTLS
    auth: { user: config.user, pass: config.pass },
    pool: true,
    maxConnections: 5,
    // Be a good SES citizen: cap sends/sec so bursts don't trip the rate limit.
    rateLimit: 10,
  });

  return {
    name: config.name,
    async send(msg) {
      const info = await transport.sendMail(msg);
      return { messageId: info.messageId };
    },
    async close() {
      transport.close();
    },
  };
}
