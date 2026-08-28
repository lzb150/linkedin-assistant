import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUrl } from "../../lib/sources/glassdoor.mjs";

test("buildUrl encodes the keyword slug and its KO offsets for Ukraine", () => {
  assert.equal(buildUrl("QA Automation"),
    "https://www.glassdoor.com/Job/ukraine-qa-automation-jobs-SRCH_IL.0,7_IN244_KO8,21.htm");
  assert.equal(buildUrl("SDET"),
    "https://www.glassdoor.com/Job/ukraine-sdet-jobs-SRCH_IL.0,7_IN244_KO8,12.htm");
});
