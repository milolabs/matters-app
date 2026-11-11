import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { AccountMark } from "./accountMarks.ts";
import type { Backend } from "./client.ts";
import { CloseIcon } from "./icons.tsx";
import { clear, dismiss, EMPTY, moreText, type Notice, push, SHOWN, tick } from "./noticeStack.ts";

const TICK_MS = 250;

/**
 * New mail inside the window (ADR 0071, rule 7): a few quiet cards under the search bar, newest on
 * top. A card opens its message; time runs out only while the window is in front and the pointer
 * is elsewhere, so nothing goes by unseen. The thin line at the foot is the time it has left.
 */
export function NoticeStack(props: {
  backend: Backend;
  markOf: (accountId: string) => AccountMark | undefined;
  onOpen: (key: number, threadId: string) => void;
}) {
  const [state, setState] = createSignal(EMPTY);
  const [focused, setFocused] = createSignal(document.hasFocus());
  const [hovered, setHovered] = createSignal(false);
  const running = () => focused() && !hovered();

  onMount(() => {
    const off = props.backend.onEvent((event) => {
      if (event.type === "notices") setState((s) => push(s, event.notices, event.seconds));
    });
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    const timer = setInterval(() => {
      if (running() && state().notices.length > 0) setState((s) => tick(s, TICK_MS));
    }, TICK_MS);
    onCleanup(() => {
      off();
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    });
  });

  const shown = () => state().notices.slice(0, SHOWN);
  const close = (id: number) => setState((s) => dismiss(s, id));
  const open = (n: Notice) => {
    close(n.id);
    if (n.key > 0) props.onOpen(n.key, n.threadId);
  };

  return (
    <section
      aria-label="New mail"
      aria-live="polite"
      data-notices
      class="pointer-events-none fixed top-[96px] right-4 z-40 flex w-[320px] max-w-[calc(100vw-2rem)] flex-col items-stretch gap-1.5"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <For each={shown()}>
        {(n) => (
          <article
            data-notice={n.key}
            class="notice-in group pointer-events-auto relative overflow-hidden rounded-[10px] border border-hairline bg-bg shadow-[var(--pop)]"
          >
            <button
              type="button"
              class="block w-full cursor-default py-2.5 pr-8 pl-3.5 text-left hover:bg-soft focus-visible:bg-soft"
              aria-label={`${n.title}${n.subtitle ? `, ${n.subtitle}` : ""}. Open`}
              onClick={() => open(n)}
            >
              <span class="flex min-w-0 items-center gap-2">
                <Show when={props.markOf(n.accountId)}>
                  {(mark) => (
                    <span
                      aria-hidden="true"
                      class="size-[7px] shrink-0 rounded-full"
                      style={{ background: mark().dot }}
                    />
                  )}
                </Show>
                <span class="truncate text-[13px] font-semibold text-ink">{n.title}</span>
              </span>
              <Show when={n.subtitle}>
                <span class="mt-0.5 block truncate text-[12.5px] text-ink">{n.subtitle}</span>
              </Show>
              <Show when={n.body !== ""}>
                <span class="mt-0.5 line-clamp-2 block text-[12px] leading-[1.4] text-secondary">
                  {n.body}
                </span>
              </Show>
            </button>
            <button
              type="button"
              aria-label="Close"
              class="absolute top-2 right-2 grid size-[20px] cursor-default place-items-center rounded-[5px] text-secondary opacity-0 group-hover:opacity-100 hover:bg-fill hover:text-ink focus-visible:opacity-100"
              onClick={() => close(n.id)}
            >
              <CloseIcon size={11} />
            </button>
            <Show when={n.totalMs !== null}>
              <span
                aria-hidden="true"
                class="notice-time absolute bottom-0 left-0 h-px w-full origin-left bg-edge"
                style={{
                  "animation-duration": `${n.totalMs ?? 0}ms`,
                  "animation-play-state": running() ? "running" : "paused",
                }}
              />
            </Show>
          </article>
        )}
      </For>
      <Show when={moreText(state()) !== ""}>
        <div class="pointer-events-auto flex items-center justify-between px-1 text-[11.5px] text-secondary">
          <span>{moreText(state())}</span>
          <button
            type="button"
            class="cursor-default rounded-[5px] px-1.5 py-0.5 hover:bg-fill hover:text-ink"
            onClick={() => setState(clear)}
          >
            Clear all
          </button>
        </div>
      </Show>
    </section>
  );
}
