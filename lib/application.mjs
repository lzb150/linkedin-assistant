// Builds an application package for a matched job — for YOU to review and submit.
// Nothing here submits anything.
import { readFileSync } from "node:fs";
import { writeTextAtomic } from "./json-file.mjs";
import { minuteStamp, slug, shortHash } from "./filename.mjs";
import { detectLang } from "./lang.mjs";
import { extractSalary } from "./salary.mjs";
import { fmValue } from "./frontmatter.mjs";
import { profile as skills } from "./relevance.mjs";
import { RESUME_PATH, CANDIDATE_NAME as NAME } from "./candidate.mjs";

// alt_links is a "source|url, source|url" list, so a url carrying the
// separators (or whitespace) would corrupt the line — skip it.
const safeAltField = (v) => typeof v === "string" && v && !/[|,\s]/.test(v);
const safeAltUrl = safeAltField;

// Record another board's link on an existing package (cross-run dedup): append
// "source|url" to the alt_links frontmatter line, creating it when absent.
// Only the alt_links line changes; the rest is written back as read, except
// that a CRLF package comes out LF (the whole file is normalised below so the
// frontmatter matches — parseFrontmatter does the same). Returns false (and
// writes nothing) without frontmatter or when the url is already there.
export function appendAltLink(file, source, url) {
  const md = readFileSync(file, "utf8").replace(/\r\n/g, "\n"); // CRLF packages must still match (parseFrontmatter normalises too)
  const fmBlock = md.match(/^---\n[\s\S]*?\n---/);
  // `source` is guarded like `url`: today the only caller passes a literal
  // ("dou"/"djinni"/"linkedin"), but the function is exported, and a source
  // name that ever came from board text could carry a newline and forge a
  // frontmatter key — the invariant buildApplication keeps with fmValue.
  if (!fmBlock || !safeAltField(source) || !safeAltUrl(url)) return false;
  const existing = fmBlock[0].match(/^alt_links:\s*(.*)$/m);
  // Exact url match, not substring: ".../jobs/1" must not shadow ".../jobs/12".
  const urls = existing ? existing[1].split(",").map((p) => p.trim().split("|").pop()) : [];
  if (urls.includes(url)) return false;
  const pair = `${source}|${url}`;
  const updated = existing
    ? md.replace(/^alt_links:\s*(.*)$/m, (_, rest) => `alt_links: ${rest ? `${rest}, ` : ""}${pair}`)
    : md.replace(/\n---/, `\nalt_links: ${pair}\n---`);
  writeTextAtomic(file, updated);
  return true;
}

// The specialization phrase for the fallback cover letters lives in
// skills.json's profile block — the same file that already defines the
// profession (roles/skills/antiKeywords), parsed once by lib/relevance.mjs.
const SKILLS_PROFILE = skills.profile;

// Legacy phrases double as defaults so a skills.json without a profile block
// keeps producing byte-identical packages.
const DEFAULT_PHRASE = {
  en: "test automation",
  uk: "автоматизації тестування",
  ru: "автоматизации тестирования",
};

export function coverPhrase(profile, lang) {
  const v = profile && typeof profile[lang] === "string" ? profile[lang].trim() : "";
  return v || DEFAULT_PHRASE[lang] || DEFAULT_PHRASE.en;
}

// Cold-application cover note per language. {title}/{company}/{skills} get filled.
const COVER = {
  en: (title, company, skills, spec) =>
    `Hello,\n\nI came across your "${title}"${company ? " role at " + company : " role"} and believe my ` +
    `background is a strong fit. I have solid experience in ${spec}, hands-on with ` +
    `${skills || "the technologies you listed"}. My resume is attached. I'd be glad to discuss further.\n\n` +
    `Best regards,\n${NAME}`,
  uk: (title, company, skills, spec) =>
    `Доброго дня!\n\nПобачив вашу вакансію "${title}"${company ? " у " + company : ""} і вважаю, що мій ` +
    `досвід добре підходить. Маю ґрунтовний досвід в ${spec}, практичний досвід із ` +
    `${skills || "переліченими технологіями"}. Додаю резюме. Буду радий обговорити деталі.\n\n` +
    `З повагою,\n${NAME}`,
  ru: (title, company, skills, spec) =>
    `Добрый день!\n\nУвидел вашу вакансию "${title}"${company ? " в " + company : ""} и считаю, что мой ` +
    `опыт хорошо подходит. Имею основательный опыт в ${spec}, практический опыт с ` +
    `${skills || "перечисленными технологиями"}. Прикладываю резюме. Буду рад обсудить детали.\n\n` +
    `С уважением,\n${NAME}`,
};

// The cover letter is raw model output sitting between two "## " headings that
// the dashboard finds by regex, so a letter containing its own "## Action" cut
// the card short: the .md kept the whole letter, the dashboard (and its "Copy
// letter" button) showed only the part before the fake heading, and a hostile
// posting chose where the cut fell. Two changes close that: explicit delimiters
// the dashboard prefers, and a body that cannot contain either the delimiters or
// a line that reads as a heading.
export const COVER_START = "<!--cover:start-->";
export const COVER_END = "<!--cover:end-->";
// A zero-width space after the #s keeps the text readable while stopping the
// line being a Markdown heading (or matching the dashboard's ^## anchor). It
// stays in the .md; the dashboard's "Copy letter" strips it on the way to the
// clipboard so a pasted letter carries no invisible characters.
const coverBody = (s) =>
  String(s).split(COVER_START).join("").split(COVER_END).join("").replace(/^(#{1,6})(\s)/gm, "$1​$2");

export function buildApplication(job, scored, llm = null) {
  // Every frontmatter value (incl. url/salary) goes through fmValue at the write
  // boundary regardless of which source it came from (raw RSS titles have newlines).
  job = {
    ...job,
    source: fmValue(job.source), title: fmValue(job.title), company: fmValue(job.company),
    location: fmValue(job.location), url: fmValue(job.url),
  };
  const when = new Date().toISOString();
  const lang = detectLang(job.text);
  const skills = scored.matchedSkills.slice(0, 6).join(", ");
  const salary = fmValue(extractSalary((job.text || "").slice(0, 5000)));
  // Raw model output: a non-string (array of paragraphs, number) must fall back, not throw.
  // Capped: the prompt asks for <150 words; the only other bound is the 1 MB stdout buffer.
  const llmCover = typeof llm?.cover === "string" ? llm.cover.trim().slice(0, 4000) : "";
  const cover = llmCover || (COVER[lang] || COVER.en)(job.title, job.company, skills, coverPhrase(SKILLS_PROFILE, lang));

  // The same vacancy may also be listed on other boards (collected by dedupeJobs).
  const altLinks = (job.altLinks || []).filter((a) => safeAltUrl(a.url));
  const altFront = altLinks.length
    ? `\nalt_links: ${altLinks.map((a) => `${fmValue(a.source)}|${a.url}`).join(", ")}`
    : "";

  // LLM verdict, when available (score arrives already rounded by the caller).
  // Frontmatter is line-based, so why + red flags fold into one collapsed
  // line, and an empty verdict text drops the llm_why key entirely.
  const llmWhy = llm
    ? fmValue([String(llm.why || "").trim(), (Array.isArray(llm.red_flags) && llm.red_flags.length) ? "⚠ " + llm.red_flags.map(String).join("; ") : ""]
        .filter(Boolean).join(" "))
    : "";
  // llm_model: which CLI model scored it — models differ by ~27 points on weak fits, so the weekly report keeps them apart.
  const llmModel = typeof llm?.model === "string" && llm.model.trim() ? `\nllm_model: ${fmValue(llm.model)}` : "";
  // llm_suspect: the posting contains text aimed at the screener (see
  // injectionMarkers). It does not change the score — it says the score was
  // produced from text that asked for one, so the reader can weigh it.
  const suspect = llm?.suspect ? `\nllm_suspect: ${fmValue(llm.suspect)}` : "";
  const llmFront = llm ? `\nllm_score: ${fmValue(llm.score)}${llmModel}${suspect}${llmWhy ? `\nllm_why: ${llmWhy}` : ""}` : "";
  // fmValue here too, not just in the frontmatter above: `source` was the one
  // scraped field that reached the BODY raw, and the body is what the dashboard
  // regex-parses. A newline in it could plant an earlier "## Cover note" /
  // "## Action" pair and make the card render attacker-chosen text as the
  // letter. Unreachable today (all three scrapers use string literals), but
  // appendAltLink guards the same field for the same reason.
  const altSection = altLinks.length
    ? `\n## Also listed on\n${altLinks.map((a) => `- [${fmValue(a.source)}] ${a.url}`).join("\n")}\n`
    : "";

  const md = `---
source: ${job.source}
title: ${job.title}
company: ${job.company || "—"}
location: ${job.location || "—"}
url: ${job.url}${altFront}${salary ? `\nsalary: ${salary}` : ""}
generated: ${when}
cover_language: ${lang}
score: ${scored.score}
matched_role: ${fmValue(scored.matchedRole) || "—"}
matched_skills: ${fmValue(scored.matchedSkills.join(", ")) || "—"}
penalties: ${fmValue(scored.penalties.join(", ")) || "—"}${llmFront}
resume: ${fmValue(RESUME_PATH)}
---

# ${job.title} — ${job.company || "?"} (${job.source}, score ${scored.score})

🔗 ${job.url}
${altSection}
## Cover note (review before sending — ${lang})
${COVER_START}
${coverBody(cover)}
${COVER_END}

## Action
- [ ] Reviewed match + cover note
- [ ] Opened the job link
- [ ] Attached resume: \`${RESUME_PATH}\`
- [ ] Applied manually
`;

  const filename = `${minuteStamp(when)}_${slug(`${job.source}_${job.company || job.title}`)}_${shortHash(job.url)}.md`;
  return { filename, markdown: md };
}
