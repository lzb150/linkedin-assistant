// Page objects for the jobs dashboard (applications/index.html served by
// state-server.mjs). Locators go through the accessible names the page gives
// its controls (dashboard.mjs header, lib/dashboard-render.mjs cards), so a
// test fails when a screen-reader user would lose a control too. Methods are
// user actions; the specs own every assertion.

// Card names start with the job title and may carry a ", viewed" / ", closed"
// cue or a NEW ribbon after it: match the title as a whole-word prefix.
export const titlePattern = (title) => new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\w)`);

export class JobCard {
  constructor(root) {
    this.root = root;
    this.heading = root.getByRole("heading", { level: 2 });
    this.openJobLink = root.getByRole("link", { name: /^Open job: / });
    this.statusButtons = root.getByRole("group", { name: /^Status — / });
    this.newButton = root.getByRole("button", { name: /^Mark New — / });
    this.viewedButton = root.getByRole("button", { name: /^Mark Viewed — / });
    // <summary> has no ARIA role: its visible label is the stable handle.
    this.coverLetterToggle = root.getByText(/^Cover letter\b/);
    this.copyButton = root.getByRole("button", { name: /^Copy letter/ });
    this.copyStatus = root.getByRole("status");
    this.noteToggle = root.getByText(/^Note\b/);
    this.noteBox = root.getByRole("textbox", { name: /^Private note — / });
    this.noteIndicator = root.getByText("has note");
  }

  async markViewed() { await this.viewedButton.click(); }
  async markNew() { await this.newButton.click(); }
  async openCoverLetter() { await this.coverLetterToggle.click(); }
  async copyLetter() { await this.copyButton.click(); }
  async openNote() { await this.noteToggle.click(); }

  // Opens the posting in a new tab (target=_blank) → the popup page.
  async openJob() {
    const popup = this.root.page().waitForEvent("popup");
    await this.openJobLink.click();
    return popup;
  }

  // Type a note and leave the field: blur is what saves it straight away.
  async writeNote(text) {
    await this.noteBox.fill(text);
    await this.noteBox.blur();
  }

  // Type a note and stay in the field: the client saves it after a pause.
  async typeNote(text) {
    await this.noteBox.fill(text);
  }
}

export class DashboardPage {
  constructor(page, baseUrl) {
    this.page = page;
    this.baseUrl = baseUrl;
    this.header = page.getByRole("banner");
    this.statusTabs = page.getByRole("group", { name: "Filter by status" });
    this.newTab = this.statusTabs.getByRole("button", { name: /^New\b/ });
    this.viewedTab = this.statusTabs.getByRole("button", { name: /^Viewed\b/ });
    this.sourceChips = page.getByRole("group", { name: "Source" });
    this.search = page.getByRole("searchbox", { name: "Search title, company or skills" });
    this.themeToggle = page.getByRole("button", { name: "Dark theme" });
    // sr-only live region: "<n> jobs shown" once the client has rendered.
    this.shownStatus = this.header.getByRole("status");
    // Filtered-out cards are display:none, so these only see the cards on screen.
    this.cards = page.getByRole("article");
    this.cardTitles = this.cards.getByRole("heading", { level: 2 });
    this.offlineBadge = this.header.getByText("offline — not saved to disk");
    this.rejectedFlash = this.header.getByText(/^not saved — server rejected/);
    this.emptyState = page.getByText("No matching jobs yet.");
    this.noMatch = page.getByText("No jobs match these filters.");
    // The theme lives on the document itself: <html data-theme>, body colours.
    this.html = page.locator("html");
    this.body = page.locator("body");
  }

  async goto() {
    await this.page.goto(`${this.baseUrl}/`);
    await this.waitUntilRendered();
  }

  async reload() {
    await this.page.reload();
    await this.waitUntilRendered();
  }

  // The client applies statuses and filters only after its /health + /state
  // round trip; the live region is filled at the end of that pass.
  async waitUntilRendered() {
    await this.shownStatus.filter({ hasText: /jobs shown$/ }).waitFor({ state: "attached" });
  }

  card(title) {
    return new JobCard(this.page.getByRole("article", { name: titlePattern(title) }));
  }

  sourceChip(label) {
    return this.sourceChips.getByRole("button", { name: label, exact: true });
  }

  async toggleNewTab() { await this.newTab.click(); }
  async toggleViewedTab() { await this.viewedTab.click(); }
  async toggleSource(label) { await this.sourceChip(label).click(); }
  async searchFor(text) { await this.search.fill(text); }
  async toggleTheme() { await this.themeToggle.click(); }

  // What the last Copy letter put on the clipboard (needs clipboard-read).
  async clipboardText() {
    return this.page.evaluate(() => navigator.clipboard.readText());
  }
}
