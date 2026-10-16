// Source chips: All plus one chip per board that has packages on disk.
// Multi-select; an empty selection is "All".
import { test, expect, cardsTitled } from "../fixtures/dashboard.mjs";

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
});
