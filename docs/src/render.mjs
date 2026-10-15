#!/usr/bin/env node
// Renders the README images in docs/ from the HTML sources next to this file:
//   node docs/src/render.mjs            all of them
//   node docs/src/render.mjs scoring    only names containing "scoring"
// Needs the Playwright Chromium (npx playwright install chromium) and the
// network for Google Fonts; every image is shot at 2x.
import { chromium } from "playwright";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const docs = path.resolve(here, "..");

// [output, source, query, colour scheme, viewport width, selector to clip to (none = full page)]
const SHOTS = [
  ["banner.png", "banner.html", "", "dark", 960, ".banner"],
  ["banner.uk.png", "banner.html", "?lang=uk", "dark", 960, ".banner"],
  ["scoring-dark.png", "scoring.en.html", "", "dark", 1000],
  ["scoring-light.png", "scoring.en.html", "", "light", 1000],
  ["scoring-dark.uk.png", "scoring.uk.html", "", "dark", 1000],
  ["scoring-light.uk.png", "scoring.uk.html", "", "light", 1000],
  ["draft.png", "draft.html", "", "dark", 1000, ".window"],
];

const only = process.argv[2];
const browser = await chromium.launch();
try {
  for (const [out, src, query, scheme, width, clip] of SHOTS) {
    if (only && !out.includes(only)) continue;
    const page = await browser.newPage({ viewport: { width, height: 800 }, deviceScaleFactor: 2, colorScheme: scheme });
    await page.goto(pathToFileURL(path.join(here, src)).href + query, { waitUntil: "networkidle" });
    await page.evaluate(() => document.fonts.ready);
    const file = path.join(docs, out);
    if (clip) await page.locator(clip).screenshot({ path: file, omitBackground: true });
    else await page.screenshot({ path: file, fullPage: true });
    await page.close();
    console.log(`wrote docs/${out}`);
  }
} finally {
  await browser.close();
}
