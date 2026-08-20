// LLM helper over the local Claude CLI (`claude -p`). No API key — reuses the
// user's existing Claude Code install. Every failure (CLI missing, non-zero
// exit, timeout, unparseable output) resolves to null so callers degrade to
// the keyword-only pipeline. Never throws.
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";

// Pull the first {...} block out of possibly-noisy CLI output and parse it.
export function extractJSON(text) {
  const m = (text || "").match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// `exec` is injectable for tests.
export function llmJSON(prompt, { model = "haiku", exec = execFile } = {}) {
  return new Promise((resolve) => {
    try {
      // `prompt` embeds untrusted job-board text (buildJobPrompt). A hostile
      // posting could try to get the model to read local files — the child
      // must not be able to touch the repo, which holds logged-in LinkedIn
      // cookies under .browser-profile/. Disallow all tools and run from a
      // throwaway cwd as defense in depth.
      // NOTE: this must stay a --disallowedTools blocklist. --tools "" and
      // --tools none are silently ignored by the CLI (verified behaviorally:
      // with them the model still read /etc/hosts), so an "allowlist"
      // migration would actually remove the protection.
      exec(
        "claude",
        ["-p", prompt, "--model", model, "--disallowedTools", "Read,Glob,Grep,Bash,WebFetch,WebSearch,Write,Edit,MultiEdit,NotebookEdit,Task,Agent"],
        { timeout: 60_000, maxBuffer: 1024 * 1024, cwd: tmpdir() },
        (err, stdout) => resolve(err ? null : extractJSON(String(stdout))),
      );
    } catch { resolve(null); }
  });
}

// One prompt per matched job: fit score + one-line why + red flags + tailored
// cover letter, all in a single CLI call (half the cost of two calls).
const LANG_NAME = { en: "English", uk: "Ukrainian", ru: "Russian" };
export function buildJobPrompt(resume, job, lang) {
  return `You are screening job vacancies for one specific candidate.

CANDIDATE RESUME:
${resume}

VACANCY:
Title: ${job.title}
Company: ${job.company || "unknown"}
Location: ${job.location || "unknown"}
Description:
${(job.text || "").slice(0, 6000)}

Tasks:
1. Rate the candidate's fit for this vacancy from 0 (no fit) to 100 (perfect fit).
2. Explain the rating in ONE short sentence.
3. List concrete red flags for this candidate, if any (empty array if none).
4. Write a short cover letter (under 150 words, first person, no filler,
   grounded ONLY in facts present in the resume) in ${LANG_NAME[lang] || "English"}.

Respond with JSON only, no markdown fences:
{"score": <0-100>, "why": "<one sentence>", "red_flags": ["<flag>"], "cover": "<letter>"}`;
}
