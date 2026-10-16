// The Dark toggle: follows the system preference until pressed, then pins the
// theme on <html data-theme> and in localStorage, re-applied before paint.
import { test, expect } from "../fixtures/dashboard.mjs";

// --bg in dashboard.mjs: light-dark(#eeecf5, #07060d).
const LIGHT_BG = "rgb(238, 236, 245)";
const DARK_BG = "rgb(7, 6, 13)";

test.describe("Dark toggle", () => {
  test.describe("on a light system", () => {
    test.use({ colorScheme: "light" });

    test("starts unpressed on the light theme", async ({ dashboard }) => {
      await expect(dashboard.themeToggle).toHaveAttribute("aria-pressed", "false");
      await expect(dashboard.themeToggle).toHaveText("Dark");
      await expect(dashboard.body).toHaveCSS("background-color", LIGHT_BG);
    });

    test("pressing it pins the dark theme across a reload", async ({ dashboard }) => {
      await dashboard.toggleTheme();

      await expect(dashboard.themeToggle).toHaveAttribute("aria-pressed", "true");
      await expect(dashboard.html).toHaveAttribute("data-theme", "dark");
      await expect(dashboard.body).toHaveCSS("background-color", DARK_BG);

      await dashboard.reload();

      await expect(dashboard.themeToggle).toHaveAttribute("aria-pressed", "true");
      await expect(dashboard.body).toHaveCSS("background-color", DARK_BG);
    });

    test("pressing it twice pins light again", async ({ dashboard }) => {
      await dashboard.toggleTheme();
      await dashboard.toggleTheme();

      await expect(dashboard.themeToggle).toHaveAttribute("aria-pressed", "false");
      await expect(dashboard.html).toHaveAttribute("data-theme", "light");
      await expect(dashboard.body).toHaveCSS("background-color", LIGHT_BG);
    });
  });

  test.describe("on a dark system", () => {
    test.use({ colorScheme: "dark" });

    test("starts pressed on the dark theme, and pressing it pins light", async ({ dashboard }) => {
      await expect(dashboard.themeToggle).toHaveAttribute("aria-pressed", "true");
      await expect(dashboard.body).toHaveCSS("background-color", DARK_BG);

      await dashboard.toggleTheme();

      await expect(dashboard.themeToggle).toHaveAttribute("aria-pressed", "false");
      await expect(dashboard.html).toHaveAttribute("data-theme", "light");
      await expect(dashboard.body).toHaveCSS("background-color", LIGHT_BG);
    });
  });
});
