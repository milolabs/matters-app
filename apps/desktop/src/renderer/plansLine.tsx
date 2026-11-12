import type { AgentModels } from "@matters/core";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { AgentStore } from "./agent.ts";
import {
  hasNoWindows,
  modelName,
  noWindowsText,
  ourShare,
  planButton,
  seenText,
  windowLine,
} from "./agentText.ts";
import type { Backend } from "./client.ts";
import { ChevronDownIcon } from "./icons.tsx";

/**
 * The status of the plans, the foot row of the prompt in the agent's column (ADR 0052, rule 11;
 * ADR 0069): the model, a quiet hint of the keys, the plan button, and at its end what the caller
 * puts there (the send button). It has no input of its own and no other control but the model and
 * plan buttons. Its menus open upward from the dock, which is the positioned ancestor. The list's footer does not show plans.
 */
export function PlansLine(props: {
  agent: AgentStore;
  backend: Backend;
  /** What the prompt looks at: in All mail the chip is the model for questions about the mail. */
  scope: () => "thread" | "all";
  onOpenSettings: () => void;
  /** Whether the hint of the keys shows; it is the first thing to go when the column is narrow. */
  hint?: boolean;
  /** Stands at the end of the row: the send button, when the prompt can be sent. */
  children?: JSX.Element;
}) {
  const { agent } = props;
  let root!: HTMLDivElement;
  const [open, setOpen] = createSignal<"models" | "plan" | null>(null);
  const [problem, setProblem] = createSignal("");

  onMount(() => {
    // A press outside closes whatever is open; the press itself still does its work.
    const outside = (e: MouseEvent) => {
      if (open() !== null && !root.contains(e.target as Node)) setOpen(null);
    };
    document.addEventListener("mousedown", outside, true);
    root.addEventListener("keydown", onKeyDown);
    onCleanup(() => {
      document.removeEventListener("mousedown", outside, true);
      root.removeEventListener("keydown", onKeyDown);
    });
  });

  const status = () => agent.status();
  const button = () => {
    const s = status();
    return s === null ? null : planButton(s, Date.now());
  };

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || open() === null) return;
    // The popover's key is the popover's: the window's Escape must not also fire.
    e.preventDefault();
    e.stopPropagation();
    setOpen(null);
  }

  const all = () => props.scope() === "all";
  const modelTitle = () => (all() ? "Model for questions about your mail" : "Model for writing");
  /** The model the chip names, and the one the menu marks. */
  const current = (models: AgentModels) => (all() ? models.answer : models.write);

  async function choose(model: string) {
    setOpen(null);
    setProblem("");
    try {
      await agent.change(
        props.backend.agentSetModels(all() ? { answer: model } : { write: model }),
      );
    } catch (e) {
      setProblem(e instanceof Error ? e.message : "That model could not be chosen.");
    }
  }

  return (
    <div
      ref={root}
      data-plans
      class="@container flex min-h-[40px] shrink-0 items-center gap-2 px-2.5 pb-2 text-[11.5px] text-secondary"
    >
      <Show when={status()}>
        {(s) => (
          <>
            <button
              type="button"
              aria-haspopup="menu"
              aria-expanded={open() === "models"}
              aria-label={`${modelTitle()}: ${modelName(current(s().settings.models))}`}
              title={modelTitle()}
              class="inline-flex h-[22px] shrink-0 cursor-default items-center gap-1 rounded-[6px] bg-fill px-2 text-mid hover:bg-button hover:text-ink"
              onClick={() => setOpen(open() === "models" ? null : "models")}
            >
              {modelName(current(s().settings.models))}
              <ChevronDownIcon />
            </button>
            <Show when={problem() !== ""}>
              <span role="alert" class="min-w-0 truncate text-late">
                {problem()}
              </span>
            </Show>
            {/* The spring holds the hint, shown whole or not at all: a cut hint says nothing. */}
            <span class="min-w-0 flex-1 truncate">
              <Show when={props.hint !== false}>
                <span class="hidden @min-[400px]:inline">↵ · ⇧↵ new line</span>
              </Show>
            </span>
            <Show when={button()}>
              {(b) => (
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={open() === "plan"}
                  class="inline-flex h-[22px] min-w-0 shrink cursor-default items-center rounded-[6px] px-1.5 hover:bg-fill"
                  classList={{ "text-late": b().late, "text-secondary": !b().late }}
                  onClick={() => setOpen(open() === "plan" ? null : "plan")}
                >
                  <span class="truncate">{b().text}</span>
                </button>
              )}
            </Show>
            {props.children}
            <Show when={open() === "models"}>
              <div
                role="menu"
                aria-label={modelTitle()}
                class="absolute bottom-full left-2.5 z-30 mb-1 max-w-[calc(100%-1.25rem)] min-w-[170px] rounded-[9px] border border-hairline bg-bg p-1 text-[12.5px] text-ink shadow-[var(--pop)]"
              >
                <p class="px-2.5 pt-1 pb-1.5 text-[11.5px] text-secondary">{modelTitle()}</p>
                <For each={s().runtime?.models ?? [current(s().settings.models)]}>
                  {(model) => (
                    <button
                      type="button"
                      role="menuitemradio"
                      aria-checked={current(s().settings.models) === model}
                      class="flex h-[28px] w-full cursor-default items-center rounded-[6px] px-2.5 text-left hover:bg-fill"
                      classList={{
                        "bg-selected font-medium": current(s().settings.models) === model,
                      }}
                      ref={(el) => {
                        if (current(s().settings.models) === model)
                          queueMicrotask(() => el.focus());
                      }}
                      onClick={() => void choose(model)}
                    >
                      {modelName(model)}
                    </button>
                  )}
                </For>
              </div>
            </Show>
            <Show when={open() === "plan"}>
              <PlanPopover
                status={s()}
                onOpenSettings={() => {
                  setOpen(null);
                  props.onOpenSettings();
                }}
              />
            </Show>
          </>
        )}
      </Show>
    </div>
  );
}

/** Session and week, percent left and when they reset, what Matters used, and when it was seen. */
function PlanPopover(props: {
  status: NonNullable<ReturnType<AgentStore["status"]>>;
  onOpenSettings: () => void;
}) {
  const now = Date.now();
  const limits = () => props.status.settings.limits;
  const lines = () => [
    windowLine("Session", limits()?.session, now),
    windowLine("This week", limits()?.week, now),
  ];
  return (
    <div
      role="dialog"
      aria-label="Plan limits"
      class="absolute right-2.5 bottom-full z-30 mb-1 w-[300px] max-w-[calc(100%-1.25rem)] rounded-[10px] border border-hairline bg-bg p-3.5 text-[12.5px] text-ink shadow-[var(--pop)]"
    >
      <p class="font-semibold">
        {props.status.runtime?.name ?? "Agent"}
        <Show when={props.status.runtime?.plan}>
          {(plan) => <span class="font-normal text-secondary"> · {plan()}</span>}
        </Show>
      </p>
      <Show when={props.status.runtime?.noWindows === true}>
        <p class="mt-2 text-secondary" data-no-windows>
          {noWindowsText(props.status.runtime)}
        </p>
      </Show>
      <div
        class="mt-2 flex flex-col gap-1"
        classList={{ hidden: hasNoWindows(props.status.runtime) }}
      >
        <For each={lines()}>
          {(line) => (
            <p class="flex items-baseline gap-2">
              <span class="w-[68px] shrink-0 text-secondary">{line.label}</span>
              <span class="font-medium">{line.left}</span>
              <Show when={line.resets}>
                <span class="text-secondary">{line.resets}</span>
              </Show>
            </p>
          )}
        </For>
      </div>
      <Show when={!hasNoWindows(props.status.runtime)}>
        <p class="mt-2.5 text-secondary">{ourShare(props.status)}</p>
      </Show>
      <Show when={limits() && !hasNoWindows(props.status.runtime)}>
        <p class="text-secondary">{seenText(limits(), now)}</p>
      </Show>
      <button
        type="button"
        class="mt-2.5 cursor-default text-[12.5px] text-mid underline-offset-2 hover:underline"
        onClick={() => props.onOpenSettings()}
      >
        Open Settings › Agents
      </button>
    </div>
  );
}
