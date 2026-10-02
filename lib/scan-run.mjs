// The skeleton both inbox CLIs (check.mjs, djinni-check.mjs) share: launch the
// browser on a profile, run the scan, map what happened to one outcome, then
// always let the caller persist its state and close the browser. It used to be
// copied into each CLI, and the copies drifted — djinni-check treated a benign
// "profile busy" overlap as a failure (exit 1 + a "Browser launch failed"
// banner) while check.mjs logged it and exited 0.
import { launchBrowser } from "./browser.mjs";
import { log, notify } from "./notify.mjs";

// outcome: "ok" | "busy" | "failed". "busy" = another run (jobs.mjs, login.mjs,
// a manual run) holds the profile: log only, no banner, exit 0 for launchd.
//   scan(page, ctx)      the CLI's page logic; may process.exit itself (logged out)
//   finish({ held })     persists state; `held` = this run had the profile, so
//                        it may write back stores it loaded. Must not throw.
export async function runScan({ profile, app, scan, finish = () => {} }) {
  let ctx;
  let outcome = "ok";
  try {
    ctx = await launchBrowser(profile); // inside try: a launch/lock failure logs instead of an unhandled rejection
    const page = ctx.pages()[0] || (await ctx.newPage());
    await scan(page, ctx);
  } catch (err) {
    log("ERROR:", err?.message || err);
    outcome = /profile busy/.test(err?.message || "") ? "busy" : "failed";
    if (!ctx && outcome !== "busy") notify(app, `Browser launch failed: ${err?.message || err}`);
  } finally {
    try { finish({ held: Boolean(ctx) }); } catch (e) { log("saving state failed:", e?.message); }
    // A rejected close would replace the exit code this run earned with an
    // unhandled rejection; the state files above are already written.
    try { await ctx?.close(); } catch (e) { log("browser close failed:", e?.message); }
  }
  return outcome;
}
