// Builds an application package for a matched job — for YOU to review and submit.
// Nothing here submits anything.
import { detectLang } from "./lang.mjs";

const RESUME_PATH = process.env.RESUME_PATH || "~/Downloads/your-resume.docx";
// Your name for the cover-note signature. Set CANDIDATE_NAME in your run wrapper.
const NAME = process.env.CANDIDATE_NAME || "Your Name";

// Cold-application cover note per language. {title}/{company}/{skills} get filled.
const COVER = {
  en: (title, company, skills) =>
    `Hello,\n\nI came across your "${title}"${company ? " role at " + company : " role"} and believe my ` +
    `background is a strong fit. I have solid experience in test automation, hands-on with ` +
    `${skills || "the technologies you listed"}. My resume is attached. I'd be glad to discuss further.\n\n` +
    `Best regards,\n${NAME}`,
  uk: (title, company, skills) =>
    `Доброго дня!\n\nПобачив вашу вакансію "${title}"${company ? " у " + company : ""} і вважаю, що мій ` +
    `досвід добре підходить. Маю ґрунтовний досвід в автоматизації тестування, практичний досвід із ` +
    `${skills || "переліченими технологіями"}. Додаю резюме. Буду радий обговорити деталі.\n\n` +
    `З повагою,\n${NAME}`,
  ru: (title, company, skills) =>
    `Добрый день!\n\nУвидел вашу вакансию "${title}"${company ? " в " + company : ""} и считаю, что мой ` +
    `опыт хорошо подходит. Имею основательный опыт в автоматизации тестирования, практический опыт с ` +
    `${skills || "перечисленными технологиями"}. Прикладываю резюме. Буду рад обсудить детали.\n\n` +
    `С уважением,\n${NAME}`,
};

export function buildApplication(job, scored) {
  const when = new Date().toISOString();
  const lang = detectLang(job.text);
  const skills = scored.matchedSkills.slice(0, 6).join(", ");
  const cover = (COVER[lang] || COVER.en)(job.title, job.company, skills);

  // The same vacancy may also be listed on other boards (collected by dedupeJobs).
  const altLinks = job.altLinks || [];
  const altFront = altLinks.length
    ? `\nalt_links: ${altLinks.map((a) => `${a.source}|${a.url}`).join(", ")}`
    : "";
  const altSection = altLinks.length
    ? `\n## Also listed on\n${altLinks.map((a) => `- [${a.source}] ${a.url}`).join("\n")}\n`
    : "";

  const md = `---
source: ${job.source}
title: ${job.title}
company: ${job.company || "—"}
location: ${job.location || "—"}
url: ${job.url}${altFront}
generated: ${when}
cover_language: ${lang}
score: ${scored.score}
matched_role: ${scored.matchedRole || "—"}
matched_skills: ${scored.matchedSkills.join(", ") || "—"}
penalties: ${scored.penalties.join(", ") || "—"}
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
