// Per-card New / Viewed buttons and the automatic Viewed on opening a card.
// Every status lands in the server's job-state.json, not just on screen.
import { test, expect } from "../fixtures/dashboard.mjs";
import { JOBS, DEFAULT_STATE } from "../support/jobs.mjs";

test.describe("status buttons", () => {
  test("Mark Viewed flips the card, the counts and the store on disk", async ({ dashboard, server }) => {
    const sdet = dashboard.card(JOBS.globex.title);
    await expect(sdet.newButton).toHaveAttribute("aria-pressed", "true");

    await sdet.markViewed();

    await expect(sdet.viewedButton).toHaveAttribute("aria-pressed", "true");
    await expect(sdet.newButton).toHaveAttribute("aria-pressed", "false");
    await expect(sdet.heading).toHaveText(/, viewed$/);
    await expect(dashboard.newTab).toHaveText("New 3");
    await expect(dashboard.viewedTab).toHaveText("Viewed 1");
    await expect.poll(() => server.readState()[JOBS.globex.url]?.status).toBe("viewed");
  });

  test("a status set on the card survives a reload", async ({ dashboard }) => {
    await dashboard.card(JOBS.globex.title).markViewed();
    await expect(dashboard.viewedTab).toHaveText("Viewed 1");

    await dashboard.reload();

    await expect(dashboard.card(JOBS.globex.title).viewedButton).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.viewedTab).toHaveText("Viewed 1");
  });

  test.describe("on a Viewed card", () => {
    test.use({ seedState: { ...DEFAULT_STATE, [JOBS.globex.url]: { status: "viewed" } } });

    test("Mark New puts it back and drops the entry from the store", async ({ dashboard, server }) => {
      const sdet = dashboard.card(JOBS.globex.title);
      await expect(sdet.viewedButton).toHaveAttribute("aria-pressed", "true");

      await sdet.markNew();

      await expect(sdet.newButton).toHaveAttribute("aria-pressed", "true");
      await expect(sdet.heading).toHaveText(JOBS.globex.title);
      await expect(dashboard.viewedTab).toHaveText("Viewed 0");
      // "new" is never stored: an entry with no status and no note is removed.
      await expect.poll(() => Object.hasOwn(server.readState(), JOBS.globex.url)).toBe(false);
    });
  });

  test("expanding the cover letter marks the card Viewed", async ({ dashboard, server }) => {
    const initech = dashboard.card(JOBS.initech.title);

    await initech.openCoverLetter();

    await expect(initech.viewedButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => server.readState()[JOBS.initech.url]?.status).toBe("viewed");
  });

  test("opening the cover letter from the keyboard marks the card Viewed", async ({ dashboard, server }) => {
    const initech = dashboard.card(JOBS.initech.title);

    await initech.openCoverLetterWithKeyboard();

    await expect(initech.viewedButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => server.readState()[JOBS.initech.url]?.status).toBe("viewed");
  });

  test("a letter find-in-page opened leaves the card New", async ({ dashboard, server }) => {
    const initech = dashboard.card(JOBS.initech.title);

    await initech.revealCoverLetterByFind();
    // Writes are serialized: once a later click has landed, a stray Viewed would have too.
    await dashboard.card(JOBS.globex.title).markViewed();
    await expect.poll(() => server.readState()[JOBS.globex.url]?.status).toBe("viewed");

    await expect(initech.copyButton).toBeVisible();
    await expect(initech.newButton).toHaveAttribute("aria-pressed", "true");
    expect(server.readState()[JOBS.initech.url]?.status).toBeUndefined();
  });

  test("opening the job link marks the card Viewed", async ({ dashboard, server }) => {
    const acme = dashboard.card(JOBS.acme.title);

    const posting = await acme.openJob();

    await expect(posting).toHaveURL(JOBS.acme.url);
    await expect(acme.viewedButton).toHaveAttribute("aria-pressed", "true");
    await expect.poll(() => server.readState()[JOBS.acme.url]?.status).toBe("viewed");
  });

  test("opening a closed card never reopens it", async ({ dashboard, server }) => {
    await dashboard.toggleNewTab();
    await dashboard.toggleViewedTab();   // both off: the closed card shows
    const umbrella = dashboard.card(JOBS.umbrella.title);

    await umbrella.openCoverLetter();
    // Writes are serialized: once a later click has landed, a stray Viewed
    // for the closed card would have landed too.
    await dashboard.card(JOBS.initech.title).markViewed();
    await expect.poll(() => server.readState()[JOBS.initech.url]?.status).toBe("viewed");

    await expect(umbrella.heading).toHaveText(/, closed$/);
    await expect(umbrella.newButton).toHaveAttribute("aria-pressed", "false");
    await expect(umbrella.viewedButton).toHaveAttribute("aria-pressed", "false");
    expect(server.readState()[JOBS.umbrella.url]?.status).toBe("closed");
  });

  test("a card without an http(s) link is read-only", async ({ dashboard }) => {
    const broken = dashboard.card(JOBS.nowhere.title);
    await expect(broken.heading).toBeVisible();

    await expect(broken.openJobLink).toHaveAttribute("href", "#");
    await expect(broken.statusButtons).toHaveCount(0);
    await expect(broken.noteToggle).toHaveCount(0);
  });
});
