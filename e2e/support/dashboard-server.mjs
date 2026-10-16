// Throwaway dashboards for the e2e suite. buildDashboard runs the real
// dashboard.mjs over fixture packages in a temp project (a COPY of the script
// and lib/: dashboard.mjs writes next to itself, and the repo's own
// applications/index.html must never be touched). startServer serves one
// build through the real state server on a random loopback port with its own
// job-state.json, so a status click never reaches the live :7777 instance or
// the user's real store.
import { mkdtempSync, mkdirSync, copyFileSync, cpSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "../../state-server.mjs";
import { packageMarkdown } from "./jobs.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// global-setup.mjs → the server fixture: { full, empty } index.html paths.
export const BUILDS_ENV = "DASHBOARD_E2E_BUILDS";

const removeDir = (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

// → { indexPath, remove() }. `jobs` is a list of fixture vacancies (jobs.mjs).
export function buildDashboard(jobs) {
  const dir = mkdtempSync(join(tmpdir(), "dash-e2e-"));
  copyFileSync(join(ROOT, "dashboard.mjs"), join(dir, "dashboard.mjs"));
  cpSync(join(ROOT, "lib"), join(dir, "lib"), { recursive: true });
  mkdirSync(join(dir, "applications"));
  jobs.forEach((job, i) => writeFileSync(join(dir, "applications", `job-${i}.md`), packageMarkdown(job)));
  execFileSync(process.execPath, [join(dir, "dashboard.mjs")], { cwd: dir, stdio: "pipe" });
  return { indexPath: join(dir, "applications", "index.html"), remove: () => removeDir(dir) };
}

// → { base, statePath, readState(), stop(), restart(), remove() }.
// `state` seeds job-state.json; omitted, the store starts missing (= empty).
// stop()/restart() take the server off the network and bring it back at the
// same address, which is what the dashboard sees when the launchd service
// restarts. The port stays bound while it is "down" (every connection is
// reset instead): released, another worker's listen(0) could take it, and the
// page would then be talking to a different test's server.
export async function startServer({ indexPath, state }) {
  const dir = mkdtempSync(join(tmpdir(), "state-e2e-"));
  const statePath = join(dir, "job-state.json");
  if (state) writeFileSync(statePath, JSON.stringify(state));
  const srv = createServer({ statePath, indexPath });
  let down = false;
  srv.on("connection", (socket) => { if (down) socket.destroy(); });
  const port = await new Promise((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => resolve(srv.address().port));
  });
  // closeAllConnections: the browser's keep-alive sockets would otherwise keep
  // reaching a "stopped" server, and would hold the final close() open.
  const stop = () => { down = true; srv.closeAllConnections(); };

  return {
    base: `http://127.0.0.1:${port}`,
    statePath,
    // What the server has on disk: the store the dashboard's clicks must reach.
    // Only a missing file is an empty store; a corrupt one must fail the test.
    readState: () => {
      try { return JSON.parse(readFileSync(statePath, "utf8")); }
      catch (e) { if (e.code === "ENOENT") return { _meta: {} }; throw e; }
    },
    stop,
    restart: () => { down = false; },
    remove: async () => {
      stop();
      await new Promise((resolve) => srv.close(() => resolve()));
      removeDir(dir);
    },
  };
}
