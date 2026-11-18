// The print view's page (ADR 0144, rule 4), in a hidden window of its own. Its preload hands it the
// thread, which main checked; the page takes none of that on trust. It reads the thread's shape
// again, builds its own nodes with the names, addresses and lines of text put in as text, and
// sanitizes each letter's HTML again with the reader's own `sanitizeMail` right before it fills
// the letter's sandboxed frame with its light view. Then it says it is ready. It fetches nothing
// itself: the frames are the reader's pages, with the reader's policy (ADR 0024).
import { type PrintDocument, readPrintDocument } from "@matters/contracts";
import { fitMailFrame } from "./mailFit.ts";
import { type CleanMail, sanitizeMail } from "./mailHtml.ts";
import { mailBaseStyle } from "./mailTheme.ts";
import {
  framePage,
  lightHtml,
  PRINT_FRAME_SANDBOX,
  type PrintNode,
  printNodes,
} from "./printDocument.ts";
import "./print.css";

/** Images a sender's page asks for are waited for this long at most: printing does not hang on them. */
const IMAGE_WAIT_MS = 5000;
/** The width main lays a thread out at is a sheet's; anything outside this is not one. */
const MAX_WIDTH_PX = 4000;

/** The base style `sanitizeMail` puts first; it is put first again, not twice. */
const BASE_STYLE = mailBaseStyle();

/**
 * A letter's HTML sanitized again, as the reader's frame gets it. The mail window sanitized it
 * on the reader's screen, so its media questions are already answered and asking them again here
 * changes nothing (the hidden window's screen is not asked).
 */
function sanitizeAgain(html: string): CleanMail {
  return sanitizeMail(html.startsWith(BASE_STYLE) ? html.slice(BASE_STYLE.length) : html);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frameTick = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** One node as an element: its text as text, its class and label, a frame's attributes our own. */
function element(node: PrintNode): HTMLElement {
  if (node.tag === "iframe") {
    const frame = document.createElement("iframe");
    frame.dataset.printFrame = String(node.frame);
    frame.title = "Message as sent";
    frame.setAttribute("sandbox", PRINT_FRAME_SANDBOX);
    frame.src = framePage(node.images);
    return frame;
  }
  const el = document.createElement(node.tag);
  if (node.className !== undefined) el.className = node.className;
  if (node.label !== undefined) el.setAttribute("aria-label", node.label);
  if (node.text !== undefined) el.textContent = node.text;
  for (const child of node.children ?? []) el.append(element(child));
  return el;
}

async function fill(frame: HTMLIFrameElement, clean: CleanMail): Promise<void> {
  if (
    frame.contentDocument?.readyState !== "complete" ||
    frame.contentDocument.URL === "about:blank"
  ) {
    await new Promise<void>((r) => frame.addEventListener("load", () => r(), { once: true }));
  }
  const doc = frame.contentDocument;
  if (!doc) return;
  doc.documentElement.innerHTML = lightHtml(clean);
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
  // Sanitized again here, in the page that shows it: whether a letter asks for images is read from
  // this, for its line about blocked images.
  const cleans = doc.letters.map((l) =>
    l.body.kind === "html" ? sanitizeAgain(l.body.html) : null,
  );
  const nodes = printNodes(doc, (index) => cleans[index]?.hasRemoteContent === true);
  document.body.replaceChildren(...nodes.map(element));
  const frames = [...document.querySelectorAll<HTMLIFrameElement>("iframe[data-print-frame]")];
  await Promise.all(
    frames.map((frame) => {
      const clean = cleans[Number(frame.dataset.printFrame)];
      return clean ? fill(frame, clean) : Promise.resolve();
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

/** The thread and its width as the preload posts them; null for anything else. */
function readAsk(data: unknown): { doc: PrintDocument; widthPx: number } | null {
  if (typeof data !== "object" || data === null || !("mattersPrintDocument" in data)) return null;
  const ask: unknown = data.mattersPrintDocument;
  if (typeof ask !== "object" || ask === null || !("doc" in ask) || !("widthPx" in ask)) {
    return null;
  }
  const { widthPx } = ask;
  if (typeof widthPx !== "number" || !Number.isInteger(widthPx)) return null;
  if (widthPx <= 0 || widthPx > MAX_WIDTH_PX) return null;
  const doc = readPrintDocument(ask.doc);
  return doc === null ? null : { doc, widthPx };
}

// To the preload, in this same window; it reads two booleans and nothing else.
const ready = (ok: boolean, scriptRan: boolean) =>
  window.postMessage({ mattersPrintReady: { ok, scriptRan } }, "*");

/**
 * The origin a message posted by this page says it came from: its own, or "null" for a page
 * loaded from a file (as a built app's is), whose origin is opaque.
 */
const ownOrigin = () => (window.location.protocol === "file:" ? "null" : window.location.origin);

let rendering = false;

window.addEventListener("message", (event) => {
  // Only this page's own window, from its own origin: the preload. Never a frame, never another.
  if (event.source !== window || event.origin !== ownOrigin()) return;
  const data: unknown = event.data;
  if (typeof data !== "object" || data === null || !("mattersPrintDocument" in data)) return;
  const ask = readAsk(data);
  // One thread per window: main makes a window for each job.
  if (ask === null || rendering) {
    if (ask === null) ready(false, false);
    return;
  }
  rendering = true;
  void render(ask.doc, ask.widthPx).then(
    () => {
      // A corpus run reads whether anything in a message ran here (ADR 0047): its payloads set it.
      const ran = Boolean((window as unknown as { __pwned?: unknown }).__pwned);
      ready(true, ran);
    },
    () => ready(false, false),
  );
});
