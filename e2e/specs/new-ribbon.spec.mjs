// NEW ribbon: a card generated after the stored lastVisit carries it. 4 s after
// load the client moves lastVisit up to the newest package on the page (never
// "now"), so the next load shows no ribbon.
import { test, expect, cardsTitled } from "../fixtures/dashboard.mjs";
import { JOBS, DEFAULT_STATE } from "../support/jobs.mjs";

// Between Globex (10-02) and Initech (10-03): Initech, Umbrella and Nowhere are new.
const LAST_VISIT = "2026-10-02T12:00:00.000Z";

test.describe("NEW ribbon", () => {
  test.use({ seedState: { ...DEFAULT_STATE, _meta: { lastVisit: LAST_VISIT } } });

  test("marks only the jobs generated after the last visit", async ({ dashboard }) => {
    // The ribbon sits after the title, so the headings still match by title.
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("acme", "globex", "initech", "nowhere"));
    await expect(dashboard.card(JOBS.initech.title).ribbon).toBeVisible();
    await expect(dashboard.card(JOBS.nowhere.title).ribbon).toBeVisible();
    await expect(dashboard.card(JOBS.acme.title).ribbon).toHaveCount(0);
    await expect(dashboard.card(JOBS.globex.title).ribbon).toHaveCount(0);
  });

  test("the visit moves lastVisit to the newest package, and a reload drops the ribbons", async ({ dashboard, server }) => {
    await expect(dashboard.card(JOBS.nowhere.title).ribbon).toBeVisible();

    // Nowhere (10-05) is the newest package on the page.
    await expect.poll(() => server.readState()._meta.lastVisit, { timeout: 10_000 }).toBe(JOBS.nowhere.generated);

    await dashboard.reload();
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("acme", "globex", "initech", "nowhere"));
    await expect(dashboard.cards.getByText("NEW", { exact: true })).toHaveCount(0);
  });
});
