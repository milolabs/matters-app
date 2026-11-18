// The preload of the print view's hidden window (ADR 0144, rule 4). It exposes nothing: main hands
// it the thread, which it passes to the page, and it tells main when the page is ready. Main reads
// two booleans from that and nothing else.
import { ipcRenderer } from "electron";

// The names of `printShapes.ts`, written out: a module shared with the mail window's preload would
// be built as a chunk of its own, which a sandboxed preload cannot load.
const CHANNEL_PRINT_DOCUMENT = "matters:print-document";
const CHANNEL_PRINT_READY = "matters:print-ready";

ipcRenderer.on(CHANNEL_PRINT_DOCUMENT, (_event, data: unknown) => {
  window.postMessage({ mattersPrintDocument: data }, "*");
});

window.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (event.source !== window || typeof data !== "object" || data === null) return;
  if (!("mattersPrintReady" in data)) return;
  const ready = data.mattersPrintReady as { ok?: unknown; scriptRan?: unknown } | null;
  ipcRenderer.send(CHANNEL_PRINT_READY, {
    ok: ready?.ok === true,
    scriptRan: ready?.scriptRan === true,
  });
});
