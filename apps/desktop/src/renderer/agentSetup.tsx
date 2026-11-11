import type { AccountInfo } from "@matters/contracts";
import type { AgentStatus } from "@matters/core";
import { createSignal, onMount, Show } from "solid-js";
import { ConsentQuestion, NotYet, RuntimeCard, WhatDoesWhat } from "./agentConnect.tsx";
import type { Backend } from "./client.ts";
import { pill, pillPrimary } from "./ui.ts";

// The two questions after "You're in." (ADR 0052, rule 3): who works on the mail, and whether to
// read the last days of it. Both can be answered `Use without AI`, which is remembered.

const body = "text-[14px] leading-[1.5] text-mid";

/** Step one: which program works on the mail, and which model does which work. No mail is used. */
export function RuntimeStep(props: {
  backend: Backend;
  headline: string;
  onContinue: (status: AgentStatus) => void;
  onDeclined: () => void;
  onStatus: (status: AgentStatus) => void;
  /** The big ring breathes while the program is being checked. */
  onBusy?: (busy: boolean) => void;
}) {
  const [status, setStatus] = createSignal<AgentStatus | null>(null);
  const [looking, setLooking] = createSignal(true);
  const [checking, setChecking] = createSignal(false);
  const [failure, setFailure] = createSignal("");

  function take(next: AgentStatus) {
    setStatus(next);
    props.onStatus(next);
  }

  async function look() {
    setLooking(true);
    setFailure("");
    try {
      take(await props.backend.agentInspect());
    } catch {
      setFailure("The assistant could not be looked at. Try again.");
    } finally {
      setLooking(false);
    }
  }
  onMount(() => void look());

  async function check(): Promise<AgentStatus | null> {
    setChecking(true);
    props.onBusy?.(true);
    setFailure("");
    try {
      const next = await props.backend.agentTestRuntime();
      take(next);
      return next;
    } catch {
      setFailure("The check did not finish. Nothing was sent.");
      return null;
    } finally {
      setChecking(false);
      props.onBusy?.(false);
    }
  }

  async function next() {
    const current = status();
    if (current?.runtime == null || checking()) return;
    // A runtime that passed the test with this plan is not asked to prove it again.
    const result = current.runtime.status === "ready" ? current : await check();
    if (result?.runtime?.status === "ready") props.onContinue(result);
    else if (result !== null && failure() === "") {
      setFailure(result.runtime?.problem ?? "The check did not pass.");
    }
  }

  async function setModels(
    models: Parameters<Backend["agentSetModels"]>[0],
    efforts?: Parameters<Backend["agentSetModels"]>[1],
  ) {
    try {
      take(await props.backend.agentSetModels(models, efforts));
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "That did not work.");
    }
  }

  const usable = () => {
    const s = status()?.runtime?.status;
    return s === "ready" || s === "found" || s === "failed";
  };

  return (
    <div class="settle flex flex-col gap-5" data-step="runtime">
      <div class="flex flex-col gap-2.5">
        <h1 class={props.headline}>Who should work on your mail?</h1>
        <p class={body}>
          Use what you already pay for. This is what I found on this Mac. Nothing has been sent
          anywhere yet.
        </p>
      </div>
      <Show
        when={status()?.runtime}
        fallback={
          <p role="status" class="text-[13px] text-secondary">
            {looking() ? "Looking…" : "No assistant found on this Mac."}
          </p>
        }
      >
        {(runtime) => (
          <div class="flex flex-col gap-1.5 rounded-[10px] border border-hairline p-3.5">
            <p class="text-[12px] font-semibold text-secondary">Found on this Mac</p>
            <RuntimeCard
              runtime={runtime()}
              checking={checking()}
              {...(failure() !== "" ? { checkFailed: failure() } : {})}
              onCheck={() => void check()}
              onLookAgain={() => void look()}
            />
          </div>
        )}
      </Show>
      <Show when={usable() && status()}>
        {(s) => <WhatDoesWhat status={s()} idPrefix="setup" suggested onChange={setModels} />}
      </Show>
      <NotYet />
      <Show when={failure() !== "" && !status()?.runtime}>
        <p role="alert" class="text-[13px] text-late">
          {failure()}
        </p>
      </Show>
      <div class="flex items-center gap-3">
        <button
          type="button"
          class={pillPrimary}
          data-continue-agent
          disabled={!usable() || checking()}
          onClick={() => void next()}
        >
          {checking() ? "Checking…" : "Continue"}
        </button>
        <Show when={status()?.runtime && !usable()}>
          <button type="button" class={pill} disabled={looking()} onClick={() => void look()}>
            Look again
          </button>
        </Show>
        <button type="button" class={pill} onClick={() => props.onDeclined()}>
          Use without AI
        </button>
      </div>
    </div>
  );
}

/** Step two: shall I read your mail? Nothing is sent before `Turn on`. */
export function ReadStep(props: {
  backend: Backend;
  headline: string;
  status: AgentStatus;
  accounts: readonly AccountInfo[];
  onAddAccount: () => void;
  onStarted: (status: AgentStatus) => void;
  onDeclined: () => void;
  onStatus: (status: AgentStatus) => void;
}) {
  return (
    <div class="settle flex flex-col gap-5" data-step="read">
      <h1 class={props.headline}>Shall I read your mail?</h1>
      <ConsentQuestion
        backend={props.backend}
        status={props.status}
        accounts={props.accounts}
        onAddAccount={props.onAddAccount}
        onStarted={props.onStarted}
        onDeclined={props.onDeclined}
        onStatus={props.onStatus}
      />
    </div>
  );
}
