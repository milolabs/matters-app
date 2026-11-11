import type {
  AgentStatus,
  FeedbackJournalEntry,
  InstructionJournalEntry,
  RuleJournalEntry,
} from "@matters/core";
import { describe, expect, it } from "vitest";
import {
  EFFORT_WORDS,
  effortOptions,
  effortShown,
  journalLine,
  journalLines,
  ledgerEffort,
  ourShare,
  planButton,
  questionButtonText,
  ruleText,
  splitYours,
  writtenByLine,
} from "../src/renderer/agentText.ts";

const NOW = Date.UTC(2026, 10, 5, 10, 42);
const models = { understand: "haiku", write: "sonnet", answer: "sonnet", titles: "haiku" };
const status = (over: Partial<AgentStatus> = {}): AgentStatus => ({
  settings: {
    enabled: true,
    runtimeId: "claude-code",
    models,
    efforts: { understand: "low", write: "default", answer: "default", titles: "low" },
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
        reason: "sessionLimit",
        untilMs: new Date(2026, 10, 5, 14, 0).getTime(),
      },
    });
    expect(planButton(paused, new Date(2026, 10, 5, 10, 0).getTime()).text).toBe(
      "Paused until 14:00 · plan limit",
    );
  });

  it("says our share and who wrote a draft: always the writing model", () => {
    expect(ourShare(status())).toBe("Matters this week: about 4% of Claude");
    expect(writtenByLine(status().runtime, models)).toBe("Claude Code, Sonnet, your plan");
    expect(writtenByLine(null, { ...models, write: "opus" })).toBe("Agent, Opus, your plan");
  });

  it("reads Write the draft once a way forward is chosen, and Answer until then", () => {
    expect(questionButtonText(false, true)).toBe("Write the draft");
    expect(questionButtonText(false, false)).toBe("Answer");
    expect(questionButtonText(true, true)).toBe("Writing…");
    expect(questionButtonText(true, false)).toBe("Writing…");
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

  it("describes a rule about a kind in the person's words (ADR 0068, rule 3)", () => {
    expect(ruleText({ scope: "category", subject: "offer" })).toBe("Don't show offers");
    expect(ruleText({ scope: "category", subject: "official" })).toBe(
      "Don't show mail from public offices",
    );
    expect(ruleText({ scope: "sender", subject: "a@b.example" })).toBe(
      "No reply needed from a@b.example",
    );
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

describe("the effort beside each model (ADR 0118)", () => {
  const all = { efforts: ["low", "medium", "high", "xhigh", "max"] } as const;

  it("offers Default and only the levels the runtime lists, lowest first (rule 4)", () => {
    expect(effortOptions(all)).toEqual([
      ["default", "Default"],
      ["low", "Low"],
      ["medium", "Medium"],
      ["high", "High"],
      ["xhigh", "Extra high"],
      ["max", "Max"],
    ]);
    expect(effortOptions({ efforts: ["high", "low"] })).toEqual([
      ["default", "Default"],
      ["low", "Low"],
      ["high", "High"],
    ]);
  });

  it("offers nothing, so no control shows, when the runtime lists none or is not known", () => {
    expect(effortOptions({ efforts: [] })).toEqual([]);
    expect(effortOptions({})).toEqual([]);
    expect(effortOptions(null)).toEqual([]);
  });

  it("shows a stored level the runtime does not list as Default, which is what is sent", () => {
    expect(effortShown("max", { efforts: ["low", "medium"] })).toBe("default");
    expect(effortShown("medium", { efforts: ["low", "medium"] })).toBe("medium");
    expect(effortShown("default", all)).toBe("default");
  });

  it("names the effort of a ledger line, and nothing for a line without one (rule 7)", () => {
    expect(ledgerEffort({ effort: "xhigh" })).toBe("extra high effort");
    expect(ledgerEffort({ effort: "low" })).toBe("low effort");
    expect(ledgerEffort({})).toBe("");
    expect(EFFORT_WORDS.default).toBe("Default");
  });
});
