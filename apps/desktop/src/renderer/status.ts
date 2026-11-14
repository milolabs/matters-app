import type { AccountInfo } from "@matters/contracts";
import type { SignInRefusal, SyncStatus } from "@matters/core";
import { browserSignInProvider } from "@matters/core";

export type Tone = "idle" | "busy" | "error";

export interface StatusSummary {
  readonly tone: Tone;
  readonly text: string;
}

const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/**
 * A one-line description of one account's sync state. `browser`: the account signs in through
 * the browser (ADR 0133, rule 11), so nothing here is about a password. `graph`: its mail moves
 * over Microsoft Graph (ADR 0136), so nothing is about a server, a password or IMAP either.
 */
export function describeStatus(status: SyncStatus, browser = false, graph = false): StatusSummary {
  switch (status.state) {
    case "syncing": {
      if (status.folder === "") return { tone: "busy", text: "Connecting…" };
      const progress =
        status.total !== undefined && status.total > 0
          ? ` ${status.done} / ${status.total}`
          : status.done > 0
            ? ` ${status.done}`
            : "";
      return { tone: "busy", text: `Syncing ${status.folder}${progress}` };
    }
    case "error":
      return {
        tone: "error",
        text:
          status.kind === "auth"
            ? graph
              ? graphRefusalLabel(status.detail?.refusal)
              : refusalLabel(status.detail?.refusal, browser)
            : graph
              ? graphErrorText(status.kind, status.message)
              : errorText(status.kind, status.message, browser),
      };
    case "idle":
      return {
        tone: "idle",
        text:
          status.lastSyncMs === undefined
            ? "Up to date"
            : `Synced ${time.format(status.lastSyncMs)}`,
      };
  }
}

/** A few words for why the server refused the sign-in (ADR 0114); the row says the rest. */
function refusalLabel(refusal: SignInRefusal | undefined, browser: boolean): string {
  switch (refusal) {
    case "appPassword":
      return "App password needed";
    case "expired":
      return browser ? "Sign-in refused" : "Password expired";
    case "webLogin":
      return "Sign in on the website first";
    case "imapOff":
      return "IMAP is turned off";
    case "browserOnly":
      return "Needs browser sign-in";
    case "signInAgain":
      return "Sign-in ended";
    case "notAllowed":
      return browser ? "IMAP is turned off" : "Sign-in not allowed";
    case "encryptionRequired":
      return "Needs a secure connection";
    case "unavailable":
      return "Server can't sign in now, retrying";
    case "throttled":
      return "Too many sign-ins, retrying later";
    default:
      return browser ? "Sign-in refused" : "Password rejected";
  }
}

/** Graph's refusals (ADR 0136, rule 11): `notAllowed` is the organisation's `403`. */
function graphRefusalLabel(refusal: SignInRefusal | undefined): string {
  switch (refusal) {
    case "signInAgain":
      return "Sign-in ended";
    case "notAllowed":
      return "Not allowed by your organisation";
    case "unavailable":
      return "Microsoft unavailable, retrying";
    case "throttled":
      return "Too many requests, retrying later";
    default:
      return "Sign-in refused";
  }
}

function graphErrorText(kind: string, message: string): string {
  switch (kind) {
    case "tls":
      return "Insecure connection refused";
    case "unreachable":
      return "Microsoft unreachable, retrying";
    case "credentials":
      return "Sign-in unavailable";
    default:
      return message === "" ? "Sync failed" : `Sync failed: ${message}`;
  }
}

function errorText(kind: string, message: string, browser: boolean): string {
  switch (kind) {
    case "tls":
      return "Insecure connection refused";
    case "unreachable":
      return "Server unreachable, retrying";
    case "credentials":
      return browser ? "Sign-in unavailable" : "Password unavailable";
    default:
      return message === "" ? "Sync failed" : `Sync failed: ${message}`;
  }
}

/** The state of everything at once, for the indicator in the header: errors first, then work. */
export function summarize(
  accounts: readonly AccountInfo[],
  statuses: Readonly<Record<string, SyncStatus>>,
): StatusSummary {
  if (accounts.length === 0) return { tone: "idle", text: "No account" };
  const all = accounts.map((a) => statuses[a.id] ?? a.status);
  const failed = accounts.find((a) => (statuses[a.id] ?? a.status).state === "error");
  if (failed) {
    return describeStatus(
      statuses[failed.id] ?? failed.status,
      browserSignInProvider({ transport: failed.transport, imap: { host: failed.host } }) !==
        undefined,
      failed.transport === "graph",
    );
  }
  const busy = all.find((s) => s.state === "syncing");
  if (busy) return describeStatus(busy);
  const last = Math.max(...all.map((s) => (s.state === "idle" ? (s.lastSyncMs ?? 0) : 0)));
  return describeStatus({ state: "idle", ...(last > 0 ? { lastSyncMs: last } : {}) });
}
