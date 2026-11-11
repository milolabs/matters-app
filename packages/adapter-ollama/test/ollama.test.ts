import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { type AgentRunError, type AgentRunRequest, isAgentRunError } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OllamaRuntime } from "../src/index.ts";
import {
  ANSWER_TOKENS,
  CHARS_PER_TOKEN,
  contextFor,
  inputCharsOf,
  levelsOf,
  MAX_TOOL_ROUNDS,
  MESSAGE_TOKENS,
  RESERVED_CHARS,
  THINKING_TOKENS,
} from "../src/runtime.ts";

// A tiny Ollama on an ephemeral loopback port: no network and no real server. Each test says what
// its endpoints answer; every request is kept, with its body.

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly body: Record<string, unknown> | null;
}

type Handler = (req: IncomingMessage, res: ServerResponse, body: string) => void;

const MAIL = "MAIL-TEXT: please wire the money to account 1234";

let server: Server;
let base: string;
let seen: Seen[];
let routes: Map<string, Handler>;
/** Requests whose connection closed before an answer: what a real abort does to the server. */
let dropped: string[];

function json(res: ServerResponse, status: number, value: unknown): void {
  const text = JSON.stringify(value);
  res.writeHead(status, { "content-type": "application/json" });
  res.end(text);
}

beforeEach(async () => {
  seen = [];
  dropped = [];
  routes = new Map();
  server = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (c: string) => {
      body += c;
    });
    req.on("end", () => {
      const path = (req.url ?? "").split("?")[0] ?? "";
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = body === "" ? null : (JSON.parse(body) as Record<string, unknown>);
      } catch {
        parsed = null;
      }
      seen.push({ method: req.method ?? "", path, body: parsed });
      res.on("close", () => {
        if (!res.writableFinished) dropped.push(path);
      });
      const handler = routes.get(`${req.method} ${path}`);
      if (handler === undefined) return json(res, 404, { error: "no route" });
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

interface ModelSpec {
  readonly name: string;
  readonly size?: number;
  readonly capabilities?: readonly string[];
  readonly thinking?: { values: readonly (string | boolean)[]; default?: string | boolean };
  readonly context?: number;
  readonly remote?: boolean;
}

const QWEN: ModelSpec = {
  name: "qwen3:8b",
  size: 5_225_388_164,
  capabilities: ["completion", "tools", "thinking"],
  thinking: { values: [false, true], default: true },
  context: 40_960,
};
const CODER: ModelSpec = {
  name: "qwen2.5-coder:1.5b-base",
  size: 986_060_385,
  capabilities: ["completion", "insert"],
  context: 32_768,
};
const EMBED: ModelSpec = {
  name: "nomic-embed-text:latest",
  size: 274_302_450,
  capabilities: ["embedding"],
  context: 2048,
};
const LEVELS: ModelSpec = {
  name: "reasoner:20b",
  size: 13_000_000_000,
  capabilities: ["completion", "thinking"],
  thinking: { values: ["low", "medium", "high", "extreme"], default: "medium" },
  context: 131_072,
};
const CLOUD: ModelSpec = {
  name: "big:120b-cloud",
  size: 384,
  capabilities: ["completion"],
  remote: true,
};

/** The server has these models: the version, the list and what it says of each. */
function serve(models: readonly ModelSpec[]): void {
  routes.set("GET /api/version", (_q, res) => json(res, 200, { version: "0.40.16" }));
  routes.set("GET /api/tags", (_q, res) =>
    json(res, 200, {
      models: models.map((m) => ({
        name: m.name,
        model: m.name,
        size: m.size ?? 1,
        details: { parameter_size: "1B" },
        ...(m.remote ? { remote_model: m.name, remote_host: "https://elsewhere.example" } : {}),
      })),
    }),
  );
  routes.set("POST /api/show", (_q, res, body) => {
    const asked = (JSON.parse(body) as { model: string }).model;
    const m = models.find((x) => x.name === asked);
    if (m === undefined) return json(res, 404, { error: `model '${asked}' not found` });
    json(res, 200, {
      capabilities: m.capabilities ?? ["completion"],
      ...(m.thinking === undefined ? {} : { thinking: m.thinking }),
      model_info: m.context === undefined ? {} : { "family.context_length": m.context },
      details: { family: "family" },
      ...(m.remote ? { remote_model: m.name, remote_host: "https://elsewhere.example" } : {}),
    });
  });
}

const SCHEMA = {
  type: "object",
  properties: { kind: { type: "string" } },
  required: ["kind"],
  additionalProperties: false,
};

function request(over: Partial<AgentRunRequest> = {}): AgentRunRequest {
  return {
    model: "qwen3:8b",
    instructions: "You answer with JSON.",
    untrusted: `Hello.\n${MAIL}`,
    schema: SCHEMA,
    ...over,
  };
}

/** The chat endpoint answers with this content, and these counts. */
function answers(content: string, extra: Record<string, unknown> = {}): void {
  routes.set("POST /api/chat", (_q, res) =>
    json(res, 200, {
      model: "qwen3:8b",
      message: { role: "assistant", content, thinking: `I think about ${MAIL}` },
      done: true,
      done_reason: "stop",
      prompt_eval_count: 120,
      eval_count: 30,
      ...extra,
    }),
  );
}

const runtime = (options: { timeoutMs?: number; inspectTimeoutMs?: number } = {}) =>
  new OllamaRuntime({ baseUrl: base, ...options });

async function failure(promise: Promise<unknown>): Promise<AgentRunError> {
  try {
    await promise;
  } catch (error) {
    if (isAgentRunError(error)) return error;
    throw error;
  }
  throw new Error("expected the run to fail");
}

const chats = () => seen.filter((s) => s.path === "/api/chat");

describe("the address (rule 1)", () => {
  it("reaches only the loopback address", () => {
    expect(() => new OllamaRuntime({ baseUrl: "http://example.com:11434" })).toThrow();
    expect(() => new OllamaRuntime({ baseUrl: "http://localhost:11434" })).toThrow();
    expect(() => new OllamaRuntime({ baseUrl: "https://127.0.0.1:11434" })).toThrow();
    expect(() => new OllamaRuntime({ baseUrl: "http://127.0.0.1:11434/x" })).toThrow();
    expect(() => new OllamaRuntime()).not.toThrow();
  });
});

describe("inspect (rules 5, 6, 7, 9)", () => {
  it("is not running when nothing answers", async () => {
    const closed = new OllamaRuntime({ baseUrl: "http://127.0.0.1:9", inspectTimeoutMs: 2000 });
    const info = await closed.inspect();
    expect(info).toMatchObject({ id: "ollama", name: "Ollama", status: "notRunning", models: [] });
    expect(info.problem).toBe("Ollama is not running. Start it, then look again.");
    expect(info.noPlan).toBe(true);
  });

  it("is not running when the server does not answer in time", async () => {
    routes.set("GET /api/version", () => {
      // Never answers.
    });
    const info = await runtime({ inspectTimeoutMs: 150 }).inspect();
    expect(info.status).toBe("notRunning");
  });

  it("has no model when only embedding and forwarded models are listed", async () => {
    serve([EMBED, CLOUD]);
    const info = await runtime().inspect();
    expect(info.status).toBe("noModel");
    expect(info.models).toEqual([]);
    expect(info.problem).toBe(
      "No model is installed. Run `ollama pull <model>` in Terminal, then look again.",
    );
  });

  it("lists only local models that complete text, with no plan, one turn at a time", async () => {
    serve([EMBED, CODER, QWEN, CLOUD, LEVELS]);
    const info = await runtime().inspect();
    expect(info.status).toBe("found");
    expect(info.models).toEqual(["qwen2.5-coder:1.5b-base", "qwen3:8b", "reasoner:20b"]);
    expect(info.noPlan).toBe(true);
    expect(info.onThisMachine).toBe(true);
    expect(info.turnsAtOnce).toBe(1);
    expect(info.plan).toBeUndefined();
    expect(info.limits).toBeUndefined();
    // The forwarded model is not even looked at.
    expect(seen.some((s) => s.path === "/api/show" && s.body?.model === CLOUD.name)).toBe(false);
  });

  it("starts on the largest model (rule 4)", async () => {
    serve([CODER, QWEN, EMBED]);
    expect((await runtime().inspect()).defaultModel).toBe("qwen3:8b");
    serve([CODER, QWEN, LEVELS]);
    expect((await runtime().inspect()).defaultModel).toBe("reasoner:20b");
  });

  it("gives levels per model: named levels that are ours, none for on and off", async () => {
    serve([CODER, QWEN, LEVELS]);
    const info = await runtime().inspect();
    expect(info.efforts).toBeUndefined();
    expect(info.modelEfforts).toEqual({
      "qwen2.5-coder:1.5b-base": [],
      "qwen3:8b": [],
      "reasoner:20b": ["low", "medium", "high"],
    });
  });

  it("says how much mail one turn on each model may carry, by the estimate num_ctx uses (rule 8)", async () => {
    serve([
      CODER,
      QWEN,
      { ...CODER, name: "tiny:1b", context: 8192, capabilities: ["completion", "thinking"] },
    ]);
    const info = await runtime().inspect();
    const chars = info.modelInputChars ?? {};
    expect(chars["qwen2.5-coder:1.5b-base"]).toBe(inputCharsOf(false, 32_768));
    expect(chars["qwen3:8b"]).toBe(inputCharsOf(true, 40_960));
    // A thinking model with a small context takes no mail at all: such a turn cannot fit.
    expect(chars["tiny:1b"]).toBe(0);
    // What it says fits does fit: that much mail, with our largest instructions, is not refused.
    const mail = chars["qwen3:8b"] ?? 0;
    expect(contextFor(mail + RESERVED_CHARS, true, 40_960)).not.toBeNull();
    expect(contextFor(mail + RESERVED_CHARS + 4 * CHARS_PER_TOKEN, true, 40_960)).toBeNull();
  });

  it("fails, in its own words, on a list it does not understand", async () => {
    routes.set("GET /api/version", (_q, res) => json(res, 200, { version: "1" }));
    routes.set("GET /api/tags", (_q, res) => json(res, 200, { models: "many" }));
    const info = await runtime().inspect();
    expect(info.status).toBe("failed");
    expect(info.problem).toBe("Ollama gave an answer that was not understood.");
  });

  it("never sends a chat", async () => {
    serve([QWEN]);
    await runtime().inspect();
    expect(chats()).toEqual([]);
  });
});

describe("levelsOf and contextFor", () => {
  it("maps named levels by exact name only", () => {
    expect(
      levelsOf({ thinking: { values: ["max", "low", "LOW", "xhigh", "ultra", true] } }),
    ).toEqual(["low", "xhigh", "max"]);
    expect(levelsOf({ thinking: { values: [false] } })).toEqual([]);
    expect(levelsOf({})).toEqual([]);
  });

  it("asks for the text, the answer and thinking, rounded up, within the model", () => {
    const chars = 30_000;
    const need = Math.ceil(chars / CHARS_PER_TOKEN) + MESSAGE_TOKENS + ANSWER_TOKENS;
    expect(contextFor(chars, false, 40_960)).toBe(Math.ceil(need / 1024) * 1024);
    expect(contextFor(chars, true, 40_960)).toBe(Math.ceil((need + THINKING_TOKENS) / 1024) * 1024);
    expect(contextFor(chars, false, need)).toBe(need);
    expect(contextFor(chars, false, need - 1)).toBeNull();
    // A model that does not say what it takes is held to a small context.
    expect(contextFor(chars, false, undefined)).toBeNull();
  });
});

describe("run: the request (rules 8, 9)", () => {
  it("sends instructions as system, mail as user, the schema as format, no stream", async () => {
    serve([QWEN]);
    answers('{"kind":"acknowledgement"}');
    const req = request();
    const result = await runtime().run(req);
    expect(result).toEqual({
      value: { kind: "acknowledgement" },
      inputTokens: 120,
      outputTokens: 30,
    });
    const [chat] = chats();
    expect(chat?.body).toMatchObject({
      model: "qwen3:8b",
      messages: [
        { role: "system", content: req.instructions },
        { role: "user", content: req.untrusted },
      ],
      format: SCHEMA,
      stream: false,
    });
    expect(Object.hasOwn(chat?.body ?? {}, "think")).toBe(false);
    expect(Object.keys(chat?.body ?? {}).sort()).toEqual([
      "format",
      "messages",
      "model",
      "options",
      "stream",
    ]);
  });

  it("asks for the context the turn needs, with room to think on a model that thinks", async () => {
    serve([QWEN, CODER]);
    answers('{"kind":"x"}');
    const req = request({ untrusted: "x".repeat(24_000) });
    await runtime().run(req);
    const chars = req.instructions.length + req.untrusted.length + JSON.stringify(SCHEMA).length;
    const options = chats()[0]?.body?.options as { num_ctx: number };
    expect(options.num_ctx).toBe(contextFor(chars, true, QWEN.context));
    await runtime().run({ ...req, model: CODER.name });
    const plain = chats()[1]?.body?.options as { num_ctx: number };
    expect(plain.num_ctx).toBe(contextFor(chars, false, CODER.context));
    expect(plain.num_ctx).toBeLessThan(options.num_ctx);
  });

  it("refuses a turn too long for the model, and sends nothing", async () => {
    serve([{ ...CODER, context: 8192 }]);
    answers('{"kind":"x"}');
    const error = await failure(
      runtime().run(request({ model: CODER.name, untrusted: `${MAIL} ${"y".repeat(20_000)}` })),
    );
    expect(error.code).toBe("tooLong");
    expect(error.message).toBe(
      "This is too long for qwen2.5-coder:1.5b-base. Choose a model that takes more, or ask about less.",
    );
    expect(chats()).toEqual([]);
  });

  it("sends think only for a level the model lists", async () => {
    serve([QWEN, LEVELS]);
    answers('{"kind":"x"}');
    await runtime().run(request({ model: LEVELS.name, effort: "high" }));
    expect(chats()[0]?.body?.think).toBe("high");
    await runtime().run(request({ model: LEVELS.name }));
    expect(Object.hasOwn(chats()[1]?.body ?? {}, "think")).toBe(false);
    // A level the model does not list is refused, never sent: the server would use its default.
    const notListed = await failure(runtime().run(request({ model: LEVELS.name, effort: "max" })));
    expect(notListed.code).toBe("effortRefused");
    expect(notListed.message).toBe(
      "reasoner:20b does not take the effort max. Choose another in Settings.",
    );
    const onOff = await failure(runtime().run(request({ effort: "low" })));
    expect(onOff.code).toBe("effortRefused");
    expect(chats()).toHaveLength(2);
  });

  it("refuses files and an unknown model name, before any request", async () => {
    serve([QWEN]);
    const withFiles = request({
      files: [{ name: "a.pdf", mediaType: "application/pdf", bytes: new Uint8Array([1]) }],
    });
    expect((await failure(runtime().run(withFiles))).code).toBe("failed");
    for (const model of ["--x", "http://evil/x", "", "a b"]) {
      expect((await failure(runtime().run(request({ model })))).code).toBe("failed");
    }
    expect(seen).toEqual([]);
  });

  it("refuses a model that is not installed, is forwarded elsewhere, or only embeds", async () => {
    serve([QWEN, CLOUD, EMBED]);
    answers('{"kind":"x"}');
    for (const model of ["llama3:8b", CLOUD.name, EMBED.name]) {
      const error = await failure(runtime().run(request({ model })));
      expect(error.code).toBe("failed");
      expect(error.message).toBe("That model is not installed on this Mac.");
    }
    expect(chats()).toEqual([]);
  });
});

describe("run: the answer and its failures", () => {
  it("does not take an answer that is not JSON", async () => {
    serve([QWEN]);
    answers(`Sure! ${MAIL}`);
    const error = await failure(runtime().run(request()));
    expect(error.code).toBe("badAnswer");
    answers("");
    expect((await failure(runtime().run(request()))).code).toBe("badAnswer");
    answers("42");
    expect((await failure(runtime().run(request()))).code).toBe("badAnswer");
  });

  it("does not take an answer that ran out of room, or a request that filled the context", async () => {
    serve([QWEN]);
    answers('{"kind":"x"}', { done_reason: "length" });
    expect((await failure(runtime().run(request()))).code).toBe("tooLong");
    answers('{"kind":"x"}', { prompt_eval_count: 1_000_000 });
    const cut = await failure(runtime().run(request()));
    expect(cut.code).toBe("tooLong");
    expect(cut.message).toBe("This was too long for qwen3:8b, so its answer is not used.");
  });

  it("says the model is gone when the chat does not find it", async () => {
    serve([QWEN]);
    routes.set("POST /api/chat", (_q, res) =>
      json(res, 404, { error: `model not found: ${MAIL}` }),
    );
    const error = await failure(runtime().run(request()));
    expect(error.message).toBe("That model is not installed on this Mac.");
  });

  it("says Ollama reported an error, never in its words", async () => {
    serve([QWEN]);
    routes.set("POST /api/chat", (_q, res) => json(res, 500, { error: `boom ${MAIL}` }));
    const error = await failure(runtime().run(request()));
    expect(error.code).toBe("failed");
    expect(error.message).toBe("Ollama reported an error.");
  });

  it("is not running when the server is gone", async () => {
    const closed = new OllamaRuntime({ baseUrl: "http://127.0.0.1:9" });
    const error = await failure(closed.run(request()));
    expect(error.code).toBe("failed");
    expect(error.message).toBe("Ollama is not running.");
  });

  it("stops when aborted, and really ends the request", async () => {
    serve([QWEN]);
    routes.set("POST /api/chat", () => {
      // Thinks forever.
    });
    const controller = new AbortController();
    const running = runtime().run(request(), { signal: controller.signal });
    for (let i = 0; i < 100 && chats().length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    const error = await failure(running);
    expect(error.message).toBe("Cancelled.");
    for (let i = 0; i < 100 && dropped.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(dropped).toContain("/api/chat");
  });

  it("does not start when already aborted", async () => {
    serve([QWEN]);
    const controller = new AbortController();
    controller.abort();
    expect((await failure(runtime().run(request(), { signal: controller.signal }))).message).toBe(
      "Cancelled.",
    );
    expect(seen).toEqual([]);
  });

  it("times out, and ends the request", async () => {
    serve([QWEN]);
    routes.set("POST /api/chat", () => {
      // Never answers.
    });
    const error = await failure(runtime({ timeoutMs: 200 }).run(request()));
    expect(error.message).toBe("Ollama took too long.");
    for (let i = 0; i < 100 && dropped.length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(dropped).toContain("/api/chat");
  });

  it("reads no more than it allows of an answer", async () => {
    serve([QWEN]);
    routes.set("POST /api/chat", (_q, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      const chunk = "x".repeat(1024 * 1024);
      let n = 0;
      const more = () => {
        while (n < 20) {
          n++;
          if (!res.write(chunk)) return void res.once("drain", more);
        }
        res.end();
      };
      more();
    });
    const error = await failure(runtime().run(request()));
    expect(error.message).toBe("Ollama wrote too much.");
  });

  it("never puts mail text, model text or the server's words in an error", async () => {
    serve([QWEN]);
    const errors: AgentRunError[] = [];
    for (const reply of [
      (res: ServerResponse) => json(res, 500, { error: MAIL }),
      (res: ServerResponse) => json(res, 400, { error: MAIL }),
      (res: ServerResponse) => json(res, 404, { error: MAIL }),
      (res: ServerResponse) =>
        json(res, 200, { message: { content: MAIL, thinking: MAIL }, done_reason: "stop" }),
      (res: ServerResponse) =>
        json(res, 200, { message: { content: MAIL }, done_reason: "length" }),
    ]) {
      routes.set("POST /api/chat", (_q, res) => reply(res));
      errors.push(await failure(runtime().run(request())));
    }
    for (const error of errors) {
      expect(error.message).not.toContain("MAIL-TEXT");
      expect(error.message).not.toContain("wire");
      expect(JSON.stringify(error)).not.toContain("MAIL-TEXT");
    }
  });
});

// --- Attachments where the model can (ADR 0119, rule 10) ---

const TOOLS_MODEL: ModelSpec = {
  name: "toolful:8b",
  size: 5_000_000_000,
  capabilities: ["completion", "tools"],
  context: 40_960,
};
const VISION: ModelSpec = {
  name: "seeing:4b",
  size: 3_000_000_000,
  capabilities: ["completion", "vision"],
  context: 32_768,
};

/** A tool server like ours: JSON-RPC over POST /mcp, behind a bearer token. */
async function toolServer(answer: (name: string, args: unknown) => string | null) {
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
                name: "read_file",
                description: "Reads a file.",
                inputSchema: {
                  type: "object",
                  properties: { thread: { type: "integer" }, file: { type: "integer" } },
                },
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
      const text = answer(m.params.name, m.params.arguments);
      if (text === null)
        return json(res, 200, {
          jsonrpc: "2.0",
          id: m.id,
          error: { code: -32602, message: "Unknown tool" },
        });
      json(res, 200, { jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text }] } });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as AddressInfo).port;
  return {
    server: {
      name: "matters",
      url: `http://127.0.0.1:${port}/mcp`,
      token,
      tools: ["search_mail", "read_file"],
    },
    calls,
    close: () =>
      new Promise<void>((resolve) => {
        http.closeAllConnections();
        http.close(() => resolve());
      }),
  };
}

/** The chat endpoint answers each request in turn with what `steps` gives for it. */
function chatSteps(steps: ((body: Record<string, unknown>) => Record<string, unknown>)[]): void {
  let n = 0;
  routes.set("POST /api/chat", (_q, res, body) => {
    const step = steps[Math.min(n++, steps.length - 1)];
    json(res, 200, {
      done: true,
      done_reason: "stop",
      prompt_eval_count: 100,
      eval_count: 10,
      ...(step?.(JSON.parse(body) as Record<string, unknown>) ?? {}),
    });
  });
}
const toolCall = (name: string, args: Record<string, unknown>) => () => ({
  message: {
    role: "assistant",
    content: "",
    tool_calls: [{ function: { name, arguments: args } }],
  },
});
const says = (content: string) => () => ({ message: { role: "assistant", content } });

describe("inspect: what each model can do with attachments (rule 10)", () => {
  it("lists the models that take tools and the files each takes whole", async () => {
    serve([QWEN, TOOLS_MODEL, VISION]);
    const info = await runtime().inspect();
    expect(info.toolModels).toEqual(["qwen3:8b", "toolful:8b"]);
    expect(info.modelFiles).toEqual({
      "qwen3:8b": [],
      "toolful:8b": [],
      "seeing:4b": ["image/jpeg", "image/png"],
    });
  });
});

describe("runWithTools: the loop with our tools (ADR 0083; rule 10)", () => {
  let tools: Awaited<ReturnType<typeof toolServer>>;
  afterEach(async () => {
    await tools?.close();
  });

  it("calls our tools, gives the results back as tool messages, and answers in the schema", async () => {
    serve([TOOLS_MODEL]);
    tools = await toolServer((name) =>
      name === "search_mail" ? "[1] Contract, Alex, 2 files" : "Term: 24 months, notice 3 months.",
    );
    chatSteps([
      toolCall("search_mail", { query: "contract" }),
      () => ({
        message: {
          role: "assistant",
          content: "Reading the file.",
          tool_calls: [{ function: { name: "read_file", arguments: '{"thread":1,"file":1}' } }],
        },
      }),
      says("Done."),
      says('{"kind":"answer"}'),
    ]);
    const events: unknown[] = [];
    const result = await runtime().runWithTools(request({ model: TOOLS_MODEL.name }), {
      server: tools.server,
      onEvent: (e) => events.push(e),
    });
    expect(result).toEqual({ value: { kind: "answer" }, inputTokens: 400, outputTokens: 40 });
    expect(tools.calls).toEqual([
      { name: "search_mail", args: { query: "contract" } },
      { name: "read_file", args: { thread: 1, file: 1 } },
    ]);
    expect(events).toEqual([
      { kind: "tool", name: "search_mail", input: { query: "contract" } },
      { kind: "text", text: "Reading the file." },
      { kind: "tool", name: "read_file", input: { thread: 1, file: 1 } },
    ]);
    const bodies = chats().map((c) => c.body ?? {});
    // Only the tools named for the turn are offered; rounds without the schema, the last with it.
    const offered = ((bodies[0]?.tools ?? []) as { function: { name: string } }[]).map(
      (t) => t.function.name,
    );
    expect(offered).toEqual(["search_mail", "read_file"]);
    expect(bodies.slice(0, 3).every((b) => !("format" in b))).toBe(true);
    expect(bodies[3]?.format).toEqual(SCHEMA);
    expect("tools" in (bodies[3] ?? {})).toBe(false);
    const last = bodies[3]?.messages as { role: string; content: string; tool_name?: string }[];
    expect(last[0]).toEqual({ role: "system", content: request().instructions });
    expect(last.filter((m) => m.role === "tool")).toEqual([
      { role: "tool", tool_name: "search_mail", content: "[1] Contract, Alex, 2 files" },
      { role: "tool", tool_name: "read_file", content: "Term: 24 months, notice 3 months." },
    ]);
    // Mail and file text never reach the system message.
    expect(last[0]?.content).not.toContain("24 months");
  });

  it("gives a tool's error back as its text, and goes on", async () => {
    serve([TOOLS_MODEL]);
    tools = await toolServer(() => null);
    chatSteps([toolCall("read_file", { thread: 9, file: 1 }), says("No."), says('{"kind":"x"}')]);
    const result = await runtime().runWithTools(request({ model: TOOLS_MODEL.name }), {
      server: tools.server,
    });
    expect(result.value).toEqual({ kind: "x" });
    const last = chats().at(-1)?.body?.messages as { role: string; content: string }[];
    expect(last.find((m) => m.role === "tool")?.content).toBe("The tool could not be used.");
  });

  it("stops the turn when the model calls a tool that was not offered", async () => {
    serve([TOOLS_MODEL]);
    tools = await toolServer(() => "x");
    chatSteps([toolCall("count_mail", { query: "x" }), says('{"kind":"x"}')]);
    const error = await failure(
      runtime().runWithTools(request({ model: TOOLS_MODEL.name }), { server: tools.server }),
    );
    expect(error.message).toBe("Ollama called a tool that was turned off.");
    expect(tools.calls).toEqual([]);
  });

  it("refuses a model without tools, a server that is not ours, and files", async () => {
    serve([CODER, TOOLS_MODEL]);
    tools = await toolServer(() => "x");
    expect(
      (
        await failure(
          runtime().runWithTools(request({ model: CODER.name }), { server: tools.server }),
        )
      ).message,
    ).toBe("qwen2.5-coder:1.5b-base cannot use tools.");
    for (const server of [
      { ...tools.server, url: "http://example.com:1/mcp" },
      { ...tools.server, token: "short" },
      { ...tools.server, tools: ["Bad-Name"] },
    ]) {
      expect(
        (await failure(runtime().runWithTools(request({ model: TOOLS_MODEL.name }), { server })))
          .message,
      ).toBe("The tool server is not one this app made.");
    }
    expect(chats()).toEqual([]);
  });

  it("stops the rounds at the cap and answers from what was read", async () => {
    serve([TOOLS_MODEL]);
    tools = await toolServer(() => "more");
    let n = 0;
    routes.set("POST /api/chat", (_q, res, body) => {
      n++;
      const b = JSON.parse(body) as Record<string, unknown>;
      json(res, 200, {
        done: true,
        done_reason: "stop",
        message:
          "format" in b
            ? { role: "assistant", content: '{"kind":"enough"}' }
            : {
                role: "assistant",
                content: "",
                tool_calls: [{ function: { name: "search_mail", arguments: { query: `q${n}` } } }],
              },
      });
    });
    const result = await runtime().runWithTools(request({ model: TOOLS_MODEL.name }), {
      server: tools.server,
    });
    expect(result.value).toEqual({ kind: "enough" });
    expect(tools.calls).toHaveLength(MAX_TOOL_ROUNDS);
  });

  it("stops when aborted, and times out", async () => {
    serve([TOOLS_MODEL]);
    tools = await toolServer(() => "x");
    routes.set("POST /api/chat", () => {
      // Thinks forever.
    });
    const controller = new AbortController();
    const running = runtime().runWithTools(request({ model: TOOLS_MODEL.name }), {
      server: tools.server,
      signal: controller.signal,
    });
    for (let i = 0; i < 100 && chats().length === 0; i++)
      await new Promise((r) => setTimeout(r, 10));
    controller.abort();
    expect((await failure(running)).message).toBe("Cancelled.");
    const late = await failure(
      runtime().runWithTools(request({ model: TOOLS_MODEL.name }), {
        server: tools.server,
        timeoutMs: 200,
      }),
    );
    expect(late.message).toBe("Ollama took too long.");
  });
});

describe("whole files: images to a model that sees them (rule 10)", () => {
  // The first bytes of a PNG, as `bytesMatchType` checks them.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
  const image = { name: "scan.png", mediaType: "image/png" as const, bytes: png };

  it("sends an image as base64 in the person's message, to a model with vision only", async () => {
    serve([VISION, QWEN]);
    answers('{"kind":"x"}');
    await runtime().run(request({ model: VISION.name, files: [image] }));
    const user = ((chats()[0]?.body?.messages ?? []) as { role: string; images?: string[] }[])[1];
    expect(user?.images).toEqual([Buffer.from(png).toString("base64")]);
    const blind = await failure(runtime().run(request({ files: [image] })));
    expect(blind.message).toBe("qwen3:8b does not see images.");
    const pdf = await failure(
      runtime().run(
        request({
          model: VISION.name,
          files: [
            {
              name: "a.pdf",
              mediaType: "application/pdf",
              bytes: new TextEncoder().encode("%PDF-1.4"),
            },
          ],
        }),
      ),
    );
    expect(pdf.message).toBe("Ollama takes images whole, and no other file.");
    expect(chats()).toHaveLength(1);
  });
});

describe("the port", () => {
  it("runs with tools and takes files: per model, as inspect says (rule 10)", () => {
    const r = runtime();
    expect(typeof r.runWithTools).toBe("function");
    expect(r.takesFiles).toBe(true);
  });
});
