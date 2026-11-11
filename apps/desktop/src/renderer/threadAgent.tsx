import type { ThreadMessage } from "@matters/contracts";
import { type OpenPart, openSummary, type PreparedWork } from "@matters/core";
import { createMemo, For, Show } from "solid-js";
import type { AgentStore } from "./agent.ts";
import { AgentRing, DraftFrame, QuestionFrame } from "./agentLayer.tsx";
import { askTheAgent } from "./agentTalk.tsx";
import { splitYours, writtenByLine } from "./mattersView.ts";
import { replyPromptName } from "./replyPrompt.ts";
import type { ThreadAgentStore } from "./threadAgent.ts";
import { pill, toolButton } from "./ui.ts";

// The agent in an ordinary thread (ADR 0063). It shows only where the agent can be asked here, and
// everything it shows is the agent's: the dashed edge, the agent colour and the open ring. Model
// text is shown as text nodes only.

const PANEL = "data-thread-agent-panel";

/**
 * Scrolls to the agent's draft or question under the letters. In Matters the frame is the one of
 * the open thing. It starts nothing.
 */
export function goToAgentPanel(): void {
  const frame =
    document.querySelector<HTMLElement>(`[${PANEL}]`) ??
    document.querySelector<HTMLElement>("[data-proposal]");
  frame?.scrollIntoView({ block: "center", behavior: "smooth" });
}

/**
 * Whether the draft's Send button is on screen in `reader`. The panel sits under the letters, so a
 * draft made ahead can be out of sight, and a key must never send what the person has not seen.
 */
export function agentSendInView(reader: HTMLElement): boolean {
  const send = document.querySelector<HTMLElement>(`[${PANEL}] [data-send-agent]`);
  if (send === null) return false;
  const button = send.getBoundingClientRect();
  const view = reader.getBoundingClientRect();
  return button.top >= view.top && button.bottom <= view.bottom;
}

/** The header button, next to Reply and Reply all. It focuses the prompt; it spends nothing. */
export function AgentHeaderButton(props: { onPress: () => void }) {
  return (
    <button
      type="button"
      aria-label="Ask the agent"
      title="Ask the agent  g"
      class={toolButton}
      onClick={() => props.onPress()}
    >
      <AgentRing size={15} />
    </button>
  );
}

/** What the strip and the panel hold, in words the person can read at a glance. */
function stripText(
  reading: { readonly headline: string } | null,
  work: PreparedWork | null,
): string {
  if (reading !== null) return `Agent: ${reading.headline}`;
  return work?.kind === "needs" ? "Agent: a question is waiting" : "Agent: a draft is ready";
}

/** The headline ends as a sentence before "Still open:" follows it. */
export function endSentence(text: string): string {
  return /[.!?…]$/.test(text.trimEnd()) ? text : `${text.trimEnd()}.`;
}

function stripButton(work: PreparedWork | null): string {
  if (work === null) return "Ask";
  return work.kind === "needs" ? "See question" : "See draft";
}

/** The top line under the thread header: what the agent read, and the way to the panel. */
export function AgentStrip(props: { ta: ThreadAgentStore }) {
  const { ta } = props;
  // What is still open, from the reading's facts (ADR 0075). Read once per set of facts.
  const open = createMemo(() =>
    ta.reading() === null
      ? []
      : openSummary(ta.facts(), Date.now(), Intl.DateTimeFormat().resolvedOptions().timeZone),
  );
  return (
    <Show when={ta.available() && (ta.reading() !== null || ta.prepared() !== null)}>
      <div
        data-thread-agent-strip
        class="mb-3 grid grid-cols-[28px_minmax(0,1fr)_auto] items-center gap-x-3 rounded-[12px] border-[1.5px] border-dashed border-agent-edge bg-agent-soft px-4 py-3 text-[13px] leading-[1.5] text-agent"
      >
        <span class="flex items-center justify-center">
          <AgentRing />
        </span>
        <span class="min-w-0 [overflow-wrap:anywhere]">
          {open().length > 0
            ? endSentence(stripText(ta.reading(), ta.prepared()))
            : stripText(ta.reading(), ta.prepared())}
          <Show when={open().length > 0}>
            <span data-still-open>
              {" "}
              Still open: <StillOpen parts={open()} />
            </span>
          </Show>
        </span>
        <button
          type="button"
          class="shrink-0 cursor-default rounded-[8px] bg-button px-3 text-[12px] leading-[18px] text-ink"
          onClick={() => (ta.prepared() === null ? askTheAgent() : goToAgentPanel())}
        >
          {stripButton(ta.prepared())}
        </button>
      </div>
    </Show>
  );
}

/** The parts joined by " and "; the late ones wear the late colour. */
function StillOpen(props: { parts: readonly OpenPart[] }) {
  return (
    <For each={props.parts}>
      {(part, i) => (
        <>
          {i() > 0 ? " and " : ""}
          <span classList={{ "text-late": part.late }}>{part.text}</span>
        </>
      )}
    </For>
  );
}

/** Between the letters and the reply prompt: the draft or the question the agent made. */
export function AgentPanel(props: {
  ta: ThreadAgentStore;
  agent: AgentStore;
  threadId: string;
  own: ReadonlySet<string>;
  messages: readonly ThreadMessage[];
}) {
  const { ta, agent } = props;
  return (
    <Show when={ta.available() && (ta.prepared() !== null || ta.problem() !== "")}>
      <div data-thread-agent-panel class="mt-3 scroll-mb-6">
        <Show when={ta.prepared()}>
          {(work) => (
            <Show
              when={work().kind === "draft"}
              fallback={
                <Question
                  ta={ta}
                  agent={agent}
                  threadId={props.threadId}
                  work={work() as Extract<PreparedWork, { kind: "needs" }>}
                />
              }
            >
              <Draft
                ta={ta}
                agent={agent}
                threadId={props.threadId}
                own={props.own}
                messages={props.messages}
                body={(work() as Extract<PreparedWork, { kind: "draft" }>).body}
              />
            </Show>
          )}
        </Show>
        <Show when={ta.problem() !== ""}>
          <p role="alert" class="mt-3 text-[13px] text-late">
            {ta.problem()}
          </p>
        </Show>
      </div>
    </Show>
  );
}

function Dismiss(props: { ta: ThreadAgentStore }) {
  return (
    <button
      type="button"
      class={pill}
      title="Stop showing this here. It tells the agent nothing"
      onClick={() => props.ta.dismiss()}
    >
      Dismiss
    </button>
  );
}

function Draft(props: {
  ta: ThreadAgentStore;
  agent: AgentStore;
  threadId: string;
  own: ReadonlySet<string>;
  messages: readonly ThreadMessage[];
  body: string;
}) {
  const { ta, agent } = props;
  const pieces = createMemo(() => splitYours(props.body, agent.givenFor(props.threadId)));
  const by = () =>
    writtenByLine(
      agent.status()?.runtime ?? null,
      agent.status()?.settings.models ?? {
        understand: "",
        draftAhead: "",
        write: "",
        answer: "",
        titles: "",
      },
      agent.askedFor(props.threadId),
    );
  return (
    <DraftFrame
      to={replyPromptName(props.messages, props.own)}
      pieces={pieces()}
      read={`Read the ${props.messages.length === 1 ? "1 message" : `${props.messages.length} messages`} in this thread. Nothing else.`}
      by={by()}
      busy={ta.busy()}
      aside={<Dismiss ta={ta} />}
      onEdit={() => void ta.editMyself()}
      onSend={() => void ta.send()}
    />
  );
}

function Question(props: {
  ta: ThreadAgentStore;
  agent: AgentStore;
  threadId: string;
  work: Extract<PreparedWork, { kind: "needs" }>;
}) {
  const { ta, agent } = props;
  const by = () =>
    writtenByLine(
      agent.status()?.runtime ?? null,
      agent.status()?.settings.models ?? {
        understand: "",
        draftAhead: "",
        write: "",
        answer: "",
        titles: "",
      },
      false,
    );
  return (
    <QuestionFrame
      work={props.work}
      direction={agent.directionOf(props.threadId)}
      by={by()}
      busy={ta.busy()}
      aside={<Dismiss ta={ta} />}
      onChoose={(text) => agent.chooseDirection(props.threadId, text)}
      onWrite={() => ta.ask(undefined, agent.directionOf(props.threadId))}
      onAnswer={askTheAgent}
    />
  );
}
