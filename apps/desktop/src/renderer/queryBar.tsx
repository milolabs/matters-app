import {
  type ParsedQuery,
  type PersonSuggestion,
  parseQuery,
  QUERY_FIELDS,
  type QueryFieldName,
} from "@matters/core";
import {
  batch,
  createEffect,
  createMemo,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { AccountsStore } from "./accounts.ts";
import type { Backend } from "./client.ts";
import { displayName, fileSize, listDate, senderName } from "./format.ts";
import { type HitSegment, highlight } from "./hits.ts";
import { FileIcon, PaperclipIcon, SearchIcon } from "./icons.tsx";
import { initials } from "./initials.ts";
import {
  liveCount,
  noThreadMatches,
  type PanelItem,
  type PillId,
  panelGroups,
  pills,
  togglePill,
} from "./livePanel.ts";
import {
  askLive,
  createCoalescer,
  freeWords,
  type LiveAnswer,
  type PersonRow,
  type ThreadRow,
  wantsLive,
} from "./liveSearch.ts";
import { createPeopleFeed } from "./peopleFeed.ts";
import { personTint } from "./personMark.ts";
import { type PromptOff, withPromptOffText } from "./promptView.ts";
import { addField, addFilter } from "./queryEdits.ts";
import { type QuerySegment, querySegments } from "./querySegments.ts";
import { type Edit, peoplePrefix, querySuggestions, type Suggestion } from "./querySuggestions.ts";
import type { MailStore } from "./store.ts";

/**
 * ADR 0026. The query text lives in the store and nowhere else. The renderer parses it here, on
 * the keystroke, with the loaded accounts so that `account:` diagnostics are right. `promptOff`
 * is why a prompt does nothing now (ADR 0116, rule 11): the parser reports it and drops it.
 */
export function createQueryModel(
  store: MailStore,
  accounts: AccountsStore,
  promptOff: () => PromptOff | null = () => null,
) {
  const parsed = createMemo<ParsedQuery>(() => {
    const off = promptOff();
    const parsed = parseQuery(store.query(), {
      ...(accounts.loaded() ? { accounts: accounts.accounts() } : {}),
      ...(off === null ? {} : { promptOff: true }),
    });
    return withPromptOffText(parsed, off);
  });
  return { parsed };
}
export type QueryModel = ReturnType<typeof createQueryModel>;

export interface QueryBarHandle {
  readonly input: HTMLTextAreaElement;
  /** The window's keydown calls this first; true when the bar used the key. */
  onKeyDown(e: KeyboardEvent): boolean;
  /** Down leaves the bar only from its last line: above that it moves the caret. */
  atLastLine(): boolean;
  /** Replaces the whole query: input, mirror and store, the caret after the last character. */
  setText(text: string): void;
  /** Puts the cursor in the bar and opens its panel (⌘K and `/`). */
  open(): void;
  /** ⌘↵ in the bar: asks the agent what is typed. True when the key was used. */
  askAgent(): boolean;
}

/** ⌘K on macOS, Ctrl K elsewhere (ADR 0076). */
export const OPEN_KEY_LABEL = navigator.userAgent.includes("Macintosh") ? "⌘K" : "Ctrl K";

const LIST_ID = "query-suggestions";
/** What the strip holds besides the text and the handlers: icon, key, gaps, padding. */
const STRIP_CHROME_PX = 104;
const textWidth = (() => {
  // Must match `.qtext`. Measured on the keystroke: reads no layout, and takes microseconds.
  const ctx = document.createElement("canvas").getContext("2d");
  if (ctx) ctx.font = '13px -apple-system, "SF Pro Text", system-ui, "Segoe UI", sans-serif';
  return (text: string) => ctx?.measureText(text).width ?? 0;
})();

interface PillNode {
  readonly pill: number | undefined;
  readonly segs: QuerySegment[];
}

/** Segments of one `field:value` become one pill. */
function nodesOf(segments: readonly QuerySegment[]): PillNode[] {
  const out: PillNode[] = [];
  for (const s of segments) {
    const last = out[out.length - 1];
    if (s.pill !== undefined && last?.pill === s.pill) last.segs.push(s);
    else out.push({ pill: s.pill, segs: [s] });
  }
  return out;
}

function Piece(props: { seg: QuerySegment }) {
  const s = props.seg;
  if (s.kind === "op") return <span class="qop qkw">{s.text}</span>;
  if (s.kind === "phrase") return <span class="qph">{s.text}</span>;
  if (s.kind === "bracket") {
    return s.state === "invalid" ? (
      <span class="qp qbad">
        <span class="qv">{s.text}</span>
      </span>
    ) : (
      <span class="qop">{s.text}</span>
    );
  }
  return <>{s.text}</>;
}

/** Text with the matched words marked (ADR 0076). */
function Marked(props: { text: string; words: readonly string[]; anywhere?: boolean }) {
  const segments = createMemo<HitSegment[]>(() =>
    highlight(props.text, props.words, { anywhere: props.anywhere }),
  );
  return (
    <For each={segments()}>
      {(seg) => (seg.hit ? <mark class="hit">{seg.text}</mark> : seg.text)}
    </For>
  );
}

function ThreadBody(props: {
  row: ThreadRow;
  words: readonly string[];
  own: ReadonlySet<string>;
  dot: (accountId: string) => string | undefined;
}) {
  const m = () => props.row.message;
  return (
    <>
      <div class="qrow1">
        <span class="qwho">{senderName(m(), props.own)}</span>
        <span class="qsubj">
          <Marked text={m().subject.trim() || "(no subject)"} words={props.words} />
        </span>
      </div>
      <div class="qside">
        <Show when={props.dot(m().accountId)}>
          {(color) => <i class="qdot" style={{ background: color() }} />}
        </Show>
        <Show when={m().hasAttachments}>
          <span class="qclip" role="img" aria-label="Has an attachment">
            <PaperclipIcon />
          </span>
        </Show>
        <time class="qwhen">{listDate(m().dateMs)}</time>
      </div>
      <Show when={m().snippet.trim() !== ""}>
        <div class="qsnip">
          <Marked text={m().snippet.trim()} words={props.words} />
        </div>
      </Show>
    </>
  );
}

function PersonBody(props: { row: PersonRow }) {
  const name = () => (props.row.name?.trim() ? (props.row.name as string) : props.row.address);
  const note = () => {
    const bits: string[] = [];
    if (name() !== props.row.address) bits.push(props.row.address);
    const n = props.row.threads;
    if (n !== undefined) bits.push(`${n} ${n === 1 ? "thread" : "threads"} here`);
    else if (props.row.messages !== undefined) bits.push(`${props.row.messages} messages`);
    return bits.join(" · ");
  };
  return (
    <>
      <span
        class="avatar qav"
        aria-hidden="true"
        data-initials={initials(name())}
        data-tint={personTint(props.row.address)}
      />
      <div class="qwho">{name()}</div>
      <div class="qsnip qnote">{note()}</div>
    </>
  );
}

function FileBody(props: { item: Extract<PanelItem, { kind: "file" }>; words: readonly string[] }) {
  const hit = () => props.item.hit;
  return (
    <>
      <span class="qficon" aria-hidden="true">
        <FileIcon />
      </span>
      <div class="qwho qfname">
        <Marked text={hit().fileName} words={props.words} anywhere />
      </div>
      <div class="qside">
        <time class="qwhen">{listDate(hit().dateMs)}</time>
      </div>
      <div class="qsnip qnote">
        {displayName(hit().sender)} · {fileSize(hit().sizeBytes)}
      </div>
    </>
  );
}

function OptionBody(props: {
  item: PanelItem;
  words: readonly string[];
  sure: boolean;
  own: ReadonlySet<string>;
  dot: (accountId: string) => string | undefined;
}) {
  const item = () => props.item;
  return (
    <>
      <Show when={item().kind === "suggestion"}>
        {(() => {
          const s = () => (item() as Extract<PanelItem, { kind: "suggestion" }>).suggestion;
          return (
            <>
              <b classList={{ qclear: s().clearsRecent === true }}>
                {s().clearsRecent && props.sure ? "Clear all recent searches?" : s().label}
              </b>
              <span>{s().hint}</span>
              <Show when={s().count !== undefined}>
                <em>{s().count}</em>
              </Show>
              <Show when={s().recent}>
                {(query) => (
                  <i class="qforget" data-forget={query()} title="Remove from recent  ⌦">
                    ×
                  </i>
                )}
              </Show>
            </>
          );
        })()}
      </Show>
      <Show when={item().kind === "thread"}>
        <div class="qgrid qthread">
          <ThreadBody
            row={(item() as Extract<PanelItem, { kind: "thread" }>).row}
            words={props.words}
            own={props.own}
            dot={props.dot}
          />
        </div>
      </Show>
      <Show when={item().kind === "person"}>
        <div class="qgrid qperson">
          <PersonBody row={(item() as Extract<PanelItem, { kind: "person" }>).row} />
        </div>
      </Show>
      <Show when={item().kind === "file"}>
        <div class="qgrid qfile">
          <FileBody item={item() as Extract<PanelItem, { kind: "file" }>} words={props.words} />
        </div>
      </Show>
      <Show when={item().kind === "ask"}>
        <div class="qask">
          <span class="qasktext">
            Ask the agent: „{(item() as Extract<PanelItem, { kind: "ask" }>).text}”
          </span>
          <kbd class="qkbd">⌘↵</kbd>
        </div>
      </Show>
    </>
  );
}

export function QueryBar(props: {
  store: MailStore;
  accounts: AccountsStore;
  backend: Backend;
  model: QueryModel;
  /** The active view: searches are remembered per view (ADR 0030). */
  viewId: () => string;
  /** The text the active view stands for. */
  baseline: () => string;
  /** What the bar asked is not answered yet, in the list it is over. */
  searching: () => boolean;
  /** The agent can be asked (AI is on); the ask row and ⌘↵ exist only then (ADR 0076). */
  canAsk: () => boolean;
  /** A prompt would do nothing (ADR 0116, rule 11): `prompt:` is not offered. */
  promptOff: () => boolean;
  /** Sends the words to the agent across all mail. */
  onAsk: (text: string) => void;
  /** Shows a thread found by the panel. */
  onOpenThread: (threadId: string) => void;
  ref: (handle: QueryBarHandle) => void;
}) {
  const { store, model } = props;
  let input!: HTMLTextAreaElement;
  let strip!: HTMLDivElement;
  let handlers!: HTMLDivElement;
  const [caret, setCaret] = createSignal(0);
  const [focused, setFocused] = createSignal(false);
  const [open, setOpen] = createSignal(false);
  const [labels, setLabels] = createSignal<readonly string[]>([]);
  const [chosen, setChosen] = createSignal(-1);
  const [recent, setRecent] = createSignal<readonly string[]>([]);
  // Clearing cannot be taken back, so the row asks once, in place.
  const [sure, setSure] = createSignal(false);
  const [stripPx, setStripPx] = createSignal(Number.POSITIVE_INFINITY);
  const [handlersPx, setHandlersPx] = createSignal(0);
  // The latest answer for people; the panel narrows it to what is typed (ADR 0028).
  const [people, setPeople] = createSignal<readonly PersonSuggestion[]>([]);
  const feed = createPeopleFeed(props.backend, setPeople);
  onCleanup(() => feed.stop());
  // Labels are fetched when the panel first opens per focus, never per keystroke.
  let fetched = false;

  // `account:` says nothing while there is only one account to name, `prompt:` while AI is off.
  const fields = createMemo(() =>
    (Object.keys(QUERY_FIELDS) as QueryFieldName[]).filter(
      (f) =>
        (f !== "account" || props.accounts.accounts().length > 1) &&
        (f !== "prompt" || !props.promptOff()),
    ),
  );
  const inUse = createMemo(() => {
    const out = new Set<string | undefined>();
    for (const t of model.parsed().tokens) if (t.state === "ok") out.add(t.field);
    return out;
  });

  // The text comes first: once it no longer fits beside the handlers, they give up the line.
  // Neither width depends on this answer, so it cannot flip back and forth.
  const long = createMemo(
    () => textWidth(store.query()) > stripPx() - handlersPx() - STRIP_CHROME_PX,
  );
  function measure() {
    setStripPx(strip.clientWidth);
    // The buttons themselves: the row's own width is the whole strip while it has a line to
    // itself. Hidden, they measure nothing, and the last real width still holds.
    const first = handlers.firstElementChild as HTMLElement | null;
    const last = handlers.lastElementChild as HTMLElement | null;
    const width = first && last ? last.offsetLeft + last.offsetWidth - first.offsetLeft : 0;
    if (width > 0) setHandlersPx(width);
  }
  onMount(() => {
    const seen = new ResizeObserver(measure);
    seen.observe(strip);
    onCleanup(() => seen.disconnect());
  });
  createEffect(on(fields, measure, { defer: true }));

  const nodes = createMemo(() => nodesOf(querySegments(store.query(), model.parsed())));

  // ADR 0076. The free words of the query decide whether live results are asked for.
  const words = createMemo(() => {
    const all = freeWords(store.query(), model.parsed());
    return wantsLive(all) ? all : [];
  });
  const [live, setLive] = createSignal<LiveAnswer | null>(null);
  const coalescer = createCoalescer(
    (text) => askLive(props.backend, text, freeWords(text, parseQuery(text))),
    (_text, answer) => setLive(answer),
  );
  onCleanup(() => coalescer.stop());
  // Asked only while the panel is open and there is something to find; one request at a time.
  createEffect(() => {
    if (open() && words().length > 0) coalescer.ask(store.query());
    else {
      coalescer.stop();
      setLive(null);
    }
  });
  const own = createMemo(
    () => new Set(props.accounts.accounts().map((a) => a.address.toLowerCase())),
  );

  const suggested = createMemo(() =>
    open()
      ? querySuggestions(store.query(), caret(), model.parsed(), {
          labels: labels(),
          accounts: props.accounts.accounts(),
          people: people(),
          recent: recent(),
          baseline: props.baseline(),
          noPrompt: props.promptOff(),
        })
      : [],
  );
  // People are asked for only while the panel is open in a context that wants them, and only
  // when the prefix changes. The request is separate from the query: it never waits for search.
  const wanted = createMemo(() =>
    open() ? peoplePrefix(store.query(), caret(), model.parsed()) : null,
  );
  createEffect(() => {
    const prefix = wanted();
    if (prefix === null) {
      feed.stop();
      if (!open()) setPeople([]);
    } else feed.ask(prefix);
  });
  const panelInput = () => ({
    text: store.query(),
    parsed: model.parsed(),
    groups: suggested(),
    live: live(),
    words: words(),
    own: own(),
    canAsk: props.canAsk(),
  });
  const groups = createMemo(() => panelGroups(panelInput()));
  const quiet = createMemo(() => noThreadMatches(panelInput()));
  const indexed = createMemo(() => {
    let n = 0;
    return groups().map((g) => ({
      title: g.title,
      live: g.live,
      items: g.items.map((item) => ({ item, i: n++ })),
    }));
  });
  type IndexedGroup = ReturnType<typeof indexed>[number];
  const GroupView = (gp: { group: IndexedGroup }) => (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset does not belong in a listbox
    <div role="group" aria-label={gp.group.title === "Ask" ? "Agent" : gp.group.title}>
      <Show when={gp.group.title !== "Ask"}>
        <div class="qh" classList={{ qhl: gp.group.live }} aria-hidden="true">
          {gp.group.title}
        </div>
      </Show>
      <For each={gp.group.items}>
        {({ item, i }) => (
          <div
            id={`qs-${i}`}
            data-i={i}
            role="option"
            tabIndex={-1}
            aria-selected={active() === i}
            class="qopt"
            classList={{ qlive: item.kind !== "suggestion" }}
          >
            <OptionBody
              item={item}
              words={words()}
              sure={sure()}
              dot={(id) =>
                props.accounts.accounts().length > 1
                  ? props.accounts.marks().get(id)?.dot
                  : undefined
              }
              own={own()}
            />
          </div>
        )}
      </For>
    </div>
  );

  const flat = createMemo(() => groups().flatMap((g) => g.items));
  const pillRow = createMemo(() =>
    open() && words().length > 0 ? pills(store.query(), props.accounts.accounts().length) : [],
  );
  const shown = () => open() && (flat().length > 0 || pillRow().length > 0);
  const announced = () =>
    quiet() ? "No thread matches" : live() === null ? "" : `${liveCount(groups())} results`;
  const active = () => (chosen() < flat().length ? chosen() : -1);

  function ensureLabels() {
    if (fetched) return;
    fetched = true;
    props.backend
      .listLabels()
      .then((r) => setLabels(r.labels))
      .catch(() => {});
    props.backend
      .listSearches(props.viewId())
      .then(setRecent)
      .catch(() => {});
  }

  function reopen() {
    setOpen(true);
    ensureLabels();
  }

  let panelEl: HTMLDivElement | undefined;

  /** Focus left the bar and its panel: half-typed terms are not kept, the panel closes. */
  function leave() {
    remember();
    input.scrollTop = 0;
    fetched = false;
    batch(() => {
      setFocused(false);
      setSure(false);
      setOpen(false);
      setChosen(-1);
    });
  }

  function place() {
    setCaret(input.selectionStart ?? input.value.length);
  }

  /** Leaving the bar is what makes typed text a search; half-typed terms are not kept. */
  function remember() {
    const text = store.query().trim();
    if (text.length < 2 || text === props.baseline().trim()) return;
    if (model.parsed().tokens.some((t) => t.state !== "ok")) return;
    props.backend.noteSearch(props.viewId(), text).catch(() => {});
  }

  function forget(query: string) {
    setRecent((all) => all.filter((q) => q !== query));
    props.backend.forgetSearch(props.viewId(), query).catch(() => {});
  }

  function apply({ start, end, text, caret: next }: Edit) {
    input.focus();
    input.setSelectionRange(start, end);
    // Through the editing pipeline, so that undo keeps working; the input event does the rest.
    if (!document.execCommand("insertText", false, text)) {
      input.setRangeText(text, start, end, "end");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    }
    input.setSelectionRange(next, next);
    place();
  }

  function clearRecent() {
    batch(() => {
      setRecent([]);
      setSure(false);
      setChosen(-1);
    });
    props.backend.clearSearches(props.viewId()).catch(() => {});
  }

  function acceptSuggestion(item: Suggestion) {
    if (item.clearsRecent) {
      if (sure()) clearRecent();
      else setSure(true);
      return;
    }
    apply(item.edit);
    // A whole query taken back: there is nothing left to complete.
    if (item.recent !== undefined) setOpen(false);
  }

  /** ⌘↵ and the ask row: what is typed goes to the agent across all mail (ADR 0076). */
  function askAgent(): boolean {
    const text = store.query().trim();
    if (!props.canAsk() || text === "") return false;
    batch(() => {
      setOpen(false);
      setChosen(-1);
    });
    props.onAsk(text);
    return true;
  }

  function accept(item: PanelItem) {
    switch (item.kind) {
      case "suggestion":
        acceptSuggestion(item.suggestion);
        break;
      case "person":
        // The panel stays open: the person may go on narrowing the search.
        apply(item.edit);
        break;
      case "thread":
        batch(() => {
          setOpen(false);
          setChosen(-1);
        });
        props.onOpenThread(item.row.threadId);
        break;
      case "file":
        batch(() => {
          setOpen(false);
          setChosen(-1);
        });
        props.onOpenThread(item.hit.threadId);
        break;
      case "ask":
        askAgent();
        break;
    }
  }

  function clickPill(id: PillId, on: boolean) {
    const text = togglePill(store.query(), id, on);
    apply({ start: 0, end: store.query().length, text, caret: text.length });
  }

  /** Puts the cursor in the bar with the panel open. */
  function openBar() {
    store.setZone("search");
    input.focus();
    input.select();
    // A window that does not have the focus raises no focus event; the bar still has the cursor.
    setFocused(document.activeElement === input);
    place();
    reopen();
  }

  /** A field handler: the same edit as choosing the field in the panel, at the end of the text. */
  function writeField(field: QueryFieldName) {
    if (field === "prompt") {
      // ADR 0116: one prompt, a phrase; the caret waits inside its quotes.
      const text = addFilter(store.query(), 'prompt:""');
      apply({ start: 0, end: store.query().length, text, caret: text.length - 1 });
      return;
    }
    const text = addField(store.query(), field);
    apply({ start: 0, end: store.query().length, text, caret: text.length });
  }

  function setText(text: string) {
    input.value = text;
    batch(() => {
      store.setQuery(text);
      setOpen(false);
      setChosen(-1);
    });
    if (document.activeElement === input) input.setSelectionRange(text.length, text.length);
    place();
  }

  function onKeyDown(e: KeyboardEvent): boolean {
    if (e.isComposing || e.target !== input) return false;
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey) {
      if (!askAgent()) return false;
      e.preventDefault();
      return true;
    }
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
    const n = flat().length;
    const has = shown();
    switch (e.key) {
      case "Tab": {
        if (!has) return false;
        const chosenItem = flat()[active()];
        // Nothing chosen: the first suggestion of syntax, as it always was.
        const item =
          chosenItem ?? flat().find((i) => i.kind === "suggestion" || i.kind === "person");
        if (item && (item.kind === "suggestion" || item.kind === "person")) {
          e.preventDefault();
          accept(item);
          return true;
        }
        // Live rows are opened, not accepted: Tab goes on to the pills.
        const first = panelEl?.querySelector<HTMLElement>(".qpill");
        if (!first) return false;
        e.preventDefault();
        first.focus();
        return true;
      }
      case "ArrowDown":
        if (!has) return false;
        e.preventDefault();
        setChosen(active() + 1 >= n ? -1 : active() + 1);
        return true;
      case "ArrowUp":
        if (!has) return false;
        e.preventDefault();
        setChosen(active() <= -1 ? n - 1 : active() - 1);
        return true;
      case "Enter": {
        const item = flat()[active()];
        if (!has || !item) return false;
        e.preventDefault();
        accept(item);
        return true;
      }
      case "Delete": {
        const chosenItem = flat()[active()];
        const query = chosenItem?.kind === "suggestion" ? chosenItem.suggestion.recent : undefined;
        if (!has || query === undefined) return false;
        e.preventDefault();
        forget(query);
        return true;
      }
      case "Escape":
        if (!has) return false;
        e.preventDefault();
        batch(() => {
          setOpen(false);
          setChosen(-1);
        });
        return true;
      default:
        return false;
    }
  }

  props.ref({
    get input() {
      return input;
    },
    onKeyDown,
    atLastLine: () => !long() || input.selectionStart === input.value.length,
    setText,
    open: openBar,
    askAgent,
  });

  // The store can change the text (views, the reader's filters, clearing): the input follows.
  createEffect(() => {
    const q = store.query();
    if (input.value !== q) input.value = q;
  });

  createEffect(() => {
    const i = active();
    if (i >= 0) document.getElementById(`qs-${i}`)?.scrollIntoView({ block: "nearest" });
  });

  return (
    <div class="qslot">
      <div ref={strip} class="qstrip" classList={{ qlong: long() }}>
        <label class="qline">
          <SearchIcon />
          <span class="qfield">
            <span aria-hidden="true" class="qtext qmirror">
              <For each={nodes()}>
                {(node) =>
                  node.pill === undefined ? (
                    <Piece seg={node.segs[0] as QuerySegment} />
                  ) : (
                    <span
                      class="qp"
                      classList={{
                        qdraft: node.segs[0]?.state === "incomplete",
                        qbad: node.segs[0]?.state === "invalid",
                        qagent: node.segs[0]?.agent === true,
                      }}
                    >
                      {node.segs.map((s) => (
                        <span class={s.kind === "key" ? "qk" : "qv"}>{s.text}</span>
                      ))}
                    </span>
                  )
                }
              </For>
            </span>
            <textarea
              ref={input}
              rows={1}
              role="combobox"
              aria-label="Search mail"
              aria-autocomplete="list"
              aria-expanded={shown()}
              aria-controls={shown() ? LIST_ID : undefined}
              aria-activedescendant={active() >= 0 ? `qs-${active()}` : undefined}
              placeholder="Search mail"
              autocomplete="off"
              spellcheck={false}
              class="selectable qtext qinput"
              onInput={(e) => {
                // The query is one line of text, however it wraps: a pasted break is a space.
                if (/[\r\n]/.test(e.currentTarget.value)) {
                  const at = e.currentTarget.selectionStart;
                  e.currentTarget.value = e.currentTarget.value.replace(/\r\n?|\n/g, " ");
                  e.currentTarget.setSelectionRange(at, at);
                }
                const value = e.currentTarget.value;
                batch(() => {
                  store.setQuery(value);
                  setSure(false);
                  setCaret(e.currentTarget.selectionStart ?? value.length);
                  setChosen(-1);
                  // Typing is focused; a script that sets the value should not open the panel.
                  if (document.activeElement === input) reopen();
                });
              }}
              onKeyUp={(e) => {
                place();
                if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) reopen();
              }}
              onClick={() => {
                place();
                reopen();
              }}
              onSelect={place}
              onFocus={() => {
                store.setZone("search");
                setFocused(true);
                place();
                reopen();
              }}
              onBlur={(e) => {
                // Focus moving to a pill of the panel is still the bar.
                const to = e.relatedTarget;
                if (to instanceof Node && panelEl?.contains(to)) return;
                leave();
              }}
            />
          </span>
        </label>
        <Show when={props.searching()}>
          <span class="qsearching" role="status">
            Searching…
          </span>
        </Show>
        {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and its layout */}
        <div ref={handlers} class="qfields" role="group" aria-label="Add a filter">
          <For each={fields()}>
            {(field) => (
              <button
                type="button"
                class="qf"
                data-on={inUse().has(field) ? "" : undefined}
                data-agent={field === "prompt" ? "" : undefined}
                title={QUERY_FIELDS[field].hint}
                aria-label={`Add ${field}: ${QUERY_FIELDS[field].hint}`}
                // The input keeps or takes the focus when the field is written.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => writeField(field)}
              >
                {field}
                <i>:</i>
              </button>
            )}
          </For>
        </div>
        <kbd class="qkey">{focused() ? "esc" : OPEN_KEY_LABEL}</kbd>
        <Show when={shown()}>
          {/* A mouse down must not blur the input; the item is taken right away. */}
          {/* biome-ignore lint/a11y/noStaticElementInteractions: the options are the interactive part, the panel only keeps the focus in the input */}
          <div
            ref={panelEl}
            class="qsugg"
            onMouseDown={(e) => {
              e.preventDefault();
              const gone = (e.target as HTMLElement).closest<HTMLElement>("[data-forget]");
              if (gone?.dataset.forget !== undefined) {
                forget(gone.dataset.forget);
                return;
              }
              const el = (e.target as HTMLElement).closest<HTMLElement>("[data-i]");
              const item = el ? flat()[Number(el.dataset.i)] : undefined;
              if (item) accept(item);
            }}
            onFocusOut={(e) => {
              // Tabbing out of the pills ends the panel like leaving the bar does.
              const to = e.relatedTarget;
              if (to instanceof Node && (panelEl?.contains(to) || to === input)) return;
              if (document.activeElement === input) return;
              leave();
            }}
          >
            <Show when={pillRow().length > 0}>
              {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and its layout */}
              <div
                class="qpills"
                role="group"
                aria-label="Quick filters"
                onKeyDown={(e) => {
                  if (e.key === "Tab") return;
                  e.stopPropagation();
                  if (e.key === "Escape" || e.key === "ArrowDown" || e.key === "ArrowUp") {
                    e.preventDefault();
                    input.focus();
                  }
                }}
              >
                <For each={pillRow()}>
                  {(pill) => (
                    <button
                      type="button"
                      class="qpill"
                      aria-pressed={pill.on}
                      onClick={() => clickPill(pill.id, pill.on)}
                    >
                      {pill.label}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <div class="sr-only" role="status" aria-live="polite">
              {announced()}
            </div>
            <div id={LIST_ID} class="qlist" role="listbox" aria-label="Suggestions">
              {/* Groups scroll; the row that asks the agent stays under them (ADR 0076). */}
              <div class="qscroll">
                <For each={indexed().filter((g) => g.title !== "Ask")}>
                  {(group) => <GroupView group={group} />}
                </For>
                <Show when={quiet()}>
                  <div class="qnone" aria-hidden="true">
                    No thread matches
                  </div>
                </Show>
              </div>
              <For each={indexed().filter((g) => g.title === "Ask")}>
                {(group) => (
                  <div class="qpinned">
                    <GroupView group={group} />
                  </div>
                )}
              </For>
            </div>
            <div class="qfoot" aria-hidden="true">
              <Show
                when={words().length > 0}
                fallback={
                  <>
                    <span>Tab accept</span>
                    <span>↑↓ choose</span>
                    <span>
                      {model.parsed().prompt === undefined
                        ? "↵ go to results"
                        : "↵ read with the prompt"}
                    </span>
                  </>
                }
              >
                <span>↑↓ move</span>
                <span>↵ open</span>
                <Show when={props.canAsk()}>
                  <span>⌘↵ ask the agent</span>
                </Show>
                <span>esc close</span>
              </Show>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
}
