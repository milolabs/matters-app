// Launch trace, page side (see ../backend/trace.ts). Active only when main opened the page with
// `?trace=1`, which it does in a dev build when the benchmark asked for it; the preload then
// forwards the marks to main. In every other run `mark` is a no-op.
const on =
  typeof location !== "undefined" && new URLSearchParams(location.search).get("trace") === "1";

export const tracing = on;

/** Records a phase on the shared epoch clock. */
export function mark(name: string): void {
  if (!on) return;
  window.postMessage(
    { mattersTrace: { name, epochMs: performance.timeOrigin + performance.now() } },
    "*",
  );
}

/** Marks the browser's own paint events and the first frame that shows list rows. */
export function traceRows(): void {
  if (!on) return;
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      window.postMessage(
        {
          mattersTrace: {
            name: entry.name,
            epochMs: performance.timeOrigin + entry.startTime,
          },
        },
        "*",
      );
    }
  }).observe({ type: "paint", buffered: true });
  // The frame in which a row is on screen: the Element Timing API reports when the first frame
  // containing the element was presented (`renderTime`), which a requestAnimationFrame callback
  // cannot say (it runs before that frame is drawn). The attribute is added the moment the first
  // row enters the DOM, before that frame is produced.
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const at =
        (entry as PerformanceEntry & { renderTime?: number }).renderTime || entry.startTime;
      window.postMessage(
        { mattersTrace: { name: "rows-painted", epochMs: performance.timeOrigin + at } },
        "*",
      );
    }
  }).observe({ type: "element", buffered: true });
  const tag = () => {
    const row = document.querySelector("[data-row]");
    if (!row) return false;
    // Element Timing reports elements that hold text nodes of their own: take the first one.
    const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let text = walker.nextNode();
    while (text && !(text.textContent ?? "").trim()) text = walker.nextNode();
    const target = text?.parentElement;
    if (!target) return false;
    target.setAttribute("elementtiming", "first-row");
    mark("rows-in-dom");
    return true;
  };
  if (tag()) return;
  const observer = new MutationObserver(() => {
    if (tag()) observer.disconnect();
  });
  observer.observe(document, { childList: true, subtree: true });
}

// The first module of the page to run (main.tsx imports this file first).
mark("renderer-script-start");
