import type {
  AddInstructionInput,
  AddRuleInput,
  AgentInstruction,
  AgentRule,
  AgentStatus,
  FeedbackJournalEntry,
  InstructionJournalEntry,
  JournalEntry,
  PrepareResult,
  RememberResult,
  RuleJournalEntry,
  RuleOffer,
} from "@matters/core";
import { everyKindOn } from "@matters/core";
import { createRoot } from "solid-js";
import { describe, expect, it } from "vitest";
import {
  COALESCE_MS,
  createAgentStore,
  createInstructions,
  createJournal,
  createRules,
  FEEDBACK_UNDO_MS,
  JOURNAL_SHOWN,
  STATUS_AGE_MS,
} from "../src/renderer/agent.ts";
import type { Backend } from "../src/renderer/client.ts";
import { BackendError } from "../src/renderer/client.ts";

const NOW = Date.UTC(2026, 10, 5, 10, 42);
const models = { understand: "haiku", write: "sonnet", answer: "sonnet", titles: "haiku" };
const status = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  settings: {
    enabled: true,
    kindRuntime: everyKindOn("claude-code"),
    models,
    efforts: { understand: "low", write: "default", answer: "default", titles: "low" },
    weekSharePercent: 10,
    plans: {
      "claude-code": {
        usedByUsPercent: 4.2,
        limits: {
          session: { usedPercent: 39, resetsAtMs: NOW + 3_600_000 },
          week: { usedPercent: 22, resetsAtMs: NOW + 3 * 86_400_000 },
          usingOverage: false,
          seenAtMs: NOW - 60_000,
        },
      },
    },
  },
  runtimes: [
    {
      id: "claude-code",
      name: "Claude Code",
      info: {
        id: "claude-code",
        name: "Claude Code",
        status: "ready",
        models: ["haiku", "sonnet"],
      },
    },
  ],
  unlisted: [],
  consents: [],
  progress: { state: "idle" },
  ledger: [],
  ...over,
});

const journalEntry = (over: Partial<FeedbackJournalEntry> = {}): FeedbackJournalEntry => ({
  id: 1,
  atMs: NOW - 60_000,
  action: "notImportant",
  actor: "person",
  threadId: "t1",
  lastMessageKey: 10,
  senderAddress: "anna@northwind.example",
  ...over,
});

const ruleEntry = (over: Partial<RuleJournalEntry> = {}): RuleJournalEntry => ({
  id: 1,
  atMs: NOW - 60_000,
  action: "ruleAdded",
  actor: "person",
  ruleId: 1,
  scope: "sender",
  subject: "alerts@x.com",
  ...over,
});

const instructionEntry = (
  over: Partial<InstructionJournalEntry> = {},
): InstructionJournalEntry => ({
  id: 1,
  atMs: NOW - 60_000,
  action: "instructionAdded",
  actor: "person",
  instructionId: 1,
  scope: "write",
  text: "Write briefly",
  ...over,
});

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("the instructions page", () => {
  const kept = (id: number, scope: AgentInstruction["scope"], text: string): AgentInstruction => ({
    id,
    scope,
    text,
    actor: "person",
    atMs: NOW,
  });

  function instructions(initial: AgentInstruction[], refusal = "") {
    let current = initial;
    const calls: string[] = [];
    const store = createInstructions({
      agentInstructions: async () => current,
      agentAddInstruction: async (input: AddInstructionInput) => {
        calls.push(`add:${JSON.stringify(input)}`);
        if (refusal !== "") throw new BackendError("invalidRequest", refusal);
        current = [...current, kept(current.length + 1, input.scope, input.text)];
        return current[current.length - 1];
      },
      agentRemoveInstruction: async (id: number) => {
        calls.push(`remove:${id}`);
        current = current.filter((i) => i.id !== id);
      },
    } as unknown as Backend);
    return { store, calls };
  }

  it("reads the instructions, adds one by scope, and removes one", () =>
    createRoot(async (dispose) => {
      const { store, calls } = instructions([kept(1, "general", "Answer in Polish")]);
      await store.load();
      expect(store.loaded()).toBe(true);
      expect(store.instructions().map((i) => i.text)).toEqual(["Answer in Polish"]);
      expect(await store.add({ scope: "write", text: "No formulas" })).toBe(true);
      expect(store.instructions().map((i) => i.scope)).toEqual(["general", "write"]);
      expect(await store.remove(kept(1, "general", "Answer in Polish"))).toBe(true);
      expect(store.instructions().map((i) => i.text)).toEqual(["No formulas"]);
      expect(calls).toEqual(['add:{"scope":"write","text":"No formulas"}', "remove:1"]);
      dispose();
    }));

  it("shows the backend's sentence for a text it refuses, and keeps the list", () =>
    createRoot(async (dispose) => {
      const { store } = instructions([kept(1, "general", "x")], "Write the instruction first.");
      await store.load();
      expect(await store.add({ scope: "general", text: " " })).toBe(false);
      expect(store.problem()).toBe("Write the instruction first.");
      expect(store.instructions()).toHaveLength(1);
      dispose();
    }));
});

describe("the rules page", () => {
  const rule = (id: number, scope: AgentRule["scope"], subject: string): AgentRule => ({
    id,
    scope,
    subject,
    action: "noReply",
    actor: "person",
    atMs: NOW,
  });

  function rules(initial: AgentRule[], refusal = "") {
    let current = initial;
    const calls: string[] = [];
    const store = createRules({
      agentRules: async () => current,
      agentAddRule: async (input: AddRuleInput) => {
        calls.push(`add:${JSON.stringify(input)}`);
        if (refusal !== "") throw new BackendError("invalidRequest", refusal);
        const subject = "subject" in input ? input.subject : "";
        current = [...current, rule(current.length + 1, input.scope, subject)];
        return current[current.length - 1];
      },
      agentRemoveRule: async (id: number) => {
        calls.push(`remove:${id}`);
        current = current.filter((r) => r.id !== id);
      },
    } as unknown as Backend);
    return { store, calls };
  }

  it("reads the rules, and an address is a sender while anything else is a domain", () =>
    createRoot(async (dispose) => {
      const { store, calls } = rules([rule(1, "sender", "a@x.com")]);
      await store.load();
      expect(store.rules().map((r) => r.subject)).toEqual(["a@x.com"]);
      expect(await store.add("b@y.com")).toBe(true);
      expect(await store.add("@z.com")).toBe(true);
      expect(await store.add("w.com")).toBe(true);
      expect(calls).toEqual([
        'add:{"scope":"sender","subject":"b@y.com"}',
        'add:{"scope":"domain","subject":"@z.com"}',
        'add:{"scope":"domain","subject":"w.com"}',
      ]);
      expect(store.rules()).toHaveLength(4);
      dispose();
    }));

  it("shows the backend's sentence for a value it refuses, and keeps the rules", () =>
    createRoot(async (dispose) => {
      const { store } = rules([rule(1, "sender", "a@x.com")], "That is not a domain.");
      await store.load();
      expect(await store.add("nope")).toBe(false);
      expect(store.problem()).toBe("That is not a domain.");
      expect(store.rules()).toHaveLength(1);
      dispose();
    }));

  it("removes a rule and toggles the type rule", () =>
    createRoot(async (dispose) => {
      const { store, calls } = rules([rule(1, "sender", "a@x.com")]);
      await store.load();
      expect(store.programLike()).toBe(false);
      await store.toggleProgramLike();
      expect(store.programLike()).toBe(true);
      await store.toggleProgramLike();
      expect(store.programLike()).toBe(false);
      await store.remove(rule(1, "sender", "a@x.com"));
      expect(store.rules()).toEqual([]);
      expect(calls).toEqual([
        'add:{"scope":"type","subject":"programLike"}',
        "remove:2",
        "remove:1",
      ]);
      dispose();
    }));
});

describe("the journal page (ADR 0054, rule 6)", () => {
  it("undoes an instruction from the journal, by its own id", () =>
    createRoot(async (dispose) => {
      const entry = instructionEntry({ id: 4, instructionId: 7, actor: "agent" });
      let entries: JournalEntry[] = [entry];
      const calls: string[] = [];
      const journal = createJournal(
        {
          agentJournal: async () => entries,
          agentRemoveInstruction: async (id: number) => {
            calls.push(`removeInstruction:${id}`);
            entries = [{ ...entry, undoneAtMs: NOW }];
          },
        } as unknown as Backend,
        () => NOW,
      );
      await journal.load();
      expect(await journal.undo(entry)).toBe(true);
      expect(calls).toEqual(["removeInstruction:7"]);
      expect(journal.lines()[0]).toMatchObject({ undone: true, undoable: false });
      dispose();
    }));

  it("undoes from the journal, and reads it again to show the line as undone", () =>
    createRoot(async (dispose) => {
      const entry = journalEntry({ id: 1, threadId: "t1", action: "closed", actor: "agent" });
      let entries: JournalEntry[] = [entry];
      const calls: string[] = [];
      const journal = createJournal(
        {
          agentJournal: async (limit: number) => {
            calls.push(`journal:${limit}`);
            return entries;
          },
          agentUndoFeedback: async (threadId: string, kind: string) => {
            calls.push(`undo:${threadId}:${kind}`);
            entries = [{ ...entry, undoneAtMs: NOW }];
          },
        } as unknown as Backend,
        () => NOW,
      );
      await journal.load();
      expect(calls).toEqual([`journal:${JOURNAL_SHOWN}`]);
      expect(journal.lines()[0]?.undoable).toBe(true);
      expect(await journal.undo(entry)).toBe(true);
      expect(calls).toContain("undo:t1:closed");
      expect(journal.lines()[0]).toMatchObject({ undone: true, undoable: false });
      dispose();
    }));

  it("undoes a rule line by removing the rule, and shows the line as undone", () =>
    createRoot(async (dispose) => {
      const entry: JournalEntry = ruleEntry({ id: 4, ruleId: 9 });
      let entries: JournalEntry[] = [entry];
      const calls: string[] = [];
      const journal = createJournal(
        {
          agentJournal: async () => entries,
          agentRemoveRule: async (id: number) => {
            calls.push(`remove:${id}`);
            entries = [{ ...entry, undoneAtMs: NOW }];
          },
          agentUndoFeedback: async () => {
            calls.push("undoFeedback");
          },
        } as unknown as Backend,
        () => NOW,
      );
      await journal.load();
      expect(journal.lines()[0]?.undoable).toBe(true);
      expect(await journal.undo(entry)).toBe(true);
      expect(calls).toEqual(["remove:9"]);
      expect(journal.lines()[0]).toMatchObject({ undone: true, undoable: false });
      dispose();
    }));

  it("keeps the journal as it was when the backend refuses the undo", () =>
    createRoot(async (dispose) => {
      const entry = journalEntry({ id: 1 });
      const journal = createJournal(
        {
          agentJournal: async () => [entry],
          agentUndoFeedback: async () => {
            throw new Error("no");
          },
        } as unknown as Backend,
        () => NOW,
      );
      await journal.load();
      expect(await journal.undo(entry)).toBe(false);
      expect(journal.lines()[0]?.undoable).toBe(true);
      dispose();
    }));
});

describe("the agent store", () => {
  function rig() {
    const calls: string[] = [];
    const listeners: ((e: { type: string }) => void)[] = [];
    let timers: (() => void)[] = [];
    const opened: string[] = [];
    let existing = false;
    let prepared: PrepareResult = { kind: "draft", body: "B", nudge: false };
    let offer: RuleOffer | null = null;
    let ruleFails = false;
    const rememberCalls: string[] = [];
    let remembered: RememberResult = { items: [] };
    let rememberFails = false;
    let rememberGate: Promise<void> = Promise.resolve();
    let statusGate: Promise<void> = Promise.resolve();
    const ruleCalls: string[] = [];
    let shownStatus = status();
    const backend = {
      agentStatus: async () => {
        calls.push("status");
        // What the backend says when the read is asked, answered when the gate opens; a new
        // object each time, as a read across the bridge is.
        const asked = { ...shownStatus };
        await statusGate;
        return asked;
      },
      agentPauseReading: async () => {
        calls.push("pause");
        return shownStatus;
      },
      agentResumeReading: async () => {
        calls.push("resume");
        return shownStatus;
      },
      agentUndoFeedback: async (id: string, kind: string) => {
        calls.push(`undo:${id}:${kind}`);
      },
      agentRuleOffer: async (id: string) => {
        ruleCalls.push(`offer:${id}`);
        return offer;
      },
      agentAddRule: async (input: AddRuleInput) => {
        ruleCalls.push(`add:${JSON.stringify(input)}`);
        if (ruleFails) throw new Error("That is one of your own addresses.");
        return { id: 7, scope: "sender", subject: "anna@northwind.example" };
      },
      agentDraftFromPrepared: async (id: string, body: string) => {
        calls.push(`draft:${id}:${body}`);
        return { draftId: "d1", existing };
      },
      requestSend: async (id: string) => {
        calls.push(`requestSend:${id}`);
        return {};
      },
      agentPrepare: async () => prepared,
      agentRemember: async (id: string, words: string) => {
        rememberCalls.push(`remember:${id}:${words}`);
        await rememberGate;
        if (rememberFails) throw new Error("boom");
        return remembered;
      },
      agentRemoveInstruction: async (id: number) => {
        rememberCalls.push(`removeInstruction:${id}`);
      },
      agentRemoveRule: async (id: number) => {
        rememberCalls.push(`removeRule:${id}`);
      },
      onEvent: (l: (e: { type: string }) => void) => {
        listeners.push(l);
        return () => {};
      },
    } as unknown as Backend;
    const store = createAgentStore(backend, {
      openDraft: async (id) => {
        opened.push(id);
      },
      now: () => NOW,
      schedule: (run) => {
        timers.push(run);
        return () => {
          timers = timers.filter((t) => t !== run);
        };
      },
    });
    return {
      store,
      calls,
      opened,
      setPrepared: (next: PrepareResult) => {
        prepared = next;
      },
      setExisting: (v: boolean) => {
        existing = v;
      },
      ruleCalls,
      rememberCalls,
      setRemembered: (next: RememberResult) => {
        remembered = next;
      },
      failRemember: (v: boolean) => {
        rememberFails = v;
      },
      /** Holds the answer of the turn that remembers until the returned function is called. */
      holdRemember: () => {
        let open: () => void = () => {};
        rememberGate = new Promise<void>((resolve) => {
          open = resolve;
        });
        return open;
      },
      /** Holds the answers of status reads asked from now until the returned function runs. */
      holdStatus: () => {
        let open: () => void = () => {};
        statusGate = new Promise<void>((resolve) => {
          open = () => {
            statusGate = Promise.resolve();
            resolve();
          };
        });
        return open;
      },
      setOffer: (next: RuleOffer | null) => {
        offer = next;
      },
      failRules: (v: boolean) => {
        ruleFails = v;
      },
      setShownStatus: (next: AgentStatus) => {
        shownStatus = next;
      },
      fire: () => {
        const t = timers;
        timers = [];
        for (const r of t) r();
      },
      /** A push; `status` is the backend saying the status itself changed (ADR 0115). */
      emit: (hint: { status?: true } = {}) => {
        for (const l of listeners) l({ type: "agentChanged", ...hint });
      },
      pending: () => timers.length,
    };
  }

  it("loads the status, and AI is on", () =>
    createRoot(async (dispose) => {
      const r = rig();
      expect(r.store.loaded()).toBe(false);
      await r.store.start();
      expect(r.store.loaded()).toBe(true);
      expect(r.store.enabled()).toBe(true);
      expect(r.calls).toEqual(["status"]);
      dispose();
    }));

  it("coalesces pushes into one refetch, and reads a fresh status only once it ages out", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.calls.length = 0;
      r.emit();
      r.emit();
      r.emit();
      expect(r.pending()).toBe(1);
      expect(COALESCE_MS).toBeGreaterThan(0);
      r.fire();
      await flush();
      // The status was read a moment ago: it waits until it is old enough.
      expect(r.calls).toEqual([]);
      expect(r.pending()).toBe(1);
      r.fire();
      await flush();
      expect(r.calls).toEqual(["status"]);
      // A push that says the status changed is read at once (ADR 0115).
      r.calls.length = 0;
      r.emit({ status: true });
      r.fire();
      await flush();
      expect(r.calls).toEqual(["status"]);
      expect(r.pending()).toBe(0);
      dispose();
    }));

  // The status was read a moment ago (here: always, the clock stands still), and then another
  // window or the reading changed it (ADR 0115).
  const off = (s: AgentStatus): AgentStatus => ({
    ...s,
    settings: { ...s.settings, enabled: false },
    progress: { state: "off", reason: "disabled" },
  });

  it("turns AI on when another window did, however fresh its status was", () =>
    createRoot(async (dispose) => {
      const r = rig();
      r.setShownStatus(off(status()));
      await r.store.start();
      expect(r.store.enabled()).toBe(false);
      // Settings turned AI on: the worker's own push, then the one that says the status changed.
      r.setShownStatus(status());
      r.emit();
      r.emit({ status: true });
      r.fire();
      await flush();
      expect(r.store.enabled()).toBe(true);
      dispose();
    }));

  it("keeps a status read asked for while a refresh runs", () =>
    createRoot(async (dispose) => {
      const r = rig();
      r.setShownStatus(off(status()));
      await r.store.start();
      const open = r.holdStatus();
      r.emit({ status: true });
      r.fire();
      await flush();
      // The first refresh waits for a read that still says off; AI is turned on meanwhile.
      r.setShownStatus(status());
      r.emit({ status: true });
      r.fire();
      open();
      await flush();
      await flush();
      expect(r.store.enabled()).toBe(true);
      dispose();
    }));

  it("brings what another window changed: AI off, consent withdrawn, pause, continue", () =>
    createRoot(async (dispose) => {
      const r = rig();
      const on = status({
        consents: [{ accountId: "a", runtimeId: "claude-code", grantedAtMs: NOW }],
      });
      r.setShownStatus(on);
      await r.store.start();
      const steps: [AgentStatus, (s: AgentStatus | null) => unknown, unknown][] = [
        [{ ...on, consents: [] }, (s) => s?.consents.length, 0],
        [
          {
            ...on,
            consents: [],
            progress: { state: "paused", reason: "pausedByPerson" },
          },
          (s) => s?.progress.reason,
          "pausedByPerson",
        ],
        [
          { ...on, consents: [], progress: { state: "reading" } },
          (s) => s?.progress.state,
          "reading",
        ],
        [off(on), (s) => s?.settings.enabled, false],
      ];
      for (const [next, look, want] of steps) {
        r.setShownStatus(next);
        r.emit({ status: true });
        r.fire();
        await flush();
        expect(look(r.store.status())).toEqual(want);
      }
      expect(r.store.enabled()).toBe(false);
      dispose();
    }));

  it("reads a status a push skipped once it ages out: the plan's limit, a reading's end", () =>
    createRoot(async (dispose) => {
      const r = rig();
      r.setShownStatus(status({ progress: { state: "reading" } }));
      await r.store.start();
      r.calls.length = 0;
      // The reading stops at the plan's limit; its push carries no word about the status.
      r.setShownStatus(status({ progress: { state: "paused", reason: "limit" } }));
      r.emit();
      r.fire();
      await flush();
      expect(r.calls).toEqual([]);
      expect(r.store.status()?.progress.state).toBe("reading");
      // No further push comes; the status is read when it is old enough all the same.
      expect(r.pending()).toBe(1);
      r.fire();
      await flush();
      expect(r.calls).toEqual(["status"]);
      expect(r.store.status()?.progress.reason).toBe("limit");
      dispose();
    }));

  it("reads the status of a long reading once per STATUS_AGE_MS", () =>
    createRoot(async (dispose) => {
      let clock = NOW;
      let timers: { at: number; run: () => void }[] = [];
      const listeners: ((e: { type: string; status?: true }) => void)[] = [];
      let reads = 0;
      let done = 0;
      const backend = {
        agentStatus: async () => {
          reads += 1;
          return status({ progress: { state: "reading", untilMs: done } });
        },
        onEvent: (l: (e: { type: string }) => void) => {
          listeners.push(l);
          return () => {};
        },
      } as unknown as Backend;
      const store = createAgentStore(backend, {
        openDraft: async () => {},
        now: () => clock,
        schedule: (run, ms) => {
          const timer = { at: clock + ms, run };
          timers.push(timer);
          return () => {
            timers = timers.filter((t) => t !== timer);
          };
        },
      });
      await store.start();
      reads = 0;
      // A reading that pushes four times a second, the most the backend sends, for a minute.
      const seconds = 60;
      for (let ms = 0; ms < seconds * 1000; ms += 50) {
        clock = NOW + ms;
        if (ms % 250 === 0) {
          done += 1;
          for (const l of listeners) l({ type: "agentChanged" });
        }
        const due = timers.filter((t) => t.at <= clock);
        timers = timers.filter((t) => t.at > clock);
        for (const t of due) t.run();
        await flush();
      }
      expect(reads).toBeLessThanOrEqual(seconds / (STATUS_AGE_MS / 1000) + 1);
      expect(reads).toBeGreaterThanOrEqual(seconds / (STATUS_AGE_MS / 1000) - 1);
      // The last one is never older than STATUS_AGE_MS.
      expect(done - (store.status()?.progress.untilMs ?? 0)).toBeLessThanOrEqual(
        STATUS_AGE_MS / 250 + 2,
      );
      dispose();
    }));

  it("answers a burst of pushes with one read, and nothing is redrawn when nothing changed", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      const first = r.store.status();
      r.calls.length = 0;
      for (let i = 0; i < 50; i++) r.emit({ status: true });
      expect(r.pending()).toBe(1);
      r.fire();
      await flush();
      expect(r.calls).toEqual(["status"]);
      // The same answer keeps the same object: no signal fired for the page.
      expect(r.store.status()).toBe(first);
      dispose();
    }));

  it("sends only by agentDraftFromPrepared, then requestSend", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.calls.length = 0;
      expect(await r.store.send("t1", "Hello")).toBe("sent");
      expect(r.calls).toEqual(["draft:t1:Hello", "requestSend:d1"]);
      expect(r.opened).toEqual([]);
      expect(r.store.busy("t1")).toBe(false);
      dispose();
    }));

  it("opens an existing draft in the composer and never sends it", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.setExisting(true);
      r.calls.length = 0;
      expect(await r.store.send("t1", "Hello")).toBe("openedExisting");
      expect(r.calls).toEqual(["draft:t1:Hello"]);
      expect(r.opened).toEqual(["d1"]);
      dispose();
    }));

  it("Edit myself opens the composer on the draft, and on the person's own when there is one", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      expect(await r.store.editMyself("t1", "Text")).toBe("took");
      expect(r.opened).toEqual(["d1"]);
      r.setExisting(true);
      expect(await r.store.editMyself("t1", "Text")).toBe("existing");
      expect(r.opened).toEqual(["d1", "d1"]);
      expect(r.calls.some((c) => c.startsWith("requestSend"))).toBe(false);
      dispose();
    }));

  it("treats a closing from the talk like any closing: its line and Undo", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.store.talkMade("t1", "closed", "You spoke on the phone", "this is done", "Anna waits");
      expect(r.store.line()).toMatchObject({
        kind: "closed",
        threadId: "t1",
        headline: "Anna waits",
        text: "Closed: You spoke on the phone",
      });
      expect(r.rememberCalls).toEqual(["remember:t1:this is done"]);
      await r.store.undoFeedback();
      expect(r.calls).toContain("undo:t1:closed");
      expect(r.store.line()).toBeNull();
      expect(FEEDBACK_UNDO_MS).toBeGreaterThan(0);
      dispose();
    }));

  it("keeps the words given for a draft from the talk, and spends nothing on an answer", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.store.talkMade("t1", "answer", "She wants a date", "what does she want?", "Anna waits");
      expect(r.store.givenFor("t1")).toEqual([]);
      expect(r.rememberCalls).toEqual([]);
      r.store.talkMade("t1", "draft", "", "36,000 net", "Anna waits");
      expect(r.store.givenFor("t1")).toEqual(["36,000 net"]);
      expect(r.rememberCalls).toEqual(["remember:t1:36,000 net"]);
      expect(r.store.line()).toBeNull();
      dispose();
    }));

  it("offers a rule for the sender after a closing, and the click turns the line into the rule's words", () =>
    createRoot(async (dispose) => {
      const r = rig();
      r.setOffer({ scope: "sender", subject: "alerts@x.com" });
      await r.store.start();
      r.store.talkMade("t1", "closed", "Automatic", "no reply", "Alerts");
      // The line is there at once; the offer joins it when the read answers.
      expect(r.store.line()).toMatchObject({ kind: "closed", text: "Closed: Automatic" });
      expect(r.store.line()?.offer).toBeUndefined();
      await flush();
      expect(r.ruleCalls).toEqual(["offer:t1"]);
      expect(r.store.line()?.offer).toEqual({ scope: "sender", subject: "alerts@x.com" });
      await r.store.addRuleFromLine();
      expect(r.ruleCalls).toContain('add:{"threadId":"t1","scope":"sender"}');
      expect(r.store.line()?.text).toBe("No reply needed from alerts@x.com");
      expect(r.store.line()?.offer).toBeUndefined();
      // Undo on the line still takes the closing back.
      await r.store.undoFeedback();
      expect(r.calls).toContain("undo:t1:closed");
      dispose();
    }));

  it("offers the rule after a closing in the person's words too, but not after a draft", () =>
    createRoot(async (dispose) => {
      const r = rig();
      r.setOffer({ scope: "sender", subject: "alerts@x.com" });
      await r.store.start();
      // Whether a no adds up to a rule is for the backend; a draft is no no.
      await r.store.prepare("t1", { answer: "Friday" });
      await flush();
      expect(r.ruleCalls).toEqual([]);
      r.setPrepared({ kind: "closed", reason: "Automatic" });
      await r.store.prepare("t2", { answer: "no reply" });
      await flush();
      expect(r.ruleCalls).toEqual(["offer:t2"]);
      expect(r.store.line()?.offer).toEqual({ scope: "sender", subject: "alerts@x.com" });
      dispose();
    }));

  it("makes no offer when there is none, and keeps the line and the offer when adding fails", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.store.talkMade("t1", "closed", "Automatic", "no reply", "Alerts");
      await flush();
      expect(r.store.line()?.offer).toBeUndefined();
      await r.store.addRuleFromLine();
      expect(r.ruleCalls).toEqual(["offer:t1"]);
      r.setOffer({ scope: "sender", subject: "me@example.com" });
      r.failRules(true);
      r.store.talkMade("t2", "closed", "Automatic", "no reply", "Me");
      await flush();
      await r.store.addRuleFromLine();
      expect(r.store.line()).toMatchObject({
        threadId: "t2",
        text: "That rule could not be added.",
        offer: { subject: "me@example.com" },
      });
      dispose();
    }));

  it("says why the agent closed a thread from the person's words, and Undo takes the closing back", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.setPrepared({ kind: "closed", reason: "<b>Automatic</b> notification" });
      const made = await r.store.prepare("t1", { answer: "don't write" }, "Headline t1");
      expect(made).toMatchObject({ kind: "closed" });
      // Nothing is kept as made work: no words to underline.
      expect(r.store.givenFor("t1")).toEqual([]);
      // The reason is kept as the text it is; the view draws text only.
      expect(r.store.line()).toMatchObject({
        kind: "closed",
        threadId: "t1",
        headline: "Headline t1",
        text: "Closed: <b>Automatic</b> notification",
      });
      expect(r.store.busy("t1")).toBe(false);
      await r.store.undoFeedback();
      expect(r.calls).toContain("undo:t1:closed");
      expect(r.store.line()).toBeNull();
      dispose();
    }));

  it("keeps the words given for a made draft", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      const made = await r.store.prepare("t1", { answer: "Friday", direction: "Yes" });
      expect(made).toMatchObject({ kind: "draft", body: "B" });
      expect(r.store.givenFor("t1")).toEqual(["Friday", "Yes"]);
      expect(r.store.givenFor("t2")).toEqual([]);
      dispose();
    }));

  describe("what the agent remembers from the person's words (ADR 0054)", () => {
    const instruction = (id: number, text: string): RememberResult["items"][number] => ({
      kind: "instruction",
      instruction: { id, scope: "write", text, actor: "agent", atMs: NOW },
    });
    const sender = (id: number, subject: string): RememberResult["items"][number] => ({
      kind: "rule",
      rule: {
        id,
        scope: "sender",
        subject,
        action: "noReply",
        actor: "agent",
        atMs: NOW,
      },
    });

    it("asks only for typed words: not for a chosen direction, a blank answer or no guidance", () =>
      createRoot(async (dispose) => {
        const r = rig();
        await r.store.start();
        await r.store.prepare("t1", { direction: "Ask for a new date" });
        await r.store.prepare("t2", { answer: "   " });
        await r.store.prepare("t3");
        await flush();
        expect(r.rememberCalls).toEqual([]);
        dispose();
      }));

    it("asks with the trimmed words once the answer to prepare is in, for a direction and words both", () =>
      createRoot(async (dispose) => {
        const r = rig();
        await r.store.start();
        await r.store.prepare("t1", { direction: "Yes", answer: "  zawsze pisz krótko " });
        await flush();
        expect(r.rememberCalls).toEqual(["remember:t1:zawsze pisz krótko"]);
        dispose();
      }));

    it("shows the reply at once, and does not wait for the turn that remembers", () =>
      createRoot(async (dispose) => {
        const r = rig();
        r.setRemembered({ items: [instruction(5, "Write briefly")] });
        const release = r.holdRemember();
        await r.store.start();
        const made = await r.store.prepare("t1", { answer: "zawsze pisz krótko" });
        // The turn was asked and has not answered: the draft is there and nothing waits.
        expect(r.rememberCalls).toEqual(["remember:t1:zawsze pisz krótko"]);
        expect(made).toMatchObject({ kind: "draft", body: "B" });
        expect(r.store.busy("t1")).toBe(false);
        expect(r.store.line()).toBeNull();
        release();
        await flush();
        expect(r.store.line()).toMatchObject({
          kind: "remembered",
          threadId: "t1",
          text: "Remembered: Write briefly",
        });
        dispose();
      }));

    it("adds what was kept to the line of a closing that is still showing", () =>
      createRoot(async (dispose) => {
        const r = rig();
        r.setPrepared({ kind: "closed", reason: "Automatic" });
        r.setRemembered({ items: [sender(2, "alerts@x.com")] });
        await r.store.start();
        await r.store.prepare("t1", { answer: "wszystko od tego nadawcy ignoruj" });
        await flush();
        expect(r.store.line()).toMatchObject({
          kind: "closed",
          text: "Closed: Automatic · Remembered: No reply needed from alerts@x.com",
        });
        // Undo on that line takes the closing back and leaves what was kept, which has its own Undo.
        await r.store.undoFeedback();
        expect(r.calls).toContain("undo:t1:closed");
        expect(r.rememberCalls.filter((c) => c.startsWith("remove"))).toEqual([]);
        dispose();
      }));

    it("shows a line of its own when there is no closing, and says the first and how many more", () =>
      createRoot(async (dispose) => {
        const r = rig();
        r.setRemembered({
          items: [
            instruction(5, "Write briefly"),
            instruction(6, "No formulas"),
            sender(2, "a@x.com"),
          ],
        });
        await r.store.start();
        await r.store.prepare("t1", { answer: "zawsze pisz krótko" });
        await flush();
        expect(r.store.line()).toMatchObject({
          kind: "remembered",
          text: "Remembered: Write briefly +2",
        });
        expect(r.store.line()?.headline).toBe("");
        dispose();
      }));

    it("is a line of a closing of another thread's own: it does not join that line", () =>
      createRoot(async (dispose) => {
        const r = rig();
        r.setRemembered({ items: [instruction(5, "Write briefly")] });
        await r.store.start();
        r.setPrepared({ kind: "closed", reason: "Automatic" });
        await r.store.prepare("t2", { answer: "nie odpisuj" });
        await flush();
        r.setPrepared({ kind: "draft", body: "B", nudge: false });
        await r.store.prepare("t1", { answer: "zawsze pisz krótko" });
        await flush();
        expect(r.store.line()).toMatchObject({
          kind: "remembered",
          text: "Remembered: Write briefly",
        });
        dispose();
      }));

    it("removes exactly what the result added when Undo is pressed, and no feedback", () =>
      createRoot(async (dispose) => {
        const r = rig();
        r.setRemembered({ items: [instruction(5, "Write briefly"), sender(9, "a@x.com")] });
        await r.store.start();
        await r.store.prepare("t1", { answer: "zawsze pisz krótko" });
        await flush();
        r.calls.length = 0;
        await r.store.undoFeedback();
        expect(r.rememberCalls.filter((c) => c.startsWith("remove"))).toEqual([
          "removeInstruction:5",
          "removeRule:9",
        ]);
        expect(r.calls.some((c) => c.startsWith("undo:"))).toBe(false);
        expect(r.store.line()).toBeNull();
        dispose();
      }));

    it("shows nothing for an empty answer or a failed turn, and the reply stands", () =>
      createRoot(async (dispose) => {
        const r = rig();
        await r.store.start();
        await r.store.prepare("t1", { answer: "Friday" });
        await flush();
        expect(r.store.line()).toBeNull();
        r.failRemember(true);
        await r.store.prepare("t2", { answer: "zawsze" });
        await flush();
        expect(r.store.line()).toBeNull();
        expect(r.store.problem("t2")).toBe("");
        expect(r.store.givenFor("t2")).toEqual(["zawsze"]);
        dispose();
      }));

    it("lets the line go after the undo time", () =>
      createRoot(async (dispose) => {
        const r = rig();
        r.setRemembered({ items: [instruction(5, "Write briefly")] });
        await r.store.start();
        await r.store.prepare("t1", { answer: "zawsze" });
        await flush();
        expect(r.store.line()).not.toBeNull();
        r.fire();
        expect(r.store.line()).toBeNull();
        dispose();
      }));
  });

  it("lets the line go after the undo time", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.setPrepared({ kind: "closed", reason: "Automatic" });
      await r.store.prepare("t1", { answer: "no reply" });
      expect(r.store.line()).not.toBeNull();
      r.fire();
      expect(r.store.line()).toBeNull();
      dispose();
    }));

  it("sends Pause reading and Continue to the backend and shows what they return (ADR 0117, rule 3)", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.calls.length = 0;
      r.setShownStatus(status({ progress: { state: "paused", reason: "pausedByPerson" } }));
      await r.store.pauseReading();
      expect(r.store.status()?.progress.reason).toBe("pausedByPerson");
      r.setShownStatus(status({ progress: { state: "reading" } }));
      await r.store.resumeReading();
      expect(r.store.status()?.progress.state).toBe("reading");
      expect(r.calls).toEqual(["pause", "resume"]);
      dispose();
    }));
});
