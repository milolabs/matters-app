import type { AccountInfo } from "@matters/contracts";
import type { SignInRefusal, SyncStatus } from "@matters/core";

export type Tone = "idle" | "busy" | "error";

export interface StatusSummary {
  readonly tone: Tone;
  readonly text: string;
}

const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });

/** A one-line description of one account's sync state. */
export function describeStatus(status: SyncStatus): StatusSummary {
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
            ? refusalLabel(status.detail?.refusal)
            : errorText(status.kind, status.message),
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
function refusalLabel(refusal: SignInRefusal | undefined): string {
  switch (refusal) {
    case "appPassword":
      return "App password needed";
    case "expired":
      return "Password expired";
    case "webLogin":
      return "Sign in on the website first";
    case "imapOff":
      return "IMAP is turned off";
    case "browserOnly":
      return "Needs browser sign-in";
    case "notAllowed":
      return "Sign-in not allowed";
    case "encryptionRequired":
      return "Needs a secure connection";
    case "unavailable":
      return "Server can't sign in now, retrying";
    case "throttled":
      return "Too many sign-ins, retrying later";
    default:
      return "Password rejected";
  }
}

function errorText(kind: string, message: string): string {
  switch (kind) {
    case "tls":
      return "Insecure connection refused";
    case "unreachable":
      return "Server unreachable, retrying";
    case "credentials":
      return "Password unavailable";
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
  const error = all.find((s) => s.state === "error");
  if (error) return describeStatus(error);
  const busy = all.find((s) => s.state === "syncing");
  if (busy) return describeStatus(busy);
  const last = Math.max(...all.map((s) => (s.state === "idle" ? (s.lastSyncMs ?? 0) : 0)));
  return describeStatus({ state: "idle", ...(last > 0 ? { lastSyncMs: last } : {}) });
}
