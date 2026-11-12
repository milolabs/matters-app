// The reading in the background at the foot of the list (ADR 0117, rule 3a): a segment of the
// list's foot row, right of the mail's sync, whose words carry the state by themselves (which view
// and how far, or why it waits and until when); a 2 px line along the row's top edge, as wide as
// the view read is far; and a popover, `Reading in the background`, with each view with a prompt
// and its state, the runtime that reads, and `Pause reading` or `Continue reading`. Nothing is
// only in a tooltip. Up to date, the segment is not there.
import type { PromptProgress, ReadingView } from "@matters/core";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { AgentRing } from "./agentLayer.tsx";
import {
  readingCountText,
  readingFoot,
  readingSettingsText,
  readingStateText,
} from "./agentText.ts";
import { createTicker, type ReadingStore } from "./reading.ts";

export function ReadingFootSegment(props: {
  reading: ReadingStore;
  /** A run of the open saved view, as its line shows it: the foot row shows it too. */
  run?: () => PromptProgress | null;
  /** Opens a saved view by id, as its tab does. */
  onOpenView: (id: string) => void;
  /** `Pause reading` and `Continue reading`: the person's switch (ADR 0117, rule 3). */
  onPause: (paused: boolean) => Promise<unknown>;
}) {
  const { reading } = props;
  let root!: HTMLDivElement;
  let button: HTMLButtonElement | undefined;
  let panel: HTMLDivElement | undefined;
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  // The clock moves only for the times the words name; nothing ticks while nothing is out.
  const now = createTicker(open);
  /** The pass in the background, else a run of the open view. */
  const live = () => reading.live() ?? props.run?.() ?? null;
  // While the popover is open the segment stays, also once all is read, so it closes where it opened.
  const foot = () =>
    readingFoot(reading.status(), live(), now()) ??
    (open()
      ? {
          text: readingSettingsText(reading.status(), live(), now()),
          kind: "waiting" as const,
        }
      : null);
  const views = () => reading.status()?.views ?? [];

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) button?.focus();
  }

  function toggle() {
    if (open()) return close(false);
    setOpen(true);
    // The counts are computed now, once; the row's own words come from what was last counted.
    void reading.fresh();
    queueMicrotask(() => panel?.querySelector<HTMLElement>("button")?.focus());
  }

  onMount(() => {
    const outside = (e: MouseEvent) => {
      if (open() && !root.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || !open()) return;
      // The popover's key is the popover's: the window's Escape must not also fire.
      e.preventDefault();
      e.stopPropagation();
      close(true);
    };
    document.addEventListener("mousedown", outside, true);
    root.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", outside, true);
      root.removeEventListener("keydown", onKey);
    });
  });

  async function pause(paused: boolean) {
    if (busy()) return;
    setBusy(true);
    try {
      await props.onPause(paused);
      await reading.refresh();
    } finally {
      setBusy(false);
    }
  }

  const readsNow = (v: ReadingView) => {
    const l = live();
    return (l?.view?.id === v.viewId && !l.finished) || v.state === "reading";
  };
  const stateOf = (v: ReadingView) =>
    readsNow(v) ? "Reading now" : readingStateText(v, reading.status()?.runtime ?? "", now());

  return (
    <div ref={root} class="flex min-w-0 max-w-[60%] shrink" data-reading-foot>
      <Show when={foot()}>
        {(f) => (
          <>
            {/* How far the view read is, along the top edge: the one thing to see from anywhere. */}
            <Show when={f().kind === "reading"}>
              <span class="reading-edge" aria-hidden="true">
                <span
                  class="reading-fill"
                  classList={{ flight: f().inFlight === true }}
                  style={{ width: `${Math.round((f().fraction ?? 0) * 1000) / 10}%` }}
                />
              </span>
            </Show>
            <button
              ref={button}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={open()}
              data-reading-state={f().kind}
              class="flex min-w-0 cursor-default items-center gap-2 self-stretch border-l border-hairline px-3 text-left text-[12px] leading-[14px] tabular-nums hover:bg-fill"
              classList={{
                "text-agent": f().kind === "reading",
                "text-mid": f().kind === "waiting",
                "text-late": f().kind === "act",
              }}
              onClick={toggle}
            >
              <Show
                when={f().kind === "reading"}
                fallback={
                  <span
                    class="reading-dot"
                    classList={{ act: f().kind === "act" }}
                    aria-hidden="true"
                  />
                }
              >
                <AgentRing size={12} />
              </Show>
              {/* The words wrap in the 44 px row; they are never cut. Waiting: why, then which. */}
              <span class="min-w-0" role="status" aria-live="polite">
                <Show when={f().why !== undefined && f().which !== undefined} fallback={f().text}>
                  <span class="block">{f().why}</span>
                  <span class="block whitespace-nowrap">{f().which}</span>
                </Show>
              </span>
            </button>
          </>
        )}
      </Show>
      <Show when={open() && foot() !== null}>
        <div
          ref={panel}
          role="dialog"
          aria-label="Reading in the background"
          data-reading-popover
          class="absolute right-2.5 bottom-full z-30 mb-1 w-[320px] max-w-[calc(100%-1.25rem)] rounded-[10px] border border-hairline bg-bg p-1.5 text-[12.5px] text-ink shadow-[var(--pop)]"
        >
          <p class="px-2 pt-1.5 pb-1 font-semibold">
            Reading in the background
            <Show when={reading.status()?.runtime}>
              {(name) => <span class="font-normal text-secondary"> · {name()}</span>}
            </Show>
          </p>
          <For each={views()}>
            {(v) => (
              <button
                type="button"
                data-reading-view={v.viewId}
                class="flex w-full cursor-default flex-col rounded-[6px] px-2 py-1.5 text-left hover:bg-fill focus-visible:bg-fill"
                onClick={() => {
                  close(false);
                  props.onOpenView(v.viewId);
                }}
              >
                <span class="flex w-full items-baseline gap-2">
                  <span class="min-w-0 flex-1 font-medium">{v.name}</span>
                  <span class="shrink-0 text-[12px] text-secondary tabular-nums">
                    {readingCountText(v, live())}
                  </span>
                </span>
                <span
                  class="text-[12px]"
                  classList={{ "text-agent": readsNow(v), "text-secondary": !readsNow(v) }}
                >
                  {stateOf(v)}
                </span>
              </button>
            )}
          </For>
          <div class="mt-1 border-t border-hairline px-2 pt-2 pb-1">
            <button
              type="button"
              data-reading-pause
              disabled={busy()}
              class="h-[24px] cursor-default rounded-[6px] bg-button px-2.5 text-[12px] text-ink disabled:opacity-35"
              onClick={() => void pause(reading.status()?.paused !== true)}
            >
              {reading.status()?.paused === true ? "Continue reading" : "Pause reading"}
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
}
