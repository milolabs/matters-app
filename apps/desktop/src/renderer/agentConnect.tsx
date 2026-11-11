import type { AccountInfo } from "@matters/contracts";
import type { AgentModels, AgentRuntimeInfo, AgentStatus } from "@matters/core";
import { createSignal, For, Index, Show } from "solid-js";
import { modelName, SIGN_IN_COMMAND, vendorName, windowLine } from "./agentText.ts";
import type { Backend } from "./client.ts";
import { field, pill, pillPrimary } from "./ui.ts";

// The pieces that first run and Settings share when they talk about agents (ADR 0051, 0052). The
// app never starts a sign-in and never asks for a credential: where a program is not ready, it
// says what to run in Terminal and looks again when asked.

/** The kinds of work, in the order and with the words the person sees. */
export const WORK: readonly { key: keyof AgentModels; label: string; hint: string }[] = [
  { key: "understand", label: "Understanding mail", hint: "Reading threads for a prompt." },
  { key: "write", label: "Writing when you ask", hint: "A draft you asked for." },
  { key: "answer", label: "Questions about your mail", hint: "For the prompt that comes later." },
  {
    key: "titles",
    label: "Talk titles",
    hint: "A short name for each talk across all mail, from your questions only.",
  },
];

export const WEEK_SHARES: readonly number[] = [5, 10, 25];

const STATUS_WORDS: Record<AgentRuntimeInfo["status"], string> = {
  ready: "Ready",
  found: "Signed in · not checked yet",
  signedOut: "Not signed in",
  missing: "Not found on this Mac",
  failed: "The check did not pass",
};

/**
 * A command to run in Terminal, selectable, with a Copy button. The app only offers the text: it
 * never runs it and never signs in for the person.
 */
export function CopyCommand(props: { command: string }) {
  const [copied, setCopied] = createSignal(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(props.command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // The command is on screen to select; copying is a convenience.
    }
  }
  return (
    <>
      <code class="selectable rounded-[7px] bg-fill px-2.5 py-1 font-mono text-[12px] text-ink">
        {props.command}
      </code>
      <button type="button" class={pill} onClick={() => void copy()}>
        {copied() ? "Copied" : "Copy"}
      </button>
    </>
  );
}

/** One runtime: a dot, its name, plan and status, its windows, and what to do when it is not ready. */
export function RuntimeCard(props: {
  runtime: AgentRuntimeInfo;
  checking: boolean;
  checkFailed?: string;
  onCheck: () => void;
  onLookAgain: () => void;
}) {
  const r = () => props.runtime;
  const now = Date.now();
  const limits = () => r().limits;
  return (
    <div data-runtime={r().id} class="flex flex-col gap-2">
      <div class="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          class="size-[7px] shrink-0 rounded-full"
          classList={{
            "bg-good": r().status === "ready",
            "bg-secondary": r().status === "found",
            "bg-late":
              r().status === "signedOut" || r().status === "missing" || r().status === "failed",
          }}
        />
        <div class="min-w-0 flex-1">
          <p class="truncate">
            <span class="font-semibold">{r().name}</span>
            <Show when={r().plan}>
              <span class="text-secondary"> · {r().plan}</span>
            </Show>
          </p>
          <p class="text-[12px] text-secondary" data-runtime-status>
            {STATUS_WORDS[r().status]}
          </p>
        </div>
        <Show when={r().status === "found" || r().status === "failed"}>
          <button
            type="button"
            class={pill}
            disabled={props.checking}
            onClick={() => props.onCheck()}
          >
            {props.checking ? "Checking…" : "Check"}
          </button>
        </Show>
      </div>
      <Show when={r().status === "ready" || r().status === "found"}>
        <div class="flex flex-col gap-0.5 pl-[17px] text-[12px] text-secondary">
          <For
            each={[
              windowLine("Session", limits()?.session, now),
              windowLine("This week", limits()?.week, now),
            ]}
          >
            {(w) => (
              <p>
                {w.label} <span class="text-ink">{w.left}</span>
                <Show when={w.resets}> · {w.resets}</Show>
              </p>
            )}
          </For>
        </div>
      </Show>
      <Show when={r().status === "signedOut"}>
        <div class="flex flex-col gap-2 pl-[17px] text-[12.5px] leading-[1.5] text-mid">
          <p>
            {r().name} is on this Mac but not signed in. Sign in with its own program, in Terminal.
            This app never signs in for you and never sees your login.
          </p>
          <div class="flex items-center gap-2">
            <CopyCommand command={SIGN_IN_COMMAND} />
            <button type="button" class={pill} onClick={() => props.onLookAgain()}>
              Look again
            </button>
          </div>
        </div>
      </Show>
      <Show when={r().status === "missing"}>
        <div class="flex flex-col gap-2 pl-[17px] text-[12.5px] leading-[1.5] text-mid">
          <p>
            {r().name} was not found on this Mac. Install it from its own documentation, sign in
            with{" "}
            <code class="rounded-[5px] bg-fill px-1.5 font-mono text-[12px] text-ink">
              {SIGN_IN_COMMAND}
            </code>
            , then look again.
          </p>
          <div>
            <button type="button" class={pill} onClick={() => props.onLookAgain()}>
              Look again
            </button>
          </div>
        </div>
      </Show>
      <Show when={r().status === "failed" || props.checkFailed}>
        <p role="alert" class="pl-[17px] text-[12.5px] leading-[1.5] text-late">
          {props.checkFailed ?? r().problem ?? "The check did not pass."}
        </p>
      </Show>
    </div>
  );
}

/** What is not connected yet, said plainly and not clickable. */
export function NotYet() {
  const items = [
    { name: "Codex", detail: "OpenAI's program, on your ChatGPT plan." },
    { name: "Ollama", detail: "A model that runs on this Mac and sends nothing out." },
    { name: "Others", detail: "API keys, your own endpoint, other agents." },
  ];
  return (
    <div class="flex flex-col gap-2">
      <p class="text-[12px] font-semibold text-secondary">Not connected yet</p>
      <ul class="m-0 flex list-none flex-col gap-1.5 p-0">
        <For each={items}>
          {(item) => (
            <li aria-disabled="true" class="flex items-baseline gap-2.5 text-secondary opacity-80">
              <span
                aria-hidden="true"
                class="size-[7px] shrink-0 self-center rounded-full bg-edge"
              />
              <span class="min-w-0 flex-1">
                <span class="font-semibold text-mid">{item.name}</span>
                <span> · {item.detail}</span>
              </span>
              <span class="shrink-0 text-[12px]">Not available yet</span>
            </li>
          )}
        </For>
      </ul>
    </div>
  );
}

/** A select in the app's quiet field style; options are `[value, label]`. */
export function Choice(props: {
  id: string;
  label: string;
  hint?: string;
  value: string;
  options: readonly (readonly [string, string])[];
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  // A value the list does not name (a window set to 7 days) is still shown, not replaced.
  const options = () =>
    props.options.some(([value]) => value === props.value)
      ? props.options
      : [...props.options, [props.value, props.value] as const];
  return (
    <div class="grid grid-cols-[minmax(0,1fr)_minmax(0,230px)] items-center gap-4">
      <label for={props.id} class="min-w-0">
        <span class="block text-[13px]">{props.label}</span>
        <Show when={props.hint}>
          <span class="block text-[12px] text-secondary">{props.hint}</span>
        </Show>
      </label>
      <select
        id={props.id}
        class={`${field} w-full`}
        value={props.value}
        disabled={props.disabled}
        onChange={(e) => props.onChange(e.currentTarget.value)}
      >
        {/* By position: a status brings new arrays with the same options. Rebuilding the elements
            would put the select back on its first option and close it while it is open. */}
        <Index each={options()}>
          {(option) => (
            <option value={option()[0]} selected={option()[0] === props.value}>
              {option()[1]}
            </option>
          )}
        </Index>
      </select>
    </div>
  );
}

/** "What does what": one choice of model for each kind of work, from the runtime's own models. */
export function WhatDoesWhat(props: {
  status: AgentStatus;
  idPrefix: string;
  onChange: (models: Partial<AgentModels>) => void;
  /** Words for the first-run screen: the values are what the app suggests. */
  suggested?: boolean;
}) {
  const runtime = () => props.status.runtime;
  const names = () => runtime()?.models ?? [];
  const by = () => runtime()?.name ?? "";
  return (
    <div class="flex flex-col gap-3">
      <p class="text-[12px] font-semibold text-secondary">
        What does what
        <Show when={props.suggested}>
          <span class="font-normal"> · suggested from what is ready</span>
        </Show>
      </p>
      <For each={WORK}>
        {(work) => (
          <Choice
            id={`${props.idPrefix}-${work.key}`}
            label={work.label}
            value={props.status.settings.models[work.key]}
            options={[
              ...(work.key === "titles" ? ([["off", "Off"]] as const) : []),
              ...names().map((m) => [m, `${modelName(m)} · ${by()}`] as const),
            ]}
            onChange={(value) => props.onChange({ [work.key]: value })}
          />
        )}
      </For>
    </div>
  );
}

/** The background limit, which both Settings and first run name. */
export function Limits(props: {
  status: AgentStatus;
  idPrefix: string;
  onWeekShare: (percent: number) => void;
}) {
  return (
    <Choice
      id={`${props.idPrefix}-share`}
      label="Background limit"
      hint="On plans that show limits. It stops there, never on paid credits."
      value={String(props.status.settings.weekSharePercent)}
      options={WEEK_SHARES.map((n) => [String(n), `Up to ${n}% of my week`] as const)}
      onChange={(v) => props.onWeekShare(Number(v))}
    />
  );
}

/**
 * Shall I read your mail? The one place where mail is agreed to go to a runtime (ADR 0051, rule 6).
 * Nothing is sent before `Turn on`.
 */
export function ConsentQuestion(props: {
  backend: Backend;
  status: AgentStatus;
  /** The accounts this answer is about. */
  accounts: readonly AccountInfo[];
  /** First run offers another account here; Settings does not. */
  onAddAccount?: () => void;
  onStarted: (status: AgentStatus) => void;
  onDeclined: () => void;
  onStatus: (status: AgentStatus) => void;
  declineLabel?: string;
}) {
  const [changing, setChanging] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  const runtime = () => props.status.runtime;
  const ids = () => props.accounts.map((a) => a.id);

  async function setUnderstand(model: string) {
    try {
      props.onStatus(await props.backend.agentSetModels({ understand: model }));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not work.");
    }
  }

  async function start() {
    const r = runtime();
    if (r === null || starting()) return;
    setStarting(true);
    setProblem("");
    try {
      const next = await props.backend.agentSetEnabled({
        accountIds: ids(),
        runtimeId: r.id,
      });
      props.onStarted(next);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "AI could not be turned on.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div class="flex flex-col gap-5">
      <div class="flex items-baseline gap-2.5 text-[13px]">
        <span class="min-w-0 flex-1 truncate">
          Read by{" "}
          <span class="font-semibold">
            {modelName(props.status.settings.models.understand)} · {runtime()?.name ?? ""}
          </span>
        </span>
        <button
          type="button"
          class="cursor-default text-[12.5px] text-mid underline-offset-2 hover:underline"
          aria-expanded={changing()}
          onClick={() => setChanging(!changing())}
        >
          Change
        </button>
      </div>
      <Show when={changing()}>
        <Choice
          id="read-model"
          label="Model for reading"
          value={props.status.settings.models.understand}
          options={(runtime()?.models ?? []).map(
            (m) => [m, `${modelName(m)} · ${runtime()?.name ?? ""}`] as const,
          )}
          onChange={(v) => void setUnderstand(v)}
        />
      </Show>
      <ul class="m-0 flex list-none flex-col gap-1.5 p-0 text-[13.5px]">
        <For each={props.accounts}>
          {(a) => (
            <li class="flex items-center gap-2">
              <span aria-hidden="true" class="size-[7px] shrink-0 rounded-full bg-ink" />
              <span class="min-w-0 truncate">{a.address}</span>
            </li>
          )}
        </For>
      </ul>
      <Show when={props.onAddAccount}>
        <div>
          <button type="button" class={pill} onClick={() => props.onAddAccount?.()}>
            Add another account
          </button>
        </div>
      </Show>
      <p class="text-[12.5px] leading-[1.5] text-secondary">
        Mail goes to {vendorName(runtime())} only when you ask about it, and for views with a
        prompt, such as Needs you, which read new mail as it comes. Your {vendorName(runtime())}{" "}
        privacy settings apply to what is sent.
      </p>
      <Show when={problem() !== ""}>
        <p role="alert" class="text-[13px] text-late">
          {problem()}
        </p>
      </Show>
      <div class="flex items-center gap-3">
        <button
          type="button"
          class={pillPrimary}
          data-turn-on
          disabled={starting() || runtime() === null || props.accounts.length === 0}
          onClick={() => void start()}
        >
          {starting() ? "Turning on…" : "Turn on"}
        </button>
        <button type="button" class={pill} onClick={() => props.onDeclined()}>
          {props.declineLabel ?? "Use without AI"}
        </button>
      </div>
    </div>
  );
}
