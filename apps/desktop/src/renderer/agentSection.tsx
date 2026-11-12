import type { AccountInfo } from "@matters/contracts";
import type { AgentStatus, AgentWorkKind, LedgerEntry } from "@matters/core";
import { AGENT_WORK_KINDS, choicesOn, kindInfo, runtimeInfo, runtimesInUse } from "@matters/core";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { AccountsStore } from "./accounts.ts";
import { createInstructions, createJournal, createRules } from "./agent.ts";
import {
  Choice,
  ConsentQuestion,
  Limits,
  NotYet,
  RuntimeList,
  WhatDoesWhat,
} from "./agentConnect.tsx";
import {
  hasNoPlan,
  instructionScopeWords,
  ledgerEffort,
  loopOffered,
  ourShare,
  ruleText,
  wholeFilesText,
} from "./agentText.ts";
import type { Backend } from "./client.ts";
import { letterDate } from "./format.ts";
import { createStatusOrder } from "./statusOrder.ts";
import { field, pill, pillPrimary } from "./ui.ts";

const row = "border-b border-hairline px-5 py-3";
const heading = "mb-2 font-semibold";

/**
 * Whether Settings offers the search in a loop (ADR 0083): a question runs it on the model its
 * runtime keeps for writing, and a prompt's search on the one the runtime for understanding mail
 * keeps (ADR 0121, rule 1). Offered when either can use our tools.
 */
function loopOfferedFor(status: AgentStatus): boolean {
  return (["answer", "understand"] as const).some((kind) => {
    const id = status.settings.kindRuntime[kind];
    return loopOffered(kindInfo(status, kind), choicesOn(status.settings, id).models.write);
  });
}

/** What a line of the ledger says, in words. */
export function ledgerWords(entry: LedgerEntry): string {
  switch (entry.purpose) {
    case "analysis":
      // A line of an earlier version, which read every thread of a window (ADR 0117).
      return "Read mail, in an earlier version";
    case "prepare":
      return "Prepared a draft";
    case "remember":
      return "Your words, to decide what to remember";
    case "talk":
      return "Talked about a thread";
    case "prompt":
      return "Read for your prompt";
    case "consent":
      return "You agreed";
    case "revoke":
      return "You took it back";
  }
}

/** How many threads a line names; the choices of the person (`revoke`) name none. */
export function ledgerThreads(entry: LedgerEntry): string {
  // The choices of the person and the turn on typed words name no thread: no mail went with them.
  // A consent of an earlier version named the threads its screen counted.
  if (entry.purpose === "revoke" || entry.purpose === "remember") return "";
  if (entry.purpose === "consent" && entry.threads === 0) return "";
  return entry.threads === 1 ? "1 thread" : `${entry.threads} threads`;
}

/**
 * Agents, a section of the settings window (ADR 0051, 0052): the programs found on this Mac, which
 * model does which work, the limits of background work, consent for each account, and what was
 * sent. The window never starts a sign-in and never asks for a credential.
 */
export function AgentSection(props: { backend: Backend; accounts: AccountsStore }) {
  const [status, setStatus] = createSignal<AgentStatus | null>(null);
  const order = createStatusOrder();
  // What the agent did (ADR 0054, rule 6): read when the section is shown, and again on a push.
  const journal = createJournal(props.backend);
  // The rules the person keeps (ADR 0054, rule 7), read the same way.
  const rules = createRules(props.backend);
  // The rule for a type has its own switch below the list, so it is not listed a second time.
  const listed = () => rules.rules().filter((r) => r.scope !== "type");
  const [typed, setTyped] = createSignal("");
  async function addTyped() {
    const value = typed().trim();
    if (value === "") return;
    if (await rules.add(value)) setTyped("");
    void journal.load();
  }
  // The instructions the person keeps for the model (ADR 0054, rule 7), read the same way.
  const instructions = createInstructions(props.backend);
  const [instructionScope, setInstructionScope] = createSignal<"general" | "understand" | "write">(
    "general",
  );
  const [instructionText, setInstructionText] = createSignal("");
  async function addInstruction() {
    const text = instructionText().trim();
    if (text === "") return;
    if (await instructions.add({ scope: instructionScope(), text })) setInstructionText("");
    void journal.load();
  }
  const [looking, setLooking] = createSignal(true);
  // The runtime being checked, and the one whose check failed with its sentence.
  const [checking, setChecking] = createSignal<string | null>(null);
  const [checkFailed, setCheckFailed] = createSignal<{
    readonly runtimeId: string;
    readonly problem: string;
  } | null>(null);
  const [failure, setFailure] = createSignal("");
  const [problem, setProblem] = createSignal("");
  // The account and runtime whose consent is being asked for, and whether the turn-on flow is open.
  const [consenting, setConsenting] = createSignal<{
    readonly accountId: string;
    readonly runtimeId: string;
  } | null>(null);
  const [turningOn, setTurningOn] = createSignal(false);
  const [picked, setPicked] = createSignal<ReadonlySet<string> | null>(null);
  // A kind of work moving to a runtime that some of its accounts have not agreed to (rule 4).
  // Several kinds can wait for the same question: one runtime is asked about at a time.
  const [moving, setMoving] = createSignal<{
    readonly kinds: readonly AgentWorkKind[];
    readonly runtimeId: string;
    readonly accounts: readonly AccountInfo[];
  } | null>(null);

  // A runtime in use that no account lets read its mail: the person is asked here, in one place.
  const [allowing, setAllowing] = createSignal<string | null>(null);

  async function look() {
    setLooking(true);
    setFailure("");
    try {
      await order.settle(props.backend.agentInspect(), setStatus);
    } catch {
      setFailure("The assistant could not be looked at. Try again.");
    } finally {
      setLooking(false);
    }
  }

  // The person opened this section: that is asking for the status (ADR 0051, refinement 4).
  onMount(() => {
    void look();
    void journal.load();
    void rules.load();
    void instructions.load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = props.backend.onEvent((event) => {
      if (event.type !== "agentChanged" || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void order.settle(props.backend.agentStatus(), setStatus).catch(() => {});
        void journal.load();
        void rules.load();
        void instructions.load();
      }, 500);
    });
    onCleanup(() => {
      off();
      clearTimeout(timer);
    });
  });

  async function change(work: Promise<AgentStatus>) {
    setProblem("");
    try {
      await order.settle(work, setStatus);
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That did not work.");
    }
  }

  /** The test of one runtime with a made-up message; any runtime, in use or not (rule 2). */
  async function check(runtimeId: string) {
    setChecking(runtimeId);
    setCheckFailed(null);
    try {
      const next = await order.settle(props.backend.agentTestRuntime(runtimeId), setStatus);
      const info = runtimeInfo(next, runtimeId);
      if (info?.status === "failed") {
        setCheckFailed({ runtimeId, problem: info.problem ?? "The check did not pass." });
      }
    } catch {
      setCheckFailed({ runtimeId, problem: "The check did not finish. Nothing was sent." });
    } finally {
      setChecking(null);
    }
  }

  const enabled = () => status()?.settings.enabled === true;
  const inUse = () => runtimesInUse(status()?.settings ?? { kindRuntime: {} });
  const nameOf = (runtimeId: string | undefined) =>
    status()?.runtimes.find((r) => r.id === runtimeId)?.name ?? runtimeId ?? "";
  const agreed = (accountId: string, runtimeId: string) =>
    status()?.consents.some((c) => c.accountId === accountId && c.runtimeId === runtimeId) === true;
  const addressOf = (id: string) => props.accounts.accounts().find((a) => a.id === id)?.address;
  const selection = createMemo<readonly AccountInfo[]>(() => {
    const chosen = picked();
    const all = props.accounts.accounts();
    return chosen === null ? all : all.filter((a) => chosen.has(a.id));
  });
  function toggle(id: string) {
    const current = picked() ?? new Set(props.accounts.accounts().map((a) => a.id));
    const next = new Set(current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setPicked(next);
  }

  /**
   * The person moves a kind of work to another runtime (ADR 0121, rule 1). The accounts its mail
   * comes from that have not agreed to that runtime are asked first (rule 4); while no kind is on
   * any runtime, every kind goes there (rule 12).
   */
  function moveKind(kind: AgentWorkKind, runtimeId: string) {
    const s = status();
    if (s === null) return;
    const waiting = moving();
    // Back to where it is: the kind no longer waits for a question.
    if (s.settings.kindRuntime[kind] === runtimeId) {
      if (waiting !== null) {
        const rest = waiting.kinds.filter((k) => k !== kind);
        setMoving(rest.length === 0 ? null : { ...waiting, kinds: rest });
      }
      return;
    }
    const none = runtimesInUse(s.settings).length === 0;
    const kinds = none ? AGENT_WORK_KINDS : [kind];
    // The accounts the agent works with at all: those that agreed to some runtime. Asking only
    // those of the runtime the kind is on now would move it in silence when that one has none,
    // and the kind would then wait with nobody asked.
    const works = (id: string) => s.consents.some((c) => c.accountId === id);
    const asked = s.settings.enabled
      ? props.accounts.accounts().filter((a) => works(a.id) && !agreed(a.id, runtimeId))
      : [];
    if (asked.length > 0) {
      // The same runtime again: one question moves every kind that waits for it.
      const before = waiting !== null && waiting.runtimeId === runtimeId ? waiting.kinds : [];
      setMoving({ kinds: [...before.filter((k) => k !== kind), kind], runtimeId, accounts: asked });
      return;
    }
    if (waiting !== null) {
      const rest = waiting.kinds.filter((k) => k !== kind);
      setMoving(rest.length === 0 ? null : { ...waiting, kinds: rest });
    }
    void change(props.backend.agentSetKindRuntime(kinds, runtimeId));
  }

  /** Whether a runtime can be agreed to now: it is ready, or checked once agreed. */
  const canAgree = (runtimeId: string) => {
    const state = status()?.runtimes.find((r) => r.id === runtimeId)?.info?.status;
    return state === "ready" || state === "found";
  };

  return (
    <section aria-label="Agents" class="flex h-full flex-col">
      <div class="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-5">
        <h2 class="flex-1 font-serif text-[17px] font-semibold">Agents</h2>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class={row}>
          <h3 class={heading}>Who works on your mail</h3>
          <Show
            when={status()}
            fallback={
              <p role="status" class="text-[13px] text-secondary">
                {looking() ? "Looking…" : failure() || "No assistant found on this Mac."}
              </p>
            }
          >
            {(s) => (
              <RuntimeList
                status={s()}
                checking={checking()}
                {...(checkFailed() === null ? {} : { checkFailed: checkFailed() ?? undefined })}
                onCheck={(id) => void check(id)}
                onLookAgain={() => void look()}
              />
            )}
          </Show>
          <div class="mt-3 flex items-center gap-2">
            <button type="button" class={pill} disabled={looking()} onClick={() => void look()}>
              Look again
            </button>
          </div>
        </div>
        <div class={row}>
          <NotYet />
        </div>

        <Show when={status()}>
          {(s) => (
            <>
              <Show when={s().runtimes.some((r) => (r.info?.models.length ?? 0) > 0)}>
                <div class={row}>
                  <WhatDoesWhat
                    status={s()}
                    idPrefix="settings"
                    onChange={(models, efforts) =>
                      void change(props.backend.agentSetModels(models, efforts))
                    }
                    onRuntime={moveKind}
                    pending={(kind) => {
                      const m = moving();
                      return m?.kinds.includes(kind) ? m.runtimeId : undefined;
                    }}
                  />
                  <Show when={enabled() && moving() === null}>
                    <For
                      each={inUse().filter(
                        (id) => canAgree(id) && !s().consents.some((c) => c.runtimeId === id),
                      )}
                    >
                      {(id) => (
                        <div
                          class="mt-3 rounded-[10px] border border-hairline p-3.5"
                          data-allow-runtime={id}
                        >
                          <Show
                            when={allowing() === id}
                            fallback={
                              <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                                <p class="min-w-0 flex-1 text-[13px]">
                                  {nameOf(id)} is chosen above, but you have not let it read any
                                  account yet. Until you do, that work waits.
                                </p>
                                <button type="button" class={pill} onClick={() => setAllowing(id)}>
                                  Let {nameOf(id)} read mail…
                                </button>
                              </div>
                            }
                          >
                            <ConsentQuestion
                              backend={props.backend}
                              status={s()}
                              accounts={props.accounts.accounts()}
                              runtimeIds={[id]}
                              startLabel={`Let ${nameOf(id)} read mail`}
                              declineLabel="Not now"
                              onStatus={setStatus}
                              onStarted={(next) => {
                                setStatus(next);
                                setAllowing(null);
                              }}
                              onDeclined={() => setAllowing(null)}
                            />
                          </Show>
                        </div>
                      )}
                    </For>
                  </Show>
                  <Show when={moving()}>
                    {(m) => (
                      <div
                        class="mt-3 rounded-[10px] border border-hairline p-3.5"
                        data-move-consent={m().runtimeId}
                      >
                        <ConsentQuestion
                          backend={props.backend}
                          status={s()}
                          accounts={m().accounts}
                          runtimeIds={[m().runtimeId]}
                          kinds={m().kinds}
                          startLabel={`Agree and move to ${nameOf(m().runtimeId)}`}
                          declineLabel="Keep as it is"
                          onStatus={setStatus}
                          onStarted={(next) => {
                            const { kinds, runtimeId } = m();
                            setStatus(next);
                            setMoving(null);
                            void change(props.backend.agentSetKindRuntime(kinds, runtimeId));
                          }}
                          onDeclined={() => setMoving(null)}
                        />
                      </div>
                    )}
                  </Show>
                </div>
              </Show>
              <div class={row}>
                <Limits
                  status={s()}
                  idPrefix="settings"
                  onWeekShare={(percent) => void change(props.backend.agentSetWeekShare(percent))}
                />
                <Show when={enabled()}>
                  <For each={inUse().filter((id) => !hasNoPlan(runtimeInfo(s(), id)))}>
                    {(id) => (
                      <p class="mt-3 text-[12px] text-secondary" data-our-share={id}>
                        {ourShare(s(), id)}
                      </p>
                    )}
                  </For>
                </Show>
                <Show when={enabled()}>
                  <label
                    class="mt-3 flex cursor-default items-start gap-2.5 text-[13px]"
                    data-pause-reading
                  >
                    <input
                      type="checkbox"
                      class="mt-0.5"
                      checked={s().settings.readingPaused === true}
                      onChange={(e) =>
                        void change(
                          e.currentTarget.checked
                            ? props.backend.agentPauseReading()
                            : props.backend.agentResumeReading(),
                        )
                      }
                    />
                    <span>
                      Pause reading
                      <span class="block text-[12px] text-secondary">
                        Views with a prompt do not read new mail in the background until you turn
                        this off. What you ask for still runs.
                      </span>
                    </span>
                  </label>
                </Show>
                <Show when={enabled() && loopOfferedFor(s())}>
                  <label
                    class="mt-3 flex cursor-default items-start gap-2.5 text-[13px]"
                    data-talk-loop
                  >
                    <input
                      type="checkbox"
                      class="mt-0.5"
                      checked={s().settings.talkLoop === true}
                      onChange={(e) =>
                        void change(props.backend.agentSetTalkLoop(e.currentTarget.checked))
                      }
                    />
                    <span>
                      Search in a loop (experimental)
                      <span class="block text-[12px] text-secondary">
                        The agent searches, reads and searches again, and shows each step. It reads
                        whole threads, and the files attached to them too (PDF, Word and text files,
                        up to five a question): their text goes to the assistant.{" "}
                        {wholeFilesText(kindInfo(s(), "answer"))} It takes longer and uses more of
                        your plan.
                      </span>
                    </span>
                  </label>
                </Show>
              </div>

              <Show
                when={enabled()}
                fallback={
                  <div class={row} data-ai-off>
                    <h3 class={heading}>AI is off</h3>
                    <p class="mb-3 text-[12.5px] leading-[1.5] text-secondary">
                      Nothing leaves this Mac until you turn it on. Turning it on names which
                      accounts go to which assistant.
                    </p>
                    <Show
                      when={turningOn()}
                      fallback={
                        <button
                          type="button"
                          class={pillPrimary}
                          disabled={!inUse().some((id) => runtimeInfo(s(), id)?.status === "ready")}
                          title={
                            inUse().some((id) => runtimeInfo(s(), id)?.status === "ready")
                              ? undefined
                              : "Check the assistant above first"
                          }
                          onClick={() => setTurningOn(true)}
                        >
                          Turn AI on
                        </button>
                      }
                    >
                      <h3 class="mt-1 mb-2 font-serif text-[17px] font-semibold">
                        Shall I read your mail?
                      </h3>
                      <fieldset class="m-0 mb-4 flex flex-col gap-1.5 border-0 p-0">
                        <legend class="mb-1 text-[12px] text-secondary">Accounts</legend>
                        <For each={props.accounts.accounts()}>
                          {(a) => (
                            <label class="flex cursor-default items-center gap-2.5 text-[13px]">
                              <input
                                type="checkbox"
                                checked={selection().some((x) => x.id === a.id)}
                                onChange={() => toggle(a.id)}
                              />
                              {a.address}
                            </label>
                          )}
                        </For>
                      </fieldset>
                      <ConsentQuestion
                        backend={props.backend}
                        status={s()}
                        accounts={selection()}
                        runtimeIds={inUse().filter((id) => canAgree(id))}
                        declineLabel="Leave AI off"
                        onStatus={setStatus}
                        onStarted={(next) => {
                          setStatus(next);
                          setTurningOn(false);
                        }}
                        onDeclined={() => setTurningOn(false)}
                      />
                    </Show>
                  </div>
                }
              >
                <div class={row} data-consents>
                  <h3 class={heading}>Which account goes where</h3>
                  <ul class="m-0 flex list-none flex-col gap-2 p-0">
                    <For each={props.accounts.accounts()}>
                      {(a) => (
                        <li class="flex flex-col gap-3" data-consent-account={a.id}>
                          <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[13px]">
                            <span class="min-w-0 flex-1 truncate">{a.address}</span>
                            <For each={inUse()}>
                              {(id) => (
                                <label
                                  class="flex cursor-default items-center gap-1.5 text-[12.5px]"
                                  data-consent-runtime={id}
                                >
                                  <input
                                    type="checkbox"
                                    checked={
                                      agreed(a.id, id) ||
                                      (consenting()?.accountId === a.id &&
                                        consenting()?.runtimeId === id)
                                    }
                                    disabled={!canAgree(id) && !agreed(a.id, id)}
                                    onChange={(e) => {
                                      if (e.currentTarget.checked) {
                                        setConsenting({ accountId: a.id, runtimeId: id });
                                      } else {
                                        setConsenting(null);
                                        void change(props.backend.agentRevokeConsent(a.id, id));
                                      }
                                    }}
                                  />
                                  {nameOf(id)}
                                </label>
                              )}
                            </For>
                          </div>
                          <Show
                            when={
                              consenting()?.accountId === a.id &&
                              !agreed(a.id, consenting()?.runtimeId ?? "")
                                ? consenting()
                                : null
                            }
                          >
                            {(c) => (
                              <div class="rounded-[10px] border border-hairline p-3.5">
                                <ConsentQuestion
                                  backend={props.backend}
                                  status={s()}
                                  accounts={[a]}
                                  runtimeIds={[c().runtimeId]}
                                  declineLabel="Not this account"
                                  onStatus={setStatus}
                                  onStarted={(next) => {
                                    setStatus(next);
                                    setConsenting(null);
                                  }}
                                  onDeclined={() => setConsenting(null)}
                                />
                              </div>
                            )}
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                  <p class="mt-2 text-[12px] text-secondary">
                    An assistant reads only the accounts agreed to it. Its work leaves the others
                    out.
                  </p>
                  <div class="mt-4 flex items-center gap-3">
                    <button
                      type="button"
                      class={pill}
                      onClick={() => void change(props.backend.agentDisable())}
                    >
                      Turn AI off
                    </button>
                    <p class="text-[12px] text-secondary">
                      Takes every consent back and stops reading.
                    </p>
                  </div>
                </div>
              </Show>

              <Show when={problem() !== ""}>
                <p role="alert" class="px-5 pt-3 text-[13px] text-late">
                  {problem()}
                </p>
              </Show>

              <div class={row} data-instructions>
                <h3 class={heading}>Instructions</h3>
                <Show
                  when={instructions.instructions().length > 0}
                  fallback={<p class="text-[12.5px] text-secondary">No instructions yet.</p>}
                >
                  <ul class="m-0 flex list-none flex-col gap-1.5 p-0 text-[12.5px]">
                    <For each={instructions.instructions()}>
                      {(instruction) => (
                        <li
                          data-instruction-entry
                          class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
                        >
                          {/* Written by the person, or by the agent from their words: text only, cut to one line. */}
                          <span class="block min-w-0 truncate" title={instruction.text}>
                            <span class="text-secondary">
                              {instruction.scope === "thread"
                                ? "For one thread"
                                : instructionScopeWords(instruction.scope)}
                              {" · "}
                            </span>
                            {instruction.text}
                          </span>
                          <button
                            type="button"
                            class={pill}
                            onClick={() => {
                              void instructions.remove(instruction).then(() => journal.load());
                            }}
                          >
                            Remove
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <div class="mt-2">
                  <Choice
                    id="agent-instruction-scope"
                    label="Applies"
                    value={instructionScope()}
                    options={[
                      ["general", "In general"],
                      ["understand", "When reading"],
                      ["write", "When writing"],
                    ]}
                    onChange={(value) =>
                      setInstructionScope(
                        value === "write" || value === "understand" ? value : "general",
                      )
                    }
                  />
                </div>
                <div class="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    class={field}
                    data-instruction-input
                    placeholder="For example: I write briefly, no formulas"
                    aria-label="Instruction"
                    value={instructionText()}
                    onInput={(e) => setInstructionText(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addInstruction();
                    }}
                  />
                  <button
                    type="button"
                    class={pill}
                    data-instruction-add
                    onClick={() => void addInstruction()}
                  >
                    Add
                  </button>
                </div>
                <Show when={instructions.problem() !== ""}>
                  <p role="alert" class="mt-2 text-[12.5px] text-late">
                    {instructions.problem()}
                  </p>
                </Show>
                <p class="mt-2 text-[12px] text-secondary">
                  These go to the assistant with what it reads and writes. Your rules below do not.
                </p>
              </div>

              <div class={row} data-rules>
                <h3 class={heading}>Rules</h3>
                <Show
                  when={listed().length > 0}
                  fallback={<p class="text-[12.5px] text-secondary">No rules yet.</p>}
                >
                  <ul class="m-0 flex list-none flex-col gap-1.5 p-0 text-[12.5px]">
                    <For each={listed()}>
                      {(rule) => (
                        <li
                          data-rule-entry
                          class="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3"
                        >
                          {/* An address the person typed or a sender: text only, cut to one line. */}
                          <span class="block min-w-0 truncate" title={ruleText(rule)}>
                            {ruleText(rule)}
                          </span>
                          <button
                            type="button"
                            class={pill}
                            onClick={() => {
                              void rules.remove(rule).then(() => journal.load());
                            }}
                          >
                            Remove
                          </button>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <div class="mt-2 flex items-center gap-2">
                  <input
                    type="text"
                    class={field}
                    data-rule-input
                    placeholder="Address or domain"
                    aria-label="Address or domain"
                    value={typed()}
                    onInput={(e) => setTyped(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void addTyped();
                    }}
                  />
                  <button type="button" class={pill} data-rule-add onClick={() => void addTyped()}>
                    Add
                  </button>
                </div>
                <div class="mt-2 flex items-center gap-3 text-[12.5px]">
                  <span class="min-w-0 flex-1 truncate">Addresses that look like programs</span>
                  <button
                    type="button"
                    class={pill}
                    data-rule-program
                    onClick={() => {
                      void rules.toggleProgramLike().then(() => journal.load());
                    }}
                  >
                    {rules.programLike() ? "Remove" : "Add"}
                  </button>
                </div>
                <Show when={rules.problem() !== ""}>
                  <p role="alert" class="mt-2 text-[12.5px] text-late">
                    {rules.problem()}
                  </p>
                </Show>
                <p class="mt-2 text-[12px] text-secondary">
                  A thread stays if anyone else writes in it. These rules run on this computer and
                  spend nothing.
                </p>
              </div>

              <div class={row} data-journal>
                <h3 class={heading}>What the agent did</h3>
                <Show
                  when={journal.lines().length > 0}
                  fallback={<p class="text-[12.5px] text-secondary">Nothing yet.</p>}
                >
                  <ul class="m-0 flex list-none flex-col gap-1.5 p-0 text-[12.5px]">
                    <For each={journal.lines()}>
                      {(line) => (
                        <li
                          data-journal-entry
                          class="grid grid-cols-[110px_minmax(0,1fr)_auto] items-baseline gap-3"
                        >
                          <span class="text-secondary tabular-nums">
                            {letterDate(line.entry.atMs)}
                          </span>
                          {/* Mail, the person's words and a model's reason: text only, cut to one line. */}
                          <span class="min-w-0">
                            <span
                              class="block truncate"
                              title={
                                line.headline === ""
                                  ? line.title
                                  : `${line.title} · ${line.headline}`
                              }
                            >
                              {line.title}
                              <Show when={line.headline !== ""}>
                                <span class="text-secondary">
                                  {" · "}
                                  {line.headline}
                                </span>
                              </Show>
                            </span>
                            <Show when={line.detail !== ""}>
                              <span class="block truncate text-secondary" title={line.detail}>
                                {line.detail}
                              </span>
                            </Show>
                          </span>
                          <Show
                            when={line.undoable}
                            fallback={
                              <span class="text-secondary">{line.undone ? "Undone" : ""}</span>
                            }
                          >
                            <button
                              type="button"
                              class={pill}
                              onClick={() => void journal.undo(line.entry)}
                            >
                              Undo
                            </button>
                          </Show>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <p class="mt-2 text-[12px] text-secondary">
                  Kept on this computer. It is never sent to an assistant.
                </p>
              </div>

              <div class={row} data-ledger>
                <h3 class={heading}>What was sent</h3>
                <Show
                  when={s().ledger.length > 0}
                  fallback={<p class="text-[12.5px] text-secondary">Nothing has been sent.</p>}
                >
                  <ul class="m-0 flex list-none flex-col gap-1 p-0 text-[12.5px]">
                    <For each={s().ledger.slice(0, 8)}>
                      {(entry) => (
                        <li class="grid grid-cols-[110px_minmax(0,1fr)_auto] items-baseline gap-3">
                          <span class="text-secondary tabular-nums">{letterDate(entry.atMs)}</span>
                          <span class="min-w-0 truncate">
                            {ledgerWords(entry)}
                            <span class="text-secondary">
                              {" · "}
                              {addressOf(entry.accountId) ?? "an account that was removed"}
                              {" · "}
                              {nameOf(entry.runtimeId)}
                            </span>
                          </span>
                          <span class="text-secondary tabular-nums">
                            {[ledgerThreads(entry), ledgerEffort(entry)]
                              .filter((part) => part !== "")
                              .join(" · ")}
                          </span>
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <p class="mt-2 text-[12px] text-secondary">
                  The list holds dates and counts. It never holds the text of any mail.
                </p>
              </div>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}
