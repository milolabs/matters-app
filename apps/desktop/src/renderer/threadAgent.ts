// The agent in an ordinary thread (ADR 0063). Nothing is made ahead for ordinary mail: this store
// shows what the agent already has for the open thread (its reading and prepared work, a local read
// that spends nothing) and asks for a turn only when the person does. What it shows is whatever the
// backend holds for the thread as it stands now, so a new message makes old work disappear by
// itself. It does not depend on a mounted component, and it uses no effects of its own: `sync` is
// called when the open thread or its last message may have changed.
import type { PreparedWork, ThreadAgentView } from "@matters/core";
import { createSignal } from "solid-js";
import type { AgentStore } from "./agent.ts";
import { COALESCE_MS } from "./agent.ts";
import type { Backend } from "./client.ts";

/** The thread the person has open, as the thread view knows it. */
export interface OpenThreadRef {
  readonly id: string;
  /** What the thread's last message is now; work is kept for exactly this. */
  readonly lastMessageKey: number;
  /** For the closing line when nothing else names the thread. */
  readonly subject?: string;
}

export interface ThreadAgentOptions {
  readonly backend: Pick<Backend, "agentThread" | "onEvent">;
  readonly agent: Pick<
    AgentStore,
    "prepare" | "send" | "editMyself" | "busy" | "problem" | "chooseDirection" | "directionOf"
  >;
  /** The open thread; null while none is open. Read on every `sync`, never cached. */
  readonly open: () => OpenThreadRef | null;
  /** Runs `run` after `ms`; returns the cancel. Tests inject one they control. */
  readonly schedule?: (run: () => void, ms: number) => () => void;
}

const realSchedule = (run: () => void, ms: number) => {
  const timer = setTimeout(run, ms);
  return () => clearTimeout(timer);
};

const NO_FACTS: ThreadAgentView["facts"] = [];

/** What a read answered, and for which thread at which last message. */
interface Loaded {
  readonly threadId: string;
  readonly lastMessageKey: number;
  readonly view: ThreadAgentView;
}

export function createThreadAgent(options: ThreadAgentOptions) {
  const { backend, agent, open } = options;
  const schedule = options.schedule ?? realSchedule;

  const [loaded, setLoaded] = createSignal<Loaded | null>(null);
  // The thread (and its last message) whose work the person sent, took over or dismissed. While the
  // thread's last message is still that one, its work is not shown and the offer shows instead.
  const [gone, setGone] = createSignal<ReadonlyMap<string, number>>(new Map());
  let seq = 0;
  let cancelTimer: (() => void) | null = null;

  /** What was loaded, when it is of the open thread as it stands; never another thread's. */
  function current(): Loaded | null {
    const thread = open();
    const l = loaded();
    if (thread === null || l === null) return null;
    return l.threadId === thread.id && l.lastMessageKey === thread.lastMessageKey ? l : null;
  }

  /** Reads the open thread again. An answer that is not for the latest question is dropped. */
  async function load(): Promise<void> {
    const thread = open();
    const mine = ++seq;
    if (thread === null) return;
    try {
      const view = await backend.agentThread(thread.id);
      if (mine !== seq) return;
      setLoaded({ threadId: thread.id, lastMessageKey: thread.lastMessageKey, view });
    } catch {
      // What is on screen stays: a failed local read must not take work away.
    }
  }

  let seen: { id: string; key: number } | null = null;

  /** The open thread or its last message may have changed: ask for what the agent has for it. */
  function sync(): void {
    const thread = open();
    if (thread === null) {
      seen = null;
      seq++;
      return;
    }
    if (seen?.id === thread.id && seen.key === thread.lastMessageKey) return;
    seen = { id: thread.id, key: thread.lastMessageKey };
    void load();
  }

  // A push carries no data: ask again once things have been quiet for a moment.
  const unsubscribe = backend.onEvent((event) => {
    if (event.type !== "agentChanged" || cancelTimer !== null) return;
    cancelTimer = schedule(() => {
      cancelTimer = null;
      if (open() !== null) void load();
    }, COALESCE_MS);
  });

  const isGone = (thread: OpenThreadRef) => gone().get(thread.id) === thread.lastMessageKey;

  function markGone(thread: OpenThreadRef): void {
    setGone((m) => new Map(m).set(thread.id, thread.lastMessageKey));
  }

  /** The work to draw, when there is any and the person has not dealt with it. */
  function prepared(): PreparedWork | null {
    const thread = open();
    const l = current();
    if (thread === null || l === null || isGone(thread)) return null;
    return l.view.prepared;
  }

  /** The person asks for a reply here. Spends one turn; nothing else in this store does. */
  async function ask(words?: string, direction?: string): Promise<void> {
    const thread = open();
    if (thread === null) return;
    const typed = (words ?? "").trim();
    const reading = current()?.view.reading;
    const result = await agent.prepare(
      thread.id,
      typed === "" && direction === undefined
        ? undefined
        : {
            ...(direction === undefined ? {} : { direction }),
            ...(typed === "" ? {} : { answer: typed }),
          },
      reading?.headline ?? thread.subject ?? "",
    );
    // Work that was set aside shows again only if this ask made new work; a failure or a closing
    // leaves the offer as it was. The backend's store is the truth, so it is read again either way.
    if (result !== null && result.kind !== "closed") {
      setGone((m) => {
        if (m.get(thread.id) !== thread.lastMessageKey) return m;
        const next = new Map(m);
        next.delete(thread.id);
        return next;
      });
    }
    await load();
  }

  /** Sends the draft shown, by the same path as in Matters. */
  async function send(): Promise<"sent" | "openedExisting" | "failed" | "none"> {
    const thread = open();
    const work = prepared();
    if (thread === null || work?.kind !== "draft") return "none";
    const outcome = await agent.send({ threadId: thread.id }, work.body);
    if (outcome === "sent") markGone(thread);
    return outcome;
  }

  /** `Edit myself`: the draft in the composer, where it is the person's. */
  async function editMyself(): Promise<"took" | "existing" | "failed" | "none"> {
    const thread = open();
    const work = prepared();
    if (thread === null || work?.kind !== "draft") return "none";
    const outcome = await agent.editMyself({ threadId: thread.id }, work.body);
    if (outcome === "took") markGone(thread);
    return outcome;
  }

  /** New work was made for this thread by the talk: a mark that set the old work aside goes. */
  function reveal(threadId: string): void {
    setGone((m) => {
      if (!m.has(threadId)) return m;
      const next = new Map(m);
      next.delete(threadId);
      return next;
    });
  }

  /** `Dismiss`: this window stops showing the work. It is not feedback and tells nobody anything. */
  function dismiss(): void {
    const thread = open();
    if (thread !== null) markGone(thread);
  }

  /** A digit key on a question: picks that way forward. Returns whether it picked one. */
  function pickDirection(digit: string): boolean {
    const thread = open();
    const work = prepared();
    if (thread === null || work?.kind !== "needs" || !/^[1-9]$/.test(digit)) return false;
    const direction = work.directions[Number(digit) - 1];
    if (direction === undefined) return false;
    agent.chooseDirection(thread.id, direction);
    return true;
  }

  return {
    sync,
    /** Reads again now, for the open thread. */
    refresh: load,
    /** The backend has answered for the open thread as it stands, so `available` means something. */
    known: (): boolean => current() !== null,
    /** The agent can be asked here: AI is on and the thread's account agreed. */
    available: (): boolean => current()?.view.available === true,
    /** What the agent read of the thread, when it is current and shown. */
    reading: (): ThreadAgentView["reading"] => current()?.view.reading ?? null,
    /** The reading's promises and asks with their quotes; empty when no reading is shown. */
    facts: (): ThreadAgentView["facts"] => current()?.view.facts ?? NO_FACTS,
    prepared,
    /** The draft shown, when it is ready to go. */
    readyDraft: (): string | null => {
      const thread = open();
      const work = prepared();
      return thread === null || work?.kind !== "draft" || agent.busy(thread.id) ? null : work.body;
    },
    busy: (): boolean => {
      const thread = open();
      return thread !== null && agent.busy(thread.id);
    },
    problem: (): string => {
      const thread = open();
      return thread === null ? "" : agent.problem(thread.id);
    },
    ask,
    send,
    editMyself,
    dismiss,
    reveal,
    pickDirection,
    dispose(): void {
      cancelTimer?.();
      cancelTimer = null;
      unsubscribe();
    },
  };
}

export type ThreadAgentStore = ReturnType<typeof createThreadAgent>;
