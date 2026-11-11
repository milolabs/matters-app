/**
 * Why talking to a mail server or the credential vault failed, in terms a user can act on.
 * Adapters expose it as a `kind` property on their errors; the core never imports them.
 */
export type MailErrorKind = "auth" | "tls" | "unreachable" | "insecure" | "credentials" | "other";

const KINDS: ReadonlySet<string> = new Set([
  "auth",
  "tls",
  "unreachable",
  "insecure",
  "credentials",
]);

export function mailErrorKind(error: unknown): MailErrorKind {
  const kind = (error as { kind?: unknown } | null)?.kind;
  return typeof kind === "string" && KINDS.has(kind) ? (kind as MailErrorKind) : "other";
}

/** `safeStorage` (or its equivalent) cannot protect a password on this machine. */
export class CredentialsUnavailableError extends Error {
  readonly kind = "credentials";
  constructor(reason: string) {
    super(reason);
    this.name = "CredentialsUnavailableError";
  }
}

export class AccountExistsError extends Error {
  constructor(address: string) {
    super(`An account for ${address} already exists`);
    this.name = "AccountExistsError";
  }
}

/** Replaces every secret in `text`; error messages travel to the UI and into logs. */
export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) if (secret.length > 0) out = out.split(secret).join("***");
  return out;
}

/** A saved view was refused (ADR 0027). The message is for the person at the keyboard. */
export class InvalidViewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidViewError";
  }
}

export class ViewNotFoundError extends Error {
  constructor() {
    super("That view no longer exists.");
    this.name = "ViewNotFoundError";
  }
}

/** An image rule, setting or import was refused (ADR 0037). */
export class InvalidImageRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidImageRuleError";
  }
}

export class DraftNotFoundError extends Error {
  constructor() {
    super("The draft no longer exists");
    this.name = "DraftNotFoundError";
  }
}

/**
 * Why file work failed (ADR 0041). The work runs in a worker thread, so a caller tells the kinds
 * apart by `kind` and the error's name, not by class identity.
 * - `unreadable`: the original is gone or cannot be read.
 * - `noSpace`: the disk is full.
 * - `isDirectory`: a folder cannot be attached.
 * - `missing`: a stored copy needed for a message is gone or does not match its hash.
 */
export type FileWorkErrorKind = "unreadable" | "noSpace" | "isDirectory" | "missing";

export class FileWorkError extends Error {
  readonly kind: FileWorkErrorKind;
  /** The file's name as the user knows it; set when the error is about one file of a message. */
  readonly file?: string;
  constructor(kind: FileWorkErrorKind, message: string, file?: string) {
    super(message);
    this.name = "FileWorkError";
    this.kind = kind;
    if (file !== undefined) this.file = file;
  }
}

export function isFileWorkError(error: unknown): error is FileWorkError {
  const e = error as { name?: unknown; kind?: unknown } | null;
  return e?.name === "FileWorkError" && typeof e.kind === "string";
}

/**
 * Why an agent runtime could not answer (ADR 0051). Messages never hold mail text or what the
 * runtime said, since they travel to logs; `code` is what a caller acts on.
 * - `notSignedIn`: the person has no login with the runtime.
 * - `notPlan`: the turn would not run on the person's plan (for instance an API key is in use).
 * - `limit`: the plan's allowance is used up for now.
 * - `refused`: the model declined to answer.
 * - `badAnswer`: it answered, but not in the shape asked for.
 * - `failed`: anything else, including a timeout, a missing program and a cancelled run.
 */
export type AgentRunErrorCode =
  | "notSignedIn"
  | "notPlan"
  | "limit"
  | "refused"
  | "badAnswer"
  | "failed";

export class AgentRunError extends Error {
  readonly code: AgentRunErrorCode;
  constructor(code: AgentRunErrorCode, message: string) {
    super(message);
    this.name = "AgentRunError";
    this.code = code;
  }
}

const RUN_ERROR_CODES: ReadonlySet<string> = new Set([
  "notSignedIn",
  "notPlan",
  "limit",
  "refused",
  "badAnswer",
  "failed",
]);

/** By name and code, not class identity: adapters may be bundled apart from the core. */
export function isAgentRunError(error: unknown): error is AgentRunError {
  const e = error as { name?: unknown; code?: unknown } | null;
  return e?.name === "AgentRunError" && typeof e.code === "string" && RUN_ERROR_CODES.has(e.code);
}
