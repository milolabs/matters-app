// Property tests (ADR 0125) of the person's own API key (ADR 0141, rules 5 and 6): saves, removals,
// presses of the reading switch, tests, the person's turns and work in the background (a pass of
// the reading, remembering, the name of a talk) are asked for in any order, and every wait of the
// vault, a look, a turn and the reads between them ends in any order. Once all has ended, two
// things must hold:
//
// 1. The reading switch is what the commands of the key, run one at a time in the order they were
//    asked for, leave it at: a save or a removal turns it off, a press sets it. Each save and
//    removal answers with it off.
// 2. What is shown of the runtime, its stored test and a refusal are the key's now in the vault:
//    a refusal shown is one of a turn on that key, ready is its own test's.
//
// And two all the way through:
//
// 3. No request goes in the background on a key whose switch is off: one the person did not ask
//    for leaves on the key that was in the vault, with its switch on, when it was handed over, and
//    on no other. A test while some ask of the person's runs may be theirs, and is not held to it.
// 4. Nothing stored was produced under a key other than the one in the vault as it is written:
//    each answer names the key it was given on, and every write of a rule, an instruction, a talk
//    entry, prepared work, a verdict or a talk's name is checked as it begins.
// 5. A turn the person asked for is sent only on the key its gate passed for: each ask carries
//    the key of what the gate found ready, and a request of that ask that leaves names the same.
// 6. A turn the person asked for is ended only by a key change, AI off, a revoked consent or its
//    own Stop, never by the reading switch: the switch governs only what the background starts.
//    A signal is aborted as its stop is called, so what called it is on the stack then.
import { AsyncLocalStorage } from "node:async_hooks";
import { visibleText } from "@matters/adapter-mime";
import type {
  AgentKey,
  AgentKeyVaultPort,
  AgentRunRequest,
  AgentRunResult,
  AgentRuntimeInfo,
  AgentSettings,
  AgentStatus,
  StoredAccount,
} from "@matters/core";
import {
  AgentRunError,
  keyReadingOn,
  PREPARED_INSTRUCTIONS,
  PROMPT_INSTRUCTIONS,
  REMEMBER_INSTRUCTIONS,
  runtimeInfo,
  TALK_ALL_INSTRUCTIONS,
  TALK_FOLLOW_INSTRUCTIONS,
  TALK_INSTRUCTIONS,
  TALK_PLAN_INSTRUCTIONS,
  TALK_TITLE_INSTRUCTIONS,
} from "@matters/core";
import {
  createInMemoryStorage,
  InMemoryAgentInsightStore,
  InMemoryAgentSettings,
  ManualClock,
  makeMessage,
  settle,
} from "@matters/testkit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AgentService, KICK_DEBOUNCE_MS, TEST_PROMPT_QUOTE } from "../src/backend/agentService.ts";

const NOW = Date.UTC(2026, 10, 16, 12);
const ID = "anthropic-api";
/** The prompt of the saved view the background reads; the person's own prompt is another. */
const VIEW_PROMPT = "a date for the meeting";
const TEXT = "Can we meet on Tuesday?";
/** A made-up key; one that ends in `-bad` is refused by the stand-in provider. */
const keyText = (n: number, bad: boolean) =>
  `sk-ant-test-${String(n).padStart(4, "0")}11111111111111111111111111-made-up${bad ? "-bad" : ""}`;

/** The ask of the person's a request belongs to, if any, and the key its last gate passed for. */
interface Ask {
  passed: boolean;
  gated: string | undefined;
}
const asks = new AsyncLocalStorage<Ask>();

const account: StoredAccount = {
  id: "acc1",
  address: "acc1@example.com",
  displayName: "acc1",
  imap: { host: "imap.example.com", port: 993, security: "tls", username: "acc1" },
  createdAtMs: 1,
};

/** Every wait of the stand-ins goes through the scheduler once the setup is done. */
class Waits {
  live = false;
  private readonly s: fc.Scheduler;
  constructor(s: fc.Scheduler) {
    this.s = s;
  }
  async wait(label: string): Promise<void> {
    if (this.live) await this.s.schedule(Promise.resolve(), label);
  }
}

class Vault implements AgentKeyVaultPort {
  readonly kept = new Map<string, AgentKey>();
  private readonly waits: Waits;
  constructor(waits: Waits) {
    this.waits = waits;
  }
  async get(runtimeId: string) {
    return this.kept.get(runtimeId) ?? null;
  }
  async set(runtimeId: string, key: AgentKey) {
    await this.waits.wait("vault set");
    this.kept.set(runtimeId, key);
  }
  async delete(runtimeId: string) {
    await this.waits.wait("vault delete");
    this.kept.delete(runtimeId);
  }
}

/**
 * A runtime billed to a key. It reads the vault when a look begins and when a turn's request is
 * sent, as the adapter does, and answers for that key whenever the scheduler lets it. Every other
 * turn that was stopped while it waited still answers: its answer was already on the way.
 */
class Keyed {
  readonly id = ID;
  readonly name = "Anthropic API";
  private readonly vault: Vault;
  private readonly waits: Waits;
  constructor(vault: Vault, waits: Waits) {
    this.vault = vault;
    this.waits = waits;
  }
  async inspect(): Promise<AgentRuntimeInfo> {
    const base = { id: this.id, name: this.name, noPlan: true, billed: true } as const;
    const key = this.vault.kept.get(this.id);
    await this.waits.wait("look");
    if (key === undefined) return { ...base, status: "noKey", models: [], problem: "Paste a key." };
    return {
      ...base,
      status: "found",
      models: ["claude-haiku-5-5", "claude-opus-5-5"],
      defaultModel: "claude-opus-5-5",
      defaultModels: { understand: "claude-haiku-5-5", titles: "claude-haiku-5-5" },
      keySavedAtMs: key.savedAtMs,
      ...(key.id === undefined ? {} : { keyId: key.id }),
    };
  }
  private turns = 0;
  /** The next turn is refused whatever its key, as a rate limit for now is. */
  limitNext = false;
  /** The ids of the keys the provider refused a turn of. */
  readonly refused = new Set<string>();
  /** Once set up: each turn answers in a form the code keeps, naming the key it was given on. */
  answers = false;
  /** Whether an ask of the person's runs, as a request is handed to the runtime. */
  personAsks: () => boolean = () => false;
  /** The settings as they are now, read with nothing awaited. */
  switchOn: () => boolean = () => false;
  /** Every break of property 3, in words. */
  readonly broken: string[] = [];
  async run(
    request: AgentRunRequest,
    options?: { readonly signal?: AbortSignal },
  ): Promise<AgentRunResult> {
    const deaf = this.turns++ % 2 === 1;
    const stopped = () => options?.signal?.aborted === true;
    // 6. What stops a turn of the person's, as it stops it.
    if (asks.getStore() !== undefined && inBackground(request) === "never") {
      options?.signal?.addEventListener(
        "abort",
        () => {
          const limit = Error.stackTraceLimit;
          Error.stackTraceLimit = Number.POSITIVE_INFINITY;
          const stack = new Error().stack ?? "";
          Error.stackTraceLimit = limit;
          // A key saved or removed, AI off, a consent taken back, or the run's own end (a
          // refusal of another of its turns); here no Stop is pressed and no kind moves.
          const switched = /\bsetKeyReading|\bsetReading\b/.test(stack);
          const allowed =
            /\b(saveKeyNow|removeKeyNow|disable|revokeConsent)\b|promptService\.ts/.test(stack);
          if (switched || !allowed) {
            this.broken.push(
              `${kindOf(request)} of the person's stopped by ${switched ? "the reading switch" : "something else"}`,
            );
          }
        },
        { once: true },
      );
    }
    // As the service hands the request over: the key in the vault and its switch.
    const handed = this.vault.kept.get(this.id)?.id;
    const handedOn = this.switchOn();
    const person = this.personAsks();
    // The key is read as the request is sent; a request stopped before it left does not leave,
    // as the adapter, which reads the key and then asks with the signal, does not send it.
    await this.waits.wait("send");
    const key = this.vault.kept.get(this.id);
    if (stopped()) throw new AgentRunError("failed", "Cancelled.");
    const background = inBackground(request);
    if (key !== undefined && (background === "always" || (background === "test" && !person))) {
      if (key.id !== handed || !handedOn) {
        this.broken.push(
          `${kindOf(request)} left on ${key.id === handed ? "the key handed" : "another key"} with the switch ${handedOn ? "on" : "off"}`,
        );
      }
    }
    // 5. A turn of the person's leaves only on the key its gate passed for.
    const ask = asks.getStore();
    if (key !== undefined && ask !== undefined && background === "never") {
      if (!ask.passed) this.broken.push(`${kindOf(request)} left before its gate passed`);
      else if (ask.gated !== key.id) {
        this.broken.push(`${kindOf(request)} left on a key its gate did not pass for`);
      }
    }
    const limited = this.limitNext;
    this.limitNext = false;
    await this.waits.wait("turn");
    if (stopped() && !deaf) throw new AgentRunError("failed", "Cancelled.");
    if (key === undefined || key.key.endsWith("-bad") || limited) {
      if (key?.id !== undefined) this.refused.add(key.id);
      throw new AgentRunError("refused", "Anthropic refused the key.");
    }
    if (request.untrusted.includes(TEST_PROMPT_QUOTE)) {
      return {
        value: {
          verdicts: [
            { thread: 1, fit: 3, why: "It promises it.", message: 1, quote: TEST_PROMPT_QUOTE },
          ],
        },
      };
    }
    return { value: this.answers ? answerOf(request, tagOf(key.id ?? "")) : {} };
  }
}

/** Each key's short name in the answers given on it. */
const tags = new Map<string, string>();
function tagOf(keyId: string): string {
  let tag = tags.get(keyId);
  if (tag === undefined) {
    tag = `k${tags.size + 1}`;
    tags.set(keyId, tag);
  }
  return tag;
}
/** The key a text was answered on, by the tag in it, or undefined when it names none. */
function keyIn(text: string): string | undefined {
  const tag = /\bk\d+\b/.exec(text)?.[0];
  return [...tags].find(([, t]) => t === tag)?.[0];
}

function kindOf(request: AgentRunRequest): string {
  const i = request.instructions;
  if (request.untrusted.includes(TEST_PROMPT_QUOTE)) return "test";
  if (i.startsWith(REMEMBER_INSTRUCTIONS)) return "remember";
  if (i.startsWith(TALK_TITLE_INSTRUCTIONS)) return "title";
  if (i.startsWith(PROMPT_INSTRUCTIONS)) {
    return request.untrusted.includes(VIEW_PROMPT) ? "view" : "prompt";
  }
  if (i.startsWith(PREPARED_INSTRUCTIONS)) return "prepare";
  if (i.startsWith(TALK_PLAN_INSTRUCTIONS)) return "plan";
  if (i.startsWith(TALK_FOLLOW_INSTRUCTIONS)) return "follow";
  if (i.startsWith(TALK_ALL_INSTRUCTIONS)) return "answer";
  if (i.startsWith(TALK_INSTRUCTIONS)) return "talk";
  return "other";
}

/** Whether a request is work in the background: always, never, or a test that may be either. */
function inBackground(request: AgentRunRequest): "always" | "never" | "test" {
  const kind = kindOf(request);
  if (kind === "test") return "test";
  return kind === "remember" || kind === "title" || kind === "view" ? "always" : "never";
}

/** An answer each turn's code keeps, naming the key it was given on. */
function answerOf(request: AgentRunRequest, tag: string): unknown {
  switch (kindOf(request)) {
    case "remember":
      return { items: [{ scope: "general", text: `Keep it short ${tag}` }] };
    case "title":
      return { title: `Meeting ${tag}` };
    case "view":
    case "prompt":
      return { verdicts: [{ thread: 1, fit: 0, why: `No date ${tag}` }] };
    case "prepare":
      return { kind: "draft", body: `Tuesday works ${tag}`, nudge: false };
    case "talk":
      return { kind: "answer", text: `On Tuesday ${tag}`, quotes: [] };
    case "plan":
      return {
        goal: "Find the meeting",
        assumptions: [],
        trails: [{ name: "Main", why: "It is likely", priority: 5, queries: ["Tuesday"] }],
        traps: [],
      };
    case "follow":
      return { decision: "answer", keep: [], hypothesis: "The Tuesday thread" };
    case "answer":
      return {
        text: `Anna asks about Tuesday ${tag}`,
        threads: [{ thread: 1, note: `asks ${tag}`, quotes: [{ message: 1, quote: TEXT }] }],
      };
    default:
      return {};
  }
}

type Command =
  | { readonly kind: "save"; readonly bad: boolean }
  | { readonly kind: "remove" }
  | { readonly kind: "reading"; readonly on: boolean }
  | { readonly kind: "test" }
  | { readonly kind: "prepare" }
  | { readonly kind: "talk" }
  | { readonly kind: "prompt" }
  | { readonly kind: "limit" }
  | { readonly kind: "pass" }
  | { readonly kind: "remember" }
  | { readonly kind: "askAll" }
  | { readonly kind: "rewrite" };

const command: fc.Arbitrary<Command> = fc.oneof(
  fc.record({ kind: fc.constant("save" as const), bad: fc.boolean() }),
  fc.constant({ kind: "remove" as const }),
  // The switch is pressed on more often than anything else, so work in the background runs.
  { arbitrary: fc.constant({ kind: "reading" as const, on: true }), weight: 3 },
  fc.constant({ kind: "reading" as const, on: false }),
  fc.constant({ kind: "test" as const }),
  fc.constant({ kind: "prepare" as const }),
  fc.constant({ kind: "talk" as const }),
  fc.constant({ kind: "prompt" as const }),
  fc.constant({ kind: "limit" as const }),
  fc.constant({ kind: "pass" as const }),
  fc.constant({ kind: "remember" as const }),
  fc.constant({ kind: "askAll" as const }),
  fc.constant({ kind: "rewrite" as const }),
);

async function build(s: fc.Scheduler) {
  const waits = new Waits(s);
  const storage = createInMemoryStorage();
  const clock = new ManualClock();
  await clock.advance(NOW);
  const settings = new InMemoryAgentSettings();
  await storage.accounts.add(account);
  const vault = new Vault(waits);
  const keyed = new Keyed(vault, waits);
  const insights = new InMemoryAgentInsightStore();
  const service = new AgentService({
    runtimes: [keyed],
    keys: vault,
    views: storage.views,
    store: storage.store,
    index: storage.index,
    bodies: storage.bodies,
    accounts: storage.accounts,
    insights,
    settings,
    drafts: storage.drafts,
    saveDraft: async () => {
      throw new Error("unused");
    },
    clock,
    visibleText,
    onChanged: () => {},
  });
  const message = makeMessage({
    seq: 1,
    accountId: "acc1",
    threadId: "t1",
    providerId: "t1-1",
    dateMs: NOW - 86_400_000,
    from: { name: "Anna", address: "anna@example.org" },
    to: [{ address: "acc1@example.com" }],
    subject: "Tuesday",
    labelIds: ["inbox"],
  });
  const { keys } = await storage.store.upsertMessages([message]);
  await storage.bodies.putBodies(keys.map((key) => ({ key, threadId: "t1", text: TEXT })));
  await storage.index.indexMessages([
    { message: { ...message, key: keys[0] ?? message.key }, bodyText: TEXT },
  ]);
  // A key kept, agreed to and tested, before anything is asked for in any order.
  await service.saveKey(ID, keyText(0, false));
  await service.setEnabled({ accountIds: ["acc1"], runtimeId: ID });
  await service.testRuntime(ID);
  // A saved view the person ran once, whose thread is not read yet: the background reads it.
  const query = `from:anna prompt:"${VIEW_PROMPT}"`;
  await storage.views.put({ id: "v", name: "v", query, position: 0, createdMs: 0, updatedMs: 0 });
  await service.promptRun(query);
  await service.idle();
  // Every write of what a turn found names the key now in the vault (property 4).
  const broken: string[] = [];
  const check = (what: string, texts: readonly string[]) => {
    const now = vault.kept.get(ID)?.id;
    for (const text of texts) {
      const on = keyIn(text);
      if (on !== undefined && on !== now) broken.push(`${what} of another key: ${text}`);
    }
  };
  type Writes = Pick<
    InMemoryAgentInsightStore,
    "addInstruction" | "addRule" | "appendTalk" | "putPrepared" | "putPromptVerdicts" | "nameTalk"
  >;
  const watch = <K extends keyof Writes>(
    name: K,
    texts: (...args: Parameters<Writes[K]>) => string[],
  ) => {
    const original = insights[name].bind(insights) as (...args: Parameters<Writes[K]>) => unknown;
    (insights as unknown as Record<K, unknown>)[name] = (...args: Parameters<Writes[K]>) => {
      check(name, texts(...args));
      return original(...args);
    };
  };
  watch("addInstruction", (input) => [input.text]);
  watch("addRule", (input) => [input.words ?? ""]);
  watch("appendTalk", (entries) =>
    entries.flatMap((e) => (e.role === "agent" ? [e.text, JSON.stringify(e)] : [])),
  );
  watch("putPrepared", (items) => items.map((i) => JSON.stringify(i.work)));
  watch("putPromptVerdicts", (verdicts) => verdicts.map((v) => v.why));
  watch("nameTalk", (_id, title) => [title]);
  // The reads the service waits on between a decision and its request, or between a turn and
  // what it stores, end in any order too.
  const slow = (target: object, names: readonly string[]) => {
    const methods = target as Record<string, (...args: unknown[]) => Promise<unknown>>;
    for (const name of names) {
      const original = methods[name]?.bind(target);
      if (original === undefined) continue;
      methods[name] = async (...args: unknown[]) => {
        await waits.wait(name);
        return original(...args);
      };
    }
  };
  slow(storage.store, ["getThread"]);
  slow(insights, ["listRules", "listInstructions", "listTalk"]);
  slow(settings, ["get"]);
  // The key each gate of the person's passed for: what it found ready, as it passed (property 5).
  const inner = service as unknown as {
    gateRuntime: (...args: unknown[]) => Promise<void>;
    infoOf: (id: string) => AgentRuntimeInfo | null;
  };
  const gateRuntime = inner.gateRuntime.bind(service);
  inner.gateRuntime = async (...args: unknown[]) => {
    await gateRuntime(...args);
    const ask = asks.getStore();
    if (ask === undefined) return;
    ask.passed = true;
    ask.gated = inner.infoOf(ID)?.keyId;
  };
  const current = settings as unknown as { readonly settings: AgentSettings };
  keyed.switchOn = () => keyReadingOn(current.settings, ID);
  keyed.answers = true;
  // What the setup asked for was the person's.
  keyed.broken.length = 0;
  waits.live = true;
  return { service, vault, settings, keyed, clock, broken, waits };
}

describe("the person's own API key, in any order (ADR 0141)", () => {
  it("keeps the switch and the state of the runtime the key's now in the vault, whatever ends first", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.scheduler(),
        fc.array(command, { minLength: 1, maxLength: 10 }),
        async (s, commands) => {
          const h = await build(s);
          /** The asks of the person's that have not ended: a test meanwhile may be theirs. */
          let asking = 0;
          h.keyed.personAsks = () => asking > 0;
          const person = <T>(p: () => Promise<T>): Promise<T> => {
            asking++;
            return asks.run({ passed: false, gated: undefined }, p).finally(() => {
              asking--;
            });
          };
          /** The commands of the key, in the order they were asked for. */
          const keyOrder: Command[] = [];
          const answers: Promise<AgentStatus | null>[] = [];
          let saved = 0;
          const ask = (c: Command): Promise<AgentStatus | null> => {
            switch (c.kind) {
              case "save":
                keyOrder.push(c);
                return h.service.saveKey(ID, keyText(++saved, c.bad));
              case "remove":
                keyOrder.push(c);
                return h.service.removeKey(ID);
              case "reading":
                keyOrder.push(c);
                return h.service.setKeyReading(ID, c.on).then(() => null);
              case "test":
                return person(() => h.service.testRuntime(ID)).then(() => null);
              case "prepare":
                return person(() => h.service.prepare("t1")).then(() => null);
              case "talk":
                return person(() => h.service.talk("t1", "When?")).then(() => null);
              case "prompt":
                return person(() => h.service.promptRun('prompt:"when do we meet"')).then(
                  () => null,
                );
              case "askAll":
                // The question is the person's; the name of its talk is not (it goes by itself).
                return person(() => h.service.talkAll("When do we meet?")).then(() => null);
              case "rewrite":
                return person(() =>
                  h.service.rewriteDraft({ threadId: "t1" }, "Tuesday is fine, Anna.", "shorter"),
                ).then(() => null);
              case "limit":
                h.keyed.limitNext = true;
                return Promise.resolve(null);
              case "pass":
                // A sync committed new mail: a pass after the quiet time.
                h.service.kick();
                return h.clock.advance(KICK_DEBOUNCE_MS + 1).then(() => null);
              case "remember":
                // What the person typed is kept, if anything, by work in the background.
                return h.service.remember("t1", "Always answer Anna briefly").then(() => null);
            }
          };
          const asked = commands.map((c) =>
            s
              .schedule(Promise.resolve(), `ask ${c.kind}`)
              .then(() => {
                const answer = ask(c);
                if (c.kind === "save" || c.kind === "remove") answers.push(answer);
                return answer;
              })
              .catch(() => null),
          );
          await s.waitFor(Promise.all(asked));
          // What the commands started (the pass, its test) ends too.
          for (let i = 0; i < 5; i++) {
            await s.waitIdle();
            await s.waitFor(h.service.idle());
            await settle();
          }
          await s.waitIdle();
          // What is read from here on answers at once.
          h.waits.live = false;

          // 3, 4 and 5, as they were checked throughout.
          expect(h.keyed.broken).toEqual([]);
          expect(h.broken).toEqual([]);

          // 1. The switch.
          let reading = false;
          for (const c of keyOrder) {
            if (c.kind === "reading") reading = c.on;
            else reading = false;
          }
          const now = await h.settings.get();
          expect(keyReadingOn(now, ID)).toBe(reading);
          for (const answer of answers) {
            const status = await answer.catch(() => null);
            if (status !== null) expect(keyReadingOn(status.settings, ID)).toBe(false);
          }

          // 2. The state shown, the stored test and a refusal.
          const kept = h.vault.kept.get(ID);
          const shown = runtimeInfo(await h.service.status(), ID);
          const record = await h.settings.getRuntimeRecord(ID);
          if (kept === undefined) {
            expect(shown?.status).toBe("noKey");
          } else {
            const bad = kept.key.endsWith("-bad");
            expect(shown?.status).not.toBe("noKey");
            // A refusal shown is one of a turn on this key.
            if (shown?.status === "keyRefused")
              expect(h.keyed.refused.has(kept.id ?? "")).toBe(true);
            if (shown?.status === "ready") {
              expect(bad).toBe(false);
              expect(record).toMatchObject({ status: "ready", keyId: kept.id });
            }
            if (record !== null && record.keyId === kept.id) {
              expect(record.status).toBe(bad ? "failed" : "ready");
            }
          }
        },
      ),
      { numRuns: 500 },
    );
  });
});
