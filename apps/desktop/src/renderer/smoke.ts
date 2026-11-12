import { NEEDS_YOU_VIEW } from "@matters/core";
import DOMPurify from "dompurify";
import { createComponent, createSignal } from "solid-js";
import { render } from "solid-js/web";
import type { AccountsStore } from "./accounts.ts";
import type { AgentStore } from "./agent.ts";
import { Choice } from "./agentConnect.tsx";
import { askTheAgent } from "./agentTalk.tsx";
import type { Backend } from "./client.ts";
import type { ComposeStore } from "./compose.ts";
import { HEAD_HEIGHT, layoutList, ROW_HEIGHT } from "./listLayout.ts";
import { LIST_DEFAULT, LIST_MAX, LIST_MIN } from "./listWidth.ts";
import { MAIL_FRAME_SANDBOX, MailFrame } from "./mailFrame.tsx";
import { sanitizeMail } from "./mailHtml.ts";
import type { MailStore } from "./store.ts";
import type { ViewsStore } from "./views.ts";

const QUERIES = [
  "faktura",
  "zażółć gęślą",
  "from:wiśniewska",
  "label:praca spotkanie",
  "bilet kraków",
];

const frame = () => new Promise<number>((r) => requestAnimationFrame(() => r(performance.now())));

async function waitForRows(): Promise<void> {
  for (let i = 0; i < 300 && !document.querySelector("[data-row]"); i++) await frame();
}

const OPEN_SAMPLES = 5;

/** Resolves once the reading pane shows `threadId` with at least one non-empty body. */
function waitForThread(threadId: string): Promise<{ at: number; bodyChars: number }> {
  const pane = document.querySelector("section[aria-label=Thread]");
  if (!pane) throw new Error("reading pane missing");
  return new Promise((resolve, reject) => {
    const check = () => {
      const article = pane.querySelector(`article[data-thread-id="${CSS.escape(threadId)}"]`);
      const bodies = article?.querySelectorAll("[data-body]") ?? [];
      const bodyChars = [...bodies].reduce((n, b) => n + (b.textContent ?? "").length, 0);
      if (bodies.length === 0 || bodyChars === 0) return false;
      observer.disconnect();
      clearTimeout(timer);
      resolve({ at: performance.now(), bodyChars });
      return true;
    };
    const observer = new MutationObserver(check);
    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`thread ${threadId} was not painted within 2 s`));
    }, 2000);
    observer.observe(pane, { childList: true, subtree: true, characterData: true });
    check();
  });
}

/** An index whose message starts a different thread than its predecessor's, from `from` on. */
function findThreadStart(store: MailStore, from: number): number {
  const messages = store.messages();
  for (let i = Math.max(from, 1); i < messages.length; i++) {
    if (messages[i]?.threadId !== messages[i - 1]?.threadId) return i;
  }
  return -1;
}

/**
 * Parks on a message, presses `j` onto the next one of a different thread and times
 * keystroke -> body in the DOM -> next frame. Reads the list as it is now, so it also works
 * while mail is arriving.
 */
async function measureOpenOnce(store: MailStore, from: number) {
  const target = findThreadStart(store, from);
  if (target < 0) throw new Error("not enough distinct threads to sample");
  // Park on the previous row (untimed) so a single `j` opens the target thread.
  store.select(target - 1);
  const parked = store.messages()[store.selected()];
  if (!parked) throw new Error("nothing to park on");
  await waitForThread(parked.threadId);
  await frame();

  const next = store.messages()[store.selected() + 1];
  if (!next || next.threadId === parked.threadId) return null;
  const start = performance.now();
  const painted = waitForThread(next.threadId);
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "j", bubbles: true }));
  const { at, bodyChars } = await painted;
  const frameMs = (await frame()) - start;
  return {
    threadId: next.threadId,
    bodyChars,
    workMs: Math.round((at - start) * 100) / 100,
    frameMs: Math.round(frameMs * 100) / 100,
  };
}

async function measureOpenThread(store: MailStore, from = 1) {
  const out = [];
  let at = from;
  while (out.length < OPEN_SAMPLES) {
    const sample = await measureOpenOnce(store, at);
    if (sample) out.push(sample);
    at = findThreadStart(store, at) + 1;
    if (at <= 0) throw new Error("not enough distinct threads to sample");
  }
  return out;
}

/**
 * ADR 0078, as ADR 0099 left it: every row of the list carries an avatar with letters; an opened
 * thread leads with its subject, and each open letter names its sender in its own header (avatar,
 * name, and the line of whom it went to), after the subject.
 */
async function measureSenderHead(store: MailStore) {
  await frame();
  const rows = [...document.querySelectorAll<HTMLElement>("[data-row]")];
  const withAvatar = rows.filter((r) => {
    const a = r.querySelector<HTMLElement>("[data-row-avatar] .avatar");
    return a !== null && (a.dataset.initials ?? "") !== "";
  }).length;
  const target = findThreadStart(store, 1);
  if (target < 0) throw new Error("not enough distinct threads to check the header");
  store.select(target - 1);
  await frame();
  const row = store.messages()[target];
  if (!row) throw new Error("no thread for the sender header");
  store.select(target);
  await waitForThread(row.threadId);
  await frame();
  const article = document.querySelector(`article[data-thread-id="${CSS.escape(row.threadId)}"]`);
  const section = article?.querySelector<HTMLElement>("section[data-letter-key]");
  const head = section?.querySelector<HTMLElement>("[data-letter-head]");
  const avatar = section?.querySelector<HTMLElement>(".avatar");
  const name = head?.querySelector<HTMLElement>("[data-sender-name]")?.textContent?.trim() ?? "";
  const title = article?.querySelector("h2");
  const before =
    head !== undefined && head !== null && title
      ? (head.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_PRECEDING) !== 0
      : false;
  const line = head?.querySelector<HTMLElement>("button[aria-expanded]");
  const box = avatar?.getBoundingClientRect();
  // The line fills in when the index answers; its box must not change when it does.
  const lineHeight = line?.getBoundingClientRect().height ?? 0;
  await new Promise((r) => setTimeout(r, 300));
  const settledHeight = line?.getBoundingClientRect().height ?? -1;
  return {
    rows: rows.length,
    rowsWithAvatar: withAvatar,
    headPresent: head !== null && head !== undefined,
    avatarSize: box ? Math.round(box.width) : 0,
    avatarLetters: avatar?.dataset.initials ?? "",
    name,
    afterSubject: before,
    lineText: line?.textContent ?? "",
    lineHeightStable: lineHeight === settledHeight && lineHeight > 0,
  };
}

/**
 * Picking another row of the open thread goes to that letter: it opens, and the reader scrolls so
 * the letter's top is in view. The letter starts folded or off screen, so the check means something:
 * before, the reader stayed as it was because the thread was already open.
 */
async function measureRowToLetter(store: MailStore) {
  const result = { found: false, startedHidden: false, opened: false, inView: false };
  const pane = document.querySelector<HTMLElement>("section[aria-label=Thread]");
  if (!pane) return result;
  const list = store.messages();
  const pairs: [number, number][] = [];
  for (let i = 0; i < list.length && pairs.length < 20; i++) {
    for (let j = i + 1; j < list.length; j++) {
      if (list[j]?.threadId === list[i]?.threadId && list[j]?.flags.seen) pairs.push([i, j]);
    }
  }
  for (const [first, second] of pairs) {
    const a = list[first];
    const b = list[second];
    if (!a || !b) continue;
    store.select(first);
    await waitForThread(a.threadId);
    await frame();
    const scroller = pane
      .querySelector<HTMLElement>("[data-letter-key]")
      ?.closest<HTMLElement>(".overflow-y-auto, .overflow-auto");
    if (!scroller) continue;
    const sectionOf = () => pane.querySelector<HTMLElement>(`[data-letter-key="${b.key}"]`);
    const shows = () => {
      const box = sectionOf()?.getBoundingClientRect();
      const view = scroller.getBoundingClientRect();
      return box !== undefined && box.top >= view.top - 1 && box.top < view.bottom;
    };
    const isOpen = () => sectionOf()?.querySelector("[data-body]") != null;
    // Put the letter out of sight: scroll to the end away from it.
    const box = sectionOf()?.getBoundingClientRect();
    const middle = scroller.getBoundingClientRect().top + scroller.clientHeight / 2;
    scroller.scrollTo({ top: box !== undefined && box.top < middle ? scroller.scrollHeight : 0 });
    await frame();
    if (shows() && isOpen()) continue;
    result.found = true;
    result.startedHidden = true;
    store.select(second);
    for (let i = 0; i < 4; i++) await frame();
    result.opened = isOpen();
    result.inView = shows();
    return result;
  }
  return result;
}

const MARK_SAMPLES = 5;

/**
 * ADR 0039: `u` on an unread row marks its thread read in the next frame (ADR 0012: one frame)
 * without folding, reloading or moving anything in the open thread, and `u` on the read row marks
 * only that message unread. The state must survive the round trip through the worker.
 */
async function measureMarkRead(store: MailStore) {
  const frames: number[] = [];
  let letterNodesKept = true;
  let stayedRead = true;
  let unreadAgain = true;
  const press = () =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "u", bubbles: true }));
  const unreadRows = () =>
    store
      .messages()
      .flatMap((m, i) => (m.flags.seen ? [] : [i]))
      .slice(0, MARK_SAMPLES * 3);
  for (const index of unreadRows()) {
    if (frames.length >= MARK_SAMPLES) break;
    const row = store.messages()[index];
    if (!row || row.flags.seen) continue;
    store.select(index);
    await waitForThread(row.threadId);
    await frame();
    // `select` is the reader's choice; the countdown that reads the thread must not be what we time.
    const article = document.querySelector(`article[data-thread-id="${CSS.escape(row.threadId)}"]`);
    const bodies = [...(article?.querySelectorAll("[data-body]") ?? [])];

    const start = performance.now();
    press();
    const marked = store.messages()[store.selected()]?.flags.seen === true;
    const at = await frame();
    const unreadMark = document.querySelector("[data-row][aria-selected=true] .sr-only");
    if (!marked || unreadMark?.textContent === "Unread") {
      throw new Error("the row was not marked read in the next frame");
    }
    frames.push(at - start);

    // The write goes to the worker and comes back as an event; nothing in the thread may react.
    await new Promise((r) => setTimeout(r, 400));
    const same = document.querySelector(`article[data-thread-id="${CSS.escape(row.threadId)}"]`);
    if (same !== article || bodies.some((b) => !b.isConnected)) letterNodesKept = false;
    if (store.messages()[store.selected()]?.flags.seen !== true) stayedRead = false;

    // The row is read now, so `u` marks that message unread again and the thread stays put.
    press();
    await new Promise((r) => setTimeout(r, 400));
    if (store.messages()[store.selected()]?.flags.seen !== false) unreadAgain = false;
  }
  if (frames.length === 0) throw new Error("no unread mail to mark");
  return {
    frameMs: frames.map((f) => Math.round(f * 100) / 100),
    letterNodesKept,
    stayedRead,
    unreadAgain,
  };
}

const ARCHIVE_SAMPLES = 10;

/**
 * ADR 0044, rules 9 and 10: `e` in the Inbox tab takes the thread's rows out of the list, selects the
 * next one and puts the line in the tray in the next frame; ⌘Z brings the thread back. Each sample
 * is undone inside its window, so nothing leaves the account.
 */
async function measureArchive(store: MailStore, views?: ViewsStore) {
  const frames: number[] = [];
  let lineShown = true;
  let selectedNext = true;
  let restored = true;
  const press = (init: KeyboardEventInit) =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, ...init }));
  // The Inbox tab's digit: the view, not the store, owns the query text. It is the second tab
  // unless a view went in front of it (`Needs you`, ADR 0117, rule 2, on a run after AI was on).
  // The text changes at once and the list only when the answer is in, so it is the answer that
  // is awaited: a row read before it is a row of the list being replaced.
  const inbox = views?.views().findIndex((v) => v.query === "in:inbox") ?? -1;
  let settled = false;
  const stop = store.onSettled((query) => {
    if (query === "in:inbox") settled = true;
  });
  press({ key: String(inbox >= 0 && inbox < 9 ? inbox + 1 : 2) });
  await until(() => settled && store.messages().length > ARCHIVE_SAMPLES * 2, 10_000);
  stop();
  await frame();
  for (let n = 0; n < ARCHIVE_SAMPLES; n++) {
    const row = store.messages()[store.selected()];
    if (!row) break;
    await waitForThread(row.threadId);
    await frame();
    const rows = store.messages().filter((m) => m.threadId !== row.threadId);

    const start = performance.now();
    press({ key: "e" });
    // The list is already changed here, before any await: nothing was asked of the backend yet.
    const gone = !store.messages().some((m) => m.threadId === row.threadId);
    if (!gone || store.messages().length !== rows.length) selectedNext = false;
    const at = await frame();
    if (document.querySelector("[data-move]") === null) lineShown = false;
    frames.push(at - start);

    press({ key: "z", metaKey: true });
    const back = await until(() => store.messages().some((m) => m.threadId === row.threadId), 5000);
    if (!back) restored = false;
    await until(() => document.querySelector("[data-move]") === null, 3000);
    await frame();
  }
  press({ key: "1" });
  await until(() => store.query() === "", 5000);
  await frame();
  if (frames.length === 0) throw new Error("no thread to archive");
  return {
    frameMs: frames.map((f) => Math.round(f * 100) / 100),
    lineShown,
    selectedNext,
    restored,
  };
}

const COMPOSER_SAMPLES = 30;

/**
 * ADR 0020: opens a reply with the real key (`r`), shows the preview next to the editor, types
 * into the editor through the browser's own text input path and times keystroke -> the preview
 * frame painted with that text. Also checks that the editor and the frame cost no CSP violation
 * (the frame's own are collected here) and that Escape keeps nothing the user did not touch.
 */
async function measureComposer(store: MailStore, compose: ComposeStore, violations: string[]) {
  // Park on a thread with a message that is not the user's own, then press `r`.
  const target = findThreadStart(store, 1);
  if (target < 0) throw new Error("no thread to reply to");
  store.select(target);
  const message = store.messages()[store.selected()];
  if (!message) throw new Error("nothing selected");
  await waitForThread(message.threadId);
  await frame();
  // The first reply of the run: the editor's chunk was only preloaded (ADR 0046, rule 3), so this is
  // the first-use cost the budget holds to.
  const openStart = performance.now();
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true }));
  // The editor lives in a shadow root.
  const editor = () =>
    document.querySelector<HTMLElement>("[data-composer] [data-editor]")?.shadowRoot ?? null;
  await until(() => editor()?.querySelector(".cm-content") != null, 3000);
  const content = editor()?.querySelector<HTMLElement>(".cm-content");
  if (!content) throw new Error(`the composer did not open: ${compose.problem() || "no reason"}`);
  const openMs = Math.round((performance.now() - openStart) * 100) / 100;
  // ADR 0100, rule 4: the quote of the answered message is in the draft (it is sent as before), is
  // folded to "···" when the reply opens, and opens on a click.
  const quoteInDraft = /wrote:\s*\n+\s*>/.test(compose.session()?.body() ?? "");
  const toggle = () => content.querySelector<HTMLButtonElement>(".cm-quote-toggle");
  const quoteFolded =
    toggle()?.getAttribute("aria-expanded") === "false" &&
    !(content.textContent ?? "").includes("wrote:");
  toggle()?.click();
  const quoteOpens = await until(
    () =>
      (content.textContent ?? "").includes("wrote:") &&
      toggle()?.getAttribute("aria-expanded") === "true",
    2000,
  );
  toggle()?.click();
  await until(() => toggle()?.getAttribute("aria-expanded") === "false", 2000);
  const quoted = quoteInDraft && quoteFolded && quoteOpens;
  const quoteDetail = quoted
    ? ""
    : `in the draft ${quoteInDraft}, folded ${quoteFolded}, opens on a click ${quoteOpens}`;

  // A reply opens under its thread (ADR 0100); the preview is in the full composer.
  document.querySelector<HTMLButtonElement>("[aria-label='Open the full composer']")?.click();
  await until(() => document.querySelector("[data-view=both]") !== null, 3000);
  document.querySelector<HTMLButtonElement>("[data-view=both]")?.click();
  const frameEl = document.querySelector<HTMLIFrameElement>("[data-preview] iframe");
  if (!frameEl) throw new Error("the preview frame is missing");
  if (!(await until(() => frameEl.dataset.painted !== undefined, 3000))) {
    throw new Error("the preview was never painted");
  }
  const doc = frameEl.contentDocument;
  if (!doc) throw new Error("the preview frame has no document");
  doc.addEventListener("securitypolicyviolation", (e) =>
    violations.push(`preview ${e.violatedDirective} ${e.blockedURI}`),
  );

  // Typing goes through the real input path of the editor, one character at a time.
  content.focus();
  const word = "zażółćgęśląjaźńQWERTYUIOPASDFGHJKL".slice(0, COMPOSER_SAMPLES);
  const samples: { workMs: number; frameMs: number }[] = [];
  let typed = "";
  for (const ch of word) {
    typed += ch;
    const painted = new Promise<number>((resolve, reject) => {
      const timer = setTimeout(() => {
        observer.disconnect();
        reject(new Error(`"${typed}" never reached the preview`));
      }, 2000);
      const check = () => {
        if (!(doc.body?.textContent ?? "").includes(typed)) return false;
        observer.disconnect();
        clearTimeout(timer);
        resolve(performance.now());
        return true;
      };
      const observer = new MutationObserver(check);
      observer.observe(doc, { childList: true, subtree: true, characterData: true });
    });
    const start = performance.now();
    document.execCommand("insertText", false, ch);
    const at = await painted;
    const frameMs = (await frame()) - start;
    samples.push({
      workMs: Math.round((at - start) * 100) / 100,
      frameMs: Math.round(frameMs * 100) / 100,
    });
    await new Promise((r) => setTimeout(r, 30));
  }
  const html = doc.documentElement.innerHTML;
  const styled = /<p style="[^"]+"/.test(html);
  const polish = (doc.body?.textContent ?? "").includes("zażółć");

  // A developer can ask main for a picture of this moment (MATTERS_SMOKE_SHOT).
  window.postMessage({ mattersSmokeSignal: "shot" }, "*");
  await new Promise((r) => setTimeout(r, 500));

  // Escape closes it; the text was typed, so the draft is kept.
  content.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const closed = await until(() => document.querySelector("[data-composer]") === null, 3000);
  return { samples, quoted, quoteDetail, styled, polish, closed, openMs };
}

const ATTACH_FILES = 3;
const ATTACH_FILE_BYTES = 40_000_000;
const ATTACH_KEY_SAMPLES = 24;

/**
 * ADR 0041: files over the window, and 120 MB attached through the real pipeline. The drag is
 * synthetic (a real one needs the operating system), so only its page-side effects are checked:
 * one class, an overlay that shows, frames that stop taking the pointer, and no change at all on
 * `dragover`. The files are pasted images (the one way in a page can drive, as main grants a
 * paste), so each goes page -> preload -> main (private temp file, grant) -> router -> attachment
 * worker, the path of a dropped file. A pasted image is refused over 50 MB, hence three of 40 MB.
 * Measured: the chips in the frame of the call, and `j` / `k` while the copies run.
 */
async function measureAttach(store: MailStore, compose: ComposeStore, backend: Backend) {
  const overlay = await checkDragOverlay();
  // The first round warms the allocators and the worker up (the process keeps what it freed);
  // the second is held to the memory budget. Both are reported.
  const warm = await attachRound(store, compose, backend, "round1");
  const round = await attachRound(store, compose, backend, "round2");
  return {
    ...overlay,
    ...round,
    keyFrameMs: [...warm.keyFrameMs, ...round.keyFrameMs],
    keysDuringCopy: warm.keysDuringCopy + round.keysDuringCopy,
    warmupChipFrameMs: warm.chipFrameMs,
  };
}

/** 120 MB pasted into a new message, closed over, copied in the background, then deleted. */
async function attachRound(
  store: MailStore,
  compose: ComposeStore,
  backend: Backend,
  label: string,
) {
  document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "c", bubbles: true }));
  if (!(await until(() => compose.session() !== null, 3000))) {
    throw new Error(`the composer did not open: ${compose.problem() || "no reason"}`);
  }
  const session = compose.session();
  if (!session) throw new Error("no composer");
  const files = Array.from(
    { length: ATTACH_FILES },
    (_, i) =>
      new File([new Uint8Array(ATTACH_FILE_BYTES + i)], `shot-${i}.png`, { type: "image/png" }),
  );

  // The copies run on the attachment thread: watch the rows for the end.
  let settled = false;
  let settledAt = 0;
  const off = backend.onEvent((event) => {
    if (event.type !== "attachments" || event.draftId !== session.draft()?.id) return;
    const rows = event.attachments;
    if (rows.length >= ATTACH_FILES && rows.every((r) => r.state !== "reading")) {
      settled = true;
      settledAt = performance.now();
    }
  });

  // Main samples the backend's memory between these two signals.
  window.postMessage({ mattersSmokeSignal: `memory-start:${label}` }, "*");
  await new Promise((r) => setTimeout(r, 60));
  const start = performance.now();
  const pasting = session.pasteImages(files);
  // Nothing was awaited yet: the chips are in the page already.
  // The files are counted in the header (ADR 0101); their chips are in its popover.
  const chipsAtOnce = Number(
    /\d+/.exec(document.querySelector("[data-composer] [data-files]")?.textContent ?? "")?.[0] ?? 0,
  );
  const chipFrameMs = (await frame()) - start;

  // The composer has the keys while it is open, so the list is moved the way `j` and `k` move it
  // (the store), from the first byte pasted until the last copy ended.
  const keyFrameMs: number[] = [];
  let during = 0;
  let pasted = false;
  void pasting.then(() => {
    pasted = true;
  });
  for (let i = 0; i < 400 && !(pasted && settled); i++) {
    const copying = !settled;
    const from = store.selected();
    const t0 = performance.now();
    store.move(i % 2 === 0 ? 1 : -1);
    const moved = store.selected() !== from;
    const at = await frame();
    if (moved) keyFrameMs.push(Math.round((at - t0) * 100) / 100);
    if (moved && copying) during++;
    await new Promise((r) => setTimeout(r, 10));
  }
  await pasting;
  const grantedMs = performance.now() - start;
  const draftId = session.draft()?.id;
  if (!draftId || !session.attachments().every((c) => c.added)) {
    throw new Error("the files never got their rows");
  }

  // Close the composer (the files stay on the draft) so that the list has its keys back, and
  // press the real keys once.
  document
    .querySelector("[data-composer]")
    ?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await until(() => document.querySelector("[data-composer]") === null, 3000);
  const press = (key: string) =>
    document.body.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
  for (let i = 0; i < ATTACH_KEY_SAMPLES; i++) {
    const from = store.selected();
    const t0 = performance.now();
    press(i % 2 === 0 ? "j" : "k");
    const moved = store.selected() !== from;
    const at = await frame();
    if (moved) keyFrameMs.push(Math.round((at - t0) * 100) / 100);
    await new Promise((r) => setTimeout(r, 15));
  }
  const allSettled = await until(() => settled, 15_000);
  off();
  await new Promise((r) => setTimeout(r, 100));
  window.postMessage({ mattersSmokeSignal: `memory-end:${label}` }, "*");
  // The rows say how the copies ended; the closed composer's chips no longer follow them.
  const rows = await backend.listAttachments(draftId).catch(() => []);
  await backend.deleteDraft(draftId).catch(() => {});

  return {
    pastedBytes: files.reduce((n, f) => n + f.size, 0),
    chipsAtOnce,
    chipFrameMs: Math.round(chipFrameMs * 100) / 100,
    grantedMs: Math.round(grantedMs),
    copyMs: allSettled ? Math.round(settledAt - start) : undefined,
    allReady: allSettled,
    states: rows.map((r) => r.state),
    reasons: rows.flatMap((r) => (r.reason ? [r.reason] : [])),
    keyFrameMs,
    keysDuringCopy: during,
  };
}

/** What dragging files over the window does to the page, with the events a drag would send. */
async function checkDragOverlay() {
  const transfer = () => {
    const t = new DataTransfer();
    t.items.add(new File(["x"], "a.txt", { type: "text/plain" }));
    return t;
  };
  const fire = (type: string, target: EventTarget, dataTransfer: DataTransfer | null) =>
    target.dispatchEvent(
      new DragEvent(type, {
        bubbles: true,
        cancelable: true,
        dataTransfer,
        clientX: 50,
        clientY: 50,
      }),
    );
  const body = document.body;
  const overlayEl = document.querySelector<HTMLElement>("[data-drop-overlay]");
  const frameEl = document.querySelector<HTMLIFrameElement>("iframe");
  const shown = () => (overlayEl ? getComputedStyle(overlayEl).display !== "none" : false);

  const hiddenAtRest = !shown();
  const child = document.querySelector("[data-row]") ?? body;
  fire("dragenter", body, transfer());
  fire("dragenter", child, transfer());
  const classOn = body.classList.contains("dragging-files");
  const overlayShown = shown();
  const framesInert = frameEl ? getComputedStyle(frameEl).pointerEvents === "none" : true;

  // Nothing may change in the page while the drag moves.
  let mutations = 0;
  const observer = new MutationObserver((records) => {
    mutations += records.length;
  });
  observer.observe(document.documentElement, { attributes: true, childList: true, subtree: true });
  const over = new DragEvent("dragover", {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer(),
  });
  for (let i = 0; i < 50; i++) child.dispatchEvent(over);
  await frame();
  observer.disconnect();

  // One child left, one still entered: the drag is still inside.
  fire("dragleave", child, transfer());
  const stillOver = body.classList.contains("dragging-files");
  fire("dragleave", body, transfer());
  const cleared = !body.classList.contains("dragging-files") && !shown();

  // A text drag (inside the editor, say) is not ours.
  const text = new DataTransfer();
  text.setData("text/plain", "words");
  fire("dragenter", body, text);
  const textIgnored = !body.classList.contains("dragging-files");

  // Escape ends a drag that never got its `dragleave`.
  fire("dragenter", body, transfer());
  window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  const escaped = !body.classList.contains("dragging-files");

  return {
    overlay: {
      hiddenAtRest,
      classOn,
      overlayShown,
      framesInert,
      dragoverMutations: mutations,
      stillOver,
      cleared,
      textIgnored,
      escaped,
    },
  };
}

/** Runs the timing scenario of ADR 0012 and posts the report to main (via the preload). */
/** A long, wide newsletter: the costliest thing that can sit beside the list's edge. */
function largeHtmlMail(): string {
  const row = (i: number) =>
    `<tr><td><a href="https://example.com/${i}">Article ${i}</a><p>Paragraph ${i} with enough text to wrap more than once when the pane is narrow, as a newsletter's would.</p></td></tr>`;
  const rows = Array.from({ length: 400 }, (_, i) => row(i)).join("");
  return sanitizeMail(`<table width="900">${rows}</table>`).html;
}

/**
 * ADR 0076. The live search panel: ⌘K puts the cursor in the bar, and typing words shows Threads
 * in the panel. Times keystroke -> the rows are in the DOM (`workMs`, the backend answered and the
 * signals were applied) and -> the next frame is painted (`frameMs`). Stale answers must not show:
 * the panel after a burst of keys holds the answer to the last text only.
 */
async function measureLivePanel(store: MailStore) {
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Search mail"]');
  const key = document.querySelector<HTMLElement>(".qkey");
  if (!input || !key) throw new Error("search bar missing");
  const rows = () =>
    document.querySelectorAll('.qsugg [role="group"][aria-label="Threads"] [role="option"]');
  const mac = navigator.userAgent.includes("Macintosh");
  const labelBefore = key.textContent ?? "";
  document.body.dispatchEvent(
    new KeyboardEvent("keydown", { key: "k", metaKey: mac, ctrlKey: !mac, bubbles: true }),
  );
  await frame();
  const out = {
    cmdKFocuses: document.activeElement === input,
    keyLabelIdle: labelBefore,
    keyLabelFocused: key.textContent ?? "",
    samples: [] as { query: string; threads: number; workMs: number; frameMs: number }[],
    burstShowsLast: false,
    askHidden: false,
    footer: "",
    escCloses: false,
  };
  const type = async (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  await type("warmup");
  await until(() => rows().length > 0, 2000);
  await type("");
  await frame();
  for (const query of ["faktura", "zażółć gęślą", "bilet kraków"]) {
    const start = performance.now();
    await type(query);
    let workAt = 0;
    const found = await new Promise<boolean>((resolve) => {
      const end = start + 3000;
      const tick = () => {
        if (rows().length > 0) {
          workAt = performance.now();
          resolve(true);
        } else if (performance.now() > end) resolve(false);
        else requestAnimationFrame(tick);
      };
      // Checked on every frame and by a mutation observer, so that the time is not a frame late.
      const watch = new MutationObserver(() => {
        if (rows().length > 0) {
          watch.disconnect();
          workAt = performance.now();
          resolve(true);
        }
      });
      watch.observe(document.body, { childList: true, subtree: true });
      tick();
    });
    const frameAt = await frame();
    out.samples.push({
      query,
      threads: found ? rows().length : 0,
      workMs: Math.round((workAt - start) * 100) / 100,
      frameMs: Math.round((frameAt - start) * 100) / 100,
    });
    if (query === "faktura") {
      out.askHidden = document.querySelector('.qsugg [aria-label="Agent"]') === null;
      out.footer = document.querySelector(".qfoot")?.textContent ?? "";
    }
    await type("");
    await frame();
  }
  // A burst of keys: the panel ends on the answer to the last text, whichever came back first.
  for (const t of ["f", "fa", "fak", "fakt", "faktu", "faktur", "faktura"]) await type(t);
  await until(() => rows().length > 0, 2000);
  await frame();
  const subject = rows()[0]?.querySelector(".qsubj, .qsnip, .qwho");
  out.burstShowsLast = store.query() === "faktura" && rows().length > 0 && subject !== null;
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  await frame();
  out.escCloses = document.querySelector(".qsugg") === null;
  await type("");
  input.blur();
  await frame();
  return out;
}

/**
 * ADR 0077. A search for "faktura": the rows of the list mark the word, a thread opened from the
 * results marks it in the reader, and ⌘G moves the current match (⇧⌘G goes back). The first
 * result is opened; when its words give no stop, the next few are tried for the navigation.
 */
async function measureHits(store: MailStore) {
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Search mail"]');
  if (!input) throw new Error("search input missing");
  const type = async (text: string) => {
    const settled = new Promise<void>((resolve) => {
      const off = store.onSettled((q) => {
        if (q !== text) return;
        off();
        resolve();
      });
    });
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settled;
    await frame();
  };
  let word = "";
  const mac = navigator.userAgent.includes("Macintosh");
  const g = (shift: boolean) =>
    document.body.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: shift ? "G" : "g",
        shiftKey: shift,
        metaKey: mac,
        ctrlKey: !mac,
        bubbles: true,
      }),
    );
  const out = {
    listMarks: 0,
    readerMarks: 0,
    stops: 0,
    countText: "",
    currentIndexes: [] as number[],
    wrapped: false,
    plainBodiesUntouched: true,
    expandedCollapsed: false,
  };
  await type("faktura");
  await until(() => document.querySelectorAll("[data-row] mark.hit").length > 0, 2000);
  out.listMarks = document.querySelectorAll("[data-row] mark.hit").length;
  const first = store.messages()[0];
  if (first) {
    store.select(0);
    await waitForThread(first.threadId);
    await frame();
    const article = document.querySelector(
      `article[data-thread-id="${CSS.escape(first.threadId)}"]`,
    );
    out.readerMarks = article?.querySelectorAll("mark.hit").length ?? 0;
    // A word of the letters themselves, for the walk: the seeded mail names its topic in the
    // subject only, and the walk goes through the words of the bodies.
    const text = article?.querySelector("[data-body]")?.textContent ?? "";
    word = text.match(/\p{L}{6,}/u)?.[0] ?? "";
  }
  await type("");
  await frame();
  if (word) {
    await type(word);
    await until(() => document.querySelectorAll("[data-row] mark.hit").length > 0, 2000);
    for (let at = 0; at < Math.min(10, store.messages().length); at++) {
      const row = store.messages()[at];
      if (!row) break;
      store.select(at);
      await waitForThread(row.threadId);
      await frame();
      const article = document.querySelector(
        `article[data-thread-id="${CSS.escape(row.threadId)}"]`,
      );
      const count = article?.querySelector("[data-match-count]");
      if (!count) continue;
      out.countText = count.textContent ?? "";
      out.stops = Number.parseInt(out.countText, 10) || 0;
      const stops = () => [...(article?.querySelectorAll("mark.hit[data-nav]") ?? [])];
      const collapsedBefore = article?.querySelectorAll("button[aria-expanded=false]").length ?? 0;
      const now = () => stops().findIndex((m) => m.hasAttribute("data-now"));
      for (const shift of [false, false, true]) {
        g(shift);
        await until(() => now() >= 0, 500);
        await frame();
        out.currentIndexes.push(now());
      }
      const collapsedAfter = article?.querySelectorAll("button[aria-expanded=false]").length ?? 0;
      out.expandedCollapsed = collapsedAfter < collapsedBefore;
      out.wrapped = out.currentIndexes[0] === 0;
      break;
    }
  }
  await type("");
  await until(() => document.querySelectorAll("[data-row] mark.hit").length === 0, 1000);
  out.plainBodiesUntouched = document.querySelectorAll("mark.hit").length === 0;
  return out;
}

/**
 * The list's edge (ADR 0038): frames while it is dragged over a large HTML message, and what the
 * gestures leave behind. Events are synthetic, so nothing holds a real pointer to capture.
 */
async function measureListDivider() {
  const pane = document.querySelector<HTMLElement>("section[aria-label=Thread]");
  const grip = document.querySelector<HTMLElement>("[data-list-divider]");
  const list = document.querySelector<HTMLElement>("section[aria-label=Messages]");
  if (!pane || !grip || !list) throw new Error("the list's edge is missing");
  grip.setPointerCapture = () => undefined;
  const width = () => list.getBoundingClientRect().width;

  const host = document.createElement("div");
  pane.prepend(host);
  const dispose = render(
    () =>
      createComponent(MailFrame, {
        html: largeHtmlMail(),
        scheme: "light",
        images: false,
        onLink: () => undefined,
        onHoverLink: () => undefined,
      }),
    host,
  );
  try {
    const mail = host.querySelector<HTMLIFrameElement>("[data-mail-frame]");
    if (!mail) throw new Error("the mail frame is missing");
    if (!(await until(() => !!mail.dataset.painted, 3000))) throw new Error("mail never painted");
    await frame();

    const pointer = (type: string, clientX: number) =>
      grip.dispatchEvent(
        new PointerEvent(type, { bubbles: true, button: 0, clientX, pointerId: 1 }),
      );
    pointer("pointerdown", 0);
    // The column fills the pane (ADR 0049), so the whole range narrows the message.
    const low = LIST_MIN - LIST_DEFAULT;
    const high = LIST_MAX - LIST_DEFAULT;
    const positions: number[] = [];
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let x = low; x <= high; x += 8) positions.push(x);
      for (let x = high; x >= low; x -= 8) positions.push(x);
    }
    pointer("pointermove", low);
    let last = await frame();
    const frameMs: number[] = [];
    for (const x of positions) {
      pointer("pointermove", x);
      const now = await frame();
      frameMs.push(Math.round((now - last) * 100) / 100);
      last = now;
    }
    pointer("pointermove", high);
    await frame();
    const followed = Math.abs(width() - LIST_MAX) <= 1;
    grip.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 }));

    // The drag's end fits the message to the width it landed on.
    const doc = mail.contentDocument;
    const fits = () => {
      const root = doc?.documentElement;
      return !!root && root.getBoundingClientRect().width <= mail.clientWidth + 1;
    };
    const refitted = await until(() => fits() && doc?.documentElement.style.zoom !== "", 1000);

    grip.focus();
    const key = (name: string) =>
      grip.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true }));
    key("ArrowLeft");
    await frame();
    const keyStepped = Math.abs(width() - (LIST_MAX - 8)) <= 1;
    key("Enter");
    await frame();
    const keyReset = Math.abs(width() - LIST_DEFAULT) <= 1;
    // The window's own Enter would have taken the focus to the reading pane.
    const keptKeys = document.activeElement === grip;
    grip.blur();
    return { frameMs, followed, refitted, keyStepped, keyReset, keptKeys };
  } finally {
    dispose();
    host.remove();
  }
}

/**
 * The walls around a message's HTML, in the real browser (ADR 0024). Each one is tested alone:
 * the sanitizer on hostile markup, and the sandbox and policy on markup that skipped it.
 */
async function checkMailWalls(): Promise<string[]> {
  const problems: string[] = [];
  const remote = "https://matters.invalid/pixel.png";
  const hostile = `<img src="x" onerror="parent.__pwned=1"><script>parent.__pwned=1</script><img src="${remote}"><style>body{background:url(${remote})}</style><a href="javascript:parent.__pwned=1">x</a><form action="https://matters.invalid"><input></form><iframe src="https://matters.invalid"></iframe><meta http-equiv="refresh" content="0;url=https://matters.invalid"><base href="https://matters.invalid/">`;
  const clean = sanitizeMail(hostile);
  for (const forbidden of [
    "onerror",
    "<script",
    "javascript:",
    "<form",
    "<iframe",
    "<meta",
    "<base",
  ]) {
    if (clean.html.includes(forbidden)) problems.push(`the sanitizer kept ${forbidden}`);
  }
  if (!clean.hasRemoteContent) problems.push("remote images went unnoticed");

  // Declared pixels go before anything loads, and a message with nothing else shows no bar
  // (ADR 0037). Sizes as attributes and as inline style, in any mix.
  const pixel = (attrs: string) => sanitizeMail(`<p>hi</p><img src="${remote}" ${attrs}>`);
  for (const attrs of [
    'width="1" height="1"',
    'width="0" height="0"',
    'width="1px" height="1PX"',
    'style="width:1px;height:1px"',
    'style="WIDTH: 0px !important; height: 1px"',
    'width="1" style="height:0px"',
    'width="100" height="100" style="width:1px;height:1px"',
    'width="1" height="1" style="color:red;/* width:50px */"',
  ]) {
    const out = pixel(attrs);
    if (out.html.includes(remote) || out.hasRemoteContent) {
      problems.push(`a declared pixel stayed (${attrs})`);
    }
  }
  for (const attrs of [
    "",
    'width="2" height="1"',
    'width="1"',
    'style="width:1px"',
    'width="1" height="100%"',
    'width="1" height="1" style="width:50px"',
    'width="1em" height="1em"',
  ]) {
    const out = pixel(attrs);
    if (!out.html.includes(remote) || !out.hasRemoteContent) {
      problems.push(`an image that is not a declared pixel was removed (${attrs})`);
    }
  }
  const real = sanitizeMail(
    `<img src="${remote}" width="1" height="1"><img src="${remote}?real" width="300" height="200">`,
  );
  if (!real.hasRemoteContent || real.html.includes('width="1"')) {
    problems.push("a pixel beside a real image was not told apart");
  }
  // The hook is gone again: the shared sanitizer treats a pixel as any image.
  if (!DOMPurify.sanitize(`<img src="x" width="1" height="1">`).includes("<img")) {
    problems.push("the pixel hook leaked into the shared sanitizer");
  }

  const load = async (page: string) => {
    const el = document.createElement("iframe");
    el.setAttribute("sandbox", "allow-same-origin");
    el.style.display = "none";
    el.src = page;
    const loaded = new Promise((r) => el.addEventListener("load", r, { once: true }));
    document.body.append(el);
    await loaded;
    const doc = el.contentDocument;
    if (!doc) throw new Error(`${page} has no document`);
    const blocked: string[] = [];
    doc.addEventListener("securitypolicyviolation", (e) => blocked.push(e.blockedURI));
    // Past the sanitizer on purpose.
    doc.documentElement.innerHTML = `<body>${hostile}</body>`;
    await new Promise((r) => setTimeout(r, 300));
    el.remove();
    return blocked;
  };
  const blocked = await load("./mail.html");
  if (!blocked.some((uri) => uri.startsWith(remote))) problems.push("mail.html let an image out");
  if ((window as unknown as { __pwned?: number }).__pwned) problems.push("a message ran a script");
  const withImages = await load("./mail-images.html");
  if (withImages.some((uri) => uri.startsWith(remote))) {
    problems.push("mail-images.html blocked an allowed image");
  }
  if ((window as unknown as { __pwned?: number }).__pwned) problems.push("a message ran a script");
  return problems;
}

/** What the person tells the agent to close a thread; the demo runtime closes on "no reply". */
const CLOSING_WORDS = "no reply, to automatyczne powiadomienie";
const AGENT_WAIT_MS = 20_000;
const TAB_SAMPLES = 6;

/**
 * A status arrives with new option arrays while the value stays the same. A list rebuilt from them
 * would put the select back on its first option, so settings would seem to change by themselves.
 */
function choiceKeepsItsValue(): boolean {
  const list = () =>
    [
      ["5", "Up to 5% of my week"],
      ["10", "Up to 10% of my week"],
      ["25", "Up to 25% of my week"],
    ] as const;
  const [options, setOptions] = createSignal<ReturnType<typeof list>>(list());
  const host = document.createElement("div");
  document.body.append(host);
  const dispose = render(
    () =>
      createComponent(Choice, {
        id: "smoke-choice",
        label: "Background limit",
        value: "10",
        get options() {
          return options();
        },
        onChange: () => {},
      }),
    host,
  );
  const select = host.querySelector("select");
  const first = select?.value;
  setOptions(list());
  const after = select?.value;
  dispose();
  host.remove();
  return first === "10" && after === "10";
}

/**
 * The agent's column widened over the window (⇧⌘E): it leaves a 54 px strip of the list, reaches
 * the right edge, moves nothing under it, and goes back to its side on Escape and on a click in
 * the strip. Runs with AI on.
 */
async function measureWidePane(store: MailStore, views: ViewsStore) {
  const out = {
    opened: false,
    strip: -1,
    toRightEdge: false,
    readerKept: false,
    escNarrows: false,
    stripNarrows: false,
  };
  views.select("all");
  for (let i = 0; i < 6; i++) await frame();
  if (store.messages().length > 0) store.select(0);
  for (let i = 0; i < 4; i++) await frame();
  const reader = () => document.querySelector<HTMLElement>("section[aria-label=Thread]");
  const wideAside = () => document.querySelector<HTMLElement>("aside[data-agent-wide]");
  const press = (target: EventTarget, init: KeyboardEventInit) =>
    target.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init }),
    );
  const widen = () =>
    press(document.body, { key: "E", metaKey: true, ctrlKey: true, shiftKey: true });
  widen();
  for (let i = 0; i < 4; i++) await frame();
  // The column was hidden: the first press opens it at the side or wide; get it wide.
  if (!wideAside()) {
    widen();
    for (let i = 0; i < 4; i++) await frame();
  }
  const before = reader()?.getBoundingClientRect().width ?? -1;
  const aside = wideAside();
  out.opened = aside !== null;
  (out as Record<string, unknown>).seen = [
    `pane:${document.querySelector("aside[aria-label^='The agent']") !== null}`,
    `button:${document.querySelector("[data-agent-widen]") !== null}`,
    `toggle:${document.querySelector("[data-agent-toggle]") !== null}`,
    `composer:${document.querySelector("[data-composer]") !== null}`,
    `view:${views.active().id}`,
    `active:${document.activeElement?.tagName ?? ""}`,
  ].join(" ");
  if (aside) {
    const box = aside.getBoundingClientRect();
    out.strip = Math.round(box.left);
    out.toRightEdge = Math.abs(box.right - window.innerWidth) <= 1;
    const prompt = aside.querySelector<HTMLTextAreaElement>("textarea");
    press(prompt ?? aside, { key: "Escape" });
    for (let i = 0; i < 2; i++) await frame();
    out.escNarrows =
      wideAside() === null && document.querySelector("aside[aria-label^='The agent']") !== null;
    out.readerKept = Math.abs((reader()?.getBoundingClientRect().width ?? -2) - before) <= 1;
    widen();
    for (let i = 0; i < 2; i++) await frame();
    const list = document.querySelector<HTMLElement>("section[aria-label=Messages]");
    list?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    for (let i = 0; i < 2; i++) await frame();
    out.stripNarrows = list !== null && wideAside() === null;
  }
  return out;
}

/**
 * AI turned on with the demo runtime (no model, no network): the runtime passes the test with a
 * made-up message, the starter view `Needs you` is added (ADR 0117, rule 2), the agent in an
 * ordinary thread makes a draft on request (ADR 0063), the person's words close a thread from the
 * talk with a line, a rule on offer and an Undo (ADR 0054), and Pause reading holds (rule 3).
 * Nothing here sends mail.
 */
async function measureAgent(extras: {
  compose: ComposeStore;
  backend: Backend;
  agent: AgentStore;
  views: ViewsStore;
  store: MailStore;
}) {
  const { backend, agent, views, compose, store } = extras;
  const tabOf = (id: string) =>
    document.querySelector<HTMLElement>(`[role="tab"][data-view="${CSS.escape(id)}"]`);
  const starter = () => tabOf(NEEDS_YOU_VIEW.id);
  const out = {
    enabled: false,
    starterPresent: false,
    starterFirst: false,
    /** The app went to it by itself: only when nothing chose a tab before AI was turned on. */
    starterOpenedByItself: false,
    starterOpens: false,
    tabFrameMs: [] as number[],
    draftOpened: false,
    sheetShown: false,
    sendShown: false,
    statusLineShown: false,
    statusLineHasNoInput: false,
    editOpenedComposer: false,
    closedInOwnWords: false,
    ruleOffered: false,
    closedUndone: false,
    journalRecorded: false,
    remembered: false,
    pauseHeld: false,
    continueWorked: false,
    choiceKeepsItsValue: false,
    detail: "",
  };

  // The demo runtime is `found` until it passed the test with a made-up message (ADR 0051).
  let status = await backend.agentInspect();
  // The person picks who works on the mail (ADR 0119, rule 2); the demo run lists only one.
  const demo = status.runtimes[0];
  if (status.runtime === null && demo !== undefined) {
    status = await backend.agentChooseRuntime(demo.id);
  }
  if (status.runtime?.status !== "ready") status = await backend.agentTestRuntime();
  if (status.runtime?.status !== "ready") {
    out.detail = `the demo runtime is ${status.runtime?.status ?? "missing"}`;
    return out;
  }
  if (!status.settings.enabled) {
    const accounts = (await backend.listAccounts()).accounts.map((a) => a.id);
    status = await backend.agentSetEnabled({ accountIds: accounts, runtimeId: status.runtime.id });
    // Turned on as the first-run screen does it: the window's store takes the answer at once
    // (`onAgentStatus` in app.tsx). The rest reaches the window by the backend's pushes.
    agent.setStatus(status);
  }
  out.enabled = status.settings.enabled;
  await agent.refresh();

  // ADR 0117, rule 2: `Needs you` is a saved view in front of the others, and opening it runs
  // its prompt like any view with one.
  out.starterPresent = await until(() => starter() !== null, 5000);
  out.starterFirst = views.saved()[0]?.id === NEEDS_YOU_VIEW.id;
  out.starterOpenedByItself = views.active().id === NEEDS_YOU_VIEW.id;
  if (out.starterPresent) {
    starter()?.click();
    out.starterOpens = await until(
      () =>
        views.active().id === NEEDS_YOU_VIEW.id &&
        document.querySelector("[data-prompt-line]") !== null,
      5000,
    );
    // Switching between the tabs is one frame.
    for (let i = 0; i < TAB_SAMPLES; i++) {
      const start = performance.now();
      (i % 2 === 0 ? tabOf("all") : starter())?.click();
      out.tabFrameMs.push(Math.round(((await frame()) - start) * 100) / 100);
    }
  }
  views.select("all");
  for (let i = 0; i < 4; i++) await frame();

  // ADR 0063: the agent in an ordinary thread makes nothing ahead; asked, it may ask first, and a
  // way forward then writes the draft, which shows with Send and Edit myself.
  /** Opens the newest row of a thread other than `not`; its thread id. */
  const openRow = async (not?: string): Promise<string | undefined> => {
    const at = store.messages().findIndex((m) => m.threadId !== not);
    const id = store.messages()[at]?.threadId;
    if (id === undefined) return undefined;
    store.select(at);
    await until(() => store.thread()?.thread.id === id, 3000);
    return id;
  };
  const draftThread = await openRow();
  const writeButton = () =>
    [...document.querySelectorAll<HTMLButtonElement>("[data-proposal] button")].find(
      (b) => b.textContent?.trim() === "Write the draft",
    );
  if (draftThread !== undefined) {
    await backend.agentPrepare(draftThread).catch(() => null);
    out.draftOpened = await until(
      () => document.querySelector("[data-proposal]") !== null,
      AGENT_WAIT_MS,
    );
    if (out.draftOpened && document.querySelector("[data-draft]") === null) {
      document.querySelector<HTMLElement>('[data-direction="1"]')?.click();
      await frame();
      writeButton()?.click();
      await until(() => document.querySelector("[data-draft]") !== null, 8000);
    }
    out.sheetShown =
      (document.querySelector("[data-draft]")?.textContent ?? "").trim().length > 0 &&
      document.querySelector("[data-sheet]") !== null;
    out.sendShown = document.querySelector("[data-send-agent]") !== null;
    // `Edit myself` opens the existing composer on the same draft; Discard removes it again.
    const edit = [...document.querySelectorAll<HTMLButtonElement>("[data-proposal] button")].find(
      (b) => b.textContent?.trim() === "Edit myself",
    );
    if (edit) {
      edit.click();
      out.editOpenedComposer = await until(() => compose.isOpen(), 4000);
      if (out.editOpenedComposer) {
        await new Promise((r) => setTimeout(r, 300));
        [...document.querySelectorAll<HTMLButtonElement>("[data-composer] button")]
          .find((b) => b.textContent?.trim() === "Discard")
          ?.click();
        await until(() => !compose.isOpen(), 3000);
      }
    }
  }

  // The plans line is the foot row of the prompt in the agent's column, which `askTheAgent` shows
  // first when it is hidden (a window under 1060 px starts without it).
  askTheAgent();
  await frame();
  const plans = document.querySelector("[data-plans]");
  out.statusLineShown = plans !== null;
  out.statusLineHasNoInput =
    plans !== null && plans.querySelector("input, textarea, select, [contenteditable]") === null;

  // Telling the agent that no reply is needed closes the thread: no draft, a line that says why,
  // a rule for the sender on offer, and an Undo (ADR 0054).
  const closingId = await openRow(draftThread);
  askTheAgent();
  const prompt = () => document.querySelector<HTMLTextAreaElement>("textarea[data-agent-prompt]");
  await until(() => prompt() !== null, 3000);
  const words = prompt();
  if (closingId !== undefined && words) {
    words.value = CLOSING_WORDS;
    words.dispatchEvent(new Event("input", { bubbles: true }));
    await frame();
    words.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    const closedLine = () => document.querySelector("[data-agent-line] [data-line]");
    out.closedInOwnWords = await until(
      () => (closedLine()?.textContent ?? "").startsWith("Closed:"),
      8000,
    );
    // The one-click rule for the sender stands beside Undo, and a long address does not push it out.
    await until(() => document.querySelector("[data-rule-offer]") !== null, 3000);
    const undoBox = document
      .querySelector("[data-agent-line] [data-undo]")
      ?.getBoundingClientRect();
    out.ruleOffered =
      (document.querySelector("[data-rule-offer]")?.textContent ?? "").startsWith("Always for ") &&
      undoBox !== undefined &&
      undoBox.width > 0 &&
      undoBox.right <= window.innerWidth;
    document.querySelector<HTMLButtonElement>("[data-agent-line] [data-undo]")?.click();
    // The journal kept it: the agent closed it, on the typed words, and Undo marked the line.
    const entry = async () =>
      (await backend.agentJournal(20).catch(() => [])).find(
        (e) => e.action === "closed" && e.threadId === closingId,
      );
    for (let i = 0; i < 20 && !out.closedUndone; i++) {
      out.closedUndone = (await entry())?.undoneAtMs !== undefined;
      if (!out.closedUndone) await new Promise((r) => setTimeout(r, 150));
    }
    const kept = await entry();
    out.journalRecorded =
      kept?.action === "closed" &&
      kept.actor === "agent" &&
      kept.words === CLOSING_WORDS &&
      (kept.reason ?? "") !== "";
  } else out.detail = "no thread to close, or no prompt";

  // The agent keeps what the typed words say should hold, and the person can take it back (ADR
  // 0054). The instruction is removed either way: it would go to the turns that follow.
  if (closingId !== undefined) {
    const kept = await backend.agentRemember(closingId, "zawsze pisz krótko").catch(() => null);
    const one = kept?.items.length === 1 ? kept.items[0] : undefined;
    if (one?.kind === "instruction") {
      const listed = (await backend.agentInstructions().catch(() => [])).some(
        (i) => i.id === one.instruction.id && i.actor === "agent",
      );
      await backend.agentRemoveInstruction(one.instruction.id).catch(() => {});
      const gone = !(await backend.agentInstructions().catch(() => [])).some(
        (i) => i.id === one.instruction.id,
      );
      out.remembered = listed && gone;
    }
  }

  // Pause reading holds across reads of the status; Continue takes it away (ADR 0117, rule 3).
  const paused = await agent.pauseReading();
  const again = await backend.agentStatus();
  out.pauseHeld =
    paused.settings.readingPaused === true &&
    again.settings.readingPaused === true &&
    again.progress.state === "paused" &&
    again.progress.reason === "pausedByPerson";
  const resumed = await agent.resumeReading();
  out.continueWorked = resumed.settings.readingPaused !== true;

  out.choiceKeepsItsValue = choiceKeepsItsValue();
  return out;
}

/**
 * ADR 0116 on the seeded mailbox: the demo runtime answers the prompt's turns the same each time,
 * the plan turn that searches (it has no tools) and the batches that judge.
 */
async function measurePrompt(store: MailStore, backend: Backend) {
  const out = {
    lineShown: "",
    ran: false,
    rows: 0,
    inOrder: false,
    whyShown: false,
    noHeadings: false,
    backToFilters: false,
    datedHeadings: false,
    relevanceSorted: false,
    detail: "",
  };
  const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Search mail"]');
  if (!input) {
    out.detail = "no search input";
    return out;
  }
  const query = 'prompt:"spotkanie termin"';
  const line = () => document.querySelector<HTMLElement>("[data-prompt-line]");
  input.focus();
  input.value = query;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // Typing reads nothing: what is known comes after a quiet moment. A cold start has not searched
  // yet; a warm one has its search kept and everything read (ADR 0116, rule 4).
  const counted = await until(
    () => ["ready", "ask", "count", "allRead"].includes(line()?.dataset.promptLine ?? ""),
    5000,
  );
  out.lineShown = line()?.textContent ?? "";
  if (!counted) {
    out.detail = `no count line (saw ${line()?.dataset.promptLine ?? "none"})`;
    return out;
  }
  const enter = () => {
    input.focus();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  };
  const read = () =>
    store.ordered() && line()?.dataset.promptLine === "allRead" && store.messages().length > 0;
  enter();
  // The search, then the reading: done when the line says how many fit. Above PROMPT_ASK_ABOVE
  // found, it reads that many and says how many are left, and one more ↵ reads them all (rule 4).
  const left = () => ["ask", "count"].includes(line()?.dataset.promptLine ?? "");
  await until(() => read() || (store.ordered() && left()), 60_000);
  if (left()) enter();
  out.ran = await until(read, 60_000);
  await frame();
  const kept = await backend.agentPromptVerdicts(query).catch(() => null);
  out.rows = store.messages().length;
  out.inOrder =
    kept !== null &&
    kept.rows.length === store.messages().length &&
    kept.rows.every((r, i) => store.messages()[i]?.threadId === r.threadId);
  out.whyShown = document.querySelector("[data-row] [data-prompt-why]") !== null;
  const listbox = document.querySelector<HTMLElement>('[role="listbox"][aria-label="Messages"]');
  out.noHeadings =
    listbox !== null &&
    [...listbox.querySelectorAll<HTMLElement>(":scope > div > div")].every((el) =>
      el.hasAttribute("data-row"),
    );
  // A developer can ask main for a picture of this moment (MATTERS_SMOKE_SHOT).
  window.postMessage({ mattersSmokeSignal: "shot" }, "*");
  await new Promise((r) => setTimeout(r, 500));
  // Rule 4b: the same prompt by date reads nothing more; what fits is dated, under a heading.
  const typeText = (text: string) => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  typeText(`${query} sort:newest`);
  const headed = () =>
    listbox !== null &&
    [...listbox.querySelectorAll<HTMLElement>(":scope > div > div")].some(
      (el) => !el.hasAttribute("data-row"),
    );
  out.datedHeadings =
    (await until(
      () => store.ordered() && store.orderedDated() && store.messages().length === out.rows,
      5000,
    )) &&
    (await until(headed, 1000)) &&
    store.messages().every((m, i, all) => i === 0 || (all[i - 1]?.dateMs ?? 0) >= m.dateMs);
  // Without a prompt, a ranked order comes after ↵ only, with no headings (rule 4b).
  const sortLine = () => document.querySelector<HTMLElement>("[data-sort-line]")?.dataset.sortLine;
  typeText("sort:relevance spotkanie");
  if (await until(() => sortLine() === "ready" && !store.ordered(), 3000)) {
    enter();
    out.relevanceSorted =
      (await until(() => sortLine() === "sorted" && store.ordered(), 10_000)) &&
      !store.orderedDated() &&
      !headed();
  }
  if (!out.relevanceSorted) {
    const why = await backend.sortRanked("sort:relevance spotkanie").then(
      (r) => `${r.rows.length} rows`,
      (e: unknown) => (e instanceof Error ? e.message : String(e)),
    );
    out.detail = `sort line ${sortLine() ?? "none"} (${why})`;
  }
  // Other mail filters: the list is theirs again until the prompt is read for them.
  input.value = `${query} has:attachment`;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  out.backToFilters = await until(() => !store.ordered(), 2000);
  input.value = "";
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await frame();
  return out;
}

export async function runSmoke(
  store: MailStore,
  cspViolations: () => readonly string[],
  extras?: {
    compose: ComposeStore;
    backend: Backend;
    agent: AgentStore;
    views: ViewsStore;
  },
): Promise<void> {
  const report: Record<string, unknown> = {};
  const frameViolations: string[] = [];
  try {
    await waitForRows();
    await frame();
    report.firstRowsEpochMs = performance.timeOrigin + performance.now();

    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Search mail"]');
    if (!input) throw new Error("search input missing");

    // Types through the real input path and times: input -> backend -> signals -> next frame.
    const type = async (text: string) => {
      let settledAt = 0;
      const settled = new Promise<void>((resolve) => {
        const off = store.onSettled((q) => {
          if (q !== text) return;
          settledAt = performance.now();
          off();
          resolve();
        });
      });
      const start = performance.now();
      input.value = text;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      await settled;
      const workMs = settledAt - start;
      const frameMs = (await frame()) - start;
      return { workMs, frameMs };
    };

    await type("warmup"); // JIT and first IPC are not what a keystroke costs
    await type("");
    const samples = [];
    for (const query of QUERIES) {
      const t = await type(query);
      samples.push({
        query,
        results: store.messages().length,
        workMs: Math.round(t.workMs * 100) / 100,
        frameMs: Math.round(t.frameMs * 100) / 100,
      });
      await type("");
      await frame();
    }
    report.samples = samples;
    report.livePanel = await measureLivePanel(store);
    report.hits = await measureHits(store);
    report.openSamples = await measureOpenThread(store);
    report.senderHead = await measureSenderHead(store);
    report.rowToLetter = await measureRowToLetter(store);
    report.markRead = await measureMarkRead(store);
    report.archive = await measureArchive(store, extras?.views);
    if (extras) report.composer = await measureComposer(store, extras.compose, frameViolations);
    if (extras) {
      report.attach = await measureAttach(store, extras.compose, extras.backend);
    }
    report.listDivider = await measureListDivider();
    // Last: it turns AI on, and the scenarios above are the app as it is without it.
    if (extras) {
      report.agent = await measureAgent({ ...extras, store });
      // ADR 0116: a prompt in the bar is counted before it runs, ↵ reads it, and the list shows
      // the threads it kept in its order, each with the model's sentence.
      extras.views.select("all");
      await frame();
      report.prompt = await measurePrompt(store, extras.backend);
      // While AI is still on: the column widened over the window (⇧⌘E).
      report.widePane = await measureWidePane(store, extras.views);
      // Turning AI off leaves the starter view: it is the person's (ADR 0117, rule 2).
      await extras.agent.change(extras.backend.agentDisable());
      report.starterKeptAfterOff = extras.views.saved().some((v) => v.id === NEEDS_YOU_VIEW.id);
    }
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  // Read first: the wall check provokes violations on purpose, and parsing hostile markup in
  // the sanitizer's inert document reports some against this page, though nothing happens.
  report.cspViolations = [...cspViolations(), ...frameViolations];
  report.mailWallProblems = await checkMailWalls().catch((e: unknown) => [String(e)]);
  window.postMessage({ mattersSmoke: report }, "*");
}

/** The whole mailbox is syncing: any account whose state is "syncing". */
const syncing = (accounts: AccountsStore) =>
  accounts.accounts().some((a) => accounts.statusOf(a.id).state === "syncing");

/** Largest `done` of the syncing accounts, to know how much mail the index holds by now. */
const syncedSoFar = (accounts: AccountsStore) =>
  Math.max(
    0,
    ...accounts.accounts().map((a) => {
      const s = accounts.statusOf(a.id);
      return s.state === "syncing" ? s.done : 0;
    }),
  );

async function until(check: () => boolean, timeoutMs: number): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (performance.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return check();
}

const MEASURE_AFTER_SYNCED = 300;
const TARGET_SAMPLES = 100;
const LIVE_SUBJECTS = 3;

/**
 * ADR 0018, rule 7: the same keystroke -> frame and selection -> body timings as `runSmoke`,
 * taken while the initial sync of a large mailbox is running, one search and one open-thread
 * sample in turn until the sync ends. Samples record whether a sync was running before and
 * after them; a query that finds nothing yet (its mail is not synced) is not counted. Then,
 * once the sync is done, mail is delivered (the driver appends it on request) and the list
 * must take it in without moving the selected message or the reader's place.
 */
export async function runSyncSmoke(
  store: MailStore,
  accounts: AccountsStore,
  cspViolations: () => readonly string[],
): Promise<void> {
  const report: Record<string, unknown> = {};
  try {
    await waitForRows();
    // Enough mail is indexed for the sample queries to find something, and the sync goes on.
    if (!(await until(() => syncedSoFar(accounts) >= MEASURE_AFTER_SYNCED, 120_000))) {
      throw new Error("the sync never reached the amount needed to measure");
    }
    report.syncedBeforeMeasuring = !syncing(accounts);

    const input = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Search mail"]');
    if (!input) throw new Error("search input missing");
    const type = timedTyping(store, input);
    await type("warmup");
    await type("");

    const samples = [];
    const openSamples = [];
    let turn = 0;
    // Two of each per round: the sync of 5,000 messages is over in a couple of seconds.
    while (
      syncing(accounts) &&
      (samples.length < TARGET_SAMPLES || openSamples.length < TARGET_SAMPLES)
    ) {
      for (let n = 0; n < 2; n++) {
        const query = QUERIES[turn++ % QUERIES.length] as string;
        const before = syncing(accounts);
        const t = await type(query);
        const results = store.messages().length;
        if (results > 0) {
          samples.push({
            query,
            results,
            workMs: Math.round(t.workMs * 100) / 100,
            frameMs: Math.round(t.frameMs * 100) / 100,
            duringSync: before && syncing(accounts),
          });
        }
        await type("");
      }
      for (let n = 0; n < 2; n++) {
        const openBefore = syncing(accounts);
        const open = await measureOpenOnce(store, 1 + (turn++ % 20));
        if (open) openSamples.push({ ...open, duringSync: openBefore && syncing(accounts) });
      }
    }
    report.samples = samples;
    report.openSamples = openSamples;

    // The sync ends; the rest is about mail arriving live.
    if (!(await until(() => !syncing(accounts), 120_000))) throw new Error("the sync never ended");
    report.live = await checkLiveMail(store);
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  report.cspViolations = cspViolations();
  window.postMessage({ mattersSmoke: report }, "*");
}

/** Types through the real input and times: input -> backend -> signals -> next frame. */
function timedTyping(store: MailStore, input: HTMLTextAreaElement) {
  return async (text: string) => {
    let settledAt = 0;
    const settled = new Promise<void>((resolve) => {
      const off = store.onSettled((q) => {
        if (q !== text) return;
        settledAt = performance.now();
        off();
        resolve();
      });
    });
    const start = performance.now();
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await settled;
    const workMs = settledAt - start;
    const frameMs = (await frame()) - start;
    return { workMs, frameMs };
  };
}

async function checkLiveMail(store: MailStore) {
  const headingsAbove = () => {
    const l = layoutList(store.messages(), Date.now(), store.filtered() ? "Results" : undefined);
    const item = l.rowItem[store.selected()] ?? 0;
    return l.items.slice(0, item).filter((i) => i.kind === "head").length;
  };
  const scroller = document.querySelector<HTMLElement>("[role=listbox][aria-label=Messages]");
  if (!scroller) throw new Error("list missing");
  // Scroll well into the list and select a message there: new mail will arrive above it.
  scroller.scrollTop = 40 * ROW_HEIGHT;
  await frame();
  await frame();
  store.select(46);
  await frame();
  await frame();
  const selectedKey = store.messages()[store.selected()]?.key;
  const topOf = () => {
    const row = scroller.querySelector<HTMLElement>("[data-row][aria-selected=true]");
    return row
      ? row.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      : Number.NaN;
  };
  const offsetBefore = topOf();
  const scrollBefore = scroller.scrollTop;
  const headingsBefore = headingsAbove();

  const signalledAt = performance.now();
  window.postMessage({ mattersSmokeSignal: "append-mail" }, "*");
  const arrived = await until(
    () => store.messages().some((m) => m.subject.startsWith(`Na żywo ${LIVE_SUBJECTS}`)),
    10_000,
  );
  const visibleMs = arrived ? Math.round(performance.now() - signalledAt) : undefined;
  await frame();
  await frame();

  return {
    ...(visibleMs === undefined ? {} : { visibleMs }),
    selectionKept: store.messages()[store.selected()]?.key === selectedKey,
    offsetDriftPx: Math.round((topOf() - offsetBefore) * 100) / 100,
    // New mail can open a new day: its heading shifts the list too.
    scrollShiftRows: Math.round(
      (scroller.scrollTop - scrollBefore - (headingsAbove() - headingsBefore) * HEAD_HEIGHT) /
        ROW_HEIGHT,
    ),
    expectedShiftRows: LIVE_SUBJECTS,
  };
}

// ---- The hostile-mail corpus in a real window (tools/smoke-security.ts, ADR 0047) ---------------

const CORPUS_ID = /^<(.+)@corpus\.test>$/;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

interface SecurityRecord {
  readonly id: string;
  readonly lane: "blocked" | "images" | "bypass-blocked" | "bypass-images" | "control";
  readonly openMs?: number;
  /** The message ran a script: `parent.__pwned` was set. */
  readonly scriptRan: boolean;
  readonly cspViolations: number;
  /** The "Show images" offer was on screen with images off. */
  readonly noticeShown?: boolean;
  readonly senderText?: string;
  readonly attachments?: readonly string[];
  readonly framePage?: string;
  /** Links in the frame whose address is a file, UNC or protocol-relative one. */
  readonly anchorsInFrame?: number;
  /** Elements the sanitizer forbids (forms, frames, scripts, SVG, ...) that are in the frame. */
  readonly forbiddenElements?: number;
  /** Links followed, and how many of them asked "this link goes somewhere else" first. */
  readonly linksFollowed?: number;
  readonly linkWarnings?: number;
  readonly error?: string;
}

const pwned = () => (window as unknown as { __pwned?: unknown }).__pwned;
const resetPwned = () => {
  (window as unknown as { __pwned?: unknown }).__pwned = 0;
};

/**
 * Opens every corpus message through the real reader (sync, database, thread, sanitizer, frame),
 * twice: with images off, and once the reader allowed images from the sender. Messages that test
 * the walls alone are also put into the frame without the sanitizer. Everything outside the page is
 * watched by main and by the canary server; this reports what only the page can see. Each record
 * goes to the driver as one line.
 */
export async function runSecuritySmoke(
  store: MailStore,
  backend: Backend,
  cspViolations: () => readonly string[],
): Promise<void> {
  const send = (kind: string, data: unknown) =>
    window.postMessage({ mattersSmokeSignal: `security:${kind}:${JSON.stringify(data)}` }, "*");
  const report: Record<string, unknown> = {};
  try {
    await waitForRows();
    // The sync fills the list for a while; the set is complete when it stops growing.
    const corpus = () => store.messages().filter((m) => CORPUS_ID.test(m.messageIdHeader));
    let last = -1;
    let since = performance.now();
    const deadline = performance.now() + 180_000;
    while (performance.now() < deadline) {
      const n = corpus().length;
      if (n !== last) {
        last = n;
        since = performance.now();
      } else if (n > 0 && performance.now() - since > 4000) break;
      await sleep(250);
    }
    const idOf = (m: { messageIdHeader: string }) => CORPUS_ID.exec(m.messageIdHeader)?.[1] ?? "";
    const entries = corpus().map((m) => ({ id: idOf(m), key: m.key, from: m.from.address }));
    report.messages = entries.length;
    send("ready", { count: entries.length });

    const articleOf = (key: number) => {
      const m = store.messages().find((x) => x.key === key);
      return m
        ? document.querySelector(
            `section[aria-label=Thread] article[data-thread-id="${CSS.escape(m.threadId)}"]`,
          )
        : null;
    };

    /** Opens the message and, when it has HTML, shows the original. Resolves once the frame painted. */
    async function open(key: number, wantFrame: boolean): Promise<number> {
      const index = store.messages().findIndex((m) => m.key === key);
      const start = performance.now();
      store.select(index);
      await until(() => articleOf(key)?.querySelector("section") != null, 6000);
      if (wantFrame) {
        const original = [...(articleOf(key)?.querySelectorAll("fieldset button") ?? [])].find(
          (b) => b.textContent?.trim().toLowerCase() === "original",
        ) as HTMLButtonElement | undefined;
        if (original && original.getAttribute("aria-pressed") !== "true") original.click();
        await until(
          () => articleOf(key)?.querySelector("iframe[data-mail-frame][data-painted]") != null,
          8000,
        );
      }
      await frame();
      return performance.now() - start;
    }

    const frameOf = (key: number) =>
      articleOf(key)?.querySelector<HTMLIFrameElement>("iframe[data-mail-frame]") ?? null;

    async function followLinks(key: number): Promise<{ followed: number; warned: number }> {
      let followed = 0;
      let warned = 0;
      const links = [
        ...(articleOf(key)?.querySelectorAll<HTMLAnchorElement>("a[data-mail-link]") ?? []),
      ];
      for (const link of links.slice(0, 40)) {
        link.click();
        followed++;
        await sleep(120);
        const dialog = document.querySelector("[role=alertdialog]");
        if (dialog) {
          warned++;
          const stay = [...dialog.querySelectorAll("button")].find(
            (b) => b.textContent?.trim() === "Stay here",
          );
          stay?.click();
          await sleep(60);
        }
      }
      return { followed, warned };
    }

    // The sender alone: the same line goes on to the recipients, where the reader rightly reads "You".
    const senderOf = (key: number) =>
      (articleOf(key)?.querySelector("section")?.firstElementChild?.textContent ?? "")
        .split("→")[0]
        ?.slice(0, 300) ?? "";

    async function lane(entry: { id: string; key: number }, which: "blocked" | "images") {
      resetPwned();
      const violationsBefore = cspViolations().length;
      send("begin", { id: entry.id, lane: which });
      // The marker travels through main; what the case does next must not overtake it.
      await sleep(100);
      const record: { -readonly [K in keyof SecurityRecord]: SecurityRecord[K] } = {
        id: entry.id,
        lane: which,
        scriptRan: false,
        cspViolations: 0,
      };
      try {
        record.openMs = Math.round(await open(entry.key, true));
        await sleep(which === "blocked" ? 700 : 900);
        const el = frameOf(entry.key);
        const doc = el?.contentDocument ?? null;
        record.framePage = el?.getAttribute("src") ?? "";
        record.anchorsInFrame = doc
          ? [...doc.querySelectorAll("a[href]")].filter((a) =>
              /^(?:file:|\\\\|smb:|\/\/)/i.test(a.getAttribute("href") ?? ""),
            ).length
          : 0;
        record.forbiddenElements = doc
          ? doc.querySelectorAll(
              "script,form,input,button,select,option,textarea,iframe,frame,frameset,object,embed,applet,link,meta,base,audio,video,source,track,svg,math,marquee,dialog",
            ).length
          : 0;
        record.noticeShown =
          [...(articleOf(entry.key)?.querySelectorAll("button") ?? [])].some(
            (b) => b.textContent?.trim() === "Show images",
          ) ?? false;
        record.senderText = senderOf(entry.key);
        const thread = store.thread();
        const message = thread?.messages.find((m) => m.key === entry.key);
        record.attachments = (message?.attachments ?? [])
          .filter((a) => !a.inline)
          .map((a) => a.name);
        if (which === "blocked") {
          const { followed, warned } = await followLinks(entry.key);
          record.linksFollowed = followed;
          record.linkWarnings = warned;
        }
        record.scriptRan = Boolean(pwned());
      } catch (error) {
        record.error = error instanceof Error ? error.message : String(error);
      }
      record.cspViolations = cspViolations().length - violationsBefore;
      send("end", record);
    }

    // Pass 1: images off, as a reader who has decided nothing sees every message.
    send("phase", { name: "blocked" });
    for (const entry of entries) await lane(entry, "blocked");
    await sleep(1200);

    // Pass 2: the reader always allows images from the sender of the HTML messages (the real rule).
    send("phase", { name: "images" });
    const sender = "sender@example.org";
    await backend.setImageRule({ scope: "address", value: sender, decision: "allow" });
    for (const entry of entries.filter((e) => e.from === sender)) await lane(entry, "images");
    await sleep(1200);

    // Pass 3: the walls on their own. The message's HTML goes into the frame as sent, past the
    // sanitizer, into the same two pages the reader uses.
    send("phase", { name: "bypass" });
    const inject = async (
      id: string,
      page: string,
      html: string,
      which: SecurityRecord["lane"],
      navigateTo = false,
    ) => {
      resetPwned();
      send("begin", { id, lane: which });
      await sleep(100);
      const record: { -readonly [K in keyof SecurityRecord]: SecurityRecord[K] } = {
        id,
        lane: which,
        scriptRan: false,
        cspViolations: 0,
      };
      const el = document.createElement("iframe");
      if (MAIL_FRAME_SANDBOX !== undefined) el.setAttribute("sandbox", MAIL_FRAME_SANDBOX);
      el.style.cssText = "position:fixed;left:-9999px;width:600px;height:400px";
      el.src = page;
      const loaded = new Promise((r) => el.addEventListener("load", r, { once: true }));
      document.body.append(el);
      await loaded;
      const doc = el.contentDocument;
      if (doc) {
        let violations = 0;
        doc.addEventListener("securitypolicyviolation", () => violations++);
        doc.documentElement.innerHTML = html;
        // A wall test of navigation: the page itself sends the frame where the message's first link
        // points, as any future bug that navigated the frame would. Main's rule must stop it.
        if (navigateTo) {
          const target = doc.querySelector("a[href]")?.getAttribute("href");
          if (target) el.src = target;
        }
        await sleep(900);
        record.cspViolations = violations;
      }
      record.scriptRan = Boolean(pwned());
      el.remove();
      send("end", record);
    };
    for (const entry of entries.filter((e) => e.id.startsWith("html-wall"))) {
      const { html } = await backend.getMessageHtml(entry.key);
      if (html === null) continue;
      const navigates = entry.id.startsWith("html-wall-parent-navigates");
      await inject(entry.id, "./mail.html", html, "bypass-blocked", navigates);
      await inject(entry.id, "./mail-images.html", html, "bypass-images", navigates);
    }
    // Control for the navigation spy and for the wall test above: the page sends the frame to one of
    // our own pages, which main must let through and the spy must show.
    await inject(
      "control-parent-navigates-to-own-page",
      "./mail.html",
      '<a href="./mail-images.html">own page</a>',
      "control",
      true,
    );

    // Control for the main-frame navigation spy: the page itself tries to leave.
    send("begin", { id: "control-main-frame-navigation", lane: "control" });
    await sleep(150);
    window.location.assign("https://control.invalid/main-frame-navigation");
    await sleep(500);
    send("end", {
      id: "control-main-frame-navigation",
      lane: "control",
      scriptRan: false,
      cspViolations: 0,
    });
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
  }
  report.cspViolations = cspViolations().length;
  window.postMessage({ mattersSmoke: report }, "*");
}
