import type { AccountInfo, StorageReport } from "@matters/contracts";
import type { AgentStatus, OAuthProvider } from "@matters/core";
import { accountPermissionPages, browserSignInProvider, mailRuntimesInUse } from "@matters/core";
import { createEffect, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { AccountColor } from "./accountMarks.ts";
import type { AccountsStore } from "./accounts.ts";
import { ConsentQuestion } from "./agentConnect.tsx";
import type { Backend } from "./client.ts";
import { signInTrouble } from "./explain.ts";
import { askPermissionPage } from "./files.ts";
import { Ring } from "./icons.tsx";
import { passwordRejected, signInEnded } from "./newPassword.ts";
import { NewPasswordForm, SignInAgainForm } from "./newPasswordForm.tsx";
import { accountShare, removalNotice } from "./removal.ts";
import { Setup } from "./setup.tsx";
import {
  closeSignatureField,
  NO_PENDING_SIGNATURES,
  NO_SAVED_SIGNATURES,
  NO_SIGNATURE_FAILURES,
  NO_SIGNATURE_FIELD,
  openSignatureField,
  type PendingSignatures,
  recordSavedSignature,
  type SavedSignatures,
  type SignatureFailures,
  type SignatureFields,
  savedSignatureField,
  signatureSaveEnded,
  signatureSaveStarted,
  signaturesCaughtUp,
  typeInSignatureField,
} from "./signatureFields.ts";
import { SignatureForm } from "./signatureForm.tsx";
import { mainSignIn, type SignInClient } from "./signIn.ts";
import { describeStatus } from "./status.ts";
import { count, storageSize } from "./storageView.ts";

const small =
  "h-[28px] cursor-default rounded-[8px] bg-button px-3 text-[12px] font-semibold disabled:opacity-40";
/** The one button a row needs most: a refused password's way out (ADR 0113). */
const smallPrimary =
  "h-[28px] cursor-default rounded-[8px] bg-ink px-3 text-[12px] font-semibold text-bg disabled:opacity-40";

/**
 * Accounts and their sync state, a section of the settings window. Escape closes the window;
 * "Remove" asks first. Keys: s syncs the account in focus, p asks for its new password, r asks to
 * remove it, n adds another. An account whose password the server refused shows the password form
 * at once (ADR 0113); any other refused sign-in shows its reason and next step instead (ADR 0114).
 * An account on servers that take only a browser sign-in has *Sign in again* in the password
 * form's place, under the same key, and it opens by itself when the sign-in has ended (ADR 0133).
 * The account's own signature is edited in its row too (ADR 0142); while its field has the focus,
 * the letters are text, not the section's keys.
 */
export function AccountsSection(props: {
  backend: Backend;
  accounts: AccountsStore;
  onClose: () => void;
  /** Main's browser sign-in; tests pass their own. */
  signIn?: SignInClient;
}) {
  const signIn = props.signIn ?? mainSignIn;
  // Whose browser sign-in an account takes, read from its transport, then the host table (ADR
  // 0136, rule 2; ADR 0133, rule 11), and whether this build offers it (rule 4), asked of main
  // once: one registration serves both Microsoft entries.
  const providerOf = (account: AccountInfo): OAuthProvider | undefined =>
    browserSignInProvider({ transport: account.transport, imap: { host: account.host } });
  const [offered, setOffered] = createSignal<ReadonlySet<OAuthProvider>>(new Set());
  onMount(() => {
    void signIn.offered("microsoft").then(
      (yes) => yes && setOffered(new Set<OAuthProvider>(["microsoft", "microsoftGraph"])),
      () => {},
    );
  });
  const [adding, setAdding] = createSignal(false);
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal("");
  const [notice, setNotice] = createSignal("");
  // The size of the account's mail, for the confirmation: its share of the last measurement.
  const [sizes, setSizes] = createSignal<StorageReport | null>(null);
  const share = (id: string) => accountShare(sizes(), id);
  createEffect(() => {
    if (confirming() === null) return;
    void props.backend
      .getStorage()
      .then(setSizes)
      .catch(() => setSizes(null));
  });
  // Password forms the person opened, the refused ones they closed, and what a saved one said.
  const [asked, setAsked] = createSignal<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = createSignal<Readonly<Record<string, string>>>({});
  // The account whose signature field is open (ADR 0142), one at a time, and what is typed in it.
  const [signatureFields, setSignatureFields] = createSignal<SignatureFields>(NO_SIGNATURE_FIELD);
  const signing = () => signatureFields().open;
  const closeSignature = (id: string) => setSignatureFields((f) => closeSignatureField(f, id));
  // What each account's last save that succeeded left in the store, until the list shows it.
  const [savedSignatures, setSavedSignatures] = createSignal<SavedSignatures>(NO_SAVED_SIGNATURES);
  createEffect(() => {
    const accounts = props.accounts.accounts();
    setSavedSignatures((s) => signaturesCaughtUp(s, accounts));
  });
  // The saves still on their way and why the last one failed, per account: a field closed while
  // its save goes and opened again shows it saving, and its Save waits.
  const [pendingSignatures, setPendingSignatures] =
    createSignal<PendingSignatures>(NO_PENDING_SIGNATURES);
  const [signatureFailures, setSignatureFailures] =
    createSignal<SignatureFailures>(NO_SIGNATURE_FAILURES);
  const byBrowser = (id: string) => {
    const account = props.accounts.accounts().find((a) => a.id === id);
    return account !== undefined && providerOf(account) !== undefined;
  };
  // The way out the row offers first: a new password, or a new sign-in in the browser.
  const rejected = (id: string) =>
    byBrowser(id)
      ? signInEnded(props.accounts.statusOf(id))
      : passwordRejected(props.accounts.statusOf(id));
  const formOpen = (id: string) =>
    asked().has(id) || (rejected(id) && !dismissed().has(id) && saved()[id] === undefined);
  const plus = (set: ReadonlySet<string>, id: string) => new Set([...set, id]);
  const minus = (set: ReadonlySet<string>, id: string) => new Set([...set].filter((x) => x !== id));
  function openForm(id: string) {
    setAsked((s) => plus(s, id));
    setDismissed((s) => minus(s, id));
    setSaved(({ [id]: _, ...rest }) => rest);
  }
  function closeForm(id: string) {
    setAsked((s) => minus(s, id));
    setDismissed((s) => plus(s, id));
  }
  // A new account while AI is on: the same question as in first run, for this account (ADR 0052).
  const [reading, setReading] = createSignal<{
    account: AccountInfo;
    status: AgentStatus;
  } | null>(null);

  async function askToRead(account: AccountInfo) {
    try {
      const status = await props.backend.agentStatus();
      // The same question as in first run, for every runtime a kind of work that takes mail is on
      // (ADR 0121; ADR 0134, rule 14).
      if (status.settings.enabled && mailRuntimesInUse(status.settings).length > 0) {
        setReading({ account, status });
      }
    } catch {
      // AI cannot be reached: the account is added, and nothing is asked.
    }
  }

  // On the window: the keys work wherever the focus is, and after the form below has gone.
  onMount(() => {
    window.addEventListener("keydown", onKeyDown);
    onCleanup(() => window.removeEventListener("keydown", onKeyDown));
  });

  async function remove(account: AccountInfo) {
    if (removing() !== null) return;
    setFailure("");
    setNotice("");
    setRemoving(account.id);
    try {
      const compaction = await props.accounts.remove(account.id);
      setConfirming(null);
      setNotice(removalNotice(account.address, compaction));
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Removing the account failed.");
    } finally {
      setRemoving(null);
    }
  }

  function onKeyDown(e: KeyboardEvent) {
    if (e.metaKey || e.ctrlKey || e.altKey || e.isComposing) return;
    // Removal cannot be taken back halfway: the window stays until it has finished.
    if (removing() !== null) {
      e.preventDefault();
      return;
    }
    const inSignature =
      e.target instanceof HTMLElement ? e.target.closest("[data-signature]") !== null : false;
    if (e.key === "Escape" && inSignature) {
      // The editor closes the field itself; from the form's buttons it closes here. The window
      // stays.
      e.preventDefault();
      const target = e.target as HTMLElement;
      const form = target.closest<HTMLElement>("[data-signature]");
      if (target.closest(".cm-editor") === null && form?.dataset.signature) {
        closeSignature(form.dataset.signature);
      }
      return;
    }
    // The signature's editor is text: its letters are not the section's keys.
    if (inSignature) return;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      const form =
        e.target instanceof HTMLElement
          ? e.target.closest<HTMLElement>("[data-new-password]")
          : null;
      if (form?.dataset.newPassword) closeForm(form.dataset.newPassword);
      else if (confirming() !== null) setConfirming(null);
      else if (adding()) setAdding(false);
      else props.onClose();
      return;
    }
    if (adding()) return;
    const target = e.target;
    // A colour input has no text to type: the shortcuts still apply there.
    if (target instanceof HTMLInputElement && target.type !== "color") return;
    if (target instanceof HTMLSelectElement) return;
    const row =
      target instanceof HTMLElement ? target.closest<HTMLElement>("[data-account]") : null;
    const only =
      props.accounts.accounts().length === 1 ? props.accounts.accounts()[0]?.id : undefined;
    const id = row?.dataset.account ?? only;
    if (e.key === "n" && !adding()) {
      e.preventDefault();
      setAdding(true);
    } else if (e.key === "s" && id) {
      e.preventDefault();
      void props.accounts.syncNow(id);
    } else if (e.key === "p" && id) {
      e.preventDefault();
      openForm(id);
    } else if (e.key === "r" && id) {
      e.preventDefault();
      setConfirming(id);
    }
  }

  return (
    <section aria-label="Accounts" class="flex h-full flex-col">
      <Show
        when={!adding()}
        fallback={
          <>
            <div class="drag h-[28px] shrink-0" />
            <div class="min-h-0 flex-1 overflow-y-auto">
              <Setup
                backend={props.backend}
                signIn={signIn}
                onCancel={() => setAdding(false)}
                onAdded={(account) => {
                  setAdding(false);
                  void props.accounts.refresh();
                  void askToRead(account);
                }}
              />
            </div>
          </>
        }
      >
        <div class="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-5">
          <h2 class="flex-1 font-serif text-[17px] font-semibold">Accounts</h2>
          <button
            type="button"
            class={small}
            disabled={removing() !== null}
            onClick={() => setAdding(true)}
          >
            Add account <span class="text-secondary">n</span>
          </button>
        </div>
        <Show when={failure() !== ""}>
          <p role="alert" class="px-5 pt-3 text-[13px] text-late">
            {failure()}
          </p>
        </Show>
        <Show when={notice() !== ""}>
          <p role="status" class="px-5 pt-3 text-[13px] text-secondary">
            {notice()}
          </p>
        </Show>
        <div class="min-h-0 flex-1 overflow-y-auto">
          <Show when={reading()}>
            {(r) => (
              <div class="flex flex-col gap-4 border-b border-hairline px-5 py-4" data-read-new>
                <h3 class="font-serif text-[17px] font-semibold">
                  Shall I read the mail of {r().account.address}?
                </h3>
                <ConsentQuestion
                  backend={props.backend}
                  status={r().status}
                  accounts={[r().account]}
                  declineLabel="Not this account"
                  onStatus={(status) => setReading({ account: r().account, status })}
                  onStarted={() => setReading(null)}
                  onDeclined={() => setReading(null)}
                />
              </div>
            )}
          </Show>
          <For
            each={props.accounts.accounts()}
            fallback={<p class="px-5 pt-10 text-center text-[13px] text-secondary">No accounts.</p>}
          >
            {(account) => {
              const graph = () => account.transport === "graph";
              const status = () =>
                describeStatus(
                  props.accounts.statusOf(account.id),
                  providerOf(account) !== undefined,
                  graph(),
                );
              return (
                <div
                  data-account={account.id}
                  class="border-b border-hairline px-5 py-3 outline-none last:border-b-0"
                >
                  <div class="flex items-baseline gap-2">
                    <input
                      type="color"
                      class="account-color shrink-0 self-center"
                      value={props.accounts.marks().get(account.id)?.fill}
                      aria-label={`Color for ${account.address}`}
                      title="Change color"
                      onInput={(e) =>
                        props.accounts.setColor(account.id, e.currentTarget.value as AccountColor)
                      }
                    />
                    <span class="min-w-0 flex-1 truncate font-semibold">{account.address}</span>
                    <span
                      class="shrink-0 text-[12px]"
                      classList={{
                        "text-secondary": status().tone !== "error",
                        "text-late": status().tone === "error",
                      }}
                    >
                      {status().text}
                    </span>
                  </div>
                  <div class="text-[12px] text-secondary">
                    {/* A Graph account has no servers to show (ADR 0136, rule 2). */}
                    <Show when={!graph()} fallback="Microsoft · signs in through your browser">
                      {account.host}:{account.port} ·{" "}
                      {account.security === "tls"
                        ? "TLS"
                        : account.security === "starttls"
                          ? "STARTTLS"
                          : "no encryption"}
                    </Show>
                  </div>
                  <Show when={signing() !== account.id && account.signature}>
                    {(signature) => (
                      <p
                        data-signature-line
                        class="truncate text-[12px] text-secondary"
                        title={signature()}
                      >
                        Signature: {signature().split("\n")[0]}
                      </p>
                    )}
                  </Show>
                  <Show when={saved()[account.id]}>
                    {(note) => (
                      <p class="mt-1 text-[12px] text-secondary" role="status">
                        {note()}
                      </p>
                    )}
                  </Show>
                  <Show
                    when={
                      !formOpen(account.id) &&
                      signInTrouble(
                        props.accounts.statusOf(account.id),
                        account.host,
                        offered().size > 0,
                        account.transport,
                      )
                    }
                  >
                    {(why) => (
                      <div data-sign-in-trouble class="mt-1 text-[12px] leading-[1.45]">
                        <p>{why().sentence}</p>
                        <Show when={why().evidence}>
                          {(said) => <p class="selectable text-secondary">{said()}</p>}
                        </Show>
                      </div>
                    )}
                  </Show>
                  <Show when={formOpen(account.id) && confirming() !== account.id}>
                    <Show
                      when={providerOf(account)}
                      fallback={
                        <NewPasswordForm
                          backend={props.backend}
                          account={account}
                          status={props.accounts.statusOf(account.id)}
                          onClose={() => closeForm(account.id)}
                          onSaved={(note) => {
                            setAsked((s) => minus(s, account.id));
                            setSaved((all) => ({ ...all, [account.id]: note }));
                          }}
                        />
                      }
                    >
                      {(provider) => (
                        <SignInAgainForm
                          backend={props.backend}
                          signIn={signIn}
                          account={account}
                          provider={provider()}
                          offered={offered().has(provider())}
                          status={props.accounts.statusOf(account.id)}
                          onClose={() => closeForm(account.id)}
                          onSaved={(note) => {
                            setAsked((s) => minus(s, account.id));
                            setSaved((all) => ({ ...all, [account.id]: note }));
                          }}
                        />
                      )}
                    </Show>
                  </Show>
                  <Show when={signing() === account.id && confirming() !== account.id}>
                    <SignatureForm
                      backend={props.backend}
                      account={account}
                      typed={signatureFields().typed[account.id]}
                      onType={(text) =>
                        setSignatureFields((f) => typeInSignatureField(f, account.id, text))
                      }
                      onClose={() => closeSignature(account.id)}
                      saved={savedSignatures()}
                      pending={pendingSignatures()}
                      failure={signatureFailures()[account.id]}
                      onSaving={(submitted, order) => {
                        setPendingSignatures((p) =>
                          signatureSaveStarted(p, account.id, submitted, order),
                        );
                        setSignatureFailures(({ [account.id]: _, ...rest }) => rest);
                      }}
                      onFailed={(failure, order) => {
                        setPendingSignatures((p) => signatureSaveEnded(p, account.id, order));
                        setSignatureFailures((all) => ({ ...all, [account.id]: failure }));
                      }}
                      onSaved={(note, submitted, signature, order) => {
                        setPendingSignatures((p) => signatureSaveEnded(p, account.id, order));
                        // What the store holds now, before the list is read again: a Save of other
                        // text in the meantime is never taken for unchanged.
                        setSavedSignatures((s) =>
                          recordSavedSignature(s, account.id, signature, order),
                        );
                        // This account's field only: another may have been opened meanwhile. It
                        // stays open when it holds text typed after the save was pressed.
                        setSignatureFields((f) => savedSignatureField(f, account.id, submitted));
                        setSaved((all) => ({ ...all, [account.id]: note }));
                        void props.accounts.refresh();
                      }}
                    />
                  </Show>
                  <Show
                    when={confirming() === account.id}
                    fallback={
                      <div class="mt-2 flex gap-2">
                        <button
                          type="button"
                          class={small}
                          onClick={() => void props.accounts.syncNow(account.id)}
                        >
                          Sync now <span class="text-secondary">s</span>
                        </button>
                        <Show when={!formOpen(account.id)}>
                          <button
                            type="button"
                            class={rejected(account.id) ? smallPrimary : small}
                            onClick={() => openForm(account.id)}
                          >
                            {providerOf(account)
                              ? "Sign in again"
                              : rejected(account.id)
                                ? "Enter new password"
                                : "Change password"}{" "}
                            <span
                              classList={{
                                "text-secondary": !rejected(account.id),
                                "opacity-60": rejected(account.id),
                              }}
                            >
                              p
                            </span>
                          </button>
                        </Show>
                        <Show when={signing() !== account.id}>
                          <button
                            type="button"
                            class={small}
                            onClick={() => {
                              setSaved(({ [account.id]: _, ...rest }) => rest);
                              setSignatureFields(openSignatureField(account.id));
                            }}
                          >
                            Signature
                          </button>
                        </Show>
                        <button
                          type="button"
                          class={small}
                          onClick={() => setConfirming(account.id)}
                        >
                          Remove account <span class="text-secondary">r</span>
                        </button>
                      </div>
                    }
                  >
                    <div
                      role="alertdialog"
                      aria-label="Confirm removal"
                      class="mt-2 rounded-[9px] bg-fill p-3"
                    >
                      <Show
                        when={removing() === account.id}
                        fallback={
                          <>
                            <p class="mb-1.5 text-[13px]">
                              Remove {account.address}? Its{" "}
                              {share(account.id)
                                ? `${count(share(account.id)?.messages ?? 0)} messages`
                                : "messages"}
                              , their attachments, its part of the search index, its saved{" "}
                              {providerOf(account) ? "sign-in" : "password"} and what agents wrote
                              about its mail are deleted from this computer. Mail on the server
                              stays.
                            </p>
                            <p class="mb-2.5 text-[12px] leading-[1.5] text-secondary">
                              {share(account.id)?.bytes
                                ? `About ${storageSize(share(account.id)?.bytes ?? 0)} comes back`
                                : "The space comes back"}{" "}
                              once the database is compacted, which Matters does right after.
                              <Show when={accountPermissionPages(account)[0]}>
                                {(first) => (
                                  <>
                                    {" "}
                                    {first().provider} keeps listing Matters as allowed until you
                                    take that back on its page for{" "}
                                    <For each={accountPermissionPages(account)}>
                                      {(page, i) => (
                                        <>
                                          {i() > 0 ? " or " : ""}
                                          <button
                                            type="button"
                                            class="cursor-default text-mid underline underline-offset-2 hover:text-ink"
                                            onClick={() => void askPermissionPage(page.id)}
                                          >
                                            {page.audience}
                                          </button>
                                        </>
                                      )}
                                    </For>
                                    .
                                  </>
                                )}
                              </Show>
                            </p>
                            <div class="flex gap-2">
                              <button
                                type="button"
                                class={`${small} bg-late text-bg`}
                                onClick={() => void remove(account)}
                              >
                                Remove
                              </button>
                              <button
                                type="button"
                                class={small}
                                ref={(el) => queueMicrotask(() => el.focus())}
                                onClick={() => setConfirming(null)}
                              >
                                Cancel
                              </button>
                            </div>
                          </>
                        }
                      >
                        <p
                          class="flex items-center gap-2.5 text-[13px]"
                          role="status"
                          aria-live="polite"
                        >
                          <span class="inline-flex animate-spin">
                            <Ring size={14} />
                          </span>
                          Removing {account.address} from this computer…
                        </p>
                        <p class="mt-1 pl-[24px] text-[12px] text-secondary">
                          A large mailbox can take a moment, and compacting the database after it
                          another. Mail on the server stays.
                        </p>
                      </Show>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
          <Show when={props.accounts.accounts().length > 0}>
            <p class="px-5 py-3 text-[12px] leading-[1.5] text-secondary">
              To take everything off this Mac at once, settings included, use Erase everything in
              Storage.
            </p>
          </Show>
        </div>
      </Show>
    </section>
  );
}
