import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl } from "../../lib/sources/glassdoor.mjs";

test("buildUrl encodes the keyword slug and its KO offsets for Ukraine", () => {
  assert.equal(buildUrl("QA Automation"),
    "https://www.glassdoor.com/Job/ukraine-qa-automation-jobs-SRCH_IL.0,7_IN244_KO8,21.htm");
  assert.equal(buildUrl("SDET"),
    "https://www.glassdoor.com/Job/ukraine-sdet-jobs-SRCH_IL.0,7_IN244_KO8,12.htm");
});

test("job url keeps ?jl=<id> (bare path is 403) and drops other params", () => {
  const url = new URL("https://www.glassdoor.com/job-listing/x-JV_KO0,1.htm?jl=123&pos=1", "https://www.glassdoor.com").href.replace(/(\?jl=\d+).*$/, "$1");
  assert.equal(url, "https://www.glassdoor.com/job-listing/x-JV_KO0,1.htm?jl=123");
});
