import { createEffect, Index, onCleanup, Show } from "solid-js";
import { type Chip, chipNote, drawsReadingRing, extensionOf, readingText } from "./chips.ts";
import type { ComposerSession } from "./compose.ts";
import { fileSize, megabytes } from "./format.ts";
import { chipKey, progress } from "./progress.ts";

/**
 * The files between the message and the footer (ADR 0041, rule 20): a chip each, and the total.
 * The strip grows to two rows and then scrolls inside itself, so the message keeps its room.
 */
export function AttachmentStrip(props: { session: ComposerSession }) {
  const s = () => props.session;
  const total = () =>
    s()
      .attachments()
      .reduce((n, c) => n + c.size, 0);
  const count = () => s().attachments().length;
  const over = () => {
    const n = s().notice();
    return n?.kind === "tooLarge" && n.limitBytes !== null
      ? `${megabytes(n.encodedBytes)} to send, limit ${megabytes(n.limitBytes)}`
      : null;
  };
  return (
    <Show when={count() > 0}>
      <section
        data-strip
        class="flex items-start gap-3 border-t border-hairline px-5 py-2"
        aria-label="Attachments"
      >
        <ul class="m-0 flex max-h-[66px] min-w-0 flex-1 list-none flex-wrap gap-1.5 overflow-y-auto p-0">
          {/* By position: a chip is a new object whenever it changes, and its ring must stay. */}
          <Index each={s().attachments()}>
            {(chip) => <ChipView chip={chip()} session={s()} />}
          </Index>
        </ul>
        <p
          class="m-0 mt-[7px] shrink-0 text-[12px] tabular-nums"
          classList={{ "text-secondary": over() === null, "text-late": over() !== null }}
          data-total
        >
          {over() ?? `${count()} ${count() === 1 ? "file" : "files"} · ${megabytes(total())}`}
        </p>
        {/* State changes only, never a percentage: this is the one live region of the strip. */}
        <span class="sr-only" role="status" aria-live="polite">
          {s().announcement()}
        </span>
      </section>
    </Show>
  );
}

export function ChipView(props: { chip: Chip; session: ComposerSession }) {
  // `props.chip` is a new object whenever the chip changes, and this view is keyed by its id.
  const chip = () => props.chip;
  const note = () => chipNote(chip());
  // Provisional chips have no row yet, so nothing reports for them.
  const reading = () => chip().state === "reading" && chip().added;
  // A forwarded file under 1 MiB is downloaded too quickly for a ring to be anything but a flash.
  const ringed = () => drawsReadingRing(chip());
  let ring: HTMLSpanElement | undefined;
  let label: HTMLSpanElement | undefined;
  // Read once: from here on only a progress report writes into the words (ADR 0041, rule 5).
  const initialText = readingText(props.chip);

  // Progress reaches the ring and the words directly (ADR 0041, rule 5), not through a signal.
  createEffect(() => {
    if (!ringed() || !ring) return;
    const off = progress.bind(chipKey(chip().id), { ring, text: label });
    onCleanup(off);
  });

  return (
    <li
      data-attachment={chip().id}
      data-state={chip().state}
      class="flex h-[30px] max-w-full items-center gap-2 rounded-[8px] bg-fill pr-1 pl-2"
    >
      <Show
        when={chip().state !== "failed" && chip().state !== "tooLarge"}
        fallback={<span aria-hidden="true" class="size-1.5 shrink-0 rounded-full bg-late" />}
      >
        <span
          ref={ring}
          aria-hidden="true"
          class="chip-badge"
          classList={{ "chip-reading": ringed() }}
        >
          {extensionOf(chip().name)}
        </span>
      </Show>
      <span class="min-w-0 max-w-[290px] truncate text-[12.5px]" title={chip().name}>
        {chip().name}
      </span>
      <Show
        when={reading()}
        fallback={
          <Show
            when={note()}
            fallback={
              <span class="shrink-0 text-[12px] text-secondary tabular-nums">
                {fileSize(chip().size)}
              </span>
            }
          >
            {(n) => (
              <span
                class="shrink-0 text-[12px] tabular-nums"
                classList={{
                  "text-late": n().tone === "late",
                  "text-secondary": n().tone !== "late",
                }}
                data-note
              >
                {n().text}
              </span>
            )}
          </Show>
        }
      >
        {/* Static text on purpose: progress replaces it, and no signal ever does. */}
        <span ref={label} class="shrink-0 text-[12px] text-secondary tabular-nums" data-reading>
          {initialText}
        </span>
      </Show>
      <Show when={chip().state === "ready" && chip().changed}>
        <button
          type="button"
          data-use-new
          class="h-[22px] shrink-0 cursor-default rounded-[6px] bg-button px-2 text-[12px]"
          onClick={() => void props.session.recapture(chip().id)}
        >
          Use new version
        </button>
      </Show>
      <Show when={chip().state === "failed" && chip().added && chip().canRetry}>
        <button
          type="button"
          data-try-again
          class="h-[22px] shrink-0 cursor-default rounded-[6px] bg-button px-2 text-[12px]"
          onClick={() => void props.session.recapture(chip().id)}
        >
          Try again
        </button>
      </Show>
      <button
        type="button"
        data-remove
        aria-label={`Remove ${chip().name}`}
        class="inline-flex size-[22px] shrink-0 cursor-default items-center justify-center rounded-[6px] text-secondary hover:bg-button hover:text-ink"
        onClick={() => props.session.removeAttachment(chip().id)}
      >
        <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
          <path
            d="M2 2l6 6M8 2L2 8"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
          />
        </svg>
      </button>
    </li>
  );
}
