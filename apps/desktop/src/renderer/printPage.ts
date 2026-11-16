// The print view's page (ADR 0144, rule 4), in a hidden window of its own. Its preload hands it the
// thread, which main checked; it lays it out as text of its own and fills each letter's sandboxed
// frame with the HTML the reader shows, then says it is ready. It fetches nothing itself: the
// frames are the reader's pages, with the reader's policy (ADR 0024).
import type { PrintDocument } from "@matters/contracts";
import { fitMailFrame } from "./mailFit.ts";
import { printMarkup } from "./printDocument.ts";
import "./print.css";

/** Images a sender's page asks for are waited for this long at most: printing does not hang on them. */
const IMAGE_WAIT_MS = 5000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frameTick = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

async function fill(frame: HTMLIFrameElement, html: string): Promise<void> {
  if (
    frame.contentDocument?.readyState !== "complete" ||
    frame.contentDocument.URL === "about:blank"
  ) {
    await new Promise<void>((r) => frame.addEventListener("load", () => r(), { once: true }));
  }
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.documentElement.innerHTML = html;
  fitMailFrame(frame, doc);
}

/** Until every image of every frame has loaded or failed (none load where they are blocked). */
async function imagesSettled(frames: readonly HTMLIFrameElement[]): Promise<void> {
  const until = performance.now() + IMAGE_WAIT_MS;
  while (performance.now() < until) {
    const waiting = frames.some((f) =>
      [...(f.contentDocument?.images ?? [])].some((img) => !img.complete),
    );
    if (!waiting) return;
    await sleep(50);
  }
}

async function render(doc: PrintDocument, widthPx: number): Promise<void> {
  document.title = doc.title;
  document.body.style.width = `${widthPx}px`;
  document.body.innerHTML = printMarkup(doc);
  const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-print-frame]")];
  await Promise.all(
    frames.map((frame) => {
      const letter = doc.letters[Number(frame.dataset.printFrame)];
      return letter?.body.kind === "html" ? fill(frame, letter.body.html) : Promise.resolve();
    }),
  );
  await imagesSettled(frames);
  await document.fonts.ready;
  for (const frame of frames) {
    if (frame.contentDocument) fitMailFrame(frame, frame.contentDocument);
  }
  await frameTick();
  await frameTick();
}

window.addEventListener("message", (event) => {
  const data: unknown = event.data;
  if (event.source !== window || typeof data !== "object" || data === null) return;
  if (!("mattersPrintDocument" in data)) return;
  const { doc, widthPx } = data.mattersPrintDocument as { doc: PrintDocument; widthPx: number };
  void render(doc, widthPx).then(
    () => {
      // A corpus run reads whether anything in a message ran here (ADR 0047): its payloads set it.
      const ran = Boolean((window as unknown as { __pwned?: unknown }).__pwned);
      window.postMessage({ mattersPrintReady: { ok: true, scriptRan: ran } }, "*");
    },
    () => window.postMessage({ mattersPrintReady: { ok: false, scriptRan: false } }, "*"),
  );
});
