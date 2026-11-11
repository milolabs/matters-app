// The agent's help while writing (ADR 0098), the same in the reply under a thread and in the
// full composer: the ✦ Agent button and its menu (⌘J), the line that says what the agent changed
// with Keep and Undo, and the quiet check in the footer. The editor owns the text; this only asks.
import type { EditorView } from "@codemirror/view";
import { type Accessor, createSignal, onCleanup, onMount, Show } from "solid-js";
import type { ComposerSession } from "./compose.ts";
import { ownText, setSuggestions } from "./liveMarkdown.ts";
import type { ReplyAgent, ReplyCheck, RewriteKind } from "./replyAgent.ts";

export type AgentAction = RewriteKind | "answer" | "fill";

const CHECK_AFTER_MS = 1500;
const noteButton = "h-[22px] cursor-default rounded-[6px] bg-bg px-2 text-[12px] text-ink";

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

  async function run(kind: AgentAction) {
    const a = opts.agent();
    const v = opts.view();
    if (!a || !v || busy() !== null) return;
    setMenu(false);
    setProblem("");
    v.focus();
    const doc = v.state.doc.toString();
    setBusy(BUSY_TEXT[kind]);
    try {
      if (kind === "fill") {
        const found = await a.fill(doc);
        v.dispatch({ effects: setSuggestions.of(found) });
        if (found.length === 0)
          setProblem("The agent found nothing in the thread for the placeholders.");
        return;
      }
      // The whole text comes back, the quote as it was (ADR 0098).
      // The answer covers what the check found open; the two never disagree silently.
      const open = kind === "answer" ? (check()?.missing ?? []) : [];
      const next = kind === "answer" ? await a.answer(doc, open) : await a.rewrite(kind, doc);
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
    const a = opts.agent();
    if (!a) return;
    clearTimeout(timer);
    if (ownText(text).trim().length < 20) {
      setCheck(null);
      return;
    }
    const mine = ++seq;
    timer = setTimeout(() => {
      a.check(text).then(
        (r) => {
          if (mine === seq) setCheck(r);
        },
        () => {},
      );
    }, CHECK_AFTER_MS);
  }
  onCleanup(() => clearTimeout(timer));

  function checkNow(text: string) {
    const a = opts.agent();
    if (!a) return;
    clearTimeout(timer);
    const mine = ++seq;
    a.check(text).then(
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
    setMenu(!menu());
    return true;
  }

  /** Asks once at the start too: a reopened draft may already be written. */
  function start(text: string) {
    bodyChanged(text);
    if (opts.agent() && /\[[^\]\n]+\]/.test(ownText(text))) void run("fill");
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
    run,
    undo,
    bodyChanged,
    onKey,
    start,
    available: () => opts.agent() !== undefined,
  };
}

export type AgentHelp = ReturnType<typeof createAgentHelp>;

/** The ✦ Agent button and its menu, for the end of the formatting bar. */
export function AgentButton(props: { help: AgentHelp }) {
  const h = () => props.help;
  return (
    <Show when={h().available()}>
      <div class="relative">
        <button
          type="button"
          class="inline-flex h-[26px] cursor-default items-center gap-1.5 rounded-[6px] px-2 text-[12px] font-medium text-agent hover:bg-agent-soft aria-expanded:bg-agent-soft"
          aria-haspopup="menu"
          aria-expanded={h().menu()}
          title="Ask the agent about this message  ⌘J"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => h().setMenu(!h().menu())}
        >
          <span aria-hidden="true">✦</span>
          {h().busy() ?? "Agent"}
          <span class="text-[10px] font-normal text-secondary">⌘J</span>
        </button>
        <Show when={h().menu()}>
          <AgentMenu
            onPick={(k) => void h().run(k)}
            onClose={(refocus) => h().closeMenu(refocus)}
          />
        </Show>
      </div>
    </Show>
  );
}

/** What the agent just did to the text, with Keep and Undo; OK alone when it changed nothing. */
export function AgentNote(props: { help: AgentHelp }) {
  const h = () => props.help;
  return (
    <Show when={h().note()}>
      {(n) => (
        <div
          role="status"
          class="flex items-center gap-2 border-b border-hairline bg-agent-soft py-1.5 pr-2 pl-4 text-[12px] text-agent"
        >
          <span aria-hidden="true">✦</span>
          <span class="min-w-0 flex-1">{n().text}</span>
          <button type="button" class={noteButton} onClick={() => h().setNote(null)}>
            {n().changed ? "Keep" : "OK"}
          </button>
          <Show when={n().changed}>
            <button type="button" class={noteButton} onClick={() => h().undo()}>
              Undo
            </button>
          </Show>
        </div>
      )}
    </Show>
  );
}

const BUSY_TEXT: Record<AgentAction, string> = {
  shorter: "Shortening…",
  formal: "Rewriting…",
  english: "Translating…",
  answer: "Answering…",
  fill: "Looking…",
};
const DONE_TEXT: Record<RewriteKind | "answer", string> = {
  shorter: "The agent made it shorter.",
  formal: "The agent made it more formal.",
  english: "The agent put it in English. Check that the other side reads English.",
  answer: "The agent added answers to the questions you had left.",
};
const SAME_TEXT: Record<RewriteKind | "answer", string> = {
  shorter: "It is already short; the agent changed nothing.",
  formal: "The agent changed nothing.",
  english: "The agent changed nothing.",
  answer: "The agent found nothing to add.",
};

/** The agent's quiet word on the reply: how many of the questions it answers. Never blocks Send. */
export function CheckLine(props: { check: ReplyCheck | null; onAnswer: () => void }) {
  return (
    // A message that asks nothing (a newsletter, a notice) gets no line at all.
    <Show
      when={props.check !== null && props.check.asked > 0 ? props.check : null}
      fallback={<span class="text-secondary">Draft saves itself</span>}
    >
      {(c) => (
        <span class="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 text-secondary">
          <span aria-hidden="true" class="text-agent">
            ✦
          </span>
          <Show
            when={c().missing.length > 0}
            fallback={
              <span>
                {c().asked === 1
                  ? "Answers the one question asked."
                  : `Answers all ${c().asked} of the questions.`}
              </span>
            }
          >
            <span>
              Answers {c().answered} of {c().asked}.
            </span>
            <button
              type="button"
              class="cursor-default text-agent underline decoration-agent-edge underline-offset-[3px]"
              title="Let the agent add an answer"
              onClick={() => props.onAnswer()}
            >
              Not yet: {c().missing[0]}
              {c().missing.length > 1 ? ` and ${c().missing.length - 1} more` : ""}
            </button>
          </Show>
        </span>
      )}
    </Show>
  );
}

function AgentMenu(props: {
  onPick: (k: AgentAction) => void;
  /** `refocus`: the keyboard closed it, so the text takes the focus back. */
  onClose: (refocus?: boolean) => void;
}) {
  let el!: HTMLDivElement;
  onMount(() => {
    el.querySelector<HTMLButtonElement>("button")?.focus();
    const outside = (e: MouseEvent) => {
      if (!el.parentElement?.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", outside, true);
    onCleanup(() => document.removeEventListener("mousedown", outside, true));
  });
  const item = (k: AgentAction, label: string) => (
    <button
      type="button"
      role="menuitem"
      class="h-7 cursor-default rounded-[6px] px-2 text-left text-[13px] hover:bg-agent-soft focus-visible:bg-agent-soft focus-visible:outline-none"
      onClick={() => props.onPick(k)}
    >
      {label}
    </button>
  );
  return (
    <div
      ref={el}
      role="menu"
      aria-label="The agent"
      class="absolute top-[30px] right-0 z-30 flex w-[250px] flex-col rounded-[10px] border border-hairline bg-chrome p-1 shadow-(--pop)"
      onKeyDown={(e) => {
        // The menu's keys are the menu's: arrows move, Home/End jump, Esc and Tab close.
        const items = [...el.querySelectorAll<HTMLButtonElement>("[role=menuitem]")];
        const at = items.indexOf(document.activeElement as HTMLButtonElement);
        const go = (i: number) => items[(i + items.length) % items.length]?.focus();
        if (e.key === "ArrowDown") go(at + 1);
        else if (e.key === "ArrowUp") go(at < 0 ? items.length - 1 : at - 1);
        else if (e.key === "Home") go(0);
        else if (e.key === "End") go(items.length - 1);
        else if (e.key === "Escape" || e.key === "Tab") props.onClose(true);
        else return;
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <p class="m-0 px-2 pt-1.5 pb-0.5 text-[11px] text-secondary">Rewrite what you wrote</p>
      {item("shorter", "Shorter")}
      {item("formal", "More formal")}
      {item("english", "In English")}
      <p class="m-0 px-2 pt-1.5 pb-0.5 text-[11px] text-secondary">From the conversation</p>
      {item("answer", "Answer each of the questions")}
      {item("fill", "Fill in the placeholders")}
      <p class="m-0 mt-1 border-t border-hairline px-2 pt-1.5 pb-1 text-[11px] text-secondary">
        Runs on your plan. It never sends.
      </p>
    </div>
  );
}
