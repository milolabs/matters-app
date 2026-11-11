import { createMemo, For, type JSX, Show } from "solid-js";
import type { Menu, MenuItem } from "./listMenu.ts";
import { pill, pillPrimary } from "./ui.ts";

/** More sheets than this are one edge and a count: the list beside it holds every row. */
export const STACK_SHOWN = 12;

export interface StackItem {
  readonly id: string;
  readonly who: string;
  readonly when: string;
  readonly late?: boolean;
  readonly title: string;
  /** The third line, shown on the last sheet and on the one under the pointer. */
  readonly note: JSX.Element;
  readonly unread?: boolean;
}

/**
 * The reader while several rows are chosen (ADR 0056, rule 3): the letters laid on top of each other,
 * each showing who and what, so that what is about to happen can be checked before it happens. The
 * actions stay above the pile, so a pile that grows never moves them.
 */
export function ThreadStack<A extends string>(props: {
  title: string;
  people: string;
  items: readonly StackItem[];
  menu: Menu<A>;
  /** The action drawn as the main one. */
  primary: A;
  onAct: (action: A, button: HTMLElement) => void;
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  onClear: () => void;
}) {
  // By id: a row that changes keeps its sheet, and only a new sheet settles into place.
  const ids = createMemo(() => props.items.slice(0, STACK_SHOWN).map((i) => i.id));
  const byId = createMemo(() => new Map(props.items.map((i) => [i.id, i])));
  const more = () => Math.max(0, props.items.length - STACK_SHOWN);
  return (
    <article data-thread-stack class="settle px-8 pt-7 pb-10">
      <header class="mb-4 flex items-start gap-4">
        <div class="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 class="font-serif text-[23px] leading-[1.2] font-semibold tracking-[-0.01em]">
            {props.title}
          </h2>
          <p class="truncate text-[12.5px] text-secondary">{props.people}</p>
        </div>
        <button type="button" class={pill} title="Keep none of them  esc" onClick={props.onClear}>
          Clear
          <span class="ml-2 text-[11px] opacity-60">esc</span>
        </button>
      </header>

      <div class="mb-6 flex flex-wrap items-center gap-2">
        <For each={props.menu.sections}>
          {(section, i) => (
            <>
              <Show when={i() > 0}>
                <span aria-hidden="true" class="mx-1 h-4 w-px bg-hairline" />
              </Show>
              <For each={section}>
                {(item: MenuItem<A>) => (
                  <button
                    type="button"
                    class={item.action === props.primary ? pillPrimary : pill}
                    classList={{ "text-late": item.danger === true }}
                    data-stack-action={item.action}
                    disabled={item.disabled === true}
                    title={item.title}
                    onClick={(e) => props.onAct(item.action, e.currentTarget)}
                  >
                    {item.label}
                    <Show when={item.key}>
                      {(key) => (
                        <span class="ml-2 text-[11px] font-normal opacity-60">{key()}</span>
                      )}
                    </Show>
                  </button>
                )}
              </For>
            </>
          )}
        </For>
      </div>

      <ul aria-label="Chosen" class="tstack" classList={{ "tstack-more": more() > 0 }}>
        <For each={ids()}>
          {(id) => (
            <Show when={byId().get(id)}>
              {(item) => (
                <li class="tsheet settle" data-stack-sheet={id}>
                  <button
                    type="button"
                    class="tsheet-open"
                    title="Open this one alone"
                    onClick={() => props.onOpen(id)}
                  >
                    <span class="flex items-baseline gap-3">
                      <Show when={item().unread}>
                        <span
                          aria-hidden="true"
                          class="size-[7px] self-center rounded-full bg-ink"
                        />
                        <span class="sr-only">Unread</span>
                      </Show>
                      <span class="min-w-0 flex-1 truncate font-semibold">{item().who}</span>
                      <span
                        class="tsheet-when shrink-0 text-[12px] tabular-nums"
                        classList={{ "text-late": item().late, "text-secondary": !item().late }}
                      >
                        {item().when}
                      </span>
                    </span>
                    <span class="block truncate font-medium">{item().title}</span>
                    <span class="tsheet-note block truncate text-[12px] text-secondary">
                      {item().note}
                    </span>
                  </button>
                  <button
                    type="button"
                    class="tsheet-remove"
                    aria-label={`Leave out ${item().title}`}
                    title="Leave this one out"
                    onClick={() => props.onRemove(id)}
                  >
                    ×
                  </button>
                </li>
              )}
            </Show>
          )}
        </For>
      </ul>
      <Show when={more() > 0}>
        <p class="mt-5 text-center text-[12px] text-secondary">and {more()} more in the list</p>
      </Show>
    </article>
  );
}
