// followup.mjs as a black box: a second run the same day must not re-fire the
// reminder. (A refactor once dropped the readFileSync import; the swallowed
// ReferenceError made the dedupe file unreadable and every run re-notified.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, pkg, runScript, waitFor } from "./helpers/e2e.mjs";

test("followup.mjs fires a due reminder once per day, not on every run", async (t) => {
  const U = "https://jobs.dou.ua/companies/acme/vacancies/1/";
  const appliedAt = new Date(Date.now() - 9 * 86400000).toISOString();
  const p = makeProject(t, {
    scripts: ["followup.mjs"],
    packages: { "a.md": pkg({ url: U, generated: "2026-08-01T00:00:00Z" }) },
    state: { _meta: {}, [U]: { status: "applied", appliedAt, updatedAt: appliedAt } },
  });

  assert.match(await runScript(p, "followup.mjs"), /1 reminder\(s\) fired/);
  const log1 = await waitFor(p.path("notify.log"), /Acme/);
  assert.equal((log1.match(/Acme/g) || []).length, 1, "one banner after the first run");

  assert.match(await runScript(p, "followup.mjs"), /0 reminder\(s\) fired/, "same-day re-run is deduped");
  await new Promise((r) => setTimeout(r, 300));
  assert.equal((p.read("notify.log").match(/Acme/g) || []).length, 1, "no second banner");
});
