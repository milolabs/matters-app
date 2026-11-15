import type { EraseReviewInfo, MainEraseOverview } from "@matters/contracts";
import { accountPermissionPages, type PermissionPage } from "@matters/core";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import type { AccountsStore } from "./accounts.ts";
import type { Backend } from "./client.ts";
import {
  CONFIRM_WORD,
  confirms,
  earlierSince,
  reviewRows,
  reviewTotal,
  unsentWarning,
} from "./eraseView.ts";
import { askErase, askEraseOverview, askPermissionPage } from "./files.ts";
import { Ring } from "./icons.tsx";
import { storageSize } from "./storageView.ts";

const small =
  "h-[26px] min-w-[76px] shrink-0 cursor-default rounded-[7px] bg-button px-2.5 text-[12px] font-medium text-ink disabled:opacity-40";
const hint = "text-[12px] leading-[1.5] text-secondary";
const link = "cursor-default text-mid underline underline-offset-2 hover:text-ink";

/**
 * The accounts whose provider keeps a permission the person takes back on its page (rule 8), each
 * with its pages: both of Microsoft's when the kind of account is not known.
 */
export function providerPages(accounts: AccountsStore): readonly {
  readonly address: string;
  readonly pages: readonly PermissionPage[];
}[] {
  return accounts.accounts().flatMap((a) => {
    const pages = accountPermissionPages(a);
    return pages.length > 0 ? [{ address: a.address, pages }] : [];
  });
}

/**
 * Erase everything, the review and the confirmation (ADR 0138, rules 9 and 10), in the Storage
 * pane: what goes with sizes measured now, the earlier copy when it exists, what stays or is out
 * of reach, mail waiting to be sent. The person types `erase`; Cancel has the focus; Escape goes
 * back to Storage. Confirming restarts the app into the erase.
 */
export function EraseReview(props: {
  backend: Backend;
  accounts: AccountsStore;
  onBack: () => void;
}) {
  const [db, setDb] = createSignal<EraseReviewInfo | null>(null);
  const [main, setMain] = createSignal<MainEraseOverview | null>(null);
  const [failure, setFailure] = createSignal("");
  const [earlier, setEarlier] = createSignal(false);
  const [typed, setTyped] = createSignal("");
  const [confirming, setConfirming] = createSignal(false);
  const pages = createMemo(() => providerPages(props.accounts));

  onMount(() => {
    void Promise.all([props.backend.eraseReview(), askEraseOverview()])
      .then(([d, m]) => {
        // Without main's part the review would hide the folders and the earlier copy: no erase.
        if (m === null)
          throw new Error("Matters could not measure its folders, so it cannot erase.");
        setDb(d);
        setMain(m);
      })
      .catch((e) => setFailure(e instanceof Error ? e.message : "Measuring did not work."));
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || confirming()) return;
      e.preventDefault();
      e.stopPropagation();
      props.onBack();
    };
    // Before the settings window's own Escape (which closes the window).
    window.addEventListener("keydown", onKey, true);
    onCleanup(() => window.removeEventListener("keydown", onKey, true));
  });

  async function erase() {
    if (!confirms(typed()) || confirming()) return;
    setConfirming(true);
    setFailure("");
    const ok = await askErase(earlier(), [
      ...new Set(pages().flatMap((p) => p.pages.map((page) => page.id))),
    ]);
    if (!ok) {
      setConfirming(false);
      setFailure("Matters could not start the erase. Nothing was erased.");
    }
    // Otherwise the app closes now and opens again into the erase.
  }

  const total = () => {
    const d = db();
    return d ? reviewTotal(d, main()) : 0;
  };

  return (
    <section aria-label="Erase everything" class="flex h-full flex-col">
      <div class="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-5">
        <h2 class="flex-1 font-serif text-[17px] font-semibold">Erase everything</h2>
        <span class="text-[12px] text-secondary">{db() ? "Measured just now" : "Measuring…"}</span>
        <button type="button" class={small} disabled={confirming()} onClick={() => props.onBack()}>
          Back to Storage
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={db()}
          fallback={
            <p class="flex items-center gap-2.5 px-5 py-6 text-[13px] text-secondary">
              <Show when={failure() === ""} fallback={<span class="text-late">{failure()}</span>}>
                <span class="inline-flex animate-spin">
                  <Ring size={14} />
                </span>
                Measuring what Matters keeps…
              </Show>
            </p>
          }
        >
          {(d) => (
            <>
              <section class="border-b border-hairline px-5 py-4" aria-label="What goes">
                <h3 class="mb-1 font-semibold">What goes</h3>
                <For each={reviewRows(d(), main())}>
                  {(row) => (
                    <div
                      data-erase-group={row.id}
                      class="flex min-h-[40px] items-center gap-2.5 border-b border-hairline py-1"
                    >
                      <div class="flex min-w-0 flex-1 flex-col">
                        <span class="text-[13px]">{row.label}</span>
                        <span class="text-[12px] text-secondary">{row.detail}</span>
                      </div>
                      <span class="text-[13px] text-mid tabular-nums">{row.amount}</span>
                    </div>
                  )}
                </For>
                <div class="flex h-[34px] items-center gap-2.5">
                  <span class="flex-1 text-[13px] font-semibold">In all</span>
                  <span class="text-[13px] font-semibold tabular-nums">{storageSize(total())}</span>
                </div>
              </section>

              <Show when={main()?.earlier}>
                {(e) => (
                  <section class="border-b border-hairline px-5 py-4" aria-label="Also on this Mac">
                    <h3 class="mb-2 font-semibold">Also on this Mac</h3>
                    <label class="flex items-start gap-2.5 text-[13px]">
                      <input
                        type="checkbox"
                        class="mt-0.5"
                        checked={earlier()}
                        disabled={confirming()}
                        onChange={(ev) => setEarlier(ev.currentTarget.checked)}
                      />
                      <span class="flex min-w-0 flex-1 flex-col">
                        <span>The earlier copy, from before Matters got its name</span>
                        <span class={hint}>
                          The folder @unclosed/desktop and its Keychain key,{" "}
                          {earlierSince(e().sinceMs)}. Left alone unless you tick this; Matters
                          won't bring it back in either way.
                        </span>
                      </span>
                      <span class="text-[13px] text-mid tabular-nums">
                        {storageSize(e().bytes)}
                      </span>
                    </label>
                  </section>
                )}
              </Show>

              <section class="border-b border-hairline px-5 py-4" aria-label="What stays">
                <h3 class="mb-1.5 font-semibold">What stays, and what Matters cannot reach</h3>
                <ul class={`m-0 flex list-none flex-col gap-1.5 p-0 ${hint}`}>
                  <li>
                    <span class="text-ink">Mail on your servers.</span> Nothing is deleted there.
                  </li>
                  <For each={pages()}>
                    {(p) => (
                      <li>
                        <span class="text-ink">
                          {p.pages[0]?.provider}'s permission for {p.address}.
                        </span>{" "}
                        Matters throws its sign-in away, but {p.pages[0]?.provider} keeps listing it
                        as allowed until you take that back on its page for{" "}
                        <For each={p.pages}>
                          {(page, i) => (
                            <>
                              {i() > 0 ? " or " : ""}
                              <button
                                type="button"
                                class={link}
                                onClick={() => void askPermissionPage(page.id)}
                              >
                                {page.audience}
                              </button>
                            </>
                          )}
                        </For>
                        .
                      </li>
                    )}
                  </For>
                  <li>
                    <span class="text-ink">Files you saved elsewhere,</span> such as attachments in
                    Downloads.
                  </li>
                  <li>
                    <span class="text-ink">Backups of this Mac.</span> Time Machine and disk
                    snapshots may still hold older copies.
                  </li>
                  <li>
                    <span class="text-ink">What agents already sent to your AI provider</span> while
                    reading mail. Its own settings decide how long it keeps that.
                  </li>
                </ul>
              </section>

              <section class="px-5 py-4" aria-label="Confirm">
                <Show when={unsentWarning(d().unsent)}>
                  {(warning) => (
                    <p role="alert" class="mb-2.5 text-[13px] text-late">
                      {warning()}
                    </p>
                  )}
                </Show>
                <div
                  role="alertdialog"
                  aria-label="Confirm erasing everything"
                  class="rounded-[9px] bg-fill p-3"
                >
                  <p class="mb-2.5 text-[13px]">
                    Matters closes, erases all of this, and opens again empty. It cannot be undone.
                    Type <span class="font-semibold">{CONFIRM_WORD}</span> to go on.
                  </p>
                  <div class="flex items-center gap-2">
                    <label for="erase-word" class="sr-only">
                      Type {CONFIRM_WORD} to confirm
                    </label>
                    <input
                      id="erase-word"
                      type="text"
                      autocomplete="off"
                      spellcheck={false}
                      class="selectable h-[26px] w-[96px] rounded-[7px] bg-bg px-2 text-[12.5px] text-ink outline-none ring-1 ring-edge focus:ring-2"
                      value={typed()}
                      disabled={confirming()}
                      onInput={(ev) => setTyped(ev.currentTarget.value)}
                      onKeyDown={(ev) => {
                        if (ev.key === "Enter") void erase();
                      }}
                    />
                    <button
                      type="button"
                      class={`${small} bg-late text-bg`}
                      disabled={!confirms(typed()) || confirming()}
                      onClick={() => void erase()}
                    >
                      {confirming() ? "Restarting…" : "Erase and restart"}
                    </button>
                    <button
                      type="button"
                      class={small}
                      disabled={confirming()}
                      ref={(el) => queueMicrotask(() => el.focus())}
                      onClick={() => props.onBack()}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
                <Show when={failure() !== ""}>
                  <p role="alert" class="mt-2 text-[13px] text-late">
                    {failure()}
                  </p>
                </Show>
              </section>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}
