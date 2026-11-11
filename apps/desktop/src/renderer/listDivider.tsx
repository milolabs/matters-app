import { createMemo, createSignal, onCleanup } from "solid-js";
import {
  draggedListWidth,
  fitListWidth,
  keyedListWidth,
  LIST_DEFAULT,
  LIST_MAX,
  LIST_MIN,
  listBesidePane,
  listMax,
  readListWidth,
  writeListWidth,
} from "./listWidth.ts";
import {
  draggedPaneWidth,
  fitPaneWidth,
  keyedPaneWidth,
  PANE_DEFAULT,
  PANE_MIN,
  paneMax,
  readPaneWide,
  readPaneWidth,
  writePaneWide,
  writePaneWidth,
} from "./paneWidth.ts";

const [dragging, setDragging] = createSignal(false);

/**
 * A drag of the list's line or the agent column's line is under way. The mail frame waits for its
 * end before measuring again (ADR 0038).
 */
export const listDragging = dragging;

export interface ListWidth {
  /** The width the list has now. */
  readonly width: () => number;
  /** The widest it can be in this window. */
  readonly max: () => number;
  /** Where a gesture puts the list, shown at once. */
  readonly show: (wanted: number) => void;
  /** Keeps the current choice for the next launch. */
  readonly remember: () => void;
  readonly windowWidth: () => number;
}

/**
 * The list's width. `besidePane` says whether the agent's column is shown beside it, and
 * `paneWidth` how wide that column is: the list gives way to both, and what was chosen stays.
 */
export function createListWidth(
  windowWidth: () => number,
  besidePane: () => boolean = () => false,
  paneWidth: () => number = () => PANE_DEFAULT,
): ListWidth {
  const [wanted, setWanted] = createSignal(readListWidth());
  return {
    // Beside the column the list may be drawn narrower; what was chosen stays in `wanted`.
    width: createMemo(() =>
      besidePane()
        ? listBesidePane(wanted(), windowWidth(), paneWidth())
        : fitListWidth(wanted(), windowWidth()),
    ),
    max: createMemo(() =>
      besidePane() ? listBesidePane(LIST_MAX, windowWidth(), paneWidth()) : listMax(windowWidth()),
    ),
    show: setWanted,
    remember: () => writeListWidth(wanted()),
    windowWidth,
  };
}

/** The width of the agent's column (ADR 0069), chosen by the person and fitted to the window. */
export interface PaneWidth {
  readonly width: () => number;
  readonly max: () => number;
  readonly show: (wanted: number) => void;
  readonly remember: () => void;
  readonly windowWidth: () => number;
  /** The column widened over almost the whole window, the list's avatars left as a strip. */
  readonly wide: () => boolean;
  readonly setWide: (wide: boolean) => void;
}

export function createPaneWidth(windowWidth: () => number): PaneWidth {
  const [wanted, setWanted] = createSignal(readPaneWidth());
  const [wide, setWide] = createSignal(readPaneWide());
  return {
    width: createMemo(() => fitPaneWidth(wanted(), windowWidth())),
    max: createMemo(() => paneMax(windowWidth())),
    show: setWanted,
    remember: () => writePaneWidth(wanted()),
    windowWidth,
    wide,
    setWide: (next) => {
      if (next === wide()) return;
      setWide(next);
      writePaneWide(next);
    },
  };
}

/** What differs between the two lines: the numbers and the side the line grows toward. */
interface GripSpec {
  readonly label: string;
  /** The attribute that finds this grip. */
  readonly marker: "data-list-divider" | "data-pane-divider";
  readonly min: number;
  readonly reset: number;
  /** Dragging right widens (1), or dragging left widens (-1). */
  readonly direction: 1 | -1;
  readonly dragged: (raw: number, windowWidth: number) => number;
  readonly keyed: (
    key: string,
    large: boolean,
    current: number,
    windowWidth: number,
  ) => number | null;
  readonly size: ListWidth | PaneWidth;
}

/**
 * The invisible grip both lines share: pointer capture, a double click to the default, and the
 * keys. The line it lies over has no width of its own.
 */
function Grip(props: { spec: GripSpec }) {
  const { spec } = props;
  const size = spec.size;
  let drag: { readonly startX: number; readonly startWidth: number; moved: boolean } | undefined;

  onCleanup(() => setDragging(false));

  function choose(width: number) {
    size.show(width);
    size.remember();
  }

  function endDrag() {
    if (drag?.moved) size.remember();
    drag = undefined;
    setDragging(false);
  }

  // At the end of its range the cursor points the only way the line can still go.
  const room = () => {
    const widest = spec.direction === 1 ? "list-divider-only-left" : "list-divider-only-right";
    const narrowest = spec.direction === 1 ? "list-divider-only-right" : "list-divider-only-left";
    return {
      [narrowest]: size.width() <= spec.min,
      [widest]: size.width() >= size.max(),
    };
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: an <hr> cannot take focus or hold a value
    <div
      role="separator"
      tabIndex={0}
      {...{ [spec.marker]: "" }}
      aria-orientation="vertical"
      aria-label={spec.label}
      aria-valuemin={spec.min}
      aria-valuemax={size.max()}
      aria-valuenow={size.width()}
      class="list-divider-grip"
      classList={room()}
      // A click here is not a reason to take the keys away from the list.
      onMouseDown={(e) => e.preventDefault()}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        // Capture keeps the gesture when the pointer passes over a message's frame.
        e.currentTarget.setPointerCapture(e.pointerId);
        drag = { startX: e.clientX, startWidth: size.width(), moved: false };
        setDragging(true);
      }}
      onPointerMove={(e) => {
        if (!drag) return;
        drag.moved = true;
        const raw = drag.startWidth + spec.direction * (e.clientX - drag.startX);
        size.show(spec.dragged(raw, size.windowWidth()));
      }}
      onLostPointerCapture={endDrag}
      onDblClick={() => choose(spec.reset)}
      onKeyDown={(e) => {
        const width = spec.keyed(e.key, e.shiftKey, size.width(), size.windowWidth());
        if (width === null) return;
        // The arrows and Enter also mean something to the window's keys.
        e.preventDefault();
        e.stopPropagation();
        choose(width);
      }}
    />
  );
}

/**
 * The line between the list and the reading pane. It has no width of its own: the list's border
 * stays the line, and a wider, invisible grip lies over it.
 */
export function ListDivider(props: { list: ListWidth }) {
  return (
    <div class="list-divider" classList={{ "list-divider-active": dragging() }}>
      <Grip
        spec={{
          label: "Message list width",
          marker: "data-list-divider",
          min: LIST_MIN,
          reset: LIST_DEFAULT,
          direction: 1,
          dragged: draggedListWidth,
          keyed: keyedListWidth,
          size: props.list,
        }}
      />
    </div>
  );
}

/**
 * The line on the left edge of the agent's column (ADR 0069). Dragging it to the left widens the
 * column. It lies inside the column, whose own border stays the line.
 */
export function PaneDivider(props: { pane: PaneWidth }) {
  return (
    <div class="list-divider pane-divider" classList={{ "list-divider-active": dragging() }}>
      <Grip
        spec={{
          label: "Agent column width",
          marker: "data-pane-divider",
          min: PANE_MIN,
          reset: PANE_DEFAULT,
          direction: -1,
          dragged: draggedPaneWidth,
          keyed: keyedPaneWidth,
          size: props.pane,
        }}
      />
    </div>
  );
}
