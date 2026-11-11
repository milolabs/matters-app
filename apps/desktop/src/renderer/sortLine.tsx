// A ranked order without a prompt (ADR 0116, rule 4b): the one quiet line under the bar. Before
// `↵` the line is the key that sorts; then how the list was sorted, on one line.
import { Match, Show, Switch } from "solid-js";
import type { SortRunStore } from "./sortRun.ts";

export function SortLine(props: { sort: SortRunStore; shown: () => boolean }) {
  const line = () => (props.shown() ? props.sort.line() : null);
  // A mouse down must not take the focus from where it is.
  const hold = (e: MouseEvent) => e.preventDefault();
  return (
    <Show when={line()}>
      {(l) => (
        <div class="vstatus" data-sort-line={l().kind}>
          <Switch>
            <Match when={l().kind === "ready"}>
              <span class="msg flex min-w-0 items-center" role="status">
                <button
                  type="button"
                  class="act flex shrink-0 items-center gap-1.5"
                  data-sort-run
                  onMouseDown={hold}
                  onClick={() => void props.sort.run()}
                >
                  <kbd class="qkbd">↵</kbd>
                  {l().text.replace(/^↵ /, "")}
                </button>
              </span>
            </Match>
            <Match when={l().kind === "problem"}>
              <span class="msg err" role="alert">
                {l().text}
              </span>
              <button
                type="button"
                class="act"
                data-sort-retry
                onMouseDown={hold}
                onClick={() => void props.sort.run()}
              >
                Try again
              </button>
            </Match>
            <Match when={true}>
              <span class="msg min-w-0 truncate" role="status" title={l().text}>
                {l().text}
              </span>
            </Match>
          </Switch>
        </div>
      )}
    </Show>
  );
}
