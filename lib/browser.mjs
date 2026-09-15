// Shared Playwright launcher (previously copy-pasted in check.mjs, jobs.mjs,
// djinni-check.mjs, and login.mjs).
import { chromium } from "playwright";
import { mkdirSync, rmSync, statSync, readFileSync, writeFileSync, utimesSync, openSync, closeSync, unlinkSync } from "node:fs";
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
// Takeover rules are unchanged: a dead pid means a crashed run, and a pid older
// than 2 h is stale too, since pids get reused and an ancient lock whose pid
// happens to be running is far more likely a crash than a run. The holder
// touches the lock every 10 min, so "old mtime" means a dead holder rather than
// a long run (LLM retries and a sleeping Mac have stretched runs past 2 h).
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
  if (held && (alive(held.raw) === false || now - held.mtimeMs > staleMs)) {
    // Re-read immediately before unlinking: if the pid changed in between, someone
    // else already took over and this is their live lock, not the stale one we judged.
    const still = holder();
    if (still && still.raw === held.raw) { try { unlinkSync(pidFile); } catch {} }
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
  const release = () => { clearInterval(hb); process.off("exit", release); if (ownsLock()) rmSync(lock, { recursive: true, force: true }); };
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
