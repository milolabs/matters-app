import type { PreparedWork, TalkAgentEntry, TalkHit, TalkSummary } from "@matters/core";
import { TALK_GROUP_LABELS, type TalkGroup, talkGroup, talkTitle } from "@matters/core";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { AgentStore } from "./agent.ts";
import { AgentRing } from "./agentLayer.tsx";
import {
  type AgentTalkStore,
  foundFooter,
  isAtBottom,
  type TalkThreadRef,
  threadsOf,
  trailStepLabel,
} from "./agentTalk.ts";
import { modelName, planButton } from "./agentText.ts";
import type { Backend } from "./client.ts";
import { letterDate, listDate } from "./format.ts";
import {
  CheckIcon,
  ChevronDownIcon,
  MoreIcon,
  NarrowIcon,
  NewTalkIcon,
  PanelIcon,
  Ring,
  WidenIcon,
} from "./icons.tsx";
import type { PaneWidth } from "./listDivider.tsx";
import { PaneDivider } from "./listDivider.tsx";
import { OVERLAY_BELOW, WIDE_STRIP, WIDE_TEXT } from "./paneWidth.ts";
import { PlansLine } from "./plansLine.tsx";
import { createMenuAnchor, menuPoint, PopMenu } from "./popMenu.tsx";
import { FactRows, type OfferActions, OfferRows } from "./talkOffers.tsx";
import { toolButton } from "./ui.ts";

// The agent's column and its prompt (ADR 0064, ADR 0069). Everything the agent says is the
// agent's: a dashed left edge, the agent colour and the open ring. The prompt's send button is in
// the agent colour and never black, since black sends mail. Model text is shown as text nodes
// only: nothing in it is markup, and nothing in it is a link.

const PROMPT = "data-agent-prompt";

/** Puts the cursor in the prompt. It spends nothing; sending is a separate press. */
export function focusAgentPrompt(): boolean {
  const field = document.querySelector<HTMLTextAreaElement>(`[${PROMPT}]`);
  field?.focus({ preventScroll: true });
  return field !== null && document.activeElement === field;
}

/**
 * Shows the column if it is hidden and puts the cursor in the prompt. The column is drawn as soon
 * as the choice is made, so the prompt is normally there at once; if it is not, the next
 * microtask and then the next frame try again.
 */
export function openAgentPrompt(talk: Pick<AgentTalkStore, "setOpen">): void {
  talk.setOpen(true);
  if (focusAgentPrompt()) return;
  queueMicrotask(() => {
    if (!focusAgentPrompt()) requestAnimationFrame(() => focusAgentPrompt());
  });
}

let opener: (() => void) | null = null;

/** The window says how to ask the agent: open its column and focus the prompt. Returns the undo. */
export function registerAgentOpener(open: () => void): () => void {
  opener = open;
  return () => {
    if (opener === open) opener = null;
  };
}

/** `g`, the strip, `Answer`, the pill: every way to the prompt first opens a hidden column. */
export function askTheAgent(): void {
  if (opener !== null) opener();
  else focusAgentPrompt();
}

/** The small buttons inside the pane, in the mini style. */
const mini =
  "h-[22px] shrink-0 cursor-default rounded-[6px] bg-button px-2 text-[11.5px] text-ink disabled:opacity-35";

/**
 * The button in the top right corner that opens and closes the agent's column (ADR 0069, rule 2).
 * Opening puts the cursor in the prompt; closing gives the focus back to the reader. While the
 * column is closed and the plan is at its limit, a dot in the late colour says so, and the
 * tooltip names it, so the plan's status stays in reach (ADR 0052, rule 11).
 */
export function AgentPaneButton(props: {
  talk: AgentTalkStore;
  agent: AgentStore;
  onHidden: () => void;
}) {
  const plan = () => {
    const status = props.agent.status();
    return status === null ? null : planButton(status, Date.now());
  };
  const open = () => props.talk.paneOpen();
  const paused = () => !open() && plan()?.late === true;
  const title = () =>
    open() ? "Hide the agent" : `Show the agent  g${paused() ? `. ${plan()?.text ?? ""}` : ""}`;
  return (
    <button
      type="button"
      data-agent-toggle
      aria-label={
        paused() ? `Show or hide the agent. ${plan()?.text ?? ""}` : "Show or hide the agent"
      }
      aria-pressed={open()}
      title={title()}
      class={`${toolButton} relative`}
      classList={{ "bg-button text-ink": open() }}
      onClick={() => {
        if (open()) {
          props.talk.setOpen(false);
          props.onHidden();
        } else askTheAgent();
      }}
    >
      <PanelIcon />
      <Show when={paused()}>
        <span
          aria-hidden="true"
          class="absolute top-1 right-1 size-[7px] rounded-full bg-late ring-2 ring-chrome"
        />
      </Show>
    </button>
  );
}

const sendIcon = (
  <svg
    width="14"
    height="14"
    viewBox="0 0 16 16"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);

/**
 * The prompt, at the foot of the agent's column: one box with the field above and, under it, the
 * foot row of the plans line with the send button at its end. Enter sends to the agent, never as
 * mail; Shift+Enter is a new line; Cmd or Ctrl with Enter does nothing here, so the key that
 * sends mail cannot send this. What the agent looks at is chosen in the column's header.
 */
export function AgentPrompt(props: {
  talk: AgentTalkStore;
  agent: AgentStore;
  backend: Backend;
  thread: () => TalkThreadRef | null;
  /** False when the thread's account was not shared with the agent. */
  shared: () => boolean;
  /** The thread has an open question of the agent: what is typed here may answer it. */
  question: () => boolean;
  onOpenSettings: () => void;
  /** Escape: the focus goes back to the reader. */
  onLeave: () => void;
  /** Escape in a widened column: back to its side first. True when it was widened. */
  onNarrow?: () => boolean;
}) {
  const { talk } = props;
  const all = () => talk.scope() === "all";
  const blank = () => talk.words().trim() === "";
  const canSend = () => all() || props.shared();
  let textarea: HTMLTextAreaElement | undefined;

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (e.key === "Enter") {
      // These keys are this field's: none reaches the window, where ⌘↵ would send mail.
      e.stopPropagation();
      if (e.shiftKey && !e.metaKey && !e.ctrlKey) return;
      e.preventDefault();
      if (e.metaKey || e.ctrlKey || e.repeat) return;
      void talk.send();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      if (props.onNarrow?.()) return;
      // In All mail Esc goes back to the thread, or only leaves the field when none is open.
      if (!all()) props.onLeave();
      else if (props.thread() !== null) talk.setScope("thread");
      else textarea?.blur();
    }
  }

  const placeholder = () =>
    all()
      ? "Ask across your mail…"
      : props.question()
        ? "Answer the agent, or ask about this thread…"
        : "Ask about this thread…";

  return (
    <div class="relative shrink-0 px-2.5 pt-2 pb-2.5">
      <Show when={talk.problem() !== ""}>
        <p role="alert" class="mb-1.5 px-1 text-[12.5px] text-late">
          {talk.problem()}
        </p>
      </Show>
      <div class="rounded-[12px] border border-hairline bg-bg focus-within:border-agent-edge">
        <Show
          when={canSend()}
          fallback={
            <p class="flex min-h-[42px] min-w-0 flex-wrap items-center gap-2 px-3 pt-2.5 pb-1 text-[13px] text-agent">
              <span>You did not share this account with the agent.</span>
              <button type="button" class={mini} onClick={() => props.onOpenSettings()}>
                Settings…
              </button>
            </p>
          }
        >
          <label class="block">
            <span class="sr-only">Message to the agent. It never goes out as mail.</span>
            <textarea
              ref={textarea}
              data-agent-prompt
              rows={1}
              maxLength={2000}
              spellcheck
              placeholder={placeholder()}
              class="selectable block max-h-[140px] w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 text-[14px] leading-[21px] outline-none placeholder:text-secondary [field-sizing:content]"
              value={talk.words()}
              onInput={(e) => talk.setWords(e.currentTarget.value)}
              onKeyDown={onKeyDown}
            />
          </label>
        </Show>
        <PlansLine
          agent={props.agent}
          backend={props.backend}
          scope={talk.scope}
          hint={canSend()}
          onOpenSettings={props.onOpenSettings}
        >
          <Show when={canSend()}>
            <button
              type="button"
              aria-label="Send to the agent, not as mail"
              title="Send to the agent, not as mail  ↵"
              disabled={blank() || talk.busyNow()}
              class="inline-flex size-[28px] shrink-0 cursor-default items-center justify-center rounded-full bg-agent text-bg disabled:opacity-35"
              onClick={() => void talk.send()}
            >
              {sendIcon}
            </button>
          </Show>
        </PlansLine>
      </div>
    </div>
  );
}

/** The talk in view: about the open thread, or across all mail. */
export function AgentPane(props: {
  talk: AgentTalkStore;
  agent: AgentStore;
  backend: Backend;
  /** Its width and the line on its left edge that moves it. */
  pane: PaneWidth;
  thread: () => TalkThreadRef | null;
  /** The work the agent has prepared for the thread now, in whichever view shows it. */
  prepared: () => PreparedWork | null;
  /** False when the thread's account was not shared with the agent. */
  shared: () => boolean;
  /** The addresses of the accounts All mail searches: the ones the person agreed to. */
  addresses: () => readonly string[];
  /** Who is reading: the runtime's name, for the step line. */
  runtimeName: () => string;
  /** `See draft` and `See question`: scrolls to the frame under the letters. */
  onSeeWork: () => void;
  /** A row of an answer across all mail: the thread opens in the reader, with its own talk. */
  onOpenHit: (hit: TalkHit) => void;
  /** `Show this search in the list`: All mail with the query in the bar. */
  onShowSearch: (query: string) => void;
  /** What the rows of an answer's offers need of the app (ADR 0102). */
  offers: OfferActions;
  onOpenSettings: () => void;
  /** The focus goes back to the reader: Escape in the prompt, or hiding the column from inside. */
  onLeave: () => void;
}) {
  const { talk } = props;
  let body!: HTMLDivElement;
  const wide = () => props.pane.wide();
  /** Back to the side when widened; true when it was. */
  const narrow = () => {
    if (!wide()) return false;
    props.pane.setWide(false);
    return true;
  };
  // Widened, the talk's text keeps a readable column in the middle.
  const textInset = () => (wide() ? `max(14px, calc((100% - ${WIDE_TEXT}px) / 2))` : undefined);
  const all = () => talk.scope() === "all";
  const pending = () => talk.pendingNow();
  // The talk follows its newest line only while the person is at the bottom: an answer that grows
  // keeps its last line in view. Scrolled up, the reading position stays wherever it was left.
  // Another talk opens at the bottom, and so does the person's own question once it is sent. Older
  // entries loaded above (ADR 0086, rule 13) change nothing below.
  let stuck = true;
  const toBottom = () => {
    body.scrollTop = body.scrollHeight;
  };
  createEffect(
    on([() => talk.scope(), () => props.thread()?.id, () => talk.openTalkId()], () => {
      stuck = true;
      toBottom();
    }),
  );
  createEffect(
    on([() => talk.entries().at(-1), pending], ([last]) => {
      if (last?.role === "you") stuck = true;
      if (stuck) toBottom();
    }),
  );
  onMount(() => {
    const follow = () => {
      if (stuck) toBottom();
    };
    const grows = new MutationObserver(follow);
    grows.observe(body, { childList: true, subtree: true, characterData: true });
    const resizes = new ResizeObserver(follow);
    resizes.observe(body);
    onCleanup(() => {
      grows.disconnect();
      resizes.disconnect();
    });
  });
  let loadingOlder = false;
  async function onScroll() {
    stuck = isAtBottom(body);
    if (loadingOlder || !talk.hasOlder() || body.scrollTop > 48) return;
    loadingOlder = true;
    const before = body.scrollHeight;
    try {
      if (await talk.loadOlder()) {
        // What was at the top stays where it was; the page above it grows out of sight.
        requestAnimationFrame(() => {
          body.scrollTop += body.scrollHeight - before;
        });
      }
    } finally {
      loadingOlder = false;
    }
  }

  /** Esc in the pane, while in All mail, goes back to the thread. */
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Escape" && !e.defaultPrevented && narrow()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (e.key !== "Escape" || !all() || e.defaultPrevented) return;
    e.preventDefault();
    e.stopPropagation();
    if (props.thread() !== null) talk.setScope("thread");
    else if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  }

  const segment =
    "inline-flex h-6 cursor-default items-center gap-1.5 rounded-[6px] px-2.5 text-[12.5px] disabled:opacity-40";

  return (
    <>
      {/* Widened, the column leaves the row: this keeps its place so nothing under it moves. */}
      <Show when={wide() && props.pane.windowWidth() >= OVERLAY_BELOW}>
        <div class="shrink-0" style={{ width: `${props.pane.width()}px` }} aria-hidden="true" />
      </Show>
      <aside
        aria-label={all() ? "The agent, all mail" : "The agent, this thread"}
        class={
          wide()
            ? "fixed top-[52px] right-0 bottom-0 z-30 flex min-h-0 flex-col border-l border-agent-edge bg-agent-wash shadow-[var(--pop)]"
            : "relative flex min-h-0 shrink-0 flex-col border-l border-agent-line bg-agent-wash max-[1059px]:absolute max-[1059px]:inset-y-0 max-[1059px]:right-0 max-[1059px]:z-20 max-[1059px]:shadow-[var(--pop)]"
        }
        style={wide() ? { left: `${WIDE_STRIP}px` } : { width: `${props.pane.width()}px` }}
        data-agent-wide={wide() ? "" : undefined}
        onKeyDown={onKeyDown}
      >
        <Show when={!wide()}>
          <PaneDivider pane={props.pane} />
        </Show>
        <header class="flex h-[46px] shrink-0 items-center gap-2 border-b border-agent-line pr-3 pl-3">
          <fieldset class="m-0 flex min-w-0 rounded-[8px] border-0 bg-fill p-0.5">
            <legend class="sr-only">What the agent looks at</legend>
            <button
              type="button"
              aria-pressed={!all()}
              disabled={props.thread() === null}
              title={
                props.thread() === null
                  ? "Open a thread to ask about it. Esc goes back to a thread from All mail."
                  : "Ask about the open thread. Esc goes back to it from All mail."
              }
              class={segment}
              classList={{ "bg-bg font-medium text-agent": !all(), "text-mid": all() }}
              onClick={() => {
                talk.setScope("thread");
                focusAgentPrompt();
              }}
            >
              This thread
            </button>
            <button
              type="button"
              aria-pressed={all()}
              title="Ask across your mail  ⌘J"
              class={segment}
              classList={{ "bg-bg font-medium text-agent": all(), "text-mid": !all() }}
              onClick={() => {
                talk.setScope("all");
                focusAgentPrompt();
              }}
            >
              All mail <span class="font-normal text-secondary">⌘J</span>
            </button>
          </fieldset>
          <button
            type="button"
            aria-label={wide() ? "Back to the side" : "Widen the agent"}
            aria-pressed={wide()}
            title={wide() ? "Back to the side  ⇧⌘E" : "Widen  ⇧⌘E"}
            class={`ml-auto ${toolButton}`}
            classList={{ "bg-selected": wide() }}
            data-agent-widen
            onClick={() => props.pane.setWide(!wide())}
          >
            <Show when={wide()} fallback={<WidenIcon />}>
              <NarrowIcon />
            </Show>
          </button>
        </header>
        <Show when={all()}>
          <TalkBar talk={talk} />
          <p class="shrink-0 px-3.5 pt-2 text-[11.5px] text-secondary [overflow-wrap:anywhere]">
            Searches the accounts you agreed to: {props.addresses().join(", ")}
          </p>
        </Show>
        <div
          ref={body}
          class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-3.5"
          style={{ "padding-inline": textInset() }}
          onScroll={() => void onScroll()}
        >
          <Show when={talk.hasOlder()}>
            <p class="text-center text-[11.5px] text-secondary" data-talk-older>
              Scroll up for earlier questions in this talk.
            </p>
          </Show>
          <p class="text-center text-[11.5px] text-secondary">
            Only you and the agent see this. It never goes out as mail.
          </p>
          <Show
            when={all()}
            fallback={
              <Show
                when={props.thread()}
                fallback={
                  <p class="text-center text-[12.5px] text-secondary">
                    Open a thread to talk with the agent about it.
                  </p>
                }
              >
                <For each={talk.entries()}>
                  {(entry) =>
                    entry.role === "you" ? (
                      <YouBubble text={entry.text} />
                    ) : (
                      <AgentEntry
                        entry={entry}
                        talk={talk}
                        prepared={props.prepared()}
                        latestWork={talk.latestWorkId() === entry.id}
                        onSeeWork={props.onSeeWork}
                      />
                    )
                  }
                </For>
                <Show when={pending()}>
                  {(words) => (
                    <>
                      <YouBubble text={words()} />
                      <div
                        role="status"
                        class="flex items-center gap-2 text-[12.5px] text-agent"
                        data-agent-step
                      >
                        <AgentRing size={12} />
                        <span class="min-w-0 flex-1 truncate">
                          {props.runtimeName()} is reading this thread…
                        </span>
                        <button type="button" class={mini} onClick={() => talk.stop()}>
                          Stop
                        </button>
                      </div>
                    </>
                  )}
                </Show>
                <Show when={talk.newMessage()}>
                  <p class="text-center text-[11.5px] text-secondary">
                    A new message arrived since this.
                  </p>
                </Show>
              </Show>
            }
          >
            <Show when={talk.entries().length === 0 && pending() === null}>
              <p class="text-center text-[12.5px] text-secondary">
                Ask a question about your mail. It looks through the accounts you agreed to.
              </p>
            </Show>
            <Show when={talk.busyElsewhere()}>
              <p
                role="status"
                class="flex items-center justify-center gap-2 text-[12px] text-agent"
              >
                <AgentRing size={12} />
                <span>The agent is still answering in another talk.</span>
                <button
                  type="button"
                  class={mini}
                  onClick={() => {
                    const id = talk.runningTalk();
                    if (typeof id === "number") talk.openFromList(id);
                    else talk.newTalk();
                  }}
                >
                  Show it
                </button>
              </p>
            </Show>
            <For each={talk.entries()}>
              {(entry) =>
                entry.role === "you" ? (
                  <YouBubble text={entry.text} />
                ) : (
                  <FoundEntry
                    entry={entry}
                    onOpenHit={props.onOpenHit}
                    onShowSearch={props.onShowSearch}
                    offers={props.offers}
                  />
                )
              }
            </For>
            <Show when={pending()}>
              {(words) => (
                <>
                  <YouBubble text={words()} />
                  <For each={talk.steps()}>
                    {(trail) =>
                      trail.kind === "note" ? (
                        // The agent's own words between its steps, apart from the facts around them.
                        <p
                          class="m-0 flex items-baseline gap-1.5 text-[12px] italic leading-[1.45] text-secondary"
                          data-agent-step
                          data-agent-note
                        >
                          <span class="shrink-0 not-italic">{trailStepLabel(trail.kind)}</span>
                          <span class="min-w-0">{trail.text}</span>
                        </p>
                      ) : (
                        <p
                          class="flex items-baseline gap-1.5 text-[12px] text-secondary"
                          data-agent-step
                        >
                          <span class="shrink-0">{trailStepLabel(trail.kind)}</span>
                          <span
                            class="min-w-0 truncate"
                            classList={{
                              "font-mono": trail.kind === "search" || trail.kind === "count",
                            }}
                          >
                            {trail.text}
                          </span>
                          <Show when={trail.kind === "search"}>
                            <span class="shrink-0">{threadsOf(trail.threads)}</span>
                          </Show>
                          <Show when={trail.kind === "count" && trail.detail}>
                            {(detail) => <span class="shrink-0">{detail()}</span>}
                          </Show>
                        </p>
                      )
                    }
                  </For>
                  <Show when={talk.step()}>
                    {(step) => (
                      <p
                        class="flex items-center gap-1.5 text-[11.5px] text-secondary"
                        data-agent-step
                      >
                        <CheckIcon />
                        <SearchedLine query={step().query} />
                      </p>
                    )}
                  </Show>
                  <div
                    role="status"
                    class="flex items-center gap-2 text-[12.5px] text-agent"
                    data-agent-step
                  >
                    <AgentRing size={12} />
                    <span class="min-w-0 flex-1 truncate">
                      <Show
                        when={talk.step()}
                        fallback={<>{props.runtimeName()} is searching your mail…</>}
                      >
                        {(step) => (
                          <>
                            {props.runtimeName()} is reading {threadsOf(step().threads)}…
                          </>
                        )}
                      </Show>
                    </span>
                    <button type="button" class={mini} onClick={() => talk.stop()}>
                      Stop
                    </button>
                  </div>
                </>
              )}
            </Show>
          </Show>
        </div>
        <div style={{ "padding-inline": wide() ? textInset() : undefined }}>
          <AgentPrompt
            talk={talk}
            agent={props.agent}
            backend={props.backend}
            thread={props.thread}
            shared={props.shared}
            question={() => props.prepared()?.kind === "needs"}
            onOpenSettings={props.onOpenSettings}
            onLeave={props.onLeave}
            onNarrow={narrow}
          />
        </div>
      </aside>
    </>
  );
}

/** A talk in the list: today by its time, earlier by its day. */
function talkWhen(t: TalkSummary): string {
  return listDate(t.lastAtMs);
}

type Confirming =
  | { readonly kind: "one"; readonly id: number; readonly title: string }
  | { readonly kind: "all"; readonly count: number };

/**
 * The talks across all mail (ADR 0086, rules 3, 5, 9 to 11): the name of the talk in view opens
 * the list, newest first and grouped by day; `New talk` starts one. A row's `⋯` renames or deletes
 * that talk, and the foot of the list deletes them all. Deleting asks once, with the focus on
 * Cancel, since it cannot be undone.
 */
function TalkBar(props: { talk: AgentTalkStore }) {
  const { talk } = props;
  const list = createMenuAnchor();
  const [rowMenu, setRowMenu] = createSignal<{
    id: number;
    title: string;
    x: number;
    y: number;
  } | null>(null);
  const [renaming, setRenaming] = createSignal(false);
  const [confirming, setConfirming] = createSignal<Confirming | null>(null);
  let titleButton: HTMLButtonElement | undefined;

  const groups = createMemo(() => {
    const at = Date.now();
    const out: { group: TalkGroup; talks: TalkSummary[] }[] = [];
    for (const t of talk.talks()) {
      const group = talkGroup(t.lastAtMs, at);
      const last = out.at(-1);
      if (last?.group === group) last.talks.push(t);
      else out.push({ group, talks: [t] });
    }
    return out;
  });
  const empty = () => talk.openTalkId() === null && talk.pendingNow() === null;

  function startRename() {
    setRenaming(true);
  }

  function finishRename(value: string | null) {
    const id = talk.openTalkId();
    setRenaming(false);
    queueMicrotask(() => titleButton?.focus());
    if (value === null || id === null) return;
    void talk.renameTalk(id, value);
  }

  return (
    <div class="shrink-0 border-b border-agent-line">
      <div class="flex h-[34px] items-center gap-1 pr-2 pl-2">
        <Show
          when={renaming()}
          fallback={
            <button
              ref={titleButton}
              type="button"
              aria-haspopup="menu"
              aria-expanded={list.at() !== null}
              title="Your talks across all mail"
              data-talk-title
              class="flex h-[26px] min-w-0 flex-1 cursor-default items-center gap-1 rounded-[6px] px-1.5 text-left text-[13px] font-medium hover:bg-fill"
              onClick={(e) => list.open(e.currentTarget)}
            >
              <span class="min-w-0 truncate">{talk.openTalkTitle()}</span>
              <span class="shrink-0 text-secondary">
                <ChevronDownIcon />
              </span>
            </button>
          }
        >
          <input
            data-talk-rename
            aria-label="The name of this talk"
            maxLength={60}
            value={talk.openTalkTitle()}
            class="selectable h-[26px] min-w-0 flex-1 rounded-[6px] border border-agent-edge bg-bg px-1.5 text-[13px] outline-none"
            ref={(el) =>
              queueMicrotask(() => {
                el.focus();
                el.select();
              })
            }
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Enter") {
                e.preventDefault();
                finishRename(e.currentTarget.value);
              } else if (e.key === "Escape") {
                e.preventDefault();
                finishRename(null);
              }
            }}
            onBlur={(e) => {
              if (renaming()) finishRename(e.currentTarget.value);
            }}
          />
        </Show>
        <button
          type="button"
          aria-label="New talk"
          title={empty() ? "This talk is new" : "New talk  ⇧⌘J"}
          disabled={empty()}
          data-talk-new
          class="inline-flex size-[26px] shrink-0 cursor-default items-center justify-center rounded-[6px] text-mid hover:bg-fill disabled:opacity-35"
          onClick={() => {
            talk.newTalk();
            focusAgentPrompt();
          }}
        >
          <NewTalkIcon />
        </button>
      </div>
      <Show when={confirming()}>
        {(c) => (
          <ConfirmDelete
            what={c()}
            onCancel={() => {
              setConfirming(null);
              queueMicrotask(() => titleButton?.focus());
            }}
            onConfirm={() => {
              const what = c();
              setConfirming(null);
              if (what.kind === "one") void talk.deleteTalk(what.id);
              else void talk.deleteAllTalks();
              queueMicrotask(() => focusAgentPrompt());
            }}
          />
        )}
      </Show>
      <Show when={list.at()}>
        {(at) => (
          <PopMenu label="Talks across all mail" x={at().x} y={at().y} onClose={list.close}>
            <Show
              when={groups().length > 0}
              fallback={<div class="vhead">No earlier talks yet</div>}
            >
              <div class="max-h-[60vh] overflow-y-auto">
                <For each={groups()}>
                  {(g) => (
                    <>
                      <div class="vhead">{TALK_GROUP_LABELS[g.group]}</div>
                      <For each={g.talks}>
                        {(t) => (
                          <div class="flex items-center" data-talk-row>
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={talk.openTalkId() === t.id}
                              style={{ flex: "1 1 auto", "min-width": "0", width: "auto" }}
                              onClick={() => {
                                list.close(false);
                                talk.openFromList(t.id);
                                focusAgentPrompt();
                              }}
                            >
                              <span class="w-[16px] shrink-0 self-center text-agent">
                                <Show
                                  when={talk.runningTalk() === t.id}
                                  fallback={
                                    <Show when={talk.openTalkId() === t.id}>
                                      <CheckIcon />
                                    </Show>
                                  }
                                >
                                  <AgentRing size={10} />
                                </Show>
                              </span>
                              <span class="trunc flex-1">{talkTitle(t)}</span>
                              <span class="ml-2 text-[11.5px] text-secondary">{talkWhen(t)}</span>
                            </button>
                            <button
                              type="button"
                              role="menuitem"
                              aria-label={`More for ${talkTitle(t)}`}
                              title="Rename or delete"
                              style={{ width: "24px", "flex-shrink": "0", padding: "0" }}
                              class="justify-center text-secondary"
                              onClick={(e) => {
                                const r = e.currentTarget.getBoundingClientRect();
                                list.close(false);
                                setRowMenu({
                                  id: t.id,
                                  title: talkTitle(t),
                                  ...menuPoint(r.left, r.bottom + 2),
                                });
                              }}
                            >
                              <MoreIcon />
                            </button>
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </div>
              <hr />
              <button
                type="button"
                role="menuitem"
                class="danger"
                onClick={() => {
                  list.close(false);
                  setConfirming({ kind: "all", count: talk.talks().length });
                }}
              >
                Delete all talks…
              </button>
            </Show>
          </PopMenu>
        )}
      </Show>
      <Show when={rowMenu()}>
        {(m) => (
          <PopMenu
            label={`Talk ${m().title}`}
            x={m().x}
            y={m().y}
            onClose={(restore) => {
              setRowMenu(null);
              if (restore) queueMicrotask(() => titleButton?.focus());
            }}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                const id = m().id;
                setRowMenu(null);
                if (talk.openTalkId() !== id) talk.openFromList(id);
                startRename();
              }}
            >
              Rename…
            </button>
            <button
              type="button"
              role="menuitem"
              class="danger"
              onClick={() => {
                const { id, title } = m();
                setRowMenu(null);
                setConfirming({ kind: "one", id, title });
              }}
            >
              Delete talk…
            </button>
          </PopMenu>
        )}
      </Show>
    </div>
  );
}

/**
 * Asks once before talks are deleted (ADR 0086, rules 10 and 11). The focus starts on Cancel, so a
 * stray Return keeps them; Escape cancels too.
 */
function ConfirmDelete(props: { what: Confirming; onCancel: () => void; onConfirm: () => void }) {
  let cancel!: HTMLButtonElement;
  let confirm!: HTMLButtonElement;
  const text = () =>
    props.what.kind === "one"
      ? `Delete “${props.what.title}”? Its questions and answers are removed from this Mac and cannot be brought back.`
      : props.what.count === 1
        ? "Delete the 1 talk across all mail? It is removed from this Mac and cannot be brought back. Talks about a thread stay."
        : `Delete all ${props.what.count} talks across all mail? They are removed from this Mac and cannot be brought back. Talks about a thread stay.`;
  return (
    <div
      role="alertdialog"
      aria-label={props.what.kind === "one" ? "Delete talk" : "Delete all talks"}
      aria-describedby="talk-delete-text"
      class="mx-2.5 mb-2 flex flex-col gap-2.5 rounded-[9px] bg-fill p-3"
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          props.onCancel();
        } else if (e.key === "Tab") {
          e.preventDefault();
          (document.activeElement === cancel ? confirm : cancel).focus();
        }
      }}
    >
      <p id="talk-delete-text" class="text-[12.5px] leading-[1.45] [overflow-wrap:anywhere]">
        {text()}
      </p>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          ref={(el) => {
            cancel = el;
            queueMicrotask(() => el.focus());
          }}
          class="h-[24px] cursor-default rounded-[8px] bg-ink px-3 text-[12px] font-semibold text-bg"
          onClick={() => props.onCancel()}
        >
          Cancel
        </button>
        <button
          type="button"
          ref={(el) => (confirm = el)}
          class="h-[24px] cursor-default rounded-[8px] bg-button px-3 text-[12px] text-late"
          onClick={() => props.onConfirm()}
        >
          {props.what.kind === "one" ? "Delete talk" : "Delete all"}
        </button>
      </div>
    </div>
  );
}

/** An answer of the agent has a dashed left edge and no box: dashed and agent colour mean it made this. */
const answerEdge = "border-l-[1.5px] border-dashed border-agent-edge pl-3";

/** What the app did before the model read anything: the search, with its query as text. */
function SearchedLine(props: { query: string }) {
  return (
    <span class="min-w-0 truncate">
      Searched this Mac
      <Show when={props.query !== ""}>
        {": "}
        <span class="font-mono">{props.query}</span>
      </Show>
    </span>
  );
}

function YouBubble(props: { text: string }) {
  return (
    <div class="flex justify-end">
      <p class="selectable max-w-[85%] rounded-[12px_12px_4px_12px] bg-button px-[11px] py-[7px] text-[13px] whitespace-pre-wrap [overflow-wrap:anywhere]">
        {props.text}
      </p>
    </div>
  );
}

/** An answer across all mail: the search, the line, the threads it names, and what left. */
function FoundEntry(props: {
  entry: TalkAgentEntry;
  onOpenHit: (hit: TalkHit) => void;
  onShowSearch: (query: string) => void;
  offers: OfferActions;
}) {
  const e = () => props.entry;
  const query = () => e().query ?? "";
  const hits = () => e().hits ?? [];
  const offers = () => e().offers ?? [];
  const facts = () => e().facts ?? [];
  const nothing = () => e().threads === 0 && offers().length === 0 && facts().length === 0;
  return (
    <>
      <p class="flex items-center gap-1.5 text-[11.5px] text-secondary">
        <CheckIcon />
        <SearchedLine query={query()} />
      </p>
      <section aria-label="An answer from the agent" class={answerEdge}>
        <div class="flex items-center gap-2 pb-1.5 text-[12px] text-agent">
          <AgentRing />
          <span class="min-w-0 truncate">
            {e().runtimeName}, {modelName(e().model)}, your plan
          </span>
        </div>
        <div class="selectable flex flex-col gap-2 text-[13px] leading-[1.5] [overflow-wrap:anywhere]">
          <p class="whitespace-pre-wrap">{e().text}</p>
          <Show when={nothing() && query() !== ""}>
            <div>
              <button type="button" class={mini} onClick={() => props.onShowSearch(query())}>
                Show this search in the list
              </button>
            </div>
          </Show>
          <Show when={facts().length > 0}>
            <FactRows facts={facts()} />
          </Show>
          <Show when={offers().length > 0}>
            <OfferRows offers={offers()} actions={props.offers} />
          </Show>
          <Show when={hits().length > 0}>
            <div>
              <For each={hits()}>
                {(hit) => (
                  <button
                    type="button"
                    class="grid min-h-[34px] w-full cursor-default grid-cols-[11px_minmax(0,1fr)_auto_auto] items-center gap-x-2 gap-y-0.5 border-t border-hairline px-0.5 py-1.5 text-left first:border-t-0 hover:bg-fill"
                    onClick={() => props.onOpenHit(hit)}
                  >
                    <Ring size={11} color="var(--secondary)" />
                    <span class="truncate font-semibold">
                      {hit.who !== "" ? hit.who : hit.subject}
                    </span>
                    <span class="text-[12px] text-secondary">{letterDate(hit.lastMessageMs)}</span>
                    <span class="text-secondary" aria-hidden="true">
                      ›
                    </span>
                    {/* The note is why this thread answers: it wraps, it is never cut. */}
                    <span class="col-start-2 col-end-5 text-[12.5px] leading-[1.4] text-mid [overflow-wrap:anywhere]">
                      {hit.note !== "" ? hit.note : hit.subject}
                    </span>
                  </button>
                )}
              </For>
            </div>
          </Show>
          <For each={e().quotes}>
            {(quote) => (
              <figure>
                <blockquote class="font-serif text-[14px] leading-[1.5]">
                  {"“"}
                  {quote.text}
                  {"”"}
                </blockquote>
                <figcaption class="text-[11.5px] text-secondary">
                  {quote.from}, {letterDate(quote.dateMs)}
                  <Show when={quote.unchecked === true}>
                    {" · read from the page by the agent, not checked"}
                  </Show>
                </figcaption>
              </figure>
            )}
          </For>
        </div>
        <p class="pt-1.5 text-[11.5px] text-agent">{foundFooter(e())}</p>
      </section>
    </>
  );
}

function AgentEntry(props: {
  entry: TalkAgentEntry;
  talk: AgentTalkStore;
  prepared: PreparedWork | null;
  /** The newest draft or question of the talk. */
  latestWork: boolean;
  onSeeWork: () => void;
}) {
  const e = () => props.entry;
  // Prepared work is the thread's one draft or question now; an older one in the talk is history.
  const current = () =>
    props.latestWork &&
    ((e().kind === "draft" && props.prepared?.kind === "draft") ||
      (e().kind === "question" && props.prepared?.kind === "needs"));
  return (
    <section aria-label="An answer from the agent" class={answerEdge}>
      <div class="flex items-center gap-2 pb-1.5 text-[12px] text-agent">
        <AgentRing />
        <span class="min-w-0 truncate">
          {e().runtimeName}, {modelName(e().model)}, your plan
        </span>
      </div>
      <div class="selectable text-[13px] leading-[1.5] [overflow-wrap:anywhere]">
        <Show when={e().kind === "answer"}>
          <p class="whitespace-pre-wrap">{e().text}</p>
          <For each={e().quotes}>
            {(quote) => (
              <figure class="mt-2.5">
                <blockquote class="font-serif text-[14px] leading-[1.5]">
                  {"“"}
                  {quote.text}
                  {"”"}
                </blockquote>
                <figcaption class="text-[11.5px] text-secondary">
                  {quote.from}, {letterDate(quote.dateMs)}
                  <Show when={quote.unchecked === true}>
                    {" · read from the page by the agent, not checked"}
                  </Show>
                </figcaption>
              </figure>
            )}
          </For>
        </Show>
        <Show when={e().kind === "draft" || e().kind === "question"}>
          <div class="flex items-center gap-2">
            <p class="min-w-0 flex-1">
              {current()
                ? e().kind === "draft"
                  ? "Reply is ready under the letters."
                  : "The agent has a question under the letters."
                : e().kind === "draft"
                  ? "A draft from earlier."
                  : "A question from earlier."}
            </p>
            <Show when={current()}>
              <button type="button" class={mini} onClick={() => props.onSeeWork()}>
                {e().kind === "draft" ? "See draft" : "See question"}
              </button>
            </Show>
          </div>
        </Show>
        <Show when={e().kind === "closed"}>
          <div class="flex items-center gap-2">
            <p class="min-w-0 flex-1">Closed: {e().text}</p>
            <Show when={props.talk.canUndo(e())}>
              <button type="button" class={mini} onClick={() => void props.talk.undoClosed()}>
                Undo
              </button>
            </Show>
          </div>
        </Show>
      </div>
      <Show when={e().kind === "answer"}>
        <p class="pt-1.5 text-[11.5px] text-agent">
          Sent this thread to {e().runtimeName}. Nothing else left this Mac.
        </p>
      </Show>
    </section>
  );
}
