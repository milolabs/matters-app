import { existsSync } from "node:fs";
import { basename } from "node:path";
import { type AgentRunError, isAgentRunError } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GOOD_STREAM, Harness, INIT, RATE, RESULT, request } from "./support.ts";

let h: Harness;
beforeEach(async () => {
  h = await Harness.create();
});
afterEach(async () => {
  await h.cleanup();
});

async function failure(promise: Promise<unknown>): Promise<AgentRunError> {
  try {
    await promise;
  } catch (error) {
    if (isAgentRunError(error)) return error;
    throw error;
  }
  throw new Error("expected the run to fail");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("run: how the child is started", () => {
  it("uses exactly the locked-down flags, and no shell", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const req = request();
    await h.runtime().run(req);
    expect(h.record().argv).toEqual([
      "-p",
      "--model",
      "haiku",
      "--tools",
      "",
      "--setting-sources",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--system-prompt",
      req.instructions,
      "--output-format",
      "stream-json",
      "--verbose",
      "--json-schema",
      JSON.stringify(req.schema),
    ]);
    expect(h.record().argv).not.toContain("--bare");
    expect(h.spawns).toHaveLength(1);
    expect(h.spawns[0]?.options.shell).toBe(false);
    expect(Array.isArray(h.spawns[0]?.args)).toBe(true);
  });

  it("passes --effort only when the request sets one", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run(request());
    expect(h.record().argv).not.toContain("--effort");
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      await h.scenario({ lines: GOOD_STREAM });
      await h.runtime().run({ ...request(), effort });
      const argv = h.record().argv;
      expect(argv[argv.indexOf("--effort") + 1]).toBe(effort);
    }
  });

  it("refuses an effort it does not know, without starting anything", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    for (const effort of ["--bad", "", "maximum", "LOW", "default"]) {
      const bad = { ...request(), effort } as unknown as Parameters<
        ReturnType<typeof h.runtime>["run"]
      >[0];
      expect((await failure(h.runtime().run(bad))).code).toBe("failed");
    }
    expect(h.spawns).toHaveLength(0);
  });

  it("passes shell metacharacters as plain arguments", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const nasty = `$(touch ${h.root}/pwned); "quoted" 'single' \`tick\` | cat && echo hi`;
    await h.runtime().run(request({ instructions: nasty }));
    expect(h.record().argv[h.record().argv.indexOf("--system-prompt") + 1]).toBe(nasty);
    expect(existsSync(`${h.root}/pwned`)).toBe(false);
  });

  it("sends the mail on stdin and never in argv", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run(request());
    expect(h.record().stdin).toBe("MAIL-TEXT: please wire the money");
    expect(h.record().argv.join(" ")).not.toContain("MAIL-TEXT");
  });

  it("removes keys and provider switches from the child's environment, and keeps the rest", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const env = h.env({
      ANTHROPIC_API_KEY: "sk-test-1",
      ANTHROPIC_AUTH_TOKEN: "tok-test-2",
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      KEEP_ME: "yes",
    });
    await h.runtime({ env }).run(request());
    const seen = h.record().env;
    expect(seen.ANTHROPIC_API_KEY).toBeUndefined();
    expect(seen.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(Object.keys(seen).filter((k) => k.startsWith("CLAUDE_CODE_USE_"))).toEqual([]);
    expect(seen.KEEP_ME).toBe("yes");
    // The caller's own environment object is left as it was.
    expect(env.ANTHROPIC_API_KEY).toBe("sk-test-1");
  });

  it("runs in a new empty directory and removes it afterwards", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run(request());
    const { cwd, cwdEntries } = h.record();
    expect(cwdEntries).toEqual([]);
    expect(basename(cwd)).toMatch(/^matters-agent-/);
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(h.spawns[0]?.options.cwd as string)).toBe(false);
  });

  it("removes the directory when the run fails too", async () => {
    await h.scenario({ lines: [INIT], exitCode: 1 });
    await failure(h.runtime().run(request()));
    expect(existsSync(h.record().cwd)).toBe(false);
  });

  it("refuses a model name that could pass for a flag, without starting anything", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    for (const model of ["--dangerously-skip-permissions", "-p", "", "a b", "x;y"]) {
      expect((await failure(h.runtime().run(request({ model })))).code).toBe("failed");
    }
    expect(h.spawns).toHaveLength(0);
  });

  it("fails with a typed error when the program is not there", async () => {
    const rt = h.runtime({ env: h.env({ PATH: "/nonexistent" }) });
    const error = await failure(rt.run(request()));
    expect(error.code).toBe("failed");
    expect(h.spawns).toHaveLength(0);
  });

  it("finds the program on PATH, or takes a path as it is", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime({ binary: "claude" }).run(request());
    await h.runtime({ binary: `${h.dir}/claude` }).run(request());
    expect(h.spawns.map((s) => s.file)).toEqual([`${h.dir}/claude`, `${h.dir}/claude`]);
  });
});

describe("run: the stream", () => {
  it("returns the structured output, the limits and the tokens", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const now = 1_790_000_000_000;
    const result = await h.runtime({ now: () => now }).run(request());
    expect(result.value).toEqual({ kind: "acknowledgement" });
    expect(result.limits).toEqual({
      session: { usedPercent: 5, resetsAtMs: 1793892000_000 },
      week: { usedPercent: 14, resetsAtMs: 1794265200_000 },
      usingOverage: false,
      seenAtMs: now,
    });
    expect(result.inputTokens).toBe(2 + 1414 + 0);
    expect(result.outputTokens).toBe(57);
  });

  it("reports overage", async () => {
    const overage = RATE.replace('"isUsingOverage":false', '"isUsingOverage":true');
    await h.scenario({ lines: [INIT, overage, RESULT] });
    expect((await h.runtime().run(request())).limits?.usingOverage).toBe(true);
  });

  it("keeps a window that a later event leaves out, and the latest overage word", async () => {
    const later = JSON.stringify({
      type: "rate_limit_event",
      rate_limit_info: {
        isUsingOverage: true,
        unifiedWindows: { five_hour: { utilization: 0.9, resetsAt: 1793895600 } },
      },
    });
    await h.scenario({ lines: [INIT, RATE, later, RESULT] });
    const limits = (await h.runtime().run(request())).limits;
    expect(limits?.session).toEqual({ usedPercent: 90, resetsAtMs: 1793895600_000 });
    expect(limits?.week?.usedPercent).toBe(14);
    expect(limits?.usingOverage).toBe(true);
  });

  it("gives no limits when the stream had none", async () => {
    await h.scenario({ lines: [INIT, RESULT] });
    const result = await h.runtime().run(request());
    expect(result.limits).toBeUndefined();
  });

  it("ignores lines that are not events", async () => {
    await h.scenario({
      lines: [
        "",
        "not json at all",
        "{broken",
        "[1,2]",
        '"str"',
        INIT,
        '{"type":',
        RATE,
        "42",
        RESULT,
      ],
    });
    const result = await h.runtime().run(request());
    expect(result.value).toEqual({ kind: "acknowledgement" });
    expect(result.limits?.session?.usedPercent).toBe(5);
  });

  it("rejects a result with no structured output as a bad answer", async () => {
    const bare = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "hello",
    });
    await h.scenario({ lines: [INIT, bare] });
    expect((await failure(h.runtime().run(request()))).code).toBe("badAnswer");
    const nulled = JSON.stringify({ type: "result", is_error: false, structured_output: null });
    await h.scenario({ lines: [INIT, nulled] });
    expect((await failure(h.runtime().run(request()))).code).toBe("badAnswer");
  });

  it("fails when the stream ends without a result", async () => {
    await h.scenario({ lines: [INIT, RATE], exitCode: 3 });
    const error = await failure(h.runtime().run(request()));
    expect(error.code).toBe("failed");
    expect(error.message).toContain("exit 3");
  });

  it("fails when a result comes before the turn was checked", async () => {
    await h.scenario({ lines: [RESULT] });
    expect((await failure(h.runtime().run(request()))).code).toBe("failed");
  });
});

describe("run: plan or nothing, no tools", () => {
  const initWith = (over: object) => JSON.stringify({ ...JSON.parse(INIT), ...over });

  it("rejects an apiKeySource other than none, and kills the child at once", async () => {
    await h.scenario({
      lines: [initWith({ apiKeySource: "ANTHROPIC_API_KEY" })],
      afterMs: 900,
      lateLines: [RESULT],
    });
    const started = Date.now();
    const error = await failure(h.runtime().run(request()));
    expect(error.code).toBe("notPlan");
    expect(Date.now() - started).toBeLessThan(700);
    await sleep(1100);
    expect(h.survived()).toBe(false);
  });

  it("rejects an init that does not say where the key comes from", async () => {
    const { apiKeySource: _, ...without } = JSON.parse(INIT);
    await h.scenario({ lines: [JSON.stringify(without), RESULT] });
    expect((await failure(h.runtime().run(request()))).code).toBe("notPlan");
  });

  it("rejects any tool other than StructuredOutput, and kills the child at once", async () => {
    await h.scenario({
      lines: [initWith({ tools: ["StructuredOutput", "Bash"] })],
      afterMs: 900,
      lateLines: [RESULT],
    });
    const error = await failure(h.runtime().run(request()));
    expect(error.code).toBe("failed");
    await sleep(1100);
    expect(h.survived()).toBe(false);
  });

  it("rejects an init that does not list its tools, and an MCP server", async () => {
    const { tools: _, ...without } = JSON.parse(INIT);
    await h.scenario({ lines: [JSON.stringify(without), RESULT] });
    expect((await failure(h.runtime().run(request()))).code).toBe("failed");
    await h.scenario({ lines: [initWith({ mcp_servers: [{ name: "x" }] }), RESULT] });
    expect((await failure(h.runtime().run(request()))).code).toBe("failed");
  });
});

describe("run: failures", () => {
  const errorResult = (text: string, over: object = {}) =>
    JSON.stringify({ type: "result", subtype: "success", is_error: true, result: text, ...over });

  it("maps a login problem to notSignedIn", async () => {
    await h.scenario({ lines: [INIT, errorResult("Not logged in · Please run /login")] });
    expect((await failure(h.runtime().run(request()))).code).toBe("notSignedIn");
  });

  it("maps a limit to limit, and a refusal to refused", async () => {
    await h.scenario({
      lines: [INIT, errorResult("Claude usage limit reached. Your limit will reset at 5pm")],
    });
    expect((await failure(h.runtime().run(request()))).code).toBe("limit");
    await h.scenario({ lines: [INIT, errorResult("", { stop_reason: "refusal" })] });
    expect((await failure(h.runtime().run(request()))).code).toBe("refused");
  });

  it("maps any other error to failed", async () => {
    await h.scenario({ lines: [INIT, errorResult("something odd")] });
    expect((await failure(h.runtime().run(request()))).code).toBe("failed");
    await h.scenario({
      lines: [
        INIT,
        JSON.stringify({ type: "result", subtype: "error_max_turns", is_error: false }),
      ],
    });
    expect((await failure(h.runtime().run(request()))).code).toBe("failed");
  });

  it("fails a turn whose effort the model refuses with that reason, and does not retry (ADR 0118, rule 5)", async () => {
    await h.scenario({
      lines: [INIT, errorResult("API Error: 400 effort 'max' is not supported by this model")],
    });
    const error = await failure(h.runtime().run({ ...request(), effort: "max" }));
    expect(error.code).toBe("effortRefused");
    expect(error.message).toBe("haiku does not take the effort max. Choose another in Settings.");
    expect(error.message).not.toContain("API Error");
    expect(h.spawns).toHaveLength(1);
    // Refused before any answer: the program says so on stderr and ends.
    await h.scenario({
      lines: [],
      stderr: "error: option '--effort <level>' argument 'xhigh' is invalid.",
      exitCode: 1,
    });
    const second = await failure(h.runtime().run({ ...request(), effort: "xhigh" }));
    expect(second.code).toBe("effortRefused");
    expect(second.message).toMatch(/does not take the effort xhigh/);
    expect(h.spawns).toHaveLength(2);
  });

  it("does not take an error for a refused effort when no effort was asked for, or for a limit", async () => {
    await h.scenario({ lines: [INIT, errorResult("effort is not supported")] });
    expect((await failure(h.runtime().run(request()))).code).toBe("failed");
    await h.scenario({ lines: [INIT, errorResult("usage limit reached at this effort")] });
    expect((await failure(h.runtime().run({ ...request(), effort: "high" }))).code).toBe("limit");
  });

  it("reads stderr to find a login problem when there is no result", async () => {
    await h.scenario({ lines: [INIT], stderr: "Error: Not logged in", exitCode: 1 });
    expect((await failure(h.runtime().run(request()))).code).toBe("notSignedIn");
  });

  it("never puts mail text, model text or stderr in an error", async () => {
    const secret = "MAIL-TEXT: please wire the money";
    await h.scenario({
      lines: [INIT, errorResult(`The model said: ${secret}`)],
      stderr: `stderr echoes ${secret}`,
    });
    const error = await failure(h.runtime().run(request()));
    expect(error.message).not.toContain("MAIL-TEXT");
    expect(error.message).not.toContain("wire");
    await h.scenario({ lines: [INIT], stderr: `stderr echoes ${secret}`, exitCode: 1 });
    const second = await failure(h.runtime().run(request()));
    expect(second.message).not.toContain("MAIL-TEXT");
    expect(JSON.stringify(second)).not.toContain("MAIL-TEXT");
  });

  it("copes with a lot of stderr", async () => {
    await h.scenario({ lines: GOOD_STREAM, stderr: "x".repeat(300_000) });
    expect((await h.runtime().run(request())).value).toEqual({ kind: "acknowledgement" });
  });

  it("times out, kills the child and cleans up", async () => {
    await h.scenario({ lines: [INIT], afterMs: 3000, lateLines: [RESULT] });
    const error = await failure(h.runtime({ timeoutMs: 300 }).run(request()));
    expect(error.code).toBe("failed");
    expect(error.message).toMatch(/too long/);
    expect(existsSync(h.record().cwd)).toBe(false);
    await sleep(100);
  });

  it("stops when aborted, and kills the child", async () => {
    await h.scenario({ lines: [INIT], hang: true });
    const controller = new AbortController();
    const promise = h.runtime().run(request(), { signal: controller.signal });
    await sleep(400);
    controller.abort();
    const error = await failure(promise);
    expect(error.code).toBe("failed");
    expect(error.message).toBe("Cancelled.");
    expect(existsSync(h.record().cwd)).toBe(false);
  });

  it("does not start when already aborted", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const controller = new AbortController();
    controller.abort();
    await failure(h.runtime().run(request(), { signal: controller.signal }));
    expect(h.spawns).toHaveLength(0);
  });
});

describe("inspect", () => {
  const status = (o: object) => JSON.stringify(o);

  it("is found when signed in with a Claude plan, and names the plan", async () => {
    await h.scenario({
      auth: status({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }),
    });
    const info = await h.runtime().inspect();
    expect(info).toMatchObject({
      id: "claude-code",
      name: "Claude Code",
      status: "found",
      plan: "pro",
      models: ["haiku", "sonnet", "opus"],
      efforts: ["low", "medium", "high", "xhigh", "max"],
    });
    expect(info.limits).toBeUndefined();
    expect(h.record(true).argv).toEqual(["auth", "status"]);
    expect(h.spawns[0]?.options.shell).toBe(false);
    expect(existsSync(h.record(true).cwd)).toBe(false);
  });

  it("is signedOut when not logged in, even if the command exits with an error", async () => {
    await h.scenario({ auth: status({ loggedIn: false }), authExit: 1 });
    const info = await h.runtime().inspect();
    expect(info.status).toBe("signedOut");
    expect(info.problem).toMatch(/auth login/);
  });

  it("is signedOut when the login is not a Claude plan", async () => {
    await h.scenario({ auth: status({ loggedIn: true, authMethod: "api_key" }) });
    expect((await h.runtime().inspect()).status).toBe("signedOut");
    await h.scenario({ auth: status({ loggedIn: true }) });
    expect((await h.runtime().inspect()).status).toBe("signedOut");
  });

  it("is missing when the program is not on PATH", async () => {
    const info = await h.runtime({ env: h.env({ PATH: "/nonexistent" }) }).inspect();
    expect(info.status).toBe("missing");
    expect(info.models).toEqual(["haiku", "sonnet", "opus"]);
    expect(h.spawns).toHaveLength(0);
    expect((await h.runtime({ binary: "/nonexistent/claude" }).inspect()).status).toBe("missing");
  });

  it("is failed when the answer cannot be read", async () => {
    await h.scenario({ auth: "this is not json" });
    expect((await h.runtime().inspect()).status).toBe("failed");
    await h.scenario({ auth: "[1]" });
    expect((await h.runtime().inspect()).status).toBe("failed");
  });

  it("scrubs the environment of the status command too", async () => {
    await h.scenario({ auth: status({ loggedIn: true, authMethod: "claude.ai" }) });
    await h.runtime({ env: h.env({ ANTHROPIC_API_KEY: "sk-test" }) }).inspect();
    expect(h.record(true).env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("removes a base URL that would send mail to another server", async () => {
    await h.scenario({ auth: status({ loggedIn: true, authMethod: "claude.ai" }) });
    await h.runtime({ env: h.env({ ANTHROPIC_BASE_URL: "https://elsewhere.example" }) }).inspect();
    expect(h.record(true).env.ANTHROPIC_BASE_URL).toBeUndefined();
  });
});
