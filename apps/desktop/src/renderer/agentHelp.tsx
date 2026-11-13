// The agent's help while writing (ADR 0098, 0132), the same in the reply under a thread and in the
// full composer, for a reply and for a new message: the ✦ Agent button and its menu (⌘J) with the
// field where the writer tells the agent what to write, the line that says what the agent changed
// with Keep and Undo, and the quiet check in the footer. Only a message that answers a thread gets
// the help that reads it (the check, answers, placeholders). The editor owns the text; this only asks.
import { onCleanup, onMount, Show } from "solid-js";
import type { ReplyCheck } from "./replyAgent.ts";
import type { AgentAction, AgentHelp } from "./writingHelp.ts";

const noteButton = "h-[22px] cursor-default rounded-[6px] bg-bg px-2 text-[12px] text-ink";

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
          title="Tell the agent what to write, or ask it about this message  ⌘J"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => h().setMenu(!h().menu())}
        >
          <span aria-hidden="true">✦</span>
          {h().busy() ?? "Agent"}
          <span class="text-[10px] font-normal text-secondary">⌘J</span>
        </button>
        <Show when={h().menu()}>
          <AgentMenu
            thread={h().hasThread()}
            words={h().words()}
            onPick={(k) => void h().run(k)}
            onWrite={(words) => void h().run("write", words)}
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
  /** The message answers a thread: the items that read it are there. */
  thread: boolean;
  /** What the writer last asked and did not get; the field starts with it. */
  words: string;
  onPick: (k: AgentAction) => void;
  /** The writer's own words, from the field. */
  onWrite: (words: string) => void;
  /** `refocus`: the keyboard closed it, so the text takes the focus back. */
  onClose: (refocus?: boolean) => void;
}) {
  let el!: HTMLDivElement;
  let field!: HTMLInputElement;
  onMount(() => {
    field.focus();
    field.select();
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
        // The menu's keys are the menu's: arrows move, Home/End jump, Esc and Tab close. The
        // field is the first stop of the arrows; Home and End stay in it, for the text.
        const items = [...el.querySelectorAll<HTMLElement>("input, [role=menuitem]")];
        const at = items.indexOf(document.activeElement as HTMLElement);
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
      <input
        ref={field}
        type="text"
        autocomplete="off"
        spellcheck
        aria-label="Tell the agent what to write or change"
        placeholder="Tell the agent what to write or change"
        value={props.words}
        class="selectable mb-0.5 h-7 w-full rounded-[6px] border border-hairline bg-bg px-2 text-[13px] text-ink outline-none placeholder:text-secondary focus:border-agent-edge"
        onKeyDown={(e) => {
          if (e.isComposing) {
            e.stopPropagation();
            return;
          }
          if (e.key === "Enter" && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
            e.preventDefault();
            e.stopPropagation();
            const words = field.value.trim();
            if (words !== "") props.onWrite(words);
            return;
          }
          // Arrows, Esc and Tab are the menu's; ⌘J goes on to the editor, which closes the menu.
          const menuKey = ["ArrowDown", "ArrowUp", "Escape", "Tab"].includes(e.key);
          const agentKey = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "j";
          if (menuKey || agentKey) return;
          // The rest is typing: neither the menu, the composer nor the window sees it.
          e.stopPropagation();
        }}
      />
      <p class="m-0 px-2 pt-1.5 pb-0.5 text-[11px] text-secondary">Rewrite what you wrote</p>
      {item("shorter", "Shorter")}
      {item("formal", "More formal")}
      {item("english", "In English")}
      <Show when={props.thread}>
        <p class="m-0 px-2 pt-1.5 pb-0.5 text-[11px] text-secondary">From the conversation</p>
        {item("answer", "Answer each of the questions")}
        {item("fill", "Fill in the placeholders")}
      </Show>
      <p class="m-0 mt-1 border-t border-hairline px-2 pt-1.5 pb-1 text-[11px] text-secondary">
        Runs on your plan. It never sends.
      </p>
    </div>
  );
}
