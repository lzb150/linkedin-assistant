// Shared Playwright launcher (previously copy-pasted in check.mjs, jobs.mjs,
// djinni-check.mjs, and login.mjs).
import { chromium } from "playwright";
import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync, utimesSync, openSync, closeSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";

const HEADFUL = process.env.HEADFUL === "1";

// LinkedIn urls that mean "session gone": /login, a 2FA /checkpoint, or the
// /authwall (three inline copies drifted — login.mjs's lacked /authwall).
export const LINKEDIN_LOGGED_OUT = /\/login|\/checkpoint|\/authwall/;
const STALE_LOCK_MS = 2 * 60 * 60 * 1000;
const LOCK_HEARTBEAT_MS = 10 * 60 * 1000;

// Profile lock: two Chromium instances on one persistent profile corrupt it.
//
// The pid FILE is the lock, created with O_EXCL — one atomic syscall decides the
// winner. The directory around it is only a container. It used to be the other
// way round (mkdir was the lock, the pid written after), which left a real race:
// two runs could both judge the lock stale, both remove it, and both "win" the
// mkdir, because the second rm deleted the first's directory. The pid re-read
// that followed narrowed that window but could not close it.
//
// Takeover requires a DEAD holder. A live pid is never evicted, however old the
// mtime: the heartbeat is a setInterval, and timers do not fire while macOS is
// asleep, so after a long sleep a still-running holder looks stale on mtime
// alone. Evicting it put two Chromium instances on one profile — the exact
// corruption this lock prevents. An old mtime on a LIVE pid now yields "profile
// busy"; at worst a reused pid costs one skipped run, which is far cheaper.
// An unparsable/empty pid file has no owner to protect and is still reclaimable
// once stale.
//
// The takeover itself is atomic: rename the pid file aside first. rename(2)
// picks exactly one winner, so two runs that both judge the same lock dead
// cannot both proceed to delete and re-create it (the old re-read-then-unlink
// was two syscalls with a gap in between, and the loser could unlink the
// winner's fresh lock). The loser's rename fails with ENOENT and it falls
// through to the ordinary O_EXCL claim, where it gets "busy".
export function acquireProfileLock(profileDir, { now = Date.now(), staleMs = STALE_LOCK_MS, heartbeatMs = LOCK_HEARTBEAT_MS } = {}) {
  const lock = `${profileDir}.lock`;
  const pidFile = join(lock, "pid");
  // Container only, and it may already exist. A regular FILE at this path would
  // make every later step fail obscurely, so it is named here instead.
  try {
    mkdirSync(lock, { recursive: true });
  } catch (e) {
    throw new Error(`profile lock path is not a directory: ${lock} (${e.code || e.message})`);
  }

  // One snapshot, so the staleness verdict and the takeover refer to the same file.
  const holder = () => {
    try { return { raw: readFileSync(pidFile, "utf8"), mtimeMs: statSync(pidFile).mtimeMs }; } catch { return null; }
  };
  // null = unknown (empty or unparsable): not dead, so the mtime rule decides.
  const alive = (raw) => {
    const pid = Number(raw);
    if (!Number.isInteger(pid) || pid <= 0) return null;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
  };

  const held = holder();
  if (held) {
    const live = alive(held.raw);
    // Dead pid → crashed run, reclaim at once. Unknown pid (empty/unparsable,
    // live === null) → no owner to protect, reclaim once it is also stale.
    // Live pid → never reclaim, whatever the mtime says.
    const reclaimable = live === false || (live === null && now - held.mtimeMs > staleMs);
    if (reclaimable) {
      // Atomic takeover: exactly one racer's rename can succeed, and only that
      // racer may remove the file. A loser gets ENOENT and falls through to the
      // O_EXCL claim below, which reports "busy" if the winner got there first.
      const aside = `${pidFile}.${process.pid}`;
      try {
        renameSync(pidFile, aside);
        try { unlinkSync(aside); } catch {}
      } catch {}
    }
  }

  // The CAS: exclusive create, no overwrite. One retry, because another run's
  // release() can remove the whole directory between our mkdir and this open —
  // the lock is then free, and failing with a raw ENOENT would turn "free" into
  // an opaque filesystem error. Bounded at one: a second ENOENT means something
  // is deleting the directory continuously, which is not ours to work around.
  const claim = () => {
    const fd = openSync(pidFile, "wx");
    try { writeFileSync(fd, String(process.pid)); } finally { closeSync(fd); }
  };
  try {
    claim();
  } catch (e) {
    if (e.code === "EEXIST") throw new Error(`profile busy: another run holds ${lock}`);
    if (e.code !== "ENOENT") throw e;
    mkdirSync(lock, { recursive: true });
    try { claim(); } catch (e2) {
      if (e2.code === "EEXIST") throw new Error(`profile busy: another run holds ${lock}`);
      throw e2;
    }
  }

  const ownsLock = () => { try { return readFileSync(pidFile, "utf8") === String(process.pid); } catch { return false; } };
  const touch = () => {
    const d = new Date();
    try { utimesSync(pidFile, d, d); } catch {}
    try { utimesSync(lock, d, d); } catch {}
  };
  const hb = setInterval(touch, heartbeatMs);
  hb.unref();
  // Never rm a lock someone else took over (e.g. after our pid was misjudged dead).
  // Idempotent: the signal handlers below call it and then exit, which fires the
  // "exit" listener too, and a caller may also release explicitly.
  const onSignal = [];
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    clearInterval(hb);
    process.off("exit", release);
    for (const [sig, h] of onSignal) process.off(sig, h);
    if (ownsLock()) rmSync(lock, { recursive: true, force: true });
  };
  // "exit" does not fire for a default-disposition SIGTERM/SIGINT/SIGHUP, so
  // `launchctl kill`, unloading the job, or Ctrl-C on a manual run used to leave
  // the lock behind — and with pids recycled quickly, the next run could then
  // see a live unrelated pid and refuse for the full stale window. Release
  // first, then exit 128+signo so callers and launchd still see a signalled run.
  for (const [sig, no] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]]) {
    const h = () => { release(); process.exit(128 + no); };
    onSignal.push([sig, h]);
    process.once(sig, h);
  }
  process.on("exit", release);
  return release;
}

// A Playwright upgrade expects a new browser build (1.60→1.63 moved chromium
// 1223→1243); every browser script then fails at launch. Name the fix in the
// error so the "Browser launch failed" banner is actionable.
export function explainLaunchError(e) {
  const msg = e?.message || "";
  return /Executable doesn't exist/.test(msg)
    ? new Error(`Playwright browser build missing — run: npx playwright install chromium (after every playwright upgrade). ${msg.split("\n")[0]}`)
    : e;
}

// Visible browser when headful (login scripts always; scheduled jobs with
// HEADFUL=1), headless "new" mode otherwise.
export async function launchBrowser(profileDir, { headful = HEADFUL } = {}) {
  const release = acquireProfileLock(profileDir);
  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(profileDir, {
      headless: !headful,
      viewport: { width: 1280, height: 900 },
      args: [
        "--disable-blink-features=AutomationControlled",
        "--disk-cache-size=52428800",   // 50 MB: hourly LinkedIn visits grew .browser-profile/ to 889 MB of cache
        ...(headful ? [] : ["--headless=new", "--no-first-run", "--no-default-browser-check"]),
      ],
    });
  } catch (e) {
    release();
    throw explainLaunchError(e);
  }
  const close = ctx.close.bind(ctx);
  ctx.close = async (...a) => { try { return await close(...a); } finally { release(); } };
  return ctx;
}
