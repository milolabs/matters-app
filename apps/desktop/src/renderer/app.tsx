import type { ThreadMessage } from "@matters/contracts";
import type { ImageChoice, Message, Participant, StoppableSource, TalkHit } from "@matters/core";
import { accountsAgreedTo, parseQuery, replyPromptTarget } from "@matters/core";
import { createVirtualizer } from "@tanstack/solid-virtual";
import {
  createEffect,
  createMemo,
  createSignal,
  For,
  type JSX,
  lazy,
  on,
  onCleanup,
  onMount,
  Show,
  untrack,
} from "solid-js";
import { type AccountMark, showsAccountMarks } from "./accountMarks.ts";
import type { AccountsStore } from "./accounts.ts";
import type { AgentStore } from "./agent.ts";
import { requestSettingsSection } from "./agentPrefs.ts";
import { createAgentTalk, firstName, type TalkThreadRef } from "./agentTalk.ts";
import {
  AgentPane,
  AgentPaneButton,
  askTheAgent,
  openAgentPrompt,
  registerAgentOpener,
} from "./agentTalk.tsx";
import { talkRuntimeName } from "./agentText.ts";
import { appDark } from "./appTheme.ts";
import { DWELL_MS } from "./autoRead.ts";
import { linkify, SHORT_SIGNATURE_LINES, splitBody, splitSignature } from "./body.ts";
import { releaseBoot } from "./bootScreen.ts";
import type { Backend } from "./client.ts";
import type { ComposeStore } from "./compose.ts";
import { DropOverlay } from "./dropOverlay.tsx";
import { type DropTarget, installFileDrop } from "./fileDrop.ts";
import { onDropped } from "./files.ts";
import type { FoldersStore } from "./folders.ts";
import { displayName, fullDate, isReallyOwn, letterDate, listDate, senderName } from "./format.ts";
import { HitsContext, HitText, Segments } from "./hitText.tsx";
import {
  ArchiveIcon,
  ChevronDownIcon,
  ComposeIcon,
  FolderIcon,
  ForwardIcon,
  ImageIcon,
  ImageOffIcon,
  MoreIcon,
  PaperclipIcon,
  ReplyAllIcon,
  ReplyIcon,
  Ring,
  SettingsIcon,
  ShieldCheckIcon,
  SpamIcon,
  TrashIcon,
  WarnIcon,
} from "./icons.tsx";
import { allowingSource, barKind, imageCopy } from "./imageBar.ts";
import { moveKeyOf, plainKey, type WriteKey, writeKeyOf } from "./keys.ts";
import { Avatar, FoldRow, leadGrid, underRow } from "./letterRow.tsx";
import { isOpenable, misleadingHost, openExternally } from "./links.ts";
import { createListWidth, createPaneWidth, ListDivider } from "./listDivider.tsx";
import { HEAD_HEIGHT, itemAt, layoutList, ROW_HEIGHT } from "./listLayout.ts";
import { createMarks, type Marks } from "./listMarks.ts";
import { type MailAction, type Menu, mailMenu, threadsText } from "./listMenu.ts";
import { ListMenuView } from "./listMenuView.tsx";
import { queryHitWords } from "./liveSearch.ts";
import { MailFrame, type MailLink } from "./mailFrame.tsx";
import type { CleanMail } from "./mailHtml.ts";
import { mailView } from "./mailTheme.ts";
import { planReveal } from "./matchNav.ts";
import { createMatchNavigator, type MatchNavigator } from "./matchNavigator.ts";
import { MovePicker } from "./movePicker.tsx";
import type { MoveLine, MovesStore } from "./moves.ts";
import { movePlaces } from "./moveView.ts";
import { NoticeStack } from "./noticeStack.tsx";
import type { OutboxStore } from "./outbox.ts";
import { OVERLAY_BELOW } from "./paneWidth.ts";
import { personMark } from "./personMark.ts";
import { createMenuAnchor, menuPoint, PopMenu } from "./popMenu.tsx";
import { PromptLine } from "./promptLine.tsx";
import { createPromptRun } from "./promptRun.ts";
import { NOTHING_FITS, promptOff } from "./promptView.ts";
import { createQueryModel, QueryBar, type QueryBarHandle } from "./queryBar.tsx";
import { addFilter, labelToken, senderToken } from "./queryEdits.ts";
import { ReceivedStrip } from "./receivedStrip.tsx";
import type { ReplyAgent } from "./replyAgent.ts";
import { replyPromptName } from "./replyPrompt.ts";
import { createRowHits, type RowSegments } from "./rowHits.ts";
import {
  type Counterpart,
  counterpart,
  failedBadge,
  rowPerson,
  verifiedBadge,
} from "./senderHeader.ts";
import { SendTray } from "./sendTray.tsx";
import { SortLine } from "./sortLine.tsx";
import { createSortRun, rankedSortOf } from "./sortRun.ts";
import type { MailStore, MoveSubject } from "./store.ts";
import { resolveAct, saveViewOffer } from "./talkOffers.ts";
import type { OfferActions } from "./talkOffers.tsx";
import { createThreadAgent, type ThreadAgentStore } from "./threadAgent.ts";
import {
  AgentHeaderButton,
  AgentPanel,
  AgentStrip,
  agentSendInView,
  goToAgentPanel,
} from "./threadAgent.tsx";
import { foldRun, letterKeys, sameKeys, sameRun } from "./threadLetters.ts";
import { type StackItem, ThreadStack } from "./threadStack.tsx";
import { toolButton } from "./ui.ts";
import { ALL_MAIL_ID, holdsPrompt, type ViewsStore } from "./views.ts";
import { ViewStatus, ViewTabs } from "./viewTabs.tsx";
import { createWindowWidth } from "./windowWidth.ts";

const quietButton =
  "h-[24px] max-w-[260px] cursor-default truncate rounded-[8px] bg-button px-3 text-[12px] text-ink";

/** With a hidden title bar the traffic lights sit in the toolbar; elsewhere the frame has them. */
const mac = navigator.userAgent.includes("Macintosh");

export interface Stores {
  readonly store: MailStore;
  readonly accounts: AccountsStore;
  readonly backend: Backend;
  readonly outbox: OutboxStore;
  readonly moves: MovesStore;
  readonly folders: FoldersStore;
  readonly compose: ComposeStore;
  readonly views: ViewsStore;
  readonly agent: AgentStore;
}

// ADR 0046, rule 3: the editor (CodeMirror is half the bundle) and the first-run screen are not
// needed to show the list. They load on first use, and preload.ts fetches the editor and the
// mail sanitizer as soon as the list is on screen, so the first `r` finds them in memory.
const Composer = lazy(() => import("./composer.tsx").then((m) => ({ default: m.Composer })));
const ReplyEditor = lazy(() =>
  import("./replyEditor.tsx").then((m) => ({ default: m.ReplyEditor })),
);
const Setup = lazy(() => import("./setup.tsx").then((m) => ({ default: m.Setup })));

/**
 * Keys typed into a field are the field's, whatever the app binds. The editor lives in a shadow
 * root, which hides the field behind its host in `event.target`: ask for the real origin.
 */
function isTextTarget(event: Event): boolean {
  const target = event.composedPath()[0];
  if (!(target instanceof HTMLElement)) return false;
  return (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target.isContentEditable
  );
}

/** Asks main for the settings window, through the preload script (ADR 0036). */
function openSettings(section?: string): void {
  if (section !== undefined) requestSettingsSection(section);
  window.postMessage({ mattersOpenSettings: true }, "*");
}

export function App(props: Stores) {
  const loaded = () => props.accounts.loaded() && props.store.loaded();
  const noMail = () => props.accounts.accounts().length === 0 && props.store.mailboxEmpty();
  // Stays on after the account arrives: the first-run screen ends when the user leaves it.
  const [onboarding, setOnboarding] = createSignal(false);
  createEffect(() => {
    if (loaded() && noMail()) setOnboarding(true);
  });
  // The loading screen from index.html goes in the same frame as the first real screen arrives, or,
  // when it was seen, a moment later with a cross-fade (bootScreen.ts, ADR 0103).
  createEffect(() => {
    if (loaded()) releaseBoot("loaded");
  });
  return (
    <Show when={loaded()}>
      <Show
        when={!onboarding() && !noMail()}
        fallback={
          <Setup
            backend={props.backend}
            accounts={props.accounts}
            onAdded={() => void props.accounts.refresh()}
            onAgentStatus={(status) => props.agent.setStatus(status)}
            onFinished={() => {
              setOnboarding(false);
              void props.agent.refresh();
            }}
          />
        }
      >
        <Mail {...props} />
      </Show>
    </Show>
  );
}

function Mail(props: Stores) {
  const { store, accounts, outbox, moves, folders, compose, views, agent } = props;
  // A reply is written under its thread; everything else covers the reader (ADR 0100).
  // Only where the thread itself is shown: with another thread open, it covers the reader.
  const inlineReply = () => {
    const session = compose.session();
    return session !== null &&
      session.placement() === "inline" &&
      store.thread()?.thread.id === session.base.threadId
      ? session
      : null;
  };
  const fullComposer = () => {
    const session = compose.session();
    return session !== null && inlineReply() === null ? session : null;
  };
  // Leaving the thread keeps what was typed as a draft, as Close does: the reply stays with its thread.
  createEffect(
    on(
      () => store.thread()?.thread.id ?? null,
      (threadId) => {
        const session = untrack(inlineReply);
        // A thread that is reloading reads null for a moment; only another thread closes the reply.
        if (
          session &&
          threadId !== null &&
          session.base.threadId !== undefined &&
          session.base.threadId !== threadId
        ) {
          void session.close();
        }
      },
      { defer: true },
    ),
  );
  // The agent's help in the reply under the thread (ADR 0098); none while AI is off.
  const replyAgent = (): ReplyAgent | null => {
    // Any message that answers a thread, under it or in the full composer; a new message has none.
    const threadId = compose.session()?.base.threadId;
    if (threadId === undefined || !agent.enabled()) return null;
    const b = props.backend;
    return {
      rewrite: (how, text) => b.agentRewriteDraft(threadId, text, how),
      answer: (text, missing) => b.agentAnswerQuestions(threadId, text, missing),
      check: (text) => b.agentCheckReply(threadId, text),
      fill: (text) => b.agentFillGaps(threadId, text),
    };
  };
  const [showDetails, setShowDetails] = createSignal(false);
  // Files dragged over the window: how many, and which target of the overlay the pointer is on.
  const [dragCount, setDragCount] = createSignal(0);
  const [dropHover, setDropHover] = createSignal<DropTarget | null>(null);
  let bar!: QueryBarHandle;
  // ADR 0116, rule 11: a prompt does nothing while the agent could not read for it.
  const offWhy = createMemo(() => promptOff(agent.enabled(), agent.status()));
  const model = createQueryModel(store, accounts, offWhy, () => {
    const s = agent.status();
    const id = s?.settings.kindRuntime.understand;
    return s?.runtimes.find((r) => r.id === id)?.name;
  });
  const showMarks = createMemo(() =>
    showsAccountMarks(accounts.accounts().length, model.parsed().root),
  );
  // Selecting a view sets the text the way typing would: through the bar.
  views.bindText((text) => bar.setText(text));
  // With AI on, the app opens on the starter view `Needs you` while the person has neither chosen
  // a tab nor typed (ADR 0117, rule 2). With AI off the window is what it always was.
  createEffect(
    on([agent.enabled, views.views], ([on]) => {
      if (on) untrack(() => views.openStarter());
    }),
  );
  // A prompt is a filter (ADR 0116). The bar's text says whether there is one; nothing is asked
  // of the backend on the keystroke, and the list stays the mail filters' until a run or kept
  // verdicts give it rows (rules 2 and 7).
  const prompt = createPromptRun(props.backend);
  onCleanup(() => prompt.dispose());
  createEffect(() => {
    const text = store.query();
    const has = model.parsed().prompt !== undefined;
    untrack(() => prompt.setQuery(text, has));
  });
  // A ranked order without a prompt (rule 4b): computed after `↵`, the dated list until then.
  const sorted = createSortRun(props.backend);
  onCleanup(() => sorted.dispose());
  createEffect(() => {
    const text = store.query();
    const mine = rankedSortOf(model.parsed());
    untrack(() => sorted.setQuery(text, mine));
  });
  // The text holds a prompt that cannot work: AI is off, or no account is shared with the runtime
  // that reads for it (ADR 0116, rule 11). The list is then empty and the line above says why:
  // the mail filters' result is not what was asked for, and showing it would pass for an answer.
  const promptIdle = createMemo(() => offWhy() !== null && holdsPrompt(store.query()));
  createEffect(() => {
    const rows = prompt.rows();
    const ranked = sorted.rows();
    const idle = promptIdle();
    untrack(() => {
      if (idle) store.showOrdered(store.query(), []);
      else if (rows !== null) {
        // Under `sort:newest` or `sort:oldest` what fits is by date, with day headings (rule 4b).
        const by = parseQuery(prompt.text()).sort?.value;
        const dated = by === "newest" || by === "oldest";
        store.showOrdered(
          prompt.text(),
          rows.map((r) => r.message),
          dated,
        );
      } else if (ranked !== null) store.showOrdered(sorted.text(), ranked);
      else store.showOrdered(store.query(), null);
    });
  });
  // Opening a saved view whose text holds a prompt shows what is kept and reads the rest (rule 3);
  // one with a ranked order is sorted, as `↵` would.
  onCleanup(
    views.onOpened(() => {
      // A view opened from inside an effect (the starter view at launch) gets here before the
      // effects above have seen its text. Without this the prompt would not be known yet, the
      // view would not be opened as one, and the mail filters' result would show under its name.
      const text = store.query();
      prompt.setQuery(text, model.parsed().prompt !== undefined);
      sorted.setQuery(text, rankedSortOf(model.parsed()));
      if (prompt.has()) void prompt.open();
      else if (sorted.has()) void sorted.run();
    }),
  );
  /** The model's sentence per thread, shown on the row in the agent's colour (rule 6). */
  const whys = createMemo(
    () => new Map((prompt.rows() ?? []).map((r) => [r.threadId, r.why] as const)),
  );
  // What the agent already has for the open ordinary thread, and the person's way to ask for more
  // (ADR 0063). Nothing here spends a turn unless the person asks.
  const threadAgent = createThreadAgent({
    backend: props.backend,
    agent,
    open: () => {
      const open = store.thread()?.thread;
      return open === undefined
        ? null
        : { id: open.id, lastMessageKey: open.lastMessageKey, subject: open.subject };
    },
  });
  createEffect(() => threadAgent.sync());
  onCleanup(() => threadAgent.dispose());
  // Several rows chosen at once (ADR 0056, rule 3), by message key.
  const rowOrder = createMemo(() => store.messages().map((m) => m.key));
  const marks = createMarks<number>(rowOrder, () => store.messages()[store.selected()]?.key);
  const markedRows = createMemo(() =>
    marks.active() ? store.messages().filter((m) => marks.has(m.key)) : [],
  );
  // What is chosen belongs to the list it was chosen in.
  createEffect(on([() => views.active().id, store.query], () => marks.clear()));
  // Nobody is reading the open thread while the stack is in its place (ADR 0039).
  createEffect(
    on(
      marks.active,
      (active, was) => {
        if (active) store.pauseReading(true);
        else if (was) store.pauseReading(false);
      },
      { defer: true },
    ),
  );
  let reader!: HTMLElement;
  let listEl!: HTMLDivElement;
  const own = createMemo(() => new Set(accounts.accounts().map((a) => a.address.toLowerCase())));
  // ADR 0077. The words the open search asks for; the list and the reader mark them. Nothing is
  // computed for a query without free words, and the memo keeps its array while the words stay.
  const hitWords = createMemo<readonly string[]>(
    () => (store.filtered() ? queryHitWords(store.query()) : []),
    [],
    { equals: (a, b) => a.length === b.length && a.every((w, i) => w === b[i]) },
  );
  const matches = createMatchNavigator(
    () => store.thread()?.messages,
    hitWords,
    () => store.thread()?.thread.id,
  );
  // The thread the agent looks at now: the open thread. While several rows are marked, the reader
  // shows the stack and there is none.
  const talkThread = createMemo((): TalkThreadRef | null => {
    const open = marks.active() ? null : store.thread();
    if (!open) return null;
    const other = replyPromptTarget(open.messages, [...own()]);
    const last = open.messages.at(-1);
    return {
      id: open.thread.id,
      name: !other || own().has(other.address.toLowerCase()) ? "" : firstName(displayName(other)),
      subject: open.thread.subject,
      ...(last === undefined ? {} : { lastMessageMs: last.dateMs }),
      accountId: open.thread.accountId,
    };
  });
  // One window width, read before the first paint, for the list, the agent's column and the store.
  const windowWidth = createWindowWidth();
  const talk = createAgentTalk({
    backend: props.backend,
    windowWidth,
    thread: talkThread,
    threadAgent,
    onMade: (threadId, made, words, subject) =>
      agent.talkMade(threadId, made.kind, made.text, words, subject),
  });
  createEffect(() => talk.sync());
  // Back in a window wide enough for the column beside the mail, it follows the kept choice again.
  const narrow = createMemo(() => windowWidth() < OVERLAY_BELOW);
  createEffect(
    on(
      narrow,
      (now) => {
        if (!now) talk.forgetAsk();
      },
      { defer: true },
    ),
  );
  onCleanup(() => talk.dispose());
  // Every way to the prompt first shows the column, if it is hidden (ADR 0069, rule 5).
  onCleanup(registerAgentOpener(() => openAgentPrompt(talk)));
  /** The work the agent has prepared for the open thread. */
  const talkPrepared = () => threadAgent.prepared();
  /** The account was not shared: known once the answer for the thread is read. */
  const talkShared = () => !threadAgent.known() || threadAgent.available();
  /**
   * The accounts All mail searches: the ones the person agreed to for the runtime the talk runs
   * on, its own choice or the one for questions (ADR 0121, rules 4 and 8).
   */
  const talkAddresses = () => {
    const status = agent.status();
    const runtimeId = talk.choice()?.runtimeId ?? status?.settings.kindRuntime.answer;
    const agreed = accountsAgreedTo(status?.consents ?? [], runtimeId);
    return accounts
      .accounts()
      .filter((a) => agreed.has(a.id))
      .map((a) => a.address);
  };
  // A thread an answer across all mail named, still to be found when the list it needs has loaded.
  let wantThread: { readonly id: string; readonly query: string } | null = null;
  onCleanup(
    store.onSettled((query) => {
      if (wantThread === null || query !== wantThread.query) return;
      const id = wantThread.id;
      wantThread = null;
      const at = store.messages().findIndex((m) => m.threadId === id);
      if (at >= 0) store.select(at);
    }),
  );

  /**
   * A row of an answer across all mail (ADR 0064, rule 2): the thread opens in the reader and the
   * pane moves to its own talk. In the list it is in, it is selected there. Otherwise the app goes
   * to All mail, narrowed to the thread's subject, and selects it when that list arrives.
   */
  function openHit(hit: TalkHit) {
    // The thread opens in the reader, so the widened agent goes back to its side to show it.
    paneWidth.setWide(false);
    const id = hit.threadId;
    if (talkThread()?.id === id) {
      talk.setScope("thread");
      return;
    }
    const at = store.messages().findIndex((m) => m.threadId === id);
    if (at >= 0) {
      store.select(at);
      return;
    }
    views.select(ALL_MAIL_ID);
    const phrase = hit.subject.replace(/["()]/g, " ").replace(/\s+/g, " ").trim().slice(0, 100);
    bar.setText(phrase === "" ? "" : `subject:"${phrase}"`);
    wantThread = { id, query: store.query() };
  }

  /**
   * A notice or a banner was clicked (ADR 0071, rule 9): its message opens where it is shown, in
   * the list; otherwise the app goes to All mail, where new mail is on top.
   */
  function openNotice(key: number, threadId: string) {
    const at = store.messages().findIndex((m) => m.key === key || m.threadId === threadId);
    if (at >= 0) {
      store.select(at);
      return;
    }
    views.select(ALL_MAIL_ID);
    bar.setText("");
    wantThread = { id: threadId, query: store.query() };
  }
  onMount(() => {
    const onMessage = (event: MessageEvent) => {
      const data: unknown = event.data;
      if (event.source !== window || typeof data !== "object" || data === null) return;
      const mail = (data as { mattersOpenMail?: { key?: unknown; threadId?: unknown } })
        .mattersOpenMail;
      if (typeof mail?.key === "number" && typeof mail.threadId === "string") {
        openNotice(mail.key, mail.threadId);
      }
    };
    window.addEventListener("message", onMessage);
    onCleanup(() => window.removeEventListener("message", onMessage));
  });

  /** `Show this search in the list`: the query of an answer, in the bar, over all mail. */
  function showSearch(query: string) {
    paneWidth.setWide(false);
    views.select(ALL_MAIL_ID);
    bar.setText(query);
  }

  /** A view the agent offered and the person saved: its tab (ADR 0102). */
  function openView(id: string) {
    paneWidth.setWide(false);
    views.select(id);
  }

  /** What the rows of an answer's offers do when pressed: the app's own paths only (ADR 0102). */
  const offerActions: OfferActions = {
    saved: views.saved,
    saveView: (offer) =>
      saveViewOffer(offer, {
        create: (name, query) => views.create(name, query),
        backend: props.backend,
      }),
    openView,
    showSearch,
    resolve: (query) => resolveAct(props.backend, query),
    paths: {
      moveThreads: (subjects, action) => store.moveThreads(subjects, action),
      markSeen: (keys, seen) => store.markSeen(keys, seen),
    },
    openDraft: (prefill) => {
      paneWidth.setWide(false);
      void compose.open("new", undefined, undefined, undefined, prefill);
    },
  };

  /** The column is shown: beside the mail, or over the reader in a window under 1060 px. */
  const beside = createMemo(() => agent.enabled() && talk.paneOpen());
  const paneWidth = createPaneWidth(windowWidth);
  const listWidth = createListWidth(windowWidth, beside, paneWidth.width);
  // A message being written needs the reader's room: the widened agent goes back to its side.
  createEffect(() => {
    if (compose.isOpen()) paneWidth.setWide(false);
  });

  function toList() {
    store.setZone("list");
    bar.input.blur();
    listEl.focus({ preventScroll: true });
  }

  /** The search panel's ask row and ⌘↵ (ADR 0076): the words go across all mail, like ⌘J. */
  function askAcrossAll(text: string) {
    talk.setScope("all");
    // A question from the search panel starts a talk of its own (ADR 0086, rule 3).
    talk.newTalk();
    talk.setWords(text);
    openAgentPrompt(talk);
    void talk.send();
  }

  /** A thread found by the search panel: the list keeps the keys, the thread is shown. */
  function openFound(threadId: string) {
    toList();
    void store.showThread(threadId);
  }

  /** The list keeps the keys for when the user comes back from the other window. */
  function showSettings(section?: string) {
    openSettings(section);
    listEl.focus({ preventScroll: true });
  }

  function write(mode: WriteKey) {
    const open = store.thread();
    if (!open) return;
    if (mode === "forward") {
      // The files come from the message the thread shows, so their chips need no request (ADR 0045).
      void compose.open("forward", open.thread.accountId, open.thread.id, {
        hidden: store.viewAsksHidden(),
        messages: open.messages,
      });
    } else {
      void compose.open(mode, open.thread.accountId, open.thread.id);
    }
  }

  // The thread in the reader is the one that moves (ADR 0044). Spam and Move sit behind the ⋯.
  // `subjects`: what the row menu or the stack moves; without them, the thread in the reader.
  const [picker, setPicker] = createSignal<{
    x: number;
    y: number;
    subjects?: readonly MoveSubject[];
  } | null>(null);
  // Delete forever asks first, naming how many messages (rule 7); null while it is not asking.
  const [forever, setForever] = createSignal<number | null>(null);
  // The rows it is asked about, when they are not simply the thread in the reader.
  let foreverRows: readonly Message[] | undefined;
  // The menu of a row (ADR 0056, rule 4), and what it acts on.
  const [listMenu, setListMenu] = createSignal<{
    x: number;
    y: number;
    rows: readonly Message[];
  } | null>(null);
  const targetedRow = (key: number) => {
    const m = listMenu();
    return m !== null && m.rows.length === 1 && m.rows[0]?.key === key;
  };
  let moreButton: HTMLButtonElement | undefined;

  function archive() {
    void store.moveThread("archive");
  }
  function spam() {
    void store.moveThread("spam");
  }
  /** In Trash this is Delete forever and asks; anywhere else it moves to Trash. */
  function remove() {
    const trashed = store.viewAsksTrash() ? store.trashedKeys().length : 0;
    if (trashed > 0) setForever(trashed);
    else void store.moveThread("delete");
  }
  /** The Move list opens in the frame of the key: it reads the folders already here. */
  function openPicker(at?: { x: number; y: number }) {
    if (!store.thread()) return;
    const r = moreButton?.getBoundingClientRect();
    setPicker(at ?? menuPoint(r ? r.left : window.innerWidth - 300, r ? r.bottom + 2 : 80));
  }
  const places = createMemo(() => {
    const subjects = picker()?.subjects;
    const [first] = subjects ?? [];
    if (subjects !== undefined && first !== undefined) {
      return movePlaces(
        subjects.flatMap((s) => store.knownMessages(s.threadId)),
        folders.of(first.accountId),
        store.viewAsksHidden(),
      );
    }
    const open = store.thread();
    if (!open) return [];
    return movePlaces(open.messages, folders.of(open.thread.accountId), store.viewAsksHidden());
  });

  // --- Rows: the pointer, the menu and what is done to several of them (ADR 0056) ---

  /** A press on a row: ⌘ joins it to the others, ⇧ reaches it, anything else opens only it. */
  function pressRow<T>(e: MouseEvent, id: T, marked: Marks<T>, open: (id: T) => void) {
    // The right button, and Control on a Mac, are for the menu: they open nothing.
    if (e.button !== 0 || (mac && e.ctrlKey)) return;
    if (mac ? e.metaKey : e.ctrlKey) {
      e.preventDefault();
      const left = marked.toggle(id);
      if (left !== undefined) open(left);
      return;
    }
    if (e.shiftKey) {
      e.preventDefault();
      marked.extendTo(id);
      return;
    }
    marked.clear();
    open(id);
  }
  const openRow = (key: number) => {
    store.select(store.messages().findIndex((m) => m.key === key));
    listEl.focus({ preventScroll: true });
  };

  function menuForRow(e: MouseEvent, row: Message) {
    e.preventDefault();
    if (!(marks.active() && marks.has(row.key))) marks.clear();
    setListMenu({
      ...menuPoint(e.clientX, e.clientY),
      rows: marks.active() ? markedRows() : [row],
    });
  }
  /** The menu key: the menu of what is chosen, at the row it starts from. */
  function menuFromKeyboard() {
    const el = listEl.querySelector<HTMLElement>('[data-row][aria-selected="true"]');
    const r = el?.getBoundingClientRect();
    const at = menuPoint(r ? r.left + 24 : 80, r ? r.bottom - 12 : 120);
    const row = store.messages()[store.selected()];
    const rows = marks.active() ? markedRows() : row ? [row] : [];
    if (rows.length > 0) setListMenu({ ...at, rows });
  }
  const closeListMenu = () => {
    setListMenu(null);
    listEl.focus({ preventScroll: true });
  };

  function writeTo(mode: WriteKey, accountId: string, threadId: string) {
    if (mode !== "forward") {
      void compose.open(mode, accountId, threadId);
      return;
    }
    const hidden = store.viewAsksHidden();
    void props.backend
      .openThread(threadId, hidden)
      .then((r) => compose.open("forward", accountId, threadId, { hidden, messages: r.messages }));
  }

  function askDeleteForever(rows: readonly Message[]) {
    const count = store.trashedKeysOf(rows).length;
    if (count === 0) return;
    foreverRows = rows;
    setForever(count);
  }

  /** What a row's menu, or the stack, does with mail. */
  function actOnRows(action: MailAction, rows: readonly Message[], at: { x: number; y: number }) {
    const [row] = rows;
    if (row === undefined) return;
    switch (action) {
      case "reply":
      case "replyAll":
      case "forward":
        writeTo(action, row.accountId, row.threadId);
        return;
      case "read":
      case "unread":
        store.markRows(rows, action === "read");
        return;
      case "archive":
      case "delete":
      case "spam":
        marks.clear();
        void store.moveThreads(rows, action);
        return;
      case "deleteForever":
        askDeleteForever(rows);
        return;
      case "move":
        setPicker({ ...at, subjects: rows });
        return;
      case "fromSender": {
        const token = senderToken(row.from.address, false);
        if (token !== null) bar.setText(addFilter(store.query(), token));
      }
    }
  }

  /** Undo of a move, by key or by the tray. */
  async function undoMoveLine(line: MoveLine): Promise<void> {
    await store.undoMove(line);
  }

  /** The keys while several rows are chosen; true when the key was dealt with. */
  function onGroupKey(e: KeyboardEvent, key: string): boolean {
    if (key === "j" || key === "k" || key === "ArrowDown" || key === "ArrowUp") {
      // Walking on is leaving the group.
      marks.clear();
      return false;
    }
    if (/^[1-9]$/.test(key) || key === "/" || key === "c") return false;
    e.preventDefault();
    const rows = markedRows();
    const at = menuPoint(window.innerWidth / 2, 120);
    const move = moveKeyOf(key);
    if (move === "pick") actOnRows("move", rows, at);
    else if (move === "archive" || move === "spam") actOnRows(move, rows, at);
    else if (move === "delete") {
      actOnRows(store.viewAsksTrash() ? "deleteForever" : "delete", rows, at);
    } else if (key === "u")
      actOnRows(rows.some((m) => !m.flags.seen) ? "read" : "unread", rows, at);
    return true;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if ((e.metaKey || e.ctrlKey) && !e.altKey) {
      const key = e.key.toLowerCase();
      if (key === "a" && !e.shiftKey && !compose.isOpen() && listEl.contains(e.target as Node)) {
        // ⌘A in the list chooses everything it has loaded; in the reader it selects the text.
        e.preventDefault();
        marks.all();
      } else if (
        key === "k" &&
        !e.shiftKey &&
        (mac ? e.metaKey : e.ctrlKey) &&
        !compose.isOpen() &&
        forever() === null
      ) {
        // ⌘K opens the search from anywhere in the window (ADR 0076); `/` does it from the list.
        e.preventDefault();
        bar.open();
      } else if (
        key === "enter" &&
        e.target === bar.input &&
        !e.shiftKey &&
        !compose.isOpen() &&
        bar.askAgent()
      ) {
        // ⌘↵ in the bar asks the agent what is typed (ADR 0076).
        e.preventDefault();
      } else if (
        key === "g" &&
        (mac ? e.metaKey : e.ctrlKey) &&
        !compose.isOpen() &&
        forever() === null &&
        matches.total() > 0
      ) {
        // ⌘G and ⇧⌘G walk through the marked words of the open thread (ADR 0077).
        e.preventDefault();
        matches.step(e.shiftKey ? -1 : 1);
      } else if (key === "j" && !e.shiftKey && agent.enabled() && !compose.isOpen()) {
        // ⌘J asks across all mail, from anywhere, the prompt included. Plain `j` is the list's.
        e.preventDefault();
        talk.setScope("all");
        openAgentPrompt(talk);
      } else if (key === "j" && e.shiftKey && agent.enabled() && !compose.isOpen()) {
        // ⇧⌘J starts a new talk across all mail (ADR 0086, rule 3).
        e.preventDefault();
        talk.setScope("all");
        talk.newTalk();
        openAgentPrompt(talk);
      } else if (key === "e" && e.shiftKey && agent.enabled() && !compose.isOpen()) {
        // ⇧⌘E widens the agent's column over the window, and puts it back at the side.
        e.preventDefault();
        const widen = !(beside() && paneWidth.wide());
        paneWidth.setWide(widen);
        if (widen) openAgentPrompt(talk);
      } else if (key === "i") {
        // The composer has details of its own; outside it they describe the sends.
        e.preventDefault();
        setShowDetails((v) => !v);
      } else if (key === ",") {
        // On macOS the app menu takes this first; this is for the other platforms.
        e.preventDefault();
        openSettings();
      } else if (key === "s" && !e.shiftKey) {
        // ⌘S is "save this view" from anywhere in the mail window; the composer keeps its own.
        if (compose.isOpen()) return;
        e.preventDefault();
        if (views.isSaved()) {
          if (views.changed() && !views.blank()) void views.save();
        } else {
          views.startNaming();
        }
      } else if (
        key === "enter" &&
        !compose.isOpen() &&
        !e.shiftKey &&
        !isTextTarget(e) &&
        threadAgent.readyDraft() !== null
      ) {
        // ⌘↵ sends the agent's draft in this thread, only while no input has the focus and the
        // draft is on screen. Out of sight, the key only brings it into view.
        e.preventDefault();
        if (e.repeat) return;
        if (agentSendInView(reader)) void threadAgent.send();
        else goToAgentPanel();
      } else if (key === "z" && !e.shiftKey && !isTextTarget(e)) {
        if (forever() !== null) return;
        // In a text field ⌘Z undoes typing; anywhere else it takes back the latest pending move or
        // send, whichever was made last (ADR 0044, rule 10).
        const op = outbox.latestPending();
        const line = moves.latestPending();
        if (line && (!op || line.notBeforeMs >= op.notBeforeMs)) {
          e.preventDefault();
          void undoMoveLine(line);
        } else if (op) {
          e.preventDefault();
          void outbox.undo(op.id).then((result) => {
            // Taking a message back means going on with it (ADR 0041, rule 14).
            if (result === "cancelled") void compose.openDraft(op.draftId);
          });
        }
      }
      return;
    }
    if (e.altKey) return;
    if (compose.isOpen()) return; // the composer has its own keys
    // The question about deleting for good is answered with its own two buttons.
    if (forever() !== null) return;
    const inSearch = e.target === bar.input;

    if (bar.onKeyDown(e)) return;

    if (e.key === "Escape") {
      e.preventDefault();
      // The group goes first: the search it was chosen from stays as it is.
      if (marks.active()) {
        marks.clear();
        return;
      }
      // A changed view goes back to its saved text; on All mail that is clearing the query.
      if (views.changed()) views.revert();
      else toList();
      return;
    }
    if (inSearch) {
      if (e.key === "Enter" && prompt.has()) {
        // ↵ with a prompt reads it (ADR 0116, rule 3); the list takes the keys as always.
        e.preventDefault();
        void prompt.run();
        toList();
        return;
      }
      if (e.key === "Enter" && sorted.has()) {
        // ↵ with a ranked order computes it (rule 4b); the list takes the keys as always.
        e.preventDefault();
        void sorted.run();
        toList();
        return;
      }
      if (e.key === "Enter" || (e.key === "ArrowDown" && bar.atLastLine())) {
        e.preventDefault();
        toList();
      }
      return;
    }
    const key = plainKey(e, {
      composeOpen: compose.isOpen(),
      inSearch,
      textTarget: isTextTarget(e),
    });
    if (key === null) return;
    if (key === "ContextMenu" || (key === "F10" && e.shiftKey)) {
      if (!listEl.contains(e.target as Node)) return;
      e.preventDefault();
      menuFromKeyboard();
      return;
    }
    if (e.shiftKey && ["ArrowDown", "ArrowUp", "J", "K"].includes(key)) {
      if (key.startsWith("Arrow") && !listEl.contains(e.target as Node)) return;
      e.preventDefault();
      const delta = key === "ArrowDown" || key === "J" ? 1 : -1;
      marks.extendBy(delta);
      return;
    }
    if (key === "g" && agent.enabled() && talkThread() !== null && talkShared()) {
      // `g` goes to the prompt in every view; it spends nothing.
      e.preventDefault();
      askTheAgent();
      return;
    }
    if (marks.active() && onGroupKey(e, key)) return;
    if (onThreadKey(e, key)) return;
    const move = moveKeyOf(key);
    if (move !== null) {
      e.preventDefault();
      if (move === "archive") archive();
      else if (move === "delete") remove();
      else if (move === "spam") spam();
      else openPicker();
      return;
    }
    switch (key) {
      case "j":
        e.preventDefault();
        store.move(1);
        break;
      case "k":
        e.preventDefault();
        store.move(-1);
        break;
      case "ArrowDown":
      case "ArrowUp":
        // In the list the arrows walk it; in the reader they scroll it.
        if (!listEl.contains(e.target as Node)) break;
        e.preventDefault();
        store.move(key === "ArrowDown" ? 1 : -1);
        break;
      case "u":
        // Unread row: the whole thread is read. Read row: only that message becomes unread.
        e.preventDefault();
        store.toggleSeen();
        break;
      case "Enter":
        // On a quote toggle, Enter is the button's own activation.
        if (e.target instanceof HTMLButtonElement) break;
        if (store.thread()) {
          e.preventDefault();
          store.setZone("reader");
          reader.focus({ preventScroll: true });
        }
        break;
      case "/":
        e.preventDefault();
        bar.open();
        break;
      case "c":
        e.preventDefault();
        void compose.open("new", store.thread()?.thread.accountId);
        break;
      case "r":
      case "a":
      case "f":
        e.preventDefault();
        write(writeKeyOf(key) as WriteKey);
        break;
      default: {
        // 1 to 9 pick the nth tab.
        const tab = /^[1-9]$/.test(key) ? views.views()[Number(key) - 1] : undefined;
        if (tab) {
          e.preventDefault();
          views.select(tab.id);
        }
      }
    }
  }

  /**
   * Keys in an ordinary thread (ADR 0063): a digit picks a way forward on the agent's question.
   * It spends no turn. Returns true when the key was dealt with.
   */
  function onThreadKey(e: KeyboardEvent, key: string): boolean {
    if (/^[1-9]$/.test(key) && threadAgent.pickDirection(key)) {
      e.preventDefault();
      return true;
    }
    return false;
  }

  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
    const files = installFileDrop(
      {
        session: compose.session,
        open: async (target) => {
          const open = store.thread();
          const accountId = open?.thread.accountId;
          const threadId = open?.thread.id;
          if (target === "reply" && threadId !== undefined && accountId !== undefined) {
            await compose.open("reply", accountId, threadId);
          } else {
            await compose.open("new", accountId);
          }
        },
        onGranted: onDropped,
        page: window,
        body: document.body,
      },
      { setCount: setDragCount, setHover: setDropHover },
    );
    onCleanup(files.dispose);
    listEl.focus({ preventScroll: true });
    // A thread is read after it stayed open for a while with the window in front (ADR 0039).
    const focused = () => store.setWindowFocused(true);
    const blurred = () => store.setWindowFocused(false);
    store.setWindowFocused(document.hasFocus());
    window.addEventListener("focus", focused);
    window.addEventListener("blur", blurred);
    onCleanup(() => {
      window.removeEventListener("focus", focused);
      window.removeEventListener("blur", blurred);
    });
  });

  /** Who a reply would go to (ADR 0042, rule 6). */
  const replyTo = () => {
    const open = store.thread();
    return open ? replyPromptName(open.messages, own()) : null;
  };
  const inAllMail = () => views.active().id === ALL_MAIL_ID;
  const count = () => `${store.messages().length}${store.hasMore() ? "+" : ""}`;

  return (
    <div class="flex h-full flex-col">
      <header
        class="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline bg-chrome pr-3.5"
        classList={{ "pl-[96px]": mac, "pl-5": !mac }}
      >
        <h1 class="sr-only">
          {inAllMail() ? (store.filtered() ? "Search" : "All mail") : views.active().name}
        </h1>
        <ViewTabs
          views={views}
          onPicked={() => {
            paneWidth.setWide(false);
            listEl.focus({ preventScroll: true });
          }}
          onNew={() => {
            views.select(ALL_MAIL_ID);
            bar.input.focus();
          }}
        />
        <button
          type="button"
          aria-label="New message"
          title="New message  c"
          class={toolButton}
          onClick={() => void compose.open("new", store.thread()?.thread.accountId)}
        >
          <ComposeIcon />
        </button>
        <Show when={agent.enabled()}>
          <AgentPaneButton
            talk={talk}
            agent={agent}
            onHidden={() => {
              store.setZone("reader");
              reader.focus({ preventScroll: true });
            }}
          />
        </Show>
      </header>
      <QueryBar
        store={store}
        accounts={accounts}
        backend={props.backend}
        model={model}
        viewId={() => views.active().id}
        baseline={() => views.active().query}
        searching={() => store.searching()}
        canAsk={() => agent.enabled() && !compose.isOpen()}
        promptOff={() => offWhy() !== null}
        onAsk={askAcrossAll}
        onOpenThread={openFound}
        ref={(handle) => (bar = handle)}
      />
      <div class="relative flex min-h-0 flex-1">
        <section
          class="flex shrink-0 flex-col border-r border-hairline"
          style={{ width: `${listWidth.width()}px` }}
          // The strip left beside the widened agent is the way back to the mail.
          onPointerDown={() => paneWidth.setWide(false)}
          aria-label="Messages"
        >
          <ViewStatus
            views={views}
            parsed={model.parsed}
            focusBar={() => bar.input.focus()}
            focusList={() => listEl.focus({ preventScroll: true })}
          />
          <PromptLine prompt={prompt} />
          <SortLine sort={sorted} />
          <div class="min-h-0 flex-1">
            <MessageList
              store={store}
              marks={marks}
              targeted={targetedRow}
              onPress={(row, e) => pressRow(e, row.key, marks, openRow)}
              onMenu={menuForRow}
              resultsHeading={() => inAllMail() && store.filtered()}
              resultCount={count}
              whyOf={(m) => (store.ordered() ? whys().get(m.threadId) : undefined)}
              orderedEmpty={() =>
                sorted.rows() !== null
                  ? "Nothing found."
                  : prompt.progress() === null && !prompt.opening() && !promptIdle()
                    ? NOTHING_FITS
                    : ""
              }
              words={hitWords}
              own={own()}
              syncing={accounts.summary().tone === "busy"}
              markOf={(m) => (showMarks() ? accounts.marks().get(m.accountId) : undefined)}
              ref={(el) => (listEl = el)}
            />
          </div>
          <div class="flex h-11 shrink-0 border-t border-hairline bg-chrome">
            <button
              type="button"
              data-sync-status
              aria-label={`Accounts: ${accounts.summary().text}. ${accounts
                .accounts()
                .map((a) => a.address)
                .join(", ")}`}
              class="group relative flex min-w-0 flex-1 cursor-default items-center gap-2.5 px-4 text-left text-[12px] hover:bg-fill"
              // A refused password (or any other account error) opens Accounts, where its form
              // waits (ADR 0113).
              onClick={() =>
                showSettings(accounts.summary().tone === "error" ? "accounts" : undefined)
              }
            >
              <span class="flex">
                <For each={accounts.accounts().slice(0, 3)}>
                  {(a, i) => (
                    <span
                      title={a.address}
                      aria-hidden="true"
                      class="inline-flex size-[22px] items-center justify-center rounded-full text-[10.5px] font-semibold ring-2 ring-chrome"
                      classList={{ "-ml-1.5": i() > 0 }}
                      style={{
                        background: accounts.marks().get(a.id)?.fill,
                        color: accounts.marks().get(a.id)?.ink,
                      }}
                    >
                      {accounts.marks().get(a.id)?.letter ?? "?"}
                    </span>
                  )}
                </For>
              </span>
              <span
                aria-hidden="true"
                class="size-1.5 shrink-0 rounded-full"
                classList={{
                  "bg-good": accounts.summary().tone === "idle",
                  "bg-secondary animate-pulse": accounts.summary().tone === "busy",
                  "bg-late": accounts.summary().tone === "error",
                }}
              />
              <span
                class="min-w-0 flex-1 truncate"
                classList={{
                  "text-mid": accounts.summary().tone !== "error",
                  "text-late": accounts.summary().tone === "error",
                }}
                role="status"
                aria-live="polite"
              >
                {accounts.summary().text}
              </span>
              <span
                aria-hidden="true"
                class="pointer-events-none absolute bottom-full left-3 z-30 mb-1.5 hidden max-w-[320px] flex-col gap-1 rounded-[9px] border border-hairline bg-bg px-3 py-2 text-[12px] text-ink shadow-[var(--pop)] group-hover:flex group-focus-visible:flex"
              >
                <For each={accounts.accounts()}>
                  {(a) => (
                    <span class="flex items-center gap-2">
                      <span
                        class="size-[7px] shrink-0 rounded-full"
                        style={{ background: accounts.marks().get(a.id)?.dot }}
                      />
                      <span class="truncate">{a.address}</span>
                    </span>
                  )}
                </For>
              </span>
            </button>
            <button
              type="button"
              aria-label="Settings"
              title="Settings  ⌘,"
              class={`${toolButton} mx-1.5 shrink-0 self-center`}
              onClick={() => showSettings()}
            >
              <SettingsIcon />
            </button>
          </div>
        </section>
        <ListDivider list={listWidth} />
        <div class="relative flex min-w-0 flex-1 flex-col">
          <div class="relative flex min-h-0 flex-1">
            <section
              ref={reader}
              tabIndex={-1}
              aria-label="Thread"
              // Positioned, so that text for screen readers deep in a long thread stays inside this
              // scroller and cannot make the window itself taller than it is.
              class="selectable relative min-h-0 min-w-0 flex-1 overflow-y-auto outline-none"
            >
              <Show when={marks.active()}>
                <MailStack
                  rows={markedRows()}
                  deletesForever={store.viewAsksTrash()}
                  own={own()}
                  onAct={(action, at) => actOnRows(action, markedRows(), at)}
                  onOpen={(key) => {
                    marks.clear();
                    openRow(key);
                  }}
                  onRemove={(keys) => {
                    let left: number | undefined;
                    for (const key of keys) left = marks.toggle(key);
                    if (left !== undefined) openRow(left);
                  }}
                  onClear={() => marks.clear()}
                />
              </Show>
              <Show when={!marks.active()}>
                <ThreadView
                  store={store}
                  own={own()}
                  onWrite={write}
                  onFilter={(token) => bar.setText(addFilter(store.query(), token))}
                  backend={props.backend}
                  mark={(id) =>
                    accounts.accounts().length > 1 ? accounts.marks().get(id) : undefined
                  }
                  accountMark={(id) => accounts.marks().get(id)}
                  onArchive={archive}
                  onDelete={remove}
                  onSpam={spam}
                  onMove={openPicker}
                  deletesForever={store.viewAsksTrash() && store.trashedKeys().length > 0}
                  moreRef={(el) => (moreButton = el)}
                  agent={agent}
                  threadAgent={threadAgent}
                  words={hitWords}
                  matches={matches}
                  replying={(threadId) => inlineReply()?.base.threadId === threadId}
                  reply={() => (
                    <Show when={inlineReply()}>
                      {(session) => (
                        <ReplyEditor
                          session={session()}
                          dragCount={dragCount}
                          agent={replyAgent() ?? undefined}
                        />
                      )}
                    </Show>
                  )}
                />
              </Show>
            </section>
            <Show when={beside()}>
              <AgentPane
                talk={talk}
                agent={agent}
                backend={props.backend}
                pane={paneWidth}
                thread={talkThread}
                prepared={talkPrepared}
                shared={talkShared}
                addresses={talkAddresses}
                runtimeName={() => talkRuntimeName(agent.status(), talk.scope(), talk.choice())}
                onSeeWork={goToAgentPanel}
                onOpenHit={openHit}
                onShowSearch={showSearch}
                offers={offerActions}
                onOpenSettings={() => showSettings("agents")}
                onLeave={() => {
                  store.setZone("reader");
                  reader.focus({ preventScroll: true });
                }}
              />
            </Show>
          </div>
          <Show when={fullComposer()}>
            {(session) => (
              <Composer
                session={session()}
                accounts={accounts.accounts()}
                showDetails={showDetails()}
                dragCount={dragCount}
                agent={replyAgent() ?? undefined}
                suggest={(prefix) => props.backend.suggestPeople(prefix, 8)}
                canGoInline={store.thread()?.thread.id === session().base.threadId}
              />
            )}
          </Show>
        </div>
        <NoticeStack
          backend={props.backend}
          markOf={(id) => (accounts.accounts().length > 1 ? accounts.marks().get(id) : undefined)}
          onOpen={openNotice}
        />
        <Show when={!compose.isOpen()}>
          <DropOverlay
            listWidth={listWidth.width}
            count={dragCount}
            replyTo={replyTo}
            hover={dropHover}
            setHover={setDropHover}
          />
        </Show>
      </div>
      <Show when={compose.problem() !== ""}>
        <p class="border-t border-hairline px-3.5 py-2 text-[12.5px] text-late" role="alert">
          {compose.problem()}
        </p>
      </Show>
      <SendTray
        outbox={outbox}
        moves={moves}
        onUndoMove={(line) => void undoMoveLine(line)}
        showDetails={showDetails() && !compose.isOpen()}
        onOpenDraft={(draftId) => void compose.openDraft(draftId)}
        agent={agent}
      />
      <Show when={picker()}>
        {(at) => (
          <MovePicker
            x={at().x}
            y={at().y}
            places={places()}
            onPick={(target) => {
              const subjects = at().subjects;
              setPicker(null);
              listEl.focus({ preventScroll: true });
              if (subjects === undefined) void store.moveThread("move", target);
              else {
                marks.clear();
                void store.moveThreads(subjects, "move", target);
              }
            }}
            onClose={() => {
              setPicker(null);
              listEl.focus({ preventScroll: true });
            }}
          />
        )}
      </Show>
      <Show when={forever()}>
        {(count) => (
          <ForeverDialog
            count={count()}
            onCancel={() => {
              setForever(null);
              foreverRows = undefined;
              listEl.focus({ preventScroll: true });
            }}
            onConfirm={() => {
              const rows = foreverRows;
              foreverRows = undefined;
              setForever(null);
              marks.clear();
              listEl.focus({ preventScroll: true });
              void store.deleteForever(rows);
            }}
          />
        )}
      </Show>
      <Show when={listMenu()}>
        {(at) => {
          const m = at();
          const [row] = m.rows;
          const name =
            m.rows.length === 1 &&
            row !== undefined &&
            senderToken(row.from.address, false) !== null
              ? displayName(row.from)
              : undefined;
          return (
            <ListMenuView<MailAction>
              menu={mailMenu(m.rows, {
                deletesForever: store.viewAsksTrash(),
                senderName: name,
              })}
              label={m.rows.length === 1 ? "Message actions" : "Actions for the chosen messages"}
              x={m.x}
              y={m.y}
              onPick={(action) => {
                closeListMenu();
                actOnRows(action, m.rows, { x: m.x, y: m.y });
              }}
              onClose={(back) => {
                setListMenu(null);
                if (back) listEl.focus({ preventScroll: true });
              }}
            />
          );
        }}
      </Show>
    </div>
  );
}

const namesLine = (names: readonly string[]) => {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, 4).join(", ");
  return unique.length > 4 ? `${shown} and ${unique.length - 4} more` : shown;
};

const buttonPoint = (button: HTMLElement) => {
  const r = button.getBoundingClientRect();
  return menuPoint(r.left, r.bottom + 2);
};

/** The stack of mail: one sheet per thread, the newest row of each (ADR 0056, rule 3). */
function MailStack(props: {
  rows: readonly Message[];
  deletesForever: boolean;
  own: ReadonlySet<string>;
  onAct: (action: MailAction, at: { x: number; y: number }) => void;
  onOpen: (key: number) => void;
  onRemove: (keys: readonly number[]) => void;
  onClear: () => void;
}) {
  const threads = createMemo(() => {
    const out = new Map<string, Message[]>();
    for (const m of props.rows) {
      const list = out.get(m.threadId);
      if (list) list.push(m);
      else out.set(m.threadId, [m]);
    }
    return out;
  });
  const items = createMemo<StackItem[]>(() =>
    [...threads().values()].map((rows) => {
      const m = rows[0] as Message;
      return {
        id: String(m.key),
        who: displayName(m.from),
        when: listDate(m.dateMs),
        title: m.subject || "(no subject)",
        note: m.snippet,
        unread: rows.some((r) => !r.flags.seen),
      };
    }),
  );
  // The primary group first: what a stack is usually made for is clearing it away.
  const menu = createMemo((): Menu<MailAction> => {
    const whole = mailMenu(props.rows, { deletesForever: props.deletesForever });
    return { sections: [...whole.sections].reverse() };
  });
  const unread = () => props.rows.filter((m) => !m.flags.seen).length;
  return (
    <ThreadStack<MailAction>
      title={threadsText(threads().size)}
      people={`${namesLine(props.rows.map((m) => displayName(m.from)))}${unread() > 0 ? ` · ${unread()} unread` : ""}`}
      items={items()}
      menu={menu()}
      primary="archive"
      onAct={(action, button) => props.onAct(action, buttonPoint(button))}
      onOpen={(id) => props.onOpen(Number(id))}
      onRemove={(id) => {
        const row = props.rows.find((m) => m.key === Number(id));
        const list = row ? threads().get(row.threadId) : undefined;
        if (list) props.onRemove(list.map((m) => m.key));
      }}
      onClear={props.onClear}
    />
  );
}

function MessageList(props: {
  store: MailStore;
  marks: Marks<number>;
  /** The row the menu is open on. */
  targeted: (key: number) => boolean;
  onPress: (row: Message, e: MouseEvent) => void;
  onMenu: (e: MouseEvent, row: Message) => void;
  /** `Results` over a search; inside a view the list keeps its day headings. */
  resultsHeading: () => boolean;
  /** How many messages the list holds, `50+` while more can be loaded: beside `Results` (ADR 0093). */
  resultCount: () => string;
  /** The model's sentence for a row a prompt kept (ADR 0116, rule 6). */
  whyOf: (message: Message) => string | undefined;
  /** What an empty list says while it holds a prompt's rows. */
  orderedEmpty: () => string;
  syncing: boolean;
  /** The account mark of a message; undefined when the view does not show marks. */
  markOf: (message: Message) => AccountMark | undefined;
  /** The words of the search to mark in the rows (ADR 0077). */
  words: () => readonly string[];
  /** The person's own addresses, to show who their own mail went to (ADR 0078). */
  own: ReadonlySet<string>;
  ref: (el: HTMLDivElement) => void;
}) {
  const { store, marks } = props;
  // The marked parts of a row are cut once per message and query, not on every draw.
  const rowHits = createRowHits();
  let scroller!: HTMLDivElement;

  // Day headings are laid out against the day the list was built; a new day rebuilds on change.
  // A prompt's rows are in its order, not by day: no headings (ADR 0116, rule 7), unless that
  // order is by date (rule 4b). Either way along the key, the headings follow the rows.
  const layout = createMemo(() =>
    layoutList(
      store.messages(),
      Date.now(),
      store.ordered() && !store.orderedDated()
        ? null
        : props.resultsHeading()
          ? "Results"
          : undefined,
    ),
  );

  const virtualizer = createVirtualizer({
    get count() {
      return layout().items.length;
    },
    getScrollElement: () => scroller,
    get estimateSize() {
      const items = layout().items;
      return (i: number) => (items[i]?.kind === "head" ? HEAD_HEIGHT : ROW_HEIGHT);
    },
    overscan: 8,
  });
  // The virtualizer places items anew only when their number changes. A layout with as many
  // items but a heading elsewhere would keep the old places, and a row would stand where a
  // heading's height was kept for it. So such a layout is measured again; any other already is,
  // and measuring it twice would cost a keystroke its time.
  let placed = layout().items.length;
  createEffect(
    on(
      layout,
      (l) => {
        if (l.items.length === placed) virtualizer.measure();
        placed = l.items.length;
      },
      { defer: true },
    ),
  );

  // Follows the message, not its index: mail arriving above moves the index of the same message,
  // and scrolling for that would add to what the anchor below already corrects.
  // A memo, because `on` runs for every change of what it tracks, even to an equal value.
  const selectedKey = createMemo(() => store.messages()[store.selected()]?.key);
  createEffect(
    on(selectedKey, () => {
      const item = layout().rowItem[store.selected()];
      // The first row of a day shows its heading too.
      if (item !== undefined) virtualizer.scrollToIndex(item === 1 ? 0 : item);
    }),
  );

  // Mail arriving above the viewport must not move what the reader is looking at: remember the
  // offset of the message at the top, and after the change scroll by however far it moved.
  let anchorKey: number | undefined;
  let anchorStart = 0;
  store.setAnchor(() => {
    const l = layout();
    const at = itemAt(l, scroller.scrollTop);
    // A heading at the top anchors on the row under it.
    const item = l.items[at]?.kind === "head" ? at + 1 : at;
    const row = l.items[item];
    if (row?.kind !== "row") return undefined;
    anchorStart = l.starts[item] ?? 0;
    anchorKey = store.messages()[row.index]?.key;
    return anchorKey;
  });
  onCleanup(
    store.onShift(() => {
      const l = layout();
      const index = store.messages().findIndex((m) => m.key === anchorKey);
      const start = l.starts[l.rowItem[index] ?? -1];
      if (start !== undefined && scroller.scrollTop > 0) scroller.scrollTop += start - anchorStart;
    }),
  );

  // A prompt's rows came or went (ADR 0116, rule 7): the same message may now stand elsewhere.
  createEffect(
    on(
      store.ordered,
      () => {
        const item = layout().rowItem[store.selected()];
        if (item !== undefined) virtualizer.scrollToIndex(item === 1 ? 0 : item);
      },
      { defer: true },
    ),
  );

  // ⇧ with an arrow walks past the end of the view.
  createEffect(
    on(marks.head, (head) => {
      const at = head === null ? -1 : store.messages().findIndex((m) => m.key === head);
      const item = layout().rowItem[at];
      if (item !== undefined) virtualizer.scrollToIndex(item === 1 ? 0 : item);
    }),
  );

  // Page in older messages when the viewport nears the end of what is loaded.
  createEffect(() => {
    const last = virtualizer.getVirtualItems().at(-1);
    if (last && last.index >= layout().items.length - 40) void store.loadMore();
  });

  return (
    <div
      ref={(el) => {
        scroller = el;
        props.ref(el);
      }}
      tabIndex={-1}
      role="listbox"
      aria-label="Messages"
      aria-multiselectable="true"
      class="relative h-full overflow-y-auto outline-none focus-visible:outline-none"
    >
      <Show
        when={store.messages().length > 0}
        fallback={
          <Show when={!store.searching()}>
            <p class="px-6 pt-16 text-center text-[13px] text-secondary">
              {store.ordered()
                ? props.orderedEmpty()
                : store.filtered()
                  ? "Nothing found."
                  : props.syncing
                    ? "Your mail is on its way."
                    : "Nothing here."}
            </p>
          </Show>
        }
      >
        <div class="relative w-full" style={{ height: `${virtualizer.getTotalSize()}px` }}>
          <For each={virtualizer.getVirtualItems()}>
            {(v) => {
              const item = () => layout().items[v.index];
              const index = () => {
                const it = item();
                return it?.kind === "row" ? it.index : -1;
              };
              const message = () => store.messages()[index()];
              const markOf = () => {
                const m = message();
                return m ? props.markOf(m) : undefined;
              };
              const label = () => {
                const it = item();
                return it?.kind === "head" ? it.label : "";
              };
              return (
                <Show
                  when={index() >= 0}
                  fallback={
                    <Heading
                      label={label()}
                      // Only the search heading carries the count; it is the first item.
                      count={props.resultsHeading() && v.index === 0 ? props.resultCount() : ""}
                      top={v.start}
                    />
                  }
                >
                  <Row
                    message={message()}
                    mark={markOf()}
                    own={props.own}
                    selected={
                      marks.active()
                        ? marks.has(message()?.key ?? -1)
                        : store.selected() === index()
                    }
                    targeted={props.targeted(message()?.key ?? -1)}
                    reading={store.readingThread() === message()?.threadId}
                    top={v.start}
                    hits={(() => {
                      const m = message();
                      return m === undefined ? null : rowHits.of(m, props.words());
                    })()}
                    why={(() => {
                      const m = message();
                      return m === undefined ? undefined : props.whyOf(m);
                    })()}
                    onPress={(e) => {
                      const m = message();
                      if (m) props.onPress(m, e);
                    }}
                    onMenu={(e) => {
                      const m = message();
                      if (m) props.onMenu(e, m);
                    }}
                  />
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}

function Heading(props: { label: string; count: string; top: number }) {
  return (
    <div
      role="presentation"
      class="absolute inset-x-0 flex h-[34px] items-end gap-1.5 px-5 pb-1.5 text-[11.5px] font-semibold text-secondary"
      style={{ transform: `translateY(${props.top}px)` }}
    >
      {props.label}
      <Show when={props.count}>
        <span class="font-normal tabular-nums">{props.count}</span>
      </Show>
    </div>
  );
}

function Row(props: {
  message: Message | undefined;
  mark: AccountMark | undefined;
  /** The person's own addresses: a row of their own mail shows who it went to (ADR 0078). */
  own: ReadonlySet<string>;
  selected: boolean;
  targeted: boolean;
  /** Its thread is about to become read: an unread dot drains over the same time. */
  reading: boolean;
  top: number;
  /** The marked parts of subject and snippet while a search with free words is shown (ADR 0077). */
  hits: RowSegments | null;
  /** A prompt kept the row: the model's sentence takes the snippet's line (ADR 0116, rule 6). */
  why?: string | undefined;
  onPress: (e: MouseEvent) => void;
  onMenu: (e: MouseEvent) => void;
}) {
  return (
    <Show when={props.message}>
      {(m) => {
        const who = createMemo(() => rowPerson(m(), props.own));
        // The third line: the snippet, or the model's own sentence in the agent's colour.
        const third = () => (
          <Show
            when={props.why}
            fallback={
              <Show when={props.hits} fallback={m().snippet}>
                {(h) => <Segments segments={h().snippet} />}
              </Show>
            }
          >
            {(why) => (
              <span class="text-agent" title={why()} data-prompt-why>
                {why()}
              </span>
            )}
          </Show>
        );
        return (
          <div
            data-row
            tabIndex={-1}
            role="option"
            aria-selected={props.selected}
            class="absolute inset-x-0 h-[68px] px-1.5 py-px"
            style={{ transform: `translateY(${props.top}px)` }}
            onMouseDown={props.onPress}
            onContextMenu={props.onMenu}
          >
            <div
              class="grid h-full cursor-default grid-cols-[32px_minmax(0,1fr)_auto] content-center gap-x-2.5 gap-y-px rounded-[8px] pr-3.5 pl-2 [--row-bg:var(--bg)]"
              classList={{
                "bg-selected [--row-bg:var(--selected)]": props.selected,
                "ring-1 ring-inset ring-edge": props.targeted,
              }}
            >
              <span class="relative col-start-1 row-span-3 row-start-1 self-center" data-row-avatar>
                <Avatar size={32} initials={who().mark.initials} tint={who().mark.tint} />
                {/* The unread dot sits on the avatar's top-left corner, ringed in the row's own
                  colour so it stays a dot on a selected row too (ADR 0078). */}
                <span
                  aria-hidden="true"
                  class="absolute -top-[3px] -left-[3px] rounded-full bg-(--row-bg) p-[2px]"
                  classList={{ hidden: m().flags.seen }}
                >
                  <span
                    class="block size-[8px] rounded-full"
                    classList={{
                      "bg-ink": !m().flags.seen && !props.reading,
                      "dot-reading": !m().flags.seen && props.reading,
                    }}
                    style={{ "--dwell": `${DWELL_MS}ms` }}
                  />
                </span>
              </span>
              <Show when={!m().flags.seen}>
                <span class="sr-only">Unread</span>
              </Show>
              <span class="col-start-2 truncate font-semibold">{who().name}</span>
              <span class="flex items-center gap-1.5 text-[12px] text-secondary tabular-nums">
                <Show when={m().flags.flagged}>
                  <span class="size-[7px] rounded-full bg-late" title="Flagged" />
                  <span class="sr-only">Flagged</span>
                </Show>
                <Show when={m().hasAttachments}>
                  <PaperclipIcon />
                  <span class="sr-only">Attachment</span>
                </Show>
                {listDate(m().dateMs)}
              </span>
              <span
                class="col-start-2 col-end-4 truncate"
                classList={{ "font-medium": !m().flags.seen }}
              >
                <Show when={props.hits} fallback={m().subject || "(no subject)"}>
                  {(h) => <Segments segments={h().subject} />}
                </Show>
              </span>
              <Show
                when={props.mark}
                fallback={
                  <span class="col-start-2 col-end-4 truncate text-[12px] text-secondary">
                    {third()}
                  </span>
                }
              >
                {(mark) => (
                  <span class="col-start-2 col-end-4 flex min-w-0 items-center gap-2">
                    <span class="min-w-0 flex-1 truncate text-[12px] text-secondary">
                      {third()}
                    </span>
                    <span class="sr-only">Account {mark().address}</span>
                    {/* The padding gives the tooltip more than the dot's 6px to land on. */}
                    <span aria-hidden="true" title={mark().address} class="-m-1 shrink-0 p-1">
                      <span
                        class="block size-[6px] rounded-full"
                        style={{ background: mark().dot }}
                      />
                    </span>
                  </span>
                )}
              </Show>
            </div>
          </div>
        );
      }}
    </Show>
  );
}

function ThreadView(props: {
  store: MailStore;
  own: ReadonlySet<string>;
  onWrite: (mode: WriteKey) => void;
  /** Writes a filter token into the query (ADR 0028). */
  onFilter: (token: string) => void;
  backend: Backend;
  /** The mark of an account; undefined when the mail has only one account. */
  mark: (accountId: string) => AccountMark | undefined;
  /** The colour of an account, always: the avatar of the person's own messages wears it. */
  accountMark: (accountId: string) => AccountMark | undefined;
  onArchive: () => void;
  /** Delete, or Delete forever when `deletesForever`. */
  onDelete: () => void;
  onSpam: () => void;
  /** Opens the Move list, at the point when the menu asked for it. */
  onMove: (at?: { x: number; y: number }) => void;
  deletesForever: boolean;
  moreRef: (el: HTMLButtonElement) => void;
  agent: AgentStore;
  /** The agent in this thread (ADR 0063). */
  threadAgent: ThreadAgentStore;
  /** The words of the search the thread was opened from, to mark (ADR 0077). */
  words: () => readonly string[];
  matches: MatchNavigator;
  /** Whether a reply is being written under this thread (ADR 0100). */
  replying: (threadId: string) => boolean;
  /** That reply, in place of the "Reply to…" line; called only while `replying` says so. */
  reply: () => JSX.Element;
}) {
  const open = createMemo(() => props.store.thread());
  const more = createMenuAnchor();

  const isOwn = (p: Participant) => props.own.has(p.address.toLowerCase());
  const fromIsOwn = (m: ThreadMessage) => isOwn(m.from) && isReallyOwn(m);

  return (
    <Show
      when={open()}
      fallback={
        <div class="flex h-full flex-col items-center justify-center gap-3 text-secondary">
          <Ring size={28} />
          <p class="text-[13px]">Select a message to read it.</p>
        </div>
      }
    >
      {(t) => {
        const messages = () => t().messages;
        // The header names the other side; the line under the subject names who else is in it.
        const lead = createMemo(() => {
          const c = counterpart(messages(), props.own);
          return c === undefined || c.role === "self" ? null : c.person.address.toLowerCase();
        });
        const people = createMemo(() => {
          const seen = new Map<string, string>();
          for (const m of messages()) {
            for (const p of [m.from, ...m.to, ...m.cc]) {
              const key = p.address.toLowerCase();
              if (key === lead()) continue;
              if (!seen.has(key)) {
                const you = p === m.from ? fromIsOwn(m) : isOwn(p);
                seen.set(key, you ? "you" : displayName(p));
              }
            }
          }
          // "you" goes last, as in "Anna, Piotr, you".
          const names = [...seen.values()];
          const others = names.filter((n) => n !== "you");
          return names.length > others.length ? [...others, "you"] : others;
        });
        const last = () => messages().at(-1);
        return (
          <HitsContext.Provider value={props.words}>
            <article data-thread-id={t().thread.id} class="settle px-8 pt-6 pb-8">
              <header class="mb-4">
                {/* No sender block on top (ADR 0099): each letter names its sender; the thread
                    keeps its tools on the right, above the subject. */}
                <div data-thread-tools class="-mr-2 flex items-center justify-end gap-0.5">
                  <Show when={props.matches.total() > 0}>
                    {/* biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and its layout */}
                    <div class="match-nav" role="group" aria-label="Matches in this thread">
                      <span class="match-count" data-match-count aria-live="polite">
                        {props.matches.label()}
                      </span>
                      <button
                        type="button"
                        class="match-step"
                        aria-label="Previous match"
                        title="Previous match  ⇧⌘G"
                        onClick={() => props.matches.step(-1)}
                      >
                        ↑
                      </button>
                      <button
                        type="button"
                        class="match-step"
                        aria-label="Next match"
                        title="Next match  ⌘G"
                        onClick={() => props.matches.step(1)}
                      >
                        ↓
                      </button>
                    </div>
                  </Show>
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
                  <Show when={props.threadAgent.available()}>
                    <AgentHeaderButton onPress={askTheAgent} />
                  </Show>
                  <button
                    type="button"
                    aria-label="Forward"
                    title="Forward  f"
                    class={toolButton}
                    onClick={() => props.onWrite("forward")}
                  >
                    <ForwardIcon />
                  </button>
                  <button
                    type="button"
                    aria-label="Archive"
                    title="Archive  e"
                    class={toolButton}
                    onClick={() => props.onArchive()}
                  >
                    <ArchiveIcon />
                  </button>
                  <button
                    type="button"
                    aria-label={props.deletesForever ? "Delete forever" : "Delete"}
                    title={props.deletesForever ? "Delete forever  ⌫" : "Delete  ⌫"}
                    class={toolButton}
                    onClick={() => props.onDelete()}
                  >
                    <TrashIcon />
                  </button>
                  <button
                    type="button"
                    ref={(el) => props.moreRef(el)}
                    aria-label="More actions"
                    aria-haspopup="menu"
                    aria-expanded={more.at() !== null}
                    title="More"
                    class={toolButton}
                    onClick={(e) => more.open(e.currentTarget)}
                  >
                    <MoreIcon />
                  </button>
                  <Show when={more.at()}>
                    {(at) => (
                      <PopMenu label="More actions" x={at().x} y={at().y} onClose={more.close}>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            more.close(true);
                            props.onSpam();
                          }}
                        >
                          <SpamIcon />
                          <span class="ml-2 flex-1">Mark as spam</span>
                          <span class="text-secondary">!</span>
                        </button>
                        <button
                          type="button"
                          role="menuitem"
                          onClick={() => {
                            const where = at();
                            more.close(false);
                            props.onMove(where);
                          }}
                        >
                          <FolderIcon />
                          <span class="ml-2 flex-1">Move to…</span>
                          <span class="text-secondary">v</span>
                        </button>
                      </PopMenu>
                    )}
                  </Show>
                </div>
                <div class="mt-1 flex min-w-0 flex-col gap-1">
                  <h2 class="font-serif text-[22px] leading-[1.25] font-semibold tracking-[-0.01em] text-balance">
                    <HitText text={t().thread.subject || "(no subject)"} />
                  </h2>
                  {/* One quiet line (ADR 0097): who else, how many, which account, the labels. A
                      single message says none of the first two: its letter names them already. */}
                  <div
                    data-thread-meta
                    class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-secondary"
                  >
                    <Show when={messages().length > 1}>
                      <span class="truncate">
                        {people().length > 0 ? people().slice(0, 4).join(", ") : ""}
                        {people().length > 4 ? ` and ${people().length - 4} more` : ""}
                        {people().length > 0 ? " · " : ""}
                        {`${messages().length} messages`}
                      </span>
                    </Show>
                    <Show when={props.mark(t().thread.accountId)}>
                      {(mark) => (
                        <span class="flex min-w-0 items-center gap-1.5" title="Account">
                          <span
                            aria-hidden="true"
                            class="size-[7px] shrink-0 rounded-full"
                            style={{ background: mark().dot }}
                          />
                          <span class="truncate">{mark().address}</span>
                        </span>
                      )}
                    </Show>
                    <Show when={t().thread.labelIds.length > 0}>
                      <div class="flex flex-wrap gap-1">
                        <For each={t().thread.labelIds}>
                          {(label) => {
                            const token = labelToken(label);
                            return token === null ? (
                              <span class="rounded-[8px] bg-fill px-2 py-0.5 text-[11px] text-mid">
                                {label}
                              </span>
                            ) : (
                              <button
                                type="button"
                                title={`Search ${token}`}
                                class="cursor-default rounded-[8px] bg-fill px-2 py-0.5 text-[11px] text-mid hover:bg-button hover:text-ink focus-visible:outline-1 focus-visible:outline-edge"
                                onClick={() => props.onFilter(token)}
                              >
                                {label}
                              </button>
                            );
                          }}
                        </For>
                      </div>
                    </Show>
                  </div>
                </div>
              </header>
              <AgentStrip ta={props.threadAgent} />
              <ThreadLetters
                messages={messages()}
                own={props.own}
                onFilter={props.onFilter}
                backend={props.backend}
                accountMark={props.accountMark}
                matches={props.matches}
                focus={() => {
                  const row = props.store.messages()[props.store.selected()];
                  return row?.threadId === t().thread.id ? row.key : null;
                }}
              />
              <AgentPanel
                ta={props.threadAgent}
                agent={props.agent}
                threadId={t().thread.id}
                own={props.own}
                messages={messages()}
              />
              <Show when={last() !== undefined && !props.replying(t().thread.id)}>
                <button
                  type="button"
                  class="mt-3 grid h-[44px] w-full cursor-default grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[12px] border border-edge bg-bg px-4 text-left text-[13px] text-secondary hover:text-mid"
                  onClick={() => props.onWrite("reply")}
                >
                  <span class="flex justify-center">
                    <ReplyIcon />
                  </span>
                  <span class="truncate">Reply to {replyPromptName(messages(), props.own)}…</span>
                  <kbd class="rounded-[4px] bg-fill px-1.5 font-sans text-[11px]">r</kbd>
                </button>
              </Show>
              <Show when={props.replying(t().thread.id)}>{props.reply()}</Show>
            </article>
          </HitsContext.Provider>
        );
      }}
    </Show>
  );
}

/**
 * The letters of a thread, with what they need around them: where a link goes, and the warning when
 * it goes somewhere else than it says.
 */
function ThreadLetters(props: {
  messages: readonly ThreadMessage[];
  own: ReadonlySet<string>;
  /** Writes a filter token into the query (ADR 0028). */
  onFilter: (token: string) => void;
  backend: Backend;
  /** The colour of an account: the avatar of the person's own messages wears it. */
  accountMark: (accountId: string) => AccountMark | undefined;
  /** The walk through the marked words; the letters open and scroll when it shows a match (ADR 0077). */
  matches?: MatchNavigator;
  /** The letter of the selected row; picking another row of the open thread goes to its letter. */
  focus?: () => number | null;
}) {
  const [hoverLink, setHoverLink] = createSignal<string | null>(null);
  const [warning, setWarning] = createSignal<{ shown: string; href: string } | null>(null);

  function followLink(link: MailLink) {
    if (!isOpenable(link.href)) return;
    const shown = misleadingHost(link.text, link.href);
    if (shown) setWarning({ shown, href: link.href });
    else openExternally(link.href);
  }

  const isOwn = (p: Participant) => props.own.has(p.address.toLowerCase());
  /** Recipients: the reader's own address reads "You". */
  const name = (p: Participant) => (isOwn(p) ? "You" : displayName(p));
  /** A sender reads "You" only when the message is really the reader's (ADR 0048). */
  const fromName = (m: ThreadMessage) => senderName(m, props.own);
  const fromIsOwn = (m: ThreadMessage) => isOwn(m.from) && isReallyOwn(m);
  // Letters follow message keys: a flag moving must not fold or reload any of them.
  const keys = createMemo(() => letterKeys(props.messages), [], { equals: sameKeys });
  const byKey = createMemo(() => new Map(props.messages.map((m) => [m.key, m])));
  // How each letter starts is decided once, when the letter is first seen: the newest and the
  // unread start open, the rest fold to one line. A later version of the message moves nothing.
  const starts = new Map<number, boolean>();
  // The fold of a long run of folded letters is decided from those starts, once per list of keys.
  const run = createMemo(
    () => {
      const ks = keys();
      const by = untrack(byKey);
      const list = ks.map((k, i) => {
        let start = starts.get(k);
        const message = by.get(k) as ThreadMessage;
        if (start === undefined) {
          start = i === ks.length - 1 || !message.flags.seen;
          starts.set(k, start);
        }
        return { open: start, dateMs: message.dateMs };
      });
      return foldRun(list);
    },
    null,
    { equals: sameRun },
  );
  const [unfolded, setUnfolded] = createSignal(false);
  // Keys in the run, from its second row on: hidden until the row is activated.
  const folded = createMemo(() => {
    const r = run();
    return r === null || unfolded() ? new Set<number>() : new Set(keys().slice(r.start, r.end));
  });
  const foldAt = () => {
    const r = run();
    return r === null || unfolded() ? undefined : keys()[r.start];
  };
  const range = (r: { fromMs: number; toMs: number }) => {
    const a = listDate(r.fromMs);
    const b = listDate(r.toMs);
    return a === b ? a : `${a} – ${b}`;
  };

  // ADR 0077. Showing a match: unfold the run it is in, open its letter, then scroll to the mark.
  let letters: HTMLDivElement | undefined;
  const [forced, setForced] = createSignal<ReadonlySet<number>>(new Set());
  createEffect(
    on(
      () => props.matches?.showing() ?? null,
      (showing) => {
        if (showing === null) return;
        const open = new Set<number>(forced());
        for (const k of keys()) if (starts.get(k) === true) open.add(k);
        const plan = planReveal(showing.key, { folded: folded(), open });
        if (plan.unfold) setUnfolded(true);
        if (plan.open) setForced(new Set([...forced(), showing.key]));
        const place = () => {
          const section = letters?.querySelector(`[data-letter-key="${showing.key}"]`);
          const marks = section?.querySelectorAll<HTMLElement>("mark.hit[data-nav]");
          const target = marks?.[showing.ordinal];
          if (!letters || !target) return false;
          for (const old of letters.querySelectorAll("mark.hit[data-now]")) {
            old.removeAttribute("data-now");
          }
          target.setAttribute("data-now", "");
          target.scrollIntoView({ block: "center" });
          return true;
        };
        // The letter renders in the same turn; one frame later is the safe moment to look.
        requestAnimationFrame(() => {
          if (!place()) requestAnimationFrame(place);
        });
      },
      { defer: true },
    ),
  );

  // Picking another row of the same thread opens nothing new: the reader goes to that letter,
  // unfolding and opening it. Opening a thread itself keeps its usual start.
  createEffect(
    on(
      () => props.focus?.() ?? null,
      (key, prev) => {
        if (key === null || prev === null || prev === undefined || key === prev) return;
        if (!byKey().has(key)) return;
        const open = new Set<number>(forced());
        for (const k of keys()) if (starts.get(k) === true) open.add(k);
        const plan = planReveal(key, { folded: folded(), open });
        if (plan.unfold) setUnfolded(true);
        if (plan.open) setForced(new Set([...forced(), key]));
        const place = () => {
          const section = letters?.querySelector<HTMLElement>(`[data-letter-key="${key}"]`);
          if (!section) return false;
          section.scrollIntoView({ block: "start" });
          return true;
        };
        requestAnimationFrame(() => {
          if (!place()) requestAnimationFrame(place);
        });
      },
      { defer: true },
    ),
  );

  return (
    <>
      {/* No card around the letters: a hairline between them is enough (ADR 0097). */}
      <div
        ref={letters}
        class="-mx-4 [&>[data-letter-key]:not(:first-child)]:border-t [&>[data-letter-key]]:border-hairline"
      >
        <For each={keys()}>
          {(key) => {
            const first = byKey().get(key) as ThreadMessage;
            return (
              <>
                <Show when={foldAt() === key ? run() : null}>
                  {(r) => (
                    <FoldRow
                      count={r().count}
                      range={range(r())}
                      onOpen={() => setUnfolded(true)}
                    />
                  )}
                </Show>
                <Show when={!folded().has(key)}>
                  <Letter
                    message={byKey().get(key) ?? first}
                    name={name}
                    fromName={fromName}
                    fromIsOwn={fromIsOwn}
                    accountMark={props.accountMark}
                    onFilter={props.onFilter}
                    backend={props.backend}
                    onLink={followLink}
                    onHoverLink={setHoverLink}
                    initiallyOpen={starts.get(key) === true}
                    forceOpen={forced().has(key)}
                  />
                </Show>
              </>
            );
          }}
        </For>
      </div>
      <Show when={hoverLink()}>
        {(href) => (
          <p class="pointer-events-none fixed right-3 bottom-3 z-20 max-w-[50vw] truncate rounded-[8px] bg-ink px-3 py-1 font-sans text-[12px] text-bg">
            {href()}
          </p>
        )}
      </Show>
      <Show when={warning()}>
        {(w) => (
          <div
            role="alertdialog"
            aria-label="This link goes somewhere else"
            class="fixed right-4 bottom-4 z-20 flex w-[380px] max-w-[80vw] flex-col gap-3 rounded-[12px] border border-hairline bg-bg p-4 shadow-xl"
          >
            <p class="text-[13px] leading-[1.45]">
              This link says <strong class="font-semibold">{w().shown}</strong> but goes to:
            </p>
            <p class="text-[13px] break-all text-late">{w().href}</p>
            <div class="flex justify-end gap-2">
              <button
                type="button"
                class={quietButton}
                onClick={() => {
                  openExternally(w().href);
                  setWarning(null);
                }}
              >
                Open anyway
              </button>
              <button
                type="button"
                class="h-[24px] cursor-default rounded-[8px] bg-ink px-3 text-[12px] font-semibold text-bg"
                ref={(el) => queueMicrotask(() => el.focus())}
                onClick={() => setWarning(null)}
              >
                Stay here
              </button>
            </div>
          </div>
        )}
      </Show>
    </>
  );
}

/**
 * The one permanent action (ADR 0044, rule 7): it names how many messages and puts the focus on
 * Cancel, so a stray Return keeps them. Escape cancels too.
 */
function ForeverDialog(props: { count: number; onCancel: () => void; onConfirm: () => void }) {
  let cancel!: HTMLButtonElement;
  let confirm!: HTMLButtonElement;
  function onKeyDown(e: KeyboardEvent) {
    // The dialog's keys are the dialog's: none reach the mail window's shortcuts.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      props.onCancel();
    } else if (e.key === "Tab") {
      // Two buttons, round and round: the focus never leaves the question.
      e.preventDefault();
      (document.activeElement === cancel ? confirm : cancel).focus();
    }
  }
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label="Delete forever"
      aria-describedby="forever-text"
      class="fixed right-4 bottom-4 z-30 flex w-[380px] max-w-[80vw] flex-col gap-3 rounded-[12px] border border-hairline bg-bg p-4 shadow-xl"
      onKeyDown={onKeyDown}
    >
      <p id="forever-text" class="text-[13px] leading-[1.45]">
        Delete{" "}
        <strong class="font-semibold">
          {props.count === 1 ? "1 message" : `${props.count} messages`}
        </strong>{" "}
        forever? {props.count === 1 ? "It is" : "They are"} removed from the server and cannot be
        brought back.
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
          Delete forever
        </button>
      </div>
    </div>
  );
}

/** The two filters a sender offers: only from them, or without them (ADR 0028). */
function SenderMenu(props: {
  person: Participant;
  label: string;
  at: { x: number; y: number };
  onFilter: (token: string) => void;
  close: (restoreFocus: boolean) => void;
}) {
  const pick = (exclude: boolean) => {
    const token = senderToken(props.person.address, exclude);
    props.close(true);
    if (token !== null) props.onFilter(token);
  };
  return (
    <PopMenu label={`${props.label} filters`} x={props.at.x} y={props.at.y} onClose={props.close}>
      <button type="button" role="menuitem" onClick={() => pick(false)}>
        <span>Only from </span>
        <span class="trunc">{props.label}</span>
      </button>
      <button type="button" role="menuitem" onClick={() => pick(true)}>
        <span>Exclude </span>
        <span class="trunc">{props.label}</span>
      </button>
    </PopMenu>
  );
}

/** Dragging over a name selects it; only a plain click on it opens its menu. */
function plainClick(e: MouseEvent & { currentTarget: HTMLElement }): boolean {
  const sel = window.getSelection();
  const button = e.currentTarget;
  return !(
    sel &&
    !sel.isCollapsed &&
    (button.contains(sel.anchorNode) || button.contains(sel.focusNode))
  );
}

/** The sender's name in a letter: a quiet button that offers to filter by, or without, them. */
function SenderName(props: {
  person: Participant;
  label: string;
  onFilter: (token: string) => void;
}) {
  const anchor = createMenuAnchor();
  return (
    <>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor.at() !== null}
        title={props.person.address}
        class="selectable max-w-[55%] cursor-default truncate rounded-[4px] font-semibold hover:bg-fill focus-visible:outline-1 focus-visible:outline-edge"
        onClick={(e) => {
          if (plainClick(e)) anchor.open(e.currentTarget);
        }}
      >
        {props.label}
      </button>
      <Show when={anchor.at()}>
        {(at) => (
          <SenderMenu
            person={props.person}
            label={props.label}
            at={at()}
            onFilter={props.onFilter}
            close={anchor.close}
          />
        )}
      </Show>
    </>
  );
}

/** One message of a thread: folded to a line, or open as a letter or as its sender laid it out. */
function Letter(props: {
  message: ThreadMessage;
  name: (p: Participant) => string;
  fromName: (m: ThreadMessage) => string;
  fromIsOwn: (m: ThreadMessage) => boolean;
  accountMark: (accountId: string) => AccountMark | undefined;
  onFilter: (token: string) => void;
  initiallyOpen: boolean;
  /** Match navigation asks for this letter to be open (ADR 0077). */
  forceOpen: boolean;
  backend: Backend;
  onLink: (link: MailLink) => void;
  onHoverLink: (href: string | null) => void;
}) {
  const [open, setOpen] = createSignal(props.initiallyOpen);
  createEffect(() => {
    if (props.forceOpen) setOpen(true);
  });
  const m = () => props.message;
  // Any message with HTML opens as sent; Text is one click away (ADR 0094).
  const [view, setView] = createSignal<"original" | "text">(
    props.message.htmlKind === undefined ? "text" : "original",
  );
  const recipients = () =>
    [
      m().to.map(props.name).join(", "),
      m().cc.length > 0 ? `Cc: ${m().cc.map(props.name).join(", ")}` : "",
    ]
      .filter((s) => s !== "")
      .join(" · ");
  // The sender as the badges read it: verified or failed only for someone else's message.
  const letterSender = (): Counterpart => ({
    person: m().from,
    role: props.fromIsOwn(m()) ? "self" : "sender",
    verified: m().senderAuth === "pass",
    failed: m().senderAuth === "fail",
  });
  // Once per letter: the sender does not change under it, and the mark only when the message is own.
  const who = personMark(m().from.address, m().from.name);
  const avatar = () => {
    const mark = props.fromIsOwn(m()) ? props.accountMark(m().accountId) : undefined;
    return (
      <Avatar
        initials={who.initials}
        tint={who.tint}
        {...(mark ? { own: { fill: mark.fill, ink: mark.ink } } : {})}
      />
    );
  };

  return (
    <Show
      when={open()}
      fallback={
        <button
          type="button"
          data-letter-key={m().key}
          aria-expanded="false"
          class={`${leadGrid} w-full cursor-default text-left text-[13px] hover:bg-soft focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-edge`}
          onClick={() => setOpen(true)}
        >
          {avatar()}
          <span class="truncate">
            <span class="font-medium">{props.fromName(m())}</span>
            <span class="ml-2 text-secondary">
              <HitText text={m().snippet} />
            </span>
          </span>
          <span class="text-[12px] text-secondary tabular-nums">{listDate(m().dateMs)}</span>
        </button>
      }
    >
      <section data-letter-key={m().key}>
        {/* The same grid as a folded row. A click on the row, not on a control in it, folds it. */}
        {/* biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard folds with the button in the row */}
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut for the button in the row */}
        <div
          class={`${leadGrid} text-[13px]`}
          onClick={(e) => {
            if (!(e.target as Element).closest("button, fieldset")) setOpen(false);
          }}
        >
          {avatar()}
          {/* The letter's own header (ADR 0099): who sent it and from where on the first line,
              whom it went to on the second. A click on the second line folds the letter. */}
          <div class="flex min-w-0 flex-col" data-letter-head>
            <div class="flex min-w-0 items-baseline gap-x-2">
              <Show
                when={
                  !props.fromIsOwn(m()) && senderToken(m().from.address, false) !== null
                    ? m().from
                    : null
                }
                fallback={
                  <span data-sender-name class="shrink-0 truncate text-[15px] font-semibold">
                    {props.fromName(m())}
                  </span>
                }
              >
                {(sender) => (
                  // `contents`: the name's own 55% cap reads against the line, not this wrapper.
                  <span data-sender-name class="contents text-[15px] font-semibold">
                    <SenderName
                      person={sender()}
                      label={props.fromName(m())}
                      onFilter={props.onFilter}
                    />
                  </span>
                )}
              </Show>
              <Show when={!props.fromIsOwn(m())}>
                <span class="selectable min-w-0 truncate text-[12px] text-secondary">
                  {m().from.address}
                </span>
              </Show>
              <Show when={failedBadge(letterSender())}>
                {(badge) => (
                  <span
                    data-sender-not-verified
                    title="The sender's domain did not confirm that it sent this mail. The name and the address may not be who they say."
                    class="flex shrink-0 items-center gap-1 self-center text-[12px] font-medium text-late"
                  >
                    <WarnIcon />
                    {badge()}
                  </span>
                )}
              </Show>
              <Show when={verifiedBadge(letterSender())}>
                {(badge) => (
                  <span
                    data-sender-verified
                    title={badge()}
                    class="flex shrink-0 items-center self-center text-good"
                  >
                    <ShieldCheckIcon />
                    <span class="sr-only">{badge()}</span>
                  </span>
                )}
              </Show>
            </div>
            <button
              type="button"
              aria-expanded="true"
              class="min-w-0 cursor-default truncate text-left text-[12px] text-secondary"
              onClick={() => setOpen(false)}
            >
              To: {recipients()}
            </button>
          </div>
          <div class="flex items-center gap-3">
            <Show when={m().htmlKind !== undefined}>
              <fieldset class="m-0 flex shrink-0 rounded-[8px] border-0 bg-fill p-0.5">
                <legend class="sr-only">View of this message</legend>
                <For each={["original", "text"] as const}>
                  {(option) => (
                    <button
                      type="button"
                      aria-pressed={view() === option}
                      class="h-[20px] cursor-default rounded-[8px] px-2 text-[11px] capitalize"
                      classList={{
                        "bg-bg font-medium shadow-[0_1px_2px_rgba(0,0,0,0.08)]": view() === option,
                        "text-secondary": view() !== option,
                      }}
                      onClick={() => setView(option)}
                    >
                      {option}
                    </button>
                  )}
                </For>
              </fieldset>
            </Show>
            <span class="text-[12px] text-secondary tabular-nums" title={fullDate(m().dateMs)}>
              {letterDate(m().dateMs)}
            </span>
          </div>
        </div>
        <div class="relative">
          <Show
            when={view() === "original" && m().htmlKind !== undefined}
            fallback={
              <div class={underRow}>
                <div class="max-w-[600px]">
                  <MessageBody text={m().bodyText} onLink={props.onLink} />
                </div>
              </div>
            }
          >
            <Original
              message={m()}
              backend={props.backend}
              onLink={props.onLink}
              onHoverLink={props.onHoverLink}
              onUnavailable={() => setView("text")}
            />
          </Show>
        </div>
        <ReceivedStrip message={m()} backend={props.backend} />
      </section>
    </Show>
  );
}

/** The message as sent, on white in both themes: its colors were chosen for white. */
const noticeButton =
  "inline-flex h-[24px] shrink-0 cursor-default items-center gap-1 whitespace-nowrap rounded-[8px] px-2 text-[12px] focus-visible:outline-1 focus-visible:outline-edge";
const noticePrimary = `${noticeButton} bg-button font-medium text-ink`;
const noticeSecondary = `${noticeButton} text-mid hover:bg-fill`;

/**
 * One line about a message's images: what is true on the left, what to do on the right. Without
 * room the actions drop below as a group, so no length of text squeezes either side.
 */
function ImageNotice(props: {
  icon: JSX.Element;
  text: string;
  tinted?: boolean;
  warn?: boolean;
  children: JSX.Element;
}) {
  return (
    <div
      class="flex flex-wrap items-center gap-x-4 gap-y-2 py-2 text-[12px]"
      classList={{ "rounded-[8px] bg-soft px-3": props.tinted === true }}
    >
      <div class="flex min-w-0 flex-[1_1_16rem] items-start gap-2 leading-[18px]">
        <span
          class="mt-0.5 shrink-0"
          classList={{ "text-late": props.warn === true, "text-secondary": props.warn !== true }}
        >
          {props.icon}
        </span>
        <span
          class="min-w-0 [overflow-wrap:anywhere]"
          classList={{ "text-mid": props.tinted === true, "text-secondary": props.tinted !== true }}
        >
          {props.text}
        </span>
      </div>
      <div class="ml-auto flex flex-wrap items-center justify-end gap-1">{props.children}</div>
    </div>
  );
}

function Original(props: {
  message: ThreadMessage;
  backend: Backend;
  onLink: (link: MailLink) => void;
  onHoverLink: (href: string | null) => void;
  onUnavailable: () => void;
}) {
  const [clean, setClean] = createSignal<CleanMail | null>(null);
  // The sender's theme first, recolored only when it says nothing (ADR 0085). Recoloring runs
  // once per message and theme, only in dark.
  const view = createMemo(() => {
    const c = clean();
    return c === null ? null : mailView(c, appDark());
  });
  // What the rules decide (ADR 0037). Until the backend answers, images stay off.
  const [choice, setChoice] = createSignal<ImageChoice | null>(null);
  // Level 1: the reader's choice for this message. It lasts while the message is open, is not
  // stored, and survives a rule changing under it.
  const [shown, setShown] = createSignal(false);
  const images = () => shown() || choice()?.show === true;
  const [failure, setFailure] = createSignal("");

  // Only the newest answer counts: a rule can change twice in a row.
  let asked = 0;
  function refresh(): Promise<void> {
    const mine = ++asked;
    return props.backend.getImageChoice(props.message.key).then(
      (next) => {
        if (mine === asked) setChoice(next);
      },
      () => {},
    );
  }

  onMount(() => {
    const mine = ++asked;
    props.backend.getMessageHtml(props.message.key).then(
      ({ html, images: decided }) => {
        if (html === null) props.onUnavailable();
        else {
          // Already in memory after the idle preload; the first message may wait for the chunk.
          void import("./mailHtml.ts").then(({ sanitizeMail }) => {
            setClean(sanitizeMail(html));
            if (mine === asked) setChoice(decided);
          });
        }
      },
      () => props.onUnavailable(),
    );
    // A rule or the setting changed, here or in the settings window.
    onCleanup(
      props.backend.onEvent((event) => {
        if (event.type === "imageRulesChanged") void refresh();
      }),
    );
  });

  async function remember(action: () => Promise<unknown>) {
    setFailure("");
    try {
      await action();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "That did not work.");
    }
    await refresh();
  }

  const always = async (scope: "address" | "domain", value: string) => {
    // At once, without waiting for the rule; then the rule carries it, so removing it takes effect.
    setShown(true);
    await remember(() => props.backend.setImageRule({ scope, value, decision: "allow" }));
    if (choice()?.show) setShown(false);
  };

  const alwaysMenu = createMenuAnchor();

  const bar = (c: ImageChoice) => {
    const kind = barKind(c);
    const domain = () => (kind === "denied" ? null : c.offerDomain);
    const pick = (scope: "address" | "domain", value: string) => {
      alwaysMenu.close(false);
      void always(scope, value);
    };
    return (
      <ImageNotice
        tinted
        icon={<ImageOffIcon />}
        warn={kind === "unverified"}
        text={
          kind === "denied"
            ? imageCopy.denied((c.source === "domain-deny" ? c.domain : null) ?? c.address)
            : kind === "unverified"
              ? imageCopy.unverified
              : imageCopy.off
        }
      >
        <Show when={c.offerAddress}>
          <button
            type="button"
            class={noticeSecondary}
            aria-haspopup="menu"
            aria-expanded={alwaysMenu.at() !== null}
            onClick={(e) => alwaysMenu.open(e.currentTarget)}
          >
            {imageCopy.always}
            <ChevronDownIcon />
          </button>
          <Show when={alwaysMenu.at()}>
            {(at) => (
              <PopMenu
                label={imageCopy.alwaysMenu}
                x={at().x}
                y={at().y}
                onClose={alwaysMenu.close}
              >
                <button
                  type="button"
                  role="menuitem"
                  class="whole"
                  onClick={() => pick("address", c.address)}
                >
                  {imageCopy.fromAddress(c.address)}
                </button>
                <Show when={domain()}>
                  {(d) => (
                    <button
                      type="button"
                      role="menuitem"
                      class="whole"
                      onClick={() => pick("domain", d())}
                    >
                      {imageCopy.fromDomain(d())}
                    </button>
                  )}
                </Show>
              </PopMenu>
            )}
          </Show>
        </Show>
        <button type="button" class={noticePrimary} onClick={() => setShown(true)}>
          {imageCopy.show}
        </button>
      </ImageNotice>
    );
  };

  const stopBar = (c: ImageChoice, source: StoppableSource) => (
    <ImageNotice
      icon={<ImageIcon />}
      text={
        source === "always"
          ? imageCopy.onForEveryone
          : imageCopy.onFor((source === "domain-allow" ? c.domain : null) ?? c.address)
      }
    >
      <button
        type="button"
        class={noticeSecondary}
        onClick={() => {
          // The reader asked for them off: the choice for this message goes with the rule.
          setShown(false);
          void remember(() => props.backend.stopImages(c.address, source));
        }}
      >
        {source === "always" ? imageCopy.turnOffForSender : imageCopy.turnOff}
      </button>
    </ImageNotice>
  );

  return (
    // The message as sent takes the whole width: its own layout has margins (ADR 0097).
    <div class="flex flex-col gap-3 px-4 pt-1 pb-4">
      <Show when={clean()?.hasRemoteContent ? choice() : null}>
        {(c) => (
          <>
            <Show when={!images()}>{bar(c())}</Show>
            <Show when={allowingSource(c())}>{(source) => stopBar(c(), source())}</Show>
            <Show when={failure() !== ""}>
              <p role="alert" class="m-0 text-[12px] text-late">
                {failure()}
              </p>
            </Show>
          </>
        )}
      </Show>
      <div class="overflow-hidden rounded-[8px]">
        <Show when={view()} fallback={<div class="h-60 bg-(--bg)" />}>
          {(v) => (
            // Allowing images loads another page with a looser policy, so the frame is remade.
            <Show
              when={images()}
              keyed
              fallback={
                <MailFrame
                  html={v().html}
                  scheme={v().scheme}
                  images={false}
                  onLink={props.onLink}
                  onHoverLink={props.onHoverLink}
                />
              }
            >
              <MailFrame
                html={v().html}
                scheme={v().scheme}
                images={true}
                onLink={props.onLink}
                onHoverLink={props.onHoverLink}
              />
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}

function MessageBody(props: { text: string; onLink: (link: MailLink) => void }) {
  const segments = createMemo(() => splitBody(props.text));
  return (
    <div data-body class="font-serif text-[15px] leading-[1.6]">
      <Show when={segments().length > 0} fallback={<p class="text-secondary">No text.</p>}>
        <For each={segments()}>
          {(s) => (
            <Show when={s.quoted} fallback={<Plain text={s.text} onLink={props.onLink} />}>
              <Fold
                text={s.text}
                open="Hide quoted text"
                closed={`Show quoted text · ${s.lines} lines`}
                onLink={props.onLink}
              />
            </Show>
          )}
        </For>
      </Show>
    </div>
  );
}

function Linked(props: { text: string; onLink: (link: MailLink) => void; nav?: boolean }) {
  return (
    <For each={linkify(props.text)}>
      {(part) => (
        <Show
          when={part.href}
          fallback={<HitText text={part.text} {...(props.nav ? { nav: true } : {})} />}
        >
          {(href) => (
            <a
              href={href()}
              class="break-all text-ink underline decoration-edge underline-offset-2 hover:decoration-ink"
              onClick={(e) => {
                e.preventDefault();
                props.onLink({ text: part.text, href: href() });
              }}
            >
              <HitText text={part.text} {...(props.nav ? { nav: true } : {})} />
            </a>
          )}
        </Show>
      )}
    </For>
  );
}

/** Words as written; a signature sits quietly below them and folds away when it is long. */
function Plain(props: { text: string; onLink: (link: MailLink) => void }) {
  const split = createMemo(() => splitSignature(props.text));
  return (
    <>
      <div class="break-words whitespace-pre-wrap">
        <Linked text={split().body} onLink={props.onLink} nav />
      </div>
      <Show when={split().signature}>
        {(signature) => (
          <Show
            when={split().lines > SHORT_SIGNATURE_LINES}
            fallback={
              <div class="mt-3 font-sans text-[12px] break-words whitespace-pre-wrap text-secondary">
                <Linked text={signature()} onLink={props.onLink} nav />
              </div>
            }
          >
            <Fold
              text={signature()}
              open="Hide signature"
              closed="Show signature"
              onLink={props.onLink}
            />
          </Show>
        )}
      </Show>
    </>
  );
}

/** Quoted replies and long signatures are folded until asked for, and not rendered while folded. */
function Fold(props: {
  text: string;
  open: string;
  closed: string;
  onLink: (link: MailLink) => void;
}) {
  const [open, setOpen] = createSignal(false);
  return (
    <div class="my-2">
      <button
        type="button"
        aria-expanded={open()}
        class="cursor-default rounded-[8px] bg-fill px-2 py-1 font-sans text-[11px] text-secondary hover:bg-button"
        onClick={() => setOpen(!open())}
      >
        {open() ? props.open : props.closed}
      </button>
      <Show when={open()}>
        <div class="mt-2 border-l border-hairline pl-3 break-words whitespace-pre-wrap text-secondary">
          <Linked text={props.text} onLink={props.onLink} />
        </div>
      </Show>
    </div>
  );
}
