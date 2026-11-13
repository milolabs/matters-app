// The state of the agent's help while writing (ADR 0098, 0132): the menu, what the agent is doing,
// the note with Keep and Undo, the quiet check, and the writer's own words for the agent. The
// controls are in agentHelp.tsx. The editor owns the text; this only asks. A message that answers
// no thread gets no check, no answers and no placeholders filled: it has no thread to read.
import type { EditorView } from "@codemirror/view";
import { type Accessor, createSignal, onCleanup } from "solid-js";
import type { ComposerSession } from "./compose.ts";
import { ownText, setSuggestions } from "./liveMarkdown.ts";
import type { ReplyAgent, ReplyCheck, RewriteKind } from "./replyAgent.ts";

export type AgentAction = RewriteKind | "answer" | "fill" | "write";

const CHECK_AFTER_MS = 1500;

export function createAgentHelp(opts: {
  session: Accessor<ComposerSession>;
  view: () => EditorView | undefined;
  agent: () => ReplyAgent | undefined;
}) {
  const [menu, setMenu] = createSignal(false);
  const [busy, setBusy] = createSignal<string | null>(null);
  const [note, setNote] = createSignal<{ text: string; before: string; changed: boolean } | null>(
    null,
  );
  const [problem, setProblem] = createSignal("");
  const [check, setCheck] = createSignal<ReplyCheck | null>(null);
  // What the writer last asked in their own words; kept until it worked, so a failure can be retried.
  const [words, setWords] = createSignal("");

  /** `asked`: the writer's own words, for `write`. */
  async function run(kind: AgentAction, asked = "") {
    const a = opts.agent();
    const v = opts.view();
    if (!a || !v || busy() !== null) return;
    // The thread's help needs a thread; a new message and a forward have none (ADR 0132).
    const t = a.thread;
    if (!t && (kind === "answer" || kind === "fill")) return;
    if (kind === "write" && asked.trim() === "") return;
    setMenu(false);
    setProblem("");
    v.focus();
    const doc = v.state.doc.toString();
    setBusy(BUSY_TEXT[kind]);
    if (kind === "write") setWords(asked);
    try {
      if (kind === "fill") {
        const found = (await t?.fill(doc)) ?? [];
        v.dispatch({ effects: setSuggestions.of(found) });
        if (found.length === 0)
          setProblem("The agent found nothing in the thread for the placeholders.");
        return;
      }
      // The whole text comes back, the quote as it was (ADR 0098).
      // The answer covers what the check found open; the two never disagree silently.
      const open = kind === "answer" ? (check()?.missing ?? []) : [];
      const next =
        kind === "write"
          ? await a.write(asked, doc)
          : kind === "answer"
            ? ((await t?.answer(doc, open)) ?? doc)
            : await a.rewrite(kind, doc);
      // The writer typed while the agent worked: the answer is for a text that is no longer
      // there, and Undo would give back the older one. Their text stays, and so do their words.
      if (v.state.doc.toString() !== doc) {
        setProblem(CHANGED_TEXT);
        return;
      }
      if (kind === "write") setWords("");
      if (next === doc) {
        const text =
          open.length > 0
            ? `The agent could not write an answer for: ${open.join("; ")}. Answer it yourself, or leave it if it needs none.`
            : SAME_TEXT[kind];
        setNote({ text, before: doc, changed: false });
        return;
      }
      v.dispatch({
        changes: { from: 0, to: v.state.doc.length, insert: next },
        userEvent: "input.agent",
      });
      setNote({ text: DONE_TEXT[kind], before: doc, changed: true });
      // Checked again at once: the line in the footer says what is true now.
      if (kind === "answer") checkNow(next);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  function undo() {
    const n = note();
    const v = opts.view();
    if (!n || !v) return;
    v.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: n.before } });
    setNote(null);
    v.focus();
  }

  // The check runs a moment after the writer stops, never while they type.
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  function bodyChanged(text: string) {
    const t = opts.agent()?.thread;
    if (!t) return;
    clearTimeout(timer);
    if (ownText(text).trim().length < 20) {
      setCheck(null);
      return;
    }
    const mine = ++seq;
    timer = setTimeout(() => {
      t.check(text).then(
        (r) => {
          if (mine === seq) setCheck(r);
        },
        () => {},
      );
    }, CHECK_AFTER_MS);
  }
  onCleanup(() => clearTimeout(timer));

  function checkNow(text: string) {
    const t = opts.agent()?.thread;
    if (!t) return;
    clearTimeout(timer);
    const mine = ++seq;
    t.check(text).then(
      (r) => {
        if (mine === seq) setCheck(r);
      },
      () => {},
    );
  }

  /** ⌘J: opens or closes the menu. True when it was the agent's key. */
  function onKey(e: KeyboardEvent): boolean {
    if (!opts.agent() || !(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "j") return false;
    e.preventDefault();
    e.stopPropagation();
    // Closed from the menu's field or an item: the text takes the focus back.
    if (menu()) closeMenu(true);
    else setMenu(true);
    return true;
  }

  /** Asks once at the start too: a reopened draft may already be written. */
  function start(text: string) {
    bodyChanged(text);
    if (opts.agent()?.thread && /\[[^\]\n]+\]/.test(ownText(text))) void run("fill");
  }

  const closeMenu = (refocus = false) => {
    setMenu(false);
    if (refocus) opts.view()?.focus();
  };

  return {
    menu,
    setMenu,
    closeMenu,
    busy,
    note,
    setNote,
    problem,
    check,
    words,
    run,
    undo,
    bodyChanged,
    onKey,
    start,
    available: () => opts.agent() !== undefined,
    /** The message answers a thread, so the help that reads it is there. */
    hasThread: () => opts.agent()?.thread !== undefined,
  };
}

export type AgentHelp = ReturnType<typeof createAgentHelp>;

/** Said when the text changed under a turn, so its answer was not put in. */
export const CHANGED_TEXT =
  "You changed the text while the agent was working, so its answer was not used. Ask again.";
const BUSY_TEXT: Record<AgentAction, string> = {
  shorter: "Shortening…",
  formal: "Rewriting…",
  english: "Translating…",
  answer: "Answering…",
  fill: "Looking…",
  write: "Writing…",
};
const DONE_TEXT: Record<RewriteKind | "answer" | "write", string> = {
  shorter: "The agent made it shorter.",
  formal: "The agent made it more formal.",
  english: "The agent put it in English. Check that the other side reads English.",
  answer: "The agent added answers to the questions you had left.",
  write: "The agent wrote it as you asked.",
};
const SAME_TEXT: Record<RewriteKind | "answer" | "write", string> = {
  shorter: "It is already short; the agent changed nothing.",
  formal: "The agent changed nothing.",
  english: "The agent changed nothing.",
  answer: "The agent found nothing to add.",
  write: "The agent changed nothing.",
};
