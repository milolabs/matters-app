import type { AccountInfo } from "@matters/contracts";
import type {
  AgentEffortSetting,
  AgentEfforts,
  AgentModels,
  AgentRuntimeEntry,
  AgentRuntimeInfo,
  AgentStatus,
  AgentWorkKind,
} from "@matters/core";
import { kindInfo, kindsOn, runtimeInfo, runtimesInUse } from "@matters/core";
import { createSignal, For, Index, type JSX, Show } from "solid-js";
import {
  consentText,
  effortOptions,
  effortShown,
  hasNoPlan,
  kindsWords,
  kindWaits,
  modelName,
  signInCommand,
  statusWords,
  usedForLine,
  windowLine,
} from "./agentText.ts";
import type { Backend } from "./client.ts";
import { field, pill, pillPrimary } from "./ui.ts";

// The pieces that first run and Settings share when they talk about agents (ADR 0051, 0052). The
// app never starts a sign-in and never asks for a credential: where a program is not ready, it
// says what to run in Terminal and looks again when asked.

/** The kinds of work, in the order and with the words the person sees. */
export const WORK: readonly { key: AgentWorkKind; label: string; hint: string }[] = [
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

/** A sentence of ours with `commands` in backticks, the commands set as code. Text only. */
function WithCode(props: { text: string }) {
  return (
    <Index each={props.text.split("`")}>
      {(part, i) =>
        i % 2 === 1 ? (
          <code class="rounded-[5px] bg-fill px-1.5 font-mono text-[12px] text-ink">{part()}</code>
        ) : (
          part()
        )
      }
    </Index>
  );
}

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
  /** Its windows show: it is in use and runs on a plan (ADR 0121, rule 6). */
  windows?: boolean;
  /** What it does, under its state: `Used for writing`. */
  usedFor?: string;
  onCheck: () => void;
  onLookAgain: () => void;
}) {
  const r = () => props.runtime;
  const now = Date.now();
  const limits = () => r().limits;
  return (
    <div data-runtime={r().id} data-runtime-state={r().status} class="flex flex-col gap-2">
      <div class="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          class="size-[7px] shrink-0 rounded-full"
          classList={{
            "bg-good": r().status === "ready",
            "bg-secondary": r().status === "found",
            "bg-late":
              r().status === "signedOut" ||
              r().status === "missing" ||
              r().status === "failed" ||
              r().status === "notRunning" ||
              r().status === "noModel",
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
            {statusWords(r())}
            <Show when={props.usedFor}>{(used) => <span data-runtime-used> · {used()}</span>}</Show>
          </p>
        </div>
        <Show when={r().status === "found" || r().status === "failed"}>
          <button
            type="button"
            class={pill}
            data-runtime-check={r().id}
            disabled={props.checking}
            onClick={() => props.onCheck()}
          >
            {props.checking ? "Checking…" : "Check"}
          </button>
        </Show>
      </div>
      <Show
        when={
          props.windows !== false &&
          (r().status === "ready" || r().status === "found") &&
          !hasNoPlan(r())
        }
      >
        <div class="flex flex-col gap-0.5 pl-[17px] text-[12px] text-secondary" data-windows>
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
          <Show
            when={r().problem}
            fallback={
              <p>
                {r().name} is on this Mac but not signed in. Sign in with its own program, in
                Terminal. This app never signs in for you and never sees your login.
              </p>
            }
          >
            {(problem) => (
              <p data-runtime-problem>
                <WithCode text={problem()} /> This app never signs in for you and never sees your
                login.
              </p>
            )}
          </Show>
          <div class="flex items-center gap-2">
            <CopyCommand command={signInCommand(r())} />
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
              {signInCommand(r())}
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
      <Show when={r().status === "notRunning" || r().status === "noModel"}>
        <div class="flex flex-col gap-2 pl-[17px] text-[12.5px] leading-[1.5] text-mid">
          <p data-runtime-problem>
            <WithCode text={r().problem ?? `${r().name} cannot be used now. Look again later.`} />
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

/**
 * The first runtime, at first run (ADR 0119, rule 2; ADR 0121, rule 12): every runtime the app
 * knows, each with its dot, name and state, the one every kind of work is on marked and shown
 * whole. Choosing sends nothing and agrees to nothing.
 */
export function RuntimeChoice(props: {
  status: AgentStatus;
  checking: boolean;
  checkFailed?: string;
  choosing: boolean;
  onChoose: (runtimeId: string) => void;
  onCheck: () => void;
  onLookAgain: () => void;
}) {
  const chosen = () => props.status.settings.kindRuntime.understand;
  return (
    <div role="radiogroup" aria-label="Assistant" class="flex flex-col gap-2">
      <For each={props.status.runtimes}>
        {(entry: AgentRuntimeEntry) => (
          <div
            data-runtime-option={entry.id}
            data-chosen={chosen() === entry.id ? "" : undefined}
            class="flex items-start gap-2.5 rounded-[10px] border p-3"
            classList={{
              "border-edge": chosen() === entry.id,
              "border-hairline": chosen() !== entry.id,
            }}
          >
            <input
              type="radio"
              name="agent-runtime"
              class="mt-[3px]"
              aria-label={entry.name}
              checked={chosen() === entry.id}
              disabled={props.choosing}
              onChange={() => props.onChoose(entry.id)}
            />
            <div class="min-w-0 flex-1">
              <Show
                when={chosen() === entry.id && entry.info !== null ? entry.info : null}
                fallback={
                  <button
                    type="button"
                    class="flex w-full cursor-default items-center gap-2.5 text-left"
                    disabled={props.choosing}
                    onClick={() => props.onChoose(entry.id)}
                  >
                    <span
                      aria-hidden="true"
                      class="size-[7px] shrink-0 rounded-full"
                      classList={{
                        "bg-good": entry.info?.status === "ready",
                        "bg-secondary": entry.info === null || entry.info.status === "found",
                        "bg-late":
                          entry.info !== null &&
                          entry.info.status !== "ready" &&
                          entry.info.status !== "found",
                      }}
                    />
                    <span class="min-w-0 flex-1">
                      <span class="block truncate font-semibold">{entry.name}</span>
                      <span class="block text-[12px] text-secondary" data-runtime-status>
                        {statusWords(entry.info)}
                      </span>
                    </span>
                  </button>
                }
              >
                {(info) => (
                  <RuntimeCard
                    runtime={info()}
                    checking={props.checking}
                    {...(props.checkFailed === undefined ? {} : { checkFailed: props.checkFailed })}
                    onCheck={props.onCheck}
                    onLookAgain={props.onLookAgain}
                  />
                )}
              </Show>
            </div>
          </div>
        )}
      </For>
    </div>
  );
}

/**
 * Every runtime the app knows, in Settings (ADR 0121, rule 2): each with its state, what it is used
 * for, a way to check it, and the windows of its plan while a kind of work is on it (rule 6). One
 * can be connected and checked before a kind moves to it.
 */
export function RuntimeList(props: {
  status: AgentStatus;
  /** The runtime being checked now, if any. */
  checking: string | null;
  /** The runtime whose check failed, and how. */
  checkFailed?: { readonly runtimeId: string; readonly problem: string };
  onCheck: (runtimeId: string) => void;
  onLookAgain: () => void;
}) {
  const inUse = () => runtimesInUse(props.status.settings);
  return (
    <div class="flex flex-col gap-2" data-runtimes>
      <For each={props.status.runtimes}>
        {(entry: AgentRuntimeEntry) => (
          <div
            data-runtime-option={entry.id}
            data-in-use={inUse().includes(entry.id) ? "" : undefined}
            class="rounded-[10px] border p-3"
            classList={{
              "border-edge": inUse().includes(entry.id),
              "border-hairline": !inUse().includes(entry.id),
            }}
          >
            <Show
              when={entry.info}
              fallback={
                <div class="flex items-center gap-2.5">
                  <span aria-hidden="true" class="size-[7px] shrink-0 rounded-full bg-secondary" />
                  <span class="min-w-0 flex-1">
                    <span class="block truncate font-semibold">{entry.name}</span>
                    <span class="block text-[12px] text-secondary" data-runtime-status>
                      {statusWords(null)} · {usedForLine(props.status, entry.id)}
                    </span>
                  </span>
                </div>
              }
            >
              {(info) => (
                <RuntimeCard
                  runtime={info()}
                  checking={props.checking === entry.id}
                  {...(props.checkFailed?.runtimeId === entry.id
                    ? { checkFailed: props.checkFailed.problem }
                    : {})}
                  windows={inUse().includes(entry.id)}
                  usedFor={usedForLine(props.status, entry.id)}
                  onCheck={() => props.onCheck(entry.id)}
                  onLookAgain={props.onLookAgain}
                />
              )}
            </Show>
          </div>
        )}
      </For>
    </div>
  );
}

/** What is not connected yet, said plainly and not clickable. */
export function NotYet() {
  const items = [{ name: "Others", detail: "API keys, your own endpoint, other agents." }];
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
  /** A second control beside the select, such as the effort of a kind of work (ADR 0118). */
  aside?: JSX.Element | undefined;
}) {
  // A value the list does not name (a window set to 7 days) is still shown, not replaced.
  const options = () =>
    props.options.some(([value]) => value === props.value)
      ? props.options
      : [...props.options, [props.value, props.value] as const];
  return (
    <div
      class="grid items-center gap-4"
      classList={{
        "grid-cols-[minmax(0,1fr)_minmax(0,230px)]": props.aside === undefined,
        "grid-cols-[minmax(0,1fr)_minmax(0,230px)_112px]": props.aside !== undefined,
      }}
    >
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
      {props.aside}
    </div>
  );
}

/** The effort of one kind of work, in the same quiet field style (ADR 0118). */
function EffortChoice(props: {
  id: string;
  label: string;
  value: AgentEffortSetting;
  options: readonly (readonly [AgentEffortSetting, string])[];
  disabled: boolean;
  onChange: (value: AgentEffortSetting) => void;
}) {
  return (
    <select
      id={props.id}
      aria-label={`${props.label}, effort`}
      data-effort
      class={`${field} w-full`}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onChange(e.currentTarget.value as AgentEffortSetting)}
    >
      <Index each={props.options}>
        {(option) => (
          <option value={option()[0]} selected={option()[0] === props.value}>
            {option()[1]}
          </option>
        )}
      </Index>
    </select>
  );
}

/** A select of the kind's row, in the same quiet field style. Options are `[value, label]`. */
function RowSelect(props: {
  id: string;
  label: string;
  value: string;
  options: readonly (readonly [string, string])[];
  disabled?: boolean;
  data?: string;
  onChange: (value: string) => void;
}) {
  // A value the list does not name (a model a runtime no longer lists) is still shown, not replaced.
  const options = () =>
    props.options.some(([value]) => value === props.value)
      ? props.options
      : [...props.options, [props.value, props.value] as const];
  return (
    <select
      id={props.id}
      aria-label={props.label}
      data-row={props.data}
      class={`${field} w-full`}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => {
        const el = e.currentTarget;
        props.onChange(el.value);
        // What it shows is what is so: a choice that was not taken, or not yet, goes back.
        queueMicrotask(() => {
          if (el.value !== props.value) el.value = props.value;
        });
      }}
    >
      <Index each={options()}>
        {(option) => (
          <option value={option()[0]} selected={option()[0] === props.value}>
            {option()[1]}
          </option>
        )}
      </Index>
    </select>
  );
}

/**
 * "What does what": for each kind of work one row: who does it, on which model, at which effort
 * (ADR 0118; ADR 0121, rule 1). The models are those of the kind's runtime, and the levels those of
 * the model; none when it lists none. With `onRuntime`, the runtime of each kind can be changed
 * there (Settings); without, every kind stays where it is (first run).
 */
export function WhatDoesWhat(props: {
  status: AgentStatus;
  idPrefix: string;
  onChange: (models: Partial<AgentModels>, efforts?: Partial<AgentEfforts>) => void;
  /** The person moves a kind of work to another runtime. */
  onRuntime?: (kind: AgentWorkKind, runtimeId: string) => void;
  /** The runtime a kind is about to move to, while the person is asked to agree to it. */
  pending?: (kind: AgentWorkKind) => string | undefined;
  /** Words for the first-run screen: the values are what the app suggests. */
  suggested?: boolean;
}) {
  const runtimeOf = (key: AgentWorkKind) => kindInfo(props.status, key);
  const nameOf = (key: AgentWorkKind) => {
    const id = props.status.settings.kindRuntime[key];
    return props.status.runtimes.find((r) => r.id === id)?.name ?? "";
  };
  /** The levels of the model chosen for a kind of work (ADR 0119, rule 9). */
  const efforts = (key: AgentWorkKind) =>
    effortOptions(runtimeOf(key), props.status.settings.models[key]);
  const anyEffort = () => WORK.some((w) => efforts(w.key).length > 0);
  const unlisted = () => props.status.unlisted;
  const allNoPlan = () =>
    runtimesInUse(props.status.settings).every((id) => hasNoPlan(runtimeInfo(props.status, id)));
  const runtimeOptions = (key: AgentWorkKind) => [
    ...(props.status.settings.kindRuntime[key] === undefined ? ([["", "Choose…"]] as const) : []),
    ...props.status.runtimes.map((r) => {
      const ready = r.info?.status === "ready";
      return [r.id, ready ? r.name : `${r.name} · ${statusWords(r.info).toLowerCase()}`] as const;
    }),
  ];
  return (
    <div class="flex flex-col gap-3">
      <p class="text-[12px] font-semibold text-secondary">
        What does what
        <Show when={props.suggested}>
          <span class="font-normal"> · suggested from what is ready</span>
        </Show>
      </p>
      <For each={WORK}>
        {(work) => {
          const models = () => runtimeOf(work.key)?.models ?? [];
          const modelOptions = () => [
            ...(work.key === "titles" ? ([["off", "Off"]] as const) : []),
            ...models().map((m) =>
              props.onRuntime === undefined
                ? ([m, `${modelName(m)} · ${nameOf(work.key)}`] as const)
                : ([m, modelName(m)] as const),
            ),
          ];
          const effort = () =>
            !anyEffort() ? undefined : efforts(work.key).length === 0 ? (
              // The model has no levels: no control, and the row keeps its columns.
              <span aria-hidden="true" />
            ) : (
              <EffortChoice
                id={`${props.idPrefix}-${work.key}-effort`}
                label={work.label}
                value={effortShown(
                  props.status.settings.efforts[work.key],
                  runtimeOf(work.key),
                  props.status.settings.models[work.key],
                )}
                options={efforts(work.key)}
                disabled={work.key === "titles" && props.status.settings.models.titles === "off"}
                onChange={(value) => props.onChange({}, { [work.key]: value })}
              />
            );
          return (
            <Show
              when={props.onRuntime}
              fallback={
                <Choice
                  id={`${props.idPrefix}-${work.key}`}
                  label={work.label}
                  value={props.status.settings.models[work.key]}
                  options={modelOptions()}
                  onChange={(value) => props.onChange({ [work.key]: value })}
                  aside={effort()}
                />
              }
            >
              {(onRuntime) => (
                <div class="flex flex-col gap-1.5" data-kind={work.key}>
                  <div class="min-w-0">
                    <span class="block text-[13px]">{work.label}</span>
                    <span class="block text-[12px] text-secondary">{work.hint}</span>
                  </div>
                  <div
                    class="grid items-center gap-2"
                    classList={{
                      "grid-cols-[minmax(0,1fr)_minmax(0,1fr)]": !anyEffort(),
                      "grid-cols-[minmax(0,1fr)_minmax(0,1fr)_112px]": anyEffort(),
                    }}
                  >
                    <RowSelect
                      id={`${props.idPrefix}-${work.key}-runtime`}
                      label={`${work.label}, assistant`}
                      data="runtime"
                      value={
                        props.pending?.(work.key) ??
                        props.status.settings.kindRuntime[work.key] ??
                        ""
                      }
                      options={runtimeOptions(work.key)}
                      onChange={(value) => {
                        if (value !== "") onRuntime()(work.key, value);
                      }}
                    />
                    <RowSelect
                      id={`${props.idPrefix}-${work.key}`}
                      label={`${work.label}, model`}
                      data="model"
                      value={props.status.settings.models[work.key]}
                      options={modelOptions()}
                      disabled={models().length === 0 || props.pending?.(work.key) !== undefined}
                      onChange={(value) => props.onChange({ [work.key]: value })}
                    />
                    {effort()}
                  </div>
                  <Show when={props.pending?.(work.key)}>
                    {(id) => (
                      <p class="text-[12px] text-secondary" data-kind-pending={work.key}>
                        Still on {nameOf(work.key)}. Agree below to move it to{" "}
                        {props.status.runtimes.find((r) => r.id === id())?.name ?? id()}.
                      </p>
                    )}
                  </Show>
                  <Show
                    when={
                      props.pending?.(work.key) === undefined && kindWaits(props.status, work.key)
                    }
                  >
                    {(waits) => (
                      <p class="text-[12px] text-late" data-kind-waits={work.key}>
                        {waits()}
                      </p>
                    )}
                  </Show>
                </div>
              )}
            </Show>
          );
        }}
      </For>
      <For each={WORK.filter((w) => unlisted().includes(w.key))}>
        {(work) => (
          <p role="alert" class="text-[12px] text-late" data-model-gone={work.key}>
            {props.status.settings.models[work.key]} is not available on {nameOf(work.key)} now.
            Choose another model for {work.label.toLowerCase()}.
          </p>
        )}
      </For>
      <Show when={anyEffort()}>
        <p class="text-[12px] text-secondary">
          {allNoPlan()
            ? "Higher effort takes longer. Default leaves it to the model."
            : "Higher effort uses more of your plan. Default leaves it to the model."}
        </p>
      </Show>
    </div>
  );
}

/**
 * The background limit, which both Settings and first run name: one share of the week, applied to
 * each plan by itself (ADR 0121, rule 6). Not shown while no runtime in use has a plan.
 */
export function Limits(props: {
  status: AgentStatus;
  idPrefix: string;
  onWeekShare: (percent: number) => void;
}) {
  // A runtime with no plan has no week to share (ADR 0119, rule 7).
  const anyPlan = () => {
    const inUse = runtimesInUse(props.status.settings);
    return inUse.length === 0 || inUse.some((id) => !hasNoPlan(runtimeInfo(props.status, id)));
  };
  return (
    <Show when={anyPlan()}>
      <Choice
        id={`${props.idPrefix}-share`}
        label="Background limit"
        hint="Of each plan that shows limits. It stops there, never on paid credits."
        value={String(props.status.settings.weekSharePercent)}
        options={WEEK_SHARES.map((n) => [String(n), `Up to ${n}% of my week`] as const)}
        onChange={(v) => props.onWeekShare(Number(v))}
      />
    </Show>
  );
}

/**
 * Shall I read your mail? The one place where mail is agreed to go to a runtime (ADR 0051, rule 6;
 * ADR 0121, rule 4): for one runtime, or for every runtime a kind of work is on, each named with
 * where its mail goes. Nothing is sent before `Turn on`.
 */
export function ConsentQuestion(props: {
  backend: Backend;
  status: AgentStatus;
  /** The accounts this answer is about. */
  accounts: readonly AccountInfo[];
  /** The runtimes it is about. Absent: every runtime a kind of work is on. */
  runtimeIds?: readonly string[];
  /** The kinds of work that go to the runtime, when they are not on it yet (a kind that moves). */
  kinds?: readonly AgentWorkKind[];
  /** First run offers another account here; Settings does not. */
  onAddAccount?: () => void;
  onStarted: (status: AgentStatus) => void;
  onDeclined: () => void;
  onStatus: (status: AgentStatus) => void;
  startLabel?: string;
  declineLabel?: string;
}) {
  const [changing, setChanging] = createSignal(false);
  const [starting, setStarting] = createSignal(false);
  const [problem, setProblem] = createSignal("");
  const ids = () => props.runtimeIds ?? runtimesInUse(props.status.settings);
  const runtimes = () =>
    ids().flatMap((id) => {
      const entry = props.status.runtimes.find((r) => r.id === id);
      return entry === undefined ? [] : [entry];
    });
  /** The kinds of work this consent is for on a runtime. */
  const kindsFor = (id: string) => props.kinds ?? kindsOn(props.status.settings, id);
  const reading = () => props.status.settings.kindRuntime.understand;
  const readingInfo = () => runtimeInfo(props.status, reading());
  const accountIds = () => props.accounts.map((a) => a.id);

  async function setUnderstand(model: string) {
    try {
      props.onStatus(await props.backend.agentSetModels({ understand: model }));
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not work.");
    }
  }

  async function start() {
    if (runtimes().length === 0 || starting()) return;
    setStarting(true);
    setProblem("");
    try {
      let next: AgentStatus | null = null;
      for (const runtime of runtimes()) {
        next = await props.backend.agentSetEnabled({
          accountIds: accountIds(),
          runtimeId: runtime.id,
        });
      }
      if (next !== null) props.onStarted(next);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "AI could not be turned on.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <div class="flex flex-col gap-5">
      <For each={runtimes()}>
        {(runtime) => (
          <div class="flex flex-col gap-2" data-consent-for={runtime.id}>
            <div class="flex items-baseline gap-2.5 text-[13px]">
              <span class="min-w-0 flex-1 truncate">
                <Show
                  when={kindsFor(runtime.id).includes("understand") && props.kinds === undefined}
                  fallback={
                    <>
                      {capitalize(kindsWords(kindsFor(runtime.id)))} by{" "}
                      <span class="font-semibold">{runtime.name}</span>
                    </>
                  }
                >
                  Read by{" "}
                  <span class="font-semibold">
                    {modelName(props.status.settings.models.understand)} · {runtime.name}
                  </span>
                </Show>
              </span>
              <Show when={runtime.id === reading() && props.kinds === undefined}>
                <button
                  type="button"
                  class="cursor-default text-[12.5px] text-mid underline-offset-2 hover:underline"
                  aria-expanded={changing()}
                  onClick={() => setChanging(!changing())}
                >
                  Change
                </button>
              </Show>
            </div>
            <Show when={changing() && runtime.id === reading()}>
              <Choice
                id="read-model"
                label="Model for reading"
                value={props.status.settings.models.understand}
                options={(readingInfo()?.models ?? []).map(
                  (m) => [m, `${modelName(m)} · ${runtime.name}`] as const,
                )}
                onChange={(v) => void setUnderstand(v)}
              />
            </Show>
            <p
              class="text-[12.5px] leading-[1.5] text-secondary"
              data-stays-here={runtime.info?.onThisMachine === true ? "" : undefined}
              data-consent-line
            >
              {consentText(runtime.info)}
            </p>
          </div>
        )}
      </For>
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
          disabled={starting() || runtimes().length === 0 || props.accounts.length === 0}
          onClick={() => void start()}
        >
          {starting() ? "Turning on…" : (props.startLabel ?? "Turn on")}
        </button>
        <button type="button" class={pill} onClick={() => props.onDeclined()}>
          {props.declineLabel ?? "Use without AI"}
        </button>
      </div>
    </div>
  );
}

const capitalize = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
