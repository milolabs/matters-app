import { readdirSync } from "node:fs";
import { mkdir, utimes } from "node:fs/promises";
import { dirname, join } from "node:path";
import { type AgentRunError, type AgentTurnEvent, isAgentRunError } from "@matters/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ENV_PASSED, TOOL_TOKEN_ENV } from "../src/runtime.ts";
import { CONFIG_OFF, closedArgs, EXEC_FLAGS, FEATURES_OFF } from "../src/switches.ts";
import {
  COMPLETED,
  ev,
  failed,
  GOOD_STREAM,
  Harness,
  message,
  request,
  STARTED,
  TURN,
} from "./support.ts";

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
/** The turn's own directory, as the adapter named it in argv. */
const rootOf = (argv: readonly string[]) => {
  const arg = argv.find((a) => a.startsWith("model_catalog_json=")) ?? "";
  return dirname(dirname(arg.slice('model_catalog_json="'.length, -1)));
};
const turnDirs = () => readdirSync(h.tmpRoot).filter((n) => n.startsWith("matters-codex-"));
/**
 * The directories of turns once the read of the windows that follows a turn has let its server go:
 * the answer does not wait for that server to end, so its directory goes a moment later.
 */
const dirsLeft = async (keep: readonly string[] = []) => {
  for (let i = 0; i < 100; i++) {
    if (turnDirs().every((n) => keep.includes(n))) break;
    await sleep(20);
  }
  return turnDirs();
};
/** The variables the wrapper of the fake program sets itself. */
const WRAPPER_ENV = new Set(["FAKE_CODEX_DIR", "ELECTRON_RUN_AS_NODE", "PWD", "SHLVL", "_"]);
const ownEnv = (env: { [k: string]: string }) =>
  Object.keys(env).filter((k) => !WRAPPER_ENV.has(k) && !k.startsWith("__CF"));

describe("a turn is closed (ADR 0120, rule 3)", () => {
  it("pins every switch: Codex's own tools off, nothing of the person's setup loaded", async () => {
    // A switch taken out of the table, or one renamed, fails here and in review.
    expect(EXEC_FLAGS.map((f) => f.flag)).toEqual([
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      "--skip-git-repo-check",
      "--strict-config",
    ]);
    expect(FEATURES_OFF.map((f) => f.feature)).toEqual([
      "shell_tool",
      "unified_exec",
      "unified_exec_tty",
      "shell_snapshot",
      "write_stdin_approval",
      "exec_permission_approvals",
      "request_permissions_tool",
      "view_image",
      "image_generation",
      "browser_use",
      "browser_use_external",
      "browser_use_full_cdp_access",
      "browser_annotation_api",
      "in_app_browser",
      "computer_use",
      "apps",
      "enable_mcp_apps",
      "plugins",
      "remote_plugin",
      "plugin_sharing",
      "recommended_plugins",
      "skill_search",
      "skill_mcp_dependency_install",
      "tool_suggest",
      "multi_agent",
      "multi_agent_v2",
      "goals",
      "sleep_tool",
      "hooks",
      "memories",
      "external_agent_memory_import",
      "code_mode",
      "code_mode_host",
      "code_mode_only",
      "workspace_dependencies",
      "worktrees",
      "realtime_conversation",
      "in_app_local_automation",
      "daemon_auto_start",
      "tool_call_mcp_elicitation",
      "auth_elicitation",
      "guardian_approval",
      "standalone_web_search",
      "current_time_reminder",
      "token_budget",
      "deferred_executor",
      "agent_message_board",
      "send_message_to_user_async",
      "stable_environment_tools",
      "artifact",
      "chronicle",
      "mentions_v2",
    ]);
    expect(CONFIG_OFF.map((c) => `${c.key}=${c.value}`)).toEqual([
      'approval_policy="never"',
      'web_search="disabled"',
      "tools.experimental_request_user_input.enabled=false",
      "tools.update_plan.enabled=false",
      "agents.enabled=false",
      "skills.bundled.enabled=false",
      "skills.include_instructions=false",
      "memories.use_memories=false",
      "memories.generate_memories=false",
      "include_environment_context=false",
      "include_permissions_instructions=false",
      "include_apps_instructions=false",
      "include_collaboration_mode_instructions=false",
      "project_doc_max_bytes=0",
      "apps._default.enabled=false",
      "plugins._default.enabled=false",
      'history.persistence="none"',
      "analytics.enabled=false",
      "feedback.enabled=false",
      "check_for_update_on_startup=false",
      'shell_environment_policy.inherit="none"',
      "allow_login_shell=false",
      "notify=[]",
      'model_reasoning_summary="none"',
      "hide_agent_reasoning=true",
      "suppress_unstable_features_warning=true",
    ]);
  });

  it("starts `codex exec` with exactly those switches, a read-only sandbox and no tool server", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run(request());
    const { argv } = h.record();
    const root = rootOf(argv);
    const cwd = join(root, "work");
    expect(argv).toEqual([
      "exec",
      ...closedArgs(),
      "-c",
      'model_provider="openai"',
      "-c",
      `model_catalog_json="${join(root, "given", "models.json")}"`,
      "-c",
      `model_instructions_file="${join(root, "given", "instructions.md")}"`,
      "-c",
      `sqlite_home="${join(root, "state")}"`,
      "-c",
      `log_dir="${join(root, "state")}"`,
      "-c",
      "mcp_servers={}",
      "-s",
      "read-only",
      "-C",
      cwd,
      "-m",
      "gpt-6.1-sol",
      "--output-schema",
      join(root, "given", "schema.json"),
      "-",
    ]);
    // Never a switch that approves, bypasses the sandbox or searches the web.
    for (const bad of [
      "--dangerously-bypass-approvals-and-sandbox",
      "--approve-for-me",
      "--search",
      "--add-dir",
      "--worktree",
      "--oss",
      "-p",
      "--profile",
    ]) {
      expect(argv).not.toContain(bad);
    }
    expect(h.turns[0]?.options.shell).toBe(false);
    expect(h.turns[0]?.options.detached).toBe(true);
  });

  it("gives Codex a catalog entry with its own tools off at the source", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run(request());
    const catalog = JSON.parse(h.record().given["models.json"] ?? "");
    expect(catalog.models).toHaveLength(1);
    const entry = catalog.models[0];
    expect(entry).toMatchObject({
      slug: "gpt-6.1-sol",
      shell_type: "disabled",
      apply_patch_tool_type: null,
      tool_mode: "direct",
      experimental_supported_tools: [],
      multi_agent_version: null,
      supports_search_tool: false,
      model_messages: null,
      base_instructions: "",
      input_modalities: ["text", "image"],
      context_window: 500000,
    });
    // What Codex listed and the adapter does not know is not passed on.
    expect(entry.some_new_field).toBeUndefined();
  });

  it("sends the mail on stdin only, and our instructions in Codex's instructions file", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const req = request();
    await h.runtime().run(req);
    const r = h.record();
    expect(r.stdin).toBe(req.untrusted);
    expect(r.given["instructions.md"]).toBe(req.instructions);
    const argv = r.argv.join("\n");
    expect(argv).not.toContain("MAIL-TEXT");
    expect(argv).not.toContain("OUR-INSTRUCTIONS");
  });

  it("works in an empty directory of its own, only this user's, removed afterwards", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run(request());
    const r = h.record();
    expect(r.cwdEntries).toEqual([]);
    expect(r.rootMode).toBe(0o700);
    expect(Object.keys(r.given).sort()).toEqual(["instructions.md", "models.json", "schema.json"]);
    expect(await dirsLeft()).toEqual([]);
  });

  it("passes the child only what Codex needs to find its sign-in", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const runtime = h.runtime({
      env: h.env({
        OPENAI_API_KEY: "sk-SECRET",
        CODEX_API_KEY: "sk-SECRET",
        OPENAI_BASE_URL: "http://elsewhere.example",
        HTTPS_PROXY: "http://proxy.example",
        CODEX_HOME: "/Users/x/.codex",
        MATTERS_DATA: "/secret",
        LANG: "en_US.UTF-8",
      }),
    });
    await runtime.run(request());
    const env = h.record().env;
    for (const key of ownEnv(env)) expect(ENV_PASSED).toContain(key);
    expect(env.CODEX_HOME).toBe("/Users/x/.codex");
    expect(env.LANG).toBe("en_US.UTF-8");
    expect(JSON.stringify(env)).not.toContain("SECRET");
    expect(env.OPENAI_BASE_URL).toBeUndefined();
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env[TOOL_TOKEN_ENV]).toBeUndefined();
    // The status command too.
    expect(JSON.stringify(h.loginRecord().env)).not.toContain("SECRET");
  });

  it("removes the directory of the turn when the child crashes", async () => {
    await h.scenario({ lines: [STARTED], exitCode: 3 });
    const error = await failure(h.runtime().run(request()));
    expect(error.code).toBe("failed");
    expect(error.message).toBe("Codex ended without an answer (exit 3).");
    expect(await dirsLeft()).toEqual([]);
  });

  it("fails the turn and stops Codex at once when it uses a tool of its own", async () => {
    for (const type of ["command_execution", "file_change", "web_search", "collab_tool_call"]) {
      await h.scenario({
        lines: [STARTED, TURN, ev({ type: "item.started", item: { id: "i", type } })],
        afterMs: 3000,
        lateLines: [message('{"kind":"x"}'), COMPLETED],
      });
      const error = await failure(h.runtime().run(request()));
      expect(error.message).toBe("Codex used a tool of its own, which is turned off.");
      expect(h.survived()).toBe(false);
    }
  });

  it("fails on a kind of item or event it does not know, and on a call of a tool server", async () => {
    for (const line of [
      ev({ type: "item.started", item: { id: "i", type: "browser_action" } }),
      ev({ type: "item.started", item: { id: "i" } }),
      ev({ type: "session.configured", tools: [] }),
      ev({
        type: "item.started",
        item: { id: "i", type: "mcp_tool_call", server: "matters", tool: "search_mail" },
      }),
    ]) {
      await h.scenario({ lines: [STARTED, TURN, line, ...GOOD_STREAM.slice(2)] });
      const error = await failure(h.runtime().run(request()));
      expect(error.message).toBe("Codex used a tool of its own, which is turned off.");
    }
  });

  it("refuses a model name that could pass for a flag or reach the config, without starting", async () => {
    for (const model of ["--help", "-m", "a b", 'x"y', "x=1", "", "a/b"]) {
      expect((await failure(h.runtime().run(request({ model })))).code).toBe("failed");
    }
    expect(h.spawns).toHaveLength(0);
  });
});

describe("the answer (ADR 0120, rule 5)", () => {
  it("returns the answer in our schema's shape and the tokens", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const out = await h.runtime().run(request());
    // The null Codex wrote for an optional property is taken out.
    expect(out.value).toEqual({ kind: "acknowledgement" });
    expect(out.inputTokens).toBe(894);
    expect(out.outputTokens).toBe(54);
    // `exec` reports no windows: these come from the read after the turn (rule 9).
    expect(out.limits?.week?.usedPercent).toBe(41);
  });

  it("gives Codex the schema in the strict form: all required, optional ones nullable", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run(request());
    expect(JSON.parse(h.record().given["schema.json"] ?? "")).toEqual({
      type: "object",
      additionalProperties: false,
      required: ["kind", "note"],
      properties: {
        kind: { type: "string" },
        note: { anyOf: [{ type: "string" }, { type: "null" }] },
      },
    });
  });

  it("takes the last message as the answer, and refuses one that is not an object", async () => {
    await h.scenario({
      lines: [STARTED, TURN, message("thinking"), message('{"kind":"b"}'), COMPLETED],
    });
    expect((await h.runtime().run(request())).value).toEqual({ kind: "b" });
    for (const text of ["not json", "42", "null", ""]) {
      await h.scenario({ lines: [STARTED, TURN, message(text), COMPLETED] });
      expect((await failure(h.runtime().run(request()))).code).toBe("badAnswer");
    }
    await h.scenario({ lines: [STARTED, TURN, COMPLETED] });
    expect((await failure(h.runtime().run(request()))).code).toBe("badAnswer");
  });

  it("ignores lines that are not events, and reasoning and warnings", async () => {
    await h.scenario({
      lines: [
        "WARNING: something",
        STARTED,
        "[1,2]",
        ev({ type: "item.completed", item: { id: "r", type: "reasoning", text: "hmm" } }),
        ev({ type: "item.completed", item: { id: "e", type: "error", message: "metadata" } }),
        ...GOOD_STREAM.slice(1),
      ],
    });
    expect((await h.runtime().run(request())).value).toEqual({ kind: "acknowledgement" });
  });

  it("fails when the answer comes before the turn started", async () => {
    await h.scenario({ lines: [message('{"kind":"x"}'), COMPLETED] });
    expect((await failure(h.runtime().run(request()))).message).toBe(
      "The answer came without the start of the turn.",
    );
  });
});

describe("failures are said in our words (ADR 0120, rule 10)", () => {
  it("maps a usage limit to limit, with the time it lifts when Codex says it", async () => {
    await h.scenario({
      lines: failed(
        "You’ve hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro) or try again at Dec 13th, 2099 3:45 PM.",
      ),
    });
    const error = await failure(h.runtime().run(request()));
    expect(error.code).toBe("limit");
    expect(error.message).toBe("The plan's limit is reached.");
    expect(error.untilMs).toBe(new Date(2099, 11, 13, 15, 45).getTime());
    await h.scenario({ lines: failed("You’ve hit your usage limit. Try again later.") });
    const later = await failure(h.runtime().run(request()));
    expect(later.code).toBe("limit");
    expect(later.untilMs).toBeUndefined();
  });

  it("maps a sign-in that no longer holds to notSignedIn", async () => {
    await h.scenario({ lines: failed("unexpected status 401 Unauthorized: token expired") });
    const error = await failure(h.runtime().run(request()));
    expect(error.code).toBe("notSignedIn");
    expect(error.message).toBe(
      "Codex is not signed in. Run `codex login` in Terminal, then look again.",
    );
  });

  it("maps a refusal, a model that is gone, and anything else", async () => {
    await h.scenario({ lines: failed("This request violates our usage policy") });
    expect((await failure(h.runtime().run(request()))).code).toBe("refused");
    await h.scenario({ lines: failed("The model `gpt-6.1-sol` does not exist") });
    expect((await failure(h.runtime().run(request()))).message).toBe(
      "Codex does not offer gpt-6.1-sol now. Choose another in Settings.",
    );
    await h.scenario({ lines: failed("stream disconnected") });
    expect((await failure(h.runtime().run(request()))).message).toBe("Codex reported an error.");
  });

  it("never puts mail text, Codex's text or stderr in an error", async () => {
    const secret = "MAIL-SECRET-42";
    for (const text of [
      `You’ve hit your usage limit ${secret}`,
      `401 ${secret}`,
      `boom ${secret}`,
      `reasoning effort ${secret}`,
      `context window exceeded ${secret}`,
    ]) {
      await h.scenario({ lines: failed(text), stderr: secret });
      const error = await failure(h.runtime().run(request({ effort: "low" })));
      expect(error.message).not.toContain(secret);
      expect(error.message).not.toContain("401");
    }
    await h.scenario({ lines: [STARTED], stderr: `Error: ${secret}`, exitCode: 1 });
    expect((await failure(h.runtime().run(request()))).message).not.toContain(secret);
  });

  it("reads stderr to sort a failure when there is no event", async () => {
    await h.scenario({ stderr: "Error: Not logged in. Run codex login.", exitCode: 1 });
    expect((await failure(h.runtime().run(request()))).code).toBe("notSignedIn");
  });
});

describe("effort (ADR 0120, rule 8)", () => {
  it("is set through the config only when asked for", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run(request());
    expect(h.record().argv.join(" ")).not.toContain("model_reasoning_effort");
    for (const effort of ["low", "medium", "high", "xhigh", "max"] as const) {
      await h.runtime().run(request({ effort }));
      const argv = h.record().argv;
      expect(argv[argv.indexOf(`model_reasoning_effort="${effort}"`) - 1]).toBe("-c");
    }
  });

  it("refuses a level the model does not list, before starting the turn", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const error = await failure(h.runtime().run(request({ model: "gpt-6-luna", effort: "high" })));
    expect(error.code).toBe("effortRefused");
    expect(error.message).toBe(
      "gpt-6-luna does not take the effort high. Choose another in Settings.",
    );
    expect(h.turns).toHaveLength(0);
  });

  it("takes a failure that names the effort, on a turn that set one, as its refusal", async () => {
    await h.scenario({ lines: failed("Unsupported value: reasoning.effort 'max'") });
    expect((await failure(h.runtime().run(request({ effort: "max" })))).code).toBe("effortRefused");
    expect((await failure(h.runtime().run(request()))).code).toBe("failed");
  });

  it("refuses an effort it does not know, without starting anything", async () => {
    for (const effort of ["--bad", "ultra", "LOW", "default"]) {
      const bad = { ...request(), effort } as unknown as Parameters<
        ReturnType<typeof h.runtime>["run"]
      >[0];
      expect((await failure(h.runtime().run(bad))).code).toBe("failed");
    }
    expect(h.spawns).toHaveLength(0);
  });
});

describe("the plan and the models (ADR 0120, rules 1, 2 and 8)", () => {
  it("is found when signed in with ChatGPT, with the models Codex lists for the plan", async () => {
    const info = await h.runtime().inspect();
    expect(info).toMatchObject({
      id: "codex",
      name: "Codex",
      status: "found",
      plan: "plus",
      models: ["gpt-6.1-sol", "gpt-6-luna"],
      modelEfforts: {
        // Codex's own `ultra` is not one of ours.
        "gpt-6.1-sol": ["low", "medium", "high", "xhigh", "max"],
        "gpt-6-luna": ["low", "medium"],
      },
      modelFiles: {
        "gpt-6.1-sol": ["image/jpeg", "image/png", "image/gif", "image/webp"],
        "gpt-6-luna": [],
      },
      defaultModel: "gpt-6.1-sol",
      defaultModels: {
        understand: "gpt-6-luna",
        titles: "gpt-6-luna",
        write: "gpt-6.1-sol",
        answer: "gpt-6.1-sol",
      },
      pausesOnLimit: true,
    });
    expect(info.turnsAtOnce).toBeUndefined();
    expect(info.toolModels).toBeUndefined();
    expect(h.turns).toHaveLength(0);
  });

  it("is signed out when Codex is not signed in, and says what to run", async () => {
    await h.scenario({ login: "Not logged in" });
    const info = await h.runtime().inspect();
    expect(info.status).toBe("signedOut");
    expect(info.problem).toBe("Not signed in. Run `codex login` in Terminal, then look again.");
  });

  it("does not use a Codex signed in with a key, and keeps the key out of what it says", async () => {
    for (const login of [
      "Logged in using an API key - sk-proj-***ABCD",
      "Logged in using access token",
      "Logged in using Amazon Bedrock API key",
    ]) {
      await h.scenario({ login });
      const info = await h.runtime().inspect();
      expect(info.status).toBe("signedOut");
      expect(info.models).toEqual([]);
      expect(info.problem).toContain("ChatGPT plan");
      expect(info.problem).not.toContain("ABCD");
    }
  });

  it("asks again before each turn, and starts no turn off the plan", async () => {
    await h.scenario({ login: "Logged in using an API key - sk-***", lines: GOOD_STREAM });
    expect((await failure(h.runtime().run(request()))).code).toBe("notPlan");
    await h.scenario({ login: "Not logged in", lines: GOOD_STREAM });
    expect((await failure(h.runtime().run(request()))).code).toBe("notSignedIn");
    expect(h.turns).toHaveLength(0);
  });

  it("is missing when the program is not on PATH, and failed when its answer is not understood", async () => {
    const missing = await h.runtime({ env: { PATH: "/nonexistent" } }).inspect();
    expect(missing.status).toBe("missing");
    expect(missing.problem).toBe("Codex is not installed, or is not on this app's PATH.");
    await h.scenario({ login: "Something else entirely" });
    expect((await h.runtime().inspect()).status).toBe("failed");
  });

  it("names its own short list when Codex lists none", async () => {
    await h.scenario({ models: "not json" });
    const info = await h.runtime().inspect();
    expect(info.status).toBe("found");
    expect(info.models).toContain("gpt-6.1-sol");
    expect(info.models.length).toBeGreaterThan(1);
    await h.scenario({ models: JSON.stringify({ models: [] }), modelsExit: 0 });
    expect((await h.runtime().inspect()).models.length).toBeGreaterThan(1);
  });

  it("refuses a model Codex does not offer now, without starting the turn", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const error = await failure(h.runtime().run(request({ model: "gpt-1-gone" })));
    expect(error.message).toBe("Codex does not offer gpt-1-gone now. Choose another in Settings.");
    expect(h.turns).toHaveLength(0);
  });

  it("removes directories of turns a crash of the app left behind", async () => {
    const old = join(h.tmpRoot, "matters-codex-left");
    await mkdir(old);
    const past = new Date(Date.now() - 3 * 3_600_000);
    await utimes(old, past, past);
    const fresh = join(h.tmpRoot, "matters-codex-running");
    await mkdir(fresh);
    await h.runtime().inspect();
    expect(await dirsLeft(["matters-codex-running"])).toEqual(["matters-codex-running"]);
  });
});

describe("stopping (ADR 0120, rule 3)", () => {
  it("times out, kills the child and what it started, and cleans up", async () => {
    await h.scenario({ lines: [STARTED], hang: true, grandchildMs: 1500 });
    const error = await failure(h.runtime({ timeoutMs: 400 }).run(request()));
    expect(error.message).toBe("Codex took too long.");
    await sleep(1800);
    expect(h.survived("grandchild-survived")).toBe(false);
    expect(await dirsLeft()).toEqual([]);
  });

  it("stops when aborted, and kills the child", async () => {
    await h.scenario({ lines: [STARTED], afterMs: 1500, lateLines: GOOD_STREAM.slice(1) });
    const controller = new AbortController();
    const running = h.runtime().run(request(), { signal: controller.signal });
    await sleep(400);
    controller.abort();
    const error = await failure(running);
    expect(error.message).toBe("Cancelled.");
    await sleep(1500);
    expect(h.survived()).toBe(false);
    expect(await dirsLeft()).toEqual([]);
  });

  it("does not start when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    expect((await failure(h.runtime().run(request(), { signal: controller.signal }))).message).toBe(
      "Cancelled.",
    );
    expect(h.spawns).toHaveLength(0);
  });
});

describe("tools are ours, for the turn (ADR 0120, rule 6)", () => {
  const server = {
    name: "matters",
    url: "http://127.0.0.1:43210/mcp",
    token: "tok_ABCDEFGHIJKLMNOPQRSTUV",
    tools: ["search_mail", "open_thread", "read_file"],
  };
  const call = (tool: string, id: string, srv = "matters") =>
    ev({
      type: "item.started",
      item: { id, type: "mcp_tool_call", server: srv, tool, arguments: { query: "x" } },
    });

  it("names our server for this turn only, with its token in the child's environment", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().runWithTools(request(), { server });
    const { argv, env } = h.record();
    const config = argv.find((a) => a.startsWith("mcp_servers."));
    expect(config).toBe(
      'mcp_servers.matters={url="http://127.0.0.1:43210/mcp",bearer_token_env_var="MATTERS_TOOL_TOKEN",' +
        'enabled_tools=["search_mail","open_thread","read_file"],required=true,startup_timeout_sec=15,' +
        'tool_timeout_sec=300,default_tools_approval_mode="approve"}',
    );
    expect(argv).not.toContain("mcp_servers={}");
    expect(argv.join(" ")).not.toContain(server.token);
    expect(env[TOOL_TOKEN_ENV]).toBe(server.token);
    // Everything else as in a plain turn.
    for (const arg of closedArgs()) expect(argv).toContain(arg);
    expect(Object.keys(h.record().given)).not.toContain("mcp.json");
  });

  it("tells each step: its notes and the calls of our tools, and the last message is the answer", async () => {
    await h.scenario({
      lines: [
        STARTED,
        TURN,
        message("I will search first.", "m1"),
        call("search_mail", "c1"),
        ev({
          type: "item.completed",
          item: {
            id: "c1",
            type: "mcp_tool_call",
            server: "matters",
            tool: "search_mail",
            arguments: { query: "x" },
            status: "completed",
          },
        }),
        message('{"kind":"found"}', "m2"),
        COMPLETED,
      ],
    });
    const events: AgentTurnEvent[] = [];
    const out = await h.runtime().runWithTools(request(), {
      server,
      onEvent: (e) => events.push(e),
    });
    expect(events).toEqual([
      { kind: "text", text: "I will search first." },
      { kind: "tool", name: "search_mail", input: { query: "x" } },
    ]);
    expect(out.value).toEqual({ kind: "found" });
  });

  it("stops the turn on a tool it was not given, or one of another server", async () => {
    for (const line of [call("delete_mail", "c1"), call("search_mail", "c1", "other")]) {
      await h.scenario({
        lines: [STARTED, TURN, line],
        afterMs: 3000,
        lateLines: GOOD_STREAM.slice(2),
      });
      const error = await failure(
        h.runtime().runWithTools(request(), { server: { ...server, tools: ["search_mail"] } }),
      );
      expect(error.message).toBe("Codex called a tool that was turned off.");
      expect(h.survived()).toBe(false);
    }
  });

  it("refuses a server that is not one this app made, before starting anything", async () => {
    for (const bad of [
      { ...server, url: "http://example.com/mcp" },
      { ...server, name: 'x"y' },
      { ...server, token: "short" },
      { ...server, tools: ['a"b'] },
      { ...server, tools: [] },
    ]) {
      expect((await failure(h.runtime().runWithTools(request(), { server: bad }))).code).toBe(
        "failed",
      );
    }
    expect(h.spawns).toHaveLength(0);
  });
});

describe("images go whole, a PDF does not (ADR 0120, rule 7)", () => {
  const png = {
    mediaType: "image/png" as const,
    bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]),
    name: "a.png",
  };
  const jpeg = {
    mediaType: "image/jpeg" as const,
    bytes: new Uint8Array([0xff, 0xd8, 0xff, 0xe0]),
    name: "b.jpg",
  };

  it("gives images as files of the turn, each with its own flag before the others", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    await h.runtime().run(request({ files: [png, jpeg] }));
    const { argv, given } = h.record();
    const root = rootOf(argv);
    expect(argv.slice(0, 3)).toEqual([
      "exec",
      `--image=${join(root, "given", "image-1.png")}`,
      `--image=${join(root, "given", "image-2.jpg")}`,
    ]);
    expect(given["image-1.png"]).toBe(Buffer.from(png.bytes).toString("latin1"));
    expect(argv.at(-1)).toBe("-");
    expect(await dirsLeft()).toEqual([]);
  });

  it("refuses a PDF, images to a model that does not see them, and files in a turn with tools", async () => {
    await h.scenario({ lines: GOOD_STREAM });
    const pdf = {
      mediaType: "application/pdf" as const,
      bytes: new TextEncoder().encode("%PDF-1.4"),
      name: "c.pdf",
    };
    expect((await failure(h.runtime().run(request({ files: [pdf] })))).message).toBe(
      "Codex takes images whole, and no other file.",
    );
    expect(
      (await failure(h.runtime().run(request({ model: "gpt-6-luna", files: [png] })))).message,
    ).toBe("gpt-6-luna does not see images.");
    const server = {
      name: "matters",
      url: "http://127.0.0.1:1/mcp",
      token: "tok_ABCDEFGHIJKLMNOPQRSTUV",
      tools: ["search_mail"],
    };
    expect(
      (await failure(h.runtime().runWithTools(request({ files: [png] }), { server }))).message,
    ).toBe("Files do not go to a turn with tools.");
    expect(h.turns).toHaveLength(0);
  });
});
