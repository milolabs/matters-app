/**
 * The keys of the runtimes billed to the person's own key, as the service sees them (ADR 0141,
 * rules 5 and 6). Two rules live here, so every path goes through them:
 *
 * - The commands that change a runtime's key or its reading switch run one at a time for that
 *   runtime (`serial`). A command that fails does not hold up the next, and the commands of two
 *   runtimes do not wait on each other.
 * - A turn, a look or a test takes a ticket when it begins (`ticket`), and what it learned is kept
 *   only while that ticket holds (`holds`): the key it began on is still the runtime's key, and
 *   no save or removal of it is under way. Saving or removing a key gives the runtime a new key
 *   twice, before the vault is written (`next`) and as its write ends (`change`), and no ticket
 *   holds while it is written, so one taken before or meanwhile holds for neither key, at no
 *   moment.
 *   What a turn found is written only through `keep`, which checks the ticket as the write begins,
 *   after every wait before it.
 * - Work no press of the person's started takes its ticket before it reads what it decides from,
 *   and is sent only while `mayGoInBackground` says so, with nothing awaited between: the key
 *   holds, and the reading switch was not turned off since (`readingOff`, before the switch is
 *   written and once it is). What it read of the switch was then the switch of that key, as it
 *   still is. Its turns also run on `backgroundSignal`, which the same stop aborts, so one already
 *   sent stops too; no turn the person asked for runs on it, so the switch never stops theirs.
 *
 * A runtime with no key never gets a new one, so its tickets always hold.
 */

declare const issued: unique symbol;

/** The key a turn, a look or a test of one runtime began on. Only `RuntimeKeys` makes one. */
export interface KeyTicket {
  readonly runtimeId: string;
  readonly generation: number;
  /** How often the runtime's reading switch had been turned off when the ticket was taken. */
  readonly readingOffs: number;
  readonly [issued]: true;
}

export class RuntimeKeys {
  private readonly generations = new Map<string, number>();
  private readonly readingOffs = new Map<string, number>();
  /** Aborted with every new key: what runs on the key before stops. */
  private readonly stops = new Map<string, AbortController>();
  /** Aborted with every stop of the background: what runs there and no press started stops. */
  private readonly backgroundStops = new Map<string, AbortController>();
  /** The last command of each runtime, settled: the next one starts after it. */
  private readonly queues = new Map<string, Promise<void>>();
  /** The save or removal of a key under way for a runtime, settled when it ends. */
  private readonly changing = new Map<string, Promise<void>>();

  /** The key of a runtime now, for what begins now. */
  ticket(runtimeId: string): KeyTicket {
    return {
      runtimeId,
      generation: this.generations.get(runtimeId) ?? 0,
      readingOffs: this.readingOffs.get(runtimeId) ?? 0,
    } as KeyTicket;
  }

  /**
   * Whether the key a ticket was taken on is still the runtime's key, with no save or removal of
   * it under way.
   */
  holds(ticket: KeyTicket): boolean {
    return (
      !this.changing.has(ticket.runtimeId) &&
      (this.generations.get(ticket.runtimeId) ?? 0) === ticket.generation
    );
  }

  /**
   * Whether work no press of the person's started may be sent now on the ticket's key: the key
   * holds, and its reading switch was not turned off since the ticket was taken. Asked with nothing
   * awaited between it and the request.
   */
  mayGoInBackground(ticket: KeyTicket): boolean {
    return (
      this.holds(ticket) && (this.readingOffs.get(ticket.runtimeId) ?? 0) === ticket.readingOffs
    );
  }

  /** The runtime's reading switch goes off: the background stops (`stopBackground`). */
  readingOff(runtimeId: string): void {
    this.stopBackground(runtimeId);
  }

  /**
   * The background on the runtime stops: no work of a ticket taken before goes, and what runs on
   * `backgroundSignal` stops. A turn the person asked for goes on.
   */
  stopBackground(runtimeId: string): void {
    this.readingOffs.set(runtimeId, (this.readingOffs.get(runtimeId) ?? 0) + 1);
    this.backgroundStops.get(runtimeId)?.abort();
    this.backgroundStops.set(runtimeId, new AbortController());
  }

  /**
   * A signal aborted when the background on the runtime stops. Taken at the same moment as a
   * ticket, it is aborted whenever `mayGoInBackground` stops saying yes for that ticket while the
   * key holds. Only work no press of the person's started runs on it.
   */
  backgroundSignal(runtimeId: string): AbortSignal {
    let stop = this.backgroundStops.get(runtimeId);
    if (stop === undefined) {
      stop = new AbortController();
      this.backgroundStops.set(runtimeId, stop);
    }
    return stop.signal;
  }

  /**
   * Writes what was found on a ticket's key only while that key is still the runtime's, checked as
   * the write begins, so after every wait before it. Null when it no longer holds: nothing is
   * written. What counts what was sent (the ledger) is not written through here: it always counts.
   */
  async keep<T>(ticket: KeyTicket, write: () => Promise<T>): Promise<{ readonly value: T } | null> {
    if (!this.holds(ticket)) return null;
    return { value: await write() };
  }

  /**
   * A signal aborted when the runtime's key changes. Taken at the same moment as a ticket, it is
   * aborted whenever that ticket stops holding.
   */
  stopSignal(runtimeId: string): AbortSignal {
    let stop = this.stops.get(runtimeId);
    if (stop === undefined) {
      stop = new AbortController();
      this.stops.set(runtimeId, stop);
    }
    return stop.signal;
  }

  /** The runtime has a new key: no ticket taken before holds, and what runs on them stops. */
  next(runtimeId: string): void {
    this.generations.set(runtimeId, (this.generations.get(runtimeId) ?? 0) + 1);
    this.stops.get(runtimeId)?.abort();
    this.stops.set(runtimeId, new AbortController());
  }

  /**
   * Writes a new key of a runtime, or its removal, in the vault: no ticket holds while it is
   * written, and the runtime has a new key once it has ended, worked or not. The new key and the
   * end of the write are one step, so nothing a ticket taken before found is kept in between.
   */
  async change<T>(runtimeId: string, write: () => Promise<T>): Promise<T> {
    let ended = () => {};
    this.changing.set(
      runtimeId,
      new Promise<void>((resolve) => {
        ended = resolve;
      }),
    );
    try {
      return await write();
    } finally {
      this.changing.delete(runtimeId);
      this.next(runtimeId);
      ended();
    }
  }

  /** Settles once no save or removal of the runtime's key is under way. */
  async quiet(runtimeId: string): Promise<void> {
    await this.changing.get(runtimeId);
  }

  /**
   * Runs a command once every command of this runtime asked for before it has ended, whether it
   * worked or not. The command reads what it needs when it runs, not when it was asked for.
   */
  serial<T>(runtimeId: string, command: () => Promise<T>): Promise<T> {
    const before = this.queues.get(runtimeId) ?? Promise.resolve();
    const run = before.then(command);
    const settled = run.then(
      () => {},
      () => {},
    );
    this.queues.set(runtimeId, settled);
    void settled.then(() => {
      if (this.queues.get(runtimeId) === settled) this.queues.delete(runtimeId);
    });
    return run;
  }
}
