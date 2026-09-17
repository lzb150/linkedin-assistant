// Who the drafts and application packages are written for. Both builders
// (draft.mjs, application.mjs) put the same two values in their output — the
// resume path in the "attach" line, the name in the signature — and each used
// to read the env and spell the fallback itself, so a changed default in one
// file silently disagreed with the other. Set them in your run wrapper
// (run.sh: RESUME_PATH, CANDIDATE_NAME).
export const RESUME_PATH = process.env.RESUME_PATH || "~/Downloads/your-resume.docx";
export const CANDIDATE_NAME = process.env.CANDIDATE_NAME || "Your Name";
