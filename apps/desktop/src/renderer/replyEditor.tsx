import type { EditorView } from "@codemirror/view";
import { parseRecipients } from "@matters/core";
import { createSignal, Index, type JSX, onCleanup, onMount, Show, untrack } from "solid-js";
import { AgentButton, AgentNote, CheckLine } from "./agentHelp.tsx";
import { ChipView } from "./attachmentStrip.tsx";
import type { ComposerSession } from "./compose.ts";
import { type EditorApi, MarkdownEditor } from "./editor.tsx";
import { megabytes } from "./format.ts";
import { PaperclipIcon, WidenIcon } from "./icons.tsx";
import { isAttachShortcut } from "./keys.ts";
import { clearFormatting, insertLink, toggleInline, toggleLinePrefix } from "./liveMarkdown.ts";
import type { ReplyAgent } from "./replyAgent.ts";
import { pill, pillPrimary } from "./ui.ts";
import { createAgentHelp } from "./writingHelp.ts";

/**
 * A reply written under its thread (ADR 0100): one bordered box, because it is the one place to
 * type. "To" on one quiet line with the files beside it, the formatting bar, the text (live
 * Markdown, the quote folded to "···"), and Send. ⤢ moves the same draft into the full composer.
 */
export function ReplyEditor(props: {
  session: ComposerSession;
  /** How many files are being dragged over the window; 0 when the browser does not say. */
  dragCount: () => number;
  /** The agent's help; absent when AI is off or not set up. */
  agent?: ReplyAgent | undefined;
}) {
  const s = () => props.session;
  const [busy, setBusy] = createSignal(false);
  const [tried, setTried] = createSignal(false);
  let root!: HTMLDivElement;
  let api: EditorApi | undefined;
  const view = (): EditorView | undefined => api?.view;

  onMount(() => {
    root.scrollIntoView({ block: "nearest" });
    // A screenshot or a copied image has no text; then it is a file (as in the full composer).
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
      // ⌘J: the agent's menu.
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      void s().close();
    }
    // Everything else typed here stays here: the mail window's shortcuts are single letters.
    e.stopPropagation();
  }

  const problems = () => s().problems();
  // Each recipient by name, or by address when it has none; a piece that is no address yet shows
  // what stands before its `<`.
  const names = () => {
    const { participants, invalid } = parseRecipients(s().to());
    return [
      ...participants.map((p) => p.name ?? p.address),
      ...invalid.map((p) => (p.split("<")[0] ?? "").trim()),
    ]
      .filter((p) => p !== "")
      .join(", ");
  };

  // The agent's help (ADR 0098), shared with the full composer.
  const help = createAgentHelp({ session: s, view, agent: () => props.agent });
  function bodyChanged(text: string) {
    s().setBody(text);
    help.bodyChanged(text);
  }
  onMount(() => untrack(() => help.start(s().body())));

  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring a legend and its layout
    <div
      ref={root}
      role="group"
      aria-label={s().title}
      data-composer
      data-inline
      class="relative mt-3 flex flex-col rounded-[10px] border border-edge bg-bg shadow-[0_1px_2px_rgba(0,0,0,0.08)] focus-within:border-secondary"
      onKeyDown={onKeyDown}
    >
      <div class="flex min-w-0 items-center gap-2 pt-0.5 pr-1 pl-4 text-[12px] text-secondary">
        <span class="min-w-0 truncate">
          To <span class="font-medium text-ink">{names() || "nobody yet"}</span>
        </span>
        <span class="flex-1" />
        <FilesButton session={s()} />
        <button
          type="button"
          class={toolIcon}
          title="Open the full composer: Cc, subject, preview"
          aria-label="Open the full composer"
          onClick={() => s().setPlacement("full")}
        >
          <WidenIcon />
        </button>
      </div>

      <FormatBar view={view}>
        <AgentButton help={help} />
      </FormatBar>

      <AgentNote help={help} />

      <div class="px-3">
        <MarkdownEditor
          grow={{ min: 150, max: "60vh" }}
          initial={untrack(() => s().body())}
          label="Reply"
          placeholder="Write your reply"
          ref={(a) => (api = a)}
          onChange={bodyChanged}
          onSend={() => void send()}
          onEscape={() => void s().close()}
        />
      </div>

      <div class="flex flex-wrap items-center gap-2 border-t border-hairline py-2 pr-2 pl-4">
        <div class="min-w-0 flex-1 text-[12px]" role="status" aria-live="polite">
          <Show
            when={s().error() !== "" || problems().length > 0 || help.problem() !== ""}
            fallback={<CheckLine check={help.check()} onAnswer={() => void help.run("answer")} />}
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
                      .map((p) => (/[.!?]$/.test(p) ? p : `${p}.`))
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

      {/* Shown by one class on the body while files are dragged: nothing moves (ADR 0041, rule 21). */}
      <div data-drop-hint aria-hidden="true" class="drop-hint absolute inset-0 z-20 rounded-[10px]">
        <div class="drop-frame">
          <p class="m-0 font-serif text-[17px]">
            {props.dragCount() > 0
              ? `Attach ${props.dragCount()} ${props.dragCount() === 1 ? "file" : "files"}`
              : "Attach files"}
          </p>
          <p class="m-0 text-[12px] text-secondary">to this reply</p>
        </div>
      </div>
    </div>
  );
}

const toolIcon =
  "grid size-[28px] cursor-default place-items-center rounded-[6px] text-secondary hover:bg-fill hover:text-ink";

/**
 * The formatting bar: what a mail needs and no more. Each button writes Markdown, which the editor
 * shows formatted; the text stays the draft the send reads (ADR 0100).
 */
export function FormatBar(props: { view: () => EditorView | undefined; children?: JSX.Element }) {
  const act = (run: (v: EditorView) => boolean) => () => {
    const v = props.view();
    if (v) run(v);
  };
  const button = (
    label: string,
    title: string,
    run: (v: EditorView) => boolean,
    body: JSX.Element,
  ) => (
    <button
      type="button"
      aria-label={label}
      title={title}
      class="grid h-[26px] min-w-[28px] cursor-default place-items-center rounded-[6px] px-1.5 text-[13px] text-mid hover:bg-fill hover:text-ink"
      // The press must not take the selection away from the text it formats.
      onMouseDown={(e) => e.preventDefault()}
      onClick={act(run)}
    >
      {body}
    </button>
  );
  const sep = () => <span aria-hidden="true" class="mx-1 h-4 w-px bg-hairline" />;
  return (
    <div
      role="toolbar"
      aria-label="Formatting"
      class="flex flex-wrap items-center gap-0.5 border-y border-hairline bg-chrome px-2 py-1 mt-0.5"
    >
      {button("Bold", "Bold  ⌘B", (v) => toggleInline(v, "**"), <b>B</b>)}
      {button("Italic", "Italic  ⌘I", (v) => toggleInline(v, "*"), <i class="font-serif">I</i>)}
      {button("Strikethrough", "Strikethrough", (v) => toggleInline(v, "~~"), <s>S</s>)}
      {sep()}
      {button(
        "Bulleted list",
        "Bulleted list",
        (v) => toggleLinePrefix(v, "bullet"),
        <ListGlyph />,
      )}
      {button(
        "Numbered list",
        "Numbered list",
        (v) => toggleLinePrefix(v, "number"),
        <NumberGlyph />,
      )}
      {button("Quote", "Quote", (v) => toggleLinePrefix(v, "quote"), <QuoteGlyph />)}
      {sep()}
      {button("Link", "Link  ⌘K", insertLink, <LinkGlyph />)}
      {button("Clear formatting", "Clear formatting", clearFormatting, <ClearGlyph />)}
      <span class="flex-1" />
      {props.children}
    </div>
  );
}

/**
 * The files, as part of the message's header (ADR 0100): how many and how heavy, beside "To". A
 * press opens the list in a popover with its own scroll, so no number of files moves the text.
 */
export function FilesButton(props: { session: ComposerSession }) {
  const s = () => props.session;
  const [open, setOpen] = createSignal(false);
  let box!: HTMLSpanElement;
  const count = () => s().attachments().length;
  const total = () =>
    s()
      .attachments()
      .reduce((n, c) => n + c.size, 0);
  const over = () => s().notice()?.kind === "tooLarge";
  onMount(() => {
    const outside = (e: MouseEvent) => {
      if (open() && !box.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", outside, true);
    onCleanup(() => document.removeEventListener("mousedown", outside, true));
  });
  return (
    <span ref={box} class="relative">
      <Show
        when={count() > 0}
        fallback={
          <button
            type="button"
            class={toolIcon}
            title="Attach files  ⇧⌘A"
            aria-label="Attach files"
            onClick={() => void s().pick()}
          >
            <PaperclipIcon />
          </button>
        }
      >
        <button
          type="button"
          data-files
          aria-haspopup="dialog"
          aria-expanded={open()}
          class="inline-flex h-6 cursor-default items-center gap-1 rounded-[6px] px-1.5 text-[12px] whitespace-nowrap hover:bg-fill hover:text-ink aria-expanded:bg-fill aria-expanded:text-ink"
          classList={{ "text-late": over(), "text-secondary": !over() }}
          onClick={() => setOpen(!open())}
        >
          <PaperclipIcon />
          {count()} {count() === 1 ? "file" : "files"}, {megabytes(total())}
        </button>
      </Show>
      <Show when={open() && count() > 0}>
        <div
          role="dialog"
          aria-label="Attachments"
          class="absolute top-[30px] right-0 z-30 flex w-[340px] max-w-[80vw] flex-col rounded-[10px] border border-hairline bg-chrome shadow-(--pop)"
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <div class="flex flex-col gap-px border-b border-hairline px-3 pt-2.5 pb-2 text-[11px] text-secondary">
            <b class="text-[13px] font-semibold text-ink">
              {count()} {count() === 1 ? "file" : "files"}
            </b>
            <span class="[overflow-wrap:anywhere]" classList={{ "text-late": over() }}>
              {s().notice()?.kind === "tooLarge"
                ? "Over what your server takes: remove some, or send them as a link."
                : megabytes(total())}
            </span>
          </div>
          <ul class="m-0 flex max-h-[240px] list-none flex-col items-start gap-1 overflow-y-auto px-2 py-2">
            <Index each={s().attachments()}>
              {(chip) => <ChipView chip={chip()} session={s()} />}
            </Index>
          </ul>
          <div class="flex justify-between gap-2 border-t border-hairline px-2 py-1.5">
            <button type="button" class={popButton} onClick={() => void s().pick()}>
              Add files…
            </button>
            <button
              type="button"
              class={`${popButton} hover:text-late`}
              onClick={() => {
                for (const c of [...s().attachments()]) s().removeAttachment(c.id);
                setOpen(false);
              }}
            >
              Remove all
            </button>
          </div>
        </div>
      </Show>
      <span class="sr-only" role="status" aria-live="polite">
        {s().announcement()}
      </span>
    </span>
  );
}

const popButton =
  "h-6 cursor-default rounded-[6px] px-2 text-[12px] whitespace-nowrap text-mid hover:bg-fill";

const glyph = (children: JSX.Element) => (
  <svg
    viewBox="0 0 16 16"
    width="15"
    height="15"
    fill="none"
    stroke="currentColor"
    stroke-width="1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    {children}
  </svg>
);
const ListGlyph = () =>
  glyph(
    <>
      <circle cx="3" cy="4.5" r=".8" />
      <circle cx="3" cy="8" r=".8" />
      <circle cx="3" cy="11.5" r=".8" />
      <path d="M6 4.5h8M6 8h8M6 11.5h8" />
    </>,
  );
const NumberGlyph = () =>
  glyph(
    <path d="M2.5 3.5h1v3M2.3 6.5h1.6M2.4 9.6c.3-.5 1.6-.6 1.6.2 0 .7-1.6 1.3-1.6 2h1.6M6.5 4.5h7.5M6.5 8h7.5M6.5 11.5h7.5" />,
  );
const QuoteGlyph = () => glyph(<path d="M3 3v10M6 5h8M6 8h8M6 11h5" />);
const LinkGlyph = () =>
  glyph(
    <path d="M7 9a3 3 0 0 0 4.2 0l2-2a3 3 0 0 0-4.2-4.2l-.8.8M9 7a3 3 0 0 0-4.2 0l-2 2a3 3 0 0 0 4.2 4.2l.8-.8" />,
  );
const ClearGlyph = () => glyph(<path d="M3 3h8M7 3 5.5 13M10 9l4 4M14 9l-4 4" />);
