// Source chips: All plus one chip per board that has packages on disk, shown
// while the board has cards in the selected status tabs (or is selected).
// Multi-select; an empty selection is "All".
import { test, expect, cardsTitled } from "../fixtures/dashboard.mjs";
import { JOBS, DEFAULT_STATE } from "../support/jobs.mjs";

test.describe("source chips", () => {
  test("one chip per board with packages, All selected by default", async ({ dashboard }) => {
    await expect(dashboard.sourceChips.getByRole("button")).toHaveText(["All", "Djinni", "DOU", "LinkedIn"]);
    await expect(dashboard.sourceChip("All")).toHaveAttribute("aria-pressed", "true");
    for (const label of ["Djinni", "DOU", "LinkedIn"]) {
      await expect(dashboard.sourceChip(label)).toHaveAttribute("aria-pressed", "false");
    }
  });

  test("a board chip narrows the list to that board", async ({ dashboard }) => {
    await dashboard.toggleSource("DOU");

    await expect(dashboard.sourceChip("DOU")).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.sourceChip("All")).toHaveAttribute("aria-pressed", "false");
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("acme", "nowhere"));
    // The status counts keep counting every card, not just the shown ones.
    await expect(dashboard.newTab).toHaveText("New 4");
  });

  test("chips add up: DOU and Djinni together", async ({ dashboard }) => {
    await dashboard.toggleSource("DOU");
    await dashboard.toggleSource("Djinni");

    await expect(dashboard.cardTitles).toHaveText(cardsTitled("acme", "globex", "nowhere"));
  });

  test("clicking a selected chip again deselects it", async ({ dashboard }) => {
    await dashboard.toggleSource("LinkedIn");
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("initech"));

    await dashboard.toggleSource("LinkedIn");

    await expect(dashboard.sourceChip("All")).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.cards).toHaveCount(4);
  });

  test("All clears every board chip", async ({ dashboard }) => {
    await dashboard.toggleSource("DOU");
    await dashboard.toggleSource("LinkedIn");

    await dashboard.toggleSource("All");

    await expect(dashboard.sourceChip("All")).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.sourceChip("DOU")).toHaveAttribute("aria-pressed", "false");
    await expect(dashboard.sourceChip("LinkedIn")).toHaveAttribute("aria-pressed", "false");
    await expect(dashboard.cards).toHaveCount(4);
  });

  test("the chip selection survives a reload", async ({ dashboard }) => {
    await dashboard.toggleSource("Djinni");
    await dashboard.reload();

    await expect(dashboard.sourceChip("Djinni")).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.cardTitles).toHaveText(cardsTitled("globex"));
  });

  test.describe("a board whose only card is Viewed", () => {
    test.use({ seedState: { ...DEFAULT_STATE, [JOBS.globex.url]: { status: "viewed" } } });

    test("has no chip in the New view, and gets it back with Viewed", async ({ dashboard }) => {
      await dashboard.toggleViewedTab();   // New only

      await expect(dashboard.sourceChips.getByRole("button")).toHaveText(["All", "DOU", "LinkedIn"]);

      await dashboard.toggleViewedTab();

      await expect(dashboard.sourceChips.getByRole("button")).toHaveText(["All", "Djinni", "DOU", "LinkedIn"]);
    });

    test("deselecting its chip from the keyboard in the New view moves focus to All", async ({ dashboard }) => {
      await dashboard.toggleSource("Djinni");   // selected while visible
      await dashboard.toggleViewedTab();        // New only: Djinni stays, it is selected
      await dashboard.sourceChip("Djinni").focus();

      await dashboard.page.keyboard.press("Space");

      await expect(dashboard.sourceChip("Djinni")).toBeHidden();
      await expect(dashboard.sourceChip("All")).toBeFocused();
    });
  });
});
