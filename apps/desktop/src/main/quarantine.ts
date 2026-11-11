// "From the internet" for files that leave the cache (ADR 0043, rule 14). On macOS the mark is the
// `com.apple.quarantine` extended attribute, so Gatekeeper still judges what the file turns out to
// be when it is opened. Windows and Linux need marks of their own before the app ships there.

/**
 * The attribute's value in the format the system and browsers write: flags, the time in hex
 * seconds, and the name of the app that fetched the file. `0081` is "downloaded", with the
 * first-open prompt on.
 */
export function quarantineValue(nowMs: number): string {
  return `0081;${Math.floor(nowMs / 1000).toString(16)};Matters;`;
}

export const QUARANTINE_ATTRIBUTE = "com.apple.quarantine";

export interface QuarantineDeps {
  readonly platform: string;
  /** Runs a program and rejects if it fails; `execFile`, in the app. */
  run(file: string, args: readonly string[]): Promise<void>;
  now(): number;
}

/** Marks a file as downloaded. Rejects when the mark could not be set; a platform with none resolves. */
export function createQuarantine(deps: QuarantineDeps): (path: string) => Promise<void> {
  return async (path) => {
    if (deps.platform !== "darwin") return;
    await deps.run("xattr", ["-w", QUARANTINE_ATTRIBUTE, quarantineValue(deps.now()), path]);
  };
}
