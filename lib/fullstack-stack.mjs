// "Fullstack" vacancies that ask for a backend language the candidate does not
// work in (Java, PHP, Python, Go) are dropped before scoring — a Node.js /
// TypeScript fullstack role is the target. Configured by
// jobs.config.json → excludeFullstackStack; pure, so jobs.mjs only wires it in.
import { reEsc } from "./regex.mjs";

// A fullstack title: full stack / full-stack / fullstack, and the Ukrainian and
// Russian spellings (фулстек, фуллстек, фул-стек, фулстэк).
const FULLSTACK = /full[\s-]?stack|фул+[\s-]?ст[еэ]к/iu;

// Unicode-aware boundaries, like titleExcluder (an ASCII-only \b is wrong next
// to Cyrillic). Digits may follow a term (Java8, Python3, PHP7) but letters may
// not: that is what keeps "java" out of JavaScript and "go" out of Gopher.
const before = "(?<![\\p{L}\\p{N}])";
const after = "(?![\\p{L}])";

// A capitalised term is matched exactly ("Go" is also an English verb); the
// rest case-insensitively. An exact match that opens a sentence or a bullet and
// is followed by a lowercase word ("Go beyond what is asked") is the English
// word, not the language — "Go, Python" and "Go (Golang)" still match there.
const SENTENCE_START = /(?:^|[.!?]\s+|\n\s*[-•*–—]?\s*)$/u;
const LOWERCASE_NEXT = /^\s+\p{Ll}/u;

function ruleFor(term) {
  const exact = term !== term.toLowerCase();
  const re = new RegExp(`${before}${reEsc(term)}${after}`, exact ? "gu" : "giu");
  const matches = (text) => {
    for (const m of text.matchAll(re)) {
      if (!exact) return true;
      const english = SENTENCE_START.test(text.slice(0, m.index)) && LOWERCASE_NEXT.test(text.slice(m.index + term.length));
      if (!english) return true;
    }
    return false;
  };
  return { term, matches };
}

// terms → job → the first dealbreaker term the fullstack vacancy names, or
// undefined (not a fullstack title, or none named). The titles of copies
// dedupeJobs folded in count too, like the title gate. An empty list is off.
export function fullstackStackExcluder(terms = []) {
  const rules = terms.map((t) => String(t).trim()).filter(Boolean).map(ruleFor);
  if (!rules.length) return () => undefined;
  return (job) => {
    const titles = [job.title, ...(job.mergedTitles || [])].filter(Boolean);
    if (!titles.some((t) => FULLSTACK.test(t))) return undefined;
    const text = [...titles, job.text || ""].join("\n");
    return rules.find((r) => r.matches(text))?.term;
  };
}
