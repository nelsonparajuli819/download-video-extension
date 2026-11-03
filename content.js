// Reports <video>/<source> URLs found in the DOM (catches cached requests too).
const seen = new Set();
function scan() {
  document.querySelectorAll("video, video source, audio").forEach((el) => {
    const src = el.currentSrc || el.src;
    if (src && /^https?:/.test(src) && !seen.has(src)) {
      seen.add(src);
      chrome.runtime.sendMessage({ type: "dom-found", url: src, pageTitle: document.title });
    }
  });
}
scan();
setInterval(scan, 3000);
