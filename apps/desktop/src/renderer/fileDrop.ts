// Files dragged over the window and dropped on it (ADR 0041, rules 1 and 21). Two small pieces:
// the tracker, which knows whether a file drag is over the window and changes one class on
// `document.body` and nothing else, and the router, which pairs a drop's provisional chips with
// the grants the preload answers a moment later.
import type { PickedFile } from "@matters/contracts";
import type { ComposerSession, DropBatch } from "./compose.ts";

/** The class on `document.body` while files are over the window; CSS does the rest. */
export const DRAGGING_CLASS = "dragging-files";

/** Only a drag of files is ours: text dragged inside the editor must be left alone. */
export function hasFiles(
  transfer: { readonly types: ArrayLike<string> | Iterable<string> } | null | undefined,
): boolean {
  if (!transfer) return false;
  return Array.from(transfer.types as Iterable<string>).includes("Files");
}

/** What a drag event gives the tracker. */
export interface DragLike {
  readonly dataTransfer: {
    readonly types: ArrayLike<string> | Iterable<string>;
    readonly items?: { readonly length: number };
    dropEffect: string;
  } | null;
  readonly clientX?: number;
  readonly clientY?: number;
  preventDefault(): void;
}

export interface DragTracker {
  enter(event: DragLike): void;
  leave(event: DragLike): void;
  /** Only `preventDefault` and the effect: nothing may change on `dragover`. */
  over(event: DragLike): void;
  /** A drop, Escape or a drag that ended elsewhere. */
  clear(): void;
  active(): boolean;
}

/**
 * `dragenter` and `dragleave` fire for every child the pointer crosses, so a counter, not a
 * boolean, says whether the drag is still inside. A drag that leaves through the window's edge
 * also ends it, whatever the counter says, because the browser can skip a `dragleave`.
 */
export function createDragTracker(
  surface: {
    /** `document.body`'s class list. */
    readonly classList: { add(name: string): void; remove(name: string): void };
  },
  options: {
    /** How many files are dragged, when the browser says; 0 when it does not. */
    onEnter?: (count: number) => void;
    onClear?: () => void;
    bounds?: () => { width: number; height: number };
  } = {},
): DragTracker {
  let depth = 0;
  let shown = false;
  const clear = () => {
    depth = 0;
    if (!shown) return;
    shown = false;
    surface.classList.remove(DRAGGING_CLASS);
    options.onClear?.();
  };
  const outside = (e: DragLike) => {
    const b = options.bounds?.();
    if (!b || e.clientX === undefined || e.clientY === undefined) return false;
    return e.clientX <= 0 || e.clientY <= 0 || e.clientX >= b.width || e.clientY >= b.height;
  };
  return {
    enter(e) {
      if (!hasFiles(e.dataTransfer)) return;
      depth++;
      if (!shown) {
        shown = true;
        surface.classList.add(DRAGGING_CLASS);
        options.onEnter?.(e.dataTransfer?.items?.length ?? 0);
      }
    },
    leave(e) {
      if (!shown || !hasFiles(e.dataTransfer)) return;
      depth--;
      if (depth <= 0 || outside(e)) clear();
    },
    over(e) {
      if (!hasFiles(e.dataTransfer) || !e.dataTransfer) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    clear,
    active: () => shown,
  };
}

/** Where a drop with no composer open goes. */
export type DropTarget = "new" | "reply";

/**
 * Pairs the page's own view of a drop (names and sizes, in the frame of the drop) with the
 * preload's grants (`dropId`, counting trusted drops with files from 1). Both count the same
 * drops: `drop` here is called for every trusted drop that carries files, as the preload does.
 */
export function createDropRouter(deps: {
  session(): ComposerSession | null;
  /** Opens the composer the drop asked for; resolves when `session()` can answer. */
  open(target: DropTarget): Promise<void>;
}) {
  interface Entry {
    batch: DropBatch | null;
    granted: readonly PickedFile[] | null;
  }
  const entries = new Map<number, Entry>();
  let seq = 0;

  function settle(id: number, entry: Entry) {
    if (!entry.batch || !entry.granted) return;
    entries.delete(id);
    entry.batch.fill(entry.granted);
  }

  return {
    /** A trusted drop of files. `target` is where it landed when no composer is open. */
    drop(files: readonly { name: string; size: number }[], target: DropTarget): void {
      const id = ++seq;
      const entry: Entry = { batch: null, granted: null };
      entries.set(id, entry);
      const attach = (session: ComposerSession) => {
        entry.batch = session.attachDropped(files);
        settle(id, entry);
      };
      const open = deps.session();
      if (open) {
        attach(open);
        return;
      }
      void deps.open(target).then(() => {
        const session = deps.session();
        if (session) attach(session);
        else entries.delete(id);
      });
    },
    /** The preload's answer for a drop. */
    granted(dropId: number, files: readonly PickedFile[]): void {
      const entry = entries.get(dropId);
      if (!entry) return;
      entry.granted = files;
      settle(dropId, entry);
    },
    /** For tests: drops still waiting for something. */
    waiting: () => entries.size,
  };
}

/** The `data-drop-target` the pointer was over, from the event's path. */
export function dropTargetOf(path: readonly EventTarget[]): DropTarget {
  for (const node of path) {
    const value = (node as { dataset?: { dropTarget?: string } }).dataset?.dropTarget;
    if (value === "reply") return "reply";
    if (value === "new") return "new";
  }
  return "new";
}

/** What `installFileDrop` needs of the page; the real `window` and `document.body` fit it. */
export type DropPage = Pick<
  Window,
  "addEventListener" | "removeEventListener" | "innerWidth" | "innerHeight"
>;

export interface DropEventLike extends DragLike {
  readonly isTrusted: boolean;
  readonly dataTransfer:
    | (NonNullable<DragLike["dataTransfer"]> & { readonly files: ArrayLike<File> })
    | null;
  readonly target: unknown;
  composedPath(): readonly EventTarget[];
  stopPropagation(): void;
}

/**
 * Listens for file drags on the whole window. `dragover` changes nothing but the drop effect, so
 * dragging costs no layout; entering sets one class on the body and the count the overlay shows.
 * The signals are only the overlay's: how many files, and which target the pointer is on.
 */
export function installFileDrop(
  deps: {
    session(): ComposerSession | null;
    open(target: DropTarget): Promise<void>;
    /** The preload's grants; `onDropped` of files.ts. */
    onGranted(
      listener: (drop: { dropId: number; files: readonly PickedFile[] }) => void,
    ): () => void;
    page: DropPage;
    body: { readonly classList: { add(name: string): void; remove(name: string): void } };
  },
  state: {
    setCount(n: number): void;
    setHover(target: DropTarget | null): void;
  },
) {
  const { page } = deps;
  const router = createDropRouter({ session: deps.session, open: deps.open });
  const tracker = createDragTracker(deps.body, {
    onEnter: state.setCount,
    onClear: () => state.setHover(null),
    bounds: () => ({ width: page.innerWidth, height: page.innerHeight }),
  });

  const onEnter = (e: DragLike) => tracker.enter(e);
  const onLeave = (e: DragLike) => tracker.leave(e);
  const onOver = (e: DragLike) => tracker.over(e);
  const onDrop = (e: DropEventLike) => {
    tracker.clear();
    // The preload counts trusted drops that carry files, and so does this: the counts pair up.
    if (!e.isTrusted || !e.dataTransfer || e.dataTransfer.files.length === 0) return;
    const files = Array.from(e.dataTransfer.files, (f) => ({ name: f.name, size: f.size }));
    // Nothing else in the page (the editor reads dropped files as text) may see this drop.
    e.preventDefault();
    e.stopPropagation();
    router.drop(files, dropTargetOf(e.composedPath()));
  };
  const onKey = (e: { key: string }) => {
    if (e.key === "Escape") tracker.clear();
  };
  const onBlur = () => tracker.clear();

  // Capture, so that a child that stops the event cannot hide the end of a drag from the counter.
  const handlers: [string, (event: never) => void, boolean][] = [
    ["dragenter", onEnter, true],
    ["dragleave", onLeave, true],
    ["dragover", onOver, true],
    ["drop", onDrop, true],
    ["keydown", onKey, true],
    ["blur", onBlur, false],
  ];
  for (const [type, fn, capture] of handlers) {
    page.addEventListener(type, fn as unknown as EventListener, capture);
  }
  const offGrants = deps.onGranted(({ dropId, files }) => router.granted(dropId, files));

  return {
    tracker,
    router,
    dispose() {
      for (const [type, fn, capture] of handlers) {
        page.removeEventListener(type, fn as unknown as EventListener, capture);
      }
      offGrants();
      tracker.clear();
    },
  };
}
