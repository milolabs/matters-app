import { Show } from "solid-js";
import type { DropTarget } from "./fileDrop.ts";

const files = (n: number) => (n > 0 ? `${n} ${n === 1 ? "file" : "files"}` : "files");

/**
 * What the window offers while files are dragged over it and no composer is open (ADR 0041,
 * rule 21): New message over the list's column and, with a thread open, Reply over the reader's.
 * It is always in the page and shown by the class on the body, so dragging causes no layout. Which
 * target is hovered comes from each target's own `dragenter`; `dragover` changes nothing.
 */
export function DropOverlay(props: {
  /** The list's width: the columns line up with the list and the reader. */
  listWidth: () => number;
  count: () => number;
  /** Who a reply would go to; null when no thread is open (then there is no Reply). */
  replyTo: () => string | null;
  hover: () => DropTarget | null;
  setHover: (target: DropTarget | null) => void;
}) {
  return (
    <div data-drop-overlay aria-hidden="true" class="drop-overlay absolute inset-0 z-30">
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drag target in a layer hidden from assistive technology */}
      <div
        data-drop-target="new"
        class="drop-target"
        classList={{ "flex-1": props.replyTo() === null }}
        style={props.replyTo() === null ? undefined : { width: `${props.listWidth()}px` }}
        data-hover={props.hover() === "new" ? "" : undefined}
        onDragEnter={() => props.setHover("new")}
      >
        <p class="m-0 font-serif text-[22px]">New message</p>
        <p class="m-0 text-[13px] text-secondary">with {files(props.count())}</p>
      </div>
      <Show when={props.replyTo()}>
        {(name) => (
          // biome-ignore lint/a11y/noStaticElementInteractions: a drag target in a layer hidden from assistive technology
          <div
            data-drop-target="reply"
            class="drop-target flex-1"
            data-hover={props.hover() === "reply" ? "" : undefined}
            onDragEnter={() => props.setHover("reply")}
          >
            <p class="m-0 font-serif text-[22px]">Reply</p>
            <p class="m-0 text-[13px] text-secondary">
              to {name()}, with {files(props.count())}
            </p>
          </div>
        )}
      </Show>
    </div>
  );
}
