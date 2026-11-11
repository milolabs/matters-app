import type { PreparedWork } from "@matters/core";
import { For, type JSX, Show } from "solid-js";
import { Ring } from "./icons.tsx";
import { type Piece, questionButtonText } from "./mattersView.ts";
import { pill, pillAgent, pillPrimary } from "./ui.ts";

const mac = navigator.userAgent.includes("Macintosh");

// The agent layer (ADR 0052, rule 10). Everything an agent made is drawn the same way: the agent
// colour, a dashed edge and the open ring. The colour is never the only sign: the ring, the dashed
// edge and the words say it too. Mail from people keeps its solid hairline.

/** The open ring in the agent colour. Decoration: the words next to it say what it means. */
export function AgentRing(props: { size?: number }) {
  return (
    <span class="inline-flex shrink-0 text-agent">
      <Ring size={props.size ?? 14} color="var(--agent)" />
    </span>
  );
}

/** The frame of anything the agent proposes and nobody has taken yet. */
export function Proposal(props: {
  title: string;
  /** `Claude Code, Haiku, your plan`: who wrote it and on what. */
  by?: string;
  label: string;
  children: JSX.Element;
}) {
  return (
    <section
      aria-label={props.label}
      data-proposal
      class="rounded-[12px] border-[1.5px] border-dashed border-agent-edge bg-agent-soft"
    >
      <div class="grid grid-cols-[28px_minmax(0,1fr)] items-center gap-x-3 px-4 py-3 text-[12px] text-agent">
        <span class="flex justify-center">
          <AgentRing />
        </span>
        <span class="min-w-0 truncate">
          <span class="font-semibold">{props.title}</span>
          <Show when={props.by}>
            <span> · {props.by}</span>
          </Show>
        </span>
      </div>
      {props.children}
    </section>
  );
}

/**
 * The white sheet inside a draft: exactly what would go out. Words the person gave are
 * underlined, and the sheet says so. Model text is shown as text nodes only; a link in it is
 * not a link.
 */
export function Sheet(props: {
  to: string;
  pieces: readonly Piece[];
  /** The note under the sheet: what the agent read. */
  read: string;
  yoursNote: boolean;
}) {
  return (
    <>
      <div data-sheet class="mx-4 mb-3 rounded-[8px] bg-bg py-3 pr-4 pl-10">
        <div class="mb-3 flex items-baseline gap-3 text-[12px] text-secondary">
          <span class="min-w-0 flex-1 truncate">To {props.to}</span>
          <span>Not sent</span>
        </div>
        <div data-draft class="selectable font-serif text-[15px] leading-[1.6] whitespace-pre-line">
          <For each={props.pieces}>
            {(piece) => (
              <Show when={piece.yours} fallback={piece.text}>
                <span class="underline decoration-agent-edge decoration-2 underline-offset-[3px]">
                  {piece.text}
                </span>
              </Show>
            )}
          </For>
        </div>
        <Show when={props.yoursNote}>
          <p class="mt-3 text-[12px] text-secondary">Underlined words are yours.</p>
        </Show>
      </div>
      <p class="pr-4 pb-3 pl-14 text-[12px] text-agent">{props.read}</p>
    </>
  );
}

/**
 * A draft the agent wrote: the proposal frame, the sheet that would go out, and the only Send.
 * Matters and the thread view draw it alike; `aside` holds the buttons on the left.
 */
export function DraftFrame(props: {
  to: string;
  pieces: readonly Piece[];
  /** The note under the sheet: what the agent read. */
  read: string;
  /** `Claude Code, Haiku, your plan`: who wrote it and on what. */
  by: string;
  busy: boolean;
  /** The key hint in the title of `Edit myself`; none where the key means something else. */
  editKey?: string;
  aside: JSX.Element;
  onEdit: () => void;
  onSend: () => void;
}) {
  return (
    <Proposal title="Written by the agent" by={props.by} label="A draft written by the agent">
      <Sheet
        to={props.to}
        pieces={props.pieces}
        yoursNote={props.pieces.some((p) => p.yours)}
        read={props.read}
      />
      <div class="flex flex-wrap items-center gap-2 pr-4 pb-3 pl-14">
        {props.aside}
        <span class="flex-1" />
        <button
          type="button"
          class={pill}
          disabled={props.busy}
          title={`Open this draft in the composer${props.editKey === undefined ? "" : `  ${props.editKey}`}`}
          onClick={props.onEdit}
        >
          Edit myself
        </button>
        <button
          type="button"
          class={pillPrimary}
          data-send-agent
          disabled={props.busy}
          title={`Send (${mac ? "⌘" : "Ctrl+"}↵)`}
          onClick={props.onSend}
        >
          {props.busy ? "Sending…" : "Send"}
          <span class="ml-2 text-[11px] font-normal opacity-60">⌘↵</span>
        </button>
      </div>
    </Proposal>
  );
}

/**
 * The agent stopped instead of guessing: what is missing and ways forward. It has no field of its
 * own: words go to the agent through the one prompt in its column (ADR 0069), which opens and
 * takes the cursor on `Answer`. The caller says what writing does.
 */
export function QuestionFrame(props: {
  work: Extract<PreparedWork, { kind: "needs" }>;
  /** The way forward the person chose, if any. */
  direction: string | undefined;
  by: string;
  busy: boolean;
  aside: JSX.Element;
  onChoose: (text: string) => void;
  /** `Write the draft`, with the way forward that was chosen. */
  onWrite: () => Promise<unknown> | undefined;
  /** `Answer`: shows the agent's column and puts the cursor in its prompt. */
  onAnswer: () => void;
}) {
  const chosen = () => props.direction !== undefined;
  return (
    <Proposal
      title="The agent stopped instead of guessing"
      by={props.by}
      label="A question from the agent"
    >
      <div class="mx-4 mb-3 rounded-[8px] bg-bg py-3 pr-4 pl-10">
        <p data-missing class="m-0 font-serif text-[15px] leading-[1.6]">
          {props.work.missing}
        </p>
        <Show when={props.work.directions.length > 0}>
          <fieldset class="m-0 mt-3 flex flex-col gap-0.5 border-0 p-0">
            <legend class="sr-only">Ways forward</legend>
            <For each={props.work.directions}>
              {(text, i) => (
                <button
                  type="button"
                  data-direction={i() + 1}
                  aria-pressed={props.direction === text}
                  class="flex h-[32px] w-full cursor-default items-center gap-2 rounded-[8px] px-3 text-left hover:bg-fill"
                  classList={{ "bg-selected font-medium": props.direction === text }}
                  onClick={() => props.onChoose(text)}
                >
                  <span class="min-w-0 flex-1 truncate">{text}</span>
                  <kbd class="rounded-[4px] bg-fill px-1.5 font-sans text-[11px] font-normal text-secondary">
                    {i() + 1}
                  </kbd>
                </button>
              )}
            </For>
          </fieldset>
        </Show>
      </div>
      <div class="flex flex-wrap items-center gap-2 pr-4 pb-3 pl-14">
        {props.aside}
        <span class="flex-1" />
        <Show when={props.busy}>
          <span role="status" class="sr-only">
            The agent is writing the draft.
          </span>
        </Show>
        <button
          type="button"
          class={chosen() || props.busy ? pillAgent : pill}
          disabled={props.busy}
          onClick={() => (chosen() ? void props.onWrite() : props.onAnswer())}
        >
          {questionButtonText(props.busy, chosen())}
        </button>
      </div>
    </Proposal>
  );
}
