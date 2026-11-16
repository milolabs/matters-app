import type { AccountInfo } from "@matters/contracts";
import { normalizeSignature, SIGNATURE_MAX_CHARS, signatureProblem } from "@matters/core";
import { createSignal, Show } from "solid-js";
import { type Backend, BackendError } from "./client.ts";
import { MarkdownEditor } from "./editor.tsx";
import {
  type SavedSignatures,
  type SignatureFailure,
  signatureAlert,
  signatureUnchanged,
} from "./signatureFields.ts";

const small =
  "h-[28px] cursor-default rounded-[8px] bg-button px-3 text-[12px] font-semibold disabled:opacity-40";
const primary =
  "h-[28px] cursor-default rounded-[8px] bg-ink px-3 text-[12px] font-semibold text-bg disabled:opacity-40";

/**
 * The order each save is pressed in, across the fields: a row made anew (when the list of accounts
 * is read again) has a new field, and its save is still later than one the old field started.
 */
let saves = 0;

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
  /** What the saves that succeeded left, while the list of accounts has not caught up. */
  saved: SavedSignatures;
  /**
   * The save succeeded: the note, the text it saved (the field closes only if it still holds
   * that), the signature the store now holds, and the order the save was pressed in.
   */
  onSaved: (note: string, submitted: string, signature: string, order: number) => void;
}) {
  const [text, setText] = createSignal(props.typed ?? props.account.signature ?? "");
  const [saving, setSaving] = createSignal(false);
  const [failure, setFailure] = createSignal<SignatureFailure | null>(null);
  const kept = () => normalizeSignature(text());
  const problem = () => signatureProblem(kept());
  // Unchanged only when it is what the store holds: the account as the list shows it, and the
  // last save that succeeded, which the list may not show yet.
  const unchanged = () =>
    signatureUnchanged(props.saved, props.account.id, props.account.signature ?? "", kept());

  async function save(e?: Event) {
    e?.preventDefault();
    if (saving() || problem() !== null) return;
    if (unchanged()) {
      props.onClose();
      return;
    }
    setSaving(true);
    setFailure(null);
    // The field stays editable while the save goes, since it can be slow: what is typed meanwhile
    // is newer than what this saves, and keeps the field open.
    const submitted = text();
    const order = ++saves;
    try {
      const signature = await props.backend.setSignature(props.account.id, submitted);
      props.onSaved(
        signature === ""
          ? "No signature. New messages from this account start empty."
          : "Signature saved. New messages, replies and forwards from this account start with it.",
        submitted,
        signature,
        order,
      );
    } catch (error) {
      setFailure({
        why: error instanceof BackendError ? error.message : "The signature was not saved.",
        text: submitted,
      });
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
            // Why the last save failed is stale once the text changes.
            if (value !== failure()?.text) setFailure(null);
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
      <Show when={signatureAlert(problem(), failure(), text())}>
        {(why) => (
          <p role="alert" data-signature-problem class="text-[12px] leading-[1.45] text-late">
            {why()}
          </p>
        )}
      </Show>
    </form>
  );
}
