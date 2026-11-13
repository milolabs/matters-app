import type { AccountInfo } from "@matters/contracts";
import { describeLargeNotice } from "@matters/core";
import { createEffect, createSignal, For, onCleanup, onMount, Show, untrack } from "solid-js";
import { AgentButton, AgentNote, CheckLine } from "./agentHelp.tsx";
import type { ComposerSession } from "./compose.ts";
import { type EditorApi, MarkdownEditor } from "./editor.tsx";
import { fullDate } from "./format.ts";
import { ChevronDownIcon, CloseIcon, EyeIcon, NarrowIcon } from "./icons.tsx";
import { isAttachShortcut } from "./keys.ts";
import { PreviewFrame } from "./previewFrame.tsx";
import { RecipientField, type Suggestion } from "./recipientField.tsx";
import type { ReplyAgent } from "./replyAgent.ts";
import { FilesButton, FormatBar } from "./replyEditor.tsx";
import { type ReplyNotice, replyNotice } from "./replyNotice.ts";
import { pill, pillPrimary } from "./ui.ts";
import { createAgentHelp } from "./writingHelp.ts";

const SAVE_TEXT = {
  idle: "",
  saving: "Saving…",
  saved: "Draft saved",
  error: "Not saved",
} as const;

/**
 * The composer: To/Cc/Bcc/Subject, the Markdown editor (source, preview or both), the footer
 * with the problems that block Send, and the details (⌘I). `⌘↵` sends; only here.
 */
export function Composer(props: {
  session: ComposerSession;
  /** Whom a message can go out from; with more than one, a new message can choose (ADR 0050). */
  accounts: readonly AccountInfo[];
  showDetails: boolean;
  /** How many files are being dragged over the window; 0 when the browser does not say. */
  dragCount: () => number;
  /**
   * The agent's help (ADR 0098, 0132); absent when AI is off. A message that answers no thread
   * gets the field and the rewrites, without the help that reads a thread.
   */
  agent?: ReplyAgent | undefined;
  /** People the index knows, for To, Cc and Bcc (ADR 0101). */
  suggest?: (prefix: string) => Promise<readonly Suggestion[]>;
  /** The reply's thread is open beside it, so it can go back under it. */
  canGoInline?: boolean;
}) {
  const s = () => props.session;
  const [busy, setBusy] = createSignal(false);
  // What blocks Send is a quiet hint until Send is pressed; then it is red (ADR 0096).
  const [tried, setTried] = createSignal(false);
  let root!: HTMLDivElement;
  let firstField: HTMLInputElement | undefined;
  let editorApi: EditorApi | undefined;

  const hasRecipient = () => s().to().trim() !== "";
  // A reply starts in the text; a new message and a forward start in To.
  const startsInText = s().base.inReplyTo !== "" || hasRecipient();
  onMount(() => {
    if (!startsInText) firstField?.focus();
    // A screenshot or a copied image has no text; then it is a file. Capture, so that the editor
    // (which handles paste itself) does not see it first. A paste with text stays text.
    const onPaste = (e: ClipboardEvent) => {
      const data = e.clipboardData;
      if (!data) return;
      const images = Array.from(data.files).filter((f) => f.type.startsWith("image/"));
      if (images.length === 0 || data.getData("text/plain") !== "") return;
      e.preventDefault();
      e.stopPropagation();
      void s().pasteImages(images);
    };
    root.addEventListener("paste", onPaste, true);
    onCleanup(() => root.removeEventListener("paste", onPaste, true));
  });

  async function send() {
    if (busy()) return;
    setTried(true);
    setBusy(true);
    try {
      await s().send();
    } finally {
      setBusy(false);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.isComposing) return;
    if (isAttachShortcut(e)) {
      e.preventDefault();
      e.stopPropagation();
      void s().pick();
    } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      void send();
    } else if (help.onKey(e)) {
      // ⌘J: the agent's menu, as in the reply under a thread.
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void s().close();
    }
  }
  // The same help as in the reply under a thread (ADR 0098), for a new message too (ADR 0132).
  const help = createAgentHelp({
    session: s,
    view: () => editorApi?.view,
    agent: () => props.agent,
  });
  onMount(() => untrack(() => help.start(s().body())));

  // The first run only reads the view: where the focus starts is `onMount`'s decision (a forward
  // and a new message start in To, ADR 0045 rule 1).
  let viewSeen = false;
  createEffect(() => {
    const view = s().view();
    // The view changes under the keyboard: keep typing where it was.
    if (viewSeen && view !== "preview") queueMicrotask(() => editorApi?.focus());
    viewSeen = true;
  });

  const problems = () => s().problems();
  // What the footer says when nothing blocks Send: a remark about a file, a heavy message, or
  // how the draft is saved. Blockers (a message over the limit among them) come first, in late.
  const status = () => {
    if (s().attachStatus() !== "") return s().attachStatus();
    const notice = s().notice();
    if (notice?.kind === "heavy") return describeLargeNotice(notice);
    return SAVE_TEXT[s().saveState()];
  };

  return (
    <div
      ref={root}
      role="dialog"
      aria-label={s().title}
      data-composer
      class="absolute inset-0 z-10 flex flex-col bg-bg"
      onKeyDown={onKeyDown}
    >
      {/* A quiet top line (ADR 0101): what this is, and the few things to do with the window. */}
      <div class="flex items-center gap-0.5 px-3 pt-2.5 pb-1">
        <h2 class="min-w-0 flex-1 truncate pl-3 text-[13px] font-semibold text-secondary">
          {s().title}
        </h2>
        <button
          type="button"
          data-view="both"
          aria-pressed={s().view() !== "write"}
          title="Preview as it will be sent"
          aria-label="Preview"
          class={topIcon}
          classList={{ "bg-fill text-ink": s().view() !== "write" }}
          onClick={() => s().setView(s().view() === "write" ? "both" : "write")}
        >
          <EyeIcon />
        </button>
        <Show when={s().base.inReplyTo !== "" && props.canGoInline}>
          <button
            type="button"
            title="Back under the thread"
            aria-label="Back under the thread"
            class={topIcon}
            onClick={() => s().setPlacement("inline")}
          >
            <NarrowIcon />
          </button>
        </Show>
        <button
          type="button"
          title="Close (the draft is kept)  Esc"
          aria-label="Close"
          class={topIcon}
          onClick={() => void s().close()}
        >
          <CloseIcon />
        </button>
      </div>

      <div class="flex min-h-0 flex-1 gap-6 overflow-hidden px-6">
        <div class="mx-auto flex min-h-0 w-full max-w-[760px] min-w-0 flex-1 flex-col overflow-y-auto">
          <Show when={replyNotice(s().redirect)}>
            {(notice) => <ReplyNoticeLine notice={notice()} />}
          </Show>
          <For each={s().notices}>{(line) => <ForwardNoticeLine text={line} />}</For>

          <Show
            when={(s().canChangeSender && props.accounts.length > 1) || s().base.inReplyTo === ""}
          >
            <div class="flex min-h-[40px] items-center gap-2 border-b border-hairline text-[13px]">
              <span class="w-[56px] shrink-0 text-secondary">From</span>
              <Show
                when={s().canChangeSender && props.accounts.length > 1}
                fallback={
                  <span class="min-w-0 flex-1 truncate" data-from>
                    {senderLabel(s().sender().from.name, s().sender().from.address)}
                  </span>
                }
              >
                <div class="relative flex min-w-0 flex-1">
                  <select
                    aria-label="From"
                    data-from
                    class="h-[30px] w-full min-w-0 appearance-none truncate rounded-[6px] bg-transparent pr-8 text-[13px] outline-none hover:bg-fill focus-visible:bg-fill"
                    onChange={(e) => {
                      const account = props.accounts.find((a) => a.id === e.currentTarget.value);
                      if (account) void s().setSender(account);
                    }}
                  >
                    <For each={props.accounts}>
                      {(account) => (
                        <option
                          value={account.id}
                          selected={account.id === s().sender().accountId}
                          disabled={!account.canSend}
                        >
                          {senderLabel(account.displayName, account.address)}
                          {account.canSend ? "" : " (no outgoing server)"}
                        </option>
                      )}
                    </For>
                  </select>
                  <span class="pointer-events-none absolute inset-y-0 right-3 flex items-center text-secondary">
                    <ChevronDownIcon />
                  </span>
                </div>
              </Show>
            </div>
          </Show>
          <RecipientField
            label="To"
            name="to"
            value={s().to()}
            onInput={(v) => s().setTo(v)}
            ref={(el) => (firstField = el)}
            {...(props.suggest ? { suggest: props.suggest } : {})}
            end={
              <>
                <Show when={!s().showCc()}>
                  <button
                    type="button"
                    class="h-6 shrink-0 cursor-default rounded-[6px] px-1.5 text-[12px] text-secondary hover:bg-fill hover:text-ink"
                    onClick={() => s().setShowCc(true)}
                  >
                    Cc / Bcc
                  </button>
                </Show>
                <FilesButton session={s()} />
              </>
            }
          />
          <Show when={s().showCc()}>
            <RecipientField
              label="Cc"
              name="cc"
              value={s().cc()}
              onInput={(v) => s().setCc(v)}
              {...(props.suggest ? { suggest: props.suggest } : {})}
            />
            <RecipientField
              label="Bcc"
              name="bcc"
              value={s().bcc()}
              onInput={(v) => s().setBcc(v)}
              {...(props.suggest ? { suggest: props.suggest } : {})}
            />
          </Show>
          <input
            id="compose-subject"
            type="text"
            autocomplete="off"
            spellcheck
            aria-label="Subject"
            placeholder="Subject"
            value={s().subject()}
            class="selectable mt-3 h-9 w-full shrink-0 bg-transparent font-serif text-[22px] leading-[1.25] font-semibold tracking-[-0.01em] outline-none placeholder:text-edge"
            onInput={(e) => s().setSubject(e.currentTarget.value)}
            onKeyDown={(e) => {
              // From the subject, ↵ goes on to the text, as in a mail client.
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                editorApi?.focus();
              }
            }}
          />

          <div class="sticky top-0 z-10 mt-2 bg-bg">
            <FormatBar view={() => editorApi?.view}>
              <AgentButton help={help} />
            </FormatBar>
            <AgentNote help={help} />
          </div>
          <div class="flex-1 pt-1 pb-6">
            <MarkdownEditor
              grow={{ min: 260, max: "none" }}
              initial={untrack(() => s().body())}
              label="Message"
              placeholder={s().base.inReplyTo !== "" ? "Write your reply" : "Write your message"}
              autofocus={startsInText}
              ref={(api) => (editorApi = api)}
              onChange={(text) => {
                s().setBody(text);
                help.bodyChanged(text);
              }}
              onSend={() => void send()}
              onEscape={() => void s().close()}
            />
          </div>
        </div>
        <Show when={s().view() !== "write"}>
          <div class="flex min-h-0 w-[min(46%,640px)] shrink-0 flex-col py-2" data-preview>
            <p class="m-0 pb-2 text-[11px] text-secondary">As it will be sent</p>
            <div class="min-h-0 flex-1">
              <PreviewFrame html={s().previewHtml()} />
            </div>
          </div>
        </Show>
      </div>

      <Show when={props.showDetails}>
        <Details session={s()} />
      </Show>

      <div class="border-t border-hairline px-6">
        <div class="mx-auto flex w-full max-w-[760px] items-center gap-3 py-3">
          <div class="min-w-0 flex-1 text-[12.5px]" role="status" aria-live="polite">
            <Show
              when={s().error() !== "" || problems().length > 0 || help.problem() !== ""}
              fallback={
                <Show
                  when={help.check() !== null && status() === SAVE_TEXT.saved}
                  fallback={
                    <span class="text-secondary" data-status>
                      {status() || "The draft saves itself"}
                    </span>
                  }
                >
                  <CheckLine check={help.check()} onAnswer={() => void help.run("answer")} />
                </Show>
              }
            >
              <span
                data-problem
                classList={{
                  "text-late": s().error() !== "" || tried(),
                  "text-secondary": s().error() === "" && !tried(),
                }}
              >
                {s().error() !== ""
                  ? s().error()
                  : help.problem() !== ""
                    ? help.problem()
                    : problems()
                        // Some end a sentence and some are a file's state: each is read as its own.
                        .map((problem) => (/[.!?]$/.test(problem) ? problem : `${problem}.`))
                        .join(" ")}
              </span>
            </Show>
          </div>
          <button type="button" class={pill} onClick={() => void s().discard()}>
            Discard
          </button>
          <button
            type="button"
            class={pillPrimary}
            data-send
            disabled={busy()}
            aria-disabled={problems().length > 0}
            classList={{ "opacity-60": problems().length > 0 && !busy() }}
            title="Send (⌘↵)"
            onClick={() => void send()}
          >
            Send
            <span class="ml-2 text-[11px] font-normal opacity-60">⌘↵</span>
          </button>
        </div>
      </div>

      {/* Always here, shown by one class on the body: dragging changes no layout (ADR 0041, rule 21). */}
      <div data-drop-hint aria-hidden="true" class="drop-hint absolute inset-0 z-20">
        <div class="drop-frame">
          <p class="m-0 font-serif text-[22px]">
            {props.dragCount() > 0
              ? `Attach ${props.dragCount()} ${props.dragCount() === 1 ? "file" : "files"}`
              : "Attach files"}
          </p>
          <p class="m-0 text-[13px] text-secondary">
            {s().base.inReplyTo !== "" ? "to this reply" : "to this message"}
          </p>
        </div>
      </div>
    </div>
  );
}

const topIcon =
  "grid size-[30px] cursor-default place-items-center rounded-[7px] text-secondary hover:bg-fill hover:text-ink";

const senderLabel = (name: string | undefined, address: string) =>
  name && name !== address ? `${name} <${address}>` : address;

/**
 * Where a new reply goes when that is not who sent the message (ADR 0042, rule 5). Everything
 * is text, never markup. A long address truncates inside its own box, so the rest of the line,
 * the warning among it, stays readable; a screen reader hears the sentence whole.
 */
function ReplyNoticeLine(props: { notice: ReplyNotice }) {
  const warn = () => props.notice.warning !== null;
  return (
    <p
      role="note"
      data-reply-notice
      class="m-0 text-[12px] leading-[18px] [overflow-wrap:anywhere]"
      classList={{ "text-secondary": !warn(), "text-late": warn() }}
    >
      Replies go to{" "}
      <strong
        class="inline-block max-w-full truncate align-bottom font-semibold"
        classList={{ "text-mid": !warn() }}
        title={props.notice.to}
      >
        {props.notice.to}
      </strong>
      {props.notice.rest}
      <Show when={props.notice.warning}>{(text) => <> {text()}</>}</Show>
    </p>
  );
}

/** What a forward leaves behind (ADR 0045, rules 11 and 12): one quiet line each, plain text. */
function ForwardNoticeLine(props: { text: string }) {
  return (
    <p
      role="note"
      data-forward-notice
      class="m-0 text-[12px] leading-[18px] text-secondary [overflow-wrap:anywhere]"
    >
      {props.text}
    </p>
  );
}

/** ⌘I: where this stands, in facts: version, thread, what the approval says. */
function Details(props: { session: ComposerSession }) {
  const s = () => props.session;
  const approval = () => {
    const op = s().operation();
    if (!op) return "Not approved: nothing has been sent from this draft.";
    const a = op.approval;
    const when = fullDate(a.approvedAtMs);
    switch (op.state.kind) {
      case "pending":
        return `Approved version ${a.version} at ${when}; it goes out when the undo window ends.`;
      case "held":
        return `Approved version ${a.version} at ${when}; held because the window ended while the app was closed.`;
      case "voided":
        return `Approval of version ${a.version} no longer holds: ${op.state.reason}`;
      default:
        return `Approved version ${a.version} at ${when}; state: ${op.state.kind}.`;
    }
  };
  return (
    <div
      data-details
      class="selectable mx-5 mb-2 flex flex-col gap-0.5 rounded-[9px] bg-fill px-3 py-2 text-[12px] text-secondary"
    >
      <span>
        Version {s().draft()?.version ?? 0} ·{" "}
        {s().draft() ? `fingerprint ${s().draft()?.fingerprint.slice(0, 12)}` : "not saved yet"}
      </span>
      <span>
        Thread:{" "}
        {s().base.threadId
          ? `${s().base.subject || "(no subject)"} · answers ${s().base.inReplyTo}`
          : "none, a new conversation"}
      </span>
      <span>{approval()}</span>
    </div>
  );
}
