import type { ThingBundle } from "@matters/core";
import { createMemo, createSignal, For, Index, Show } from "solid-js";
import { AgentRing } from "./agentLayer.tsx";
import { matterRows, matterSummary, pathOf } from "./matterMap.ts";

/** Longer matters open on this many rows, so that the letter stays near the top. */
const ROWS_SHOWN = 6;

/**
 * One matter as an order of work (ADR 0059, rule 5). It answers where to start, and shows why: order
 * and indent give the direction, so no line needs an arrow, and the reason sits on the line it
 * explains. Threads are the person's mail and have plain ink; what blocks what was said by an agent,
 * so its lines and quotes are the agent's: dashed and violet (ADR 0052, rule 10).
 */
export function MatterMap(props: {
  bundle: ThingBundle;
  current: string;
  onOpen: (threadId: string) => void;
  /** Says what these threads are, in place of the sentence about what holds up what. */
  summary?: string;
}) {
  const rows = createMemo(() => matterRows(props.bundle));
  const summary = createMemo(() =>
    props.summary === undefined
      ? matterSummary(props.bundle)
      : { text: props.summary, agent: false },
  );
  const [lit, setLit] = createSignal<string | null>(null);
  const [all, setAll] = createSignal(false);
  const path = createMemo(() => pathOf(props.bundle, lit()));
  const shown = () => (all() ? rows() : rows().slice(0, ROWS_SHOWN));
  const member = (id: string) => props.bundle.members.find((m) => m.threadId === id);
  return (
    <section aria-label={`Threads of ${props.bundle.name}`} data-matter-map class="mb-5">
      <div class="mb-1.5 flex flex-wrap items-baseline gap-x-2.5">
        <h3 class="m-0 font-serif text-[15px] font-semibold">{props.bundle.name}</h3>
        <p
          data-matter-summary
          class="m-0 inline-flex items-center gap-2 text-[12px]"
          classList={{ "text-agent": summary().agent, "text-secondary": !summary().agent }}
        >
          <Show when={summary().agent}>
            <span class="self-center">
              <AgentRing />
            </span>
          </Show>
          {summary().text}
        </p>
      </div>
      <ol class="matter-tree" onMouseLeave={() => setLit(null)}>
        <For each={shown()}>
          {(row) => (
            <li>
              <button
                type="button"
                class="mm-row"
                data-map-node={row.threadId}
                data-ready={row.ready ? "" : undefined}
                data-dim={lit() !== null && !path().has(row.threadId) ? "" : undefined}
                aria-current={row.threadId === props.current ? "true" : undefined}
                style={{ "--depth": row.depth }}
                onMouseEnter={() => setLit(row.threadId)}
                onFocus={() => setLit(row.threadId)}
                onBlur={() => setLit(null)}
                onClick={() => props.onOpen(row.threadId)}
              >
                <Index each={row.guides}>
                  {(goesOn, level) => (
                    <span
                      aria-hidden="true"
                      class="mm-guide"
                      data-on={goesOn() ? "" : undefined}
                      style={{ "--level": level }}
                    />
                  )}
                </Index>
                <Show when={row.depth > 0}>
                  <span aria-hidden="true" class="mm-elbow" />
                </Show>
                <Show when={row.stem}>
                  <span aria-hidden="true" class="mm-stem" />
                </Show>
                <span
                  aria-hidden="true"
                  class="mm-dot"
                  data-late={(member(row.threadId)?.lateByDays ?? 0) > 0 ? "" : undefined}
                />
                <span class="sr-only">{row.ready ? "Can start now: " : "Waits: "}</span>
                <span class="flex min-w-0 items-baseline gap-2">
                  <span class="max-w-[45%] shrink-0 truncate font-semibold">
                    {member(row.threadId)?.who}
                  </span>
                  <span class="min-w-0 flex-1 truncate text-mid">
                    {member(row.threadId)?.headline}
                  </span>
                  <Show when={(member(row.threadId)?.lateByDays ?? 0) > 0}>
                    <span class="shrink-0 text-[12px] text-late tabular-nums">
                      {member(row.threadId)?.lateByDays} d late
                    </span>
                  </Show>
                </span>
                <Show when={row.quote !== undefined || row.alsoWaitsOn.length > 0}>
                  <span class="mm-reason" title={row.quote}>
                    <Show when={row.alsoWaitsOn.length > 0}>
                      <span class="mm-also">Also waits on {row.alsoWaitsOn.join(", ")}. </span>
                    </Show>
                    <Show when={row.quote}>{(quote) => <>“{quote()}”</>}</Show>
                  </span>
                </Show>
              </button>
            </li>
          )}
        </For>
      </ol>
      <Show when={rows().length > ROWS_SHOWN}>
        <button
          type="button"
          class="mt-1 cursor-default rounded-[5px] px-2 py-0.5 text-[12px] text-secondary hover:bg-fill hover:text-ink"
          aria-expanded={all()}
          onClick={() => setAll((v) => !v)}
        >
          {all() ? "Show fewer" : `Show all ${rows().length}`}
        </button>
      </Show>
    </section>
  );
}
