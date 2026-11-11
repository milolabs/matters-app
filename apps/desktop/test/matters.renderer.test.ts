import type {
  AddInstructionInput,
  AddRuleInput,
  AgentInstruction,
  AgentRule,
  AgentStatus,
  FeedbackJournalEntry,
  InstructionJournalEntry,
  JournalEntry,
  PreparedWork,
  PrepareResult,
  RememberResult,
  RuleJournalEntry,
  RuleOffer,
  Thing,
} from "@matters/core";
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
import {
  ASK_FOR_DETAILS,
  dateOrLateness,
  defaultHint,
  directionOf,
  etaText,
  foundText,
  hasIntentBar,
  holdList,
  intentFacts,
  journalLine,
  journalLines,
  keptScroll,
  listNote,
  MORE_COMING,
  mattersTab,
  NOT_LIKE_THIS_LATER,
  nextWindow,
  notLikeThisChoices,
  notPreparedLine,
  ourShare,
  PAUSED_LINE,
  planButton,
  questionButtonText,
  readerActions,
  readerEyebrow,
  readerFacts,
  readingFooter,
  readingScreen,
  rowLine,
  rowMark,
  ruleText,
  SIGN_IN_COMMAND,
  seriesLine,
  seriesMap,
  sessionLeftText,
  splitYours,
  THINGS_PAGE,
  tabCount,
  writtenByLine,
} from "../src/renderer/mattersView.ts";
import { createMailStore } from "../src/renderer/store.ts";
import { createViewsStore, MATTERS_ID } from "../src/renderer/views.ts";

const NOW = Date.UTC(2026, 10, 5, 10, 42);
const models = {
  understand: "haiku",
  draftAhead: "haiku",
  write: "sonnet",
  answer: "sonnet",
  titles: "haiku",
};
const thing = (id: string, over: Partial<Thing> = {}): Thing => ({
  threadId: id,
  accountId: "a",
  who: "Anna",
  headline: `Headline ${id}`,
  quote: { quote: "q", messageKey: 1 },
  why: "You promised this.",
  score: 1,
  ...over,
});
const status = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  settings: {
    enabled: true,
    runtimeId: "claude-code",
    models,
    windowDays: 30,
    weekSharePercent: 10,
    usedByUsPercent: 4.2,
    limits: {
      session: { usedPercent: 39, resetsAtMs: NOW + 3_600_000 },
      week: { usedPercent: 22, resetsAtMs: NOW + 3 * 86_400_000 },
      usingOverage: false,
      seenAtMs: NOW - 60_000,
    },
  },
  runtime: { id: "claude-code", name: "Claude Code", status: "ready", models: ["haiku", "sonnet"] },
  consents: [],
  progress: { state: "idle", done: 3, total: 3 },
  ledger: [],
  ...over,
});

describe("what a series says (ADR 0061)", () => {
  const series = {
    name: "Documents for August",
    mails: [
      { threadId: "c", headline: "Newest", dateMs: Date.UTC(2026, 8, 16, 12) },
      { threadId: "b", headline: "Middle", dateMs: Date.UTC(2026, 8, 15, 12) },
      { threadId: "a", headline: "Oldest", dateMs: Date.UTC(2026, 8, 14, 12) },
    ],
  };
  it("counts the mails on the row and names the newest date, and says nothing for no series", () => {
    expect(seriesLine(thing("c", { series }))).toBe("3 mails, newest 16 Sept");
    expect(seriesLine(thing("c"))).toBe("");
  });
  it("draws as a map with a line per mail, newest first, and nothing holding up anything", () => {
    const map = seriesMap(thing("c", { series }));
    expect(map?.bundle.name).toBe("Documents for August");
    expect(map?.bundle.edges).toEqual([]);
    expect(map?.bundle.members.map((m) => [m.threadId, m.who, m.headline])).toEqual([
      ["c", "16 Sept", "Newest"],
      ["b", "15 Sept", "Middle"],
      ["a", "14 Sept", "Oldest"],
    ]);
    expect(map?.summary).toContain("Sent 3 times.");
    expect(seriesMap(thing("c"))).toBeUndefined();
  });
});

describe("what a thing asks of the person (ADR 0066, rule 8)", () => {
  const ids = (t: Thing) => readerActions(t).map((a) => a.id);
  const labels = (t: Thing) => readerActions(t).map((a) => a.label);

  const weights = (t: Thing) => readerActions(t).map((a) => a.weight);

  it("gives a decision three ways to answer, a reminder and Not important, and no draft ahead", () => {
    const t = thing("a", { intent: "decide" });
    expect(labels(t)).toEqual([
      "I'll take it",
      "Not this year",
      "Ask for details",
      "Remind me tomorrow",
      "Not important",
    ]);
    expect(ids(t)).toEqual(["take", "decline", "details", "later", "notImportant"]);
    expect(weights(t)).toEqual(["primary", "plain", "plain", "plain", "menu"]);
    expect(hasIntentBar(t)).toBe(true);
    expect(ASK_FOR_DETAILS).toBe("Ask for the details that would help decide");
  });

  it("gives an act Mark as done, and news Got it, each with a reminder and Not important", () => {
    expect(labels(thing("a", { intent: "act" }))).toEqual([
      "Mark as done",
      "Remind me tomorrow",
      "Not important",
    ]);
    expect(labels(thing("a", { intent: "know" }))).toEqual([
      "Got it",
      "Remind me tomorrow",
      "Not important",
    ]);
    expect(hasIntentBar(thing("a", { intent: "act" }))).toBe(true);
    expect(hasIntentBar(thing("a", { intent: "know" }))).toBe(true);
    // Neither is offered a draft: "Prepare now" is not among them.
    for (const intent of ["act", "know", "decide"] as const) {
      expect(labels(thing("a", { intent }))).not.toContain("Prepare now");
      expect(labels(thing("a", { intent }))).not.toContain("No reply needed");
    }
  });

  it("keeps what a reply, a wait and no stated intent had, with no primary (ADR 0095)", () => {
    for (const t of [thing("a", { intent: "reply" }), thing("a", { intent: "wait" }), thing("a")]) {
      expect(labels(t)).toEqual(["No reply needed", "Remind me tomorrow", "Not important"]);
      expect(weights(t)).toEqual(["plain", "plain", "menu"]);
      expect(defaultHint(readerActions(t))).toBe("");
      expect(hasIntentBar(t)).toBe(false);
    }
  });

  it("renames Done to Ignore for a suspect thing, whatever it is", () => {
    expect(labels(thing("a", { intent: "act", suspect: true }))[0]).toBe("Ignore");
    expect(ids(thing("a", { intent: "act", suspect: true }))[0]).toBe("ignore");
    expect(weights(thing("a", { intent: "act", suspect: true }))[0]).toBe("primary");
    expect(labels(thing("a", { suspect: true }))).toEqual([
      "Ignore",
      "Remind me tomorrow",
      "Not important",
    ]);
    expect(labels(thing("a", { intent: "act", check: true }))).toEqual([
      "Mark as done",
      "Remind me tomorrow",
      "Not important",
    ]);
  });

  it("says what every button does, and leads with the primary's words (ADR 0095)", () => {
    for (const intent of ["decide", "act", "know", "reply", "wait", undefined] as const) {
      for (const spec of readerActions(thing("a", intent ? { intent, suspect: false } : {}))) {
        expect(spec.hint, `${String(intent)} ${spec.id}`).toMatch(/\.$/);
      }
    }
    expect(defaultHint(readerActions(thing("a", { intent: "act" })))).toBe(
      "Closes it. A new message opens it again.",
    );
    expect(readerActions(thing("a", { intent: "act" }))[1]?.hint).toBe(
      "Hides it until tomorrow morning, then brings it back.",
    );
  });

  it("names what a thing asks of the person above the agent's part", () => {
    expect(readerEyebrow(thing("a", { intent: "act" }))).toBe("To do");
    expect(readerEyebrow(thing("a", { intent: "decide" }))).toBe("To decide");
    expect(readerEyebrow(thing("a", { intent: "know" }))).toBe("Worth knowing");
    expect(readerEyebrow(thing("a", { intent: "reply" }))).toBe("Needs a reply");
    expect(readerEyebrow(thing("a", { intent: "wait" }))).toBe("Waiting on them");
    expect(readerEyebrow(thing("a"))).toBe("Needs you");
  });

  it("marks only the lateness among the card's facts as late", () => {
    expect(readerFacts(thing("a", { lateByDays: 2 }))).toEqual([
      { text: "2 days late", late: true },
    ]);
    expect(readerFacts(thing("a", { dueMs: Date.UTC(2026, 10, 12) }))).toEqual([
      { text: "Due 12 Nov", late: false },
    ]);
  });

  it("says what a row is, truly: to decide, to do, worth knowing", () => {
    expect(rowLine(thing("a", { intent: "decide" }), undefined)).toMatchObject({
      label: "To decide",
      agent: false,
    });
    expect(rowLine(thing("a", { intent: "act" }), undefined).label).toBe("To do");
    expect(rowLine(thing("a", { intent: "know" }), undefined).label).toBe("Worth knowing");
    expect(rowLine(thing("a", { intent: "reply" }), undefined).label).toBe("Needs you");
    // A draft that was asked for is a draft, whatever the thing is.
    expect(
      rowLine(thing("a", { intent: "decide" }), { kind: "draft", body: "x", nudge: false }).label,
    ).toBe("Agent draft ready");
  });

  it("marks a row that may be stale or suspect, the second stronger", () => {
    expect(rowMark(thing("a"))).toBe("");
    expect(rowMark(thing("a", { check: true }))).toBe("Check once");
    expect(rowMark(thing("a", { suspect: true }))).toBe("Check the sender");
    expect(rowMark(thing("a", { suspect: true, check: true }))).toBe("Check the sender");
    expect(rowMark(thing("a", { unverified: true }))).toBe("Check the sender");
  });

  it("shows the amount with what it is, the end of an offer, and the date", () => {
    const amount = (role: "debt" | "price" | "refund" | "other") => ({
      value: 1090,
      currency: "PLN",
      role,
      evidence: { quote: "1090 PLN", messageKey: 1 },
    });
    expect(intentFacts(thing("a", { intent: "decide", amount: amount("price") }))).toEqual([
      "Price 1,090 PLN",
    ]);
    expect(intentFacts(thing("a", { amount: amount("debt") }))).toEqual(["To pay 1,090 PLN"]);
    expect(intentFacts(thing("a", { amount: amount("refund") }))).toEqual(["Refund 1,090 PLN"]);
    expect(intentFacts(thing("a", { amount: amount("other") }))).toEqual(["Amount 1,090 PLN"]);
    expect(
      intentFacts(
        thing("a", {
          amount: amount("price"),
          windowEndMs: Date.UTC(2026, 10, 30),
          dueMs: Date.UTC(2026, 10, 12),
        }),
      ),
    ).toEqual(["Price 1,090 PLN", "Ends 30 Nov", "Due 12 Nov"]);
    expect(intentFacts(thing("a", { lateByDays: 2 }))).toEqual(["2 days late"]);
    expect(intentFacts(thing("a"))).toEqual([]);
  });
});

describe("Not like this… (ADR 0068, rule 3)", () => {
  it("offers a kind in words when the reading named one, and the sender, for every intent", () => {
    for (const intent of ["decide", "act", "know", "reply", "wait", undefined] as const) {
      const t = thing("a", {
        category: "paymentProblem",
        who: "Anna",
        ...(intent ? { intent } : {}),
      });
      expect(
        notLikeThisChoices(t).map((c) => c.label),
        String(intent),
      ).toEqual(["Don't show payment problems", "Don't show mail from Anna"]);
    }
    expect(notLikeThisChoices(thing("a", { category: "other" })).map((c) => c.id)).toEqual([
      "sender",
    ]);
    expect(notLikeThisChoices(thing("a")).map((c) => c.id)).toEqual(["sender"]);
    expect(notLikeThisChoices(thing("a", { who: "  " })).map((c) => c.id)).toEqual([]);
  });

  it("says honestly that the words apply from now on", () => {
    expect(NOT_LIKE_THIS_LATER).toBe("Applies to mail read from now on.");
  });

  it("describes a rule about a kind in the person's words", () => {
    expect(ruleText({ scope: "category", subject: "offer" })).toBe("Don't show offers");
    expect(ruleText({ scope: "category", subject: "official" })).toBe(
      "Don't show mail from public offices",
    );
    expect(ruleText({ scope: "sender", subject: "a@b.example" })).toBe(
      "No reply needed from a@b.example",
    );
  });

  it("marks a row from a public office, and a suspect one wins", () => {
    expect(rowMark(thing("a", { official: true }))).toBe("Official");
    expect(rowMark(thing("a", { official: true, suspect: true }))).toBe("Check the sender");
  });
});

describe("a list on hold (ADR 0062)", () => {
  const row = (threadId: string, now = false) => ({ threadId, now });
  const ids = (list: readonly Thing[]) => list.map((t) => t.threadId);

  it("keeps the rows in the order they had, whatever the ranking says now", () => {
    const out = holdList([thing("c"), thing("a"), thing("b")], [row("a"), row("b"), row("c")]);
    expect(ids(out.things)).toEqual(["a", "b", "c"]);
  });

  it("keeps a row on its side of the heading, both ways", () => {
    const out = holdList(
      [thing("left"), thing("joined", { now: true }), thing("rest")],
      [row("left", true), row("joined"), row("rest")],
    );
    expect(ids(out.things)).toEqual(["left", "joined", "rest"]);
    expect(out.things[0]?.now).toBe(true);
    expect(out.things[1]?.now).toBeUndefined();
  });

  it("brings the new, after the row the ranking puts before them", () => {
    const out = holdList(
      [thing("top"), thing("a"), thing("new"), thing("b")],
      [row("b"), row("a")],
    );
    expect(ids(out.things)).toEqual(["top", "b", "a", "new"]);
  });

  it("puts something new for now above the heading", () => {
    const out = holdList(
      [thing("a", { now: true }), thing("b"), thing("urgent", { now: true })],
      [row("a", true), row("b")],
    );
    expect(ids(out.things)).toEqual(["a", "urgent", "b"]);
  });

  it("remembers the place of what left, so that an Undo puts it back there", () => {
    const first = holdList([thing("a"), thing("c")], [row("a"), row("b"), row("c")]);
    expect(ids(first.things)).toEqual(["a", "c"]);
    expect(first.held.map((r) => r.threadId)).toEqual(["a", "b", "c"]);
    const back = holdList([thing("b"), thing("c"), thing("a")], first.held);
    expect(ids(back.things)).toEqual(["a", "b", "c"]);
  });

  it("keeps a row that stayed the same object, so that it is not redrawn", () => {
    const same = thing("a");
    expect(holdList([same], [row("a")]).things[0]).toBe(same);
  });
});

describe("what a row says", () => {
  const draft: PreparedWork = { kind: "draft", body: "x", nudge: false };
  it("marks agent work with the ring words and what needs the person with its own", () => {
    expect(rowLine(thing("a"), draft)).toMatchObject({ label: "Agent draft ready", agent: true });
    expect(rowLine(thing("a"), { ...draft, nudge: true }).label).toBe("Agent nudge ready");
    expect(rowLine(thing("a"), undefined)).toMatchObject({ label: "Needs you", agent: false });
    expect(rowLine(thing("a", { updating: true }), draft).label).toBe("Agent working");
    expect(rowLine(thing("a"), { kind: "needs", missing: "m", directions: [] }).agent).toBe(true);
  });
  it("says lateness in words and counts the tab", () => {
    expect(dateOrLateness(thing("a", { lateByDays: 3 }))).toEqual({
      text: "3 days late",
      late: true,
    });
    expect(dateOrLateness(thing("a"))).toEqual({ text: "", late: false });
    expect(tabCount(0)).toBeUndefined();
    expect(tabCount(2)).toBe("2");
    expect(tabCount(214)).toBe("214");
  });
  it("keeps the row the person is looking at when the list changes above it", () => {
    const [a, b, c] = [thing("a"), thing("b"), thing("c")];
    const one = (things: Thing[]) => ({ things, boundary: -1 });
    // 102 is where the second row starts: a heading of 34, a row of 68.
    expect(keptScroll(one([a, b, c]), one([c, a, b]), 102)).toBe(170);
    expect(keptScroll(one([a, b, c]), one([b, c]), 102)).toBe(34);
    expect(keptScroll(one([a, b, c]), one([a, b, c]), 170)).toBe(170);
    expect(keptScroll(one([]), one([a]), 34)).toBe(34);
  });
  it("holds on to the next row when the one at the top is gone", () => {
    const [a, b, c] = [thing("a"), thing("b"), thing("c")];
    const one = (things: Thing[]) => ({ things, boundary: -1 });
    expect(keptScroll(one([a, b, c]), one([a, c]), 102)).toBe(34);
    expect(keptScroll(one([a, b]), one([c]), 102)).toBe(102);
  });
  it("counts the heading of the rest when it comes, goes or moves", () => {
    const [n, a, b, c] = [thing("n"), thing("a"), thing("b"), thing("c")];
    // No sections, then a thing for now above them: one row more, and the heading of the rest.
    expect(
      keptScroll({ things: [a, b, c], boundary: -1 }, { things: [n, a, b, c], boundary: 1 }, 102),
    ).toBe(102 + 68 + 34);
    // Deep in the rest, one more thing for now: the heading was above already, so one row.
    expect(
      keptScroll({ things: [a, b, c], boundary: 1 }, { things: [n, a, b, c], boundary: 2 }, 204),
    ).toBe(204 + 68);
    // On the heading itself the first row under it holds: the rest goes on from there.
    expect(
      keptScroll({ things: [a, b, c], boundary: 1 }, { things: [n, a, b, c], boundary: 2 }, 110),
    ).toBe(110 + 68);
  });
  it("claims preparing only for what is drafted ahead", () => {
    const on = status();
    const preparing = "The agent is preparing this.";
    expect(notPreparedLine(true, 50, on)).toBe("The agent is writing this.");
    expect(notPreparedLine(false, 6, on)).toBe(preparing);
    expect(notPreparedLine(false, 7, on)).toBe("Not prepared yet.");
    const off = {
      ...on,
      settings: { ...on.settings, models: { ...on.settings.models, draftAhead: "off" } },
    };
    expect(notPreparedLine(false, 0, off)).toBe("Not prepared yet.");
    const paused = status({ progress: { state: "paused", done: 1, total: 2 } });
    expect(notPreparedLine(false, 0, paused)).toBe("Not prepared yet.");
  });
  it("says what sits under the rows", () => {
    expect(listNote(3, { state: "reading", done: 1, total: 2 })).toBe("more");
    // With no rows the reader explains, and the list says nothing at all.
    expect(listNote(0, { state: "reading", done: 1, total: 2 })).toBeNull();
    expect(listNote(0, { state: "idle", done: 0, total: 0 })).toBeNull();
    expect(listNote(3, { state: "idle", done: 0, total: 0 })).toBeNull();
    // The person's pause is said under the rows, where Continue sits; a plan's pause is not.
    expect(listNote(3, { state: "paused", reason: "pausedByPerson", done: 1, total: 2 })).toBe(
      "paused",
    );
    expect(listNote(3, { state: "paused", reason: "budget", done: 1, total: 2 })).toBeNull();
    expect(
      listNote(0, { state: "paused", reason: "pausedByPerson", done: 1, total: 2 }),
    ).toBeNull();
    expect(PAUSED_LINE).toBe("Reading is paused.");
    expect(MORE_COMING).toBe("More will appear here as I read.");
    expect(readingFooter(status({ progress: { state: "reading", done: 84, total: 214 } }))).toBe(
      "Reading last 30 days · 84 of 214",
    );
    expect(readingFooter(status())).toBeNull();
  });
});

describe("the status line", () => {
  it("shows the session's percent left, late under 20", () => {
    expect(planButton(status(), NOW)).toEqual({ text: "Claude Code 61% left", late: false });
    const low = status();
    const s = {
      ...low,
      settings: {
        ...low.settings,
        limits: {
          ...(low.settings.limits as object),
          usingOverage: false,
          seenAtMs: NOW,
          week: undefined,
          session: { usedPercent: 85, resetsAtMs: NOW + 1000 },
        },
      },
    };
    expect(planButton(s, NOW)).toEqual({ text: "Claude Code 15% left", late: true });
  });
  it("says when limits are not known, and when work is paused", () => {
    const s = status();
    const unknown = { ...s, settings: { ...s.settings, limits: undefined } };
    expect(planButton(unknown, NOW).text).toBe("Claude Code · limits not known yet");
    const paused = status({
      progress: {
        state: "paused",
        done: 1,
        total: 2,
        reason: "sessionLimit",
        untilMs: new Date(2026, 10, 5, 14, 0).getTime(),
      },
    });
    expect(planButton(paused, new Date(2026, 10, 5, 10, 0).getTime()).text).toBe(
      "Paused until 14:00 · plan limit",
    );
  });
  it("says our share and who wrote a draft", () => {
    expect(ourShare(status())).toBe("Matters this week: about 4% of Claude");
    expect(writtenByLine(status().runtime, models, false)).toBe("Claude Code, Haiku, your plan");
    expect(writtenByLine(status().runtime, models, true)).toBe("Claude Code, Sonnet, your plan");
  });
});

describe("the person's words", () => {
  it("underlines only what occurs word for word", () => {
    expect(splitYours("Hi,\n\nI pay Friday.\n\nBye", ["I pay Friday."])).toEqual([
      { text: "Hi,\n\n", yours: false },
      { text: "I pay Friday.", yours: true },
      { text: "\n\nBye", yours: false },
    ]);
    expect(splitYours("Hi", ["other"])).toEqual([{ text: "Hi", yours: false }]);
  });
  it("picks directions by digit", () => {
    const work: PreparedWork = { kind: "needs", missing: "m", directions: ["a", "b"] };
    expect(directionOf(work, "2")).toBe("b");
    expect(directionOf(work, "3")).toBeUndefined();
  });
});

describe("tabs", () => {
  function setup() {
    const backend = {
      listNewest: async () => ({ messages: [] }),
      search: async () => ({ messages: [] }),
      listViews: async () => [],
      countMatches: async () => ({ count: 0 }),
    } as unknown as Backend;
    const store = createMailStore(backend);
    const views = createViewsStore(backend, store, {
      delay: () => new Promise(() => {}),
      setText: (t) => store.setQuery(t),
    });
    return { store, views };
  }
  it("has no Matters tab while AI is off", () =>
    createRoot((dispose) => {
      const { views } = setup();
      expect(views.views().map((v) => v.id)).toEqual(["all"]);
      dispose();
    }));
  it("adds Matters first and opens it when AI turns on, and takes it away again", () =>
    createRoot((dispose) => {
      const { views } = setup();
      views.setMattersAvailable(true);
      expect(views.views().map((v) => v.id)).toEqual([MATTERS_ID, "all"]);
      expect(views.active().id).toBe(MATTERS_ID);
      expect(views.isSaved()).toBe(false);
      views.setMattersAvailable(false);
      expect(views.active().id).toBe("all");
      dispose();
    }));
  it("does not open by default after the person chose a tab", () =>
    createRoot((dispose) => {
      const { views } = setup();
      views.select("all");
      views.setMattersAvailable(true);
      expect(views.active().id).toBe("all");
      dispose();
    }));
  it("stays in Matters when text is typed, and cannot be renamed or deleted", async () =>
    createRoot((dispose) => {
      const { views, store } = setup();
      views.setMattersAvailable(true);
      store.setQuery("faktura");
      expect(views.active().id).toBe(MATTERS_ID);
      // A search of Matters is not a view: a saved view searches mail.
      expect(views.canSaveAs()).toBe(false);
      expect(views.startNaming()).toBe(false);
      views.revert();
      expect(store.query()).toBe("");
      void views.rename(MATTERS_ID, "x").then((o) => expect(o.ok).toBe(false));
      void views.remove(MATTERS_ID).then((o) => expect(o.ok).toBe(false));
      dispose();
    }));
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

describe("the words of a rule", () => {
  it("titles who added it, and says what it does", () => {
    const line = (over: Partial<RuleJournalEntry>) => journalLine(ruleEntry(over), NOW);
    expect(line({}).title).toBe("Rule added by you");
    expect(line({ actor: "agent" }).title).toBe("Rule added by the agent");
    expect(line({}).detail).toBe("No reply needed from alerts@x.com");
    expect(line({ scope: "domain", subject: "x.com" }).detail).toBe("No reply needed from x.com");
    expect(line({ scope: "type", subject: "programLike" }).detail).toBe(
      "No reply needed from addresses that look like programs (alerts@, updates@…)",
    );
    expect(line({ words: "never from them" }).detail).toBe(
      'No reply needed from alerts@x.com. You said: "never from them"',
    );
    expect(line({}).headline).toBe("");
  });

  it("is undoable until undone, whatever else the journal holds", () => {
    const lines = journalLines(
      [
        ruleEntry({ id: 6, ruleId: 3 }),
        journalEntry({ id: 5, threadId: "t1", action: "notImportant" }),
        ruleEntry({ id: 4, ruleId: 2, undoneAtMs: NOW - 1 }),
        ruleEntry({ id: 3, ruleId: 1 }),
      ],
      NOW,
    );
    expect(lines.map((l) => [l.entry.id, l.undoable, l.undone])).toEqual([
      [6, true, false],
      [5, true, false],
      [4, false, true],
      [3, true, false],
    ]);
  });
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

describe("the words of an instruction", () => {
  const line = (over: Partial<InstructionJournalEntry>) => journalLine(instructionEntry(over), NOW);

  it("titles who added it, and says where it applies and what it says", () => {
    expect(line({}).title).toBe("Instruction added by you");
    expect(line({ actor: "agent" }).title).toBe("Remembered by the agent");
    expect(line({}).detail).toBe("When writing: Write briefly.");
    expect(line({ scope: "general", text: "Answer in Polish." }).detail).toBe(
      "In general: Answer in Polish.",
    );
    expect(line({ scope: "understand" }).detail).toMatch(/^When reading: /);
    expect(line({ scope: "thread" }).detail).toMatch(/^For this thread: /);
    expect(line({}).headline).toBe("");
  });

  it("quotes the person's words only when they differ from the text", () => {
    expect(line({ actor: "agent", words: "zawsze pisz krótko" }).detail).toBe(
      'When writing: Write briefly. You said: "zawsze pisz krótko"',
    );
    expect(line({ actor: "agent", words: " Write briefly " }).detail).toBe(
      "When writing: Write briefly.",
    );
    expect(line({ actor: "agent", words: "  " }).detail).toBe("When writing: Write briefly.");
  });

  it("is undoable until undone, by its own id, whatever else the journal holds", () => {
    const lines = journalLines(
      [
        instructionEntry({ id: 6, instructionId: 3 }),
        journalEntry({ id: 5, threadId: "t1", action: "notImportant" }),
        instructionEntry({ id: 4, instructionId: 2, undoneAtMs: NOW - 1 }),
        instructionEntry({ id: 3, instructionId: 1 }),
      ],
      NOW,
    );
    expect(lines.map((l) => [l.entry.id, l.undoable, l.undone])).toEqual([
      [6, true, false],
      [5, true, false],
      [4, false, true],
      [3, true, false],
    ]);
  });
});

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

describe("the journal's words", () => {
  it("titles who did what", () => {
    const title = (over: Partial<FeedbackJournalEntry>) =>
      journalLine(journalEntry(over), NOW).title;
    expect(title({ action: "closed", actor: "agent" })).toBe("Closed by the agent");
    expect(title({ action: "closed", actor: "person" })).toBe("Closed by you");
    expect(title({ action: "notImportant" })).toBe("Marked not important");
    expect(title({ action: "later", untilMs: NOW + 1 })).toBe("Set aside");
  });

  it("says how many older mails a closing also hid, and says nothing when it is none", () => {
    const title = (over: Partial<FeedbackJournalEntry>) =>
      journalLine(journalEntry(over), NOW).title;
    expect(title({ action: "closed", actor: "person", alsoCovers: 8 })).toBe(
      "Closed by you · also 8 older mails",
    );
    expect(title({ action: "notImportant", alsoCovers: 1 })).toBe(
      "Marked not important · also 1 older mail",
    );
    expect(title({ action: "closed", actor: "person" })).toBe("Closed by you");
  });

  it("gives the reason and the person's words, as plain text", () => {
    const detail = (over: Partial<FeedbackJournalEntry>) =>
      journalLine(journalEntry(over), NOW).detail;
    expect(detail({ reason: "Nothing to answer", words: "nie odpisuj" })).toBe(
      'Nothing to answer. You said: "nie odpisuj"',
    );
    expect(detail({ reason: "Nothing to answer." })).toBe("Nothing to answer.");
    expect(detail({ words: "nie odpisuj" })).toBe('You said: "nie odpisuj"');
    expect(detail({ reason: "<b>x</b>" })).toBe("<b>x</b>.");
    expect(detail({})).toBe("");
    expect(detail({ reason: "  ", words: " " })).toBe("");
  });

  it("offers Undo only on the newest line of a thread and action that is not undone", () => {
    const lines = journalLines(
      [
        journalEntry({ id: 5, threadId: "t1", action: "notImportant" }),
        journalEntry({ id: 4, threadId: "t2", action: "notImportant" }),
        journalEntry({ id: 3, threadId: "t1", action: "closed" }),
        journalEntry({ id: 2, threadId: "t1", action: "notImportant" }),
      ],
      NOW,
    );
    expect(lines.map((l) => [l.entry.id, l.undoable, l.undone])).toEqual([
      [5, true, false],
      [4, true, false],
      [3, true, false],
      [2, false, false],
    ]);
  });

  it("passes over an undone line when it looks for the newest, and shows the line as undone", () => {
    const lines = journalLines(
      [
        journalEntry({ id: 3, undoneAtMs: NOW - 1 }),
        journalEntry({ id: 2 }),
        journalEntry({ id: 1 }),
      ],
      NOW,
    );
    expect(lines.map((l) => [l.entry.id, l.undoable, l.undone])).toEqual([
      [3, false, true],
      [2, true, false],
      [1, false, false],
    ]);
  });

  it("does not offer Undo on a later that has already come back", () => {
    const later = (untilMs: number) =>
      journalLines([journalEntry({ action: "later", untilMs })], NOW)[0];
    expect(later(NOW + 1000)?.undoable).toBe(true);
    expect(later(NOW)?.undoable).toBe(false);
    expect(later(NOW - 1000)?.undoable).toBe(false);
    expect(later(NOW - 1000)?.undone).toBe(false);
  });
});

describe("the agent store", () => {
  function rig(list: Thing[] = [thing("t1"), thing("t2")]) {
    const calls: string[] = [];
    const listeners: ((e: { type: string }) => void)[] = [];
    let timers: (() => void)[] = [];
    const opened: string[] = [];
    let existing = false;
    let prepared: PrepareResult = { kind: "draft", body: "B", nudge: false };
    let current = list;
    let journal: JournalEntry[] = [];
    let offer: RuleOffer | null = null;
    let ruleFails = false;
    const rememberCalls: string[] = [];
    let remembered: RememberResult = { items: [] };
    let rememberFails = false;
    let rememberGate: Promise<void> = Promise.resolve();
    let thingsGate: Promise<void> = Promise.resolve();
    const ruleCalls: string[] = [];
    let shownStatus = status();
    const backend = {
      agentStatus: async () => {
        calls.push("status");
        return shownStatus;
      },
      agentPauseReading: async () => {
        calls.push("pause");
        return shownStatus;
      },
      agentResumeReading: async () => {
        calls.push("resume");
        return shownStatus;
      },
      agentInspect: async () => {
        calls.push("inspect");
        return shownStatus;
      },
      agentTestRuntime: async () => {
        calls.push("test");
        return shownStatus;
      },
      agentSetWindowDays: async (days: number) => {
        calls.push(`window:${days}`);
        shownStatus = { ...shownStatus, settings: { ...shownStatus.settings, windowDays: days } };
        return shownStatus;
      },
      agentThings: async (limit: number) => {
        calls.push("things");
        // What the backend lists when the read is asked, answered when the gate opens.
        const asked = current;
        await thingsGate;
        return { things: asked.slice(0, limit), total: asked.length };
      },
      openThread: async (id: string) => ({
        thread: { id, accountId: "a" },
        messages: [{ key: 1 }],
      }),
      agentFeedback: async (id: string, kind: string, outcome?: string) => {
        calls.push(
          outcome === undefined ? `feedback:${id}:${kind}` : `feedback:${id}:${kind}:${outcome}`,
        );
        current = current.filter((t) => t.threadId !== id);
      },
      agentUndoFeedback: async (id: string, kind: string) => {
        calls.push(`undo:${id}:${kind}`);
        current = list;
        // The journal marks the newest line of that thread and kind, as the store does.
        const at = journal.findIndex(
          (e) =>
            e.action !== "ruleAdded" &&
            e.threadId === id &&
            e.action === kind &&
            e.undoneAtMs === undefined,
        );
        const found = journal[at];
        if (found !== undefined) journal[at] = { ...found, undoneAtMs: NOW };
      },
      agentJournal: async (limit?: number) => {
        calls.push(`journal:${limit}`);
        return journal;
      },
      agentRuleOffer: async (id: string) => {
        ruleCalls.push(`offer:${id}`);
        return offer;
      },
      agentAddRule: async (input: AddRuleInput) => {
        ruleCalls.push(`add:${JSON.stringify(input)}`);
        if (ruleFails) throw new Error("That is one of your own addresses.");
        if ("scope" in input && input.scope === "category") {
          return { id: 8, scope: "category", subject: input.subject };
        }
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
      agentAddInstruction: async (input: { scope: string; text: string }) => {
        rememberCalls.push(`addInstruction:${input.scope}:${input.text}`);
        return { id: 9, scope: input.scope, text: input.text, actor: "person", atMs: NOW };
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
      setList: (next: Thing[]) => {
        current = next;
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
      /** Holds the answers of reads of the list asked from now until the returned function runs. */
      holdThings: () => {
        let open: () => void = () => {};
        thingsGate = new Promise<void>((resolve) => {
          open = () => {
            thingsGate = Promise.resolve();
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
      setJournal: (next: JournalEntry[]) => {
        journal = next;
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
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("pages in every thing, and closing one does not pull another up from a queue", () =>
    createRoot(async (dispose) => {
      const many = Array.from({ length: THINGS_PAGE + 10 }, (_, i) => thing(`t${i}`));
      const r = rig(many);
      await r.store.start();
      expect(r.store.things()).toHaveLength(THINGS_PAGE);
      expect(r.store.count()).toBe(many.length);

      await r.store.loadMore();
      expect(r.store.things()).toHaveLength(many.length);
      // All there: no further request.
      const asked = r.calls.length;
      await r.store.loadMore();
      expect(r.calls).toHaveLength(asked);

      await r.store.feedback(many[0] as Thing, "closed");
      expect(r.store.things()).toHaveLength(many.length - 1);
      expect(r.store.things()[0]?.threadId).toBe("t1");
      expect(r.store.count()).toBe(many.length - 1);
      dispose();
    }));

  it("loads status and things, selects the first", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      expect(r.store.enabled()).toBe(true);
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t1", "t2"]);
      expect(r.store.selected()?.threadId).toBe("t1");
      r.store.move(1);
      expect(r.store.selected()?.threadId).toBe("t2");
      dispose();
    }));

  it("coalesces pushes into one refetch and asks for the status only when it is shown", () =>
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
      expect(r.calls).toEqual(["things"]);
      r.store.setShown(true);
      r.calls.length = 0;
      r.emit();
      r.fire();
      await flush();
      expect([...r.calls].sort()).toEqual(["status", "things"]);
      dispose();
    }));

  // The status was read a moment ago (here: always, the clock stands still), and then another
  // window or the reading changed it (ADR 0115).
  const off = (s: AgentStatus): AgentStatus => ({
    ...s,
    settings: { ...s.settings, enabled: false },
    progress: { state: "off", done: 0, total: 0, reason: "disabled" },
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
      const open = r.holdThings();
      r.emit();
      r.fire();
      await flush();
      // The first refresh waits for the list; AI is turned on meanwhile.
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
            progress: { state: "paused", done: 3, total: 9, reason: "pausedByPerson" },
          },
          (s) => s?.progress.reason,
          "pausedByPerson",
        ],
        [
          { ...on, consents: [], progress: { state: "reading", done: 3, total: 9 } },
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
      r.setShownStatus(status({ progress: { state: "reading", done: 3, total: 9 } }));
      await r.store.start();
      r.calls.length = 0;
      // The reading stops at the plan's limit; its push carries no word about the status.
      r.setShownStatus(
        status({ progress: { state: "paused", done: 4, total: 9, reason: "limit" } }),
      );
      r.emit();
      r.fire();
      await flush();
      expect(r.calls).toEqual(["things"]);
      expect(r.store.status()?.progress.state).toBe("reading");
      // No further push comes; the status is read when it is old enough all the same.
      expect(r.pending()).toBe(1);
      r.fire();
      await flush();
      expect(r.calls).toEqual(["things", "status"]);
      expect(r.store.status()?.progress.reason).toBe("limit");
      dispose();
    }));

  it("reads the status of a long reading once per STATUS_AGE_MS while Matters is not shown", () =>
    createRoot(async (dispose) => {
      let clock = NOW;
      let timers: { at: number; run: () => void }[] = [];
      const listeners: ((e: { type: string; status?: true }) => void)[] = [];
      let reads = 0;
      let done = 0;
      const backend = {
        agentStatus: async () => {
          reads += 1;
          return status({ progress: { state: "reading", done, total: 100_000 } });
        },
        agentThings: async () => ({ things: [], total: 0 }),
        openThread: async () => ({ thread: {}, messages: [] }),
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
      expect(done - (store.status()?.progress.done ?? 0)).toBeLessThanOrEqual(
        STATUS_AGE_MS / 250 + 2,
      );
      dispose();
    }));

  it("opens Matters on the status a push skipped", () =>
    createRoot(async (dispose) => {
      const r = rig();
      r.setShownStatus(status({ progress: { state: "reading", done: 3, total: 9 } }));
      await r.store.start();
      r.setShownStatus(status({ progress: { state: "reading", done: 5, total: 9 } }));
      r.emit();
      r.fire();
      await flush();
      r.calls.length = 0;
      r.store.setShown(true);
      await flush();
      expect(r.calls).toEqual(["status"]);
      expect(r.store.status()?.progress.done).toBe(5);
      expect(r.pending()).toBe(0);
      dispose();
    }));

  it("sends only by agentDraftFromPrepared, then requestSend", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      const t = r.store.selected() as Thing;
      r.calls.length = 0;
      expect(await r.store.send(t, "Hello")).toBe("sent");
      expect(r.calls).toEqual(["draft:t1:Hello", "requestSend:d1"]);
      expect(r.opened).toEqual([]);
      expect(r.store.things().map((x) => x.threadId)).toEqual(["t2"]);
      dispose();
    }));

  describe("what the window hides is a bridge the backend confirms (ADR 0112)", () => {
    it("a sent thing stays out while the backend leaves it out, and returns when it lists it", () =>
      createRoot(async (dispose) => {
        const r = rig();
        await r.store.start();
        expect(await r.store.send(r.store.selected() as Thing, "Hello")).toBe("sent");
        expect(r.store.count()).toBe(1);
        // The reply is in the outbox: the backend's list leaves it out, and so does the count.
        r.setList([thing("t2")]);
        await r.store.refresh();
        expect(r.store.things().map((t) => t.threadId)).toEqual(["t2"]);
        expect(r.store.count()).toBe(1);
        // The send was undone or failed: the backend lists it, and the window shows it.
        r.setList([thing("t1"), thing("t2")]);
        await r.store.refresh();
        expect(r.store.things().map((t) => t.threadId)).toEqual(["t1", "t2"]);
        expect(r.store.count()).toBe(2);
        dispose();
      }));

    it("a read asked after the action has the last word, even when it still lists the thing", () =>
      createRoot(async (dispose) => {
        const r = rig();
        await r.store.start();
        await r.store.send(r.store.selected() as Thing, "Hello");
        // The backend did not take it out: the window does not keep a number of its own.
        await r.store.refresh();
        expect(r.store.things().map((t) => t.threadId)).toEqual(["t1", "t2"]);
        expect(r.store.count()).toBe(2);
        dispose();
      }));

    it("a read already asked when the person acted does not bring the thing back", () =>
      createRoot(async (dispose) => {
        const r = rig();
        await r.store.start();
        const open = r.holdThings();
        const early = r.store.refresh();
        await flush();
        await r.store.send(r.store.selected() as Thing, "Hello");
        r.setList([thing("t2")]);
        open();
        await early;
        // That read was asked before the send and still had t1: it stays out.
        expect(r.store.things().map((t) => t.threadId)).toEqual(["t2"]);
        expect(r.store.count()).toBe(1);
        await r.store.refresh();
        expect(r.store.things().map((t) => t.threadId)).toEqual(["t2"]);
        expect(r.store.count()).toBe(1);
        dispose();
      }));

    it("a moved thing is out until the move is recorded, and an undone move brings it back", () =>
      createRoot(async (dispose) => {
        const r = rig();
        await r.store.start();
        r.store.hide(["t1"]);
        // Not recorded yet: a read in between keeps it out.
        await r.store.refresh();
        expect(r.store.things().map((t) => t.threadId)).toEqual(["t2"]);
        r.store.recorded(["t1"]);
        r.setList([thing("t2")]);
        await r.store.refresh();
        expect(r.store.count()).toBe(1);
        // Undo of the move from the tray: the backend lists it again, and so does the window.
        r.setList([thing("t1"), thing("t2")]);
        await r.store.refresh();
        expect(r.store.things().map((t) => t.threadId)).toEqual(["t1", "t2"]);
        expect(r.store.count()).toBe(2);
        dispose();
      }));

    it("feedback is out until it is recorded, then the backend's list decides", () =>
      createRoot(async (dispose) => {
        const r = rig();
        await r.store.start();
        expect(await r.store.feedback(r.store.selected() as Thing, "later")).toBe(true);
        await r.store.refresh();
        expect(r.store.things().map((t) => t.threadId)).toEqual(["t2"]);
        expect(r.store.count()).toBe(1);
        dispose();
      }));
  });

  it("opens an existing draft in the composer and never sends it", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.setExisting(true);
      r.calls.length = 0;
      expect(await r.store.send(r.store.selected() as Thing, "Hello")).toBe("openedExisting");
      expect(r.calls).toEqual(["draft:t1:Hello"]);
      expect(r.opened).toEqual(["d1"]);
      dispose();
    }));

  it("Edit myself opens the composer on the draft and turns the frame solid", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      const t = r.store.selected() as Thing;
      expect(await r.store.editMyself(t, "Text")).toBe("took");
      expect(r.opened).toEqual(["d1"]);
      expect(r.store.tookOver("t1")).toBe("Text");
      expect(r.calls.some((c) => c.startsWith("requestSend"))).toBe(false);
      dispose();
    }));

  it("records feedback with a line, and Undo takes it back", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      await r.store.feedback(r.store.selected() as Thing, "notImportant");
      expect(r.calls).toContain("feedback:t1:notImportant");
      expect(r.store.line()?.text).toBe("Marked not important");
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t2"]);
      await r.store.undoFeedback();
      expect(r.calls).toContain("undo:t1:notImportant");
      expect(r.store.line()).toBeNull();
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t1", "t2"]);
      expect(FEEDBACK_UNDO_MS).toBeGreaterThan(0);
      dispose();
    }));

  it("passes the closed kind through, with its own line and Undo", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      await r.store.feedback(r.store.selected() as Thing, "closed");
      expect(r.calls).toContain("feedback:t1:closed");
      expect(r.store.line()).toMatchObject({ kind: "closed", text: "Closed, no reply needed" });
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t2"]);
      await r.store.undoFeedback();
      expect(r.calls).toContain("undo:t1:closed");
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t1", "t2"]);
      dispose();
    }));

  it("makes a rule about a kind of mail from a thing: the row goes, the line says so, Undo brings it back (ADR 0068)", () =>
    createRoot(async (dispose) => {
      const r = rig([thing("t1", { category: "offer" }), thing("t2")]);
      await r.store.start();
      const first = r.store.selected() as Thing;
      const [choice] = notLikeThisChoices(first);
      expect(choice).toMatchObject({ id: "category", category: "offer" });
      expect(await r.store.notLikeThis(first, choice as NonNullable<typeof choice>)).toBe(true);
      expect(r.ruleCalls).toContain('add:{"scope":"category","subject":"offer"}');
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t2"]);
      expect(r.store.line()).toMatchObject({
        kind: "remembered",
        text: "Remembered: Don't show offers",
      });
      await r.store.undoFeedback();
      expect(r.rememberCalls).toContain("removeRule:8");
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t1", "t2"]);
      dispose();
    }));

  it("makes a rule for the sender through the existing path, and says why when it cannot (ADR 0068)", () =>
    createRoot(async (dispose) => {
      const r = rig([thing("t1"), thing("t2")]);
      await r.store.start();
      const first = r.store.selected() as Thing;
      const sender = notLikeThisChoices(first).find((c) => c.id === "sender");
      expect(await r.store.notLikeThis(first, sender as NonNullable<typeof sender>)).toBe(true);
      expect(r.ruleCalls).toContain('add:{"threadId":"t1","scope":"sender"}');
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t2"]);
      dispose();
    }));

  it("keeps the person's own words as an instruction for what is read from now on, and leaves the row (ADR 0068)", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      const first = r.store.selected() as Thing;
      expect(await r.store.notLikeThisWords(first, "   ")).toBe(false);
      expect(await r.store.notLikeThisWords(first, "  No offers about accounting ")).toBe(true);
      expect(r.rememberCalls).toContain("addInstruction:understand:No offers about accounting");
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t1", "t2"]);
      expect(r.store.line()?.text).toBe("Remembered: No offers about accounting");
      await r.store.undoFeedback();
      expect(r.rememberCalls).toContain("removeInstruction:9");
      dispose();
    }));

  it("says what a closing meant, with its own line, and offers no rule for it (ADR 0066, rule 7)", () =>
    createRoot(async (dispose) => {
      const r = rig([thing("t1", { intent: "decide" }), thing("t2", { intent: "act" })]);
      await r.store.start();
      await r.store.feedback(r.store.selected() as Thing, "closed", "declined");
      expect(r.calls).toContain("feedback:t1:closed:declined");
      expect(r.store.line()).toMatchObject({ kind: "closed", text: "Declined for this year" });
      await r.store.undoFeedback();
      expect(r.calls).toContain("undo:t1:closed");
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t1", "t2"]);
      await r.store.feedback(r.store.selected() as Thing, "closed", "taken");
      expect(r.store.line()?.text).toBe("Marked as taken");
      await r.store.feedback(r.store.selected() as Thing, "closed", "done");
      expect(r.store.line()?.text).toBe("Marked done");
      // Closing something done is not a no to the sender: nothing is asked about a rule.
      expect(r.ruleCalls).toEqual([]);
      dispose();
    }));

  it("treats a closing from the talk like any closing: gone, with its line and Undo", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.store.talkMade("t1", "closed", "You spoke on the phone", "this is done", "Anna waits");
      expect(r.store.line()).toMatchObject({
        kind: "closed",
        text: "Closed: You spoke on the phone",
      });
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t2"]);
      expect(r.rememberCalls).toEqual(["remember:t1:this is done"]);
      dispose();
    }));

  it("says how many older mails a closing from the talk hid (ADR 0065)", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.store.talkMade("t1", "closed", "You spoke on the phone", "this is done", "Anna waits", 3);
      expect(r.store.line()).toMatchObject({
        text: "Closed: You spoke on the phone · also 3 older mails",
      });
      dispose();
    }));

  it("names the writing model for a draft from the talk, and spends nothing on an answer", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.store.talkMade("t1", "answer", "She wants a date", "what does she want?", "Anna waits");
      expect(r.store.askedFor("t1")).toBe(false);
      expect(r.rememberCalls).toEqual([]);
      r.store.talkMade("t1", "draft", "", "36,000 net", "Anna waits");
      expect(r.store.askedFor("t1")).toBe(true);
      expect(r.store.givenFor("t1")).toEqual(["36,000 net"]);
      expect(r.rememberCalls).toEqual(["remember:t1:36,000 net"]);
      dispose();
    }));

  it("offers a rule for the sender after a closing, and the click turns the line into the rule's words", () =>
    createRoot(async (dispose) => {
      const r = rig();
      r.setOffer({ scope: "sender", subject: "alerts@x.com" });
      await r.store.start();
      await r.store.feedback(r.store.selected() as Thing, "closed");
      // The line is there at once; the offer joins it when the read answers.
      expect(r.store.line()).toMatchObject({ kind: "closed", text: "Closed, no reply needed" });
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

  it("offers the rule after a closing in the person's words too, but not after Later", () =>
    createRoot(async (dispose) => {
      const r = rig([thing("t1"), thing("t2"), thing("t3")]);
      r.setOffer({ scope: "sender", subject: "alerts@x.com" });
      await r.store.start();
      // Later sets nothing aside for good. Whether a no adds up to a rule is for the backend.
      await r.store.feedback(r.store.selected() as Thing, "later");
      await flush();
      expect(r.store.line()?.offer).toBeUndefined();
      expect(r.ruleCalls).toEqual([]);
      r.setPrepared({ kind: "closed", reason: "Automatic" });
      await r.store.prepare(r.store.selected()?.threadId ?? "", { answer: "no reply" });
      await flush();
      expect(r.ruleCalls).toHaveLength(1);
      expect(r.store.line()?.offer).toEqual({ scope: "sender", subject: "alerts@x.com" });
      dispose();
    }));

  it("makes no offer when there is none, and keeps the line and the offer when adding fails", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      await r.store.feedback(r.store.selected() as Thing, "closed");
      await flush();
      expect(r.store.line()?.offer).toBeUndefined();
      await r.store.addRuleFromLine();
      expect(r.ruleCalls).toEqual(["offer:t1"]);
      r.setOffer({ scope: "sender", subject: "me@example.com" });
      r.failRules(true);
      await r.store.feedback(r.store.selected() as Thing, "closed");
      await flush();
      await r.store.addRuleFromLine();
      expect(r.store.line()).toMatchObject({
        text: "That rule could not be added.",
        offer: { subject: "me@example.com" },
      });
      dispose();
    }));

  it("hides a thing the agent closed from the person's words, says why, and Undo returns it", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      const t = r.store.selected() as Thing;
      r.setPrepared({ kind: "closed", reason: "<b>Automatic</b> notification" });
      await r.store.prepare("t1", { answer: "don't write" });
      // Nothing is kept as made work, and the thing is gone from the list.
      expect(r.store.preparedOf(t)).toBeUndefined();
      expect(r.store.askedFor("t1")).toBe(false);
      expect(r.store.things().map((x) => x.threadId)).toEqual(["t2"]);
      expect(r.store.selected()?.threadId).toBe("t2");
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
      expect(r.store.things().map((x) => x.threadId)).toEqual(["t1", "t2"]);
      dispose();
    }));

  it("says how many older mails the agent's closing also hid (ADR 0065)", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.setPrepared({ kind: "closed", reason: "Automatic", alsoCovers: 3 });
      await r.store.prepare("t1", { answer: "don't write" });
      expect(r.store.line()?.text).toBe("Closed: Automatic · also 3 older mails");
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
        const r = rig([thing("t1"), thing("t2"), thing("t3")]);
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
        const t = r.store.selected() as Thing;
        await r.store.prepare("t1", { answer: "zawsze pisz krótko" });
        // The turn was asked and has not answered: the draft is there and nothing waits.
        expect(r.rememberCalls).toEqual(["remember:t1:zawsze pisz krótko"]);
        expect(r.store.preparedOf(t)).toMatchObject({ kind: "draft", body: "B" });
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
        // The thing stays where it was: nothing was hidden.
        expect(r.store.things().map((t) => t.threadId)).toContain("t1");
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
        expect(r.store.askedFor("t2")).toBe(true);
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

  it("reads Write the draft once a way forward is chosen, and Answer until then", () => {
    expect(questionButtonText(false, true)).toBe("Write the draft");
    expect(questionButtonText(false, false)).toBe("Answer");
    expect(questionButtonText(true, true)).toBe("Writing…");
    expect(questionButtonText(true, false)).toBe("Writing…");
  });

  it("holds a made draft until the list carries it, and keeps the words given", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      const t = r.store.selected() as Thing;
      await r.store.prepare("t1", { answer: "Friday" });
      expect(r.store.preparedOf(t)).toMatchObject({ kind: "draft", body: "B" });
      expect(r.store.givenFor("t1")).toEqual(["Friday"]);
      expect(r.store.askedFor("t1")).toBe(true);
      dispose();
    }));

  it("does not rearrange the list after the person acts, until they leave and come back", () =>
    createRoot(async (dispose) => {
      const [a, b, c, d] = ["a", "b", "c", "d"].map((id) => thing(id)) as [
        Thing,
        Thing,
        Thing,
        Thing,
      ];
      const r = rig([a, b, c, d]);
      await r.store.start();
      r.store.setShown(true);
      await r.store.feedback(b, "closed");
      // What closing it changed moves c below d in the ranking.
      r.setList([a, d, c]);
      r.emit();
      r.fire();
      await flush();
      expect(r.store.things().map((t) => t.threadId)).toEqual(["a", "c", "d"]);

      // Something new still shows.
      r.setList([thing("new"), a, d, c]);
      r.emit();
      r.fire();
      await flush();
      expect(r.store.things().map((t) => t.threadId)).toEqual(["new", "a", "c", "d"]);

      r.store.setShown(false);
      r.store.setShown(true);
      await flush();
      expect(r.store.things().map((t) => t.threadId)).toEqual(["new", "a", "d", "c"]);
      dispose();
    }));

  it("leaves the list to the ranking until the person acts", () =>
    createRoot(async (dispose) => {
      const [a, b] = [thing("a"), thing("b")];
      const r = rig([a, b]);
      await r.store.start();
      r.setList([b, a]);
      r.emit();
      r.fire();
      await flush();
      expect(r.store.things().map((t) => t.threadId)).toEqual(["b", "a"]);
      dispose();
    }));

  it("puts a thing back in its place on Undo", () =>
    createRoot(async (dispose) => {
      const list = [thing("a"), thing("b"), thing("c")];
      const r = rig(list);
      await r.store.start();
      await r.store.feedback(list[1] as Thing, "closed");
      await r.store.undoFeedback();
      await flush();
      expect(r.store.things().map((t) => t.threadId)).toEqual(["a", "b", "c"]);
      dispose();
    }));

  it("opens the first thing by itself, and keeps it open when a better one arrives", () =>
    createRoot(async (dispose) => {
      const r = rig([thing("t2")]);
      await r.store.start();
      expect(r.store.selected()?.threadId).toBe("t2");
      expect(r.store.chose()).toBe(false);
      r.setList([thing("t1", { score: 9 }), thing("t2")]);
      r.emit();
      r.fire();
      await flush();
      expect(r.store.things().map((t) => t.threadId)).toEqual(["t1", "t2"]);
      // The list grew above it; what the person has open does not change under them.
      expect(r.store.selected()?.threadId).toBe("t2");
      expect(r.store.selectedId()).toBe("t2");
      dispose();
    }));

  it("does not take a choice back when rows arrive or reorder", () =>
    createRoot(async (dispose) => {
      const r = rig([thing("t1"), thing("t2"), thing("t3")]);
      await r.store.start();
      r.store.select("t3");
      expect(r.store.chose()).toBe(true);
      r.setList([thing("t3"), thing("t0"), thing("t1"), thing("t2")]);
      r.emit();
      r.fire();
      await flush();
      expect(r.store.selected()?.threadId).toBe("t3");
      expect(r.store.chose()).toBe(true);
      dispose();
    }));

  it("opens the row where the person was, as no choice, when the open one is gone", () =>
    createRoot(async (dispose) => {
      const r = rig([thing("t1"), thing("t2"), thing("t3")]);
      await r.store.start();
      r.store.select("t2");
      r.setList([thing("t1"), thing("t3")]);
      r.emit();
      r.fire();
      await flush();
      expect(r.store.selected()?.threadId).toBe("t3");
      expect(r.store.chose()).toBe(false);
      // The end of the list has nothing under it.
      r.store.select("t3");
      r.setList([thing("t1")]);
      r.emit();
      r.fire();
      await flush();
      expect(r.store.selected()?.threadId).toBe("t1");
      expect(r.store.chose()).toBe(false);
      dispose();
    }));

  it("opens nothing while there is nothing, then the first thing when it arrives", () =>
    createRoot(async (dispose) => {
      const r = rig([]);
      await r.store.start();
      expect(r.store.selected()).toBeUndefined();
      r.setList([thing("t1")]);
      r.emit();
      r.fire();
      await flush();
      expect(r.store.selected()?.threadId).toBe("t1");
      dispose();
    }));

  it("answers a burst of pushes with one read, and nothing is redrawn when nothing changed", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.store.setShown(true);
      const first = r.store.things()[0];
      r.calls.length = 0;
      for (let i = 0; i < 50; i++) r.emit();
      expect(r.pending()).toBe(1);
      r.fire();
      await flush();
      expect([...r.calls].sort()).toEqual(["status", "things"]);
      // The same answer gives the same objects: no signal fired for the rows.
      expect(r.store.things()[0]).toBe(first);
      dispose();
    }));

  it("sends the reading screen's buttons to the backend and shows what they return", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      r.calls.length = 0;
      await r.store.pauseReading();
      await r.store.resumeReading();
      await r.store.lookAgain();
      await r.store.tryAgain();
      expect(r.calls.filter((c) => c !== "things")).toEqual(["pause", "resume", "inspect", "test"]);
      dispose();
    }));

  it("reads further back one step at a time, and stops at the last", () =>
    createRoot(async (dispose) => {
      const r = rig();
      await r.store.start();
      await r.store.readFurtherBack();
      expect(r.calls).toContain("window:90");
      expect(r.store.status()?.settings.windowDays).toBe(90);
      r.calls.length = 0;
      await r.store.readFurtherBack();
      expect(r.calls.some((c) => c.startsWith("window:"))).toBe(false);
      dispose();
    }));
});

const reading = (over: Partial<AgentStatus["progress"]> = {}, found = 2): AgentStatus =>
  status({
    progress: { state: "reading", done: 12, total: 214, found, ...over },
  });
const withLimits = (s: AgentStatus, limits: AgentStatus["settings"]["limits"]): AgentStatus => ({
  ...s,
  settings: { ...s.settings, ...(limits === undefined ? { limits: undefined } : { limits }) },
});

describe("the reading screen: what it says", () => {
  it("says nothing while AI is off or nothing is known", () => {
    expect(readingScreen(null, NOW)).toBeNull();
    const off = status();
    expect(
      readingScreen({ ...off, settings: { ...off.settings, enabled: false } }, NOW),
    ).toBeNull();
    expect(
      readingScreen(
        status({ progress: { state: "off", done: 0, total: 0, reason: "disabled" } }),
        NOW,
      ),
    ).toBeNull();
  });

  it("says the runtime is being checked, with a ring that only breathes", () => {
    const s = readingScreen(status({ progress: { state: "checking", done: 0, total: 0 } }), NOW);
    expect(s).toMatchObject({ kind: "checking", title: "Checking Claude Code", ring: null });
    expect(s?.actions).toEqual([]);
  });

  it("says how far the reading is, what it found, the time left and the plan left", () => {
    const s = readingScreen(reading({ etaMs: 8 * 60_000 }), NOW);
    expect(s).toMatchObject({ kind: "reading", title: "Reading your last 30 days" });
    expect(s?.lines).toEqual([
      "Read 12 of 214 threads · found 2 things so far",
      "About 8 minutes left · 61% of your session left",
      "You can keep using your mail. I'll show things here as I find them.",
    ]);
    expect(s?.actions).toEqual(["pause", "openAllMail"]);
    expect(s?.ring).toBeCloseTo(12 / 214);
  });

  it("says it is estimating before the measurement exists, and leaves the plan out when unknown", () => {
    const s = readingScreen(reading(), NOW);
    expect(s?.lines[1]).toBe("Estimating time left · 61% of your session left");
    const unknown = readingScreen(withLimits(reading(), undefined), NOW);
    expect(unknown?.lines[1]).toBe("Estimating time left");
    const measured = readingScreen(withLimits(reading({ etaMs: 90_000 }), undefined), NOW);
    expect(measured?.lines[1]).toBe("About 2 minutes left");
  });

  it("uses the real window and the real numbers", () => {
    const s = status({ progress: { state: "reading", done: 0, total: 1, found: 0 } });
    const wide = { ...s, settings: { ...s.settings, windowDays: 90 } };
    const screen = readingScreen(wide, NOW);
    expect(screen?.title).toBe("Reading your last 90 days");
    expect(screen?.lines[0]).toBe("Read 0 of 1 thread · found nothing yet");
  });

  it("says how long is left the way a person would", () => {
    expect(etaText(20_000)).toBe("Less than a minute left");
    expect(etaText(60_000)).toBe("About 1 minute left");
    expect(etaText(8 * 60_000 + 20_000)).toBe("About 8 minutes left");
    expect(etaText(3 * 3_600_000)).toBe("About 3 hours left");
    expect(etaText(2 * 86_400_000)).toBe("More than a day left");
    expect(foundText(0)).toBe("found nothing yet");
    expect(foundText(1)).toBe("found 1 thing so far");
    expect(sessionLeftText(undefined, NOW)).toBe("");
  });

  it("says a pause of the person's, how far it got, and offers Continue", () => {
    const s = readingScreen(
      status({
        progress: { state: "paused", reason: "pausedByPerson", done: 12, total: 214, found: 1 },
      }),
      NOW,
    );
    expect(s).toMatchObject({ kind: "pausedByPerson", title: "Paused" });
    expect(s?.lines[0]).toBe("Read 12 of 214 threads · found 1 thing so far");
    expect(s?.actions).toEqual(["resume", "openAllMail"]);
  });

  it("says until when and which limit when the plan paused it", () => {
    const at = new Date(2026, 10, 5, 14, 0).getTime();
    const now = new Date(2026, 10, 5, 10, 0).getTime();
    const paused = (reason: NonNullable<AgentStatus["progress"]["reason"]>) =>
      readingScreen(
        status({ progress: { state: "paused", reason, untilMs: at, done: 5, total: 9, found: 0 } }),
        now,
      );
    expect(paused("sessionLimit")).toMatchObject({
      kind: "pausedByPlan",
      title: "Paused until 14:00",
      actions: ["openSettings"],
    });
    expect(paused("sessionLimit")?.lines[0]).toBe(
      "The session limit of your Claude plan is reached.",
    );
    expect(paused("weekLimit")?.lines[0]).toBe("The weekly limit of your Claude plan is reached.");
    expect(paused("overage")?.lines[0]).toContain("allowance is used up");
    expect(paused("budget")?.lines[0]).toContain("my share of your plan's week (10%)");
    const noTime = readingScreen(
      status({ progress: { state: "paused", reason: "budget", done: 1, total: 2 } }),
      now,
    );
    expect(noTime?.title).toBe("Paused");
  });

  it("says what to run when the program is signed out or missing, and never starts a login", () => {
    const out = readingScreen(
      status({
        progress: { state: "off", done: 0, total: 0, reason: "signedOut", problem: "x" },
        runtime: {
          id: "claude-code",
          name: "Claude Code",
          status: "signedOut",
          models: [],
        },
      }),
      NOW,
    );
    expect(out).toMatchObject({
      kind: "signedOut",
      title: "Claude Code is not signed in",
      command: SIGN_IN_COMMAND,
      actions: ["copy", "lookAgain"],
    });
    const paused = readingScreen(
      status({ progress: { state: "paused", reason: "notPlan", done: 0, total: 0 } }),
      NOW,
    );
    expect(paused?.title).toBe("Claude Code is not using your Claude plan");
    const gone = readingScreen(
      status({
        progress: { state: "off", done: 0, total: 0, reason: "runtime" },
        runtime: { id: "claude-code", name: "Claude Code", status: "missing", models: [] },
      }),
      NOW,
    );
    expect(gone).toMatchObject({ kind: "missing", actions: ["copy", "lookAgain"] });
    // Nothing on the screen can start a login: only these actions exist.
    const all = new Set([out, paused, gone].flatMap((x) => x?.actions ?? []));
    expect([...all].sort()).toEqual(["copy", "lookAgain"]);
  });

  it("gives the reason and Try again when the test failed", () => {
    const s = readingScreen(
      status({
        progress: {
          state: "off",
          done: 0,
          total: 0,
          reason: "runtime",
          problem: "The assistant answered, but not in the form the app needs.",
        },
        runtime: {
          id: "claude-code",
          name: "Claude Code",
          status: "failed",
          models: [],
        },
      }),
      NOW,
    );
    expect(s).toMatchObject({
      kind: "failed",
      title: "Claude Code did not pass its check",
      lines: ["The assistant answered, but not in the form the app needs."],
      actions: ["tryAgain"],
    });
  });

  it("says the window is empty and offers to read further back, until there is no further", () => {
    const empty = (days: number) => {
      const s = status({
        progress: { state: "idle", done: 0, total: 0, windowEmpty: true, found: 0 },
      });
      return readingScreen({ ...s, settings: { ...s.settings, windowDays: days } }, NOW);
    };
    expect(empty(30)).toMatchObject({
      kind: "windowEmpty",
      title: "Nothing to read in the last 30 days",
      actions: ["readFurtherBack"],
    });
    expect(empty(14)?.actions).toEqual(["readFurtherBack"]);
    expect(empty(90)?.actions).toEqual([]);
    expect(nextWindow(14)).toBe(30);
    expect(nextWindow(30)).toBe(90);
    expect(nextWindow(90)).toBeUndefined();
  });

  it("says how many threads were read when nothing needs the person", () => {
    const s = readingScreen(
      status({ progress: { state: "idle", done: 214, total: 214, found: 0 } }),
      NOW,
    );
    expect(s).toMatchObject({
      kind: "finished",
      title: "Read 214 threads. Nothing needs you right now.",
      actions: [],
    });
    const some = readingScreen(
      status({ progress: { state: "idle", done: 213, total: 214, found: 0 } }),
      NOW,
    );
    expect(some?.title).toBe("Read 213 of 214 threads. Nothing needs you right now.");
    // With something found the reader has a thing to show.
    expect(
      readingScreen(status({ progress: { state: "idle", done: 3, total: 3, found: 2 } }), NOW),
    ).toBeNull();
  });

  it("never says 'Nothing here.' in any state", () => {
    const states: AgentStatus[] = [
      status({ progress: { state: "checking", done: 0, total: 0 } }),
      reading(),
      reading({ state: "paused", reason: "pausedByPerson" }),
      status({ progress: { state: "paused", reason: "sessionLimit", done: 1, total: 2 } }),
      status({ progress: { state: "off", done: 0, total: 0, reason: "runtime" } }),
      status({ progress: { state: "idle", done: 0, total: 0, windowEmpty: true } }),
      status({ progress: { state: "idle", done: 3, total: 3, found: 0 } }),
    ];
    for (const s of states) {
      const screen = readingScreen(s, NOW);
      expect(JSON.stringify(screen)).not.toContain("Nothing here");
    }
  });
});

describe("the tab", () => {
  it("shows how far the reading is while it reads, with the count of things in the label", () => {
    expect(mattersTab(2, { state: "reading", done: 12, total: 214 })).toEqual({
      badge: "12/214",
      spoken: ", reading 12 of 214 threads, 2 things found",
    });
    expect(mattersTab(0, { state: "reading", done: 0, total: 1 })).toEqual({
      badge: "0/1",
      spoken: ", reading 0 of 1 thread",
    });
  });
  it("shows the plain count otherwise", () => {
    expect(mattersTab(1, { state: "idle", done: 1, total: 1 })).toEqual({
      badge: "1",
      spoken: ", 1 thing",
    });
    expect(mattersTab(0, { state: "paused", done: 1, total: 4, reason: "pausedByPerson" })).toEqual(
      {
        badge: undefined,
        spoken: "",
      },
    );
    expect(mattersTab(2, undefined).badge).toBe("2");
  });
});
