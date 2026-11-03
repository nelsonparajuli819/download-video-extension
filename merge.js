// Pure-JS muxers: combine a video-only and an audio-only stream into ONE file.
//  - mergeTs:   MPEG-TS + MPEG-TS  -> MPEG-TS
//  - mergeFmp4: fMP4 + fMP4        -> fMP4 (.mp4)
(function (root) {
  const TS = 188;
  const isVideo = (t) => [0x01, 0x02, 0x10, 0x1b, 0x24].includes(t);
  const isAudio = (t) => [0x03, 0x04, 0x0f, 0x11, 0x81, 0x87].includes(t);

  // ---------------- MPEG-TS ----------------
  function crc32(b) {
    let c = 0xffffffff;
    for (const x of b) {
      c = (c ^ (x << 24)) >>> 0;
      for (let i = 0; i < 8; i++) c = ((c & 0x80000000 ? (c << 1) ^ 0x04c11db7 : c << 1) >>> 0);
    }
    return c >>> 0;
  }
  const withCrc = (s) => { const c = crc32(s), o = new Uint8Array(s.length + 4); o.set(s); o[s.length] = c >>> 24; o[s.length + 1] = (c >>> 16) & 255; o[s.length + 2] = (c >>> 8) & 255; o[s.length + 3] = c & 255; return o; };
  const psi = (pid, sec, cc) => { const p = new Uint8Array(TS).fill(0xff); p[0] = 0x47; p[1] = 0x40 | (pid >> 8); p[2] = pid & 255; p[3] = 0x10 | (cc & 15); p[4] = 0; p.set(sec, 5); return p; };

  function findSync(buf) {
    const lim = Math.min(buf.length - 2 * TS, 4000);
    for (let o = 0; o < lim; o++) if (buf[o] === 0x47 && buf[o + TS] === 0x47 && buf[o + 2 * TS] === 0x47) return o;
    return 0;
  }
  const pOff = (b, o) => { const a = (b[o + 3] >> 4) & 3; return a === 1 ? o + 4 : a === 3 ? o + 5 + b[o + 4] : -1; };

  function parseStreams(buf, start) {
    let pmtPid = -1;
    for (let o = start; o + TS <= buf.length; o += TS) {
      if (buf[o] !== 0x47 || !(buf[o + 1] & 0x40)) continue;
      const pid = ((buf[o + 1] & 0x1f) << 8) | buf[o + 2];
      const p = pOff(buf, o);
      if (p < 0) continue;
      const s = p + 1 + buf[p];
      const len = ((buf[s + 1] & 0x0f) << 8) | buf[s + 2];
      if (pid === 0 && pmtPid < 0) {
        for (let i = s + 8; i < s + 3 + len - 4; i += 4)
          if (((buf[i] << 8) | buf[i + 1]) !== 0) { pmtPid = ((buf[i + 2] & 0x1f) << 8) | buf[i + 3]; break; }
      } else if (pid === pmtPid) {
        const pil = ((buf[s + 10] & 0x0f) << 8) | buf[s + 11];
        const streams = [];
        for (let i = s + 12 + pil; i < s + 3 + len - 4;) {
          streams.push({ type: buf[i], pid: ((buf[i + 1] & 0x1f) << 8) | buf[i + 2] });
          i += 5 + (((buf[i + 3] & 0x0f) << 8) | buf[i + 4]);
        }
        return streams;
      }
    }
    return [];
  }

  function pesTime(buf, o) {
    const p = pOff(buf, o);
    if (p < 0 || p + 19 > o + TS || buf[p] || buf[p + 1] || buf[p + 2] !== 1) return -1;
    const f = buf[p + 7] >> 6;
    if (f < 2) return -1;
    const rd = (q) => ((buf[q] >> 1) & 7) * 1073741824 + ((buf[q + 1] << 22) | ((buf[q + 2] >> 1) << 15) | (buf[q + 3] << 7) | (buf[q + 4] >> 1));
    return f === 3 ? rd(p + 14) : rd(p + 9); // prefer DTS
  }

  function collect(buf, start, pid) {
    const n = Math.floor((buf.length - start) / TS);
    const off = new Uint32Array(n), t = new Float64Array(n);
    let c = 0, cur = null;
    for (let o = start; o + TS <= buf.length; o += TS) {
      if (buf[o] !== 0x47 || (((buf[o + 1] & 0x1f) << 8) | buf[o + 2]) !== pid) continue;
      if (buf[o + 1] & 0x40) { const x = pesTime(buf, o); if (x >= 0) cur = x; }
      if (cur === null) continue;
      off[c] = o; t[c++] = cur;
    }
    return { off, t, c };
  }

  function mergeTs(vBuf, aBuf) {
    const vs = findSync(vBuf), as = findSync(aBuf);
    const v = parseStreams(vBuf, vs).find((s) => isVideo(s.type));
    const a = parseStreams(aBuf, as).find((s) => isAudio(s.type));
    if (!v) throw new Error("No video track found in the video stream.");
    if (!a) throw new Error("No audio track found in the audio stream.");
    const V = collect(vBuf, vs, v.pid), A = collect(aBuf, as, a.pid);
    const VP = 0x100, AP = 0x101, PM = 0x1000;
    const pat = withCrc([0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00, 0x00, 0x01, 0xe0 | (PM >> 8), PM & 255]);
    const pmt = withCrc([0x02, 0xb0, 0x17, 0x00, 0x01, 0xc1, 0x00, 0x00, 0xe0 | (VP >> 8), VP & 255, 0xf0, 0x00,
      v.type, 0xe0 | (VP >> 8), VP & 255, 0xf0, 0x00, a.type, 0xe0 | (AP >> 8), AP & 255, 0xf0, 0x00]);
    const CH = TS * 20000, chunks = [];
    let chunk = new Uint8Array(CH), cu = 0, patCc = 0, pmtCc = 0;
    const put = (src, o) => { if (cu === CH) { chunks.push(chunk); chunk = new Uint8Array(CH); cu = 0; } chunk.set(src.subarray(o, o + TS), cu); cu += TS; };
    const putPsi = () => { put(psi(0, pat, patCc++), 0); put(psi(PM, pmt, pmtCc++), 0); };
    let i = 0, j = 0, n = 0;
    while (i < V.c || j < A.c) {
      if (n++ % 3000 === 0) putPsi();
      const useV = i >= V.c ? false : j >= A.c ? true : V.t[i] <= A.t[j];
      const buf = useV ? vBuf : aBuf, o = useV ? V.off[i++] : A.off[j++], pid = useV ? VP : AP;
      buf[o + 1] = (buf[o + 1] & 0xe0) | (pid >> 8);
      buf[o + 2] = pid & 255;
      put(buf, o);
    }
    chunks.push(chunk.slice(0, cu));
    return { blob: new Blob(chunks, { type: "video/mp2t" }), ext: "ts" };
  }

  // ---------------- fragmented MP4 ----------------
  const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  const w32 = (b, o, v) => { b[o] = v >>> 24; b[o + 1] = (v >>> 16) & 255; b[o + 2] = (v >>> 8) & 255; b[o + 3] = v & 255; };
  function boxes(b, s = 0, e = b.length) {
    const out = [];
    for (let o = s; o + 8 <= e;) {
      let size = u32(b, o), hdr = 8;
      if (size === 1) { size = u32(b, o + 12); hdr = 16; } else if (size === 0) size = e - o;
      out.push({ t: String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), s: o, e: o + size, h: hdr });
      o += size;
    }
    return out;
  }
  const kids = (b, bx) => boxes(b, bx.s + bx.h, bx.e);
  const kid = (b, bx, t) => kids(b, bx).find((k) => k.t === t);
  function mk(type, parts) {
    const len = parts.reduce((s, p) => s + p.length, 8), o = new Uint8Array(len);
    w32(o, 0, len); for (let i = 0; i < 4; i++) o[4 + i] = type.charCodeAt(i);
    let p = 8; for (const x of parts) { o.set(x, p); p += x.length; }
    return o;
  }

  function parseFmp4(b) {
    const top = boxes(b), moov = top.find((x) => x.t === "moov");
    if (!moov) throw new Error("fMP4 init segment (moov) missing.");
    const trak = kid(b, moov, "trak");
    const tkhd = kid(b, trak, "tkhd"), mdhd = kid(b, kid(b, trak, "mdia"), "mdhd");
    const tv = b[tkhd.s + tkhd.h], mv = b[mdhd.s + mdhd.h];
    const trackIdPos = tkhd.s + tkhd.h + (tv === 1 ? 20 : 12);
    const scale = u32(b, mdhd.s + mdhd.h + (mv === 1 ? 20 : 12));
    const frags = [];
    for (let i = 0; i < top.length; i++) {
      if (top[i].t !== "moof") continue;
      const moof = top[i], mdat = top[i + 1];
      if (!mdat || mdat.t !== "mdat") continue;
      const traf = kid(b, moof, "traf"), tfdt = kid(b, traf, "tfdt");
      let time = 0;
      if (tfdt) { const p = tfdt.s + tfdt.h; time = b[p] === 1 ? u32(b, p + 4) * 4294967296 + u32(b, p + 8) : u32(b, p + 4); }
      frags.push({ moof, bytes: b.subarray(moof.s, mdat.e), time: time / scale });
    }
    return { b, top, moov, trak, trackIdPos, trackId: u32(b, trackIdPos), frags,
      ftyp: top.find((x) => x.t === "ftyp"), trex: (kid(b, moov, "mvex") ? kids(b, kid(b, moov, "mvex")).filter((x) => x.t === "trex") : []) };
  }

  function mergeFmp4(vBuf, aBuf) {
    const V = parseFmp4(vBuf), A = parseFmp4(aBuf);
    const AID = V.trackId === 100 ? 101 : 100;
    // audio: renumber track
    w32(aBuf, A.trackIdPos, AID);
    A.trex.forEach((x) => { if (u32(aBuf, x.s + x.h + 4) === A.trackId) w32(aBuf, x.s + x.h + 4, AID); });
    const aTrex = A.trex.find((x) => u32(aBuf, x.s + x.h + 4) === AID);
    A.frags.forEach((f) => {
      const tfhd = kid(aBuf, kid(aBuf, f.moof, "traf"), "tfhd");
      w32(aBuf, tfhd.s + tfhd.h + 4, AID);
    });
    // rebuild moov: video moov + audio trak + both trex
    const parts = [];
    for (const k of kids(vBuf, V.moov)) {
      if (k.t === "mvhd") {
        const c = vBuf.slice(k.s, k.e);
        w32(c, k.h + (c[k.h] === 1 ? 108 : 96), 200); // next_track_ID
        parts.push(c);
      } else if (k.t === "mvex") {
        const tr = kids(vBuf, k).filter((x) => x.t === "trex").map((x) => vBuf.subarray(x.s, x.e));
        parts.push(mk("mvex", [...tr, aBuf.subarray(aTrex.s, aTrex.e)]));
      } else if (k.t === "trak") {
        parts.push(vBuf.subarray(k.s, k.e));
        if (!parts.aDone) { parts.push(aBuf.subarray(A.trak.s, A.trak.e)); parts.aDone = true; }
      } else parts.push(vBuf.subarray(k.s, k.e));
    }
    const moov = mk("moov", parts);
    const frags = [...V.frags.map((f) => [f.time, 0, f.bytes]), ...A.frags.map((f) => [f.time, 1, f.bytes])]
      .sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    return { blob: new Blob([vBuf.subarray(V.ftyp.s, V.ftyp.e), moov, ...frags.map((f) => f[2])], { type: "video/mp4" }), ext: "mp4" };
  }

  // ---------------- Progressive (seekable) MP4 builder ----------------
  const be32 = (v) => [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255];
  const be16 = (v) => [(v >> 8) & 255, v & 255];
  const asc = (s) => [...s].map((c) => c.charCodeAt(0));
  const Bx = (type, ...k) => mk(type, k.map((x) => (x instanceof Uint8Array ? x : Uint8Array.from(x))));
  const FB = (type, ver, fl, ...k) => Bx(type, [ver, (fl >> 16) & 255, (fl >> 8) & 255, fl & 255], ...k);
  const U32 = (arr) => { const o = new Uint8Array(arr.length * 4); for (let i = 0; i < arr.length; i++) w32(o, i * 4, arr[i] >>> 0); return o; };
  const MATRIX = [...be32(0x10000), ...be32(0), ...be32(0), ...be32(0), ...be32(0x10000), ...be32(0), ...be32(0), ...be32(0), ...be32(0x40000000)];
  function runs(vals) { const o = []; for (const v of vals) { const l = o[o.length - 1]; if (l && l[1] === v) l[0]++; else o.push([1, v]); } return o; }

  function Writer() {
    const CH = 8 << 20, parts = [];
    let cur = new Uint8Array(CH), cu = 0, total = 0;
    return {
      put(u) { let o = 0; while (o < u.length) { if (cu === CH) { parts.push(cur); cur = new Uint8Array(CH); cu = 0; } const n = Math.min(CH - cu, u.length - o); cur.set(u.subarray(o, o + n), cu); cu += n; o += n; } total += u.length; },
      end() { parts.push(cur.subarray(0, cu)); return parts; },
      get total() { return total; },
    };
  }

  // track = {video, timescale, width, height, stsd(Uint8Array box), samples:[{size,dur,cts,key,data}], startPts(sec), mediaTime}
  function buildMp4(tracks) {
    const t0 = Math.min(...tracks.map((t) => t.startPts));
    const chunks = [], idx = tracks.map(() => 0), dts = tracks.map(() => 0);
    for (let win = 1, more = true; more; win++) {
      more = false;
      tracks.forEach((t, ti) => {
        const from = idx[ti];
        while (idx[ti] < t.samples.length && dts[ti] / t.timescale < win) dts[ti] += t.samples[idx[ti]++].dur;
        if (idx[ti] > from) chunks.push({ ti, from, n: idx[ti] - from });
        if (idx[ti] < t.samples.length) more = true;
      });
    }
    const W = Writer(), co = tracks.map(() => []), spc = tracks.map(() => []);
    for (const c of chunks) {
      const t = tracks[c.ti];
      co[c.ti].push(W.total); spc[c.ti].push(c.n);
      for (let i = c.from; i < c.from + c.n; i++) W.put(t.samples[i].data);
    }
    if (W.total > 0xfffffff0) throw new Error("File too large for MP4 remux.");

    const moov = (base) => {
      let movieDur = 0;
      const traks = tracks.map((t, ti) => {
        const S = t.samples, dur = S.reduce((s, x) => s + x.dur, 0);
        const durMs = Math.round((dur / t.timescale) * 1000), delay = Math.round((t.startPts - t0) * 1000);
        const total = durMs + Math.max(delay, 0);
        movieDur = Math.max(movieDur, total);
        const elst = []; if (delay > 0) elst.push(be32(delay), be32(0xffffffff), be32(0x10000));
        elst.push(be32(durMs), be32(t.mediaTime || 0), be32(0x10000));
        const sttsR = runs(S.map((s) => s.dur)), cttsR = runs(S.map((s) => s.cts));
        const sc = []; spc[ti].forEach((n, i) => { if (!sc.length || sc[sc.length - 1][1] !== n) sc.push([i + 1, n, 1]); });
        const keys = []; S.forEach((s, i) => s.key && keys.push(i + 1));
        const stbl = Bx("stbl", t.stsd,
          FB("stts", 0, 0, be32(sttsR.length), U32(sttsR.flat())),
          ...(cttsR.some((r) => r[1]) ? [FB("ctts", 0, 0, be32(cttsR.length), U32(cttsR.flat()))] : []),
          ...(t.video && keys.length < S.length ? [FB("stss", 0, 0, be32(keys.length), U32(keys))] : []),
          FB("stsc", 0, 0, be32(sc.length), U32(sc.flat())),
          FB("stsz", 0, 0, be32(0), be32(S.length), U32(S.map((s) => s.size))),
          FB("stco", 0, 0, be32(co[ti].length), U32(co[ti].map((o) => o + base))));
        const minf = Bx("minf", t.video ? FB("vmhd", 0, 1, [0, 0, 0, 0, 0, 0, 0, 0]) : FB("smhd", 0, 0, [0, 0, 0, 0]),
          Bx("dinf", FB("dref", 0, 0, be32(1), FB("url ", 0, 1))), stbl);
        const mdia = Bx("mdia", FB("mdhd", 0, 0, be32(0), be32(0), be32(t.timescale), be32(dur), be16(0x55c4), be16(0)),
          FB("hdlr", 0, 0, be32(0), asc(t.video ? "vide" : "soun"), new Array(12).fill(0), asc("Video\0")), minf);
        return Bx("trak", FB("tkhd", 0, 3, be32(0), be32(0), be32(ti + 1), be32(0), be32(total), new Array(8).fill(0),
          be16(0), be16(0), be16(t.video ? 0 : 0x100), be16(0), MATRIX, be32((t.width || 0) << 16), be32((t.height || 0) << 16)),
          Bx("edts", FB("elst", 0, 0, be32(elst.length / 3), elst.flat())), mdia);
      });
      return Bx("moov", FB("mvhd", 0, 0, be32(0), be32(0), be32(1000), be32(movieDur), be32(0x10000), be16(0x100), new Array(10).fill(0),
        MATRIX, new Array(24).fill(0), be32(tracks.length + 1)), ...traks);
    };
    const ftyp = Bx("ftyp", asc("isom"), be32(512), asc("isomiso2avc1mp41"));
    const size = moov(0).length;
    const moovFinal = moov(ftyp.length + size + 8);
    const mdatHdr = new Uint8Array(8); w32(mdatHdr, 0, W.total + 8); mdatHdr.set(asc("mdat"), 4);
    return { blob: new Blob([ftyp, moovFinal, mdatHdr, ...W.end()], { type: "video/mp4" }), ext: "mp4" };
  }

  // ---- H.264 / AAC helpers (for MPEG-TS -> MP4) ----
  function demux(buf, start, pid) {
    const out = []; let cur = null;
    const rd = (d, q) => ((d[q] >> 1) & 7) * 1073741824 + ((d[q + 1] << 22) | ((d[q + 2] >> 1) << 15) | (d[q + 3] << 7) | (d[q + 4] >> 1));
    const flush = () => {
      if (!cur) return;
      let len = 0; for (const p of cur.parts) len += p.length;
      const d = new Uint8Array(len); let o = 0; for (const p of cur.parts) { d.set(p, o); o += p.length; }
      cur = null;
      if (len < 9 || d[0] || d[1] || d[2] !== 1) return;
      const f = d[7] >> 6, pts = f >= 2 ? rd(d, 9) : null, dts = f === 3 ? rd(d, 14) : pts;
      out.push({ pts, dts, data: d.subarray(9 + d[8]) });
    };
    for (let o = start; o + TS <= buf.length; o += TS) {
      if (buf[o] !== 0x47 || (((buf[o + 1] & 0x1f) << 8) | buf[o + 2]) !== pid) continue;
      const p = pOff(buf, o); if (p < 0) continue;
      const pl = buf.subarray(p, o + TS);
      if (buf[o + 1] & 0x40) { flush(); cur = { parts: [pl] }; } else if (cur) cur.parts.push(pl);
    }
    flush();
    return out;
  }
  function splitNals(d) {
    const r = []; let s = -1, i = 0; const n = d.length;
    const end = (e) => { while (e > s && d[e - 1] === 0) e--; return e; };
    while (i + 2 < n) {
      if (d[i + 2] > 1) i += 3;
      else if (d[i] === 0 && d[i + 1] === 0 && d[i + 2] === 1) { if (s >= 0) r.push(d.subarray(s, end(i))); s = i + 3; i += 3; }
      else i++;
    }
    if (s >= 0) r.push(d.subarray(s, end(n)));
    return r;
  }
  function parseSps(nal) {
    const rb = []; for (let i = 1; i < nal.length; i++) if (!(i >= 3 && nal[i] === 3 && nal[i - 1] === 0 && nal[i - 2] === 0)) rb.push(nal[i]);
    let pos = 24;
    const bit = () => { const v = (rb[pos >> 3] >> (7 - (pos & 7))) & 1; pos++; return v; };
    const u = (n) => { let v = 0; for (let i = 0; i < n; i++) v = v * 2 + bit(); return v; };
    const ue = () => { let z = 0; while (!bit() && z < 32) z++; return z ? 2 ** z - 1 + u(z) : 0; };
    const se = () => { const k = ue(); return k & 1 ? (k + 1) / 2 : -k / 2; };
    const profile = rb[0]; let chroma = 1;
    ue();
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = ue(); if (chroma === 3) bit(); ue(); ue(); bit();
      if (bit()) for (let i = 0; i < (chroma !== 3 ? 8 : 12); i++) if (bit()) {
        let last = 8, next = 8; for (let j = 0; j < (i < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; }
      }
    }
    ue(); const poc = ue();
    if (poc === 0) ue(); else if (poc === 1) { bit(); se(); se(); const n = ue(); for (let i = 0; i < n; i++) se(); }
    ue(); bit();
    const w = ue() + 1, h = ue() + 1, fmo = bit();
    if (!fmo) bit();
    bit();
    let cl = 0, cr = 0, ct = 0, cb = 0;
    if (bit()) { cl = ue(); cr = ue(); ct = ue(); cb = ue(); }
    const cux = chroma === 0 || chroma === 3 ? 1 : 2, cuy = (chroma === 1 ? 2 : 1) * (2 - fmo) * (chroma === 0 ? 1 : 1);
    return { width: w * 16 - cux * (cl + cr), height: (2 - fmo) * h * 16 - (chroma === 0 ? 2 - fmo : cuy) * (ct + cb) };
  }
  const AAC_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function videoTrackFromTs(buf, start, pid) {
    const pes = demux(buf, start, pid);
    let sps = null, pps = null; const S = [];
    for (const p of pes) {
      const nl = splitNals(p.data); let key = false, vcl = false; const keep = [];
      for (const n of nl) {
        const t = n[0] & 31;
        if (t === 7) sps = sps || n.slice(); else if (t === 8) pps = pps || n.slice();
        else if (t === 5) { key = vcl = true; keep.push(n); } else if (t === 1 || t === 2 || t === 3 || t === 4) { vcl = true; keep.push(n); }
      }
      if (!vcl || (!S.length && !key)) continue;
      let len = 0; keep.forEach((n) => (len += 4 + n.length));
      const data = new Uint8Array(len); let o = 0;
      keep.forEach((n) => { w32(data, o, n.length); data.set(n, o + 4); o += 4 + n.length; });
      S.push({ size: len, key, data, pts: p.pts, dts: p.dts });
    }
    if (!S.length || !sps || !pps) throw new Error("No H.264 video found.");
    let last = null;
    S.forEach((s, i) => {
      if (s.dts == null) s.dts = last == null ? 0 : last + 3000;
      if (s.pts == null) s.pts = s.dts;
      last = s.dts;
    });
    const d0 = S[0].dts, p0 = S[0].pts;
    let prevDur = 3000;
    S.forEach((s, i) => {
      const d = i + 1 < S.length ? S[i + 1].dts - s.dts : prevDur;
      s.dur = d > 0 && d < 90000 * 10 ? d : prevDur; prevDur = s.dur;
      s.cts = Math.max(0, s.pts - s.dts);
    });
    const { width, height } = parseSps(sps);
    const avcC = Bx("avcC", [1, sps[1], sps[2], sps[3], 0xff, 0xe1], be16(sps.length), sps, [1], be16(pps.length), pps);
    const avc1 = Bx("avc1", new Array(6).fill(0), be16(1), new Array(16).fill(0), be16(width), be16(height), be32(0x480000), be32(0x480000),
      be32(0), be16(1), new Array(32).fill(0), be16(0x18), be16(0xffff), avcC);
    return { video: true, timescale: 90000, width, height, stsd: FB("stsd", 0, 0, be32(1), avc1), samples: S,
      startPts: p0 / 90000, mediaTime: S[0].cts };
  }

  function audioTrackFromTs(buf, start, pid) {
    const pes = demux(buf, start, pid);
    if (!pes.length) throw new Error("No audio found.");
    let len = 0; pes.forEach((p) => (len += p.data.length));
    const d = new Uint8Array(len); let o = 0; pes.forEach((p) => { d.set(p.data, o); o += p.data.length; });
    const S = []; let info = null;
    for (let p = 0; p + 7 <= len;) {
      if (d[p] !== 0xff || (d[p + 1] & 0xf0) !== 0xf0) { p++; continue; }
      const hl = d[p + 1] & 1 ? 7 : 9, fl = ((d[p + 3] & 3) << 11) | (d[p + 4] << 3) | (d[p + 5] >> 5);
      if (fl < hl || p + fl > len) break;
      if (!info) info = { obj: ((d[p + 2] >> 6) & 3) + 1, fi: (d[p + 2] >> 2) & 15, ch: ((d[p + 2] & 1) << 2) | (d[p + 3] >> 6) };
      S.push({ size: fl - hl, dur: 1024, cts: 0, key: true, data: d.subarray(p + hl, p + fl) });
      p += fl;
    }
    if (!S.length || !AAC_RATES[info.fi]) throw new Error("Unsupported audio.");
    const rate = AAC_RATES[info.fi], cfg = (info.obj << 11) | (info.fi << 7) | (info.ch << 3);
    const esds = FB("esds", 0, 0, [0x03, 0x19, 0, 0, 0, 0x04, 0x11, 0x40, 0x15, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x05, 0x02, cfg >> 8, cfg & 255, 0x06, 0x01, 0x02]);
    const mp4a = Bx("mp4a", new Array(6).fill(0), be16(1), new Array(8).fill(0), be16(info.ch || 2), be16(16), be16(0), be16(0), be32(rate * 65536), esds);
    const first = pes.find((p) => p.pts != null);
    return { video: false, timescale: rate, stsd: FB("stsd", 0, 0, be32(1), mp4a), samples: S, startPts: first ? first.pts / 90000 : 0, mediaTime: 0 };
  }

  function tsToMp4(vBuf, aBuf) {
    const vs = findSync(vBuf), vst = parseStreams(vBuf, vs), v = vst.find((s) => isVideo(s.type));
    if (!v || v.type !== 0x1b) throw new Error("Video is not H.264.");
    let ab = aBuf || vBuf, as = aBuf ? findSync(aBuf) : vs;
    const a = (aBuf ? parseStreams(aBuf, as) : vst).find((s) => isAudio(s.type));
    if (a && a.type !== 0x0f) throw new Error("Audio is not AAC.");
    const tracks = [videoTrackFromTs(vBuf, vs, v.pid)];
    if (a) tracks.push(audioTrackFromTs(ab, as, a.pid));
    return buildMp4(tracks);
  }

  // ---- fragmented MP4 -> progressive MP4 ----
  function fmp4Track(b) {
    const top = boxes(b), moov = top.find((x) => x.t === "moov");
    const traks = moov ? kids(b, moov).filter((x) => x.t === "trak") : [];
    if (traks.length !== 1) throw new Error("Unsupported fMP4 layout.");
    const trak = traks[0], mdia = kid(b, trak, "mdia"), mdhd = kid(b, mdia, "mdhd"), hdlr = kid(b, mdia, "hdlr"), tkhd = kid(b, trak, "tkhd");
    if (b[mdhd.s + mdhd.h] !== 0) throw new Error("mdhd v1 unsupported.");
    const timescale = u32(b, mdhd.s + mdhd.h + 12);
    const video = String.fromCharCode(...b.subarray(hdlr.s + hdlr.h + 8, hdlr.s + hdlr.h + 12)) === "vide";
    const stsdB = kid(b, kid(b, kid(b, mdia, "minf"), "stbl"), "stsd");
    const mvex = kid(b, moov, "mvex"), trex = mvex && kids(b, mvex).find((x) => x.t === "trex");
    const dd = trex ? u32(b, trex.s + trex.h + 12) : 0, ds = trex ? u32(b, trex.s + trex.h + 16) : 0, df = trex ? u32(b, trex.s + trex.h + 20) : 0;
    const samples = []; let dts0 = null;
    for (const moof of top.filter((x) => x.t === "moof")) {
      const traf = kid(b, moof, "traf"), tfhd = kid(b, traf, "tfhd"), tfdt = kid(b, traf, "tfdt");
      const fl = u32(b, tfhd.s + tfhd.h) & 0xffffff; let p = tfhd.s + tfhd.h + 8;
      if (fl & 1) p += 8; if (fl & 2) p += 4;
      let fdur = dd, fsize = ds, fflags = df;
      if (fl & 8) { fdur = u32(b, p); p += 4; } if (fl & 0x10) { fsize = u32(b, p); p += 4; } if (fl & 0x20) { fflags = u32(b, p); p += 4; }
      if (dts0 === null && tfdt) { const q = tfdt.s + tfdt.h; dts0 = b[q] === 1 ? u32(b, q + 4) * 4294967296 + u32(b, q + 8) : u32(b, q + 4); }
      for (const trun of kids(b, traf).filter((x) => x.t === "trun")) {
        const ver = b[trun.s + trun.h], tf = u32(b, trun.s + trun.h) & 0xffffff, n = u32(b, trun.s + trun.h + 4);
        let q = trun.s + trun.h + 8, pos = moof.s, first = null;
        if (tf & 1) { pos = moof.s + (u32(b, q) | 0); q += 4; }
        if (tf & 4) { first = u32(b, q); q += 4; }
        for (let i = 0; i < n; i++) {
          const dur = tf & 0x100 ? u32(b, (q += 4) - 4) : fdur, size = tf & 0x200 ? u32(b, (q += 4) - 4) : fsize;
          let flags = tf & 0x400 ? u32(b, (q += 4) - 4) : i === 0 && first !== null ? first : fflags;
          const cts = tf & 0x800 ? (ver === 0 ? u32(b, (q += 4) - 4) : u32(b, (q += 4) - 4) | 0) : 0;
          samples.push({ size, dur, cts: Math.max(0, cts), key: !(flags & 0x10000), data: b.subarray(pos, pos + size) });
          pos += size;
        }
      }
    }
    if (!samples.length) throw new Error("No samples.");
    return { video, timescale, width: u32(b, tkhd.e - 8) >>> 16, height: u32(b, tkhd.e - 4) >>> 16, stsd: b.subarray(stsdB.s, stsdB.e),
      samples, startPts: ((dts0 || 0) + samples[0].cts) / timescale, mediaTime: video ? samples[0].cts : 0 };
  }
  function fmp4ToMp4(vBuf, aBuf) {
    const v = fmp4Track(vBuf), a = fmp4Track(aBuf);
    if (!v.video || a.video) throw new Error("Unexpected track types.");
    return buildMp4([v, a]);
  }

  const api = { mergeTs, mergeFmp4, tsToMp4, fmp4ToMp4 };
  if (typeof module !== "undefined") module.exports = api; else root.Merge = api;
})(typeof self !== "undefined" ? self : globalThis);
