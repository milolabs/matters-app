import { createSignal, type JSX, onCleanup, onMount } from "solid-js";

/** The widest a menu gets (`.vmenu`), so one opened near the edge stays inside the window. */
export const MENU_WIDTH = 280;

/** Where a menu opens, in window coordinates, kept inside the window. */
export function menuPoint(x: number, y: number): { x: number; y: number } {
  return { x: Math.max(4, Math.min(x, window.innerWidth - MENU_WIDTH - 4)), y };
}

/** A small menu under a button (`.vmenu`): arrows move, Esc and Tab close, a press outside closes. */
export function PopMenu(props: {
  label: string;
  x: number;
  y: number;
  /** `restoreFocus`: the keyboard closed it, so the opener takes the focus back. */
  onClose: (restoreFocus: boolean) => void;
  children: JSX.Element;
}) {
  let el!: HTMLDivElement;
  const items = () => [...el.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];

  onMount(() => {
    items()[0]?.focus();
    // A long menu opened low in the window stays inside it.
    const over = el.getBoundingClientRect().bottom - (window.innerHeight - 4);
    if (over > 0) el.style.top = `${Math.max(4, props.y - over)}px`;
    // A press outside the menu closes it; the press itself still does its work.
    const outside = (e: MouseEvent) => {
      if (!el.contains(e.target as Node)) props.onClose(false);
    };
    document.addEventListener("mousedown", outside, true);
    onCleanup(() => document.removeEventListener("mousedown", outside, true));
  });

  function onKeyDown(e: KeyboardEvent) {
    // The menu's keys are the menu's: none reach the mail window's shortcuts.
    e.stopPropagation();
    const list = items();
    const at = list.indexOf(document.activeElement as HTMLButtonElement);
    switch (e.key) {
      case "Escape":
      case "Tab":
        e.preventDefault();
        props.onClose(true);
        break;
      case "ArrowDown":
        e.preventDefault();
        list[(at + 1) % list.length]?.focus();
        break;
      case "ArrowUp":
        e.preventDefault();
        list[(at - 1 + list.length) % list.length]?.focus();
        break;
      case "Home":
        e.preventDefault();
        list[0]?.focus();
        break;
      case "End":
        e.preventDefault();
        list[list.length - 1]?.focus();
        break;
    }
  }

  return (
    <div
      ref={el}
      role="menu"
      aria-label={props.label}
      class="vmenu"
      style={{ left: `${props.x}px`, top: `${props.y}px` }}
      onKeyDown={onKeyDown}
      onFocusOut={(e) => {
        if (!e.relatedTarget || !el.contains(e.relatedTarget as Node)) props.onClose(false);
      }}
    >
      {props.children}
    </div>
  );
}

/** A button that opens a `PopMenu` under itself and gets the focus back when the keyboard closes it. */
export function createMenuAnchor() {
  const [at, setAt] = createSignal<{ x: number; y: number } | null>(null);
  let opener: HTMLElement | undefined;
  return {
    at,
    open(button: HTMLElement) {
      opener = button;
      const r = button.getBoundingClientRect();
      setAt(menuPoint(r.left, r.bottom + 2));
    },
    close(restoreFocus: boolean) {
      setAt(null);
      if (restoreFocus) queueMicrotask(() => opener?.focus());
    },
  };
}
