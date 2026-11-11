import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { visibleText } from "@matters/adapter-mime";
import { createSqliteStorage } from "@matters/adapter-sqlite";
import type { AgentStatus, StoredAccount } from "@matters/core";
import { acceptVerdicts, buildPromptRequest, PROMPT_VERSION } from "@matters/core";
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
      write: "sonnet",
      answer: "sonnet",
      titles: "haiku",
    },
    efforts: { understand: "low", write: "default", answer: "default", titles: "low" },
    weekSharePercent: 10,
    usedByUsPercent: 0,
  },
  runtime: null,
  consents: [],
  progress: { state: "off", reason: "disabled" },
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
    threadAgent: note("threadAgent", { available: true, prepared: null }),
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
    setEnabled: note("setEnabled", status),
    disable: note("disable", status),
    setModels: note("setModels", status),
    setWeekShare: note("setWeekShare", status),
    setTalkLoop: note("setTalkLoop", status),
    inspect: note("inspect", status),
    testRuntime: note("testRuntime", status),
    pauseReading: note("pauseReading", status),
    resumeReading: note("resumeReading", status),
    prepare: note("prepare", { kind: "draft", body: "Hi", nudge: false }),
    undoFeedback: note("undoFeedback", undefined),
    revokeConsent: note("revokeConsent", status),
    draftFromPrepared: note("draftFromPrepared", { draftId: "d1", existing: false }),
    matchAct: note("matchAct", {
      messages: [{ key: 7, threadId: "t1", accountId: "a", subject: "S", seen: false }],
      capped: false,
    }),
    promptCount: note("promptCount", promptOff),
    promptVerdicts: note("promptVerdicts", { ...promptOff, rows: [] }),
    promptBadge: note("promptBadge", { ai: "off", unread: null }),
    promptRun: note("promptRun", { ...promptOff, rows: [], stopped: false, rejected: 0 }),
    promptStop: note("promptStop", undefined),
    ...overrides,
  };
  const deps = { agent: api } as unknown as BackendDeps;
  return { api, calls, ask: (request: object) => handle(deps, { requestId: "r", ...request }) };
}

describe("agent requests", () => {
  it("routes each request to the service with checked fields", async () => {
    const { ask, calls } = stub();
    expect(await ask({ type: "agentStatus" })).toMatchObject({
      type: "agentStatus",
      ok: true,
      status,
    });
    expect(await ask({ type: "agentThread", threadId: "t1" })).toMatchObject({
      type: "agentThread",
      ok: true,
      view: { available: true, prepared: null },
    });
    expect(await ask({ type: "agentJournal" })).toMatchObject({
      type: "agentJournal",
      ok: true,
      entries: [],
    });
    await ask({ type: "agentJournal", limit: 20 });
    expect(
      await ask({
        type: "agentSetEnabled",
        accountIds: ["a"],
        runtimeId: "claude-code",
      }),
    ).toMatchObject({ type: "agentSetEnabled", ok: true });
    expect(await ask({ type: "agentDisable" })).toMatchObject({ type: "agentDisable" });
    expect(await ask({ type: "agentSetModels", models: { write: "opus" } })).toMatchObject({
      type: "agentSetModels",
    });
    // The effort beside the model (ADR 0118): every level and the default pass.
    expect(
      await ask({
        type: "agentSetModels",
        models: {},
        efforts: { understand: "max", write: "default", answer: "xhigh", titles: "low" },
      }),
    ).toMatchObject({ type: "agentSetModels", ok: true });
    expect(calls.filter((c) => c[0] === "setModels").at(-1)).toEqual([
      "setModels",
      {},
      { understand: "max", write: "default", answer: "xhigh", titles: "low" },
    ]);
    expect(await ask({ type: "agentSetWeekShare", percent: 15 })).toMatchObject({ ok: true });
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
      "threadAgent",
      "journal",
      "journal",
      "setEnabled",
      "disable",
      "setModels",
      "setModels",
      "setWeekShare",
      "setTalkLoop",
      "inspect",
      "testRuntime",
      "pauseReading",
      "resumeReading",
      "prepare",
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
    // ADR 0117, rule 4: the number on a view's tab.
    expect(await ask({ type: "agentPromptBadge", query })).toEqual({
      type: "agentPromptBadge",
      requestId: "r",
      ok: true,
      badge: { ai: "off", unread: null },
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
      ["promptBadge", query],
      ["promptRun", query, false, false],
      ["promptRun", query, true, false],
      ["promptRun", query, false, true],
      ["promptStop"],
    ]);
    for (const request of [
      { type: "agentPromptCount" },
      { type: "agentPromptVerdicts", query: 3 },
      { type: "agentPromptBadge", query: null },
      { type: "agentPromptRun", query: "x".repeat(10_001) },
      { type: "agentPromptRun", query, again: "yes" },
      { type: "agentPromptRun", query, readAll: 1 },
    ]) {
      expect(await ask(request), JSON.stringify(request)).toMatchObject({
        type: "error",
        code: "invalidRequest",
      });
    }
    expect(calls).toHaveLength(7);
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

  it("passes the closed kind through undo, and answers a closing from prepare", async () => {
    const { ask, calls } = stub({
      prepare: async () => ({ kind: "closed", reason: "Automatic notification" }),
    });
    expect(await ask({ type: "agentUndoFeedback", threadId: "t1", kind: "closed" })).toMatchObject({
      type: "agentUndoFeedback",
      ok: true,
    });
    expect(calls).toEqual([["undoFeedback", "t1", "closed"]]);
    expect(
      await ask({ type: "agentPrepare", threadId: "t1", answer: "don't write" }),
    ).toMatchObject({
      type: "agentPrepare",
      ok: true,
      prepared: { kind: "closed", reason: "Automatic notification" },
    });
  });

  it("refuses requests that are not in shape before they reach the service", async () => {
    const { ask, calls } = stub();
    const bad: object[] = [
      { type: "agentThread" },
      { type: "agentThread", threadId: "" },
      { type: "agentJournal", limit: 0 },
      { type: "agentJournal", limit: 201 },
      { type: "agentJournal", limit: 1.5 },
      { type: "agentJournal", limit: "20" },
      { type: "agentSetEnabled", accountIds: "a", runtimeId: "r" },
      { type: "agentSetEnabled", accountIds: [1], runtimeId: "r" },
      { type: "agentSetEnabled", accountIds: ["a"] },
      { type: "agentSetModels", models: { mystery: "x" } },
      { type: "agentSetModels", models: { write: 3 } },
      { type: "agentSetModels", models: "write" },
      { type: "agentSetModels", models: { draftAhead: "haiku" } },
      { type: "agentSetModels", models: {}, efforts: "high" },
      { type: "agentSetModels", models: {}, efforts: { write: "ultra" } },
      { type: "agentSetModels", models: {}, efforts: { write: "High" } },
      { type: "agentSetModels", models: {}, efforts: { mystery: "low" } },
      { type: "agentSetWeekShare", percent: "10" },
      { type: "agentSetTalkLoop", on: "yes" },
      { type: "agentSetWeekShare", percent: Number.POSITIVE_INFINITY },
      { type: "agentPrepare", threadId: "t", direction: 1 },
      { type: "agentPrepare", threadId: "t", answer: "x".repeat(2001) },
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
    // The models are named in the refusal, with no model for drafts ahead (ADR 0117, rule 1).
    expect(await ask({ type: "agentSetModels", models: { draftAhead: "haiku" } })).toMatchObject({
      message: "models holds understand, write, answer and titles, as short strings",
    });
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
    await remote.undoFeedback("t1", "closed");
    expect(log).toEqual(["agentStatus", "agentPrepare", "agentUndoFeedback"]);
    log.length = 0;
    await remote.setEnabled({ accountIds: ["a"], runtimeId: "r" });
    await remote.disable();
    await remote.revokeConsent("a");
    await remote.pauseReading();
    await remote.resumeReading();
    await remote.setModels({});
    await remote.setWeekShare(10);
    await remote.setTalkLoop(true);
    await remote.inspect();
    await remote.testRuntime();
    expect(log.filter((l) => l === "told")).toHaveLength(10);
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
        listFeedback: async () => [],
        getPrepared: async () => null,
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
        listWrittenTo: async () => new Map(),
      },
      accounts: { list: async () => [] },
    };
    const remote = new RemoteAgent(
      host,
      reads,
      readsHere(reads, () => 1),
    );
    expect(await remote.threadAgent("t1")).toEqual({ available: false, prepared: null });
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
    await remote.setEnabled({ accountIds: ["a"], runtimeId: "r" });
    await remote.prepare("t1", { direction: "Yes" });
    await remote.undoFeedback("t1", "notImportant");
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
    await remote.promptBadge("prompt:x");
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
      { name: "agentSetEnabled", accountIds: ["a"], runtimeId: "r" },
      { name: "agentPrepare", threadId: "t1", direction: "Yes" },
      { name: "agentUndoFeedback", threadId: "t1", kind: "notImportant" },
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
      { name: "agentPromptBadge", query: "prompt:x" },
      { name: "agentPromptRun", query: "prompt:x" },
      { name: "agentPromptStop" },
    ]);
  });
});

describe("across all mail, with a real database (ADR 0064)", () => {
  const SENDER = "books@office.example";
  const OWN = "person@example.com";

  /** Reminders in threads of their own, and one thread from someone else. */
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
    });
    await storage.store.upsertMessages([
      mail(1, "r1", SENDER),
      mail(2, "r2", SENDER),
      mail(3, "r3", SENDER),
      mail(4, "x", "someone@example.org"),
    ]);
    return { service, storage };
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
      hits: [{ threadId: "x", note: "The newest thread that matched." }],
      quotes: [{ text: "Please send the reports today.", threadId: "x" }],
    });
    expect((await service.talkAllEntries()).slice(2)).toEqual(entries);
    // The summaries shown to the follow turn, then the threads read for the answer.
    expect((await talked()).map((l) => l.threads)).toEqual([4, 4]);
  });
});

describe("the demo assistant over the demo mailbox, with a real database", () => {
  it("tests itself once turned on, drafts on request, and the router's reader sees the same", async () => {
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
    await service.setEnabled({
      accountIds: [ACCOUNT_ID],
      runtimeId: "claude-code",
    });
    service.kick();
    await clock.advance(KICK_DEBOUNCE_MS + 100);
    await service.idle();
    await settle();

    // The made-up test ran by itself once the person agreed, and the pass ended (ADR 0117).
    const status = await service.status();
    expect(status.runtime?.status).toBe("ready");
    expect(status.progress).toEqual({ state: "idle" });

    // A draft on request, for a seeded thread with mail from someone else.
    const own = new Set([account.address]);
    const thread = docs.find((d) => !own.has(d.message.from.address))?.message.threadId;
    if (thread === undefined) throw new Error("no thread");
    expect(await service.prepare(thread, { answer: "Piątek pasuje." })).toMatchObject({
      kind: "draft",
    });
    const view = await service.threadAgent(thread);
    expect(view).toMatchObject({ available: true, prepared: { kind: "draft" } });

    // The router reads the same from the reader connection.
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
    expect(await remote.threadAgent(thread)).toEqual(view);
  });

  it("never answers in a shape the code would not accept", async () => {
    const demo = new DemoAgentRuntime();
    const thread = {
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
    };
    const { request } = buildPromptRequest(
      [{ thread, signals: { unread: true, starred: false, answered: false, messages: 1 } }],
      "a promise to send a signed contract",
      Date.UTC(2026, 10, 5),
    );
    const run = await demo.run({ model: "haiku", ...request });
    const verdicts = acceptVerdicts(run.value, [{ threadId: "t", lastMessageKey: 1, thread }], {
      promptKey: "k",
      version: PROMPT_VERSION,
      atMs: 1,
    });
    expect(verdicts).toHaveLength(1);
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
