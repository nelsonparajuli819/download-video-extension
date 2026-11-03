const MEDIA_EXT = /\.(mp4|webm|m3u8|mkv|mov|m4v|mp3|m4a)(\?|#|$)/i;
const SKIP_EXT = /\.(ts|m4s|aac|vtt|srt|jpg|png|js|css)(\?|#|$)/i;

// ---------- serialized session-storage helpers (service worker can sleep) ----------
let queue = Promise.resolve();
const enqueue = (fn) => (queue = queue.then(fn).catch((e) => console.warn(e)));
const get = async (k) => (await chrome.storage.session.get(k))[k] || {};
const set = (k, v) => chrome.storage.session.set({ [k]: v });
const sanitize = (s) => (s || "video").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().replace(/^\.+/, "").slice(0, 120) || "video";

// ---------- listing: one lesson = one card ----------
function visible(list) {
  let l = list || [];
  if (l.some((v) => v.kind === "hls" && v.master === true)) l = l.filter((v) => !(v.kind === "hls" && v.master !== true));
  return l.map((v, i) => ({ ...v, base: v.title + (i ? ` (${i + 1})` : "") }));
}
function updateBadge(tabId, list) {
  const n = visible(list).length;
  chrome.action.setBadgeBackgroundColor({ color: "#0b6bcb" });
  chrome.action.setBadgeText({ tabId, text: n ? String(n) : "" }).catch(() => {});
}

// ---------- Referer/Origin for our own requests (needed by signed streams) ----------
const ruleId = (s) => 1000 + ([...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % 100000);
async function setReferer(key, refUrl) {
  if (!refUrl) return;
  const o = new URL(refUrl).origin;
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [ruleId(key)],
    addRules: [{
      id: ruleId(key), priority: 1,
      action: { type: "modifyHeaders", requestHeaders: [
        { header: "referer", operation: "set", value: o + "/" },
        { header: "origin", operation: "set", value: o }] },
      condition: { tabIds: [-1], resourceTypes: ["xmlhttprequest"] },
    }],
  });
}
const dropReferer = (key) => chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [ruleId(key)] }).catch(() => {});

async function classifyHls(tabId, key, url, refUrl) {
  let master = null, q = "";
  try {
    await setReferer("probe-" + key, refUrl);
    const r = await fetch(url, { credentials: "include" });
    if (r.ok) {
      const t = await r.text();
      master = t.includes("#EXT-X-STREAM-INF");
      const hs = [...t.matchAll(/RESOLUTION=\d+x(\d+)/g)].map((m) => +m[1]);
      if (hs.length) q = Math.max(...hs) + "p";
    }
  } catch {}
  dropReferer("probe-" + key);
  enqueue(async () => {
    const all = await get("videos"), list = all[tabId] || [], it = list.find((v) => v.key === key);
    if (!it) return;
    it.master = master; it.q = q;
    await set("videos", all);
    updateBadge(tabId, list);
  });
}

// ---------- detection ----------
function classify(url, headers) {
  const h = {};
  (headers || []).forEach((x) => (h[x.name.toLowerCase()] = x.value));
  const type = (h["content-type"] || "").toLowerCase();
  let size = parseInt(h["content-length"] || "0", 10);
  const cr = /\/(\d+)$/.exec(h["content-range"] || "");
  if (cr) size = parseInt(cr[1], 10);
  if (/mpegurl/.test(type) || /\.m3u8(\?|#|$)/i.test(url)) return { kind: "hls", ext: "mp4", size: 0 };
  if (SKIP_EXT.test(url)) return null;
  if (/^(video|audio)\//.test(type) || MEDIA_EXT.test(url)) {
    if (size && size < 200 * 1024) return null;
    const m = MEDIA_EXT.exec(url);
    return { kind: "file", ext: m ? m[1].toLowerCase() : type.split("/")[1]?.split(";")[0] || "mp4", size };
  }
  return null;
}

function addVideo(tabId, url, info, pageTitle, refUrl) {
  if (tabId < 0) return;
  enqueue(async () => {
    const all = await get("videos");
    const list = all[tabId] || [];
    const key = url.split("?")[0];
    const existing = list.find((v) => v.key === key);
    if (existing) { // keep the freshest (token-bearing) URL
      existing.url = url;
      if (refUrl) existing.refUrl = refUrl;
      all[tabId] = list;
      await set("videos", all);
      return;
    }
    let title = pageTitle, tabUrl;
    try { const t = await chrome.tabs.get(tabId); title = title || t.title; tabUrl = t.url; } catch {}
    list.push({ key, url, refUrl: refUrl || tabUrl, kind: info.kind, ext: info.ext, size: info.size, title: sanitize(title), master: undefined });
    all[tabId] = list;
    await set("videos", all);
    updateBadge(tabId, list);
    if (info.kind === "hls") classifyHls(tabId, key, url, refUrl || tabUrl);
  });
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => { const info = classify(d.url, d.responseHeaders); if (info) addVideo(d.tabId, d.url, info, null, d.documentUrl); },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);

function clearTab(tabId) {
  enqueue(async () => {
    const all = await get("videos");
    delete all[tabId];
    await set("videos", all);
    chrome.action.setBadgeText({ tabId, text: "" }).catch(() => {});
  });
}
chrome.tabs.onUpdated.addListener((tabId, ch) => { if (ch.status === "loading") clearTab(tabId); });
chrome.tabs.onRemoved.addListener(clearTab);

// ---------- downloads (global, independent of the tab) ----------
async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  await chrome.offscreen.createDocument({ url: "offscreen.html", reasons: ["BLOBS"], justification: "Download and assemble video streams" });
}
const patchJob = (key, patch) => enqueue(async () => {
  const jobs = await get("jobs");
  jobs[key] = { ...(jobs[key] || {}), ...patch };
  await set("jobs", jobs);
});
const rememberName = (url, filename) => enqueue(async () => {
  const n = await get("names"); n[url] = filename; await set("names", n);
});

// Force OUR file name (Chrome otherwise names blob downloads with a random id).
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  (async () => {
    await queue;
    const n = await get("names");
    const f = n[item.url] || n[item.finalUrl];
    f ? suggest({ filename: f, conflictAction: "uniquify" }) : suggest();
  })().catch(() => suggest());
  return true;
});

async function startDownload(v) {
  const name = sanitize(v.base);
  await patchJob(v.key, { name, state: "running", pct: 0, speed: 0, kind: v.kind, dlId: null, error: null, q: v.q || "",
    startedAt: Date.now(), lastBytes: 0, lastTime: Date.now(), filename: null });
  if (v.kind === "hls") {
    await ensureOffscreen();
    await setReferer(v.key, v.refUrl);
    chrome.runtime.sendMessage({ target: "offscreen", type: "hls", id: v.key, url: v.url, base: name });
  } else {
    const filename = `${name}.${v.ext}`;
    await rememberName(v.url, filename);
    const dlId = await chrome.downloads.download({ url: v.url, filename, conflictAction: "uniquify" });
    await patchJob(v.key, { dlId, filename });
  }
}

async function cancelDownload(key) {
  const j = (await get("jobs"))[key];
  if (!j) return;
  if (j.kind === "hls" && !j.dlId) chrome.runtime.sendMessage({ target: "offscreen", type: "cancel", id: key });
  if (j.dlId) chrome.downloads.cancel(j.dlId).catch(() => {});
  dropReferer(key);
  await patchJob(key, { state: "cancelled" });
}

async function buildState(tabId) {
  await queue;
  const videos = visible((await get("videos"))[tabId]);
  const jobs = await get("jobs");
  const patches = [];
  for (const [key, j] of Object.entries(jobs)) {
    if (!j.dlId || j.state !== "running") continue;
    let d;
    try { [d] = await chrome.downloads.search({ id: j.dlId }); } catch {}
    if (!d) { patches.push(patchJob(key, { state: "cancelled" })); continue; }
    const p = {};
    if (j.kind === "file") {
      const now = Date.now(), dt = Math.max(0.3, (now - (j.lastTime || now)) / 1000);
      p.pct = d.totalBytes > 0 ? Math.round((d.bytesReceived / d.totalBytes) * 100) : 0;
      p.speed = d.state === "in_progress" && d.bytesReceived > (j.lastBytes || 0) ? (d.bytesReceived - (j.lastBytes || 0)) / dt : 0;
      p.lastBytes = d.bytesReceived; p.lastTime = now;
    }
    if (d.state === "complete") { p.state = "done"; p.pct = 100; p.speed = 0; }
    else if (d.state === "interrupted") { p.state = d.error === "USER_CANCELED" ? "cancelled" : "error"; p.error = d.error; }
    patches.push(patchJob(key, p));
  }
  await Promise.all(patches);
  await queue;
  return { videos, jobs: await get("jobs") };
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  switch (m.type) {
    case "dom-found": {
      if (!sender.tab) break;
      const info = classify(m.url, []);
      if (info) addVideo(sender.tab.id, m.url, info, sender.tab.title, sender.url);
      break;
    }
    case "progress":
      enqueue(async () => {
        const jobs = await get("jobs"), j = jobs[m.id];
        if (!j || j.dlId || j.state !== "running") return;
        j.pct = m.pct; j.speed = m.speed; if (m.q) j.q = m.q;
        await set("jobs", jobs);
      });
      break;
    case "hls-done":
      dropReferer(m.id);
      (async () => {
        await rememberName(m.blobUrl, m.filename);
        const dlId = await chrome.downloads.download({ url: m.blobUrl, filename: m.filename, conflictAction: "uniquify" });
        await patchJob(m.id, { dlId, pct: 100, speed: 0, filename: m.filename, lastBytes: 0, lastTime: Date.now() });
      })().catch((e) => patchJob(m.id, { state: "error", error: String(e) }));
      break;
    case "hls-error":
      dropReferer(m.id);
      patchJob(m.id, { state: m.cancelled ? "cancelled" : "error", error: m.error });
      break;
    case "getState":
      buildState(m.tabId).then(reply);
      return true;
    case "download":
      startDownload(m.video).catch((e) => patchJob(m.video.key, { state: "error", error: String(e) }));
      break;
    case "cancel": cancelDownload(m.key); break;
    case "removeJob":
      enqueue(async () => { const j = await get("jobs"); delete j[m.key]; await set("jobs", j); });
      break;
    case "clearFinished":
      enqueue(async () => { const j = await get("jobs"); for (const k in j) if (j[k].state !== "running") delete j[k]; await set("jobs", j); });
      break;
    case "clear": clearTab(m.tabId); break;
  }
});
