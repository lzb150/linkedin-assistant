// Builds the fixture dashboards once for the whole run: the real dashboard.mjs
// over e2e/support/jobs.mjs packages, in temp dirs (never applications/).
// Workers inherit process.env, which is how the server fixture finds them; the
// returned function is the global teardown.
import { buildDashboard, BUILDS_ENV } from "./support/dashboard-server.mjs";
import { JOBS } from "./support/jobs.mjs";

export default function globalSetup() {
  const builds = {
    full: buildDashboard(Object.values(JOBS)),
    empty: buildDashboard([]),
  };
  process.env[BUILDS_ENV] = JSON.stringify(Object.fromEntries(Object.entries(builds).map(([k, b]) => [k, b.indexPath])));
  return () => { for (const b of Object.values(builds)) b.remove(); };
}
