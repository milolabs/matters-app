import type { ThreadMessage } from "@matters/contracts";
import type { PreparedWork, Thing } from "@matters/core";
import { createVirtualizer } from "@tanstack/solid-virtual";
import { createEffect, createMemo, createSignal, For, Index, type JSX, on, Show } from "solid-js";
import type { AccountMark } from "./accountMarks.ts";
import type { AgentStore, ClosingOutcome } from "./agent.ts";
import { CopyCommand } from "./agentConnect.tsx";
import { AgentRing, DraftFrame, QuestionFrame } from "./agentLayer.tsx";
import { askTheAgent } from "./agentTalk.tsx";
import { displayName, isReallyOwn, letterDate, senderName } from "./format.ts";
import { ForwardIcon, ReplyAllIcon, ReplyIcon } from "./icons.tsx";
import { initials } from "./initials.ts";
import type { WriteKey } from "./keys.ts";
import { Avatar } from "./letterRow.tsx";
import type { Marks } from "./listMarks.ts";
import { railAt } from "./matterMap.ts";
import { MatterMap } from "./matterMap.tsx";
import {
  type ActionSpec,
  ASK_FOR_DETAILS,
  dateOrLateness,
  defaultHint,
  HEADING_HEIGHT,
  hasIntentBar,
  keptScroll,
  listNote,
  MORE_COMING,
  NOT_LIKE_THIS_LATER,
  notLikeThisChoices,
  notPreparedLine,
  PAUSED_LINE,
  type ReadingAction,
  type ReadingScreen,
  readerActions,
  readerEyebrow,
  readerFacts,
  readingScreen,
  rowLine,
  rowMark,
  seriesLine,
  seriesMap,
  splitYours,
  THING_ROW_HEIGHT,
  writtenByLine,
} from "./mattersView.ts";
import { personTint } from "./personMark.ts";
import { createMenuAnchor, PopMenu } from "./popMenu.tsx";
import { replyPromptName } from "./replyPrompt.ts";
import { field, pill, pillPrimary, pillQuiet, toolButton } from "./ui.ts";

// --- The list column ---

/** Rows from the end of what is loaded at which the next page is asked for. */
const LOAD_MORE_WITHIN = 20;

/**
 * The things that matter, in the real list's rows (68 px, a 34 px heading): all of them, best first,
 * paged in as the list nears its end (ADR 0055). A thing still being read says so. Model text is
 * shown as text only.
 */
export function MattersList(props: {
  agent: AgentStore;
  marks: Marks<string>;
  /** The thing the row menu is open on. */
  targeted: (threadId: string) => boolean;
  onPress: (thing: Thing, e: MouseEvent) => void;
  onMenu: (e: MouseEvent, thing: Thing) => void;
  ref: (el: HTMLDivElement) => void;
}) {
  const { agent, marks } = props;
  let scroller!: HTMLDivElement;
  const boundary = () => (agent.sections() ? agent.nowRows() : -1);
  const virtualizer = createVirtualizer({
    get count() {
      return agent.things().length;
    },
    getScrollElement: () => scroller,
    // The last row for now carries the room of the heading of the rest, so the rows below it keep
    // whole-row arithmetic. A new function per boundary: the virtualizer drops its cached sizes.
    get estimateSize() {
      const at = boundary();
      return (i: number) => (i === at - 1 ? THING_ROW_HEIGHT + HEADING_HEIGHT : THING_ROW_HEIGHT);
    },
    paddingStart: HEADING_HEIGHT,
    overscan: 8,
  });

  // The row the person opened stays in view, and the first one shows the heading too. A selection
  // that moved by itself, because its row left, is no reason to move the list. A memo, because `on`
  // runs on every change of what it reads: without one, each new list scrolled back to the open row.
  const openThread = createMemo(() => agent.selected()?.threadId);
  createEffect(
    on(openThread, () => {
      if (!agent.chose()) return;
      const at = agent.selectedIndex();
      if (at === 0) virtualizer.scrollToOffset(0);
      else if (at > 0) virtualizer.scrollToIndex(at);
    }),
  );

  // Rows arrive ranked, so one may land above the viewport: what the person is looking at stays.
  let drawnBoundary = -1;
  createEffect(
    on(agent.things, (list, before) => {
      const wasBoundary = drawnBoundary;
      drawnBoundary = boundary();
      if (before === undefined || scroller.scrollTop <= 0) return;
      const kept = keptScroll(
        { things: before, boundary: wasBoundary },
        { things: list, boundary: drawnBoundary },
        scroller.scrollTop,
      );
      if (kept !== scroller.scrollTop) scroller.scrollTop = kept;
    }),
  );

  createEffect(() => {
    const last = virtualizer.getVirtualItems().at(-1);
    if (last && last.index >= agent.things().length - LOAD_MORE_WITHIN) void agent.loadMore();
  });

  // Which matter each row belongs to, for the rail that holds a bundle together. Worked out per list.
  const bundleIds = createMemo(() => agent.things().map((t) => t.bundle?.id));

  // ⇧ with an arrow walks past the end of the view.
  createEffect(
    on(marks.head, (head) => {
      const at = head === null ? -1 : agent.things().findIndex((t) => t.threadId === head);
      if (at >= 0) virtualizer.scrollToIndex(at);
    }),
  );

  // One short line under the rows while reading. With no rows the reader explains, and the list
  // says nothing: "Nothing here." is never said in Matters (ADR 0053, rule 4). A search is the one
  // exception: there an empty list is an answer to what was asked (ADR 0056, rule 1).
  const note = () =>
    agent.loaded() && !agent.filtered()
      ? listNote(agent.things().length, agent.status()?.progress)
      : null;
  return (
    <div
      ref={(el) => {
        scroller = el;
        props.ref(el);
      }}
      tabIndex={-1}
      role="listbox"
      aria-label="Things that matter"
      aria-multiselectable="true"
      class="relative h-full overflow-y-auto outline-none focus-visible:outline-none"
    >
      <Show
        when={
          agent.filtered() && agent.loaded() && !agent.searching() && agent.things().length === 0
        }
      >
        <p class="px-6 pt-16 text-center text-[13px] text-secondary">Nothing found.</p>
      </Show>
      <div
        class="relative w-full"
        classList={{ "list-waiting": agent.searching() }}
        style={{ height: `${virtualizer.getTotalSize()}px` }}
      >
        <Show when={agent.things().length > 0 || !agent.filtered()}>
          <div
            role="presentation"
            class="absolute inset-x-0 top-0 flex h-[34px] items-end px-5 pb-1.5 text-[11.5px] font-semibold text-secondary"
          >
            {agent.filtered() ? "Results" : agent.sections() ? "Now" : "Things that matter"}
          </div>
        </Show>
        <Show when={agent.sections() && agent.nowRows() > 0 && agent.restCount() > 0}>
          <button
            type="button"
            data-rest-toggle
            aria-expanded={agent.restOpen()}
            class="absolute inset-x-0 flex h-[34px] cursor-default items-end gap-1.5 px-5 pb-1.5 text-left text-[11.5px] font-semibold text-secondary hover:text-ink"
            style={{ top: `${HEADING_HEIGHT + agent.nowRows() * THING_ROW_HEIGHT}px` }}
            onClick={() => agent.setRestOpen(!agent.restOpen())}
          >
            <span>{agent.restOpen() ? "▾" : "▸"}</span>
            <span>The rest</span>
            <span class="font-normal tabular-nums">{agent.restCount()}</span>
          </button>
        </Show>
        {/* By position: a new list holds new objects for the same rows, and they are not remade. */}
        <Index each={virtualizer.getVirtualItems()}>
          {(v) => (
            <Show when={agent.things()[v().index]}>
              {(thing) => (
                <ThingRow
                  thing={thing()}
                  prepared={agent.preparedOf(thing())}
                  selected={
                    marks.active()
                      ? marks.has(thing().threadId)
                      : agent.selected()?.threadId === thing().threadId
                  }
                  targeted={props.targeted(thing().threadId)}
                  rail={railAt(bundleIds(), v().index)}
                  top={v().start}
                  position={v().index + 1}
                  count={agent.count()}
                  onPress={(e) => props.onPress(thing(), e)}
                  onMenu={(e) => props.onMenu(e, thing())}
                />
              )}
            </Show>
          )}
        </Index>
      </div>
      <Show when={note()}>
        {(n) => (
          <p role="status" class="px-5 pt-3 text-[12px] text-secondary">
            {n() === "more" ? MORE_COMING : PAUSED_LINE}{" "}
            {/* With a thing open the reading screen is not shown, so the one control of the
                reading sits here, in the same line, quiet. */}
            <button
              type="button"
              data-reading-action={n() === "more" ? "pause" : "resume"}
              class="cursor-default text-mid underline-offset-2 hover:underline"
              onClick={() => void (n() === "more" ? agent.pauseReading() : agent.resumeReading())}
            >
              {n() === "more" ? "Pause" : "Continue"}
            </button>
          </p>
        )}
      </Show>
    </div>
  );
}

function ThingRow(props: {
  thing: Thing;
  prepared: PreparedWork | undefined;
  selected: boolean;
  targeted: boolean;
  rail: "first" | "middle" | "last" | undefined;
  top: number;
  position: number;
  count: number;
  onPress: (e: MouseEvent) => void;
  onMenu: (e: MouseEvent) => void;
}) {
  const line = () => rowLine(props.thing, props.prepared);
  const when = () => dateOrLateness(props.thing);
  return (
    <div
      data-row
      data-thing={props.thing.threadId}
      tabIndex={-1}
      role="option"
      aria-selected={props.selected}
      aria-posinset={props.position}
      aria-setsize={props.count}
      class="absolute inset-x-0 h-[68px] px-1.5 py-px"
      style={{ transform: `translateY(${props.top}px)` }}
      onMouseDown={props.onPress}
      onContextMenu={props.onMenu}
    >
      <Show when={props.rail}>
        {(at) => <span aria-hidden="true" class="matter-rail" data-at={at()} />}
      </Show>
      <div
        class="grid h-full cursor-default grid-cols-[32px_minmax(0,1fr)_auto] content-center gap-x-2.5 gap-y-px rounded-[8px] pr-3.5 pl-2 [--row-bg:var(--bg)]"
        classList={{
          "bg-selected [--row-bg:var(--selected)]": props.selected,
          "ring-1 ring-inset ring-edge": props.targeted,
        }}
      >
        {/* The other person, as in the mail list (ADR 0078). A thing knows them by name only, so
            their hue comes from the name. The late dot or the agent's ring sits on the corner. */}
        <span class="relative col-start-1 row-span-3 row-start-1 self-center" data-row-avatar>
          <Avatar
            size={32}
            initials={initials(props.thing.who)}
            tint={personTint(props.thing.who)}
          />
          <Show
            when={line().agent}
            fallback={
              <span
                aria-hidden="true"
                class="absolute -top-[3px] -left-[3px] rounded-full bg-(--row-bg) p-[2px]"
              >
                <span class="block size-[8px] rounded-full bg-late" />
              </span>
            }
          >
            <span
              aria-hidden="true"
              class="absolute -top-[5px] -left-[5px] rounded-full bg-(--row-bg) p-[1px]"
            >
              <AgentRing />
            </span>
          </Show>
        </span>
        <span class="col-start-2 truncate font-semibold">{props.thing.who}</span>
        <span
          class="text-[12px] tabular-nums"
          classList={{ "text-late": when().late, "text-secondary": !when().late }}
        >
          {when().text}
        </span>
        <span class="col-start-2 col-end-4 truncate font-medium">{props.thing.headline}</span>
        <span class="col-start-2 col-end-4 truncate text-[12px]">
          <span classList={{ "text-agent": line().agent, "text-late": !line().agent }}>
            {line().label}
          </span>
          <Show when={rowMark(props.thing) !== ""}>
            <span data-row-mark class="text-late">
              {" "}
              · {rowMark(props.thing)}
            </span>
          </Show>
          <Show when={props.rail === "first"}>
            <span class="text-secondary">
              {" · "}
              {props.thing.bundle?.name} · {props.thing.bundle?.members.length} threads
            </span>
          </Show>
          <Show when={seriesLine(props.thing) !== ""}>
            <span class="text-secondary"> · {seriesLine(props.thing)}</span>
          </Show>
          <Show when={line().note !== ""}>
            <span class="text-secondary"> · {line().note}</span>
          </Show>
        </span>
      </div>
    </div>
  );
}

// --- The reading column ---

/** What the reader shows for the selected thing, or what the reading is doing. */
export function MattersReader(props: {
  agent: AgentStore;
  own: ReadonlySet<string>;
  onWrite: (mode: WriteKey) => void;
  /** The letters of the thread, drawn as the thread view draws them (ADR 0060). */
  letters: (messages: () => readonly ThreadMessage[]) => JSX.Element;
  /** The sender header of the thread view (ADR 0078), with this reader's actions beside it. */
  senderHead: (
    threadId: string,
    messages: () => readonly ThreadMessage[],
    actions: JSX.Element,
  ) => JSX.Element;
  /** The colour of an account: the avatar of the person's own messages wears it. */
  accountMark: (accountId: string) => AccountMark | undefined;
  /** `Open All mail`. */
  onOpenAllMail: () => void;
  /** `Open Settings`, at Agents. */
  onOpenSettings: () => void;
}) {
  const { agent } = props;
  return (
    <Show
      when={agent.selected()?.threadId}
      keyed
      fallback={
        // A search that found nothing says so in the list: the state of the reading is not the answer.
        <Show when={!agent.filtered()}>
          <ReadingScreenView
            agent={agent}
            onOpenAllMail={props.onOpenAllMail}
            onOpenSettings={props.onOpenSettings}
          />
        </Show>
      }
    >
      {(id) => (
        <ThingReader
          id={id}
          initial={agent.selected() as Thing}
          agent={agent}
          own={props.own}
          accountMark={props.accountMark}
          onWrite={props.onWrite}
          letters={props.letters}
          senderHead={props.senderHead}
        />
      )}
    </Show>
  );
}

/**
 * The ring of the app: how far the reading is, in the agent's colour. It is drawn the way the
 * large ring of first run is (the arc moves with a transition, and rests for those who asked for
 * less motion). Without a measure it only breathes.
 */
function ProgressRing(props: { fraction: number | null }) {
  const R = 22;
  const circumference = 2 * Math.PI * R;
  const shown = () => props.fraction ?? 0.28;
  return (
    <svg
      aria-hidden="true"
      width="56"
      height="56"
      viewBox="0 0 56 56"
      classList={{ "ring-busy": props.fraction === null }}
    >
      <circle cx="28" cy="28" r={R} fill="none" stroke="var(--hairline)" stroke-width="3.5" />
      <circle
        class="ring-arc"
        cx="28"
        cy="28"
        r={R}
        fill="none"
        stroke="var(--agent)"
        stroke-width="3.5"
        stroke-linecap="round"
        stroke-dasharray={String(circumference)}
        stroke-dashoffset={String(circumference * (1 - shown()))}
        transform="rotate(-90 28 28)"
      />
    </svg>
  );
}

const ACTION_LABELS: Record<ReadingAction, string> = {
  pause: "Pause",
  resume: "Continue",
  openAllMail: "Open All mail",
  openSettings: "Open Settings",
  copy: "Copy",
  lookAgain: "Look again",
  tryAgain: "Try again",
  readFurtherBack: "Read further back",
};

/**
 * The reader while no thing is open. It is the app speaking, so the words are in plain ink; only
 * the ring is the agent's. Every word comes from `readingScreen`, which is tested without a page,
 * and is drawn as text.
 */
function ReadingScreenView(props: {
  agent: AgentStore;
  onOpenAllMail: () => void;
  onOpenSettings: () => void;
}) {
  const { agent } = props;
  // `Date.now()` is read when the status changes, which is when the words can change.
  const screen = (): ReadingScreen | null =>
    agent.loaded() ? readingScreen(agent.status(), Date.now()) : null;
  const run = (action: ReadingAction): (() => void) | undefined => {
    switch (action) {
      case "pause":
        return () => void agent.pauseReading();
      case "resume":
        return () => void agent.resumeReading();
      case "openAllMail":
        return props.onOpenAllMail;
      case "openSettings":
        return props.onOpenSettings;
      case "lookAgain":
        return () => void agent.lookAgain();
      case "tryAgain":
        return () => void agent.tryAgain();
      case "readFurtherBack":
        return () => void agent.readFurtherBack();
      case "copy":
        return undefined; // the command's own button
    }
  };
  return (
    <Show when={screen()}>
      {(s) => (
        <div
          data-reading={s().kind}
          class="flex h-full flex-col items-center justify-center gap-3 px-10 text-center"
        >
          <Show when={s().ring !== undefined}>
            <ProgressRing fraction={s().ring} />
          </Show>
          <h2
            role="status"
            class="font-serif text-[22px] leading-[1.25] font-semibold tracking-[-0.01em] text-balance text-ink"
          >
            {s().title}
          </h2>
          <div class="flex max-w-[460px] flex-col gap-1 text-[13px] leading-[1.5] text-secondary">
            <For each={s().lines}>{(line) => <p>{line}</p>}</For>
          </div>
          <Show when={s().actions.length > 0 || s().command !== undefined}>
            <div class="mt-1 flex flex-wrap items-center justify-center gap-2">
              <For each={s().actions}>
                {(action) => (
                  <Show
                    when={action === "copy" && s().command !== undefined}
                    fallback={
                      <button
                        type="button"
                        class={action === "readFurtherBack" ? pillPrimary : pill}
                        data-reading-action={action}
                        onClick={() => run(action)?.()}
                      >
                        {ACTION_LABELS[action]}
                      </button>
                    }
                  >
                    <CopyCommand command={s().command as string} />
                  </Show>
                )}
              </For>
            </div>
          </Show>
        </div>
      )}
    </Show>
  );
}

function ThingReader(props: {
  id: string;
  initial: Thing;
  agent: AgentStore;
  own: ReadonlySet<string>;
  accountMark: (accountId: string) => AccountMark | undefined;
  onWrite: (mode: WriteKey) => void;
  letters: (messages: () => readonly ThreadMessage[]) => JSX.Element;
  senderHead: (
    threadId: string,
    messages: () => readonly ThreadMessage[],
    actions: JSX.Element,
  ) => JSX.Element;
}) {
  const { agent } = props;
  // The thing as the last list has it. A new list brings new objects for the same thread; the
  // reader keeps its place (and what was typed) and only the text under it moves.
  const current = createMemo<Thing>((prev) => {
    const s = agent.selected();
    return s !== undefined && s.threadId === props.id ? s : prev;
  }, props.initial);
  const thing = () => current();
  const messages = () => {
    const d = agent.detail();
    return d?.threadId === thing().threadId ? d.messages : [];
  };
  const source = () => messages().find((m) => m.key === thing().quote.messageKey);
  const isOwn = (m: ThreadMessage) => props.own.has(m.from.address.toLowerCase()) && isReallyOwn(m);
  const people = createMemo(() => {
    const seen = new Map<string, string>();
    for (const m of messages()) {
      const key = m.from.address.toLowerCase();
      if (!seen.has(key)) seen.set(key, isOwn(m) ? "you" : displayName(m.from));
    }
    const names = [...seen.values()];
    const others = names.filter((n) => n !== "you");
    return names.length > others.length ? [...others, "you"] : others;
  });
  const prepared = () => agent.preparedOf(thing());
  // An older mail of a series, shown in place of the newest under `The whole thread` (ADR 0061).
  // Replying and closing stay with the newest, which is what the thing is.
  const [older, setOlder] = createSignal<{
    readonly threadId: string;
    readonly messages: readonly ThreadMessage[];
  } | null>(null);
  const letters = () => older()?.messages ?? messages();
  const map = createMemo(() => seriesMap(thing()));
  let openSeq = 0;
  async function openMail(threadId: string) {
    const seq = ++openSeq;
    if (threadId === thing().threadId) {
      setOlder(null);
      return;
    }
    const opened = await agent.threadMessages(threadId);
    if (seq === openSeq && opened !== null) setOlder({ threadId, messages: opened });
  }

  return (
    <article data-thing-reader={thing().threadId} class="settle px-8 pt-6 pb-8">
      <header class="mb-4">
        {/* Who wrote leads, as in the thread view (ADR 0078): a thing is only as good as its
            sender, and a name and a logo can be copied while the address and its verdict cannot.
            Reply, reply all and forward act on this thread through the composer; archive, delete
            and the rest act on the list's selected row, which is not this thing, so they are left
            to the thread view. */}
        {props.senderHead(
          thing().threadId,
          messages,
          <>
            <button
              type="button"
              aria-label="Reply"
              title="Reply  r"
              class={toolButton}
              onClick={() => props.onWrite("reply")}
            >
              <ReplyIcon />
            </button>
            <button
              type="button"
              aria-label="Reply all"
              title="Reply all  a"
              class={toolButton}
              onClick={() => props.onWrite("replyAll")}
            >
              <ReplyAllIcon />
            </button>
            <button
              type="button"
              aria-label="Forward"
              title="Forward  f"
              class={toolButton}
              onClick={() => props.onWrite("forward")}
            >
              <ForwardIcon />
            </button>
          </>,
        )}
        <h2 class="mt-4 font-serif text-[22px] leading-[1.25] font-semibold tracking-[-0.01em] text-balance">
          {thing().headline}
        </h2>
        <p class="mt-1 text-[12px] text-secondary">
          {(people().length > 0 ? people() : [thing().who]).slice(0, 4).join(", ")}
          <Show when={messages().length > 0}>
            {" · "}
            {messages().length === 1 ? "1 message" : `${messages().length} messages`}
          </Show>
        </p>
      </header>

      <Show when={thing().bundle}>
        {(bundle) => (
          <MatterMap
            bundle={bundle()}
            current={thing().threadId}
            onOpen={(id) => agent.select(id)}
          />
        )}
      </Show>

      <Show when={map()}>
        {(series) => (
          <MatterMap
            bundle={series().bundle}
            current={older()?.threadId ?? thing().threadId}
            summary={series().summary}
            onOpen={(id) => void openMail(id)}
          />
        )}
      </Show>

      <ThingCard
        thing={thing()}
        sender={source() ? senderName(source() as ThreadMessage, props.own) : thing().who}
        dateMs={source()?.dateMs}
      >
        {/* A thing to decide, do or know answers here, in the card (ADR 0095). */}
        <Show
          when={
            thing().updating !== true &&
            !agent.tookOver(thing().threadId) &&
            !prepared() &&
            hasIntentBar(thing())
          }
        >
          <ActionRow thing={thing()} agent={agent} />
        </Show>
      </ThingCard>

      <div class="mt-3">
        <Show
          when={thing().updating !== true}
          fallback={
            <p role="status" class="flex items-center gap-2 text-[13px] text-agent">
              <AgentRing />
              The agent is reading the latest message.
            </p>
          }
        >
          <Show
            when={agent.tookOver(thing().threadId)}
            fallback={
              <Show
                when={prepared()}
                fallback={
                  <Show when={!hasIntentBar(thing())}>
                    <NotPrepared thing={thing()} agent={agent} />
                  </Show>
                }
              >
                {(work) => (
                  <Show
                    when={work().kind === "draft"}
                    fallback={
                      <Question
                        thing={thing()}
                        agent={agent}
                        work={work() as Extract<PreparedWork, { kind: "needs" }>}
                      />
                    }
                  >
                    <Draft
                      thing={thing()}
                      agent={agent}
                      own={props.own}
                      messages={messages()}
                      body={(work() as Extract<PreparedWork, { kind: "draft" }>).body}
                    />
                  </Show>
                )}
              </Show>
            }
          >
            {(text) => <TookOver thing={thing()} agent={agent} text={text()} />}
          </Show>
        </Show>
        <Show when={thing().suspect === true}>
          <p role="alert" data-suspect class="mt-3 text-[13px] text-late">
            <span class="font-semibold">Check the sender.</span> {SUSPECT_LINE}
          </p>
        </Show>
        <Show when={thing().unverified === true}>
          <p role="alert" data-unverified class="mt-3 text-[13px] text-late">
            <span class="font-semibold">Check the sender.</span> {UNVERIFIED_LINE}
          </p>
        </Show>
        <Show when={agent.problem(thing().threadId) !== ""}>
          <p role="alert" class="mt-3 text-[13px] text-late">
            {agent.problem(thing().threadId)}
          </p>
        </Show>
      </div>

      {/* The mail itself, always: what the agent made of it never stands in for it (ADR 0060). */}
      <Show when={letters().length > 0}>
        <section aria-label="The whole thread" data-whole-thread class="mt-6">
          <h3 class="m-0 mb-2 text-[11px] font-semibold text-secondary">
            The whole thread ·{" "}
            {letters().length === 1 ? "1 message" : `${letters().length} messages`}
          </h3>
          {props.letters(letters)}
        </section>
      </Show>
    </article>
  );
}

/**
 * What the agent made of the thing, set apart from the mail under it (ADR 0095): what it asks of
 * the person, why, its facts, the passage it was read from and, for a thing to decide, to do or to
 * know, the answers.
 */
function ThingCard(props: {
  thing: Thing;
  sender: string;
  dateMs: number | undefined;
  children?: JSX.Element;
}) {
  const facts = () => readerFacts(props.thing);
  return (
    <section
      aria-label="What this asks of you"
      data-thing-card
      class="overflow-hidden rounded-[12px] border border-agent-line bg-agent-wash"
    >
      <div class="flex flex-col gap-2 px-4 pt-3 pb-4">
        <p class="m-0 flex items-center gap-2 text-[11px] font-semibold tracking-[0.04em] text-agent uppercase">
          <AgentRing />
          {readerEyebrow(props.thing)}
        </p>
        <p class="selectable m-0 text-[13px] leading-[18px] [overflow-wrap:anywhere]">
          {props.thing.why}
        </p>
        <Show when={facts().length > 0}>
          <div class="flex flex-wrap gap-1.5">
            <For each={facts()}>
              {(fact) => (
                <span
                  data-fact={fact.late ? "late" : "plain"}
                  class={`inline-flex h-[22px] items-center rounded-[6px] px-2 text-[12px] tabular-nums ${
                    fact.late ? "bg-late/15 font-semibold text-late" : "bg-fill text-mid"
                  }`}
                >
                  {fact.text}
                </span>
              )}
            </For>
          </div>
        </Show>
        {/* The passage it was read from, so the reading can be checked against the mail (ADR 0060). */}
        <figure class="m-0 mt-1">
          <blockquote
            class="selectable m-0 line-clamp-3 border-l-2 border-agent-edge pl-3 font-serif text-[15px] leading-[1.5] break-words text-mid"
            title={props.thing.quote.quote}
          >
            {props.thing.quote.quote}
          </blockquote>
          <figcaption class="mt-1 pl-3.5 text-[12px] text-secondary tabular-nums">
            {props.sender}
            <Show when={props.dateMs !== undefined}> · {letterDate(props.dateMs as number)}</Show>
          </figcaption>
        </figure>
      </div>
      {props.children}
    </section>
  );
}

/** The sentence for a thing from a sender nobody can vouch for: from code, as in the thing's why. */
/** A failed authentication, said once in the reader (ADR 0079). */
const UNVERIFIED_LINE =
  "The sender's domain did not confirm it sent this mail. Compare the address above with the one you know before you pay, sign in or reply.";

const SUSPECT_LINE =
  "It asks for money from an address you have never written to. It may not be genuine.";

/** Where each action goes. `details` is the one that asks for a draft; the rest close or set aside. */
function runAction(agent: AgentStore, thing: Thing, spec: ActionSpec): void {
  const close = (outcome: ClosingOutcome) => {
    void agent.feedback(thing, "closed", outcome);
  };
  switch (spec.id) {
    case "take":
      close("taken");
      break;
    case "decline":
      close("declined");
      break;
    case "done":
    case "gotIt":
    case "ignore":
      close("done");
      break;
    case "noReply":
      void agent.feedback(thing, "closed");
      break;
    case "later":
      void agent.feedback(thing, "later");
      break;
    case "notImportant":
      void agent.feedback(thing, "notImportant");
      break;
    case "details":
      void agent.prepare(thing.threadId, { direction: ASK_FOR_DETAILS });
      break;
  }
}

/**
 * The buttons for a thing (ADR 0095): the primary solid, the rest plain, and `Not for me…` last,
 * a menu with `Not important` and the ways to teach the agent. `onHint` hears what the pointed-at
 * button does; without it each button carries that as its tooltip.
 */
function ActionButtons(props: {
  thing: Thing;
  agent: AgentStore;
  /** Leave out the one that asks for a draft: it is already asked for, or is the frame's own. */
  except?: ActionSpec["id"];
  onHint?: (hint: string | null) => void;
}) {
  const busy = () => props.agent.busy(props.thing.threadId);
  const shown = () => readerActions(props.thing).filter((a) => a.id !== props.except);
  const say = (hint: string | null) => props.onHint?.(hint);
  return (
    <>
      <For each={shown().filter((a) => a.weight !== "menu")}>
        {(spec) => (
          <button
            type="button"
            class={spec.weight === "primary" ? pillPrimary : pill}
            data-action={spec.id}
            {...(props.onHint === undefined && spec.hint !== "" ? { title: spec.hint } : {})}
            disabled={spec.id === "details" && busy()}
            onMouseEnter={() => say(spec.hint)}
            onMouseLeave={() => say(null)}
            onFocus={() => say(spec.hint)}
            onBlur={() => say(null)}
            onClick={() => runAction(props.agent, props.thing, spec)}
          >
            {spec.id === "details" && busy() ? "Preparing…" : spec.label}
          </button>
        )}
      </For>
      <NotForMe
        thing={props.thing}
        agent={props.agent}
        items={shown().filter((a) => a.weight === "menu")}
      />
    </>
  );
}

/** The answers in the card, with the line that says what the pointed-at one does (ADR 0095). */
function ActionRow(props: { thing: Thing; agent: AgentStore }) {
  const [hint, setHint] = createSignal<string | null>(null);
  return (
    <div
      data-intent-bar={props.thing.intent}
      class="flex flex-col gap-2 border-t border-agent-line bg-bg px-4 py-3"
    >
      <div class="flex flex-wrap items-center gap-2">
        <ActionButtons thing={props.thing} agent={props.agent} onHint={setHint} />
      </div>
      <p data-action-hint class="m-0 min-h-4 text-[12px] text-secondary">
        {hint() ?? defaultHint(readerActions(props.thing))}
      </p>
    </div>
  );
}

/**
 * `Not for me…` (ADR 0095): `Not important`, then what was `Not like this…` (ADR 0068, rule 3): no
 * more of this kind of mail, no more from this sender, or a few words of the person's own for the
 * next readings. The rules take effect at once; the words apply to mail read from now on.
 */
function NotForMe(props: { thing: Thing; agent: AgentStore; items: readonly ActionSpec[] }) {
  const menu = createMenuAnchor();
  const [words, setWords] = createSignal("");
  const choices = () => notLikeThisChoices(props.thing);
  const pick = (run: () => void) => {
    menu.close(false);
    run();
  };
  async function save() {
    if (await props.agent.notLikeThisWords(props.thing, words())) {
      setWords("");
      menu.close(true);
    }
  }
  return (
    <>
      <button
        type="button"
        class={pillQuiet}
        data-not-for-me
        aria-haspopup="menu"
        aria-expanded={menu.at() !== null}
        onClick={(e) => menu.open(e.currentTarget)}
      >
        Not for me…
      </button>
      <Show when={menu.at()}>
        {(at) => (
          <PopMenu label="Not for me" x={at().x} y={at().y} onClose={menu.close}>
            <For each={props.items}>
              {(spec) => (
                <button
                  type="button"
                  role="menuitem"
                  class="whole"
                  data-action={spec.id}
                  onClick={() => pick(() => runAction(props.agent, props.thing, spec))}
                >
                  <span class="flex flex-col">
                    <span>{spec.label}</span>
                    <span class="text-[12px] text-secondary">{spec.hint}</span>
                  </span>
                </button>
              )}
            </For>
            <Show when={choices().length > 0}>
              <hr class="mx-2 my-1 border-0 border-t border-hairline" />
              <For each={choices()}>
                {(choice) => (
                  <button
                    type="button"
                    role="menuitem"
                    class="whole"
                    data-not-like-this-choice={choice.id}
                    onClick={() => pick(() => void props.agent.notLikeThis(props.thing, choice))}
                  >
                    {choice.label}
                  </button>
                )}
              </For>
            </Show>
            <hr class="mx-2 my-1 border-0 border-t border-hairline" />
            <div class="flex flex-col gap-1 p-1" data-not-like-this>
              <input
                type="text"
                class={field}
                aria-label="What you do not want, in your words"
                placeholder="Or say what you don't want"
                value={words()}
                maxLength={500}
                onInput={(e) => setWords(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && words().trim() !== "") void save();
                }}
              />
              <span class="px-1 text-[12px] text-secondary">
                Enter keeps it. {NOT_LIKE_THIS_LATER}
              </span>
            </div>
          </PopMenu>
        )}
      </Show>
    </>
  );
}

/** Nothing prepared yet: a quiet line, the way to ask now, and `Not for me…`. */
function NotPrepared(props: { thing: Thing; agent: AgentStore }) {
  const busy = () => props.agent.busy(props.thing.threadId);
  return (
    <div class="flex flex-wrap items-center gap-3">
      <p role="status" class="flex min-w-0 flex-1 items-center gap-2 text-[13px] text-agent">
        <AgentRing />
        {notPreparedLine(busy(), props.agent.selectedIndex(), props.agent.status())}
      </p>
      <button
        type="button"
        class={pill}
        disabled={busy()}
        onClick={() => void props.agent.prepare(props.thing.threadId)}
      >
        {busy() ? "Preparing…" : "Prepare now"}
      </button>
      <NotForMe
        thing={props.thing}
        agent={props.agent}
        items={readerActions(props.thing).filter((a) => a.weight === "menu")}
      />
    </div>
  );
}

/**
 * The ways to set a thing aside, which every prepared frame carries: for a reply `No reply needed`,
 * `Remind me tomorrow` and `Not for me…`; for the rest what fits what the thing is (ADR 0066, rule 8).
 */
function SetAside(props: { thing: Thing; agent: AgentStore }) {
  return <ActionButtons thing={props.thing} agent={props.agent} except="details" />;
}

/** A draft the agent wrote: the shared frame, with `Not important`, `Later` and `No reply needed`. */
function Draft(props: {
  thing: Thing;
  agent: AgentStore;
  own: ReadonlySet<string>;
  messages: readonly ThreadMessage[];
  body: string;
}) {
  const { agent } = props;
  const pieces = createMemo(() => splitYours(props.body, agent.givenFor(props.thing.threadId)));
  const by = () =>
    writtenByLine(
      agent.status()?.runtime ?? null,
      agent.status()?.settings.models ?? {
        understand: "",
        draftAhead: "",
        write: "",
        answer: "",
        titles: "",
      },
      agent.askedFor(props.thing.threadId),
    );
  return (
    <DraftFrame
      to={props.messages.length > 0 ? replyPromptName(props.messages, props.own) : props.thing.who}
      pieces={pieces()}
      read={
        props.messages.length > 0
          ? `Read the ${props.messages.length === 1 ? "1 message" : `${props.messages.length} messages`} in this thread. Nothing else.`
          : "Read this thread. Nothing else."
      }
      by={by()}
      busy={agent.busy(props.thing.threadId)}
      editKey="e"
      aside={<SetAside thing={props.thing} agent={agent} />}
      onEdit={() => void agent.editMyself(props.thing, props.body)}
      onSend={() => void agent.send(props.thing, props.body)}
    />
  );
}

/** After `Edit myself`: the plain solid letter. It is the person's now. */
function TookOver(props: { thing: Thing; agent: AgentStore; text: string }) {
  return (
    <section
      aria-label="Your draft"
      data-took-over
      class="overflow-hidden rounded-[12px] border border-hairline"
    >
      <p class="px-4 pt-3 pb-2 text-[12px] text-secondary">
        <span class="font-semibold text-ink">Your draft</span> · you took over from the agent
      </p>
      <div class="selectable px-4 pb-4 font-serif text-[15px] leading-[1.6] whitespace-pre-line">
        {props.text}
      </div>
      <div class="flex items-center gap-2 border-t border-hairline px-4 py-3">
        <span class="flex-1" />
        <button
          type="button"
          class={pill}
          onClick={() => void props.agent.editMyself(props.thing, props.text)}
        >
          Open draft
        </button>
      </div>
    </section>
  );
}

/** The agent stopped instead of guessing: the shared frame, with the ways to set the thing aside. */
function Question(props: {
  thing: Thing;
  agent: AgentStore;
  work: Extract<PreparedWork, { kind: "needs" }>;
}) {
  const { agent } = props;
  const direction = () => agent.directionOf(props.thing.threadId);
  const by = () =>
    writtenByLine(
      agent.status()?.runtime ?? null,
      agent.status()?.settings.models ?? {
        understand: "",
        draftAhead: "",
        write: "",
        answer: "",
        titles: "",
      },
      false,
    );
  return (
    <QuestionFrame
      work={props.work}
      direction={direction()}
      by={by()}
      busy={agent.busy(props.thing.threadId)}
      aside={<SetAside thing={props.thing} agent={agent} />}
      onChoose={(text) => agent.chooseDirection(props.thing.threadId, text)}
      onWrite={() =>
        agent.prepare(props.thing.threadId, {
          ...(direction() === undefined ? {} : { direction: direction() as string }),
        })
      }
      onAnswer={askTheAgent}
    />
  );
}
