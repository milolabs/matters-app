import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { isAgentRunError } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { INITIALIZE, INITIALIZED, parseRateLimits, READ_LIMITS } from "../src/limits.ts";
import { ENV_PASSED } from "../src/runtime.ts";
import { CONFIG_OFF, closedServerArgs, FEATURES_OFF } from "../src/switches.ts";
import { failed, GOOD_STREAM, Harness, RATE_LIMITS, request } from "./support.ts";

const NOW = 1_794_000_000_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const WRAPPER_ENV = new Set(["FAKE_CODEX_DIR", "ELECTRON_RUN_AS_NODE", "PWD", "SHLVL", "_"]);

const win = (usedPercent: number, windowDurationMins: number | null, resetsAt: number | null) => ({
  usedPercent,
  windowDurationMins,
  resetsAt,
});
const snapshot = (over: Record<string, unknown> = {}) => ({
  limitId: "codex",
  primary: win(10, 300, 1_800_000_000),
  secondary: win(40, 10080, 1_800_400_000),
  credits: { hasCredits: false, unlimited: false, balance: null },
  planType: "plus",
  rateLimitReachedType: null,
  ...over,
});
const answer = (over: Record<string, unknown> = {}) => ({
  rateLimits: snapshot(over),
  rateLimitsByLimitId: { codex: snapshot(over) },
});

describe("what a read says, in our terms (ADR 0120, rule 9)", () => {
  it("makes the shorter window the session and the longer the week, in milliseconds", () => {
    expect(parseRateLimits(answer(), NOW)).toEqual({
      plan: "plus",
      limits: {
        session: { usedPercent: 10, resetsAtMs: 1_800_000_000_000 },
        week: { usedPercent: 40, resetsAtMs: 1_800_400_000_000 },
        usingOverage: false,
        seenAtMs: NOW,
      },
    });
  });

  it("goes by length, not by slot, when the windows come the other way round", () => {
    const read = parseRateLimits(
      answer({ primary: win(70, 10080, 1_800_400_000), secondary: win(5, 300, 1_800_000_000) }),
      NOW,
    );
    expect(read.limits?.session).toEqual({ usedPercent: 5, resetsAtMs: 1_800_000_000_000 });
    expect(read.limits?.week).toEqual({ usedPercent: 70, resetsAtMs: 1_800_400_000_000 });
  });

  it("places a lone window by its length, and one with no length by its slot", () => {
    const short = parseRateLimits(
      answer({ secondary: null, primary: win(9, 1440, 1_800_000_000) }),
      NOW,
    );
    expect(short.limits?.session?.usedPercent).toBe(9);
    expect(short.limits?.week).toBeUndefined();
    const long = parseRateLimits(
      answer({ primary: null, secondary: win(9, 1441, 1_800_000_000) }),
      NOW,
    );
    expect(long.limits?.week?.usedPercent).toBe(9);
    expect(long.limits?.session).toBeUndefined();
    const weekFirst = parseRateLimits(
      answer({ primary: win(9, 10080, 1_800_000_000), secondary: null }),
      NOW,
    );
    expect(weekFirst.limits?.week?.usedPercent).toBe(9);
    const noLength = parseRateLimits(
      answer({ primary: null, secondary: win(9, null, 1_800_000_000) }),
      NOW,
    );
    expect(noLength.limits?.week?.usedPercent).toBe(9);
    const neither = parseRateLimits(
      answer({ primary: win(1, null, 1_800_000_000), secondary: win(2, null, 1_800_400_000) }),
      NOW,
    );
    expect(neither.limits?.session?.usedPercent).toBe(1);
    expect(neither.limits?.week?.usedPercent).toBe(2);
  });

  it("leaves out a window it cannot read, and gives no limits when none is left", () => {
    const noReset = parseRateLimits(answer({ primary: win(5, 300, null) }), NOW);
    expect(noReset.limits?.session).toBeUndefined();
    // The week is still the longer window, alone.
    expect(noReset.limits?.week?.usedPercent).toBe(40);
    for (const over of [
      { primary: null, secondary: null },
      { primary: "x", secondary: { usedPercent: "a lot", resetsAt: 1 } },
    ]) {
      const read = parseRateLimits(answer(over), NOW);
      expect(read.limits).toBeUndefined();
      expect(read.plan).toBe("plus");
    }
    expect(parseRateLimits(null, NOW)).toEqual({});
    expect(parseRateLimits({ rateLimits: 3 }, NOW)).toEqual({});
    const clamped = parseRateLimits(answer({ primary: win(130, 300, 1_800_000_000) }), NOW);
    expect(clamped.limits?.session?.usedPercent).toBe(100);
  });

  it("prefers Codex's own limit by name over the single view", () => {
    const read = parseRateLimits(
      {
        rateLimits: snapshot({ primary: win(99, 300, 1_800_000_000), planType: "pro" }),
        rateLimitsByLimitId: { codex: snapshot(), other: snapshot({ planType: "team" }) },
      },
      NOW,
    );
    expect(read.limits?.session?.usedPercent).toBe(10);
    expect(read.plan).toBe("plus");
    expect(parseRateLimits({ rateLimits: snapshot({ planType: "pro" }) }, NOW).plan).toBe("pro");
  });

  it("names the plan only when Codex knows it, as a plain word", () => {
    expect(parseRateLimits(answer({ planType: "unknown" }), NOW).plan).toBeUndefined();
    expect(parseRateLimits(answer({ planType: "Plus <b>" }), NOW).plan).toBeUndefined();
    expect(parseRateLimits(answer({ planType: null }), NOW).plan).toBeUndefined();
  });

  it("bills on top only when a window is full or a limit is reached, and there are credits", () => {
    const full = { primary: win(100, 300, 1_800_000_000) };
    const credits = { hasCredits: true, unlimited: false, balance: "12" };
    const over = (o: Record<string, unknown>) =>
      parseRateLimits(answer(o), NOW).limits?.usingOverage;
    expect(over({ ...full, credits })).toBe(true);
    expect(over({ ...full, credits: { hasCredits: false, unlimited: true } })).toBe(true);
    expect(over({ ...full })).toBe(false);
    expect(over({ ...full, credits: null })).toBe(false);
    expect(over({ credits })).toBe(false);
    expect(over({ credits, rateLimitReachedType: "rate_limit_reached" })).toBe(true);
    expect(over({ rateLimitReachedType: "rate_limit_reached" })).toBe(false);
  });
});

let h: Harness;
beforeEach(async () => {
  h = await Harness.create();
});
afterEach(async () => {
  await h.cleanup();
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("the read is closed (ADR 0120, rule 9)", () => {
  it("starts the server with every switch of a turn it takes, in a directory of its own", async () => {
    const info = await h.runtime().inspect();
    expect(info.plan).toBe("plus");
    expect(info.limits?.week?.usedPercent).toBe(41);
    const r = h.appServerRecord();
    const at = r.argv.find((x) => x.startsWith("sqlite_home=")) ?? "";
    const state = at.slice('sqlite_home="'.length, -1);
    // Beside the empty working directory, in a directory made for this read.
    expect(state).toBe(join(dirname(state), "state"));
    expect(r.cwd.endsWith(join(basename(dirname(state)), "work"))).toBe(true);
    expect(basename(dirname(state)).startsWith("matters-codex-")).toBe(true);
    expect(r.argv).toEqual([
      "app-server",
      ...closedServerArgs(),
      "-c",
      'model_provider="openai"',
      "-c",
      `sqlite_home="${state}"`,
      "-c",
      `log_dir="${state}"`,
      "-c",
      "mcp_servers={}",
    ]);
    expect(closedServerArgs()).toEqual([
      "--listen",
      "stdio://",
      "--strict-config",
      ...FEATURES_OFF.flatMap((f) => ["--disable", f.feature]),
      ...CONFIG_OFF.flatMap((c) => ["-c", `${c.key}=${c.value}`]),
    ]);
    const spawn = h.spawns.find((s) => s.args[0] === "app-server");
    expect(spawn?.options.shell).toBe(false);
    expect(spawn?.options.detached).toBe(true);
    for (const key of Object.keys(r.env)) {
      if (WRAPPER_ENV.has(key) || key.startsWith("__CF")) continue;
      expect(ENV_PASSED).toContain(key);
    }
    // No turn: the server is never used to run one.
    expect(h.turns).toHaveLength(0);
  });

  it("writes the handshake and the one request, and nothing else", async () => {
    await h.scenario({ appServer: { notify: true } });
    const info = await h.runtime().inspect();
    expect(info.limits?.session?.usedPercent).toBe(3);
    expect(h.appServerInput()).toEqual([INITIALIZE, INITIALIZED, READ_LIMITS]);
    expect(READ_LIMITS.method).toBe("account/rateLimits/read");
  });

  it("refuses whatever the server asks of it, and reads on", async () => {
    await h.scenario({ appServer: { ask: true } });
    const info = await h.runtime().inspect();
    expect(info.limits?.week?.usedPercent).toBe(41);
    const sent = h.appServerInput();
    expect(sent).toContainEqual({
      id: "srv-1",
      error: { code: -32601, message: "Not supported." },
    });
    expect(sent.filter((m) => JSON.stringify(m).includes('"result"'))).toEqual([]);
    expect(sent).toHaveLength(4);
  });

  it("stops the server when the answer is in, and removes its directory", async () => {
    await h.runtime().inspect();
    const { pid } = h.appServerRecord();
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(20);
    expect(alive(pid)).toBe(false);
    for (let i = 0; i < 100 && readdirSync(h.tmpRoot).length > 0; i++) await sleep(20);
    expect(readdirSync(h.tmpRoot)).toEqual([]);
  });

  it("gives up when late, kills the server, and keeps nothing", async () => {
    await h.scenario({ appServer: { silent: true } });
    const started = Date.now();
    const info = await h.runtime({ limitsTimeoutMs: 300 }).inspect();
    expect(Date.now() - started).toBeLessThan(3000);
    expect(info.status).toBe("found");
    expect(info.limits).toBeUndefined();
    // Until Codex names the plan, it is the ChatGPT plan.
    expect(info.plan).toBe("ChatGPT");
    const { pid } = h.appServerRecord();
    for (let i = 0; i < 100 && alive(pid); i++) await sleep(20);
    expect(alive(pid)).toBe(false);
  });

  it("is not asked while Codex is not signed in with a plan", async () => {
    await h.scenario({ login: "Not logged in" });
    await h.runtime().inspect();
    await h.scenario({ login: "Logged in using an API key - sk-***" });
    await h.runtime().inspect();
    expect(h.appServerStarts).toBe(0);
  });
});

describe("when the read happens, and what a failed one leaves (ADR 0120, rule 9)", () => {
  it("reads when looked at and after a turn, at most once in 30 seconds", async () => {
    let now = NOW;
    await h.scenario({ lines: GOOD_STREAM });
    const runtime = h.runtime({ now: () => now });
    await runtime.inspect();
    await runtime.inspect();
    expect(h.appServerStarts).toBe(1);
    now += 29_999;
    const first = await runtime.run(request());
    expect(h.appServerStarts).toBe(1);
    // The turn carries what is known all the same.
    expect(first.limits?.seenAtMs).toBe(NOW);
    now += 2;
    const second = await runtime.run(request());
    expect(h.appServerStarts).toBe(2);
    expect(second.limits?.seenAtMs).toBe(NOW + 30_001);
  });

  it("keeps the windows and the plan it knew when a read fails", async () => {
    let now = NOW;
    const runtime = h.runtime({ now: () => now, limitsTimeoutMs: 300 });
    const known = await runtime.inspect();
    expect(known.limits?.seenAtMs).toBe(NOW);
    for (const appServer of [
      { error: true },
      { initError: true },
      { exitCode: 1 },
      { silent: true },
      { result: { rateLimits: null } },
    ]) {
      now += 31_000;
      await h.scenario({ appServer });
      const info = await runtime.inspect();
      expect(info.limits).toEqual(known.limits);
      expect(info.plan).toBe("plus");
    }
    expect(h.appServerStarts).toBe(6);
  });

  it("answers the turn when the read fails, and fails the turn for the turn only", async () => {
    await h.scenario({ lines: GOOD_STREAM, appServer: { exitCode: 2 } });
    const out = await h.runtime().run(request());
    expect(out.value).toEqual({ kind: "acknowledgement" });
    expect(out.limits).toBeUndefined();

    await h.scenario({ lines: GOOD_STREAM, appServer: { silent: true } });
    const started = Date.now();
    const late = await h.runtime({ limitsTimeoutMs: 300 }).run(request());
    expect(late.value).toEqual({ kind: "acknowledgement" });
    expect(Date.now() - started).toBeLessThan(5000);

    await h.scenario({
      lines: failed("You’ve hit your usage limit. Try again later."),
      appServer: { delayMs: 2000 },
    });
    const before = h.appServerStarts;
    const started2 = Date.now();
    try {
      await h.runtime().run(request());
      throw new Error("expected the turn to fail");
    } catch (error) {
      expect(isAgentRunError(error) && error.code).toBe("limit");
    }
    // A failed turn does not wait for the read it starts.
    expect(Date.now() - started2).toBeLessThan(2000);
    for (let i = 0; i < 100 && h.appServerStarts === before; i++) await sleep(20);
    expect(h.appServerStarts).toBe(before + 1);
  });

  it("matches what the real server answered in shape", () => {
    const read = parseRateLimits(RATE_LIMITS, NOW);
    expect(read.plan).toBe("plus");
    expect(read.limits?.session).toEqual({ usedPercent: 3, resetsAtMs: 1_800_000_000_000 });
    expect(read.limits?.week).toEqual({ usedPercent: 41, resetsAtMs: 1_800_400_000_000 });
    expect(JSON.stringify(read)).not.toContain("acct");
  });
});
