import { createEffect, onMount } from "solid-js";

/**
 * Shows the message as it will be sent. The frame is a page of our own with a policy that allows
 * inline styles (the sent HTML carries them) and nothing else: no script, no image, no network.
 * It is sandboxed without `allow-scripts`, so nothing in it can run; `allow-same-origin` only
 * lets this page hand it the HTML. The main page's policy stays as strict as it was.
 */
export function PreviewFrame(props: { html: string }) {
  let frame!: HTMLIFrameElement;

  const paint = () => {
    const doc = frame.contentDocument;
    if (!doc || doc.URL === "about:blank") return;
    doc.documentElement.innerHTML = props.html;
    frame.dataset.painted = String(props.html.length);
  };

  onMount(() => {
    frame.addEventListener("load", paint);
    if (frame.contentDocument?.readyState === "complete") paint();
  });
  createEffect(() => {
    void props.html;
    paint();
  });

  return (
    <iframe
      ref={frame}
      title="Preview of the message"
      sandbox="allow-same-origin"
      src="./preview.html"
      class="h-full w-full rounded-[9px] border border-hairline bg-white"
    />
  );
}
