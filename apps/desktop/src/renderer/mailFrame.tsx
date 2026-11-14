import { createEffect, createSignal, For, on, onCleanup, onMount } from "solid-js";
import { cssStringContent, type TextNode, visibleLinkText } from "./links.ts";
import { listDragging } from "./listDivider.tsx";

export interface MailLink {
  readonly text: string;
  readonly href: string;
}

interface Hit extends MailLink {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

const MAX_HITS = 2000;
/**
 * Pseudo-element reads (`getComputedStyle`) per measurement. Each is a style lookup; a message
 * with thousands of links must not pay for them. Past the budget a link is read without its
 * generated text.
 */
const MAX_PSEUDO_READS = 4000;
/**
 * Text can be drawn by CSS only from a rule whose selector names a pseudo-element. A backslash
 * counts too: `::bef\6fre` is `::before` to the browser. A false match costs only a few reads.
 */
const PSEUDO_SELECTOR = /before|after|\\/i;

/**
 * The frame's sandbox (ADR 0024): no `allow-scripts`; `allow-same-origin` only lets this page fill
 * and measure it. One constant, so the corpus's wall tests (tools/smoke-security.ts) put a message
 * into a frame that is sandboxed exactly like this one.
 */
export const MAIL_FRAME_SANDBOX: string | undefined = "allow-same-origin";

/**
 * Shows a sanitized message as its sender laid it out. The frame is a page of our own whose policy
 * allows inline styles and images only (`mail.html`, or `mail-images.html` once the reader allowed
 * images). It is sandboxed without `allow-scripts`, so nothing in it can run, which also means no
 * event listener runs there, ours included; `allow-same-origin` only lets this page fill and
 * measure it. So links are caught on this side: real links in this page lie exactly over the
 * message's, and those in the frame are taken out of the tab order.
 */
export function MailFrame(props: {
  html: string;
  /** The scheme the message's own media queries see (ADR 0085): the frame takes it from its element. */
  scheme: "light" | "dark";
  images: boolean;
  onLink: (link: MailLink) => void;
  onHoverLink: (href: string | null) => void;
}) {
  let frame!: HTMLIFrameElement;
  let observer: ResizeObserver | undefined;
  let pending = 0;
  const [hits, setHits] = createSignal<readonly Hit[]>([]);

  /** Wide layouts shrink to the pane, as they would on a phone; the height follows the content. */
  function fit(doc: Document) {
    const root = doc.documentElement;
    root.style.zoom = "1";
    const width = frame.clientWidth;
    const needed = root.scrollWidth;
    if (needed > width && width > 0) root.style.zoom = String(width / needed);
    frame.style.height = `${Math.ceil(root.getBoundingClientRect().height)}px`;
    measureLinks(doc);
  }

  /**
   * The text of a link as the reader sees it, including what CSS `::before` and `::after` draw
   * (they are not in `textContent`). Only when a style rule names a pseudo-element at all, so a
   * message without one costs nothing, and within `MAX_PSEUDO_READS` otherwise.
   */
  function linkTexts(doc: Document): (link: HTMLAnchorElement) => string {
    const view = doc.defaultView;
    const drawsText =
      view !== null &&
      [...doc.querySelectorAll("style")].some((s) => PSEUDO_SELECTOR.test(s.textContent ?? ""));
    if (!drawsText) return (link) => link.textContent ?? "";
    let reads = 0;
    const pseudo = (el: TextNode, which: "::before" | "::after") => {
      if (reads >= MAX_PSEUDO_READS) return "";
      reads++;
      return cssStringContent(view.getComputedStyle(el as unknown as Element, which).content);
    };
    return (link) => visibleLinkText(link, pseudo);
  }

  function measureLinks(doc: Document) {
    const out: Hit[] = [];
    const textOf = linkTexts(doc);
    for (const link of doc.querySelectorAll<HTMLAnchorElement>("a[href]")) {
      if (out.length >= MAX_HITS) break;
      const text = textOf(link);
      for (const r of link.getClientRects()) {
        if (r.width > 0 && r.height > 0 && out.length < MAX_HITS) {
          out.push({
            text,
            href: link.href,
            left: r.left,
            top: r.top,
            width: r.width,
            height: r.height,
          });
        }
      }
    }
    setHits(out);
  }

  function fitNextFrame(doc: Document) {
    cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => fit(doc));
  }

  function paint() {
    const doc = frame.contentDocument;
    if (!doc || doc.URL === "about:blank") return;
    doc.documentElement.innerHTML = props.html;
    for (const link of doc.querySelectorAll("a[href]")) link.setAttribute("tabindex", "-1");
    observer?.disconnect();
    // Fitting lays the message out twice and measures every link, too much for each frame of a
    // drag of the list's edge. The message is fitted once, when the drag ends (ADR 0038).
    observer = new ResizeObserver(() => {
      if (!listDragging()) fitNextFrame(doc);
    });
    observer.observe(doc.documentElement);
    observer.observe(frame);
    fit(doc);
    frame.dataset.painted = String(props.html.length);
  }

  // Focus in the frame takes the app's keys, and no listener there can give them back. It stays
  // there only while the reader has text selected, to copy it.
  const focusWatch = setInterval(() => {
    if (document.activeElement !== frame) return;
    const selection = frame.contentDocument?.getSelection();
    if (selection?.isCollapsed !== false) frame.closest<HTMLElement>("[tabindex]")?.focus();
  }, 400);

  onMount(() => {
    frame.addEventListener("load", paint);
    onCleanup(() => {
      clearInterval(focusWatch);
      cancelAnimationFrame(pending);
      observer?.disconnect();
      props.onHoverLink(null);
    });
  });

  createEffect(() => {
    void props.html;
    paint();
  });

  createEffect(
    on(
      listDragging,
      (dragging) => {
        const doc = frame.contentDocument;
        if (!dragging && doc && frame.dataset.painted) fitNextFrame(doc);
      },
      { defer: true },
    ),
  );

  return (
    <div class="relative">
      <iframe
        ref={frame}
        title="Message as sent"
        sandbox={MAIL_FRAME_SANDBOX}
        src={props.images ? "./mail-images.html" : "./mail.html"}
        style={{ "color-scheme": props.scheme }}
        // In dark the frame's own ground is the theme's (ADR 0134, rule 10), as is its page's.
        class={`block h-60 w-full border-0 ${props.scheme === "dark" ? "bg-bg" : "bg-white"}`}
        data-mail-frame
      />
      <For each={hits()}>
        {(hit) => (
          // biome-ignore lint/a11y/useAnchorContent: named by aria-label; the words are in the frame
          <a
            href={hit.href}
            data-mail-link
            aria-label={hit.text.trim() || hit.href}
            class="absolute rounded-[2px] focus-visible:outline-2 focus-visible:outline-[#1a56c4]"
            style={{
              left: `${hit.left}px`,
              top: `${hit.top}px`,
              width: `${hit.width}px`,
              height: `${hit.height}px`,
            }}
            onClick={(e) => {
              e.preventDefault();
              props.onLink({ text: hit.text, href: hit.href });
            }}
            onMouseEnter={() => props.onHoverLink(hit.href)}
            onMouseLeave={() => props.onHoverLink(null)}
            onFocus={() => props.onHoverLink(hit.href)}
            onBlur={() => props.onHoverLink(null)}
          />
        )}
      </For>
    </div>
  );
}
