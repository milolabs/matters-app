/**
 * A message's frame fitted to its content (ADR 0024): a wide layout shrinks to the frame's width,
 * as it would on a phone, and the frame is as tall as what it holds. The reader's frame and the
 * print view's frames (ADR 0144) are fitted by this one function.
 */
export function fitMailFrame(frame: HTMLIFrameElement, doc: Document): void {
  const root = doc.documentElement;
  root.style.zoom = "1";
  const width = frame.clientWidth;
  const needed = root.scrollWidth;
  if (needed > width && width > 0) root.style.zoom = String(width / needed);
  frame.style.height = `${Math.ceil(root.getBoundingClientRect().height)}px`;
}
