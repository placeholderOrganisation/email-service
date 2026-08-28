import { env } from "../config/env.js";
import { Email, MAX_ATTEMPTS, type EmailDocument } from "../models/Email.js";
import { EmailTemplate } from "../models/EmailTemplate.js";
import { render, type RenderSource } from "../services/render.js";
import {
  PermanentSendError,
  getProviders,
  sendWithFailover,
  type Provider,
} from "../providers/index.js";

const TICK_MS = 10_000; // how often to poll the queue
const BATCH = 20; // max emails drained per tick (so bursts don't trickle out)
const STALE_MS = 2 * 60_000; // a `processing` row older than this was orphaned by a crash
// Backoff before retry N (index = attempts-1). Length < MAX_ATTEMPTS since the
// final attempt goes terminal instead of scheduling another retry.
const BACKOFF_MS = [60_000, 5 * 60_000];

let timer: NodeJS.Timeout | null = null;
let ticking = false; // guards against overlapping ticks in this process
let stopping = false;

/** Worker logs. Skipped in tests; never includes recipients or body (PII). */
function workerLog(level: "log" | "warn", message: string, extra: Record<string, unknown> = {}): void {
  if (env.nodeEnv === "test") return;
  const fields = Object.entries(extra)
    .map(([k, v]) => `${k}=${v === undefined || v === "" ? "(none)" : JSON.stringify(v)}`)
    .join(" ");
  console[level](`[worker] ${message}${fields ? ` ${fields}` : ""}`);
}

/**
 * Atomically claims the next due email: a fresh `queued`, a `failed` row whose
 * backoff has elapsed, or a `processing` row orphaned by a crash. The
 * findOneAndUpdate flips it to `processing` so no other tick/instance can grab it.
 */
async function claimNext(): Promise<EmailDocument | null> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_MS);
  return Email.findOneAndUpdate(
    {
      $or: [
        { status: "queued", nextAttemptAt: { $lte: now } },
        { status: "failed", attempts: { $lt: MAX_ATTEMPTS }, nextAttemptAt: { $lte: now } },
        { status: "processing", lockedAt: { $lte: staleBefore } },
      ],
    },
    { $set: { status: "processing", lockedAt: now } },
    { new: true, sort: { nextAttemptAt: 1 } },
  );
}

/** Resolves an email (raw or template) into the rendered `{ subject, html?, text? }`. */
async function buildMessage(email: EmailDocument) {
  const variables = (email.variables as Record<string, unknown>) ?? {};
  let source: RenderSource;

  if (email.templateName) {
    const tpl = await EmailTemplate.findOne({
      projectId: email.projectId,
      name: email.templateName,
    });
    // A missing template is permanent — retrying won't conjure it.
    if (!tpl) throw new PermanentSendError(`template "${email.templateName}" not found`);
    source = { subject: tpl.subject, format: tpl.format, body: tpl.body };
  } else if (email.markdown != null) {
    source = {
      subject: email.subject ?? "",
      format: "markdown",
      body: email.markdown,
      providedText: email.text ?? undefined,
    };
  } else if (email.html != null) {
    source = {
      subject: email.subject ?? "",
      format: "html",
      body: email.html,
      providedText: email.text ?? undefined,
    };
  } else {
    source = { subject: email.subject ?? "", format: "text", body: email.text ?? "" };
  }

  return render(source, variables);
}

function describe(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 500);
}

async function processEmail(email: EmailDocument, providers?: Provider[]): Promise<void> {
  workerLog("log", "processing", {
    id: String(email._id),
    attempts: email.attempts,
    template: email.templateName,
    lastError: email.lastError,
  });

  try {
    const { subject, html, text } = await buildMessage(email);
    const msg = {
      from: email.from,
      to: email.to,
      replyTo: email.replyTo ?? undefined,
      subject,
      html,
      text,
    };
    const result = providers
      ? await sendWithFailover(msg, providers)
      : await sendWithFailover(msg);

    email.status = "sent";
    email.provider = result.provider;
    email.providerMessageId = result.messageId;
    email.sentAt = new Date();
    email.lastError = undefined;
    email.lockedAt = undefined;
    await email.save();
    workerLog("log", "sent", { id: String(email._id), provider: result.provider });
  } catch (err) {
    email.lockedAt = undefined;

    if (err instanceof PermanentSendError) {
      // Terminal: bump attempts to the max so the claim query won't re-pick it.
      email.status = "failed";
      email.attempts = MAX_ATTEMPTS;
      email.lastError = `permanent: ${describe(err)}`;
      await email.save();
      workerLog("warn", "failed", {
        id: String(email._id),
        kind: "permanent",
        error: email.lastError,
      });
      return;
    }

    // Transient (or an unexpected error): retry with backoff until attempts run out.
    email.attempts += 1;
    email.status = "failed";
    email.lastError = `transient: ${describe(err)}`;
    const willRetry = email.attempts < MAX_ATTEMPTS;
    let retryInMs: number | undefined;
    if (willRetry) {
      retryInMs = BACKOFF_MS[Math.min(email.attempts - 1, BACKOFF_MS.length - 1)];
      email.nextAttemptAt = new Date(Date.now() + retryInMs);
    }
    await email.save();
    workerLog("warn", "failed", {
      id: String(email._id),
      kind: "transient",
      attempts: `${email.attempts}/${MAX_ATTEMPTS}`,
      retryInMs: willRetry ? retryInMs : "(none, terminal)",
      error: email.lastError,
    });
  }
}

/** Drains up to BATCH due emails. Exported for tests (deterministic, no timer). */
export async function drainOnce(providers?: Provider[]): Promise<number> {
  let processed = 0;
  for (let i = 0; i < BATCH; i++) {
    const email = await claimNext();
    if (!email) break;
    await processEmail(email, providers);
    processed += 1;
  }
  return processed;
}

async function tick(): Promise<void> {
  if (ticking || stopping) return;
  ticking = true;
  try {
    await drainOnce();
  } catch (err) {
    console.error("[worker] tick error", err);
  } finally {
    ticking = false;
  }
}

export function startWorker(): void {
  stopping = false;
  // Resolve the provider list at boot so SES/Brevo config shows up immediately,
  // not on the first queued send.
  getProviders();
  void tick(); // run one immediately on boot
  timer = setInterval(() => void tick(), TICK_MS);
  console.log(`[worker] started (poll ${TICK_MS / 1000}s, batch ${BATCH})`);
}

/** Stops the poll loop and waits for an in-flight tick to finish (graceful shutdown). */
export async function stopWorker(): Promise<void> {
  stopping = true;
  if (timer) clearInterval(timer);
  timer = null;
  while (ticking) await new Promise((r) => setTimeout(r, 50));
}
