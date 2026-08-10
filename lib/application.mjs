// Builds an application package for a matched job — for YOU to review and submit.
// Nothing here submits anything.
import { readFileSync, writeFileSync } from "node:fs";
import { detectLang } from "./lang.mjs";
import { extractSalary } from "./salary.mjs";

// Record another board's link on an existing package (cross-run dedup): append
// "source|url" to the alt_links frontmatter line, creating it when absent.
// Only the frontmatter line changes — the body stays byte-identical. Returns
// false (and writes nothing) without frontmatter or when the url is already there.
export function appendAltLink(file, source, url) {
  const md = readFileSync(file, "utf8");
  const fmBlock = md.match(/^---\n[\s\S]*?\n---/);
  if (!fmBlock || fmBlock[0].includes(url)) return false;
  const pair = `${source}|${url}`;
  const updated = /^alt_links:/m.test(fmBlock[0])
    ? md.replace(/^alt_links:\s*(.*)$/m, (_, rest) => `alt_links: ${rest ? `${rest}, ` : ""}${pair}`)
    : md.replace(/\n---/, `\nalt_links: ${pair}\n---`);
  writeFileSync(file, updated);
  return true;
}

// The specialization phrase for the fallback cover letters lives in
// skills.json's profile block — the same file that already defines the
// profession (roles/skills/antiKeywords). Loaded once, like lib/relevance.mjs.
const SKILLS_PROFILE = JSON.parse(
  readFileSync(new URL("../skills.json", import.meta.url), "utf8"),
).profile;

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

const RESUME_PATH = process.env.RESUME_PATH || "~/Downloads/your-resume.docx";
// Your name for the cover-note signature. Set CANDIDATE_NAME in your run wrapper.
const NAME = process.env.CANDIDATE_NAME || "Your Name";

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

export function buildApplication(job, scored, llm = null) {
  const when = new Date().toISOString();
  const lang = detectLang(job.text);
  const skills = scored.matchedSkills.slice(0, 6).join(", ");
  const salary = extractSalary(job.text);
  const llmCover = (llm?.cover || "").trim();
  const cover = llmCover || (COVER[lang] || COVER.en)(job.title, job.company, skills, coverPhrase(SKILLS_PROFILE, lang));

  // The same vacancy may also be listed on other boards (collected by dedupeJobs).
  const altLinks = job.altLinks || [];
  const altFront = altLinks.length
    ? `\nalt_links: ${altLinks.map((a) => `${a.source}|${a.url}`).join(", ")}`
    : "";

  // LLM verdict, when available (score arrives already rounded by the caller).
  // Frontmatter is line-based, so why + red flags fold into one collapsed
  // line, and an empty verdict text drops the llm_why key entirely.
  const llmWhy = llm
    ? [String(llm.why || "").trim(), (llm.red_flags || []).length ? "⚠ " + llm.red_flags.join("; ") : ""]
        .filter(Boolean).join(" ").replace(/\s+/g, " ")
    : "";
  const llmFront = llm ? `\nllm_score: ${llm.score}${llmWhy ? `\nllm_why: ${llmWhy}` : ""}` : "";
  const altSection = altLinks.length
    ? `\n## Also listed on\n${altLinks.map((a) => `- [${a.source}] ${a.url}`).join("\n")}\n`
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
matched_role: ${scored.matchedRole || "—"}
matched_skills: ${scored.matchedSkills.join(", ") || "—"}
penalties: ${scored.penalties.join(", ") || "—"}${llmFront}
resume: ${RESUME_PATH}
---

# ${job.title} — ${job.company || "?"} (${job.source}, score ${scored.score})

🔗 ${job.url}
${altSection}
## Cover note (review before sending — ${lang})
${cover}

## Action
- [ ] Reviewed match + cover note
- [ ] Opened the job link
- [ ] Attached resume: \`${RESUME_PATH}\`
- [ ] Applied manually
`;

  const safe = `${job.source}_${(job.company || job.title)}`.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
  // short stable hash of the url so two jobs at the same company never collide
  let h = 0;
  for (const ch of job.url) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const tail = h.toString(36).slice(0, 6);
  const stamp = when.slice(0, 16).replace(/[:T]/g, "");
  return { filename: `${stamp}_${safe}_${tail}.md`, markdown: md };
}
