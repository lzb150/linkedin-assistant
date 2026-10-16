// Private per-card notes: saved to job-state.json on blur or after a typing
// pause, flagged with a dot on the Note toggle, cleared by emptying the field.
import { test, expect } from "../fixtures/dashboard.mjs";
import { JOBS, DEFAULT_STATE } from "../support/jobs.mjs";

const NOTE = "Recruiter: Anna, call on Tuesday";

test.describe("notes", () => {
  test("a note is saved on blur and flagged on the card", async ({ dashboard, server }) => {
    const acme = dashboard.card(JOBS.acme.title);
    await expect(acme.noteIndicator).toBeHidden();

    await acme.openNote();
    await acme.writeNote(NOTE);

    await expect(acme.noteIndicator).toBeVisible();
    await expect.poll(() => server.readState()[JOBS.acme.url]?.note).toBe(NOTE);
    // A note is not a visit: the card stays New.
    await expect(acme.newButton).toHaveAttribute("aria-pressed", "true");
  });

  test("a saved note is back in its field after a reload", async ({ dashboard, server }) => {
    const acme = dashboard.card(JOBS.acme.title);
    await acme.openNote();
    await acme.writeNote(NOTE);
    await expect.poll(() => server.readState()[JOBS.acme.url]?.note).toBe(NOTE);

    await dashboard.reload();
    const reloaded = dashboard.card(JOBS.acme.title);
    await reloaded.openNote();

    await expect(reloaded.noteBox).toHaveValue(NOTE);
    await expect(reloaded.noteIndicator).toBeVisible();
  });

  test("a note is saved after a typing pause, without leaving the field", async ({ dashboard, server }) => {
    const initech = dashboard.card(JOBS.initech.title);
    await initech.openNote();

    await initech.typeNote("Salary range asked");

    await expect(initech.noteBox).toBeFocused();
    await expect.poll(() => server.readState()[JOBS.initech.url]?.note).toBe("Salary range asked");
    await expect(initech.noteIndicator).toBeVisible();
  });

  test.describe("with a note on disk", () => {
    test.use({ seedState: { ...DEFAULT_STATE, [JOBS.globex.url]: { note: "Old note" } } });

    test("emptying the field removes the note", async ({ dashboard, server }) => {
      const sdet = dashboard.card(JOBS.globex.title);
      await expect(sdet.noteIndicator).toBeVisible();
      await sdet.openNote();
      await expect(sdet.noteBox).toHaveValue("Old note");

      await sdet.writeNote("");

      await expect(sdet.noteIndicator).toBeHidden();
      await expect.poll(() => Object.hasOwn(server.readState(), JOBS.globex.url)).toBe(false);
    });
  });
});
