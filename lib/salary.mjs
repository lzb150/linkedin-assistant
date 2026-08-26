// Number: digits with optional comma or space thousands separators, optional k suffix.
// Matches: 3000  3,000  3 000  3k  5k — but never ends on a separator comma
// ("$2800–3500, remote" must yield "$2800–3500", not "$2800–3500,").
// Bounded and unambiguous on purpose: the old `\d(?:[\d,]*\d)?` nested
// quantifier backtracked super-linearly on long digit/comma runs. Every part
// here has one way to match, and `(?!\d)` keeps a number from being accepted
// short of its end ("$2800–350" for "$2800–3500").
const N = String.raw`\d{1,7}(?:[,\s]\d{3}){0,2}(?!\d)k?`;
const C = String.raw`[$€£₴]`;           // currency symbol
const CW = String.raw`(?:USD|EUR|UAH|GBP)`;  // currency word
const RS = String.raw`(?:\s*\/\s*(?:month|mo|hour|hr|місяць|мо))?`;  // rate suffix (longer alts first)

// Group 1: range — $3,000–$5,000 / $3k–5k / 3000–5000 USD / €3 000 – €5 000
const RANGE = new RegExp(
  `(?:${C}${N}\\s*[-–—]\\s*${C}?${N}(?:\\s+${CW})?|${N}\\s*[-–—]\\s*${N}\\s+${CW})${RS}`,
  "i"
);

// Group 2: ceiling — up to $4,000 / до $5 000 / не більше $4k
const CEILING = new RegExp(
  `(?:up\\s+to|до|не\\s+більше)\\s+(?:${C}${N}|${N}\\s+${CW})${RS}`,
  "i"
);

// Group 3: single value — $4,000/month / $25/hr / 4000 USD
const SINGLE = new RegExp(
  `${C}${N}\\s*\\/\\s*(?:month|mo|hour|hr|місяць|мо)|${N}\\s+${CW}`,
  "i"
);

export function extractSalary(text) {
  if (!text) return null;
  for (const re of [RANGE, CEILING, SINGLE]) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
}
