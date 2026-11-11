import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { visibleText } from "@matters/adapter-mime";
import { createSqliteStorage } from "@matters/adapter-sqlite";
import type { AgentStatus, StoredAccount, ThreadAnalysis } from "@matters/core";
import { ANALYZER_VERSION, buildAnalysisRequest } from "@matters/core";
import { ManualClock, settle } from "@matters/testkit";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AgentApi,
  AgentUnavailableError,
  InvalidAgentSettingError,
  ThingNotFoundError,
} from "../src/backend/agentApi.ts";
import { agentEnv, extraBinDirs } from "../src/backend/agentEnv.ts";
import { AgentService, KICK_DEBOUNCE_MS } from "../src/backend/agentService.ts";
import { DemoAgentRuntime } from "../src/backend/demoAgent.ts";
import { type BackendDeps, handle } from "../src/backend/handler.ts";
import { readsHere } from "../src/backend/heavyReads.ts";
import { RemoteAgent } from "../src/backend/remoteAgent.ts";
import { ACCOUNT_ID, generateMailbox, SEED_NOW_MS } from "../src/backend/seed.ts";
import type { SyncHost } from "../src/backend/syncHost.ts";

const cleanups: (() => unknown)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
});

const status: AgentStatus = {
  settings: {
    enabled: false,
    models: {
      understand: "haiku",
      draftAhead: "haiku",
      write: "sonnet",
      answer: "sonnet",
      titles: "haiku",
    },
    windowDays: 30,
    weekSharePercent: 10,
    usedByUsPercent: 0,
  },
  runtime: null,
  consents: [],
  progress: { state: "off", done: 0, total: 0, reason: "disabled" },
  ledger: [],
};

const promptOff = {
  ai: "off",
  promptKey: "",
  searched: false,
  found: 0,
  read: 0,
  fits: 0,
} as const;

/** An AgentApi that records what it was asked and answers from a table. */
function stub(overrides: Partial<AgentApi> = {}) {
  const calls: [string, ...unknown[]][] = [];
  const note =
    <T>(name: string, value: T) =>
    async (...args: unknown[]) => {
      calls.push([name, ...args]);
      return value;
    };
  const api: AgentApi = {
    status: note("status", status),
    things: note("things", { things: [], total: 0 }),
    prepared: note("prepared", null),
    threadAgent: note("threadAgent", { available: true, reading: null, facts: [], prepared: null }),
    journal: note("journal", []),
    rules: note("rules", []),
    ruleOffer: note("ruleOffer", { scope: "sender", subject: "alerts@x.com" }),
    addRule: note("addRule", {
      id: 1,
      scope: "sender",
      subject: "alerts@x.com",
      action: "noReply",
      actor: "person",
      atMs: 1,
    }),
    removeRule: note("removeRule", undefined),
    instructions: note("instructions", []),
    addInstruction: note("addInstruction", {
      id: 4,
      scope: "write",
      text: "Write briefly",
      actor: "person",
      atMs: 1,
    }),
    removeInstruction: note("removeInstruction", undefined),
    remember: note("remember", { items: [] }),
    talk: note("talk", { entries: [] }),
    talkStop: note("talkStop", undefined),
    rewriteDraft: note("rewriteDraft", { text: "Short." }),
    answerQuestions: note("answerQuestions", { text: "Yes, Tuesday." }),
    checkReply: note("checkReply", { asked: 2, answered: 1, missing: ["who pays"] }),
    fillGaps: note("fillGaps", [
      { token: "[date]", value: "Tuesday", source: "Anna's message, 6 Nov" },
    ]),
    talkEntries: note("talkEntries", []),
    talkAll: note("talkAll", { entries: [] }),
    talkAllStop: note("talkAllStop", undefined),
    talkAllEntries: note("talkAllEntries", []),
    talks: note("talks", []),
    renameTalk: note("renameTalk", undefined),
    deleteTalk: note("deleteTalk", undefined),
    deleteAllTalks: note("deleteAllTalks", 0),
    readEstimate: note("readEstimate", { threads: 4, capped: false }),
    setEnabled: note("setEnabled", status),
    disable: note("disable", status),
    setModels: note("setModels", status),
    setWeekShare: note("setWeekShare", status),
    setWindowDays: note("setWindowDays", status),
    setTalkLoop: note("setTalkLoop", status),
    inspect: note("inspect", status),
    testRuntime: note("testRuntime", status),
    pauseReading: note("pauseReading", status),
    resumeReading: note("resumeReading", status),
    prepare: note("prepare", { kind: "draft", body: "Hi", nudge: false }),
    feedback: note("feedback", 0),
    undoFeedback: note("undoFeedback", undefined),
    revokeConsent: note("revokeConsent", status),
    draftFromPrepared: note("draftFromPrepared", { draftId: "d1", existing: false }),
    matchAct: note("matchAct", {
      messages: [{ key: 7, threadId: "t1", accountId: "a", subject: "S", seen: false }],
      capped: false,
    }),
    promptCount: note("promptCount", promptOff),
    promptVerdicts: note("promptVerdicts", { ...promptOff, rows: [] }),
    promptRun: note("promptRun", { ...promptOff, rows: [], stopped: false, rejected: 0 }),
    promptStop: note("promptStop", undefined),
    ...overrides,
  };
  const deps = { agent: api } as unknown as BackendDeps;
  return { api, calls, ask: (request: object) => handle(deps, { requestId: "r", ...request }) };
}

describe("agent requests", () => {
  it("passes a whole limit on to the list and refuses anything else", async () => {
    const { ask, calls } = stub();
    await ask({ type: "agentThings", limit: 50 });
    expect(calls.at(-1)).toEqual(["things", 50]);
    for (const limit of [0, -1, 1.5, "50"]) {
      expect(await ask({ type: "agentThings", limit })).toMatchObject({ code: "invalidRequest" });
    }
  });

  it("routes each request to the service with checked fields", async () => {
    const { ask, calls } = stub();
    expect(await ask({ type: "agentStatus" })).toMatchObject({
      type: "agentStatus",
      ok: true,
      status,
    });
    expect(await ask({ type: "agentThings" })).toMatchObject({
      type: "agentThings",
      things: [],
      total: 0,
    });
    expect(await ask({ type: "agentPrepared", threadId: "t1" })).toMatchObject({ prepared: null });
    expect(await ask({ type: "agentThread", threadId: "t1" })).toMatchObject({
      type: "agentThread",
      ok: true,
      view: { available: true, reading: null, facts: [], prepared: null },
    });
    expect(await ask({ type: "agentJournal" })).toMatchObject({
      type: "agentJournal",
      ok: true,
      entries: [],
    });
    await ask({ type: "agentJournal", limit: 20 });
    expect(
      await ask({ type: "agentReadEstimate", accountIds: ["a"], windowDays: 30 }),
    ).toMatchObject({ type: "agentReadEstimate", threads: 4, capped: false });
    expect(
      await ask({
        type: "agentSetEnabled",
        accountIds: ["a"],
        runtimeId: "claude-code",
        windowDays: 30,
      }),
    ).toMatchObject({ type: "agentSetEnabled", ok: true });
    expect(await ask({ type: "agentDisable" })).toMatchObject({ type: "agentDisable" });
    expect(await ask({ type: "agentSetModels", models: { write: "opus" } })).toMatchObject({
      type: "agentSetModels",
    });
    expect(await ask({ type: "agentSetWeekShare", percent: 15 })).toMatchObject({ ok: true });
    expect(await ask({ type: "agentSetWindowDays", days: 14 })).toMatchObject({ ok: true });
    expect(await ask({ type: "agentSetTalkLoop", on: true })).toMatchObject({ ok: true });
    expect(await ask({ type: "agentInspect" })).toMatchObject({ type: "agentInspect" });
    expect(await ask({ type: "agentTestRuntime" })).toMatchObject({ type: "agentTestRuntime" });
    expect(await ask({ type: "agentPauseReading" })).toMatchObject({ type: "agentPauseReading" });
    expect(await ask({ type: "agentResumeReading" })).toMatchObject({
      type: "agentResumeReading",
    });
    expect(
      await ask({
        type: "agentPrepare",
        threadId: "t1",
        direction: "Say yes",
        answer: "400 euros",
      }),
    ).toMatchObject({ type: "agentPrepare", prepared: { kind: "draft" } });
    expect(await ask({ type: "agentFeedback", threadId: "t1", kind: "later" })).toMatchObject({
      type: "agentFeedback",
      ok: true,
    });
    expect(await ask({ type: "agentUndoFeedback", threadId: "t1", kind: "later" })).toMatchObject({
      type: "agentUndoFeedback",
      ok: true,
    });
    expect(await ask({ type: "agentRevokeConsent", accountId: "a" })).toMatchObject({
      type: "agentRevokeConsent",
      ok: true,
      status,
    });
    expect(
      await ask({ type: "agentDraftFromPrepared", threadId: "t1", body: "Hello" }),
    ).toMatchObject({ type: "agentDraftFromPrepared", draftId: "d1", existing: false });
    expect(await ask({ type: "agentMatchAct", query: "from:news.test" })).toEqual({
      type: "agentMatchAct",
      requestId: "r",
      ok: true,
      messages: [{ key: 7, threadId: "t1", accountId: "a", subject: "S", seen: false }],
      capped: false,
    });
    expect(calls.map((c) => c[0])).toEqual([
      "status",
      "things",
      "prepared",
      "threadAgent",
      "journal",
      "journal",
      "readEstimate",
      "setEnabled",
      "disable",
      "setModels",
      "setWeekShare",
      "setWindowDays",
      "setTalkLoop",
      "inspect",
      "testRuntime",
      "pauseReading",
      "resumeReading",
      "prepare",
      "feedback",
      "undoFeedback",
      "revokeConsent",
      "draftFromPrepared",
      "matchAct",
    ]);
    expect(calls.filter((c) => c[0] === "journal")).toEqual([
      ["journal", undefined],
      ["journal", 20],
    ]);
    expect(calls.find((c) => c[0] === "prepare")).toEqual([
      "prepare",
      "t1",
      { direction: "Say yes", answer: "400 euros" },
    ]);
  });

  it("routes the rule requests, and takes a thread's sender from the store and not from the page", async () => {
    const { ask, calls } = stub();
    expect(await ask({ type: "agentRules" })).toMatchObject({ type: "agentRules", rules: [] });
    expect(await ask({ type: "agentRuleOffer", threadId: "t1" })).toMatchObject({
      type: "agentRuleOffer",
      offer: { scope: "sender", subject: "alerts@x.com" },
    });
    expect(await ask({ type: "agentAddRule", threadId: "t1", scope: "sender" })).toMatchObject({
      type: "agentAddRule",
      ok: true,
      rule: { id: 1 },
    });
    await ask({ type: "agentAddRule", scope: "domain", subject: "x.com" });
    // A rule about a kind of mail is a rule of its own scope (ADR 0068).
    await ask({ type: "agentAddRule", scope: "category", subject: "offer" });
    expect(await ask({ type: "agentRemoveRule", ruleId: 1 })).toMatchObject({
      type: "agentRemoveRule",
      ok: true,
    });
    expect(calls).toEqual([
      ["rules"],
      ["ruleOffer", "t1"],
      ["addRule", { threadId: "t1", scope: "sender" }],
      ["addRule", { scope: "domain", subject: "x.com" }],
      ["addRule", { scope: "category", subject: "offer" }],
      ["removeRule", 1],
    ]);
  });

  it("routes the instruction requests with checked fields", async () => {
    const { ask, calls } = stub();
    expect(await ask({ type: "agentInstructions" })).toMatchObject({
      type: "agentInstructions",
      ok: true,
      instructions: [],
    });
    expect(
      await ask({ type: "agentAddInstruction", scope: "write", text: "Write briefly" }),
    ).toMatchObject({ type: "agentAddInstruction", ok: true, instruction: { id: 4 } });
    expect(await ask({ type: "agentRemoveInstruction", instructionId: 4 })).toMatchObject({
      type: "agentRemoveInstruction",
      ok: true,
    });
    expect(
      await ask({ type: "agentRemember", threadId: "t1", words: "zawsze pisz krótko" }),
    ).toMatchObject({ type: "agentRemember", ok: true, result: { items: [] } });
    expect(calls).toEqual([
      ["instructions"],
      ["addInstruction", { scope: "write", text: "Write briefly" }],
      ["removeInstruction", 4],
      ["remember", "t1", "zawsze pisz krótko"],
    ]);
  });

  it("carries the talk about a thread to the service and back (ADR 0064)", async () => {
    const { ask, calls } = stub();
    expect(await ask({ type: "agentTalk", threadId: "t1", words: "What is open?" })).toMatchObject({
      type: "agentTalk",
      ok: true,
      result: { entries: [] },
    });
    expect(await ask({ type: "agentTalkStop", threadId: "t1" })).toMatchObject({
      type: "agentTalkStop",
      ok: true,
    });
    expect(await ask({ type: "agentTalkEntries", threadId: "t1" })).toMatchObject({
      type: "agentTalkEntries",
      ok: true,
      entries: [],
    });
    expect(calls).toEqual([
      ["talk", "t1", "What is open?"],
      ["talkStop", "t1"],
      ["talkEntries", "t1"],
    ]);
    const bad: object[] = [
      { type: "agentTalk" },
      { type: "agentTalk", threadId: "", words: "x" },
      { type: "agentTalk", threadId: "t1" },
      { type: "agentTalk", threadId: "t1", words: 3 },
      { type: "agentTalk", threadId: "t1", words: "x".repeat(2001) },
      { type: "agentTalkStop" },
      { type: "agentTalkEntries", threadId: 4 },
    ];
    for (const request of bad) {
      expect(await ask(request), JSON.stringify(request)).toMatchObject({
        type: "error",
        code: "invalidRequest",
      });
    }
    expect(calls).toHaveLength(3);
  });

  it("carries the help with a reply to the service and back (ADR 0098)", async () => {
    const { ask, calls } = stub();
    const text = "Hi [name],\n\n> quoted";
    expect(
      await ask({ type: "agentRewriteDraft", threadId: "t1", text, how: "shorter" }),
    ).toMatchObject({ type: "agentRewriteDraft", ok: true, text: "Short." });
    expect(await ask({ type: "agentAnswerQuestions", threadId: "t1", text })).toMatchObject({
      type: "agentAnswerQuestions",
      ok: true,
      text: "Yes, Tuesday.",
    });
    expect(await ask({ type: "agentCheckReply", threadId: "t1", text })).toMatchObject({
      type: "agentCheckReply",
      ok: true,
      check: { asked: 2, answered: 1, missing: ["who pays"] },
    });
    expect(await ask({ type: "agentFillGaps", threadId: "t1", text: "" })).toMatchObject({
      type: "agentFillGaps",
      ok: true,
      suggestions: [{ token: "[date]", value: "Tuesday", source: "Anna's message, 6 Nov" }],
    });
    expect(calls).toEqual([
      ["rewriteDraft", "t1", text, "shorter"],
      ["answerQuestions", "t1", text, []],
      ["checkReply", "t1", text],
      ["fillGaps", "t1", ""],
    ]);
    const bad: object[] = [
      { type: "agentRewriteDraft", threadId: "t1", text },
      { type: "agentRewriteDraft", threadId: "t1", text, how: "poetic" },
      { type: "agentRewriteDraft", threadId: "", text, how: "formal" },
      { type: "agentAnswerQuestions", threadId: "t1" },
      { type: "agentCheckReply", threadId: "t1", text: 4 },
      { type: "agentFillGaps", text },
      { type: "agentFillGaps", threadId: "t1", text: "x".repeat(2_000_001) },
    ];
    for (const request of bad) {
      expect(await ask(request), JSON.stringify(request).slice(0, 80)).toMatchObject({
        type: "error",
        code: "invalidRequest",
      });
    }
    expect(calls).toHaveLength(4);
  });

  it("carries the talk across all mail to the service and back (ADR 0064, rule 7)", async () => {
    const { ask, calls } = stub();
    expect(await ask({ type: "agentTalkAll", words: "Who waits?" })).toMatchObject({
      type: "agentTalkAll",
      ok: true,
      result: { entries: [] },
    });
    expect(await ask({ type: "agentTalkAllStop" })).toMatchObject({
      type: "agentTalkAllStop",
      ok: true,
    });
    expect(await ask({ type: "agentTalkAllEntries" })).toMatchObject({
      type: "agentTalkAllEntries",
      ok: true,
      entries: [],
    });
    expect(calls).toEqual([
      ["talkAll", "Who waits?", null],
      ["talkAllStop"],
      ["talkAllEntries", undefined, undefined],
    ]);
    for (const request of [
      { type: "agentTalkAll" },
      { type: "agentTalkAll", words: 3 },
      { type: "agentTalkAll", words: "x".repeat(2001) },
      { type: "agentTalkAll", words: "x", talkId: 0 },
      { type: "agentTalkAll", words: "x", talkId: "1" },
      { type: "agentTalkAllEntries", talkId: -1 },
      { type: "agentTalkAllEntries", talkId: 1, beforeId: 1.5 },
    ]) {
      expect(await ask(request), JSON.stringify(request)).toMatchObject({
        type: "error",
        code: "invalidRequest",
      });
    }
    expect(calls).toHaveLength(3);
  });

  it("carries the requests of a prompt to the service and back (ADR 0116)", async () => {
    const { ask, calls } = stub();
    const query = 'from:office prompt:"what needs my decision"';
    expect(await ask({ type: "agentPromptCount", query })).toEqual({
      type: "agentPromptCount",
      requestId: "r",
      ok: true,
      count: promptOff,
    });
    expect(await ask({ type: "agentPromptVerdicts", query })).toMatchObject({
      type: "agentPromptVerdicts",
      ok: true,
      list: { ai: "off", rows: [] },
    });
    expect(await ask({ type: "agentPromptRun", query })).toMatchObject({
      type: "agentPromptRun",
      ok: true,
      result: { ai: "off", stopped: false, rejected: 0 },
    });
    // `Search again` (rule 4).
    expect(await ask({ type: "agentPromptRun", query, again: true })).toMatchObject({
      type: "agentPromptRun",
      ok: true,
    });
    // The person saw the count and pressed ↵ again (rule 4).
    expect(await ask({ type: "agentPromptRun", query, readAll: true })).toMatchObject({
      type: "agentPromptRun",
      ok: true,
    });
    expect(await ask({ type: "agentPromptStop" })).toMatchObject({
      type: "agentPromptStop",
      ok: true,
    });
    expect(calls).toEqual([
      ["promptCount", query],
      ["promptVerdicts", query],
      ["promptRun", query, false, false],
      ["promptRun", query, true, false],
      ["promptRun", query, false, true],
      ["promptStop"],
    ]);
    for (const request of [
      { type: "agentPromptCount" },
      { type: "agentPromptVerdicts", query: 3 },
      { type: "agentPromptRun", query: "x".repeat(10_001) },
      { type: "agentPromptRun", query, again: "yes" },
      { type: "agentPromptRun", query, readAll: 1 },
    ]) {
      expect(await ask(request), JSON.stringify(request)).toMatchObject({
        type: "error",
        code: "invalidRequest",
      });
    }
    expect(calls).toHaveLength(6);
  });

  it("carries the talks across all mail to the service and back (ADR 0086)", async () => {
    const { ask, calls } = stub();
    await ask({ type: "agentTalkAll", words: "Who waits?", talkId: 4 });
    await ask({ type: "agentTalkAllEntries", talkId: 4, beforeId: 90 });
    expect(await ask({ type: "agentTalks" })).toMatchObject({ ok: true, talks: [] });
    expect(await ask({ type: "agentTalkRename", talkId: 4, title: "Job change" })).toMatchObject({
      type: "agentTalkRename",
      ok: true,
    });
    expect(await ask({ type: "agentTalkDelete", talkId: 4 })).toMatchObject({ ok: true });
    expect(await ask({ type: "agentTalkDeleteAll" })).toMatchObject({ ok: true, count: 0 });
    expect(calls).toEqual([
      ["talkAll", "Who waits?", 4],
      ["talkAllEntries", 4, 90],
      ["talks"],
      ["renameTalk", 4, "Job change"],
      ["deleteTalk", 4],
      ["deleteAllTalks"],
    ]);
    for (const request of [
      { type: "agentTalkRename", talkId: 4 },
      { type: "agentTalkRename", talkId: 4, title: "x".repeat(501) },
      { type: "agentTalkRename", title: "x" },
      { type: "agentTalkDelete" },
      { type: "agentTalkDelete", talkId: 2 ** 60 },
    ]) {
      expect(await ask(request), JSON.stringify(request)).toMatchObject({
        type: "error",
        code: "invalidRequest",
      });
    }
    expect(calls).toHaveLength(6);
  });

  it("refuses instruction requests that are not in shape", async () => {
    const { ask, calls } = stub();
    const bad: object[] = [
      { type: "agentAddInstruction" },
      { type: "agentAddInstruction", scope: "thread", text: "x" },
      { type: "agentAddInstruction", scope: "general" },
      { type: "agentAddInstruction", scope: "general", text: 3 },
      { type: "agentAddInstruction", scope: "general", text: "x".repeat(5001) },
      { type: "agentRemoveInstruction" },
      { type: "agentRemoveInstruction", instructionId: 0 },
      { type: "agentRemoveInstruction", instructionId: 1.5 },
      { type: "agentRemoveInstruction", instructionId: "1" },
      { type: "agentRemember" },
      { type: "agentRemember", threadId: "" },
      { type: "agentRemember", threadId: "t1" },
      { type: "agentRemember", threadId: "t1", words: 3 },
      { type: "agentRemember", threadId: "t1", words: "x".repeat(2001) },
    ];
    for (const request of bad) {
      expect(await ask(request), JSON.stringify(request)).toMatchObject({
        type: "error",
        code: "invalidRequest",
      });
    }
    expect(calls).toEqual([]);
  });

  it("refuses rule requests that are not in shape", async () => {
    const { ask, calls } = stub();
    const bad: object[] = [
      { type: "agentRuleOffer" },
      { type: "agentRuleOffer", threadId: "" },
      { type: "agentAddRule" },
      { type: "agentAddRule", scope: "everyone", subject: "x.com" },
      { type: "agentAddRule", scope: "domain" },
      { type: "agentAddRule", scope: "domain", subject: 3 },
      { type: "agentAddRule", scope: "domain", subject: "x".repeat(401) },
      { type: "agentAddRule", scope: "sender", threadId: "" },
      { type: "agentAddRule", scope: "domain", threadId: "t1" },
      { type: "agentAddRule", scope: "sender", threadId: "t1", subject: "a@x.com" },
      { type: "agentRemoveRule" },
      { type: "agentRemoveRule", ruleId: 0 },
      { type: "agentRemoveRule", ruleId: 1.5 },
      { type: "agentRemoveRule", ruleId: "1" },
    ];
    for (const request of bad) {
      expect(await ask(request), JSON.stringify(request)).toMatchObject({
        type: "error",
        code: "invalidRequest",
      });
    }
    expect(calls).toEqual([]);
  });

  it("passes the closed kind through feedback and undo, and answers a closing from prepare", async () => {
    const { ask, calls } = stub({
      prepare: async () => ({ kind: "closed", reason: "Automatic notification" }),
    });
    expect(await ask({ type: "agentFeedback", threadId: "t1", kind: "closed" })).toMatchObject({
      type: "agentFeedback",
      ok: true,
      alsoCovers: 0,
    });
    expect(await ask({ type: "agentUndoFeedback", threadId: "t1", kind: "closed" })).toMatchObject({
      type: "agentUndoFeedback",
      ok: true,
    });
    expect(calls).toEqual([
      ["feedback", "t1", "closed", undefined],
      ["undoFeedback", "t1", "closed"],
    ]);
    expect(
      await ask({ type: "agentPrepare", threadId: "t1", answer: "don't write" }),
    ).toMatchObject({
      type: "agentPrepare",
      ok: true,
      prepared: { kind: "closed", reason: "Automatic notification" },
    });
  });

  it("passes what a closing meant through, and refuses an outcome that is not one (ADR 0066, rule 7)", async () => {
    const { ask, calls } = stub();
    for (const outcome of ["done", "taken", "declined"] as const) {
      expect(
        await ask({ type: "agentFeedback", threadId: "t1", kind: "closed", outcome }),
      ).toMatchObject({ type: "agentFeedback", ok: true });
    }
    expect(calls).toEqual([
      ["feedback", "t1", "closed", "done"],
      ["feedback", "t1", "closed", "taken"],
      ["feedback", "t1", "closed", "declined"],
    ]);
    const before = calls.length;
    for (const bad of [
      { kind: "closed", outcome: "notRelevant" },
      { kind: "closed", outcome: "gone" },
      { kind: "later", outcome: "done" },
      { kind: "notImportant", outcome: "declined" },
    ]) {
      expect(await ask({ type: "agentFeedback", threadId: "t1", ...bad })).toMatchObject({
        ok: false,
      });
    }
    expect(calls).toHaveLength(before);
  });

  it("refuses requests that are not in shape before they reach the service", async () => {
    const { ask, calls } = stub();
    const bad: object[] = [
      { type: "agentPrepared" },
      { type: "agentPrepared", threadId: "" },
      { type: "agentThread" },
      { type: "agentThread", threadId: "" },
      { type: "agentJournal", limit: 0 },
      { type: "agentJournal", limit: 201 },
      { type: "agentJournal", limit: 1.5 },
      { type: "agentJournal", limit: "20" },
      { type: "agentReadEstimate", accountIds: "a", windowDays: 30 },
      { type: "agentReadEstimate", accountIds: [1], windowDays: 30 },
      { type: "agentReadEstimate", accountIds: ["a"], windowDays: 1.5 },
      { type: "agentSetEnabled", accountIds: ["a"], windowDays: 30 },
      { type: "agentSetModels", models: { mystery: "x" } },
      { type: "agentSetModels", models: { write: 3 } },
      { type: "agentSetModels", models: "write" },
      { type: "agentSetWeekShare", percent: "10" },
      { type: "agentSetTalkLoop", on: "yes" },
      { type: "agentSetWeekShare", percent: Number.POSITIVE_INFINITY },
      { type: "agentSetWindowDays", days: 2.5 },
      { type: "agentPrepare", threadId: "t", direction: 1 },
      { type: "agentPrepare", threadId: "t", answer: "x".repeat(2001) },
      { type: "agentFeedback", threadId: "t", kind: "delete" },
      { type: "agentUndoFeedback", threadId: "t", kind: "delete" },
      { type: "agentRevokeConsent" },
      { type: "agentDraftFromPrepared", threadId: "t", body: "" },
      { type: "agentDraftFromPrepared", threadId: "t", body: "x".repeat(20_001) },
      { type: "agentMatchAct" },
      { type: "agentMatchAct", query: 3 },
      { type: "agentMatchAct", query: "x".repeat(10_001) },
      { type: "agentSend", threadId: "t" },
    ];
    for (const request of bad) {
      expect(await ask(request), JSON.stringify(request)).toMatchObject({
        type: "error",
        code: "invalidRequest",
      });
    }
    expect(calls).toEqual([]);
  });

  it("has no request that sends mail", async () => {
    const { ask } = stub();
    for (const type of ["agentSend", "agentSendDraft", "agentMove", "agentDelete"]) {
      expect(await ask({ type, threadId: "t" })).toMatchObject({ code: "invalidRequest" });
    }
  });

  it("turns the service's errors into codes the page can act on", async () => {
    const fail = (error: Error) => stub({ prepare: async () => Promise.reject(error) });
    expect(
      await fail(new AgentUnavailableError("The assistant is not ready.")).ask({
        type: "agentPrepare",
        threadId: "t",
      }),
    ).toMatchObject({
      type: "error",
      code: "agentUnavailable",
      message: "The assistant is not ready.",
    });
    expect(
      await fail(new ThingNotFoundError()).ask({ type: "agentPrepare", threadId: "t" }),
    ).toMatchObject({ code: "notFound" });
    expect(
      await fail(new InvalidAgentSettingError("no")).ask({ type: "agentPrepare", threadId: "t" }),
    ).toMatchObject({ code: "invalidRequest" });
    expect(
      await fail(new Error("boom")).ask({ type: "agentPrepare", threadId: "t" }),
    ).toMatchObject({
      code: "internal",
    });
  });

  it("finds the row of a series by the words of an older mail (ADR 0061)", async () => {
    const lead = {
      threadId: "new",
      series: {
        name: "Documents",
        mails: [
          { threadId: "new", headline: "Newest", dateMs: 2 },
          { threadId: "old", headline: "Oldest", dateMs: 1 },
        ],
      },
    };
    const { api } = stub({
      things: async () => ({ things: [lead, { threadId: "other" }], total: 2 }) as never,
    });
    const deps = {
      agent: api,
      accountStore: { list: async () => [] },
      store: {
        getThread: async (id: string) => ({
          messages: id === "old" ? [{ key: 1 }] : [{ key: 2 }],
        }),
      },
      index: { matchesAmong: async () => [1] },
    } as unknown as BackendDeps;
    const r = await handle(deps, { requestId: "r", type: "agentThings", query: "faktura" });
    expect(r).toMatchObject({ things: [{ threadId: "new" }], total: 1 });
  });

  it("fails cleanly when the backend has no agents", async () => {
    const r = await handle({} as BackendDeps, { type: "agentStatus", requestId: "r" });
    expect(r).toMatchObject({ type: "error", code: "internal" });
  });
});

describe("RemoteAgent", () => {
  it("says the status changed after each request that changes it, and only then (ADR 0115)", async () => {
    const log: string[] = [];
    const host = {
      command: async (c: { name: string }) => {
        log.push(c.name);
        return status;
      },
    } as unknown as SyncHost;
    const remote = new RemoteAgent(host, {} as never, {} as never, () => log.push("told"));
    await remote.status();
    await remote.prepare("t1");
    await remote.feedback("t1", "closed");
    expect(log).toEqual(["agentStatus", "agentPrepare", "agentFeedback"]);
    log.length = 0;
    await remote.setEnabled({ accountIds: ["a"], runtimeId: "r", windowDays: 7 });
    await remote.disable();
    await remote.revokeConsent("a");
    await remote.pauseReading();
    await remote.resumeReading();
    await remote.setWindowDays(90);
    await remote.setModels({});
    await remote.setWeekShare(10);
    await remote.setTalkLoop(true);
    await remote.inspect();
    await remote.testRuntime();
    expect(log.filter((l) => l === "told")).toHaveLength(11);
    // Each one after its answer: a window that reads then sees the change.
    expect(log.every((l, i) => (l === "told") === (i % 2 === 1))).toBe(true);
    // A refusal changed nothing, and nobody is told.
    const refusing = new RemoteAgent(
      {
        command: async () => {
          throw new Error("no");
        },
      } as unknown as SyncHost,
      {} as never,
      {} as never,
      () => log.push("told"),
    );
    log.length = 0;
    await expect(refusing.disable()).rejects.toThrow("no");
    expect(log).toEqual([]);
  });

  it("answers reads on the reader and sends the rest to the worker", async () => {
    const sent: unknown[] = [];
    const host = {
      command: async (c: unknown) => {
        sent.push(c);
        return status;
      },
    } as unknown as SyncHost;
    const asked: number[] = [];
    const ruleReads: number[] = [];
    const instructionReads: number[] = [];
    const reads = {
      insights: {
        listAnalyses: async () => [],
        listFeedback: async () => [],
        getPrepared: async () => null,
        getBundleRead: async () => null,
        listJournal: async (limit: number) => {
          asked.push(limit);
          return [];
        },
        listRules: async () => {
          ruleReads.push(1);
          return [];
        },
        listInstructions: async () => {
          instructionReads.push(1);
          return [];
        },
        listTalk: async () => [],
        listTalks: async () => [],
      },
      settings: { get: async () => status.settings, listConsents: async () => [] },
      store: {
        getThread: async () => null,
        listThreadsSince: async () => [],
        listWrittenTo: async () => new Map(),
        listSentMail: async () => [],
        listReceivedMail: async () => [],
      },
      accounts: { list: async () => [] },
    };
    const remote = new RemoteAgent(
      host,
      reads,
      readsHere(reads, () => 1),
    );
    expect((await remote.things()).things).toEqual([]);
    expect(await remote.prepared("t1")).toBeNull();
    expect(await remote.readEstimate({ accountIds: ["a"], windowDays: 30 })).toEqual({
      threads: 0,
      capped: false,
    });
    // The journal is a read too: answered here, with the limit clamped, and never sent to the worker.
    expect(await remote.journal()).toEqual([]);
    await remote.journal(5);
    await remote.journal(0);
    await remote.journal(100_000);
    expect(asked).toEqual([50, 5, 1, 200]);
    expect(sent).toEqual([]);
    // The rules and the offer of one are reads too: answered here, never sent to the worker.
    expect(await remote.rules()).toEqual([]);
    expect(await remote.ruleOffer("t1")).toBeNull();
    expect(ruleReads.length).toBeGreaterThanOrEqual(2);
    expect(sent).toEqual([]);
    // So are the instructions: read here, while adding, removing and remembering go to the worker.
    expect(await remote.instructions()).toEqual([]);
    expect(instructionReads).toEqual([1]);
    expect(sent).toEqual([]);
    await remote.addInstruction({ scope: "write", text: "Write briefly" });
    await remote.removeInstruction(4);
    await remote.remember("t1", "zawsze pisz krótko");
    await remote.addRule({ threadId: "t1", scope: "sender" });
    await remote.addRule({ scope: "domain", subject: "x.com" });
    await remote.removeRule(3);
    await remote.setEnabled({ accountIds: ["a"], runtimeId: "r", windowDays: 7 });
    await remote.prepare("t1", { direction: "Yes" });
    await remote.feedback("t1", "notImportant");
    await remote.undoFeedback("t1", "notImportant");
    await remote.feedback("t1", "closed");
    await remote.feedback("t1", "closed", "declined");
    await remote.undoFeedback("t1", "closed");
    await remote.revokeConsent("a");
    await remote.draftFromPrepared("t1", "Hi");
    await remote.matchAct("from:news.test");
    await remote.talk("t1", "What is open?");
    await remote.talkStop("t1");
    await remote.talkAll("Who waits?");
    await remote.talkAllStop();
    await remote.rewriteDraft("t1", "Hi", "formal");
    await remote.answerQuestions("t1", "Hi");
    await remote.checkReply("t1", "Hi");
    await remote.fillGaps("t1", "Hi [date]");
    // A prompt walks the index and runs turns: all four go to the worker (ADR 0116).
    await remote.promptCount("prompt:x");
    await remote.promptVerdicts("prompt:x");
    await remote.promptRun("prompt:x");
    await remote.promptStop();
    // The talk is a read here (empty with no thread), and only the turn and its stop go out.
    expect(await remote.talkEntries("t1")).toEqual([]);
    expect(await remote.talkAllEntries()).toEqual([]);
    expect(sent).toEqual([
      { name: "agentAddInstruction", input: { scope: "write", text: "Write briefly" } },
      { name: "agentRemoveInstruction", id: 4 },
      { name: "agentRemember", threadId: "t1", words: "zawsze pisz krótko" },
      { name: "agentAddRule", input: { threadId: "t1", scope: "sender" } },
      { name: "agentAddRule", input: { scope: "domain", subject: "x.com" } },
      { name: "agentRemoveRule", ruleId: 3 },
      { name: "agentSetEnabled", accountIds: ["a"], runtimeId: "r", windowDays: 7 },
      { name: "agentPrepare", threadId: "t1", direction: "Yes" },
      { name: "agentFeedback", threadId: "t1", kind: "notImportant" },
      { name: "agentUndoFeedback", threadId: "t1", kind: "notImportant" },
      { name: "agentFeedback", threadId: "t1", kind: "closed" },
      { name: "agentFeedback", threadId: "t1", kind: "closed", outcome: "declined" },
      { name: "agentUndoFeedback", threadId: "t1", kind: "closed" },
      { name: "agentRevokeConsent", accountId: "a" },
      { name: "agentDraftFromPrepared", threadId: "t1", body: "Hi" },
      { name: "agentMatchAct", query: "from:news.test" },
      { name: "agentTalk", threadId: "t1", words: "What is open?" },
      { name: "agentTalkStop", threadId: "t1" },
      { name: "agentTalkAll", words: "Who waits?" },
      { name: "agentTalkAllStop" },
      { name: "agentRewriteDraft", threadId: "t1", text: "Hi", how: "formal" },
      { name: "agentAnswerQuestions", threadId: "t1", text: "Hi" },
      { name: "agentCheckReply", threadId: "t1", text: "Hi" },
      { name: "agentFillGaps", threadId: "t1", text: "Hi [date]" },
      { name: "agentPromptCount", query: "prompt:x" },
      { name: "agentPromptVerdicts", query: "prompt:x" },
      { name: "agentPromptRun", query: "prompt:x" },
      { name: "agentPromptStop" },
    ]);
  });
});

describe("a series in the list, with a real database (ADR 0061)", () => {
  const SENDER = "books@office.example";
  const NAME = "Documents for August";
  const OWN = "person@example.com";

  /** Reminders in threads of their own, each read as an open ask, and one thread from someone else. */
  async function setup() {
    const dir = mkdtempSync(join(tmpdir(), "matters-series-"));
    const storage = createSqliteStorage(join(dir, "mail.db"));
    cleanups.push(() => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    });
    await storage.accounts.add({
      id: ACCOUNT_ID,
      address: OWN,
      displayName: "Person",
      imap: { host: "imap.demo.invalid", port: 993, security: "tls", username: "m" },
      createdAtMs: 1,
    });
    const template = generateMailbox({ messages: 1, threads: 1 })[0]?.message;
    if (template === undefined) throw new Error("no template");
    const clock = new ManualClock();
    await clock.advance(SEED_NOW_MS);
    const mail = (key: number, threadId: string, from: string) => ({
      ...template,
      key,
      threadId,
      providerId: `p${key}`,
      messageIdHeader: `<${key}@example.com>`,
      dateMs: SEED_NOW_MS - (100 - key) * 3_600_000,
      from: { address: from },
      to: [{ address: from === OWN ? SENDER : OWN }],
      cc: [],
      subject: `Subject ${threadId}`,
    });
    const service = new AgentService({
      runtime: new DemoAgentRuntime(() => clock.now()),
      store: storage.store,
      index: storage.index,
      bodies: storage.bodies,
      accounts: storage.accounts,
      insights: storage.agent,
      settings: storage.agentSettings,
      drafts: storage.drafts,
      saveDraft: async () => {
        throw new Error("unused");
      },
      clock,
      visibleText,
      onChanged: () => {},
    });
    await service.setEnabled({
      accountIds: [ACCOUNT_ID],
      runtimeId: "claude-code",
      windowDays: 30,
    });
    const read = (threadId: string, key: number, over: Partial<ThreadAnalysis> = {}) =>
      ({
        threadId,
        lastMessageKey: key,
        analyzerVersion: ANALYZER_VERSION,
        state: "onYou",
        headline: `About ${threadId}`,
        facts: [{ kind: "ask", who: "you", evidence: { quote: "Please send", messageKey: key } }],
        stakes: "none",
        confidence: 0.9,
        analyzedAtMs: clock.now(),
        caseName: NAME,
        ...over,
      }) satisfies ThreadAnalysis;
    await storage.store.upsertMessages([
      mail(1, "r1", SENDER),
      mail(2, "r2", SENDER),
      mail(3, "r3", SENDER),
      mail(4, "x", "someone@example.org"),
    ]);
    await storage.agent.putAnalysis([
      read("r1", 1),
      read("r2", 2),
      read("r3", 3),
      read("x", 4, { caseName: "Something else" }),
    ]);
    return { service, storage, mail, read };
  }

  it("answers across all mail over the real index and store, with the demo runtime (ADR 0064)", async () => {
    const { service, storage } = await setup();
    const messages = await storage.store.getByKeys([1, 2, 3, 4]);
    const text = "Please send the reports today.";
    await storage.bodies.putBodies(
      messages.map((m) => ({ key: m.key, threadId: m.threadId, text })),
    );
    await storage.index.indexMessages(messages.map((message) => ({ message, bodyText: text })));
    await service.pauseReading();
    await service.testRuntime();
    const talked = async () =>
      (await storage.agent.listLedger(10)).filter((l) => l.purpose === "talk");
    // A word the mail does not hold finds nothing, and no mail leaves: no ledger line.
    const none = await service.talkAll("anything about unicorns");
    expect(none.entries[1]).toMatchObject({ threads: 0, hits: [], query: "anything" });
    expect(await talked()).toHaveLength(0);
    const { entries } = await service.talkAll("Who sent the reports?");
    expect(entries[1]).toMatchObject({
      kind: "found",
      query: "reports",
      threads: 4,
      hits: [{ threadId: "x", note: "The newest thread that matched.", state: "onYou" }],
      quotes: [{ text: "Please send the reports today.", threadId: "x" }],
    });
    expect((await service.talkAllEntries()).slice(2)).toEqual(entries);
    // The summaries shown to the follow turn, then the threads read for the answer.
    expect((await talked()).map((l) => l.threads)).toEqual([4, 4]);
  });

  it("lists a series as one thing, counted once, whose newest stands for all", async () => {
    const { service } = await setup();
    const page = await service.things();
    expect(page.total).toBe(2);
    const lead = page.things.find((t) => t.series !== undefined);
    expect(lead?.threadId).toBe("r3");
    expect(lead?.series?.mails.map((m) => m.threadId)).toEqual(["r3", "r2", "r1"]);
    expect(page.things.some((t) => t.threadId === "r1" || t.threadId === "r2")).toBe(false);
  });

  it("closes them all by closing the newest, and one Undo brings them all back", async () => {
    const { service } = await setup();
    await service.feedback("r3", "closed");
    expect((await service.things()).things.map((t) => t.threadId)).toEqual(["x"]);
    await service.undoFeedback("r3", "closed");
    const back = (await service.things()).things.find((t) => t.threadId === "r3");
    expect(back?.series?.mails).toHaveLength(3);
  });

  it("says how many older threads a closing hid, and the journal keeps it (ADR 0065)", async () => {
    const { service } = await setup();
    expect(await service.feedback("r3", "closed")).toBe(2);
    const [line] = await service.journal(1);
    expect(line).toMatchObject({ threadId: "r3", action: "closed", alsoCovers: 2 });
  });

  it("counts only what this closing hid, not what an older one already did", async () => {
    const { service } = await setup();
    expect(await service.feedback("r2", "closed")).toBe(1);
    expect(await service.feedback("r3", "closed")).toBe(0);
    const lines = await service.journal(2);
    expect(lines[0]).not.toHaveProperty("alsoCovers");
    expect(lines[1]).toMatchObject({ threadId: "r2", alsoCovers: 1 });
  });

  it("counts nothing for a thread that is no series", async () => {
    const { service } = await setup();
    expect(await service.feedback("x", "notImportant")).toBe(0);
    expect((await service.journal(1))[0]).not.toHaveProperty("alsoCovers");
  });

  it("brings back all a closing hid with the Undo of its journal line", async () => {
    const { service } = await setup();
    await service.feedback("r3", "closed");
    const [line] = await service.journal(1);
    if (line?.action !== "closed") throw new Error("no line");
    await service.undoFeedback(line.threadId, line.action);
    const back = (await service.things()).things.find((t) => t.threadId === "r3");
    expect(back?.series?.mails.map((m) => m.threadId)).toEqual(["r3", "r2", "r1"]);
    expect((await service.journal(1))[0]).toMatchObject({ alsoCovers: 2 });
    expect((await service.journal(1))[0]?.undoneAtMs).toBeDefined();
  });

  it("does not hide a thread the person wrote in, nor count it", async () => {
    const { service, storage, mail, read } = await setup();
    // The person's message is older than the reminder it sits under, so the reminder is the newest
    // and the thread is not one the person has just answered (ADR 0112).
    const earlier = mail(7, "r1", OWN);
    await storage.store.upsertMessages([{ ...earlier, dateMs: earlier.dateMs - 10 * 3_600_000 }]);
    await storage.agent.putAnalysis([read("r1", 1)]);
    expect(await service.feedback("r3", "closed")).toBe(1);
    expect((await service.things()).things.map((t) => t.threadId).sort()).toEqual(["r1", "x"]);
  });

  it("keeps another invoice under one name listed when the newest is closed", async () => {
    const { service, storage, read } = await setup();
    await storage.agent.putAnalysis([
      read("r1", 1, { anchors: ["F0084831514/006/26"] }),
      read("r2", 2, { anchors: ["F0084831514/007/26"] }),
      read("r3", 3, { anchors: ["F0084831514/007/26"] }),
    ]);
    const page = await service.things();
    expect(page.things.map((t) => t.threadId).sort()).toEqual(["r1", "r3", "x"]);
    expect(await service.feedback("r3", "closed")).toBe(1);
    expect((await service.things()).things.map((t) => t.threadId).sort()).toEqual(["r1", "x"]);
  });

  it("sets them all aside with `Later`, and they return together", async () => {
    const { service } = await setup();
    await service.feedback("r3", "later");
    expect((await service.things()).things.map((t) => t.threadId)).toEqual(["x"]);
    await service.undoFeedback("r3", "later");
    expect((await service.things()).total).toBe(2);
  });

  it("opens again with a reminder that comes after, counting only what came after", async () => {
    const { service, storage, mail, read } = await setup();
    await service.feedback("r3", "closed");
    await storage.store.upsertMessages([mail(5, "r5", SENDER)]);
    await storage.agent.putAnalysis([read("r5", 5)]);
    const lead = (await service.things()).things.find((t) => t.threadId === "r5");
    expect(lead?.series).toBeUndefined();
    expect((await service.things()).total).toBe(2);
  });

  it("leaves out a thread the person answered until it is read again (ADR 0112)", async () => {
    const { service, storage, mail, read } = await setup();
    const before = await service.things();
    expect(before.things.map((t) => t.threadId)).toContain("x");
    await storage.store.upsertMessages([mail(8, "x", OWN)]);
    const after = await service.things();
    expect(after.things.map((t) => t.threadId)).not.toContain("x");
    expect(after.total).toBe(before.total - 1);
    // Read again, still open: it is back, and no longer marked.
    await storage.agent.putAnalysis([read("x", 8, { caseName: "Something else" })]);
    const back = (await service.things()).things.find((t) => t.threadId === "x");
    expect(back?.updating).toBeUndefined();
  });

  it("ends with a reply, even when the reading after it finds nothing open", async () => {
    const { service, storage, mail, read } = await setup();
    await storage.store.upsertMessages([mail(6, "r3", OWN)]);
    await storage.agent.putAnalysis([read("r3", 6, { state: "none", facts: [] })]);
    expect((await service.things()).things.map((t) => t.threadId)).toEqual(["x"]);
  });
});

describe("the demo assistant over the demo mailbox, with a real database", () => {
  it("reads seeded mail, quotes real passages, and the router's reader sees the same list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "matters-agent-"));
    const storage = createSqliteStorage(join(dir, "mail.db"));
    cleanups.push(() => {
      storage.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const account: StoredAccount = {
      id: ACCOUNT_ID,
      address: "milosz@example.com",
      displayName: "Miłosz",
      imap: { host: "imap.demo.invalid", port: 993, security: "tls", username: "m" },
      createdAtMs: 1,
    };
    await storage.accounts.add(account);
    const docs = generateMailbox({ messages: 600, threads: 150 });
    await storage.store.upsertMessages(docs.map((d) => d.message));
    // The seed's keys are the stored keys here, so bodies go in under them.
    await storage.bodies.putBodies(
      docs.map((d) => ({ key: d.message.key, threadId: d.message.threadId, text: d.bodyText })),
    );

    const clock = new ManualClock();
    await clock.advance(SEED_NOW_MS + 3_600_000);
    const demo = new DemoAgentRuntime(() => clock.now());
    const service = new AgentService({
      runtime: demo,
      store: storage.store,
      index: storage.index,
      bodies: storage.bodies,
      accounts: storage.accounts,
      insights: storage.agent,
      settings: storage.agentSettings,
      drafts: storage.drafts,
      saveDraft: async () => {
        throw new Error("unused");
      },
      clock,
      visibleText,
      onChanged: () => {},
    });
    const estimate = await service.readEstimate({ accountIds: [ACCOUNT_ID], windowDays: 30 });
    expect(estimate.threads).toBeGreaterThan(5);
    await service.setEnabled({
      accountIds: [ACCOUNT_ID],
      runtimeId: "claude-code",
      windowDays: 30,
    });
    service.kick();
    await clock.advance(KICK_DEBOUNCE_MS + 100);
    await service.idle();
    await settle();

    const status = await service.status();
    expect(status.runtime?.status).toBe("ready");
    expect(status.progress.state).toBe("idle");
    expect(status.progress.total).toBe(estimate.threads);
    expect(status.progress.done).toBe(estimate.threads);
    const things = (await service.things()).things;
    expect(things.length).toBeGreaterThan(0);
    for (const t of things) {
      expect(t.quote.quote.length).toBeGreaterThan(5);
      expect(t.who).not.toBe("");
    }
    expect(things.some((t) => t.prepared !== undefined)).toBe(true);

    // The router reads the same list from the reader connection.
    const reads = {
      insights: storage.read.agentInsights,
      settings: storage.read.agentSettings,
      store: storage.read.store,
      accounts: storage.read.accounts,
    };
    const remote = new RemoteAgent(
      {} as SyncHost,
      reads,
      readsHere(reads, () => clock.now()),
    );
    expect((await remote.things()).things).toEqual(things);
    expect(await remote.readEstimate({ accountIds: [ACCOUNT_ID], windowDays: 30 })).toEqual(
      estimate,
    );

    // Every stored quote is in the text of the message it names (the code held it to that).
    const analyses = await storage.agent.listAnalyses(ANALYZER_VERSION);
    expect(analyses.length).toBe(estimate.threads);
    for (const a of analyses) {
      for (const f of a.facts) {
        const [body] = [...(await storage.bodies.getBodies([f.evidence.messageKey])).values()];
        expect(body?.replace(/\s+/g, " ")).toContain(f.evidence.quote);
      }
    }
  });

  it("never answers in a shape the code would not accept", async () => {
    const demo = new DemoAgentRuntime();
    const request = buildAnalysisRequest(
      {
        subject: "Test",
        messages: [
          {
            key: 1,
            dateMs: 1,
            from: { address: "a@example.com" },
            fromOwn: false,
            text: "nothing to see",
          },
        ],
      },
      Date.UTC(2026, 10, 5),
    );
    const run = await demo.run({ model: "haiku", ...request });
    expect(run.value).toMatchObject({ state: "fyi", facts: [] });
    expect(run.limits?.week?.usedPercent).toBeGreaterThan(0);
  });
});

describe("the environment of the assistant's program", () => {
  it("adds the usual install places after what is there, once", () => {
    const home = "/Users/me";
    const env = agentEnv(
      {
        PATH: "/usr/bin:/usr/local/bin",
        HOME: home,
        ANTHROPIC_API_KEY: "kept-for-the-adapter-to-drop",
      },
      home,
    );
    const dirs = (env.PATH ?? "").split(delimiter);
    expect(dirs.slice(0, 2)).toEqual(["/usr/bin", "/usr/local/bin"]);
    for (const d of extraBinDirs(home)) expect(dirs.filter((x) => x === d)).toHaveLength(1);
    expect(dirs).toContain("/opt/homebrew/bin");
    expect(dirs).toContain("/Users/me/.local/bin");
    expect(dirs).toContain("/Users/me/.claude/local");
  });

  it("works from an empty PATH", () => {
    const env = agentEnv({}, "/h");
    expect(env.PATH).toBe(extraBinDirs("/h").join(delimiter));
  });
});
