// Builds a per-thread draft reply for YOU to review and send manually.
// Nothing here sends anything.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));

let RESUME_PATH = "~/Downloads/your-resume.docx";
try {
  // allow override via env
  if (process.env.RESUME_PATH) RESUME_PATH = process.env.RESUME_PATH;
} catch {}

// Your name for the reply signature. Set CANDIDATE_NAME in your run wrapper.
const NAME = process.env.CANDIDATE_NAME || "Your Name";

function topSkills(matchedSkills, n = 5) {
  return matchedSkills.slice(0, n).join(", ");
}

// Detect the language of the recruiter's message so we can reply in kind.
// Returns "uk" (Ukrainian), "ru" (Russian) or "en" (default / Latin).
function detectLang(text) {
  const t = (text || "").toLowerCase();
  const hasCyrillic = /[Ѐ-ӿ]/.test(t);
  if (!hasCyrillic) return "en";
  // Ukrainian-specific letters that don't exist in Russian.
  if (/[іїєґ]/.test(t)) return "uk";
  // Russian-specific letters that don't exist in Ukrainian.
  if (/[ыэъё]/.test(t)) return "ru";
  // Cyrillic but ambiguous — lean Ukrainian (most of your recruiters write UA).
  return "uk";
}

// Reply templates per language and verdict. {name} and {skills} get filled in.
const TEMPLATES = {
  en: {
    relevant: (name, skills) =>
      `Hi ${name},\n\nThanks for reaching out — this looks like a strong match for my background. ` +
      `I have hands-on experience with ${skills || "the core technologies you mentioned"}, ` +
      `and I'd be glad to take this forward. I've attached my resume for the details. ` +
      `Happy to set up a call at your convenience.\n\nBest regards,\n${NAME}`,
    maybe: (name) =>
      `Hi ${name},\n\nThanks for the message. Could you share a bit more about the role ` +
      `(tech stack, automation scope, engagement type and rate)? I want to make sure it's a good fit before we proceed.\n\nBest regards,\n${NAME}`,
  },
  ru: {
    relevant: (name, skills) =>
      `Привет, ${name}!\n\nСпасибо, что написали — выглядит как хорошее совпадение с моим опытом. ` +
      `У меня есть практический опыт с ${skills || "перечисленными технологиями"}, ` +
      `и я был бы рад продолжить общение. Прикладываю резюме с деталями. ` +
      `Готов созвониться в удобное для вас время.\n\nС уважением,\n${NAME}`,
    maybe: (name) =>
      `Привет, ${name}!\n\nСпасибо за сообщение. Могли бы вы рассказать подробнее о позиции ` +
      `(стек, объём автоматизации, формат сотрудничества и ставка)? Хочу убедиться, что это хороший мэтч, прежде чем двигаться дальше.\n\nС уважением,\n${NAME}`,
  },
  uk: {
    relevant: (name, skills) =>
      `Привіт, ${name}!\n\nДякую, що написали — виглядає як гарний збіг з моїм досвідом. ` +
      `Маю практичний досвід із ${skills || "переліченими технологіями"}, ` +
      `і був би радий продовжити спілкування. Додаю резюме з деталями. ` +
      `Готовий до дзвінка у зручний для вас час.\n\nЗ повагою,\n${NAME}`,
    maybe: (name) =>
      `Привіт, ${name}!\n\nДякую за повідомлення. Чи могли б ви розповісти більше про позицію ` +
      `(стек, обсяг автоматизації, формат співпраці та ставка)? Хочу переконатися, що це гарний збіг, перш ніж рухатися далі.\n\nЗ повагою,\n${NAME}`,
  },
};

/**
 * @param thread { name, url, snippet, fullText }
 * @param scored result from scoreMessage()
 * @returns { filename, markdown }
 */
export function buildDraft(thread, scored) {
  const when = new Date().toISOString();
  const attach = scored.verdict === "relevant";
  const skills = topSkills(scored.matchedSkills);

  // Reply in the language of their message.
  const lang = detectLang(thread.fullText || thread.snippet);
  const tpl = TEMPLATES[lang] || TEMPLATES.en;
  const name = firstName(thread.name);
  const replyBody =
    scored.verdict === "relevant" ? tpl.relevant(name, skills) : tpl.maybe(name);

  const md = `---
thread: ${thread.name}
url: ${thread.url || "(open from LinkedIn messaging)"}
generated: ${when}
reply_language: ${lang}
verdict: ${scored.verdict}
score: ${scored.score}
matched_role: ${scored.matchedRole || "—"}
matched_skills: ${scored.matchedSkills.join(", ") || "—"}
penalties: ${scored.penalties.join(", ") || "—"}
attach_resume: ${attach ? "YES — " + RESUME_PATH : "no (ask for details first)"}
---

# ${thread.name} — ${scored.verdict.toUpperCase()} (score ${scored.score})

## Their message
> ${(thread.fullText || thread.snippet || "").replace(/\n/g, "\n> ")}

## Suggested reply (review before sending)
${replyBody}

## Action
- [ ] Reviewed reply
${attach ? `- [ ] Attach resume: \`${RESUME_PATH}\`` : "- [ ] Decide whether to attach resume"}
- [ ] Sent manually on LinkedIn
`;

  const safeName = thread.name.replace(/[^a-z0-9]+/gi, "_").slice(0, 40);
  const stamp = when.slice(0, 16).replace(/[:T]/g, "");
  return { filename: `${stamp}_${scored.verdict}_${safeName}.md`, markdown: md };
}

function firstName(full) {
  return (full || "there").trim().split(/\s+/)[0] || "there";
}
