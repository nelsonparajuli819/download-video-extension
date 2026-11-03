const $ = (s) => document.querySelector(s);
let tabId, tabTitle = "", last = "";
const names = {}; // key -> name typed by the user
const clean = (s) => (s || "video").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120) || "video";
const fmtSize = (b) => (b ? (b > 1e9 ? (b / 1e9).toFixed(2) + " GB" : (b / 1e6).toFixed(1) + " MB") : "");
const fmtSpeed = (b) => (b > 1e6 ? (b / 1e6).toFixed(1) + " MB/s" : Math.round(b / 1e3) + " KB/s");
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const send = (m) => chrome.runtime.sendMessage(m);

function jobCard(j) {
  const run = j.state === "running", pct = j.pct || 0;
  const merging = run && j.kind === "hls" && !j.dlId && pct >= 99;
  let status = "", action = "";
  if (run) {
    status = merging ? "Combining audio + video…" : j.dlId && j.kind === "hls" ? "Saving…" : `${pct}%${j.speed ? " · " + fmtSpeed(j.speed) : ""}`;
    action = `<div class="bar"><i style="width:${pct}%"></i></div><span class="pill">${status}</span><button class="btn stop" data-a="cancel">■</button>`;
  } else if (j.state === "done") {
    action = `<span class="pill">✓ Done</span><button class="btn ok" data-a="open">▶ Play</button><button class="btn ghost" data-a="show">📁</button>`;
  } else if (j.state === "cancelled") action = `<span class="pill">Cancelled</span>`;
  else action = `<span class="err" title="${esc(j.error)}">${esc(j.error || "Failed")}</span>`;
  const meta = `${j.kind === "hls" ? "HLS" : "FILE"}${j.q ? " · " + j.q : ""}${j.filename ? " · " + esc(j.filename.split(/[\\/]/).pop()) : ""}`;
  return `<div class="card job ${run ? "run" : ""}" data-key="${esc(j.key)}">
    <div class="body"><div class="name"><span title="${esc(j.name)}" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(j.name)}</span>
    ${run ? "" : '<button class="x" data-a="remove" title="Remove">✕</button>'}</div>
    <div class="meta">${meta}</div><div class="row">${action}</div></div></div>`;
}

function pageCard(v, i, job) {
  const nm = names[v.key] ?? clean(tabTitle || v.title) + (i ? ` (${i + 1})` : "");
  const retry = job && (job.state === "error" || job.state === "cancelled");
  return `<div class="card" data-key="${esc(v.key)}"><div class="thumb"><span>${v.kind === "hls" ? "HLS" : esc(v.ext)}</span></div>
    <div class="body"><div class="name"><input value="${esc(nm)}" data-key="${esc(v.key)}" title="File name (edit if you like)"></div>
    <div class="meta">${v.kind === "hls" ? "HLS" : esc(v.ext.toUpperCase())}${v.q ? " · up to " + v.q : ""} ${fmtSize(v.size)}</div>
    <div class="row"><button class="btn" data-a="dl">${retry ? "Retry" : "Download"}</button></div></div></div>`;
}

async function refresh() {
  const { videos, jobs } = await send({ type: "getState", tabId });
  const jl = Object.entries(jobs).map(([key, j]) => ({ key, ...j })).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  const sig = JSON.stringify([videos, jl, tabTitle]);
  if (sig === last) return;
  if (document.activeElement?.tagName === "INPUT") return; // don't disturb typing
  last = sig;

  $("#dlSec").hidden = !jl.length;
  $("#downloads").innerHTML = jl.map(jobCard).join("");

  const pending = videos.map((v, i) => ({ v, i })).filter(({ v }) => !jobs[v.key] || ["error", "cancelled"].includes(jobs[v.key].state));
  $("#pgSec").hidden = !pending.length;
  $("#page").innerHTML = pending.map(({ v, i }) => pageCard(v, i, jobs[v.key])).join("");
  $("#empty").hidden = jl.length > 0 || videos.length > 0;
  window.__videos = videos;
}

document.addEventListener("input", (e) => { if (e.target.matches("input[data-key]")) names[e.target.dataset.key] = e.target.value; });
document.addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-a]"); if (!btn) return;
  const key = btn.closest("[data-key]")?.dataset.key, a = btn.dataset.a;
  const { jobs } = await send({ type: "getState", tabId });
  if (a === "dl") {
    const v = (window.__videos || []).find((x) => x.key === key);
    const input = btn.closest(".card").querySelector("input");
    if (v) send({ type: "download", video: { ...v, base: clean(input.value) } });
  } else if (a === "cancel") send({ type: "cancel", key });
  else if (a === "remove") send({ type: "removeJob", key });
  else if (a === "open" && jobs[key]?.dlId) chrome.downloads.open(jobs[key].dlId);
  else if (a === "show" && jobs[key]?.dlId) chrome.downloads.show(jobs[key].dlId);
  last = ""; setTimeout(refresh, 200);
});
$("#clear").onclick = () => { send({ type: "clear", tabId }); last = ""; setTimeout(refresh, 200); };
$("#clearDone").onclick = () => { send({ type: "clearFinished" }); last = ""; setTimeout(refresh, 200); };

chrome.tabs.query({ active: true, currentWindow: true }).then(([t]) => {
  tabId = t.id; tabTitle = t.title || "";
  refresh(); setInterval(refresh, 700);
});
