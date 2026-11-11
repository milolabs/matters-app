import { createSignal, onCleanup } from "solid-js";

/**
 * The window's width from `innerWidth`, which reads no layout, kept up to date on resize. The
 * first read is before the first paint, so nothing that depends on it jumps at launch. Create it
 * once, before what needs it: the agent's column, the list's width and the divider all share it.
 */
export function createWindowWidth(): () => number {
  const [width, setWidth] = createSignal(window.innerWidth);
  const onResize = () => setWidth(window.innerWidth);
  window.addEventListener("resize", onResize);
  onCleanup(() => window.removeEventListener("resize", onResize));
  return width;
}
