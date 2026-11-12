// A prompt is a filter (ADR 0116): the one quiet line under the bar while the query holds a
// prompt. What a run would do and the key that starts it (rule 4), the count after the search and
// the `↵` that reads above `PROMPT_ASK_ABOVE`, how far a run is with Stop (rule 9), how it ended,
// and `Search again`. A saved view's line also says, by itself, how the reading in the background
// stands for it (ADR 0117, rule 3a): how far, what is out and since when, or why it waits.
import type { ReadingView } from "@matters/core";
import { Match, Show, Switch } from "solid-js";
import { AgentRing } from "./agentLayer.tsx";
import type { PromptRunStore } from "./promptRun.ts";
import { promptLine } from "./promptView.ts";
import { createTicker } from "./reading.ts";

const mini =
  "h-[22px] shrink-0 cursor-default rounded-[6px] bg-button px-2 text-[11.5px] text-ink disabled:opacity-35";

export function PromptLine(props: {
  prompt: PromptRunStore;
  /** The saved view in view, in the status of the reading in the background, with its runtime. */
  reading?: () => { readonly view: ReadingView; readonly runtime: string } | null;
}) {
  const { prompt } = props;
  // What is out counts its seconds while a turn is out; still otherwise.
  const now = createTicker(
    () =>
      prompt.has() &&
      (prompt.progress()?.inFlight !== undefined || prompt.background()?.inFlight !== undefined),
  );
  const line = () =>
    prompt.has()
      ? promptLine({
          count: prompt.count(),
          progress: prompt.progress(),
          stopping: prompt.stopping(),
          outcome: prompt.outcome(),
          view: prompt.isView(),
          background: prompt.background(),
          reading: props.reading?.() ?? null,
          now: now(),
        })
      : null;
  const hint = () => (line() as { hint?: string } | null)?.hint;
  // A mouse down must not take the focus from where it is.
  const hold = (e: MouseEvent) => e.preventDefault();
  /** `label` starts with `↵ `: the key is drawn as a key. */
  const key = (label: string, attr: string) => (
    <button
      type="button"
      class="act flex shrink-0 items-center gap-1.5"
      {...{ [attr]: "" }}
      onMouseDown={hold}
      onClick={() => void prompt.run()}
    >
      <kbd class="qkbd">↵</kbd>
      {label.replace(/^↵ /, "")}
    </button>
  );
  return (
    <Show when={line()}>
      {(l) => (
        <div class="vstatus" data-prompt-line={l().kind}>
          <Switch>
            <Match when={l().kind === "searching" || l().kind === "reading"}>
              {/* A long query of the search is cut, not wrapped; how far a reading is wraps. */}
              <span
                class="msg flex min-w-0 items-center gap-2 text-agent"
                role="status"
                title={l().kind === "searching" ? l().text : undefined}
              >
                <AgentRing size={12} />
                <span class="min-w-0" classList={{ truncate: l().kind === "searching" }}>
                  {l().text}
                </span>
              </span>
              <button
                type="button"
                class={mini}
                data-prompt-stop
                disabled={prompt.stopping()}
                onMouseDown={hold}
                onClick={() => prompt.stop()}
              >
                Stop
              </button>
            </Match>
            <Match when={l().kind === "problem"}>
              <span class="msg err" role="alert">
                {l().text}
              </span>
              <Show when={(l() as { retry?: boolean }).retry}>
                <button
                  type="button"
                  class="act"
                  data-prompt-retry
                  onMouseDown={hold}
                  onClick={() => void prompt.run()}
                >
                  Try again
                </button>
              </Show>
            </Match>
            <Match when={l().kind === "ready"}>
              <span class="msg flex min-w-0 items-center" role="status">
                {key(l().text, "data-prompt-search")}
              </span>
            </Match>
            <Match when={l().kind === "ask"}>
              <span class="msg min-w-0" role="status">
                {l().text}
              </span>
              {key((l() as { key: string }).key, "data-prompt-read")}
            </Match>
            <Match when={l().kind === "background"}>
              {/* The words wrap: nothing of the state hides behind a cut or a tooltip. */}
              <span
                class="msg flex min-w-0 items-center gap-2 text-agent"
                role="status"
                data-prompt-background
              >
                <AgentRing size={12} />
                <span class="min-w-0">{l().text}</span>
              </span>
            </Match>
            <Match when={l().kind === "count"}>
              <span class="msg min-w-0" role="status">
                {l().text}
              </span>
              {key("↵ to read", "data-prompt-read")}
            </Match>
            <Match when={l().kind === "allRead" && (l() as { whole?: boolean }).whole}>
              <span class="msg" role="status">
                {l().text}
              </span>
            </Match>
            <Match when={true}>
              <span class="msg" role="status">
                {l().text}
              </span>
              <button
                type="button"
                class="act shrink-0"
                data-prompt-again
                onMouseDown={hold}
                onClick={() => void prompt.searchAgain()}
              >
                Search again
              </button>
            </Match>
          </Switch>
          <Show when={hint()}>
            {(h) => (
              <span class="basis-full text-[11.5px] text-secondary" data-prompt-slow>
                {h()}
              </span>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
