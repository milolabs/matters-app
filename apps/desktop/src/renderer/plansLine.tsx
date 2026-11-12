import type { AgentStatus, TalkChoice } from "@matters/core";
import { planUseOf, runtimeInfo } from "@matters/core";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { AgentStore } from "./agent.ts";
import {
  hasNoPlan,
  modelName,
  ourShare,
  planButton,
  seenText,
  talkRuntimes,
  windowLine,
} from "./agentText.ts";
import { ChevronDownIcon } from "./icons.tsx";

/**
 * The status of the plans, the foot row of the prompt in the agent's column (ADR 0052, rule 11;
 * ADR 0069): the model of the talk, grouped by runtime (ADR 0121, rule 8), a quiet hint of the
 * keys, the plan button of the talk's runtime, and at its end what the caller puts there (the send
 * button). It has no input of its own and no other control but the model and
 * plan buttons. Its menus open upward from the dock, which is the positioned ancestor. The list's footer does not show plans.
 */
export function PlansLine(props: {
  agent: AgentStore;
  /** What the prompt looks at: in All mail the chip is the model for questions about the mail. */
  scope: () => "thread" | "all";
  /**
   * The runtime and model chosen in the talk in view (ADR 0121, rule 8), or null for the choice
   * of its kind of work. Choosing in the menu changes that talk only.
   */
  choice: () => TalkChoice | null;
  onChoose: (choice: TalkChoice | null) => void;
  /** The account of the thread in view; null across all mail. */
  accountId: () => string | null;
  onOpenSettings: () => void;
  /** Whether the hint of the keys shows; it is the first thing to go when the column is narrow. */
  hint?: boolean;
  /** Stands at the end of the row: the send button, when the prompt can be sent. */
  children?: JSX.Element;
}) {
  const { agent } = props;
  let root!: HTMLDivElement;
  const [open, setOpen] = createSignal<"models" | "plan" | null>(null);

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

  function onKeyDown(e: KeyboardEvent) {
    if (e.key !== "Escape" || open() === null) return;
    // The popover's key is the popover's: the window's Escape must not also fire.
    e.preventDefault();
    e.stopPropagation();
    setOpen(null);
  }

  const all = () => props.scope() === "all";
  const kind = () => (all() ? "answer" : "write");
  const modelTitle = () => (all() ? "Model for questions about your mail" : "Model for writing");
  /** What the kind of work runs on, as Settings chose it. */
  const own = (s: AgentStatus): TalkChoice | null => {
    const runtimeId = s.settings.kindRuntime[kind()];
    return runtimeId === undefined ? null : { runtimeId, model: s.settings.models[kind()] };
  };
  /** The runtime and model the chip names, and the menu marks: this talk's, else its kind's. */
  const current = (s: AgentStatus): TalkChoice | null => props.choice() ?? own(s);
  /** Every runtime that is ready and agreed to for this mail, with its models (rule 8). */
  const offered = (s: AgentStatus) => talkRuntimes(s, all() ? null : props.accountId());
  const runtimeName = (s: AgentStatus, id: string | undefined) =>
    s.runtimes.find((r) => r.id === id)?.name ?? "";
  const chipText = (s: AgentStatus) => {
    const c = current(s);
    if (c === null) return "";
    // With more than one runtime to choose from, the chip says which one the talk is on.
    return offered(s).length > 1
      ? `${modelName(c.model)} · ${runtimeName(s, c.runtimeId)}`
      : modelName(c.model);
  };
  const button = () => {
    const s = status();
    return s === null ? null : planButton(s, current(s)?.runtimeId, Date.now());
  };

  function choose(s: AgentStatus, runtimeId: string, model: string) {
    setOpen(null);
    const mine = own(s);
    // The choice of the kind itself needs no choice of the talk's.
    props.onChoose(
      mine !== null && mine.runtimeId === runtimeId && mine.model === model
        ? null
        : { runtimeId, model },
    );
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
              aria-label={`${modelTitle()}: ${modelName(current(s())?.model ?? "")} · ${runtimeName(s(), current(s())?.runtimeId)}`}
              title={modelTitle()}
              data-talk-model
              class="inline-flex h-[22px] min-w-0 shrink cursor-default items-center gap-1 rounded-[6px] bg-fill px-2 text-mid hover:bg-button hover:text-ink"
              onClick={() => setOpen(open() === "models" ? null : "models")}
            >
              <span class="truncate">{chipText(s())}</span>
              <ChevronDownIcon />
            </button>
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
                class="absolute bottom-full left-2.5 z-30 mb-1 max-h-[60vh] max-w-[calc(100%-1.25rem)] min-w-[170px] overflow-y-auto rounded-[9px] border border-hairline bg-bg p-1 text-[12.5px] text-ink shadow-[var(--pop)]"
              >
                <p class="px-2.5 pt-1 pb-1.5 text-[11.5px] text-secondary">{modelTitle()}</p>
                <For
                  each={
                    offered(s()).length > 0
                      ? offered(s())
                      : [
                          {
                            id: current(s())?.runtimeId ?? "",
                            name: runtimeName(s(), current(s())?.runtimeId),
                            models: current(s()) === null ? [] : [current(s())?.model ?? ""],
                          },
                        ]
                  }
                >
                  {(runtime) => (
                    <div data-talk-runtime={runtime.id}>
                      <Show when={offered(s()).length > 1}>
                        <p class="px-2.5 pt-1.5 pb-0.5 text-[11.5px] text-secondary">
                          {runtime.name}
                        </p>
                      </Show>
                      <For each={runtime.models}>
                        {(model) => {
                          const marked = () =>
                            current(s())?.runtimeId === runtime.id && current(s())?.model === model;
                          return (
                            <button
                              type="button"
                              role="menuitemradio"
                              aria-checked={marked()}
                              class="flex h-[28px] w-full cursor-default items-center rounded-[6px] px-2.5 text-left hover:bg-fill"
                              classList={{ "bg-selected font-medium": marked() }}
                              ref={(el) => {
                                if (marked()) queueMicrotask(() => el.focus());
                              }}
                              onClick={() => choose(s(), runtime.id, model)}
                            >
                              {modelName(model)}
                            </button>
                          );
                        }}
                      </For>
                    </div>
                  )}
                </For>
                <Show when={props.choice() !== null}>
                  <p class="px-2.5 pt-1.5 pb-1 text-[11.5px] text-secondary">For this talk only.</p>
                </Show>
              </div>
            </Show>
            <Show when={open() === "plan"}>
              <PlanPopover
                status={s()}
                runtimeId={current(s())?.runtimeId}
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
  /** The runtime of the talk: its plan, its windows (ADR 0121, rule 6). */
  runtimeId: string | undefined;
  onOpenSettings: () => void;
}) {
  const now = Date.now();
  const runtime = () => runtimeInfo(props.status, props.runtimeId);
  const limits = () => planUseOf(props.status.settings, props.runtimeId).limits;
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
        {runtime()?.name ?? "Agent"}
        <Show when={runtime()?.plan}>
          {(plan) => <span class="font-normal text-secondary"> · {plan()}</span>}
        </Show>
      </p>
      <div class="mt-2 flex flex-col gap-1" classList={{ hidden: hasNoPlan(runtime()) }}>
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
      <Show when={!hasNoPlan(runtime())}>
        <p class="mt-2.5 text-secondary">{ourShare(props.status, props.runtimeId)}</p>
      </Show>
      <Show when={limits() && !hasNoPlan(runtime())}>
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
