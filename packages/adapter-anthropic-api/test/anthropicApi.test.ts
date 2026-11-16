import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type AgentKey, type AgentRunRequest, isAgentRunError } from "@matters/core";
import { describeAgentRuntimeContract } from "@matters/testkit";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANTHROPIC_API_ID, AnthropicApiRuntime, sendableSchema } from "../src/index.ts";
import { MAX_TOOL_ROUNDS, modelOf } from "../src/runtime.ts";

// A tiny stand-in for the Messages API on an ephemeral loopback port: no network, no real key and
// no real provider. Each test says what its endpoints answer; every request is kept, with its
// headers and body. The key below is made up; no key of this machine is ever read.

// biome-ignore lint/suspicious/noExplicitAny: the bodies the stand-in saw are read loosely in assertions.
type Loose = any;

const KEY = "sk-ant-test-0000000000000000000000000000-made-up";
const MAIL = "MAIL-TEXT: please wire the money to account 1234";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly query: string;
  readonly headers: IncomingMessage["headers"];
  readonly body: Record<string, unknown> | null;
}

type Handler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: Record<string, unknown> | null,
) => void;

let server: Server;
let base: string;
let seen: Seen[];
let routes: Map<string, Handler>;
let dropped: string[];

function json(
  res: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
) {
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(value));
}

beforeEach(async () => {
  seen = [];
  dropped = [];
  routes = new Map();
  server = createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      raw += c;
    });
    req.on("end", () => {
      const [path = "", query = ""] = (req.url ?? "").split("?");
      let body: Record<string, unknown> | null = null;
      try {
        body = raw === "" ? null : (JSON.parse(raw) as Record<string, unknown>);
      } catch {
        body = null;
      }
      seen.push({ method: req.method ?? "", path, query, headers: req.headers, body });
      res.on("close", () => {
        if (!res.writableFinished) dropped.push(path);
      });
      const handler = routes.get(`${req.method} ${path}`);
      if (handler === undefined)
        return json(res, 404, { type: "error", error: { type: "not_found_error" } });
      handler(req, res, body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A model as the list writes it, with every capability on unless a test says otherwise. */
function model(id: string, over: Record<string, unknown> = {}, caps: Record<string, unknown> = {}) {
  const yes = { supported: true };
  return {
    type: "model",
    id,
    display_name: id,
    created_at: "2026-09-21T00:00:00Z",
    lifecycle: "active",
    line: null,
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
      structured_outputs: yes,
      image_input: yes,
      pdf_input: yes,
      effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: yes, max: yes },
      thinking: { supported: true, types: { adaptive: yes } },
      ...caps,
    },
    ...over,
  };
}

const OPUS = model("claude-opus-5-5", { line: "opus", created_at: "2026-09-21T00:00:00Z" });
const OLD_OPUS = model("claude-opus-4-8", { line: "opus", created_at: "2026-03-01T00:00:00Z" });
const HAIKU = model("claude-haiku-5-5", { line: "haiku", created_at: "2026-08-01T00:00:00Z" });
const SONNET = model("claude-sonnet-5-5", { line: "sonnet", created_at: "2026-08-15T00:00:00Z" });

function listing(models: readonly unknown[]) {
  routes.set("GET /v1/models", (_req, res) =>
    json(res, 200, {
      data: models,
      has_more: false,
      first_id: null,
      last_id: null,
    }),
  );
}

function answer(value: unknown, extra: Record<string, unknown> = {}) {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [{ type: "text", text: JSON.stringify(value) }],
    stop_reason: "end_turn",
    usage: { input_tokens: 120, output_tokens: 30 },
    ...extra,
  };
}

const SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["yes", "no"] },
    quote: { type: "string", minLength: 1, maxLength: 300 },
    items: {
      type: "array",
      maxItems: 5,
      items: { type: "object", properties: { n: { type: "integer", minimum: 0 } } },
    },
  },
  required: ["verdict"],
};

const REQUEST: AgentRunRequest = {
  model: "claude-opus-5-5",
  instructions: "OUR-INSTRUCTIONS",
  untrusted: MAIL,
  schema: SCHEMA,
};

function runtime(over: { key?: AgentKey | null; retries?: number; backoffMs?: number } = {}) {
  const key = over.key === undefined ? { key: KEY, savedAtMs: 1000 } : over.key;
  return new AnthropicApiRuntime({
    key: async () => key,
    baseUrl: base,
    retries: over.retries ?? 2,
    backoffMs: over.backoffMs ?? 1,
    timeoutMs: 5_000,
    inspectTimeoutMs: 2_000,
  });
}

async function failure(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (isAgentRunError(error)) return error;
    throw error;
  }
  throw new Error("expected the turn to fail");
}

describeAgentRuntimeContract("AnthropicApiRuntime", {
  make: () => runtime(),
  prepare: () => listing([OPUS]),
  unknownModel: "claude-not-listed",
});

describe("AnthropicApiRuntime: the host and the key (ADR 0141, rules 3 and 4)", () => {
  it("takes no host but its own, and the loopback address in a test", () => {
    const key = async () => null;
    expect(() => new AnthropicApiRuntime({ key, baseUrl: "https://example.com" })).toThrow();
    expect(() => new AnthropicApiRuntime({ key, baseUrl: "http://10.0.0.1:80" })).toThrow();
    expect(
      () => new AnthropicApiRuntime({ key, baseUrl: "https://api.anthropic.com" }),
    ).not.toThrow();
    expect(new AnthropicApiRuntime({ key }).id).toBe(ANTHROPIC_API_ID);
  });

  it("with no key kept, says so and asks nothing, even with a key in the environment", async () => {
    const was = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-ant-from-the-environment-0000000000";
    try {
      listing([OPUS]);
      const info = await runtime({ key: null }).inspect();
      expect(info).toMatchObject({ status: "noKey", billed: true, noPlan: true, models: [] });
      expect(info.problem).toMatch(/Paste an API key/);
      const turn = await failure(runtime({ key: null }).run(REQUEST));
      expect(turn.code).toBe("refused");
      expect(seen).toEqual([]);
    } finally {
      if (was === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = was;
    }
  });

  it("sends the key in its header, the API version, and no other credential", async () => {
    listing([OPUS]);
    await runtime().inspect();
    const look = seen[0];
    expect(look?.headers["x-api-key"]).toBe(KEY);
    expect(look?.headers["anthropic-version"]).toBe("2026-10-21");
    expect(look?.headers.authorization).toBeUndefined();
    expect(look?.query).toContain("limit=1000");
  });

  it("follows no redirect, so the key never goes to another host", async () => {
    routes.set("GET /v1/models", (_req, res) => {
      res.writeHead(302, { location: "http://127.0.0.1:1/steal" });
      res.end();
    });
    const info = await runtime({ retries: 0 }).inspect();
    expect(info.status).toBe("failed");
    expect(seen).toHaveLength(1);
  });
});

describe("AnthropicApiRuntime: the models (ADR 0141, rule 7)", () => {
  it("lists active models that answer in a schema, with their levels and files, and starts each kind sensibly", async () => {
    listing([
      OPUS,
      OLD_OPUS,
      HAIKU,
      SONNET,
      model("claude-no-schema", {}, { structured_outputs: { supported: false } }),
      model("claude-old", { lifecycle: "deprecated" }),
      model(
        "claude-few-levels",
        { line: "sonnet", created_at: "2025-01-01T00:00:00Z" },
        {
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: false },
            high: { supported: true },
            max: { supported: false },
            xhigh: null,
          },
          image_input: { supported: false },
          pdf_input: { supported: false },
        },
      ),
      { id: "../etc/passwd", capabilities: {} },
    ]);
    const info = await runtime().inspect();
    expect(info.status).toBe("found");
    expect(info.keySavedAtMs).toBe(1000);
    expect(info.models).toEqual([
      "claude-opus-5-5",
      "claude-opus-4-8",
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-few-levels",
    ]);
    expect(info.modelEfforts?.["claude-few-levels"]).toEqual(["low", "high"]);
    expect(info.modelEfforts?.["claude-opus-5-5"]).toEqual([
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]);
    expect(info.modelFiles?.["claude-few-levels"]).toEqual([]);
    expect(info.modelFiles?.["claude-opus-5-5"]).toContain("application/pdf");
    expect(info.toolModels).toEqual(info.models);
    // The newest Opus writes and answers; the newest Haiku reads mail and names talks.
    expect(info.defaultModel).toBe("claude-opus-5-5");
    expect(info.defaultModels).toEqual({
      understand: "claude-haiku-5-5",
      titles: "claude-haiku-5-5",
    });
  });

  it("falls back along the lines when a key lacks one", async () => {
    listing([SONNET]);
    const info = await runtime().inspect();
    expect(info.defaultModel).toBe("claude-sonnet-5-5");
    expect(info.defaultModels).toEqual({
      understand: "claude-sonnet-5-5",
      titles: "claude-sonnet-5-5",
    });
  });

  it("reads every page of the list, and no more than a few", async () => {
    let pages = 0;
    routes.set("GET /v1/models", (req, res) => {
      pages++;
      const after = new URL(req.url ?? "", base).searchParams.get("after_id");
      const id = after === null ? "claude-a" : `${after}-next`;
      json(res, 200, { data: [model(id)], has_more: true, first_id: id, last_id: id });
    });
    const info = await runtime().inspect();
    expect(pages).toBe(4);
    expect(info.models).toHaveLength(4);
  });

  it("a key with no model that takes a schema is refused for that", async () => {
    listing([model("claude-no-schema", {}, { structured_outputs: { supported: false } })]);
    const info = await runtime().inspect();
    expect(info.status).toBe("keyRefused");
    expect(info.problem).toMatch(/no model/);
  });

  it("reads the list's fields defensively", () => {
    expect(modelOf(null)).toBeNull();
    expect(modelOf({ id: "x", capabilities: null })).toBeNull();
    expect(modelOf(model("claude-ok"))?.levels).toHaveLength(5);
  });
});

describe("AnthropicApiRuntime: refusals of the key (ADR 0141, rule 5)", () => {
  const cases: [number, string, RegExp][] = [
    [401, "authentication_error", /refused the key/],
    [402, "billing_error", /no credit/],
    [403, "permission_error", /permissions/],
    [429, "rate_limit_error", /limiting/],
  ];
  for (const [status, type, says] of cases) {
    it(`${status} ${type}: says so in our words, never the provider's`, async () => {
      routes.set("GET /v1/models", (_req, res) =>
        json(res, status, { type: "error", error: { type, message: `PROVIDER-WORDS ${KEY}` } }),
      );
      const info = await runtime({ retries: 0 }).inspect();
      expect(info.status).toBe("keyRefused");
      expect(info.problem).toMatch(says);
      expect(JSON.stringify(info)).not.toContain("PROVIDER-WORDS");
      expect(JSON.stringify(info)).not.toContain(KEY);
    });
  }

  it("a turn on a refused key fails as refused, with the same sentence", async () => {
    listing([OPUS]);
    routes.set("POST /v1/messages", (_req, res) =>
      json(res, 402, {
        type: "error",
        error: { type: "billing_error", message: "PROVIDER-WORDS" },
      }),
    );
    const error = await failure(runtime({ retries: 0 }).run(REQUEST));
    expect(error.code).toBe("refused");
    expect(error.message).toMatch(/no credit/);
    expect(error.message).not.toContain("PROVIDER-WORDS");
  });

  it("a model the key cannot use is refused before any mail goes", async () => {
    listing([HAIKU]);
    const error = await failure(runtime().run(REQUEST));
    expect(error.code).toBe("refused");
    expect(error.message).toMatch(/no access to claude-opus-5-5/);
    expect(seen.some((s) => s.path === "/v1/messages")).toBe(false);
  });
});

describe("AnthropicApiRuntime: a turn (ADR 0141, rule 8)", () => {
  it("sends our words as the system prompt, mail as the person's message, and the schema it takes", async () => {
    listing([OPUS]);
    routes.set("POST /v1/messages", (_req, res) => json(res, 200, answer({ verdict: "yes" })));
    const result = await runtime().run({ ...REQUEST, effort: "low" });
    expect(result).toEqual({ value: { verdict: "yes" }, inputTokens: 120, outputTokens: 30 });
    const body = seen.find((s) => s.path === "/v1/messages")?.body as Record<string, Loose>;
    expect(body.model).toBe("claude-opus-5-5");
    expect(body.system).toBe("OUR-INSTRUCTIONS");
    expect(JSON.stringify(body.system)).not.toContain("MAIL-TEXT");
    expect(body.messages).toEqual([{ role: "user", content: [{ type: "text", text: MAIL }] }]);
    expect(body.max_tokens).toBe(16_000);
    expect(body.output_config.effort).toBe("low");
    expect(body.output_config.format.type).toBe("json_schema");
    // Bounds structured outputs do not take are left out; every object is closed.
    const sent = JSON.stringify(body.output_config.format.schema);
    expect(sent).not.toMatch(/minLength|maxLength|maxItems|minimum/);
    expect(body.output_config.format.schema.additionalProperties).toBe(false);
    expect(body.output_config.format.schema.properties.items.items.additionalProperties).toBe(
      false,
    );
    expect(body.thinking).toBeUndefined();
    expect(body.tools).toBeUndefined();
  });

  it("does not change the schema it was given", () => {
    const copy = JSON.parse(JSON.stringify(SCHEMA));
    sendableSchema(SCHEMA);
    expect(SCHEMA).toEqual(copy);
    expect(sendableSchema({ type: "string", format: "regex" })).toEqual({ type: "string" });
    expect(sendableSchema({ type: "string", format: "date-time" })).toEqual({
      type: "string",
      format: "date-time",
    });
  });

  it("sends no effort the model does not take", async () => {
    listing([model("claude-opus-5-5", {}, { effort: { supported: false } })]);
    const error = await failure(runtime().run({ ...REQUEST, effort: "high" }));
    expect(error.code).toBe("effortRefused");
    expect(seen.some((s) => s.path === "/v1/messages")).toBe(false);
  });

  it("sends images and PDFs whole to a model that takes them, and refuses them to one that does not", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    listing([OPUS, model("claude-blind", {}, { image_input: { supported: false } })]);
    routes.set("POST /v1/messages", (_req, res) => json(res, 200, answer({ verdict: "no" })));
    await runtime().run({
      ...REQUEST,
      files: [{ name: "a.png", mediaType: "image/png", bytes: png }],
    });
    const body = seen.find((s) => s.path === "/v1/messages")?.body as Record<string, Loose>;
    expect(body.messages[0].content[0]).toMatchObject({
      type: "image",
      source: { type: "base64", media_type: "image/png" },
    });
    const error = await failure(
      runtime().run({
        ...REQUEST,
        model: "claude-blind",
        files: [{ name: "a.png", mediaType: "image/png", bytes: png }],
      }),
    );
    expect(error.message).toMatch(/does not take/);
  });

  it("an answer that is not the form asked for, empty, cut short or declined is not used", async () => {
    listing([OPUS]);
    const replies: unknown[] = [
      { ...answer({}), content: [{ type: "text", text: "not json" }] },
      { ...answer({}), content: [] },
      { ...answer({}), stop_reason: "max_tokens" },
      { ...answer({}), stop_reason: "refusal" },
      { nonsense: true },
    ];
    let i = 0;
    routes.set("POST /v1/messages", (_req, res) => json(res, 200, replies[i++]));
    expect((await failure(runtime().run(REQUEST))).code).toBe("badAnswer");
    expect((await failure(runtime().run(REQUEST))).code).toBe("badAnswer");
    expect((await failure(runtime().run(REQUEST))).code).toBe("tooLong");
    expect((await failure(runtime().run(REQUEST))).code).toBe("badAnswer");
    expect((await failure(runtime().run(REQUEST))).code).toBe("badAnswer");
  });

  it("an answer longer than it may be is not read to its end", async () => {
    listing([OPUS]);
    routes.set("POST /v1/messages", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(1024 * 1024);
      for (let n = 0; n < 9; n++) res.write(chunk);
      res.end();
    });
    const error = await failure(runtime({ retries: 0 }).run(REQUEST));
    expect(error.message).toMatch(/wrote too much/);
  });

  it("asks for the list once a minute, not before every turn", async () => {
    listing([OPUS]);
    routes.set("POST /v1/messages", (_req, res) => json(res, 200, answer({ verdict: "yes" })));
    const r = runtime();
    await r.run(REQUEST);
    await r.run(REQUEST);
    expect(seen.filter((s) => s.path === "/v1/models")).toHaveLength(1);
  });
});

describe("AnthropicApiRuntime: trying again, and Stop (ADR 0141, rule 9)", () => {
  it("tries a turn again after 429 and 529, a bounded number of times", async () => {
    listing([OPUS]);
    let n = 0;
    routes.set("POST /v1/messages", (_req, res) => {
      n++;
      if (n === 1) return json(res, 429, { type: "error", error: { type: "rate_limit_error" } });
      if (n === 2) return json(res, 529, { type: "error", error: { type: "overloaded_error" } });
      json(res, 200, answer({ verdict: "yes" }));
    });
    expect((await runtime().run(REQUEST)).value).toEqual({ verdict: "yes" });
    expect(n).toBe(3);
  });

  it("gives up after its tries, saying so in our words", async () => {
    listing([OPUS]);
    let n = 0;
    routes.set("POST /v1/messages", (_req, res) => {
      n++;
      json(res, 503, { type: "error", error: { type: "api_error", message: "PROVIDER-WORDS" } });
    });
    const error = await failure(runtime({ retries: 2 }).run(REQUEST));
    expect(n).toBe(3);
    expect(error.code).toBe("failed");
    expect(error.message).toMatch(/busy/);
  });

  it("never tries again what was refused for a reason that stays: a bad request, a wrong key", async () => {
    listing([OPUS]);
    let n = 0;
    routes.set("POST /v1/messages", (_req, res) => {
      n++;
      json(res, 400, { type: "error", error: { type: "invalid_request_error" } });
    });
    await failure(runtime().run(REQUEST));
    expect(n).toBe(1);
  });

  it("keeps to the provider's retry-after, within a bound", async () => {
    listing([OPUS]);
    let n = 0;
    const at: number[] = [];
    routes.set("POST /v1/messages", (_req, res) => {
      at.push(Date.now());
      n++;
      if (n === 1) {
        return json(
          res,
          429,
          { type: "error", error: { type: "rate_limit_error" } },
          { "retry-after": "0.2" },
        );
      }
      json(res, 200, answer({ verdict: "yes" }));
    });
    await runtime({ backoffMs: 0 }).run(REQUEST);
    expect((at[1] ?? 0) - (at[0] ?? 0)).toBeGreaterThanOrEqual(180);
  });

  it("Stop ends a turn at once, the request with it", async () => {
    listing([OPUS]);
    routes.set("POST /v1/messages", () => {
      // Never answers.
    });
    const stop = new AbortController();
    const turn = runtime().run(REQUEST, { signal: stop.signal });
    await new Promise((resolve) => setTimeout(resolve, 50));
    stop.abort();
    const error = await failure(turn);
    expect(error.message).toBe("Cancelled.");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(dropped).toContain("/v1/messages");
  });

  it("Stop during a wait between tries ends it at once", async () => {
    listing([OPUS]);
    routes.set("POST /v1/messages", (_req, res) =>
      json(
        res,
        429,
        { type: "error", error: { type: "rate_limit_error" } },
        { "retry-after": "20" },
      ),
    );
    const stop = new AbortController();
    const started = Date.now();
    const turn = runtime().run(REQUEST, { signal: stop.signal });
    setTimeout(() => stop.abort(), 100);
    const error = await failure(turn);
    expect(error.message).toBe("Cancelled.");
    expect(Date.now() - started).toBeLessThan(2_000);
  });
});

/** A tool server like ours: JSON-RPC over POST /mcp, behind a bearer token. */
async function toolServer(answerOf: (name: string, args: unknown) => string | null) {
  const token = "t".repeat(32);
  const calls: { name: string; args: unknown }[] = [];
  const http = createServer((req, res) => {
    let body = "";
    req.on("data", (c: Buffer) => {
      body += c.toString("utf8");
    });
    req.on("end", () => {
      if (req.headers.authorization !== `Bearer ${token}`) return json(res, 401, { error: "no" });
      const m = JSON.parse(body) as {
        id: number;
        method: string;
        params: { name: string; arguments: unknown };
      };
      if (m.method === "tools/list") {
        return json(res, 200, {
          jsonrpc: "2.0",
          id: m.id,
          result: {
            tools: [
              {
                name: "search_mail",
                description: "Searches.",
                inputSchema: { type: "object", properties: { query: { type: "string" } } },
              },
              {
                name: "count_mail",
                description: "Not offered here.",
                inputSchema: { type: "object" },
              },
            ],
          },
        });
      }
      calls.push({ name: m.params.name, args: m.params.arguments });
      const text = answerOf(m.params.name, m.params.arguments);
      if (text === null)
        return json(res, 200, { jsonrpc: "2.0", id: m.id, error: { code: -32602, message: "no" } });
      json(res, 200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    server: { name: "matters", url: `http://127.0.0.1:${port}/mcp`, token, tools: ["search_mail"] },
    calls,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

const THINKING = { type: "thinking", thinking: "", signature: "sig-abc" };

describe("AnthropicApiRuntime: the search loop with our tools (ADR 0083; ADR 0141, rule 8)", () => {
  it("calls only our tools, gives results back as data, keeps its own turns whole, and answers in the schema", async () => {
    listing([OPUS]);
    const tools = await toolServer((name) =>
      name === "search_mail" ? "[1] Contract, Alex" : null,
    );
    const bodies: Record<string, Loose>[] = [];
    let n = 0;
    routes.set("POST /v1/messages", (_req, res, body) => {
      bodies.push(body as Record<string, Loose>);
      n++;
      if (n === 1) {
        return json(res, 200, {
          ...answer({}),
          stop_reason: "tool_use",
          content: [
            THINKING,
            { type: "text", text: "Looking for the contract." },
            { type: "tool_use", id: "toolu_1", name: "search_mail", input: { query: "contract" } },
          ],
          usage: { input_tokens: 10, output_tokens: 5 },
        });
      }
      if (n === 2) {
        return json(res, 200, { ...answer({}), content: [{ type: "text", text: "Done." }] });
      }
      json(res, 200, answer({ verdict: "yes" }, { usage: { input_tokens: 40, output_tokens: 7 } }));
    });
    const events: unknown[] = [];
    try {
      const result = await runtime().runWithTools(REQUEST, {
        server: tools.server,
        onEvent: (e) => events.push(e),
      });
      expect(result.value).toEqual({ verdict: "yes" });
      expect(tools.calls).toEqual([{ name: "search_mail", args: { query: "contract" } }]);
      expect(events).toEqual([
        { kind: "text", text: "Looking for the contract." },
        { kind: "tool", name: "search_mail", input: { query: "contract" } },
      ]);
      // Only the tools the turn allows, by our schema.
      expect(bodies[0]?.tools.map((t: { name: string }) => t.name)).toEqual(["search_mail"]);
      expect(bodies[0]?.output_config).toBeUndefined();
      // Its turn went back as it came, thinking and all; the result is data in the person's turn.
      expect(bodies[1]?.messages[1]).toEqual({
        role: "assistant",
        content: [
          THINKING,
          { type: "text", text: "Looking for the contract." },
          { type: "tool_use", id: "toolu_1", name: "search_mail", input: { query: "contract" } },
        ],
      });
      expect(bodies[1]?.messages[2]).toEqual({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "[1] Contract, Alex" }],
      });
      expect(bodies[1]?.system).toBe("OUR-INSTRUCTIONS");
      // The last request answers in the schema and may call no tool.
      expect(bodies[2]?.tool_choice).toEqual({ type: "none" });
      expect(bodies[2]?.output_config.format.type).toBe("json_schema");
      expect(bodies[2]?.messages).toHaveLength(3);
      expect(result.inputTokens).toBe(10 + 120 + 40);
    } finally {
      await tools.close();
    }
  });

  it("stops a turn that calls a tool it was not given", async () => {
    listing([OPUS]);
    const tools = await toolServer(() => "x");
    routes.set("POST /v1/messages", (_req, res) =>
      json(res, 200, {
        ...answer({}),
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id: "toolu_1", name: "count_mail", input: {} }],
      }),
    );
    try {
      const error = await failure(runtime().runWithTools(REQUEST, { server: tools.server }));
      expect(error.message).toMatch(/turned off/);
      expect(tools.calls).toEqual([]);
    } finally {
      await tools.close();
    }
  });

  it("rounds are bounded", async () => {
    listing([OPUS]);
    const tools = await toolServer(() => "more");
    let rounds = 0;
    routes.set("POST /v1/messages", (_req, res, body) => {
      if ((body as Record<string, Loose>).tool_choice?.type === "none") {
        return json(res, 200, answer({ verdict: "no" }));
      }
      rounds++;
      json(res, 200, {
        ...answer({}),
        stop_reason: "tool_use",
        content: [
          { type: "tool_use", id: `toolu_${rounds}`, name: "search_mail", input: { query: "q" } },
        ],
      });
    });
    try {
      const result = await runtime().runWithTools(REQUEST, { server: tools.server });
      expect(result.value).toEqual({ verdict: "no" });
      expect(rounds).toBe(MAX_TOOL_ROUNDS);
    } finally {
      await tools.close();
    }
  });

  it("takes no tool server but ours", async () => {
    const error = await failure(
      runtime().runWithTools(REQUEST, {
        server: {
          name: "x",
          url: "http://example.com/mcp",
          token: "t".repeat(32),
          tools: ["search_mail"],
        },
      }),
    );
    expect(error.message).toMatch(/not one this app made/);
  });
});

describe("AnthropicApiRuntime: the key never shows (ADR 0141, rule 4)", () => {
  it("is in no error, no info and no event, whatever the provider writes", async () => {
    const outputs: string[] = [];
    const statuses = [400, 401, 402, 403, 404, 413, 429, 500, 529];
    for (const status of statuses) {
      routes.set("GET /v1/models", (_req, res) =>
        json(res, status, { type: "error", error: { type: "x", message: `echo ${KEY}` } }),
      );
      outputs.push(JSON.stringify(await runtime({ retries: 0 }).inspect()));
    }
    listing([OPUS]);
    for (const status of statuses) {
      routes.set("POST /v1/messages", (_req, res) =>
        json(res, status, { type: "error", error: { type: "x", message: `echo ${KEY}` } }),
      );
      const error = await failure(runtime({ retries: 0 }).run(REQUEST));
      outputs.push(error.message, String(error.stack), JSON.stringify(error));
    }
    routes.set("POST /v1/messages", (_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`{"echo": "${KEY}"`);
    });
    const error = await failure(runtime().run(REQUEST));
    outputs.push(error.message, String(error.stack));
    for (const out of outputs) {
      expect(out).not.toContain(KEY);
      expect(out).not.toContain("sk-ant-");
    }
  });
});
