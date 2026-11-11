/**
 * Asks each outgoing server for its message limit once per session (ADR 0040, rule 4), in the
 * background, when a message is prepared for an account whose limit is not known yet. The answer
 * is stored by the worker; `onFound` tells the windows.
 */
export class LimitProbe {
  private readonly tried = new Set<string>();
  private readonly run: (accountId: string) => Promise<number | null>;
  private readonly onFound: (accountId: string, limitBytes: number) => void;

  constructor(
    run: (accountId: string) => Promise<number | null>,
    onFound: (accountId: string, limitBytes: number) => void,
  ) {
    this.run = run;
    this.onFound = onFound;
  }

  /** Starts the probe unless the limit is known, the account cannot send or it was tried. */
  ensure(account: { id: string; canSend: boolean; messageLimitBytes?: number }): void {
    if (account.messageLimitBytes !== undefined || !account.canSend) return;
    if (this.tried.has(account.id)) return;
    this.tried.add(account.id);
    this.run(account.id).then(
      (limit) => {
        if (limit !== null) this.onFound(account.id, limit);
      },
      () => {
        // A server that cannot be asked now is asked again by the next send; not worth a retry.
      },
    );
  }
}
