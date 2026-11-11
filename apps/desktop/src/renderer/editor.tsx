import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { markdown, markdownKeymap } from "@codemirror/lang-markdown";
import { EditorState } from "@codemirror/state";
import { EditorView, keymap, placeholder } from "@codemirror/view";
import { onCleanup, onMount } from "solid-js";
import { acceptSuggestion, liveMarkdown, suggestionsField } from "./liveMarkdown.ts";

export interface EditorApi {
  focus(): void;
  view: EditorView;
}

/**
 * The Markdown editor (CodeMirror 6). It lives in a shadow root: CodeMirror then adds its styles
 * as constructed stylesheets instead of `<style>` elements, which the page's strict
 * `style-src 'self'` would block. The text lives in the editor; `onChange` reports it after
 * every edit. `Mod-Enter` and `Escape` are the composer's, so they never reach the default
 * keymap (which would insert a blank line on `Mod-Enter`).
 */
export function MarkdownEditor(props: {
  initial: string;
  label: string;
  onChange: (text: string) => void;
  onSend: () => void;
  onEscape: () => void;
  ref?: (api: EditorApi) => void;
  /** Takes the focus when it appears; default yes. A composer that starts in To says no. */
  autofocus?: boolean;
  /** What the empty editor says. */
  placeholder?: string;
  /** Grows with the text between these heights instead of filling its box (the reply under a thread). */
  grow?: { min: number; max: string };
}) {
  let host!: HTMLDivElement;
  let view: EditorView | undefined;

  onMount(() => {
    const root = host.attachShadow({ mode: "open" });
    const mount = document.createElement("div");
    // CSSOM, not a style attribute: the policy forbids those.
    if (!props.grow) mount.style.height = "100%";
    root.appendChild(mount);
    view = new EditorView({
      parent: mount,
      state: EditorState.create({
        doc: props.initial,
        selection: { anchor: 0 },
        extensions: [
          history(),
          markdown(),
          liveMarkdown(),
          EditorView.lineWrapping,
          placeholder(props.placeholder ?? "Write your message"),
          EditorView.contentAttributes.of({
            "aria-label": props.label,
            spellcheck: "true",
            lang: "pl",
          }),
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                props.onSend();
                return true;
              },
            },
            {
              // Tab puts in the value the agent found for the first placeholder (ADR 0100).
              key: "Tab",
              run: (v) => {
                const first = v.state.field(suggestionsField)[0];
                return first === undefined ? false : acceptSuggestion(v, first);
              },
            },
            {
              key: "Escape",
              run: () => {
                props.onEscape();
                return true;
              },
            },
            ...markdownKeymap,
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) props.onChange(update.state.doc.toString());
          }),
          EditorView.theme({
            "&": {
              height: props.grow ? "auto" : "100%",
              ...(props.grow
                ? { minHeight: `${props.grow.min}px`, maxHeight: props.grow.max }
                : {}),
              backgroundColor: "transparent",
              color: "var(--ink)",
              userSelect: "text",
            },
            "&.cm-focused": { outline: "none" },
            ".cm-scroller": {
              fontFamily: "var(--font-serif)",
              fontSize: "14px",
              lineHeight: "1.55",
              overflow: "auto",
            },
            ".cm-content": { padding: "12px 4px", caretColor: "var(--ink)" },
            ".cm-line": { padding: "0 2px" },
            ".cm-placeholder": { color: "var(--secondary)" },
            ".cm-cursor": { borderLeftColor: "var(--ink)" },
            ".cm-selectionBackground, &.cm-focused .cm-selectionBackground": {
              backgroundColor: "color-mix(in srgb, var(--ink) 18%, transparent)",
            },
          }),
        ],
      }),
    });
    props.ref?.({ focus: () => view?.focus(), view });
    if (props.autofocus !== false) view.focus();
  });
  onCleanup(() => view?.destroy());

  return (
    <div
      ref={host}
      class="selectable min-h-0"
      classList={{ "h-full": props.grow === undefined }}
      data-editor
    />
  );
}
