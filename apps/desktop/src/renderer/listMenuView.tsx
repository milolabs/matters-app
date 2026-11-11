import { For, Show } from "solid-js";
import type { Menu } from "./listMenu.ts";
import { PopMenu } from "./popMenu.tsx";

/** The menu of a list row, drawn in the look of every other menu (ADR 0056, rule 4). */
export function ListMenuView<A extends string>(props: {
  menu: Menu<A>;
  label: string;
  x: number;
  y: number;
  onPick: (action: A) => void;
  onClose: (restoreFocus: boolean) => void;
}) {
  return (
    <PopMenu label={props.label} x={props.x} y={props.y} onClose={props.onClose}>
      <Show when={props.menu.heading}>{(heading) => <div class="vhead">{heading()}</div>}</Show>
      <For each={props.menu.sections}>
        {(section, i) => (
          <>
            <Show when={i() > 0}>
              <hr />
            </Show>
            <For each={section}>
              {(item) => (
                <button
                  type="button"
                  role="menuitem"
                  data-menu-action={item.action}
                  disabled={item.disabled === true}
                  title={item.title}
                  classList={{ danger: item.danger === true }}
                  onClick={() => props.onPick(item.action)}
                >
                  <span class="trunc flex-1">{item.label}</span>
                  <Show when={item.key}>
                    {(key) => <span class="ml-4 text-secondary">{key()}</span>}
                  </Show>
                </button>
              )}
            </For>
          </>
        )}
      </For>
    </PopMenu>
  );
}
