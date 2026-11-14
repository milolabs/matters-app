import type { AccountInfo } from "@matters/contracts";
import type { AgentStatus } from "@matters/core";
import { mailRuntimesInUse } from "@matters/core";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { AccountColor } from "./accountMarks.ts";
import type { AccountsStore } from "./accounts.ts";
import { ConsentQuestion } from "./agentConnect.tsx";
import type { Backend } from "./client.ts";
import { signInTrouble } from "./explain.ts";
import { Ring } from "./icons.tsx";
import { passwordRejected } from "./newPassword.ts";
import { NewPasswordForm } from "./newPasswordForm.tsx";
import { Setup } from "./setup.tsx";
import { describeStatus } from "./status.ts";

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
 */
export function AccountsSection(props: {
  backend: Backend;
  accounts: AccountsStore;
  onClose: () => void;
}) {
  const [adding, setAdding] = createSignal(false);
  const [confirming, setConfirming] = createSignal<string | null>(null);
  const [removing, setRemoving] = createSignal<string | null>(null);
  const [failure, setFailure] = createSignal("");
  // Password forms the person opened, the refused ones they closed, and what a saved one said.
  const [asked, setAsked] = createSignal<ReadonlySet<string>>(new Set());
  const [dismissed, setDismissed] = createSignal<ReadonlySet<string>>(new Set());
  const [saved, setSaved] = createSignal<Readonly<Record<string, string>>>({});
  const rejected = (id: string) => passwordRejected(props.accounts.statusOf(id));
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
    setRemoving(account.id);
    try {
      await props.accounts.remove(account.id);
      setConfirming(null);
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
              const status = () => describeStatus(props.accounts.statusOf(account.id));
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
                    {account.host}:{account.port} ·{" "}
                    {account.security === "tls"
                      ? "TLS"
                      : account.security === "starttls"
                        ? "STARTTLS"
                        : "no encryption"}
                  </div>
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
                      signInTrouble(props.accounts.statusOf(account.id), account.host)
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
                            {rejected(account.id) ? "Enter new password" : "Change password"}{" "}
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
                            <p class="mb-2 text-[13px]">
                              Remove {account.address}? Its messages, search index and saved
                              password are deleted from this computer. Mail on the server stays.
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
                          A large mailbox can take a moment. Mail on the server stays.
                        </p>
                      </Show>
                    </div>
                  </Show>
                </div>
              );
            }}
          </For>
        </div>
      </Show>
    </section>
  );
}
