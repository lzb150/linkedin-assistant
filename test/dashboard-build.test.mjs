// dashboard.mjs as a black box: three packages in a throwaway project →
// applications/index.html. Covers the build-time rules no unit test reaches:
// escaping of scraped frontmatter, the identity collapse, alt_links splitting
// and the http(s)-only href rule. (CI's "Dashboard smoke build" greps for the
// same hostile fixture idea; this pins the rules where node --test runs.)
import { test } from "node:test";
import assert from "node:assert/strict";
import { makeProject, runScript } from "./helpers/e2e.mjs";

const fm = (fields) => `---\n${Object.entries(fields).map(([k, v]) => `${k}: ${v}`).join("\n")}\n---\n# x\n`;

test("dashboard.mjs: escaping, identity collapse, alt_links with commas, javascript: url", async (t) => {
  const p = makeProject(t, {
    scripts: ["dashboard.mjs"],
    packages: {
      "hostile.md": fm({ source: "dou", title: "<script>alert(1)</script>", company: 'Evil" onmouseover="x</script', url: "javascript:alert(1)", generated: "2026-09-01T00:00:00Z", score: 50 }),
      "acme-old.md": fm({ source: "dou", title: "SDET", company: "Acme", url: "https://a.example/1", generated: "2026-09-01T00:00:00Z", score: 40, llm_score: 80, llm_why: "OLD-VERDICT" }),
      "acme-new.md": fm({
        source: "dou", title: "SDET", company: "Acme", url: "https://a.example/2", generated: "2026-09-02T00:00:00Z", score: 40, llm_score: 90, llm_why: "NEW-VERDICT",
        alt_links: "djinni|https://djinni.co/jobs/1?x=1,y=2, linkedin|https://www.linkedin.com/jobs/view/9",
      }),
    },
  });
  const out = await runScript(p, "dashboard.mjs");
  assert.match(out, /\(2 jobs\)$/m, "three packages → two cards");
  const html = p.read("applications", "index.html");
  assert.equal((html.match(/<article class="card"/g) || []).length, 2);

  // (a) every scraped field is escaped; the raw markup never reaches the page.
  assert.ok(!html.includes("<script>alert"), "raw <script> from a title");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"), "title rendered escaped");
  assert.ok(!html.includes('onmouseover="x'), "quote breakout from a company name");
  assert.ok(!html.includes("x</script"), "</script inside a field cannot close the inline script");

  // (b) same identity (company+title) → only the newest generated package survives.
  assert.ok(html.includes('data-url="https://a.example/2"') && html.includes("NEW-VERDICT"));
  assert.ok(!html.includes("https://a.example/1") && !html.includes("OLD-VERDICT"), "older duplicate dropped");

  // (c) alt_links split before "source|" only, so a comma inside a url survives.
  assert.equal((html.match(/class="alt"/g) || []).length, 2);
  assert.ok(html.includes('href="https://djinni.co/jobs/1?x=1,y=2"'));
  assert.ok(html.includes('href="https://www.linkedin.com/jobs/view/9"'));

  // (d) a javascript: url is never an href; the card renders read-only (no data-url → no status/notes).
  assert.ok(!html.includes('href="javascript:'));
  assert.equal((html.match(/ data-url="/g) || []).length, 1, "only the http(s) card is live");
});
