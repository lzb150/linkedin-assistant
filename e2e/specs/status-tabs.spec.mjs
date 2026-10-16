// New / Viewed header tabs: multi-select status filter with live counts. Both
// are on by default; Closed cards only show once both are off.
import { test, expect, cardsTitled } from "../fixtures/dashboard.mjs";
import { JOBS, DEFAULT_STATE } from "../support/jobs.mjs";

test.describe("status tabs", () => {
  test.use({ seedState: { ...DEFAULT_STATE, [JOBS.globex.url]: { status: "viewed" } } });

  test("both tabs are on by default, count every status and hide the closed card", async ({ dashboard }) => {
    await expect(dashboard.newTab).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.viewedTab).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.newTab).toHaveText("New 3");
    await expect(dashboard.viewedTab).toHaveText("Viewed 1");
    // Sorted LLM-scored first, then keyword score; Umbrella is closed.
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("acme", "globex", "initech", "nowhere"));
    await expect(dashboard.shownStatus).toHaveText("4 jobs shown");
  });

  test("turning New off leaves only the Viewed cards", async ({ dashboard }) => {
    await dashboard.toggleNewTab();

    await expect(dashboard.newTab).toHaveAttribute("aria-pressed", "false");
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("globex"));
    await expect(dashboard.card(JOBS.globex.title).heading).toHaveText(/, viewed$/);
  });

  test("turning Viewed off leaves only the New cards", async ({ dashboard }) => {
    await dashboard.toggleViewedTab();

    await expect(dashboard.viewedTab).toHaveAttribute("aria-pressed", "false");
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("acme", "initech", "nowhere"));
  });

  test("with both tabs off every card shows, the closed one with its cue", async ({ dashboard }) => {
    await dashboard.toggleNewTab();
    await dashboard.toggleViewedTab();

    await expect(dashboard.cardTitles).toHaveText(cardsTitled("acme", "globex", "initech", "umbrella", "nowhere"));
    await expect(dashboard.card(JOBS.umbrella.title).heading).toHaveText(/, closed$/);
    await expect(dashboard.shownStatus).toHaveText("5 jobs shown");
  });

  test("the tab selection survives a reload", async ({ dashboard }) => {
    await dashboard.toggleNewTab();
    await dashboard.reload();

    await expect(dashboard.newTab).toHaveAttribute("aria-pressed", "false");
    await expect(dashboard.viewedTab).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("globex"));
  });

  test("an expanded card stays on screen after it turns Viewed under the New tab", async ({ dashboard }) => {
    await dashboard.toggleViewedTab();
    const acme = dashboard.card(JOBS.acme.title);

    await acme.openCoverLetter();   // auto-marks it Viewed

    await expect(acme.viewedButton).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.viewedTab).toHaveText("Viewed 2");
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("acme", "initech", "nowhere"));
  });
});
