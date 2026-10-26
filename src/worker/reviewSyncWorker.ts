import { env, isGoogleConfigured } from "../config/env.js";
import { syncAllProjects } from "../services/google/sync.js";

const FIRST_TICK_DELAY_MS = 30_000; // let the server settle before the first sync

let firstTimer: NodeJS.Timeout | null = null;
let timer: NodeJS.Timeout | null = null;
let ticking = false; // guards against overlapping ticks in this process
let stopping = false;

async function tick(): Promise<void> {
  if (ticking || stopping) return;
  // Unconfigured = idle. Checked per tick so the scheduler needs no restart logic.
  if (!isGoogleConfigured()) return;
  ticking = true;
  try {
    const { skipped, results } = await syncAllProjects({ shouldStop: () => stopping });
    if (!skipped && env.nodeEnv !== "test") {
      const failed = results.filter((r) => r.result.status === "error").length;
      console.log(`[review-sync] tick done projects=${results.length} failed=${failed}`);
    }
  } catch (err) {
    console.error("[review-sync] tick error", err instanceof Error ? err.message : err);
  } finally {
    ticking = false;
  }
}

/** Schedules Google review syncs every REVIEW_SYNC_INTERVAL_MINUTES (0 disables). First run ~30s after boot. */
export function startReviewSyncWorker(): void {
  if (env.nodeEnv === "test") return;
  const minutes = env.reviewSyncIntervalMinutes;
  if (!minutes) {
    console.log("[review-sync] scheduler disabled (REVIEW_SYNC_INTERVAL_MINUTES=0)");
    return;
  }
  stopping = false;
  firstTimer = setTimeout(() => void tick(), FIRST_TICK_DELAY_MS);
  timer = setInterval(() => void tick(), minutes * 60_000);
  console.log(
    `[review-sync] started (every ${minutes} min${isGoogleConfigured() ? "" : "; idle until Google is configured"})`,
  );
}

/** Stops scheduling and waits for an in-flight tick, which aborts between reviews once `stopping` is set. */
export async function stopReviewSyncWorker(): Promise<void> {
  stopping = true;
  if (firstTimer) clearTimeout(firstTimer);
  if (timer) clearInterval(timer);
  firstTimer = null;
  timer = null;
  while (ticking) await new Promise((r) => setTimeout(r, 50));
}
