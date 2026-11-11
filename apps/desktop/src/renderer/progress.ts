// Progress is not data (ADR 0041, rule 5). A report sets one CSS variable, and the words beside
// it, on the elements that asked: no signal changes, so no list or line renders again. Reports
// come up to four times a second per file; the cost of each is one style change on one dot.

/** What a progress report may touch. Both are optional parts of a chip or a dot. */
export interface ProgressTarget {
  /** Gets `--p`, 0 to 1, for the ring's conic gradient. */
  readonly ring: Pick<HTMLElement, "style">;
  /** Its text is replaced with the label; it is not in a live region, so nothing reads it out. */
  readonly text?: Pick<HTMLElement, "textContent"> | null;
}

export function createProgressSink() {
  const targets = new Map<string, Set<ProgressTarget>>();
  // The last report of each key, for an element that appears after it (a line rendered late).
  const last = new Map<string, { fraction: number; label: string | undefined }>();

  function apply(target: ProgressTarget, fraction: number, label: string | undefined) {
    target.ring.style.setProperty("--p", String(Math.min(1, Math.max(0, fraction))));
    if (target.text && label !== undefined) target.text.textContent = label;
  }

  return {
    /** Starts feeding `target` with the reports of `key`; returns the way to stop. */
    bind(key: string, target: ProgressTarget): () => void {
      const set = targets.get(key) ?? new Set<ProgressTarget>();
      targets.set(key, set);
      set.add(target);
      const known = last.get(key);
      if (known) apply(target, known.fraction, known.label);
      return () => {
        set.delete(target);
        if (set.size === 0) targets.delete(key);
      };
    },
    report(key: string, fraction: number, label?: string): void {
      last.set(key, { fraction, label });
      for (const target of targets.get(key) ?? []) apply(target, fraction, label);
    },
    /** The key will not report again (its file is read, its send over). */
    forget(key: string): void {
      last.delete(key);
    },
  };
}

export type ProgressSink = ReturnType<typeof createProgressSink>;

/** The one the app uses; tests make their own. */
export const progress = createProgressSink();

export const chipKey = (attachmentId: string) => `chip:${attachmentId}`;
export const sendKey = (operationId: string) => `send:${operationId}`;
export const receivedKey = (messageKey: number, partId: string) =>
  `received:${messageKey}/${partId}`;
