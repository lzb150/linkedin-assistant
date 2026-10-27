// jobs.config.json → one normalized object, so jobs.mjs (and dashboard.mjs,
// which reads candidateCountry) never see a raw hand-edited file.
//
//   parseJobsConfig(text)              JSON text → object; throws (SyntaxError, "not a JSON object")
//   readJobsConfig(file)               the file → object, same throws plus ENOENT
//   normalizeJobsConfig(config, {log}) coerces flags and lists IN PLACE, reports misspelt keys,
//                                      and returns every derived knob the run needs
//
// Every on/off switch is normalized once, here, so jobs.mjs and the sources
// that read their own section see real booleans (see flag() in lib/filters.mjs),
// and every list (the sources' own and the top-level excludeTitle /
// excludeLocation / candidateCountry) holds only entries a reader can use. A numeric
// knob that is not a number used to switch its gate off silently
// (`score < "abc"` is false for every score): it falls back to the default
// and says so once, in the run's log.
import { readFileSync } from "node:fs";
import { candidateCountryList, knob, flag, sourceList, isHttpUrl, isSearchPhrase, isChannelName, isLinkedInSearch } from "./filters.mjs";

export const SOURCES = ["dou", "djinni", "himalayas", "tgchannels", "linkedin"];

// A misspelt key is not a no-op, it is a silently different run: "llm" typo'd
// turns the whole LLM gate off (every keyword-passer gets a package) and a
// typo'd source name drops that source entirely — both with a clean log. Names
// we do not recognise are therefore reported rather than ignored. `_`-prefixed
// keys are the documentation blocks the shipped config is full of.
const KNOWN_TOP = new Set(["minScore", "requireRole", "candidateCountry", "excludeTitle", "excludeLocation", "llm", ...SOURCES]);
const KNOWN_LLM = new Set(["enabled", "model", "maxPerRun", "concurrency", "minScore", "timeoutSec", "borderlineMin"]);
// Per-source keys: `djinni.serches` drops every Djinni search just as quietly.
const KNOWN_SOURCE = {
  dou: new Set(["enabled", "minScore", "feeds"]),
  djinni: new Set(["enabled", "minScore", "searches", "maxResults", "pages", "concurrency", "fullDescription"]),
  himalayas: new Set(["enabled", "minScore", "searches", "pages", "worldwide"]),
  tgchannels: new Set(["enabled", "minScore", "channels", "pages", "fullDescription", "worldwide"]),
  linkedin: new Set(["enabled", "minScore", "searches", "maxResults"]),
};

// [section, key, default]: DOU is on unless switched off, everything else off unless switched on.
const FLAGS = [
  ["llm", "enabled", false], ["dou", "enabled", true],
  ["djinni", "enabled", false], ["djinni", "fullDescription", true],
  ["himalayas", "enabled", false], ["himalayas", "worldwide", true],
  ["tgchannels", "enabled", false], ["tgchannels", "fullDescription", true], ["tgchannels", "worldwide", true],
  ["linkedin", "enabled", false],
];
// [section, key, validator, what a valid entry is called in the log]
const LISTS = [
  ["dou", "feeds", isHttpUrl, "a feed URL"],
  ["djinni", "searches", isHttpUrl, "a search URL"],
  ["himalayas", "searches", isSearchPhrase, "a search phrase"],
  ["tgchannels", "channels", isChannelName, "a public channel name"],
  ["linkedin", "searches", isLinkedInSearch, '{ "keywords": "…" }'],
];
// The top-level string lists. lib/filters.mjs already degrades a bare string
// ("excludeTitle": "junior") to [] / the default country so the run survives —
// but silently, so the typo'd exclude never took effect and nothing said so.
const TOP_LISTS = ["excludeTitle", "excludeLocation", "candidateCountry"];
const isNonBlankString = (v) => typeof v === "string" && v.trim() !== "";
const DEFAULT_MODEL = "sonnet";

export function parseJobsConfig(text) {
  const config = JSON.parse(text);
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("not a JSON object");
  return config;
}

export const readJobsConfig = (file) => parseJobsConfig(readFileSync(file, "utf8"));

export function normalizeJobsConfig(config, { log = console.log } = {}) {
  const section = (name) => (config[name] && typeof config[name] === "object" ? config[name] : null);
  config.requireRole = flag("requireRole", config.requireRole, false, log);
  for (const [name, key, fallback] of FLAGS) {
    const sec = section(name);
    if (sec && key in sec) sec[key] = flag(`${name}.${key}`, sec[key], fallback, log);
  }
  for (const [name, key, valid, want] of LISTS) {
    const sec = section(name);
    if (sec && key in sec) sec[key] = sourceList(`${name}.${key}`, sec[key], valid, want, log);
  }
  for (const key of TOP_LISTS) {
    if (key in config) config[key] = sourceList(key, config[key], isNonBlankString, "a string", log);
  }

  const unknownIn = (obj, known) => Object.keys(obj || {}).filter((k) => !k.startsWith("_") && !known.has(k));
  for (const k of unknownIn(config, KNOWN_TOP)) log(`⚠ config: unknown top-level key "${k}" — ignored (misspelt? known keys: ${[...KNOWN_TOP].join(", ")})`);
  for (const [name, known] of [["llm", KNOWN_LLM], ...Object.entries(KNOWN_SOURCE)]) {
    for (const k of unknownIn(config[name], known)) log(`⚠ config: unknown ${name}.${k} — ignored (misspelt? known keys: ${[...known].join(", ")})`);
  }

  const llm = config.llm || {};
  const minScore = knob("minScore", config.minScore, 25, undefined, log);
  // llm.model goes straight into the CLI's argv (`--model <x>`): a number or an
  // object there used to reach execFile unchecked. A non-empty string passes,
  // anything else is the default — reported, like the numeric knobs.
  let llmModel = DEFAULT_MODEL;
  if (isNonBlankString(llm.model)) llmModel = llm.model.trim();
  else if (llm.model != null) log(`⚠ jobs.config.json: llm.model is ${JSON.stringify(llm.model)}, not a model name — using ${DEFAULT_MODEL}`);
  return {
    config,
    minScore,
    llmModel,
    // A source may set its own minScore — it overrides the global.
    sourceMinScore: Object.fromEntries(SOURCES.map((s) => [s, knob(`${s}.minScore`, config[s]?.minScore, minScore, undefined, log)])),
    llmMinScore: knob("llm.minScore", llm.minScore, 0, [0, 100], log),                 // 0 = advisory-only, as when unset
    // Verdicts in [borderlineMin, minScore) are not dropped but written as
    // `tier: borderline` packages — a muted third tab on the dashboard. 40 of
    // the 93 LLM rejects in a fortnight scored 50–69, and the same vacancy
    // scored 80 via one board and 68 via another, so the cutoff is ±12 noisy.
    // 0 (or anything at/above minScore) turns the band off.
    llmBorderlineMin: knob("llm.borderlineMin", llm.borderlineMin, 50, [0, 100], log),
    llmMaxPerRun: knob("llm.maxPerRun", llm.maxPerRun, 15, [1, Infinity], log),       // 0 must not mean "defer everything forever"
    llmConcurrency: knob("llm.concurrency", llm.concurrency, 3, [1, Infinity], log),  // 0 must not mean zero workers (every verdict empty, gate bypassed)
    // Seconds in the file (what a human tunes), ms for the wrapper. 30 s is the
    // floor: a real verdict takes ~20 s on sonnet, so anything lower times out
    // every call and quietly turns the gate into keyword-only packages.
    llmTimeoutMs: knob("llm.timeoutSec", llm.timeoutSec, 60, [30, 1800], log) * 1000,
    // Normalized once so the two gates that read it — the Djinni country filter
    // and the LLM prompt — can never disagree (an empty/typo'd candidateCountry
    // used to leave the filter rejecting everything while the prompt still said Ukraine).
    candidateCountry: candidateCountryList(config.candidateCountry),
    // Remote boards set to `worldwide: false`: only jobs that name candidateCountry.
    countryOnly: new Set(["himalayas", "tgchannels"].filter((s) => config[s]?.worldwide === false)),
  };
}
