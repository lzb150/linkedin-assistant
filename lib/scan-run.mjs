// The skeleton both inbox CLIs (check.mjs, djinni-check.mjs) share: launch the
// browser on a profile, run the scan, map what happened to one outcome, then
// always let the caller persist its state and close the browser. It used to be
// copied into each CLI, and the copies drifted — djinni-check treated a benign
// "profile busy" overlap as a failure (exit 1 + a "Browser launch failed"
// banner) while check.mjs logged it and exited 0.
import { launchBrowser, closeBounded } from "./browser.mjs";
import { log, notify } from "./notify.mjs";

// outcome: "ok" | "busy" | "failed". "busy" = another run (jobs.mjs, login.mjs,
// a manual run) holds the profile: log only, no banner, exit 0 for launchd.
//   scan(page, ctx, signal)  the CLI's page logic; may process.exit itself
//                        (logged out). `signal` aborts at the deadline: nobody
//                        awaits the scan after that, finish() has saved its
//                        stores, and a scan that unsticks during the bounded
//                        close must not open more threads or write a draft
//                        it can no longer mark seen.
//   finish({ held })     persists state; `held` = this run had the profile, so
//                        it may write back stores it loaded. Must not throw.
//   deadlineMs           the whole scan's budget. page.$$eval / evaluate /
//                        innerText have no timeout of their own, and the
//                        profile lock's heartbeat keeps a hung run's lock fresh
//                        forever: one stuck renderer used to leave every later
//                        hourly run "profile busy" (exit 0, no banner) until
//                        someone killed the process. Past it the run fails.
//                        SCAN_DEADLINE_MS in the environment overrides the
//                        default (tests drive the past-deadline path with it).
//   launch, alert        seams for tests; launchBrowser / notify in production.
export const SCAN_DEADLINE_MS = /^\d+$/.test(process.env.SCAN_DEADLINE_MS || "") ? Number(process.env.SCAN_DEADLINE_MS) : 15 * 60_000;

export async function runScan({ profile, app, scan, finish = () => {}, deadlineMs = SCAN_DEADLINE_MS, launch = launchBrowser, alert = notify }) {
  let ctx;
  let outcome = "ok";
  let timer, stuck = false;
  const abort = new AbortController();
  try {
    ctx = await launch(profile); // inside try: a launch/lock failure logs instead of an unhandled rejection
    const page = ctx.pages()[0] || (await ctx.newPage());
    const running = scan(page, ctx, abort.signal);
    running.catch(() => {});   // past the deadline nobody awaits it; its late rejection must not crash the exit path
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => { stuck = true; abort.abort(); reject(new Error(`scan exceeded ${Math.round(deadlineMs / 60_000)} min — aborted`)); }, deadlineMs);
    });
    await Promise.race([running, deadline]);
  } catch (err) {
    outcome = failureOutcome(err, { app, alert, launched: Boolean(ctx), stuck });
  } finally {
    clearTimeout(timer);
    try { finish({ held: Boolean(ctx) }); } catch (e) { log("saving state failed:", e?.message); }
    // A rejected close would replace the exit code this run earned with an
    // unhandled rejection; the state files above are already written. Bounded:
    // the browser that hung the scan can hang its own close too.
    await closeBounded(ctx, { log });
  }
  return outcome;
}

const reason = (err) => err?.message || err;

// A run that threw: logged, mapped to "busy" or "failed", and bannered when
// it got stuck past the deadline or the browser never launched.
function failureOutcome(err, { app, alert, launched, stuck }) {
  log("ERROR:", reason(err));
  const outcome = /profile busy/.test(err?.message || "") ? "busy" : "failed";
  if (stuck) alert(app, `Run stuck: ${err.message}`);
  else if (!launched && outcome !== "busy") alert(app, `Browser launch failed: ${reason(err)}`);
  return outcome;
}
