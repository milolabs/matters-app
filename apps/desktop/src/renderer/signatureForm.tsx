import type { AccountInfo } from "@matters/contracts";
import { normalizeSignature, SIGNATURE_MAX_CHARS, signatureProblem } from "@matters/core";
import { createSignal, Show } from "solid-js";
import { type Backend, BackendError } from "./client.ts";
import { MarkdownEditor } from "./editor.tsx";

const small =
  "h-[28px] cursor-default rounded-[8px] bg-button px-3 text-[12px] font-semibold disabled:opacity-40";
const primary =
  "h-[28px] cursor-default rounded-[8px] bg-ink px-3 text-[12px] font-semibold text-bg disabled:opacity-40";

/** "1,234 of 2,000": what the field holds, counted as the core counts it. */
const counted = (n: number) =>
  `${n.toLocaleString("en-GB")} of ${SIGNATURE_MAX_CHARS.toLocaleString("en-GB")}`;

/**
 * The account's own signature, in its row of Settings › Accounts (ADR 0142, rule 1): Markdown in
 * the composer's editor, so it looks here as it does in a message. Empty is none, the default; no
 * line of the app's own is ever added. ⌘↵ saves, Escape (in the section) closes it. A message
 * started afterwards starts with it; drafts that exist keep what they have.
 */
export function SignatureForm(props: {
  backend: Pick<Backend, "setSignature">;
  account: AccountInfo;
  /** What was typed in the field before its row was made anew; none when it was just opened. */
  typed?: string | undefined;
  onType?: (text: string) => void;
  onClose: () => void;
  /** The save ended, with the text it saved: the field closes only if it still holds that. */
  onSaved: (note: string, submitted: string) => void;
}) {
  const [text, setText] = createSignal(props.typed ?? props.account.signature ?? "");
  const [saving, setSaving] = createSignal(false);
  const [failure, setFailure] = createSignal("");
  const kept = () => normalizeSignature(text());
  const problem = () => signatureProblem(kept());
  const unchanged = () => kept() === (props.account.signature ?? "");

  async function save(e?: Event) {
    e?.preventDefault();
    if (saving() || problem() !== null) return;
    if (unchanged()) {
      props.onClose();
      return;
    }
    setSaving(true);
    setFailure("");
    // The field stays editable while the save goes, since it can be slow: what is typed meanwhile
    // is newer than what this saves, and keeps the field open.
    const submitted = text();
    try {
      const signature = await props.backend.setSignature(props.account.id, submitted);
      props.onSaved(
        signature === ""
          ? "No signature. New messages from this account start empty."
          : "Signature saved. New messages, replies and forwards from this account start with it.",
        submitted,
      );
    } catch (error) {
      setFailure(error instanceof BackendError ? error.message : "The signature was not saved.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      data-signature={props.account.id}
      aria-label={`Signature for ${props.account.address}`}
      class="mt-2 flex flex-col gap-2 rounded-[9px] bg-fill p-3"
      onSubmit={(e) => void save(e)}
    >
      <p class="text-[12px] text-secondary">Signature for {props.account.address}</p>
      <div class="rounded-[8px] bg-bg px-1.5 focus-within:ring-1 focus-within:ring-edge">
        <MarkdownEditor
          initial={text()}
          label={`Signature for ${props.account.address}`}
          placeholder="Your name, and what people need to reach you"
          grow={{ min: 72, max: "220px" }}
          onChange={(value) => {
            setText(value);
            props.onType?.(value);
          }}
          onSend={() => void save()}
          // After the key has gone by: the section must still see it came from here, and keep the
          // window open.
          onEscape={() => setTimeout(() => props.onClose(), 0)}
        />
      </div>
      <p class="text-[12px] leading-[1.45] text-secondary" aria-live="polite">
        Markdown, as in a message. It goes under a line with <code>--</code> in every new message,
        reply and forward from this account, where you can still change it. Drafts you already have
        keep theirs. Matters adds nothing of its own.
      </p>
      <div class="flex items-center gap-2">
        <button type="submit" class={primary} disabled={saving() || problem() !== null}>
          {saving() ? "Saving…" : "Save signature"}
        </button>
        <button type="button" class={small} disabled={saving()} onClick={() => props.onClose()}>
          Cancel
        </button>
        <span
          class="ml-auto text-[11px] tabular-nums"
          classList={{
            "text-secondary": kept().length <= SIGNATURE_MAX_CHARS,
            "text-late": kept().length > SIGNATURE_MAX_CHARS,
          }}
        >
          {counted(kept().length)}
        </span>
      </div>
      <Show when={problem() ?? (failure() === "" ? null : failure())}>
        {(why) => (
          <p role="alert" data-signature-problem class="text-[12px] leading-[1.45] text-late">
            {why()}
          </p>
        )}
      </Show>
    </form>
  );
}
