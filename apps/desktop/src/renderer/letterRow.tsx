import type { PromiseLine } from "@matters/core";
import type { JSX } from "solid-js";
import { For, Show } from "solid-js";
import { lineLabel, lineLead, lineTrail } from "./promiseRows.ts";

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
  /** 28 px by default; 32 in the list, 48 in the reader's header. */
  size?: 28 | 32 | 48;
  /** The account's colour and the ink on it, for the person's own messages. */
  own?: { readonly fill: string; readonly ink: string };
}): JSX.Element {
  return (
    <span
      aria-hidden="true"
      class="avatar"
      classList={{ "avatar-32": props.size === 32, "avatar-48": props.size === 48 }}
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

/** How far up the first marker's hairline goes: to the avatar of a row, or to the open body's rail. */
const REACH_FIRST = { row: 15, body: 9 } as const;
/** From a marker up to the one before it: the line's 10 px padding, its 18 px and half a marker. */
const REACH_NEXT = 28;

/**
 * The promises and asks of one message, one quiet line each, on the same lead grid as the rows
 * (ADR 0075). Under a collapsed row (`under="row"`) the list is pulled up 4 px; under an open
 * letter's body (`under="body"`) the body's rail brings the hairline down from the avatar. The
 * markers and hairlines are decoration: the sentence is the content.
 */
export function PromiseList(props: {
  lines: readonly PromiseLine[];
  under: "row" | "body";
  nowMs: number;
  timeZone?: string;
}): JSX.Element {
  return (
    <ul
      aria-label="Promises in this message"
      data-promise-lines
      class="m-0 list-none p-0"
      classList={{ "-mt-1": props.under === "row" }}
    >
      <For each={props.lines}>
        {(line, i) => (
          <li
            data-promise-line
            data-status={line.status}
            title={lineLabel(line, props.nowMs, props.timeZone)}
            class="grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 px-4 pb-[10px]"
          >
            <span
              aria-hidden="true"
              class="promise-lead"
              style={{
                "--reach": `${i() === 0 ? REACH_FIRST[props.under] : REACH_NEXT}px`,
              }}
            >
              <span class="promise-dot" data-status={line.status} />
            </span>
            <span class="truncate text-[13px] text-secondary">
              {lineLead(line)} „<span class="text-ink">{line.quote}</span>”
            </span>
            <span
              class="text-[12px] tabular-nums"
              classList={{
                "text-late": line.status === "late",
                "text-secondary": line.status !== "late",
              }}
            >
              {lineTrail(line, props.nowMs, props.timeZone)}
            </span>
          </li>
        )}
      </For>
    </ul>
  );
}

/** The few words that say whose move it is (ADR 0099). */
export function noteKind(line: PromiseLine): string {
  if (line.kind === "ask") return line.who === "you" ? "Waiting for you" : "You're waiting";
  return line.who === "you" ? "You promised" : "They promised";
}

/**
 * The promises and asks of an open letter as the agent's notes (ADR 0099): who noticed it (the
 * agent), whose move it is, by when, the words it came from, and the one thing to do. Violet is
 * the agent's colour (ADR 0052, rule 10); a late one says so in the late colour.
 */
export function AskNotes(props: {
  lines: readonly PromiseLine[];
  nowMs: number;
  timeZone?: string;
  /** Answering the message; absent where the reader cannot write (the note then has no button). */
  onReply?: () => void;
}): JSX.Element {
  return (
    <ul
      aria-label="Noticed by the agent"
      data-promise-lines
      class="m-0 flex list-none flex-col gap-2 px-4 pb-4 pl-14"
    >
      <For each={props.lines}>
        {(line) => {
          const trail = () => lineTrail(line, props.nowMs, props.timeZone);
          const yourMove = line.who === "you";
          return (
            <li
              data-promise-line
              data-status={line.status}
              class="ask-note flex max-w-[62ch] flex-col gap-1.5"
              aria-label={lineLabel(line, props.nowMs, props.timeZone)}
            >
              <div class="flex flex-wrap items-center gap-x-2 text-[11px]">
                <span aria-hidden="true" class="text-agent">
                  ✦
                </span>
                <span class="font-semibold text-agent">Agent noticed</span>
                <span class="text-secondary">{noteKind(line)}</span>
                <span class="flex-1" />
                <Show when={trail() !== ""}>
                  <span
                    class="font-semibold tabular-nums"
                    classList={{
                      "text-late": line.status === "late" || (line.daysLeft ?? 99) <= 2,
                      "text-secondary": line.status !== "late" && (line.daysLeft ?? 99) > 2,
                    }}
                  >
                    {trail()}
                  </span>
                </Show>
              </div>
              <p class="m-0 font-serif text-[14px] leading-[1.45] text-ink">„{line.quote}”</p>
              <Show when={yourMove && props.onReply}>
                {(reply) => (
                  <div class="flex gap-1.5 pt-0.5">
                    <button type="button" class="ask-primary" onClick={() => reply()()}>
                      {line.kind === "ask" ? "Reply" : "Write it now"}
                    </button>
                  </div>
                )}
              </Show>
            </li>
          );
        }}
      </For>
    </ul>
  );
}
