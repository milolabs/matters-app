import type { MoveTarget } from "@matters/core";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { FolderIcon } from "./icons.tsx";
import { filterPlaces, type MovePlace } from "./moveView.ts";

/**
 * The Move list (ADR 0044, rule 17): a small menu in the look of `PopMenu` with a field that
 * filters as you type. Inbox, Archive, then the folders alphabetically, all read from the local
 * folders so it opens in the frame of the key. ↑↓ choose, ↵ moves, Esc closes. The focus stays in
 * the field: the list is chosen from, not walked.
 */
export function MovePicker(props: {
  x: number;
  y: number;
  places: readonly MovePlace[];
  onPick: (target: MoveTarget) => void;
  onClose: () => void;
}) {
  let el!: HTMLDivElement;
  let field!: HTMLInputElement;
  const [typed, setTyped] = createSignal("");
  const [active, setActive] = createSignal(0);
  const shown = createMemo(() => filterPlaces(props.places, typed()));
  const choose = (i: number) => {
    const place = shown()[i];
    if (place) props.onPick(place.target);
  };

  onMount(() => {
    field.focus();
    // A press outside the list closes it; the press itself still does its work.
    const outside = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", outside, true);
    onCleanup(() => document.removeEventListener("mousedown", outside, true));
  });

  function onKeyDown(e: KeyboardEvent) {
    // The list's keys are the list's: none reach the mail window's shortcuts.
    e.stopPropagation();
    const count = shown().length;
    switch (e.key) {
      case "Escape":
      case "Tab":
        e.preventDefault();
        props.onClose();
        break;
      case "ArrowDown":
        e.preventDefault();
        if (count > 0) setActive((active() + 1) % count);
        break;
      case "ArrowUp":
        e.preventDefault();
        if (count > 0) setActive((active() - 1 + count) % count);
        break;
      case "Enter":
        e.preventDefault();
        choose(active());
        break;
    }
  }

  return (
    <div
      ref={el}
      role="dialog"
      aria-label="Move to"
      class="vmenu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onKeyDown={onKeyDown}
    >
      <input
        ref={field}
        type="text"
        role="combobox"
        aria-expanded="true"
        aria-controls="move-places"
        aria-activedescendant={shown().length > 0 ? `move-place-${active()}` : undefined}
        aria-label="Move to"
        placeholder="Move to…"
        autocomplete="off"
        spellcheck={false}
        class="mb-1 h-[26px] w-full rounded-[5px] bg-fill px-2 text-[13px] outline-none placeholder:text-secondary"
        value={typed()}
        onInput={(e) => {
          setTyped(e.currentTarget.value);
          setActive(0);
        }}
      />
      <div id="move-places" role="listbox" class="max-h-[240px] overflow-y-auto">
        <For each={shown()}>
          {(place, i) => (
            <button
              type="button"
              id={`move-place-${i()}`}
              role="option"
              tabindex="-1"
              aria-selected={active() === i()}
              style={active() === i() ? { background: "var(--selected)" } : undefined}
              onMouseMove={() => setActive(i())}
              onClick={() => choose(i())}
            >
              <FolderIcon />
              <span class="trunc ml-2">{place.name}</span>
            </button>
          )}
        </For>
        <Show when={shown().length === 0}>
          <p class="px-2 py-1 text-[12.5px] text-secondary">No such folder.</p>
        </Show>
      </div>
    </div>
  );
}
