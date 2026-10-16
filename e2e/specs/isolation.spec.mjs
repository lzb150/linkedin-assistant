// The browser reaches only this test's own state server: any other loopback
// port (the live :7777 dashboard among them) is cut off by the fixture's route.
import http from "node:http";
import { test, expect } from "../fixtures/dashboard.mjs";

test("the page cannot reach another 127.0.0.1 port", async ({ dashboard }) => {
  // The dashboard fixture has the page open on the test server's origin.
  const { page } = dashboard;
  let hits = 0;
  const other = http.createServer((req, res) => { hits++; res.end("ok"); });
  await new Promise((resolve) => other.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${other.address().port}/health`;
    // no-cors: a request that got through resolves (opaque) instead of failing on CORS.
    const result = await page.evaluate((u) => fetch(u, { mode: "no-cors" }).then(() => "reached", () => "blocked"), url);

    expect(result).toBe("blocked");
    expect(hits).toBe(0);
    // The test's own server still answers, so the block is not a dead network.
    expect(await page.evaluate(() => fetch("/health").then((r) => r.ok))).toBe(true);
  } finally {
    await new Promise((resolve) => other.close(resolve));
  }
});
