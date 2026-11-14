import type { AccountInfo } from "@matters/contracts";
import type { OAuthProvider } from "@matters/core";
import { onCleanup, Show } from "solid-js";
import type { Backend } from "./client.ts";
import { failureEvidence, signInTrouble } from "./explain.ts";
import {
  createNewPassword,
  passwordRejected,
  signInAgainFailure,
  signInAgainSaved,
  signInEnded,
} from "./newPassword.ts";
import { createBrowserSignIn, providerName, type SignInClient } from "./signIn.ts";

const small =
  "h-[28px] cursor-default rounded-[8px] bg-button px-3 text-[12px] font-semibold disabled:opacity-40";
const primary =
  "h-[28px] cursor-default rounded-[8px] bg-ink px-3 text-[12px] font-semibold text-bg disabled:opacity-40";
const input =
  "selectable h-[28px] min-w-0 flex-1 rounded-[8px] bg-bg px-2.5 text-[13px] outline-none focus:ring-1 focus:ring-edge disabled:opacity-60";

/**
 * A new password for one account, in its row of Settings › Accounts (ADR 0113). Nothing else of
 * the account changes here; its mail on this computer stays. Escape (in the section) closes it.
 */
export function NewPasswordForm(props: {
  backend: Pick<Backend, "changePassword">;
  account: AccountInfo;
  /** The account's sync state: a refused password is said first, with the server's reason. */
  status: AccountInfo["status"];
  onClose: () => void;
  onSaved: (note: string) => void;
}) {
  const form = createNewPassword(props.backend, props.account);
  const id = `new-password-${props.account.id}`;
  const checking = () => form.phase() === "checking";
  // Why the saved password was refused, in the reason's own sentence (ADR 0114).
  const refused = () =>
    passwordRejected(props.status) ? signInTrouble(props.status, props.account.host) : undefined;

  async function save(e: Event) {
    e.preventDefault();
    if (await form.submit()) props.onSaved(form.saved());
  }

  return (
    <form
      data-new-password={props.account.id}
      aria-label={`New password for ${props.account.address}`}
      class="mt-2 flex flex-col gap-2 rounded-[9px] bg-fill p-3"
      onSubmit={(e) => void save(e)}
    >
      <Show when={refused()}>
        {(why) => (
          <div data-refused-reason>
            <p class="text-[13px] leading-[1.45]">
              {why().sentence} The mail on this computer stays as it is.
            </p>
            <Show when={why().evidence}>
              {(said) => <p class="selectable mt-1 text-[12px] text-secondary">{said()}</p>}
            </Show>
          </div>
        )}
      </Show>
      <label class="text-[12px] text-secondary" for={id}>
        New password for {props.account.address}
      </label>
      <div class="flex items-center gap-2">
        <input
          id={id}
          ref={(el) => queueMicrotask(() => el.focus())}
          type="password"
          autocomplete="off"
          spellcheck={false}
          class={input}
          value={form.password()}
          disabled={checking()}
          aria-invalid={form.failure() !== ""}
          aria-describedby={`${id}-note`}
          onInput={(e) => form.setPassword(e.currentTarget.value)}
        />
        <button type="submit" class={primary} disabled={!form.canSubmit()}>
          {checking() ? "Checking…" : "Save password"}
        </button>
        <button type="button" class={small} disabled={checking()} onClick={() => props.onClose()}>
          Cancel
        </button>
      </div>
      <p id={`${id}-note`} class="text-[12px] text-secondary" aria-live="polite">
        {checking()
          ? `Signing in to ${props.account.host} with it…`
          : props.account.canSend
            ? "Matters signs in to the incoming and the outgoing server with it before saving. With two-factor sign-in, most hosts want an app password."
            : "Matters signs in with it before saving. With two-factor sign-in, most hosts want an app password."}
      </p>
      <Show when={form.failure() !== ""}>
        <div role="alert" data-new-password-failure>
          <p class="text-[12px] leading-[1.45] text-late">{form.failure()}</p>
          <Show when={form.evidence() !== ""}>
            <p class="selectable mt-0.5 text-[12px] leading-[1.45] text-secondary">
              {form.evidence()}
            </p>
          </Show>
        </div>
      </Show>
    </form>
  );
}

/**
 * *Sign in again* for an account that signs in through the browser (ADR 0133, rule 11), in its
 * row of Settings › Accounts where the others have the password form: the browser opens, and
 * what comes back is tested on the servers before it replaces the saved sign-in. Nothing else of
 * the account changes; its mail on this computer stays. Escape (in the section) closes it and
 * ends a sign-in that is waiting in the browser.
 */
export function SignInAgainForm(props: {
  backend: Pick<Backend, "signInAgain">;
  signIn: SignInClient;
  account: AccountInfo;
  provider: OAuthProvider;
  /** This build offers the provider's sign-in (rule 4). */
  offered: boolean;
  status: AccountInfo["status"];
  onClose: () => void;
  onSaved: (note: string) => void;
}) {
  const flow = createBrowserSignIn(props.signIn);
  const name = () => providerName(props.provider);
  const busy = () => flow.phase() !== "idle";
  const graph = () => props.account.transport === "graph";
  const ended = () =>
    signInEnded(props.status)
      ? signInTrouble(props.status, props.account.host, true, props.account.transport)
      : undefined;
  let saved = "";
  onCleanup(() => flow.cancel());

  async function start(e: Event) {
    e.preventDefault();
    const ok = await flow.run(
      props.provider,
      props.account.address,
      async (handle) => {
        saved = signInAgainSaved(
          await props.backend.signInAgain(props.account.id, handle),
          graph(),
        );
      },
      (error) => {
        const said = failureEvidence(error, graph());
        return {
          sentence: signInAgainFailure(error, props.account),
          ...(said ? { evidence: said } : {}),
        };
      },
    );
    if (ok) props.onSaved(saved);
  }

  return (
    <form
      data-new-password={props.account.id}
      aria-label={`Sign in again to ${props.account.address}`}
      class="mt-2 flex flex-col gap-2 rounded-[9px] bg-fill p-3"
      onSubmit={(e) => void start(e)}
    >
      <Show when={ended()}>
        {(why) => (
          <div data-refused-reason>
            <p class="text-[13px] leading-[1.45]">
              {why().sentence} The mail on this computer stays as it is.
            </p>
            <Show when={why().evidence}>
              {(said) => <p class="selectable mt-1 text-[12px] text-secondary">{said()}</p>}
            </Show>
          </div>
        )}
      </Show>
      <div class="flex items-center gap-2">
        <Show when={props.offered}>
          <button
            type="submit"
            class={primary}
            disabled={busy()}
            ref={(el) => queueMicrotask(() => el.focus())}
          >
            {flow.phase() === "browser"
              ? "Waiting for your browser…"
              : flow.phase() === "checking"
                ? "Checking…"
                : `Sign in with ${name()}`}
          </button>
        </Show>
        <button
          type="button"
          class={small}
          disabled={flow.phase() === "checking"}
          onClick={() => (flow.phase() === "browser" ? flow.cancel() : props.onClose())}
        >
          Cancel
        </button>
      </div>
      <p class="text-[12px] text-secondary" aria-live="polite">
        {!props.offered
          ? `Sign-in with ${name()} isn't set up in this copy of Matters.`
          : flow.phase() === "browser"
            ? `Waiting for you to sign in to ${props.account.address} in your browser. Matters comes back to the front when you're done.`
            : flow.phase() === "checking"
              ? graph()
                ? `Checking the sign-in with ${name()}…`
                : `Signing in to ${props.account.host} with it…`
              : `Your browser opens at ${name()}'s sign-in page. Matters never sees your password; it tests the sign-in before saving it.`}
      </p>
      <Show when={flow.failure() !== ""}>
        <div role="alert" data-new-password-failure>
          <p class="text-[12px] leading-[1.45] text-late">{flow.failure()}</p>
          <Show when={flow.evidence() !== ""}>
            <p class="selectable mt-0.5 text-[12px] leading-[1.45] text-secondary">
              {flow.evidence()}
            </p>
          </Show>
        </div>
      </Show>
    </form>
  );
}
