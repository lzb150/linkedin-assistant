import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl, jobUrl } from "../../lib/sources/glassdoor.mjs";

test("buildUrl encodes the keyword slug and its KO offsets for Ukraine", () => {
  assert.equal(buildUrl("QA Automation"),
    "https://www.glassdoor.com/Job/ukraine-qa-automation-jobs-SRCH_IL.0,7_IN244_KO8,21.htm");
  assert.equal(buildUrl("SDET"),
    "https://www.glassdoor.com/Job/ukraine-sdet-jobs-SRCH_IL.0,7_IN244_KO8,12.htm");
});

test("jobUrl keeps ?jl=<id> (bare path is 403) and drops other params", () => {
  assert.equal(jobUrl("https://www.glassdoor.com/job-listing/x-JV_KO0,1.htm?jl=123&pos=1"),
    "https://www.glassdoor.com/job-listing/x-JV_KO0,1.htm?jl=123");
  assert.equal(jobUrl("/job-listing/y.htm?jl=7"), "https://www.glassdoor.com/job-listing/y.htm?jl=7");
  assert.equal(jobUrl("https://uk.glassdoor.com/job-listing/z.htm?jl=9"), "https://uk.glassdoor.com/job-listing/z.htm?jl=9");
});

test("jobUrl drops hrefs that would resolve off glassdoor.com", () => {
  for (const bad of ["https://evil.com/x", "//evil.com/x", "https://glassdoor.com.evil.com/x",
    "https://evilglassdoor.com/x", "javascript:alert(1)", "ftp://www.glassdoor.com/x", "http://[bad", "", null]) {
    assert.equal(jobUrl(bad), null, String(bad));
  }
});
