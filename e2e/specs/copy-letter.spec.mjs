// Copy letter: puts the cover letter on the clipboard exactly as written (the
// zero-width spaces buildApplication adds after heading-like #s stripped) and
// announces the outcome in the card's live region.
import { test, expect } from "../fixtures/dashboard.mjs";
import { JOBS, ZWSP } from "../support/jobs.mjs";

test.describe("Copy letter", () => {
  // One at a time: headed (--headed, --ui) Chromium writes the real system
  // clipboard, which parallel tests would race for.
  test.describe.configure({ mode: "default" });
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });

  test("copies the letter without zero-width spaces and says so", async ({ dashboard }) => {
    // The fixture must carry one, or the strip below is never exercised.
    expect(JOBS.acme.cover).toContain(ZWSP);
    const acme = dashboard.card(JOBS.acme.title);
    await acme.openCoverLetter();

    await acme.copyLetter();

    await expect(acme.copyStatus).toHaveText("Copied");
    expect(await dashboard.clipboardText()).toBe(JOBS.acme.cover.replaceAll(ZWSP, ""));
    // The announcement clears itself, so the next copy is announced again.
    await expect(acme.copyStatus).toHaveText("");
  });

  test("each card copies its own letter", async ({ dashboard }) => {
    const sdet = dashboard.card(JOBS.globex.title);
    await sdet.openCoverLetter();

    await sdet.copyLetter();

    await expect(sdet.copyStatus).toHaveText("Copied");
    expect(await dashboard.clipboardText()).toBe(JOBS.globex.cover);
  });

  test("without a clipboard API it reports Copy failed", async ({ dashboard, page }) => {
    // What a non-secure context looks like: no navigator.clipboard at all.
    await page.addInitScript(() => Object.defineProperty(Navigator.prototype, "clipboard", { get: () => undefined }));
    await dashboard.reload();
    const acme = dashboard.card(JOBS.acme.title);
    await acme.openCoverLetter();

    await acme.copyLetter();

    await expect(acme.copyStatus).toHaveText("Copy failed");
  });
});
