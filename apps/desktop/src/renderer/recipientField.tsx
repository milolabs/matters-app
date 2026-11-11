import { createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { Avatar } from "./letterRow.tsx";
import { personMark } from "./personMark.ts";
import { chipLabel, joinRecipients, pieceOf, splitRecipients } from "./recipients.ts";

/** Someone the index knows, for the suggestions under a recipient field. */
export interface Suggestion {
  readonly address: string;
  readonly name?: string | undefined;
  readonly count: number;
}

/**
 * To, Cc or Bcc as chips (ADR 0101): each finished address is a chip with its × , and the rest is
 * typed. Typing asks the index for people; ↑ ↓ pick, ↵ or Tab take one, a comma finishes what was
 * typed, ⌫ in an empty field takes the last chip back to edit. The text underneath is what the
 * draft keeps, so nothing about drafts or sending changes.
 */
export function RecipientField(props: {
  label: string;
  name: string;
  value: string;
  onInput: (text: string) => void;
  suggest?: (prefix: string) => Promise<readonly Suggestion[]>;
  ref?: (el: HTMLInputElement) => void;
  /** Extra controls at the end of the line (Cc / Bcc, the files). */
  end?: JSX.Element;
}) {
  let input!: HTMLInputElement;
  const parts = () => splitRecipients(props.value);
  const [found, setFound] = createSignal<readonly Suggestion[]>([]);
  const [active, setActive] = createSignal(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  onCleanup(() => clearTimeout(timer));

  const set = (chips: readonly string[], typing: string) =>
    props.onInput(joinRecipients(chips, typing));

  function lookUp(prefix: string) {
    clearTimeout(timer);
    const p = prefix.trim();
    if (!props.suggest || p.length < 1) {
      setFound([]);
      return;
    }
    const mine = ++seq;
    timer = setTimeout(() => {
      props.suggest?.(p).then(
        (list) => {
          if (mine !== seq) return;
          const taken = new Set(parts().chips.map((c) => chipLabel(c).address.toLowerCase()));
          setFound(list.filter((s) => !taken.has(s.address.toLowerCase())).slice(0, 6));
          setActive(0);
        },
        () => {},
      );
    }, 80);
  }

  function take(s: Suggestion) {
    set([...parts().chips, pieceOf(s)], "");
    setFound([]);
    input.focus();
  }

  /** Finishes what was typed as a chip, when there is something. */
  function finish(): boolean {
    const { chips, typing } = parts();
    if (typing.trim() === "") return false;
    set([...chips, typing.trim()], "");
    setFound([]);
    return true;
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    const list = found();
    if (list.length > 0 && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
      e.preventDefault();
      setActive((i) => (i + (e.key === "ArrowDown" ? 1 : -1) + list.length) % list.length);
    } else if (list.length > 0 && (e.key === "Enter" || e.key === "Tab") && !e.metaKey) {
      e.preventDefault();
      take(list[active()] as Suggestion);
    } else if (list.length > 0 && e.key === "Escape") {
      // The suggestions close; the composer stays.
      e.preventDefault();
      e.stopPropagation();
      setFound([]);
    } else if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
      // Only an address becomes a chip on ↵; a name waits for its suggestions.
      e.preventDefault();
      if (parts().typing.includes("@")) finish();
    } else if (e.key === "Backspace" && parts().typing === "" && parts().chips.length > 0) {
      e.preventDefault();
      const chips = [...parts().chips];
      const last = chips.pop() as string;
      set(chips, last);
    }
  }

  return (
    <div class="relative flex min-h-[40px] items-center gap-2 border-b border-hairline py-1">
      <label for={`compose-${props.name}`} class="w-[56px] shrink-0 text-[13px] text-secondary">
        {props.label}
      </label>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer shortcut to the field inside; the keyboard reaches the field itself */}
      <div
        class="flex min-w-0 flex-1 flex-wrap items-center gap-1"
        onMouseDown={(e) => {
          if (e.target === e.currentTarget) {
            e.preventDefault();
            input.focus();
          }
        }}
      >
        <For each={parts().chips}>
          {(piece, i) => {
            const chip = () => chipLabel(piece);
            return (
              <span
                data-recipient
                title={chip().address}
                class="inline-flex h-6 max-w-[260px] items-center gap-1 rounded-[6px] pr-0.5 pl-2 text-[13px]"
                classList={{
                  "bg-fill text-ink": chip().valid,
                  "bg-transparent text-late ring-1 ring-late": !chip().valid,
                }}
              >
                <span class="truncate">{chip().label}</span>
                <button
                  type="button"
                  aria-label={`Remove ${chip().label}`}
                  class="grid size-5 cursor-default place-items-center rounded-[4px] text-secondary hover:bg-button hover:text-ink"
                  onClick={() => {
                    const chips = [...parts().chips];
                    chips.splice(i(), 1);
                    set(chips, parts().typing);
                    input.focus();
                  }}
                >
                  ×
                </button>
              </span>
            );
          }}
        </For>
        <input
          id={`compose-${props.name}`}
          ref={(el) => {
            input = el;
            props.ref?.(el);
          }}
          type="text"
          autocomplete="off"
          spellcheck={false}
          role="combobox"
          aria-expanded={found().length > 0}
          aria-controls={`compose-${props.name}-people`}
          aria-autocomplete="list"
          value={parts().typing}
          class="selectable h-7 min-w-[120px] flex-1 bg-transparent text-[13px] outline-none"
          onInput={(e) => {
            const typed = e.currentTarget.value;
            // A comma or a semicolon finishes the address before it.
            const next = splitRecipients(joinRecipients(parts().chips, typed));
            set(next.chips, next.typing);
            lookUp(next.typing);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            setFound([]);
            if (parts().typing.includes("@")) finish();
          }}
        />
      </div>
      {props.end}
      <Show when={found().length > 0}>
        <div
          id={`compose-${props.name}-people`}
          role="listbox"
          aria-label="People"
          class="absolute top-[38px] left-[64px] z-30 flex w-[360px] max-w-[calc(100%-64px)] flex-col rounded-[10px] border border-hairline bg-chrome p-1 shadow-(--pop)"
        >
          <For each={found()}>
            {(s, i) => {
              const mark = personMark(s.address, s.name);
              return (
                <button
                  type="button"
                  role="option"
                  aria-selected={i() === active()}
                  class="grid cursor-default grid-cols-[28px_minmax(0,1fr)] items-center gap-x-2.5 rounded-[7px] px-2 py-1.5 text-left aria-selected:bg-selected"
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i())}
                  onClick={() => take(s)}
                >
                  <span aria-hidden="true" class="row-span-2">
                    <Avatar initials={mark.initials} tint={mark.tint} />
                  </span>
                  <span class="truncate text-[13px]">{s.name || s.address}</span>
                  <span class="truncate text-[11px] text-secondary">
                    {s.name ? `${s.address} · ` : ""}
                    {s.count} {s.count === 1 ? "message" : "messages"}
                  </span>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
