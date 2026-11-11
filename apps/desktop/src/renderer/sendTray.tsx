import type { SendOperation } from "@matters/core";
import { createMemo, createSignal, For, Show, untrack } from "solid-js";
import type { AgentStore } from "./agent.ts";
import { fullDate } from "./format.ts";
import { describeLine, type MoveLine, type MovesStore } from "./moves.ts";
import type { OutboxStore } from "./outbox.ts";
import { SendDot } from "./sendDot.tsx";
import { describeSend, type SendActionId } from "./sendView.ts";
import { pill } from "./ui.ts";

/**
 * One line per send in progress, under the lists: what it is doing and what the user can do. Moves
 * (ADR 0044) are lines of the same tray, with the same dot draining over the undo window; they are
 * the only feedback of a move in a view where the row stays.
 */
export function SendTray(props: {
  outbox: OutboxStore;
  moves: MovesStore;
  onUndoMove: (line: MoveLine) => void;
  showDetails: boolean;
  /** "Open draft": the composer on that draft, with its files. */
  onOpenDraft: (draftId: string) => void;
  /** The line for `Not important` and `Later`, with its Undo (ADR 0052, rule 9). */
  agent?: AgentStore;
}) {
  const { outbox, moves } = props;
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  const shown = () => outbox.operations().filter((o) => !dismissed().has(o.id));
  const dismiss = (id: string) => setDismissed((d) => new Set(d).add(id));

  const bad = () => /^(Couldn't|Too late)/.test(moves.notice());

  return (
    <>
      {/* Always there, so what it is told is read out whatever the tray looks like. */}
      <div class="sr-only" role="status" aria-live="polite" data-announce>
        {moves.announcement()}
      </div>
      <Show
        when={
          shown().length > 0 ||
          outbox.problem() !== "" ||
          moves.pending().length > 0 ||
          moves.notice() !== "" ||
          props.agent?.line() != null
        }
      >
        <section
          aria-label="Sends and moves"
          data-tray
          class="flex flex-col gap-1 border-t border-hairline bg-bg px-3.5 py-2"
        >
          <For each={moves.pending()}>
            {(line) => <MoveRow line={line} moves={moves} onUndo={props.onUndoMove} />}
          </For>
          <Show when={props.agent?.line()}>
            {(line) => (
              <div data-agent-line class="flex items-center gap-3 text-[13px]">
                {/* Plain text only: a reason comes from a model. A long one is cut, and shown whole on hover. */}
                <span class="min-w-0 flex-1 truncate" title={line().text}>
                  <span class="font-semibold" data-line>
                    {line().text}
                  </span>
                  <Show when={line().headline !== ""}>
                    <span class="text-secondary"> · {line().headline}</span>
                  </Show>
                </span>
                {/* One click for a wider rule. The address is plain text and is cut when long, so Undo stays in view. */}
                <Show when={line().offer}>
                  {(offer) => (
                    <button
                      type="button"
                      class={`${pill} min-w-0 max-w-[45%] shrink truncate`}
                      data-rule-offer
                      title={
                        offer().scope === "domain"
                          ? `Everything from ${offer().subject}`
                          : `Always for ${offer().subject}`
                      }
                      onClick={() => void props.agent?.addRuleFromLine()}
                    >
                      {offer().scope === "domain" ? "Everything from" : "Always for"}{" "}
                      {offer().subject}
                    </button>
                  )}
                </Show>
                <span class="sr-only" role="status">
                  {line().text}
                </span>
                <button
                  type="button"
                  class={pill}
                  data-undo
                  onClick={() => void props.agent?.undoFeedback()}
                >
                  Undo
                </button>
              </div>
            )}
          </Show>
          <For each={shown()}>
            {(op) => (
              <Line
                op={op}
                outbox={outbox}
                dismiss={dismiss}
                details={props.showDetails}
                onOpenDraft={props.onOpenDraft}
              />
            )}
          </For>
          <Show when={outbox.problem() !== ""}>
            <p class="text-[12.5px] text-late" role="alert">
              {outbox.problem()}
            </p>
          </Show>
          <Show when={moves.notice() !== ""}>
            <div class="flex items-center gap-3 text-[12.5px]" data-notice>
              <span
                class="min-w-0 flex-1 truncate"
                classList={{ "text-late": bad(), "text-secondary": !bad() }}
              >
                {moves.notice()}
              </span>
              <button type="button" class={pill} onClick={() => moves.dismissNotice()}>
                Dismiss
              </button>
            </div>
          </Show>
        </section>
      </Show>
    </>
  );
}

/** A move in its undo window: the draining dot, what was done, and Undo with the seconds left. */
function MoveRow(props: { line: MoveLine; moves: MovesStore; onUndo: (line: MoveLine) => void }) {
  const seconds = () => props.moves.secondsLeft(props.line);
  const view = createMemo(() => describeLine(props.line, seconds()));
  return (
    <div data-move={props.line.id} class="flex items-center gap-3 text-[13px]">
      <SendDot
        kind="drain"
        small={false}
        operationId={props.line.id}
        notBeforeMs={props.line.notBeforeMs}
      />
      <span class="min-w-0 flex-1 truncate">
        <span class="font-semibold" data-line>
          {view().line}
        </span>
        <Show when={props.line.subject}>
          <span class="text-secondary"> · {props.line.subject}</span>
        </Show>
      </span>
      <Show when={view().actions.includes("undo")}>
        <button type="button" class={pill} data-undo onClick={() => props.onUndo(props.line)}>
          {seconds() > 0 ? `Undo · ${seconds()} s` : "Undo"}
        </button>
      </Show>
    </div>
  );
}

function Line(props: {
  op: SendOperation;
  outbox: OutboxStore;
  dismiss: (id: string) => void;
  details: boolean;
  onOpenDraft: (draftId: string) => void;
}) {
  const { outbox } = props;
  const op = () => props.op;
  const act = (action: Parameters<OutboxStore["act"]>[1]) => void outbox.act(op().id, action);
  const state = () => op().state;
  const seconds = () => outbox.secondsLeft(op());
  const view = createMemo(() =>
    describeSend(op(), { secondsLeft: seconds(), reading: outbox.readingFiles(op().draftId) }),
  );
  let live: HTMLSpanElement | undefined;

  // There is no list of drafts: a message taken back would otherwise be out of reach for good, with
  // its files still on disk. Taking it back means going on with it (ADR 0041, rule 14).
  const takeBack = (how: "undo" | "stop") => {
    const { id, draftId } = op();
    const asked =
      how === "undo"
        ? outbox.undo(id).then((result) => result === "cancelled")
        : outbox.act(id, "stop");
    void asked.then((done) => {
      if (done) props.onOpenDraft(draftId);
    });
  };

  const button = (id: SendActionId) => {
    switch (id) {
      case "undo":
        return (
          <button type="button" class={pill} data-undo onClick={() => takeBack("undo")}>
            {seconds() > 0 ? `Undo · ${seconds()} s` : "Undo"}
          </button>
        );
      case "stop":
        return (
          <button type="button" class={pill} data-stop onClick={() => takeBack("stop")}>
            Stop
          </button>
        );
      case "retryNow":
        return (
          <button type="button" class={pill} onClick={() => act("retry")}>
            Retry now
          </button>
        );
      case "retry":
        return (
          <button type="button" class={pill} onClick={() => act("retry")}>
            Retry
          </button>
        );
      case "openDraft":
        return (
          <button
            type="button"
            class={pill}
            data-open-draft
            onClick={() => {
              props.onOpenDraft(op().draftId);
              props.dismiss(op().id);
            }}
          >
            Open draft
          </button>
        );
      case "discard":
        return (
          <button type="button" class={pill} onClick={() => act("discard")}>
            Discard
          </button>
        );
      case "sendNow":
        return (
          <button type="button" class={pill} onClick={() => act("sendNow")}>
            Send now
          </button>
        );
      case "sendAgain":
        return (
          <button type="button" class={pill} onClick={() => act("sendAgain")}>
            Send again
          </button>
        );
      case "markSent":
        return (
          <button type="button" class={pill} onClick={() => act("markSent")}>
            Mark as sent
          </button>
        );
      case "dismiss":
        return (
          <button type="button" class={pill} onClick={() => props.dismiss(op().id)}>
            Dismiss
          </button>
        );
    }
  };

  return (
    <div data-op={op().id} data-state={state().kind} class="flex flex-col gap-0.5">
      <div class="flex items-center gap-3 text-[13px]">
        <SendDot
          kind={view().dot}
          small={view().small}
          operationId={op().id}
          notBeforeMs={op().notBeforeMs}
          text={() => live}
        />
        <span class="min-w-0 flex-1 truncate">
          <span class="font-semibold" classList={{ "text-late": view().bad }} data-line>
            {view().line}
          </span>
          <Show when={view().live !== null}>
            {/* Static text on purpose: progress rewrites it, and no signal ever does. */}
            <span ref={live} class="ml-1 text-secondary tabular-nums" data-bytes>
              {untrack(() => view().live)}
            </span>
          </Show>
          <span class="text-secondary"> · {op().summary}</span>
        </span>
        {/* The one thing a screen reader is told: the state, never the bytes. */}
        <span class="sr-only" role="status" aria-live="polite">
          {view().announce}
        </span>
        <For each={view().actions}>{(id) => button(id)}</For>
      </div>
      <Show when={view().reason !== ""}>
        <p
          class="pl-[18px] text-[12px]"
          classList={{ "text-late": view().bad, "text-secondary": !view().bad }}
        >
          {view().reason}
        </p>
      </Show>
      <Show when={props.details}>
        <p class="selectable pl-[18px] text-[11.5px] text-secondary" data-op-details>
          Draft version {op().approval.version} · approved {fullDate(op().approval.approvedAtMs)} ·
          attempts {op().attempts}
          {op().messageId ? ` · ${op().messageId}` : ""}
        </p>
      </Show>
    </div>
  );
}
