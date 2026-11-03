// HLS downloader: best quality video + audio rendition -> ONE combined file.
const aborts = {};
const send = (m) => { try { const p = chrome.runtime.sendMessage(m); p && p.catch && p.catch(() => {}); } catch {} };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (typeof chrome !== "undefined" && chrome.runtime?.onMessage)
  chrome.runtime.onMessage.addListener((m) => {
    if (m.target !== "offscreen") return;
    if (m.type === "hls") runHls(m);
    if (m.type === "cancel") aborts[m.id]?.abort();
  });

async function req(url, signal, asBuf) {
  let err;
  for (let t = 0; t < 4; t++) {
    try {
      const r = await fetch(url, { credentials: "include", signal });
      if (r.ok) return asBuf ? await r.arrayBuffer() : await r.text();
      const e = new Error("HTTP " + r.status + (r.status === 403 || r.status === 401 ? " (access denied: replay the video on the page, then retry right away)" : "") + " – " + new URL(url).host);
      e.fatal = r.status >= 400 && r.status < 500 && r.status !== 429;
      if (e.fatal) throw e;
      err = e;
    } catch (e) {
      if (e.name === "AbortError" || e.fatal) throw e;
      err = e;
    }
    await sleep(700 * (t + 1));
  }
  throw err;
}

const attrs = (l) => { const o = {}; for (const m of l.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)) o[m[1]] = m[2].replace(/^"|"$/g, ""); return o; };

function parseMaster(text, base) {
  const L = text.split(/\r?\n/), variants = [], audio = [];
  L.forEach((line, i) => {
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const a = attrs(line), u = L.slice(i + 1).find((x) => x.trim() && !x.startsWith("#"));
      if (u) variants.push({ url: new URL(u.trim(), base).href, bw: +a.BANDWIDTH || 0, h: +((a.RESOLUTION || "0x0").split("x")[1]) || 0, audio: a.AUDIO, hasRes: !!a.RESOLUTION });
    } else if (line.startsWith("#EXT-X-MEDIA")) {
      const a = attrs(line);
      if (a.TYPE === "AUDIO" && a.URI) audio.push({ url: new URL(a.URI, base).href, group: a["GROUP-ID"], def: a.DEFAULT === "YES" });
    }
  });
  return { variants, audio };
}

function parsePlaylist(text, base) {
  let seq = +(/#EXT-X-MEDIA-SEQUENCE:(\d+)/.exec(text) || [])[1] || 0, key = null, mapUrl = null;
  const segs = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("#EXT-X-KEY")) {
      const a = attrs(line);
      if (a.METHOD === "NONE") key = null;
      else if (a.METHOD === "AES-128") key = { uri: new URL(a.URI, base).href, iv: a.IV ? a.IV.replace(/^0x/i, "") : null };
      else throw new Error("This stream uses " + a.METHOD + " (DRM) encryption and can't be downloaded.");
    } else if (line.startsWith("#EXT-X-MAP")) mapUrl = new URL(attrs(line).URI, base).href;
    else if (line.trim() && !line.startsWith("#")) segs.push({ url: new URL(line.trim(), base).href, key, seq: seq++ });
  }
  if (!segs.length) throw new Error("No segments found in playlist.");
  return { segs, mapUrl };
}

async function getSegs(pl, st) {
  const keys = {};
  const getKey = (uri) => (keys[uri] ??= req(uri, st.signal, true).then((b) => crypto.subtle.importKey("raw", b, "AES-CBC", false, ["decrypt"])));
  const init = pl.mapUrl ? await req(pl.mapUrl, st.signal, true) : null;
  const res = new Array(pl.segs.length);
  let next = 0;
  const worker = async () => {
    while (next < pl.segs.length) {
      const i = next++, s = pl.segs[i];
      let buf = await req(s.url, st.signal, true);
      if (s.key) {
        const iv = new Uint8Array(16);
        if (s.key.iv) s.key.iv.padStart(32, "0").match(/../g).forEach((h, j) => (iv[j] = parseInt(h, 16)));
        else new DataView(iv.buffer).setUint32(12, s.seq);
        buf = await crypto.subtle.decrypt({ name: "AES-CBC", iv }, await getKey(s.key.uri), buf);
      }
      res[i] = buf; st.bytes += buf.byteLength; st.done++; st.report();
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return init ? [init, ...res] : res;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.byteLength, 0));
  let o = 0;
  for (const p of parts) { out.set(new Uint8Array(p), o); o += p.byteLength; }
  return out;
}

// Mux.com serves ready-made combined MP4s (if enabled for the asset). Best-effort first try.
async function tryStaticMp4(url, id, signal) {
  const u = new URL(url), m = /^\/([A-Za-z0-9]+)\.m3u8$/.exec(u.pathname);
  if (!/(^|\.)mux\.com$/.test(u.hostname) || !m) return null;
  for (const name of ["highest.mp4", "capped-1080p.mp4", "1080p.mp4", "high.mp4", "720p.mp4", "medium.mp4"]) {
    try {
      const r = await fetch(`${u.origin}/${m[1]}/${name}${u.search}`, { credentials: "include", signal });
      if (!r.ok) { r.body?.cancel(); continue; }
      const total = +r.headers.get("content-length") || 0, chunks = [], t0 = Date.now();
      let got = 0;
      const rd = r.body.getReader();
      for (;;) {
        const { done, value } = await rd.read();
        if (done) break;
        chunks.push(value); got += value.length;
        send({ type: "progress", id, pct: total ? Math.floor((got / total) * 100) : 0, speed: got / ((Date.now() - t0) / 1000) });
      }
      return new Blob(chunks, { type: "video/mp4" });
    } catch (e) { if (e.name === "AbortError") throw e; }
  }
  return null;
}

// Prefer a real, seekable MP4; fall back gracefully so a download never fails at the last step.
function combine(vBuf, aBuf, fm) {
  const tries = fm
    ? [() => aBuf && Merge.fmp4ToMp4(vBuf, aBuf), () => aBuf && Merge.mergeFmp4(vBuf, aBuf)]
    : [() => Merge.tsToMp4(vBuf, aBuf), () => aBuf && Merge.mergeTs(vBuf, aBuf)];
  for (const t of tries) {
    try { const r = t(); if (r) return r; } catch (e) { console.warn("combine step failed:", e.message); }
  }
  return { blob: new Blob([vBuf], { type: fm ? "video/mp4" : "video/mp2t" }), ext: fm ? "mp4" : "ts" };
}

async function runHls({ id, url, base }) {
  const ac = new AbortController();
  aborts[id] = ac;
  try {
    const finish = (blob, ext) => send({ type: "hls-done", id, blobUrl: URL.createObjectURL(blob), filename: `${base}.${ext}` });

    const mp4 = await tryStaticMp4(url, id, ac.signal);
    if (mp4) return finish(mp4, "mp4");

    // Players sometimes cap quality via ?max_resolution=...; try the uncapped URL first.
    let text = null;
    try {
      const u = new URL(url);
      if (u.searchParams.has("max_resolution")) {
        u.searchParams.delete("max_resolution");
        text = await req(u.href, ac.signal); url = u.href;
      }
    } catch (e) { if (e.name === "AbortError") throw e; text = null; }
    if (text == null) text = await req(url, ac.signal);
    let vUrl = url, aUrl = null, vText = text;
    if (text.includes("#EXT-X-STREAM-INF")) {
      const { variants, audio } = parseMaster(text, url);
      const pool = variants.some((v) => v.hasRes) ? variants.filter((v) => v.hasRes) : variants;
      const best = pool.sort((a, b) => b.h - a.h || b.bw - a.bw)[0];
      vUrl = best.url;
      send({ type: "progress", id, pct: 0, speed: 0, q: best.h ? best.h + "p" : "" });
      const cand = audio.filter((a) => !best.audio || a.group === best.audio);
      const a = cand.find((x) => x.def) || cand[0];
      if (a && a.url !== vUrl) aUrl = a.url;
      vText = await req(vUrl, ac.signal);
    }
    const V = parsePlaylist(vText, vUrl);
    const A = aUrl ? parsePlaylist(await req(aUrl, ac.signal), aUrl) : null;

    const total = V.segs.length + (A ? A.segs.length : 0);
    const st = { signal: ac.signal, done: 0, bytes: 0, t0: Date.now(), last: 0 };
    st.report = () => {
      const now = Date.now();
      if (now - st.last < 300 && st.done < total) return;
      st.last = now;
      send({ type: "progress", id, pct: Math.min(99, Math.floor((st.done / total) * 100)), speed: st.bytes / ((now - st.t0) / 1000) });
    };

    const vParts = await getSegs(V, st);
    const aParts = A ? await getSegs(A, st) : null;
    send({ type: "progress", id, pct: 99, speed: 0 });
    const fm = !!(V.mapUrl || (A && A.mapUrl));
    const vBuf = concat(vParts); vParts.length = 0;
    const aBuf = aParts ? concat(aParts) : null; if (aParts) aParts.length = 0;
    const r = combine(vBuf, aBuf, fm);
    finish(r.blob, r.ext);
  } catch (e) {
    ac.abort();
    send({ type: "hls-error", id, error: e.message, cancelled: e.name === "AbortError" });
  } finally {
    delete aborts[id];
  }
}
if (typeof module !== "undefined") module.exports = { runHls };
