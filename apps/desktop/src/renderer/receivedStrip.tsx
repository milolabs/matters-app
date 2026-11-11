import type { ThreadMessage } from "@matters/contracts";
import type { ReceivedAttachment } from "@matters/core";
import { isRunnableFile } from "@matters/core";
import { createEffect, createSignal, For, type JSX, onCleanup, Show } from "solid-js";
import { extensionOf } from "./chips.ts";
import type { Backend } from "./client.ts";
import { askReceived } from "./files.ts";
import { HitText } from "./hitText.tsx";
import { EyeIcon, PaperclipIcon, SaveIcon } from "./icons.tsx";
import { progress, receivedKey } from "./progress.ts";
import { createReceivedController, type ReceivedController } from "./received.ts";
import {
  chipLabel,
  chipSpeech,
  foldLabel,
  RETRY_TEXT,
  RUNNABLE_NOTE,
  splitName,
  visibleFiles,
} from "./receivedStrip.ts";

/**
 * The files of a received message (ADR 0043, rule 15), in the composer's chip language so a file
 * looks the same going out and coming in. Before the structure is known the old badge stays, with
 * no actions. The list arrives with the thread, so it is there in the frame of the letter.
 */
export function ReceivedStrip(props: { message: ThreadMessage; backend: Backend }) {
  const m = () => props.message;
  return (
    <Show
      when={m().attachmentsKnown}
      fallback={
        <Show when={m().hasAttachments}>
          <p class="mr-4 mb-4 ml-14 inline-flex items-center gap-2 rounded-[8px] bg-fill px-3 py-1 text-[12px] text-mid">
            <PaperclipIcon />
            Attachment
          </p>
        </Show>
      }
    >
      <Show when={m().attachments.length > 0}>
        <Files message={m()} backend={props.backend} />
      </Show>
    </Show>
  );
}

const reducedMotion = () =>
  typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function Files(props: { message: ThreadMessage; backend: Backend }) {
  const files = () => props.message.attachments;
  const received = createReceivedController(props.message.key, files, {
    ask: askReceived,
    sink: progress,
    keyOf: receivedKey,
    onEvent: (listener) => props.backend.onEvent(listener),
    reducedMotion,
  });
  onCleanup(received.dispose);
  const [expanded, setExpanded] = createSignal(false);
  const shown = () => files().slice(0, visibleFiles(files().length, expanded()));
  const hidden = () => files().length - shown().length;
  const note = received.note;

  return (
    <section class="flex flex-col gap-2 pr-4 pb-4 pl-14" aria-label="Attachments" data-received>
      <ul class="m-0 flex list-none flex-wrap items-center gap-2 p-0">
        <For each={shown()}>{(file) => <FileChip file={file} received={received} />}</For>
        <Show when={hidden() > 0}>
          <li>
            <button
              type="button"
              data-fold
              class="h-[28px] cursor-default rounded-[8px] px-3 text-[12px] text-mid hover:bg-fill hover:text-ink"
              onClick={() => setExpanded(true)}
            >
              {foldLabel(hidden())}
            </button>
          </li>
        </Show>
        <Show when={files().length >= 2}>
          <li>
            <button
              type="button"
              data-save-all
              class="h-[28px] cursor-default rounded-[8px] px-3 text-[12px] text-mid hover:bg-fill hover:text-ink"
              onClick={() => void received.saveAll(files().map((f) => f.partId))}
            >
              Save all
            </button>
          </li>
        </Show>
      </ul>
      <Show when={note()}>
        {(n) => (
          <p
            class="m-0 text-[12px]"
            classList={{ "text-secondary": n().tone === "plain", "text-late": n().tone === "late" }}
            data-note
          >
            {n().text}
          </p>
        )}
      </Show>
      {/* State changes only, never a percentage: this is the strip's one live region. */}
      <span class="sr-only" role="status" aria-live="polite">
        {received.spoken()}
      </span>
    </section>
  );
}

function FileChip(props: { file: ReceivedAttachment; received: ReceivedController }) {
  const file = () => props.file;
  const state = () => props.received.stateOf(file().partId);
  const phase = () => state().phase;
  const runnable = () => isRunnableFile(file().name);
  const parts = () => splitName(file().name);
  const label = () => chipLabel(phase(), file().size);
  const failed = () => phase() === "offline" || phase() === "failed";
  const ringed = () => phase() === "downloading" && props.received.ringed(file().partId);
  let badge: HTMLSpanElement | undefined;
  let words: HTMLSpanElement | undefined;

  // Progress reaches the ring and the words directly, not through a signal.
  createEffect(() => {
    if (!ringed() || !badge) return;
    onCleanup(
      progress.bind(receivedKey(props.received.messageKey, file().partId), {
        ring: badge,
        text: words,
      }),
    );
  });

  function press() {
    // A file that runs programs is never opened, and is not downloaded to be refused either.
    if (runnable()) props.received.explain(RUNNABLE_NOTE);
    else void props.received.open(file().partId);
  }

  function key(event: KeyboardEvent) {
    if (event.key === " ") {
      // A button clicks on Space; here Space looks (rule 16).
      event.preventDefault();
      void props.received.preview(file().partId);
    } else if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      event.stopPropagation();
      void props.received.save(file().partId);
    }
  }

  return (
    <li
      data-received-file={file().partId}
      data-state={phase()}
      class="rchip group flex h-[28px] max-w-full items-center rounded-[8px] bg-fill"
    >
      <button
        type="button"
        data-open
        class="flex h-full min-w-0 flex-1 cursor-default items-center gap-2 rounded-[8px] pr-1 pl-2 text-left"
        aria-label={chipSpeech(file().name, file().size, phase(), runnable())}
        aria-busy={phase() === "downloading"}
        aria-disabled={phase() === "gone"}
        onClick={() => {
          if (phase() !== "gone") press();
        }}
        onKeyDown={key}
        onKeyUp={(event) => {
          if (event.key === " ") event.preventDefault();
        }}
      >
        <span
          ref={badge}
          aria-hidden="true"
          class="chip-badge"
          classList={{ "chip-reading": ringed() }}
          data-late={failed() ? "" : undefined}
        >
          {extensionOf(file().name)}
        </span>
        <span class="flex min-w-0 max-w-[290px] text-[12px]" title={file().name}>
          <span class="truncate">
            <HitText text={parts().head} anywhere />
          </span>
          <span class="shrink-0 whitespace-pre">
            <HitText text={parts().tail} anywhere />
          </span>
        </span>
        <Show
          when={ringed()}
          fallback={
            <span
              class="shrink-0 text-[12px] tabular-nums"
              classList={{ "text-secondary": label().tone === "plain", "text-late": failed() }}
              data-label
            >
              {label().text}
              <Show when={failed()}>
                <span class="text-secondary"> · </span>
                <span class="font-semibold text-ink">{RETRY_TEXT}</span>
              </Show>
            </span>
          }
        >
          {/* Static text on purpose: progress replaces it, and no signal ever does. */}
          <span ref={words} class="shrink-0 text-[12px] text-secondary tabular-nums" data-label>
            {label().text}
          </span>
        </Show>
      </button>
      <Show when={runnable()}>
        <ActionButton
          kind="preview"
          label={`Preview ${file().name}`}
          disabled={phase() === "gone"}
          onPress={() => void props.received.preview(file().partId)}
        >
          <EyeIcon />
        </ActionButton>
      </Show>
      <ActionButton
        kind="save"
        label={`Save ${file().name}`}
        disabled={phase() === "gone"}
        onPress={() => void props.received.save(file().partId)}
      >
        <SaveIcon />
      </ActionButton>
    </li>
  );
}

/** A 22 px button like the composer's remove: always laid out, only seen on hover or focus. */
function ActionButton(props: {
  kind: "save" | "preview";
  label: string;
  disabled: boolean;
  onPress: () => void;
  children: JSX.Element;
}) {
  return (
    <button
      type="button"
      data-action={props.kind}
      aria-label={props.label}
      title={props.kind === "save" ? "Save…" : "Preview"}
      disabled={props.disabled}
      class="rsave mr-1 inline-flex size-[22px] shrink-0 cursor-default items-center justify-center rounded-[8px] text-secondary hover:bg-button hover:text-ink"
      classList={{ invisible: props.disabled }}
      onClick={props.onPress}
    >
      {props.children}
    </button>
  );
}
