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
// Right-hand operand of a range. A bare `N` let any digit close the range:
// "Вилка $3000 – 5 років досвіду" yielded the salary "$3000 – 5". To be the
// upper bound a number must carry a currency, a k suffix, or enough digits to
// be money on its own (3+, or a thousands group).
const NK = String.raw`\d{1,7}(?:[,\s]\d{3}){0,2}(?!\d)k`;
const N3 = String.raw`(?:\d{1,7}(?:[,\s]\d{3}){1,2}(?!\d)|\d{3,7}(?!\d))`;

// Group 1: range — $3,000–$5,000 / $3k–5k / 3000–5000 USD / €3 000 – €5 000
const RANGE = new RegExp(
  `(?:${C}${N}\\s*[-–—]\\s*(?:${C}${N}|${NK}|${N3})(?:\\s+${CW})?|${N}\\s*[-–—]\\s*(?:${NK}|${N3})\\s+${CW})${RS}`,
  "i"
);

// JS \b is ASCII-only, so it gives no left boundary to a Cyrillic keyword:
// "до" matched inside "щодо" ("regarding"), and "щодо $5000/month" produced the
// salary "до $5000/month". A Unicode-aware lookbehind is the boundary — the `u`
// flag makes \p{L} available and \/ stays a legal identity escape under it.
const NOT_WORD_LEFT = String.raw`(?<![\p{L}\p{N}])`;

// Group 1b: the UA range form, which has no dash — "від 3000 до 5000 USD".
// RANGE below only knows dashed ranges, so this used to fall through to CEILING
// and report the upper bound alone, silently dropping the floor. Tried before
// CEILING for exactly that reason.
// Same money rule as RANGE, branch for branch: "від X до Y" is also how postings
// phrase experience ("від 3 до 5 років"), team size and hours, and a bare N on
// both sides matched them — then, running first, shadowed the real salary in
// the same text. A currency symbol on the left lets the right be C N / k / 3+
// digits; a bare left needs a right of k or 3+ digits AND a currency word.
const UA_RANGE = new RegExp(
  `${NOT_WORD_LEFT}від\\s+(?:${C}${N}(?:\\s+${CW})?\\s*до\\s+(?:${C}${N}|${NK}|${N3})(?:\\s+${CW})?|${N}(?:\\s+${CW})?\\s*до\\s+(?:${NK}|${N3})\\s+${CW})${RS}`,
  "iu"
);

// Group 2: ceiling — up to $4,000 / до $5 000 / не більше $4k
const CEILING = new RegExp(
  `${NOT_WORD_LEFT}(?:up\\s+to|до|не\\s+більше)\\s+(?:${C}${N}|${N}\\s+${CW})${RS}`,
  "iu"
);

// Group 3: single value — $4,000/month / $25/hr / 4000 USD
const SINGLE = new RegExp(
  `${C}${N}\\s*\\/\\s*(?:month|mo|hour|hr|місяць|мо)|${N}\\s+${CW}`,
  "i"
);

export function extractSalary(text) {
  if (!text) return null;
  for (const re of [RANGE, UA_RANGE, CEILING, SINGLE]) {
    const m = re.exec(text);
    if (m) return m[0].trim();
  }
  return null;
}
