// Empty and no-match states: a dashboard with no packages says how to get
// some; filters or a search that hide every card say so on screen instead of
// leaving <main> blank.
import { test, expect, cardsTitled } from "../fixtures/dashboard.mjs";

test.describe("no packages at all", () => {
  test.use({ dataset: "empty", seedState: null });   // no job-state.json either

  test("shows the empty-state hint and zero counts", async ({ dashboard }) => {
    await expect(dashboard.emptyState).toBeVisible();
    await expect(dashboard.emptyState).toHaveText("No matching jobs yet. Run node jobs.mjs.");
    await expect(dashboard.cards).toHaveCount(0);
    await expect(dashboard.newTab).toHaveText("New 0");
    await expect(dashboard.viewedTab).toHaveText("Viewed 0");
    await expect(dashboard.sourceChips.getByRole("button")).toHaveText(["All"]);
    await expect(dashboard.noMatch).toBeHidden();
  });

  test("filters do not stack the no-match message on the empty state", async ({ dashboard }) => {
    // A tab click re-filters synchronously (a search waits out a debounce),
    // so the checks below run against the re-filtered page.
    await dashboard.toggleNewTab();

    await expect(dashboard.newTab).toHaveAttribute("aria-pressed", "false");
    await expect(dashboard.noMatch).toBeHidden();
    await expect(dashboard.emptyState).toBeVisible();
  });
});

test.describe("search and no-match", () => {
  test("search matches title, company and skills, case-insensitively", async ({ dashboard }) => {
    await dashboard.searchFor("SDET");
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("globex"));

    await dashboard.searchFor("initech");
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("initech"));

    await dashboard.searchFor("PLAYWRIGHT");
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("acme"));
    await expect(dashboard.noMatch).toBeHidden();
  });

  test("a search that matches nothing shows the no-match message", async ({ dashboard }) => {
    await dashboard.searchFor("no-such-vacancy");

    await expect(dashboard.noMatch).toBeVisible();
    await expect(dashboard.cards).toHaveCount(0);
    await expect(dashboard.shownStatus).toHaveText("0 jobs shown");
    await expect(dashboard.emptyState).toBeHidden();
  });

  test("clearing the search brings the cards back", async ({ dashboard }) => {
    await dashboard.searchFor("no-such-vacancy");
    await expect(dashboard.noMatch).toBeVisible();

    await dashboard.searchFor("");

    await expect(dashboard.noMatch).toBeHidden();
    await expect(dashboard.cards).toHaveCount(4);
  });

  test("filters that exclude every card show the no-match message", async ({ dashboard }) => {
    // The only LinkedIn card is New: LinkedIn + Viewed-only leaves nothing.
    await dashboard.toggleSource("LinkedIn");
    await dashboard.toggleNewTab();

    await expect(dashboard.noMatch).toBeVisible();
    await expect(dashboard.cards).toHaveCount(0);

    await dashboard.toggleNewTab();

    await expect(dashboard.noMatch).toBeHidden();
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("initech"));
  });
});
