// Builds a single self-contained HTML dashboard of all application packages
// in applications/, sorted by score. Run:  node dashboard.mjs [--open]
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dir = dirname(fileURLToPath(import.meta.url));
const APPS = join(__dir, "applications");
const OUT = join(APPS, "index.html");

function parse(md) {
  const fm = {};
  const m = md.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  for (const line of m[1].split("\n")) {
    const i = line.indexOf(":");
    if (i === -1) continue;
    fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  // cover note = text between "## Cover note" and "## Action"
  const cover = (m[2].match(/## Cover note[^\n]*\n([\s\S]*?)\n## Action/) || [])[1] || "";
  return { fm, cover: cover.trim() };
}

const esc = (s) =>
  (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const files = readdirSync(APPS).filter((f) => f.endsWith(".md"));
const items = files
  .map((f) => parse(readFileSync(join(APPS, f), "utf8")))
  .filter(Boolean)
  .map((x) => ({ ...x, score: parseInt(x.fm.score || "0", 10) }))
  .sort((a, b) => b.score - a.score);

function scoreColor(s) {
  if (s >= 40) return "#1a7f37";   // green
  if (s >= 30) return "#9a6700";   // amber
  return "#6e7781";                 // gray
}

function badge(source) {
  const c = source === "linkedin" ? "#0a66c2" : "#e8453c";
  return `<span class="src" style="background:${c}">${esc(source)}</span>`;
}

const cards = items
  .map((it, idx) => {
    const f = it.fm;
    const skills = (f.matched_skills || "")
      .split(",").map((s) => s.trim()).filter(Boolean)
      .map((s) => `<span class="chip">${esc(s)}</span>`).join("");
    return `
<article class="card" data-url="${esc(f.url)}">
  <div class="head">
    <span class="score" style="background:${scoreColor(it.score)}">${it.score}</span>
    <div class="titles">
      <h2>${esc(f.title || "—")}</h2>
      <div class="sub">${badge(f.source || "dou")} <strong>${esc(f.company || "—")}</strong> · ${esc(f.location || "")} · <span class="lang">${esc(f.cover_language || "")}</span></div>
    </div>
    <div class="actions">
      <a class="apply" href="${esc(f.url)}" target="_blank" rel="noopener">Открыть вакансию ↗</a>
      <button class="seen-btn" onclick="toggleSeen(this)">Просмотрено</button>
    </div>
  </div>
  <div class="skills">${skills}</div>
  <details>
    <summary>Сопроводительное письмо</summary>
    <pre id="cover${idx}">${esc(it.cover)}</pre>
    <button class="copy" onclick="copyCover(${idx})">Копировать письмо</button>
    <span class="resume">📎 резюме: ${esc(f.resume || "")}</span>
  </details>
</article>`;
  })
  .join("\n");

const html = `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Вакансии — ${items.length}</title>
<style>
  :root { font-family: -apple-system, system-ui, sans-serif; }
  body { margin: 0; background: #f6f8fa; color: #1f2328; }
  header { position: sticky; top: 0; background: #24292f; color: #fff; padding: 14px 20px; }
  header h1 { margin: 0; font-size: 18px; }
  header .meta { font-size: 13px; opacity: .8; margin-top: 2px; }
  main { max-width: 920px; margin: 18px auto; padding: 0 14px; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
  .head { display: flex; align-items: flex-start; gap: 12px; }
  .score { color: #fff; font-weight: 700; font-size: 15px; min-width: 38px; height: 38px; border-radius: 8px; display: flex; align-items: center; justify-content: center; }
  .titles { flex: 1; }
  .titles h2 { margin: 0; font-size: 16px; }
  .sub { font-size: 13px; color: #57606a; margin-top: 4px; }
  .src { color: #fff; font-size: 11px; padding: 1px 6px; border-radius: 4px; text-transform: uppercase; }
  .lang { text-transform: uppercase; font-size: 11px; color: #57606a; }
  .actions { display: flex; flex-direction: column; gap: 6px; align-items: stretch; }
  .apply { white-space: nowrap; text-align: center; background: #1f883d; color: #fff; text-decoration: none; padding: 7px 12px; border-radius: 7px; font-size: 13px; font-weight: 600; }
  .apply:hover { background: #1a7f37; }
  .seen-btn { white-space: nowrap; background: #fff; color: #57606a; border: 1px solid #d0d7de; padding: 6px 12px; border-radius: 7px; font-size: 13px; cursor: pointer; }
  .seen-btn:hover { background: #f3f4f6; }
  .card.seen { opacity: .5; }
  .card.seen .seen-btn { background: #1f883d; color: #fff; border-color: #1f883d; }
  .filter { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; cursor: pointer; margin-top: 6px; }
  .filter input { cursor: pointer; }
  .skills { margin: 10px 0 4px; }
  .chip { display: inline-block; background: #eaf2ff; color: #0a66c2; font-size: 12px; padding: 2px 8px; border-radius: 12px; margin: 2px; }
  details { margin-top: 6px; }
  summary { cursor: pointer; font-size: 13px; color: #0969da; }
  pre { white-space: pre-wrap; background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 7px; padding: 10px; font-size: 13px; font-family: inherit; }
  .copy { background: #0969da; color: #fff; border: 0; padding: 6px 12px; border-radius: 6px; font-size: 13px; cursor: pointer; }
  .resume { font-size: 12px; color: #57606a; margin-left: 10px; }
  .empty { text-align: center; color: #57606a; padding: 40px; }
</style></head>
<body>
<header>
  <h1>🎯 Подходящие вакансии: ${items.length}</h1>
  <div class="meta">Обновлено: ${new Date().toLocaleString("ru-RU")} · отсортировано по релевантности · ничего не отправляется автоматически</div>
  <label class="filter"><input type="checkbox" id="hideSeen" onchange="applyFilter()"> Скрыть просмотренные (<span id="seenCount">0</span>)</label>
</header>
<main>
${items.length ? cards : '<div class="empty">Пока нет подходящих вакансий. Запусти <code>node jobs.mjs</code>.</div>'}
</main>
<script>
function copyCover(i){
  const t = document.getElementById('cover'+i).innerText;
  navigator.clipboard.writeText(t).then(()=>{
    event.target.textContent='✓ Скопировано';
    setTimeout(()=>event.target.textContent='Копировать письмо',1500);
  });
}

// "Просмотрено" persists in localStorage keyed by job URL, so it survives
// dashboard regeneration (jobs.mjs rewrites this file on every run).
const SEEN_KEY = 'dashboardSeenJobs';
function loadSeen(){ try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); } }
function saveSeen(s){ localStorage.setItem(SEEN_KEY, JSON.stringify([...s])); }
let seenSet = loadSeen();

function toggleSeen(btn){
  const card = btn.closest('.card');
  const url = card.dataset.url;
  if (seenSet.has(url)) { seenSet.delete(url); card.classList.remove('seen'); btn.textContent = 'Просмотрено'; }
  else { seenSet.add(url); card.classList.add('seen'); btn.textContent = '✓ Просмотрено'; }
  saveSeen(seenSet);
  applyFilter();
}

function applyFilter(){
  const hide = document.getElementById('hideSeen').checked;
  let count = 0;
  document.querySelectorAll('.card').forEach((card) => {
    const isSeen = seenSet.has(card.dataset.url);
    if (isSeen) count++;
    card.style.display = (hide && isSeen) ? 'none' : '';
  });
  document.getElementById('seenCount').textContent = count;
}

// Restore saved state on load.
document.querySelectorAll('.card').forEach((card) => {
  if (seenSet.has(card.dataset.url)) {
    card.classList.add('seen');
    const btn = card.querySelector('.seen-btn');
    if (btn) btn.textContent = '✓ Просмотрено';
  }
});
applyFilter();
</script>
</body></html>`;

writeFileSync(OUT, html);
console.log(`Dashboard: ${OUT} (${items.length} jobs)`);

if (process.argv.includes("--open")) {
  execFile("open", [OUT], () => {});
}
