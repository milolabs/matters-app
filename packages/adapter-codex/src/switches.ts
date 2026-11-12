// What makes a Codex turn closed (ADR 0120, rule 3), in one place. Codex is a coding agent: by
// default it runs commands, changes files, searches the web, views images on disk, and loads the
// person's configuration, rules, instructions files, plugins, skills, memories, hooks, apps and
// tool servers. A turn here carries mail, so all of that is off. Every switch below is pinned by a
// test of the argv; `--strict-config` makes Codex refuse a key it does not know, so a switch that a
// new version renames fails the turn instead of being ignored. Each new version of Codex needs a
// look at its feature list and its config reference (ADR 0120, Consequences).
//
// Checked against codex-cli 0.163.0: with these switches the request Codex sends to the model
// carries no tool at all (a turn without our tool server), only our instructions and the mail.

/** Flags of `codex exec` for every turn, with what each one keeps out. */
export const EXEC_FLAGS: readonly { readonly flag: string; readonly why: string }[] = [
  { flag: "--json", why: "events as JSON lines on stdout, which the adapter reads" },
  { flag: "--ephemeral", why: "no session is written to disk: the turn keeps nothing" },
  { flag: "--ignore-user-config", why: "the person's config.toml is not read" },
  { flag: "--ignore-rules", why: "no execpolicy rules of the person or a project are read" },
  { flag: "--skip-git-repo-check", why: "the empty directory of the turn is not a repository" },
  { flag: "--strict-config", why: "a switch Codex does not know fails the turn" },
];

/**
 * Feature flags turned off (`--disable <feature>`): every one that gives the model a tool, reads
 * files, reaches the network or another program, or brings in the person's own setup.
 */
export const FEATURES_OFF: readonly { readonly feature: string; readonly why: string }[] = [
  { feature: "shell_tool", why: "running commands" },
  { feature: "unified_exec", why: "running commands in a terminal" },
  { feature: "unified_exec_tty", why: "a terminal for commands" },
  { feature: "shell_snapshot", why: "a copy of the person's shell setup" },
  { feature: "write_stdin_approval", why: "typing into a running command" },
  { feature: "exec_permission_approvals", why: "asking for more rights for a command" },
  { feature: "request_permissions_tool", why: "asking for more rights" },
  { feature: "view_image", why: "viewing image files on disk" },
  { feature: "image_generation", why: "making images" },
  { feature: "browser_use", why: "driving a browser" },
  { feature: "browser_use_external", why: "driving the person's browser" },
  { feature: "browser_use_full_cdp_access", why: "full control of a browser" },
  { feature: "browser_annotation_api", why: "a browser's pages" },
  { feature: "in_app_browser", why: "a browser of its own" },
  { feature: "computer_use", why: "driving the Mac" },
  { feature: "apps", why: "ChatGPT apps and connectors, tool servers of OpenAI" },
  { feature: "enable_mcp_apps", why: "apps from tool servers" },
  { feature: "plugins", why: "the person's plugins" },
  { feature: "remote_plugin", why: "plugins from elsewhere" },
  { feature: "plugin_sharing", why: "shared plugins" },
  { feature: "recommended_plugins", why: "suggested plugins" },
  { feature: "skill_search", why: "the person's skills" },
  { feature: "skill_mcp_dependency_install", why: "installing tool servers for skills" },
  { feature: "tool_suggest", why: "suggesting tools to install" },
  { feature: "multi_agent", why: "sub-agents" },
  { feature: "multi_agent_v2", why: "sub-agents" },
  { feature: "goals", why: "goals kept across turns" },
  { feature: "sleep_tool", why: "waiting" },
  { feature: "hooks", why: "the person's hooks, which run commands" },
  { feature: "memories", why: "memories kept across sessions" },
  { feature: "external_agent_memory_import", why: "memories of other agents" },
  { feature: "code_mode", why: "a script that calls tools" },
  { feature: "code_mode_host", why: "the host that runs such scripts" },
  { feature: "code_mode_only", why: "tools only through a script" },
  { feature: "workspace_dependencies", why: "the project's dependencies" },
  { feature: "worktrees", why: "git worktrees" },
  { feature: "realtime_conversation", why: "voice" },
  { feature: "in_app_local_automation", why: "automations on this Mac" },
  { feature: "daemon_auto_start", why: "a background server that outlives the turn" },
  { feature: "tool_call_mcp_elicitation", why: "tool servers asking the person" },
  { feature: "auth_elicitation", why: "sign-in asked by a tool server" },
  { feature: "guardian_approval", why: "a second model that approves actions" },
  { feature: "standalone_web_search", why: "searching the web" },
  { feature: "current_time_reminder", why: "a clock tool" },
  { feature: "token_budget", why: "tools that manage the context" },
  { feature: "deferred_executor", why: "tools run later" },
  { feature: "agent_message_board", why: "messages between agents" },
  { feature: "send_message_to_user_async", why: "messages to the person outside the answer" },
  { feature: "stable_environment_tools", why: "tools of the machine kept on in every turn" },
  { feature: "artifact", why: "files it makes" },
  { feature: "chronicle", why: "a record of what it does" },
  { feature: "mentions_v2", why: "files named in the text being read in" },
];

/** Settings given with `-c key=value` (TOML values) for every turn. */
export const CONFIG_OFF: readonly {
  readonly key: string;
  readonly value: string;
  readonly why: string;
}[] = [
  { key: "approval_policy", value: '"never"', why: "nothing is ever approved or asked" },
  { key: "web_search", value: '"disabled"', why: "no web search" },
  { key: "tools.experimental_request_user_input.enabled", value: "false", why: "no questions" },
  { key: "tools.update_plan.enabled", value: "false", why: "no plan tool" },
  { key: "agents.enabled", value: "false", why: "no sub-agents" },
  { key: "skills.bundled.enabled", value: "false", why: "no skills of its own" },
  { key: "skills.include_instructions", value: "false", why: "no skill instructions" },
  { key: "memories.use_memories", value: "false", why: "no memories read" },
  { key: "memories.generate_memories", value: "false", why: "no memories kept" },
  { key: "include_environment_context", value: "false", why: "no folder, shell or clock sent" },
  { key: "include_permissions_instructions", value: "false", why: "no sandbox instructions" },
  { key: "include_apps_instructions", value: "false", why: "no apps instructions" },
  {
    key: "include_collaboration_mode_instructions",
    value: "false",
    why: "no collaboration instructions",
  },
  { key: "project_doc_max_bytes", value: "0", why: "no AGENTS.md or other instructions file" },
  { key: "apps._default.enabled", value: "false", why: "no apps" },
  { key: "plugins._default.enabled", value: "false", why: "no plugins" },
  { key: "history.persistence", value: '"none"', why: "no history written" },
  { key: "analytics.enabled", value: "false", why: "no analytics" },
  { key: "feedback.enabled", value: "false", why: "no feedback upload" },
  { key: "check_for_update_on_startup", value: "false", why: "no update check" },
  { key: "shell_environment_policy.inherit", value: '"none"', why: "no environment to commands" },
  { key: "allow_login_shell", value: "false", why: "no login shell" },
  { key: "notify", value: "[]", why: "no program run when the turn ends" },
  { key: "model_reasoning_summary", value: '"none"', why: "no summary of its thinking" },
  { key: "hide_agent_reasoning", value: "true", why: "no thinking in the events" },
  { key: "suppress_unstable_features_warning", value: "true", why: "no warning on stderr" },
];

/**
 * The fields of the model's entry that the adapter writes itself in the catalog of the turn
 * (`model_catalog_json`). Codex decides from this entry which tools of its own the model gets, so
 * the entry turns them off at the source: no shell, no patches, no search tool, no tools only
 * through a script, no sub-agents, no instructions of its own. Every other field is left out
 * unless it is in `CATALOG_KEPT`.
 */
export const CATALOG_SET: Readonly<Record<string, unknown>> = {
  shell_type: "disabled",
  apply_patch_tool_type: null,
  web_search_tool_type: "text",
  tool_mode: "direct",
  experimental_supported_tools: [],
  multi_agent_version: null,
  supports_search_tool: false,
  supports_experimental_context: false,
  include_skills_usage_instructions: false,
  include_plugin_usage_instructions: false,
  include_apps_usage_instructions: false,
  model_messages: null,
  base_instructions: "",
  node_repl_disabled: true,
  node_repl_auto_review_required: false,
  additional_speed_tiers: [],
  service_tiers: [],
};

/** The fields copied from the entry Codex lists for the model: what it is and what it takes. */
export const CATALOG_KEPT: readonly string[] = [
  "slug",
  "display_name",
  "description",
  "default_reasoning_level",
  "supported_reasoning_levels",
  "visibility",
  "supported_in_api",
  "priority",
  "default_reasoning_summary",
  "support_verbosity",
  "default_verbosity",
  "truncation_policy",
  "supports_image_detail_original",
  "context_window",
  "max_context_window",
  "effective_context_window_percent",
  "input_modalities",
  "use_responses_lite",
  "supports_reasoning_effort_updates",
  "comp_hash",
];

/** The entry of one model for the catalog of a turn: what Codex listed, with the tools off. */
export function closedCatalogEntry(
  listed: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const entry: Record<string, unknown> = {};
  for (const key of CATALOG_KEPT) if (Object.hasOwn(listed, key)) entry[key] = listed[key];
  return { ...entry, ...CATALOG_SET };
}

/**
 * The flags and settings of `codex app-server` for the read of the plan's windows (ADR 0120, rule
 * 9), in order, as argv: every feature and setting of a turn that the server takes. It has no flag
 * to ignore the person's config.toml or rules, no `--ephemeral` and no `--skip-git-repo-check`; what
 * the person's config sets beyond the keys here still applies, and `--strict-config` holds it too,
 * so a key there that this version of Codex does not know fails the read. No thread is started, so
 * the rules, which only judge commands, are never consulted.
 */
export function closedServerArgs(): string[] {
  return [
    "--listen",
    "stdio://",
    "--strict-config",
    ...FEATURES_OFF.flatMap((f) => ["--disable", f.feature]),
    ...CONFIG_OFF.flatMap((c) => ["-c", `${c.key}=${c.value}`]),
  ];
}

/** The flags and settings of a closed turn, in order, as argv. */
export function closedArgs(): string[] {
  return [
    ...EXEC_FLAGS.map((f) => f.flag),
    ...FEATURES_OFF.flatMap((f) => ["--disable", f.feature]),
    ...CONFIG_OFF.flatMap((c) => ["-c", `${c.key}=${c.value}`]),
  ];
}
