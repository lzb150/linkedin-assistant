// Fixture vacancies for the dashboard e2e suite: one package per board, a
// closed one and a read-only one (non-http url), written as the application
// packages dashboard.mjs reads. Never the real applications/ folder.
import { COVER_START, COVER_END } from "../../lib/frontmatter.mjs";

// buildApplication puts a zero-width space after the # of a heading-like line
// so the letter cannot read as Markdown; Copy letter must strip it again.
const ZWSP = "​";

export const JOBS = {
  acme: {
    source: "dou", title: "Senior QA Automation Engineer", company: "Acme Robotics", location: "Remote",
    url: "https://jobs.example.test/dou/101", score: 45, llm_score: 82, llm_why: "Strong Playwright match",
    matched_skills: "playwright, typescript, ci", cover_language: "en", generated: "2026-10-01T09:00:00.000Z",
    cover: `Hello Acme Robotics team,\n\n#${ZWSP} Why me\nI build Playwright suites that stay green.\n\nBest regards`,
  },
  globex: {
    source: "djinni", title: "SDET", company: "Globex", location: "Kyiv",
    url: "https://jobs.example.test/djinni/202", score: 38,
    matched_skills: "selenium, java", cover_language: "en", generated: "2026-10-02T09:00:00.000Z",
    cover: "Dear Globex hiring team,\n\nI would like to apply for the SDET role.",
  },
  initech: {
    source: "linkedin", title: "QA Engineer", company: "Initech", location: "Remote",
    url: "https://jobs.example.test/linkedin/303", score: 31,
    matched_skills: "cypress, api testing", cover_language: "en", generated: "2026-10-03T09:00:00.000Z",
    cover: "Hi Initech,\n\nYour QA Engineer opening fits my API testing background.",
  },
  umbrella: {
    source: "dou", title: "Manual Tester", company: "Umbrella", location: "Lviv",
    url: "https://jobs.example.test/dou/404", score: 20,
    matched_skills: "manual testing", cover_language: "en", generated: "2026-10-04T09:00:00.000Z",
    cover: "Hello Umbrella,\n\nI am interested in the Manual Tester role.",
  },
  // safeUrl() turns a non-http(s) url into "#": the card renders read-only.
  nowhere: {
    source: "dou", title: "Broken Link QA", company: "Nowhere Ltd", location: "Remote",
    url: "javascript:void(0)", score: 10,
    matched_skills: "exploratory", cover_language: "en", generated: "2026-10-05T09:00:00.000Z",
    cover: "Hello,\n\nThis posting has no usable link.",
  },
};

// Board order of the cards on the page: LLM-scored first, then keyword score.
export const CARD_ORDER = ["acme", "globex", "initech", "umbrella", "nowhere"].map((k) => JOBS[k].title);

// The state every test starts from unless it says otherwise: closed-check
// already marked Umbrella closed, nothing else touched.
export const DEFAULT_STATE = { _meta: {}, [JOBS.umbrella.url]: { status: "closed" } };

// One package file, in the shape buildApplication writes.
export function packageMarkdown({ cover, ...fm }) {
  const front = Object.entries(fm).map(([k, v]) => `${k}: ${v}`).join("\n");
  return `---\n${front}\n---\n# ${fm.title} — ${fm.company}\n\n## Cover note (review before sending — ${fm.cover_language})\n${COVER_START}\n${cover}\n${COVER_END}\n\n## Action\nnone\n`;
}
