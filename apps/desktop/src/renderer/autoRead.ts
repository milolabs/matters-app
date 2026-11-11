/**
 * When opening a thread makes it read (ADR 0039). Pure: the timer is injected and nothing here
 * knows about the store or the DOM.
 *
 * A thread becomes read after it has stayed selected for `DWELL_MS`, and only if the reader chose
 * it: j/k, a click, an arrow in the list. The app also selects by itself (the first row at
 * start, the row that takes the place of one that went away after a refresh, the first result of
 * a view or a search), and that must never mark anything read, or launching the app would read
 * the newest mail.
 */

/**
 * Long enough that j/k through a list reads nothing (a held key repeats at about 30 ms, and
 * glancing at a subject takes a second), short enough that the reader has not moved on and
 * forgotten it was unread.
 */
export const DWELL_MS = 1500;

export interface AutoReadOptions {
  readonly dwellMs?: number;
  /** Returns the function that cancels the timer. */
  readonly setTimeout: (run: () => void, delayMs: number) => () => void;
  /** The thread stayed selected long enough, with the window focused. */
  readonly onDwell: (threadId: string) => void;
  /** The thread being counted, or `null` when none is: what the list draws while it waits. */
  readonly onCounting?: (threadId: string | null) => void;
}

export interface AutoRead {
  /** The reader chose this thread. Choosing the thread that is already selected changes nothing. */
  chose(threadId: string): void;
  /** The selection landed somewhere by itself, or nowhere (`null`): nothing is counted for it. */
  displaced(threadId: string | null): void;
  /**
   * The reader marked the thread themselves (`u`): the countdown stops, and the thread is not
   * marked again until they select another and come back. A message that arrives in a thread
   * that is open therefore stays unread, and so does one that was just marked unread.
   */
  settled(threadId: string): void;
  /** Counting happens only while the window has focus: blur cancels, focus starts it over. */
  focus(focused: boolean): void;
  /** Cancels the timer. */
  dispose(): void;
}

export function createAutoRead(options: AutoReadOptions): AutoRead {
  const dwellMs = options.dwellMs ?? DWELL_MS;
  let thread: string | null = null;
  // The reader chose the selected thread (as opposed to the app).
  let deliberate = false;
  // The countdown ran out, or the reader marked it themselves: it is not counted again.
  let done = false;
  let focused = true;
  let cancel: (() => void) | null = null;

  const stop = () => {
    if (!cancel) return;
    cancel();
    cancel = null;
    options.onCounting?.(null);
  };

  function start() {
    stop();
    if (thread === null || !deliberate || done || !focused) return;
    const mine = thread;
    cancel = options.setTimeout(() => {
      cancel = null;
      // In this order: the mail turns read first, or its dot would show whole for a moment.
      if (thread === mine && !done) {
        done = true;
        options.onDwell(mine);
      }
      options.onCounting?.(null);
    }, dwellMs);
    options.onCounting?.(mine);
  }

  return {
    chose(threadId) {
      if (threadId === thread) {
        // The app selected it and the reader now clicks it: from here it is theirs.
        if (!deliberate) {
          deliberate = true;
          start();
        }
        return;
      }
      thread = threadId;
      deliberate = true;
      done = false;
      start();
    },
    displaced(threadId) {
      // Landing on the thread that is already selected (a row of it went away) changes nothing.
      if (threadId !== null && threadId === thread) return;
      stop();
      thread = threadId;
      deliberate = false;
      done = false;
    },
    settled(threadId) {
      if (threadId !== thread) return;
      stop();
      done = true;
    },
    focus(value) {
      // A repeated event must not start a countdown over.
      if (value === focused) return;
      focused = value;
      if (value) start();
      else stop();
    },
    dispose: stop,
  };
}
