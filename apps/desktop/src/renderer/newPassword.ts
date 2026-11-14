import type { ChangePasswordResponse } from "@matters/contracts";
import {
  type MailTransport,
  newPasswordCanFix,
  refusalIsTemporary,
  type SyncStatus,
} from "@matters/core";
import { createSignal } from "solid-js";
import { type Backend, BackendError } from "./client.ts";
import { explainFailure, failureEvidence, refusalSentence } from "./explain.ts";

/**
 * The server refused the sign-in for a reason that lasts until the person acts: background
 * work waits, and only *Sync now* or a new password tries again (ADR 0113). A temporary refusal
 * (`unavailable`, `throttled`) is not one; the sync tries it again by itself.
 */
export function signInStopped(status: SyncStatus): boolean {
  return (
    status.state === "error" &&
    status.kind === "auth" &&
    !refusalIsTemporary(status.detail?.refusal)
  );
}

/**
 * The server turned the saved password down, and a new one can fix it: the account's row opens
 * the form by itself. Not for a refusal no password ends (IMAP off, a web sign-in, a policy).
 */
export function passwordRejected(status: SyncStatus): boolean {
  return (
    signInStopped(status) && status.state === "error" && newPasswordCanFix(status.detail?.refusal)
  );
}

/**
 * A browser sign-in has ended (ADR 0133, rule 8): the account's row opens *Sign in again* by
 * itself, as it opens the password form for a refused password.
 */
export function signInEnded(status: SyncStatus): boolean {
  return (
    signInStopped(status) && status.state === "error" && status.detail?.refusal === "signInAgain"
  );
}

const UNCHANGED = "The saved password is unchanged.";
const SIGN_IN_UNCHANGED = "The saved sign-in is unchanged.";

/** Why the new browser sign-in was not saved, and that the old one still is (ADR 0133). */
export function signInAgainFailure(
  error: unknown,
  account: {
    readonly host: string;
    readonly port: number;
    readonly transport?: MailTransport;
  },
): string {
  if (error instanceof BackendError) {
    // Over Graph there is no server or outgoing server to name (ADR 0136, rule 13).
    if (account.transport === "graph") {
      return error.code === "notFound"
        ? "This account is no longer on this computer."
        : `${explainFailure(error, { host: "", port: 0, place: "newPassword", browserSignIn: true, transport: "graph" })} ${SIGN_IN_UNCHANGED}`;
    }
    switch (error.code) {
      case "outgoingAuthFailed": {
        const refusal = error.detail?.refusal;
        const why =
          refusal === undefined || refusal === "credentials" || refusal === "unknown"
            ? ""
            : ` ${refusalSentence(refusal, "", "newPassword", true)}`;
        return `Receiving works with this sign-in, but the outgoing server refused it, so sending wouldn't.${why} ${SIGN_IN_UNCHANGED}`;
      }
      case "notFound":
        return "This account is no longer on this computer.";
      case "authFailed":
      case "tlsFailed":
      case "unreachable":
      case "insecureTransport":
      case "credentialsUnavailable":
      case "invalidAccount":
      case "invalidRequest":
        return `${explainFailure(error, { host: account.host, port: account.port, place: "newPassword", browserSignIn: true })} ${SIGN_IN_UNCHANGED}`;
      default:
        return `The sign-in was not saved: ${sentence(error.message)} ${SIGN_IN_UNCHANGED}`;
    }
  }
  return `Something went wrong. ${SIGN_IN_UNCHANGED}`;
}

/** What the row says once the new sign-in is saved. `graph`: no outgoing server to name. */
export function signInAgainSaved(
  response: Pick<ChangePasswordResponse, "outgoing" | "outgoingNote">,
  graph = false,
): string {
  if (response.outgoing === "unchecked") {
    const why = response.outgoingNote ? ` (${response.outgoingNote})` : "";
    return graph
      ? `Signed in. Syncing again. Microsoft could not be asked about sending${why}; the first send will tell.`
      : `Signed in. Syncing again. The outgoing server could not be asked${why}; the first send will tell.`;
  }
  return "Signed in. Syncing again.";
}

/** Why the new password was not saved, and that the old one still is. */
export function newPasswordFailure(
  error: unknown,
  account: { readonly host: string; readonly port: number },
): string {
  if (error instanceof BackendError) {
    switch (error.code) {
      case "outgoingAuthFailed": {
        // A reason that says more than "wrong password" is worth its own sentence (ADR 0114).
        const refusal = error.detail?.refusal;
        const why =
          refusal === undefined || refusal === "credentials" || refusal === "unknown"
            ? ""
            : ` ${refusalSentence(refusal, "", "newPassword")}`;
        return `Receiving works with this password, but the outgoing server refused it, so sending wouldn't.${why} ${UNCHANGED}`;
      }
      case "notFound":
        return "This account is no longer on this computer.";
      case "authFailed":
      case "tlsFailed":
      case "unreachable":
      case "insecureTransport":
      case "credentialsUnavailable":
      case "invalidAccount":
      case "invalidRequest":
        return `${explainFailure(error, { host: account.host, port: account.port, place: "newPassword" })} ${UNCHANGED}`;
      default:
        return `The password was not changed: ${sentence(error.message)} ${UNCHANGED}`;
    }
  }
  return `Something went wrong. ${UNCHANGED}`;
}

function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** What the row says once the new password is saved. */
export function newPasswordSaved(
  response: Pick<ChangePasswordResponse, "outgoing" | "outgoingNote">,
): string {
  if (response.outgoing === "unchecked") {
    const why = response.outgoingNote ? ` (${response.outgoingNote})` : "";
    return `Password saved. Syncing again. The outgoing server could not be asked${why}; the first send will tell.`;
  }
  return "Password saved. Syncing again.";
}

export type NewPasswordPhase = "editing" | "checking" | "saved";

/**
 * The form's state for one account. The password lives in one signal of this form only, and is
 * dropped as soon as the backend has answered, whatever the answer.
 */
export function createNewPassword(
  backend: Pick<Backend, "changePassword">,
  account: { readonly id: string; readonly host: string; readonly port: number },
) {
  const [password, setPassword] = createSignal("");
  const [phase, setPhase] = createSignal<NewPasswordPhase>("editing");
  const [failure, setFailure] = createSignal("");
  // The server's own words under the failure, when it gave any (ADR 0114).
  const [evidence, setEvidence] = createSignal("");
  const [saved, setSaved] = createSignal("");

  async function submit(): Promise<boolean> {
    if (phase() === "checking" || password() === "") return false;
    setFailure("");
    setEvidence("");
    setPhase("checking");
    const typed = password();
    try {
      const response = await backend.changePassword(account.id, typed);
      setSaved(newPasswordSaved(response));
      setPhase("saved");
      return true;
    } catch (error) {
      setFailure(newPasswordFailure(error, account));
      // An unexpected error's message is in the failure itself already.
      if (!(error instanceof BackendError && error.code === "internal")) {
        setEvidence(failureEvidence(error) ?? "");
      }
      setPhase("editing");
      return false;
    } finally {
      setPassword("");
    }
  }

  return {
    password,
    setPassword: (value: string) => {
      setPassword(value);
      if (failure() !== "") setFailure("");
      if (evidence() !== "") setEvidence("");
    },
    phase,
    failure,
    evidence,
    saved,
    canSubmit: () => phase() !== "checking" && password() !== "",
    submit,
  };
}

export type NewPasswordForm = ReturnType<typeof createNewPassword>;
