import { createEffect, onCleanup } from "solid-js";
import { progress, sendKey } from "./progress.ts";
import type { DotKind } from "./sendView.ts";

/**
 * The dot of a send, in the place the tray's dot always had (ADR 0041, rule 22). Under 1 MiB it is
 * the 6 px dot it was; from there it is 10 px, because a ring cannot be read any smaller. The ring
 * is a conic gradient driven by one CSS variable that progress sets on this element directly, so
 * the bytes sent never pass through a signal.
 */
export function SendDot(props: {
  kind: DotKind;
  small: boolean;
  operationId: string;
  /** For `drain`: when the undo window ends. */
  notBeforeMs: number;
  /** The words beside the ring that progress rewrites (the "14 of 34 MB"). */
  text?: () => HTMLElement | undefined;
}) {
  let el!: HTMLSpanElement;

  createEffect(() => {
    if (props.kind !== "ring") return;
    const off = progress.bind(sendKey(props.operationId), { ring: el, text: props.text?.() });
    onCleanup(off);
  });
  // The drain starts where the window stands, not at ten seconds, if the line appears late.
  createEffect(() => {
    if (props.kind !== "drain") return;
    const left = Math.max(0, props.notBeforeMs - Date.now());
    el.style.setProperty("--dwell", `${left}ms`);
  });

  const large = (kind: DotKind) => !props.small && props.kind === kind;
  const small = (kind: DotKind) => props.small && props.kind === kind;
  return (
    <span
      ref={el}
      aria-hidden="true"
      data-dot={props.kind}
      class={props.small ? "size-1.5 shrink-0 rounded-full" : "sdot"}
      classList={{
        // Under 1 MiB: the dot as it always was.
        "bg-secondary animate-pulse": small("pulse"),
        "bg-good": small("good"),
        "bg-late": small("late"),
        "sdot-drain": large("drain"),
        "sdot-breathe": large("breathe"),
        "sdot-ring": large("ring"),
        "sdot-full": large("full"),
        "sdot-good": large("good"),
        "sdot-hollow": large("hollow"),
        "sdot-late": large("late"),
        "sdot-half": large("half"),
      }}
    />
  );
}
