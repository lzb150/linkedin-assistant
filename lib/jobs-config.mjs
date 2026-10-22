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
// and every source list holds only entries the source can search. A numeric
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
const KNOWN_LLM = new Set(["enabled", "model", "maxPerRun", "concurrency", "minScore"]);
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

  const unknownIn = (obj, known) => Object.keys(obj || {}).filter((k) => !k.startsWith("_") && !known.has(k));
  for (const k of unknownIn(config, KNOWN_TOP)) log(`⚠ config: unknown top-level key "${k}" — ignored (misspelt? known keys: ${[...KNOWN_TOP].join(", ")})`);
  for (const [name, known] of [["llm", KNOWN_LLM], ...Object.entries(KNOWN_SOURCE)]) {
    for (const k of unknownIn(config[name], known)) log(`⚠ config: unknown ${name}.${k} — ignored (misspelt? known keys: ${[...known].join(", ")})`);
  }

  const llm = config.llm || {};
  const minScore = knob("minScore", config.minScore, 25, undefined, log);
  return {
    config,
    minScore,
    // A source may set its own minScore — it overrides the global.
    sourceMinScore: Object.fromEntries(SOURCES.map((s) => [s, knob(`${s}.minScore`, config[s]?.minScore, minScore, undefined, log)])),
    llmMinScore: knob("llm.minScore", llm.minScore, 0, [0, 100], log),                 // 0 = advisory-only, as when unset
    llmMaxPerRun: knob("llm.maxPerRun", llm.maxPerRun, 15, [1, Infinity], log),       // 0 must not mean "defer everything forever"
    llmConcurrency: knob("llm.concurrency", llm.concurrency, 3, [1, Infinity], log),  // 0 must not mean zero workers (every verdict empty, gate bypassed)
    // Normalized once so the two gates that read it — the Djinni country filter
    // and the LLM prompt — can never disagree (an empty/typo'd candidateCountry
    // used to leave the filter rejecting everything while the prompt still said Ukraine).
    candidateCountry: candidateCountryList(config.candidateCountry),
    // Remote boards set to `worldwide: false`: only jobs that name candidateCountry.
    countryOnly: new Set(["himalayas", "tgchannels"].filter((s) => config[s]?.worldwide === false)),
  };
}
