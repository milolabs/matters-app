import type { JSX } from "solid-js";

/**
 * The one grid every row of the reader sits on (ADR 0073): a 28 px lead column, the content, and a
 * trailing column. The lead holds the avatar, the agent ring or the reply icon; the content starts
 * 56 px from the edge of the surface (16 + 28 + 12), and so does everything under it.
 */
export const leadGrid =
  "grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 px-4 py-[10px]";

/**
 * Padding of what sits under an open letter's header: on the content edge, 16 px from the right,
 * 4 px below the header and 16 px above what follows (ADR 0075, rule 5: header and body are one
 * block, on the same background).
 */
export const underRow = "pt-1 pr-4 pb-4 pl-14";

/**
 * A circle with the sender's letters. Other people wear their own hue (ADR 0078); the person's own
 * messages are filled with the account's colour. The letters come from `data-initials`, so they are
 * not text of the row: the name stays the only text.
 */
export function Avatar(props: {
  initials: string;
  /** The person's hue (ADR 0078, `personTint`); without it the avatar is neutral. */
  tint?: number;
  /** 28 px by default; 32 in the list. */
  size?: 28 | 32;
  /** The account's colour and the ink on it, for the person's own messages. */
  own?: { readonly fill: string; readonly ink: string };
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      class="avatar"
      classList={{ "avatar-32": props.size === 32 }}
      data-initials={props.initials}
      data-tint={props.own === undefined ? props.tint : undefined}
      data-own={props.own === undefined ? undefined : ""}
      style={
        props.own === undefined
          ? undefined
          : { background: props.own.fill, color: props.own.ink, "border-color": props.own.fill }
      }
    />
  );
}

/** The run of earlier messages folded into one row, on the same grid (ADR 0073, rule 5). */
export function FoldRow(props: { count: number; range: string; onOpen: () => void }) {
  return (
    <button
      type="button"
      aria-expanded="false"
      data-fold-run
      class={`${leadGrid} w-full cursor-default text-left text-[13px] hover:bg-soft focus-visible:outline-1 focus-visible:-outline-offset-1 focus-visible:outline-edge`}
      onClick={() => props.onOpen()}
    >
      <span
        aria-hidden="true"
        class="grid size-[28px] place-items-center rounded-full border border-dashed border-edge text-[11px] text-secondary tabular-nums"
      >
        {props.count}
      </span>
      <span class="truncate text-secondary">{props.count} earlier messages</span>
      <span class="text-[12px] text-secondary tabular-nums">{props.range}</span>
    </button>
  );
}
