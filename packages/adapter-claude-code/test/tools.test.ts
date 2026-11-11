import { spawn as nodeSpawn } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { type AgentRunError, type AgentToolServer, isAgentRunError } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Harness, RATE, RESULT, request } from "./support.ts";

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

const server: AgentToolServer = {
  name: "matters",
  url: "http://127.0.0.1:43210/mcp",
  token: "abcdefghijklmnop0123456789_-ABCD",
  tools: ["search_mail", "open_thread"],
};

const init = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "system",
    subtype: "init",
    tools: ["StructuredOutput", "mcp__matters__search_mail", "mcp__matters__open_thread"],
    mcp_servers: [{ name: "matters", status: "connected" }],
    apiKeySource: "none",
    ...over,
  });

const assistant = (...content: unknown[]) =>
  JSON.stringify({ type: "assistant", message: { role: "assistant", content } });

const GOOD = [init(), RATE, RESULT];

describe("runWithTools (ADR 0083)", () => {
  it("passes the server and the allowed tools, and keeps the runtime's own tools off", async () => {
    await h.scenario({ lines: GOOD });
    const out = await h.runtime().runWithTools(request(), { server });
    expect(out.value).toEqual({ kind: "acknowledgement" });
    const argv = h.record().argv;
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    expect(argv).toContain("--strict-mcp-config");
    expect(argv).toContain("--setting-sources");
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
      "mcp__matters__search_mail,mcp__matters__open_thread",
    );
    // A variadic flag must be followed by a flag, never by the end or a value.
    expect(argv[argv.indexOf("--allowedTools") + 2]).toBe("--no-session-persistence");
    expect(argv[argv.indexOf("--mcp-config") + 2]).toBe("--allowedTools");
    expect(h.spawns[0]?.options.shell).toBe(false);
  });

  it("allows the three tools of the loop, read_file included, and no tool beyond them (ADR 0087)", async () => {
    const three = { ...server, tools: ["search_mail", "open_thread", "read_file"] };
    const initThree = (tools: string[]) =>
      init({ tools: ["StructuredOutput", ...tools.map((t) => `mcp__matters__${t}`)] });
    await h.scenario({ lines: [initThree(three.tools), RATE, RESULT] });
    const out = await h.runtime().runWithTools(request(), { server: three });
    expect(out.value).toEqual({ kind: "acknowledgement" });
    const argv = h.record().argv;
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
      "mcp__matters__search_mail,mcp__matters__open_thread,mcp__matters__read_file",
    );
    expect(argv[argv.indexOf("--tools") + 1]).toBe("");
    // A tool the server did not name is refused at init, as before.
    await h.scenario({ lines: [initThree([...three.tools, "send_mail"]), RATE, RESULT] });
    expect((await failure(h.runtime().runWithTools(request(), { server: three }))).code).toBe(
      "failed",
    );
  });

  it("allows the six read-only tools of the loop, the views' three included, and nothing more (ADR 0102)", async () => {
    const tools = [
      "search_mail",
      "open_thread",
      "read_file",
      "list_views",
      "count_mail",
      "mail_overview",
    ];
    const six = { ...server, tools };
    const initWith = (names: string[]) =>
      init({ tools: ["StructuredOutput", ...names.map((t) => `mcp__matters__${t}`)] });
    await h.scenario({ lines: [initWith(tools), RATE, RESULT] });
    const out = await h.runtime().runWithTools(request(), { server: six });
    expect(out.value).toEqual({ kind: "acknowledgement" });
    const argv = h.record().argv;
    expect(argv[argv.indexOf("--allowedTools") + 1]).toBe(
      tools.map((t) => `mcp__matters__${t}`).join(","),
    );
    await h.scenario({ lines: [initWith([...tools, "create_view"]), RATE, RESULT] });
    expect((await failure(h.runtime().runWithTools(request(), { server: six }))).code).toBe(
      "failed",
    );
  });

  const bad: [string, Partial<AgentToolServer>][] = [
    ["a foreign url", { url: "http://example.com/mcp" }],
    ["another path", { url: "http://127.0.0.1:1/other" }],
    ["https", { url: "https://127.0.0.1:1/mcp" }],
    ["a short token", { token: "short" }],
    ["a token with a bad character", { token: "abcdefghijklmnop 0123456789" }],
    ["a bad tool name", { tools: ["Search-Mail"] }],
    ["a bad server name", { name: "Matters" }],
    ["no tools", { tools: [] }],
    ["nine tools", { tools: Array.from({ length: 9 }, (_, i) => `tool_${i}`) }],
  ];
  for (const [label, over] of bad) {
    it(`refuses ${label} before starting anything`, async () => {
      await h.scenario({ lines: GOOD });
      const e = await failure(
        h.runtime().runWithTools(request(), { server: { ...server, ...over } }),
      );
      expect(e.code).toBe("failed");
      expect(h.spawns).toHaveLength(0);
    });
  }

  it("refuses an unknown model before starting anything", async () => {
    expect(
      (await failure(h.runtime().runWithTools(request({ model: "--x" }), { server }))).code,
    ).toBe("failed");
    expect(h.spawns).toHaveLength(0);
  });

  const inits: [string, string, string][] = [
    [
      "an extra tool",
      init({ tools: ["StructuredOutput", "mcp__matters__search_mail", "Bash"] }),
      "failed",
    ],
    ["a tool of another server", init({ tools: ["StructuredOutput", "mcp__other__x"] }), "failed"],
    ["no StructuredOutput", init({ tools: ["mcp__matters__search_mail"] }), "failed"],
    [
      "a second server",
      init({
        mcp_servers: [
          { name: "matters", status: "connected" },
          { name: "x", status: "connected" },
        ],
      }),
      "failed",
    ],
    [
      "our server not connected",
      init({ mcp_servers: [{ name: "matters", status: "failed" }] }),
      "failed",
    ],
    ["another server only", init({ mcp_servers: [{ name: "x", status: "connected" }] }), "failed"],
    ["no server list", init({ mcp_servers: undefined }), "failed"],
    ["an API key", init({ apiKeySource: "env" }), "notPlan"],
  ];
  for (const [label, line, code] of inits) {
    it(`rejects init with ${label}`, async () => {
      await h.scenario({ lines: [line, RATE, RESULT] });
      expect((await failure(h.runtime().runWithTools(request(), { server }))).code).toBe(code);
    });
  }

  it("reports text and allowed calls in order, and not StructuredOutput", async () => {
    await h.scenario({
      lines: [
        init(),
        assistant({ type: "text", text: "Looking for the offer." }),
        assistant(
          { type: "text", text: "   " },
          { type: "tool_use", name: "mcp__matters__search_mail", input: { query: "offer" } },
        ),
        assistant({ type: "tool_use", name: "mcp__matters__open_thread", input: { number: 2 } }),
        assistant({ type: "tool_use", name: "StructuredOutput", input: { kind: "x" } }),
        RESULT,
      ],
    });
    const seen: unknown[] = [];
    await h.runtime().runWithTools(request(), {
      server,
      onEvent: (e) => {
        seen.push(e);
        throw new Error("a listener that breaks");
      },
    });
    expect(seen).toEqual([
      { kind: "text", text: "Looking for the offer." },
      { kind: "tool", name: "search_mail", input: { query: "offer" } },
      { kind: "tool", name: "open_thread", input: { number: 2 } },
    ]);
  });

  it("fails the turn at once on a call of an unknown tool", async () => {
    await h.scenario({
      lines: [init(), assistant({ type: "tool_use", name: "Bash", input: {} }), RESULT],
    });
    const seen: unknown[] = [];
    const e = await failure(
      h.runtime().runWithTools(request(), { server, onEvent: (x) => seen.push(x) }),
    );
    expect(e.code).toBe("failed");
    expect(seen).toEqual([]);
  });

  it("keeps the token out of argv: the config is a private file in the turn's directory", async () => {
    await h.scenario({ lines: GOOD });
    let path = "";
    let seen: { text: string; mode: number } | undefined;
    const runtime = h.runtime({
      spawn: (file, args, opts) => {
        const i = args.indexOf("--mcp-config");
        path = args[i + 1] ?? "";
        seen = { text: readFileSync(path, "utf8"), mode: statSync(path).mode & 0o777 };
        return nodeSpawn(file, [...args], opts);
      },
    });
    await runtime.runWithTools(request(), { server });
    const argv = h.record().argv;
    for (const a of argv) {
      expect(a).not.toContain(server.token);
      expect(a).not.toContain("Authorization");
    }
    expect(path.startsWith(h.tmpRoot)).toBe(true);
    expect(JSON.parse(seen?.text ?? "")).toEqual({
      mcpServers: {
        matters: {
          type: "http",
          url: server.url,
          headers: { Authorization: `Bearer ${server.token}` },
        },
      },
    });
    expect(seen?.mode).toBe(0o600);
    expect(existsSync(path)).toBe(false);
  });
});
