// The offline badge: when the state server is gone the dashboard keeps edits
// in localStorage, says "offline — not saved to disk", and pushes the edits
// once the server answers again. "Stopped" is the real state server resetting
// every connection on its port, the way a launchd restart looks to the page.
import { test, expect } from "../fixtures/dashboard.mjs";
import { JOBS } from "../support/jobs.mjs";

test.describe("offline badge", () => {
  test("a server that goes away mid-session shows the badge and keeps the click", async ({ dashboard, server }) => {
    await expect(dashboard.offlineBadge).toBeHidden();
    await server.stop();
    const sdet = dashboard.card(JOBS.globex.title);

    await sdet.markViewed();

    await expect(dashboard.offlineBadge).toBeVisible();
    await expect(sdet.viewedButton).toHaveAttribute("aria-pressed", "true");
    await expect(dashboard.viewedTab).toHaveText("Viewed 1");
    expect(server.readState()[JOBS.globex.url]).toBeUndefined();
  });

  test("edits made offline reach the disk once the server is back", async ({ dashboard, server }) => {
    await server.stop();
    const sdet = dashboard.card(JOBS.globex.title);
    await sdet.markViewed();
    await sdet.openNote();
    await sdet.writeNote("Written offline");
    await expect(dashboard.offlineBadge).toBeVisible();

    await server.restart();
    await dashboard.reload();

    await expect(dashboard.offlineBadge).toBeHidden();
    await expect.poll(() => server.readState()[JOBS.globex.url]).toMatchObject({ status: "viewed", note: "Written offline" });
    await expect(dashboard.card(JOBS.globex.title).viewedButton).toHaveAttribute("aria-pressed", "true");
  });

  test("a change the server rejects is flagged without going offline", async ({ dashboard, page }) => {
    // No real click can produce a 4xx (the client validates first): stub one.
    await page.route("**/state", (route) =>
      route.request().method() === "POST"
        ? route.fulfill({ status: 400, contentType: "application/json", body: '{"error":"invalid patch"}' })
        : route.fallback());

    await dashboard.card(JOBS.initech.title).markViewed();

    await expect(dashboard.rejectedFlash).toHaveText("not saved — server rejected the change (400)");
    await expect(dashboard.offlineBadge).toBeHidden();
  });
});
