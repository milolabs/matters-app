import type { EraseReport } from "@matters/contracts";
import { PERMISSION_PAGE_AUDIENCE, type PermissionPageId } from "@matters/core";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  checkedLine,
  erasedLine,
  type GroupId,
  labelOf,
  leftReason,
  partialHeading,
  unreadableReason,
} from "./eraseView.ts";
import { askEraseWindow, onEraseProgress } from "./files.ts";
import { CheckIcon, MattersMark, Ring } from "./icons.tsx";
import { storageSize } from "./storageView.ts";

const pillSmall =
  "h-[28px] cursor-default rounded-[8px] bg-button px-3 text-[12px] font-semibold disabled:opacity-40";
const pillSmallPrimary =
  "h-[28px] cursor-default rounded-[8px] bg-ink px-3 text-[12px] font-semibold text-bg disabled:opacity-40";
const small =
  "h-[26px] shrink-0 cursor-default rounded-[7px] bg-button px-2.5 text-[12px] font-medium text-ink";
const hint = "text-[12px] leading-[1.5] text-secondary";

/** The rows of the window, by the steps of the erase (ADR 0138, rule 3). */
const ROWS: readonly {
  readonly id: string;
  readonly steps: readonly string[];
  readonly label: string;
}[] = [
  { id: "signIns", steps: ["signIns"], label: "Saved passwords and sign-ins" },
  { id: "database", steps: ["database"], label: "Mail, the search index and what agents wrote" },
  { id: "files", steps: ["files"], label: "Attachments and files" },
  { id: "settings", steps: ["settings"], label: "Views, people and settings" },
  { id: "caches", steps: ["caches", "temp"], label: "Caches" },
  {
    id: "earlier",
    steps: ["earlier"],
    label: "The earlier copy, from before Matters got its name",
  },
];
const ORDER = ["signIns", "database", "files", "settings", "caches", "temp", "earlier", "order"];

const PROVIDER: Record<PermissionPageId, string> = {
  microsoftWork: "Microsoft",
  microsoftPersonal: "Microsoft",
};

/**
 * The window of a start that erases (ADR 0138, rule 11): the steps while they run, then the result
 * once. All gone: what was erased, how much, that it was checked; Start again or Quit. Something
 * left: each thing with its reason and a way to see it; Try again, Quit, or leave them.
 */
export function EraseScreen() {
  const [step, setStep] = createSignal<string | null>(null);
  const [bytes, setBytes] = createSignal<Readonly<Record<string, number>>>({});
  const [earlierCopy, setEarlierCopy] = createSignal(false);
  const [report, setReport] = createSignal<EraseReport | null>(null);
  const [pages, setPages] = createSignal<readonly PermissionPageId[]>([]);
  const [busy, setBusy] = createSignal(false);
  /** A start that could not read its data folder: nothing was erased, nothing opened. */
  const [unreadable, setUnreadable] = createSignal<{
    readonly code: string | null;
    readonly folder: string;
  } | null>(null);
  const takeUnreadable = (a: Record<string, unknown> | null) => {
    if (a?.kind !== "unreadable") return false;
    // Nothing is being erased: the window's title must not say so.
    document.title = "Matters";
    setUnreadable({
      code: typeof a.code === "string" ? a.code : null,
      folder: typeof a.folder === "string" ? a.folder : "",
    });
    return true;
  };

  const apply = (event: Record<string, unknown>) => {
    if (event.kind === "step" && typeof event.step === "string") setStep(event.step);
    else if (event.kind === "holding" && typeof event.bytes === "number") {
      const row = ROWS.find((r) => r.steps.includes(step() ?? ""))?.id;
      if (row) setBytes((b) => ({ ...b, [row]: (b[row] ?? 0) + (event.bytes as number) }));
    } else if (event.kind === "result") {
      setReport(event.report as EraseReport);
      setBusy(false);
    }
  };

  onMount(() => {
    onCleanup(onEraseProgress(apply));
    void askEraseWindow("state").then((state) => {
      if (!state || takeUnreadable(state)) return;
      void askEraseWindow("pages").then((a) => {
        if (Array.isArray(a?.pages)) setPages(a.pages as PermissionPageId[]);
      });
      if (state.kind === "result") apply(state);
      else {
        setEarlierCopy(state.earlierCopy === true);
        for (const e of (state.events as Record<string, unknown>[] | undefined) ?? []) apply(e);
      }
    });
  });

  const rowState = (steps: readonly string[]): "done" | "now" | "later" => {
    const at = ORDER.indexOf(step() ?? "");
    const last = Math.max(...steps.map((s) => ORDER.indexOf(s)));
    const first = Math.min(...steps.map((s) => ORDER.indexOf(s)));
    if (at > last) return "done";
    if (at >= first) return "now";
    return "later";
  };

  async function act(action: string) {
    if (action === "retry") {
      setBusy(true);
      setReport(null);
      setStep(null);
      setBytes({});
    }
    await askEraseWindow(action);
  }

  const outside = () => (
    <ul class={`m-0 flex list-none flex-col gap-1.5 p-0 ${hint}`}>
      <li>
        <span class="text-ink">Mail on your servers,</span> untouched.
      </li>
      <For each={pages()}>
        {(page) => (
          <li>
            <span class="text-ink">{PROVIDER[page]}'s permission for Matters.</span>{" "}
            <button
              type="button"
              class="cursor-default text-mid underline underline-offset-2 hover:text-ink"
              onClick={() => void askEraseWindow(page)}
            >
              Open {PROVIDER[page]}'s page for {PERMISSION_PAGE_AUDIENCE[page]}
            </button>{" "}
            to take it back.
          </li>
        )}
      </For>
      <Show when={report()?.markerLeft}>
        <li>
          <span class="text-ink">The earlier copy, from before Matters got its name,</span> as you
          chose. One small file stays in Matters' folder so that it is never brought back in; it
          holds no mail and no settings.
        </li>
      </Show>
      <li>
        <span class="text-ink">Backups of this Mac,</span> which may hold older copies.
      </li>
      <li>
        <span class="text-ink">What agents already sent to your AI provider.</span>
      </li>
    </ul>
  );

  const erasing = () => (
    <Show
      when={report()}
      fallback={
        <>
          <h1 class="mt-7 font-serif text-[21px] leading-[1.2] font-semibold">
            Erasing Matters from this Mac
          </h1>
          <p role="status" class="mt-1.5 text-[13px] text-secondary">
            Nothing is read or synced meanwhile.
          </p>
          <ol class="m-0 mt-6 flex list-none flex-col p-0">
            <For each={ROWS.filter((r) => r.id !== "earlier" || earlierCopy())}>
              {(row) => (
                <li class="flex h-[34px] items-center gap-2.5 border-b border-hairline">
                  <Show when={rowState(row.steps) === "done"}>
                    <span class="text-good">
                      <CheckIcon size={14} />
                    </span>
                  </Show>
                  <Show when={rowState(row.steps) === "now"}>
                    <span class="inline-flex animate-spin">
                      <Ring size={14} />
                    </span>
                  </Show>
                  <span
                    class="flex-1 text-[13px]"
                    classList={{
                      "font-medium": rowState(row.steps) === "now",
                      "text-secondary": rowState(row.steps) === "later",
                    }}
                  >
                    {row.label}
                  </span>
                  <Show when={rowState(row.steps) !== "later"}>
                    <span class="text-[12px] text-secondary tabular-nums">
                      {bytes()[row.id]
                        ? `${storageSize(bytes()[row.id] ?? 0)}${rowState(row.steps) === "done" ? " gone" : ""}`
                        : rowState(row.steps) === "done"
                          ? "gone"
                          : ""}
                    </span>
                  </Show>
                </li>
              )}
            </For>
          </ol>
          <p class={`mt-auto ${hint}`}>
            There is no way back from here. If Matters is closed or the Mac sleeps, it carries on
            the next time Matters opens, before anything else.
          </p>
        </>
      }
    >
      {(r) => (
        <Show
          when={r().ok}
          fallback={
            <>
              <h1 class="mt-7 font-serif text-[21px] leading-[1.2] font-semibold">
                {partialHeading(r().left.length)}
              </h1>
              <p role="alert" class="mt-1.5 text-[13px] text-late">
                {r().groups.length > 0
                  ? `${r()
                      .groups.map((g) => labelOf(g.group as GroupId))
                      .join(", ")}: erased. These could not be:`
                  : "These could not be erased:"}
              </p>
              <ul class="m-0 mt-4 flex list-none flex-col p-0">
                <For each={r().left}>
                  {(item) => (
                    <li class="flex min-h-[46px] items-center gap-2.5 border-t border-hairline py-1 last:border-b">
                      <div class="flex min-w-0 flex-1 flex-col">
                        <span class="truncate text-[13px]">
                          {item.kind === "key"
                            ? `The Keychain key “${item.where ?? ""}”`
                            : `${labelOf(item.group as GroupId)}${item.bytes > 0 ? `, ${storageSize(item.bytes)}` : ""}`}
                        </span>
                        <span class="text-[12px] text-secondary">
                          {leftReason(item.reason, item.kind)}
                        </span>
                      </div>
                      <Show
                        when={item.kind === "key"}
                        fallback={
                          <button type="button" class={small} onClick={() => void act("show")}>
                            Show in Finder
                          </button>
                        }
                      >
                        <Show when={item.reason === "keychainRefused"}>
                          <button type="button" class={small} onClick={() => void act("keychain")}>
                            Open Keychain Access
                          </button>
                        </Show>
                      </Show>
                    </li>
                  )}
                </For>
              </ul>
              <p class={`mt-3 ${hint}`}>
                Until they are gone, Matters tries again each time it opens and shows you this.
              </p>
              <div class="mt-auto flex items-center gap-2">
                <button
                  type="button"
                  class={pillSmallPrimary}
                  disabled={busy()}
                  ref={(el) => queueMicrotask(() => el.focus())}
                  onClick={() => void act("retry")}
                >
                  Try again
                </button>
                <button type="button" class={pillSmall} onClick={() => void act("quit")}>
                  Quit Matters
                </button>
                <span class="flex-1" />
                <button
                  type="button"
                  class="cursor-default text-[12.5px] text-mid underline underline-offset-2"
                  onClick={() => void act("leave")}
                >
                  Leave them and start again
                </button>
              </div>
            </>
          }
        >
          <h1 class="mt-7 font-serif text-[21px] leading-[1.2] font-semibold">
            {r().markerLeft
              ? "Your mail and data are gone from this Mac."
              : "Nothing of Matters is left on this Mac."}
          </h1>
          <p role="status" class="mt-1.5 text-[13px] text-good">
            {erasedLine(r().bytes, r().ms, r().earlierCopy)} {checkedLine(r().keys)}
          </p>
          <h2 class="mt-6 mb-1.5 text-[13px] font-semibold">Still outside Matters</h2>
          {outside()}
          <div class="mt-auto flex items-center gap-2">
            <button
              type="button"
              class={pillSmallPrimary}
              ref={(el) => queueMicrotask(() => el.focus())}
              onClick={() => void act("startAgain")}
            >
              Start again
            </button>
            <button type="button" class={pillSmall} onClick={() => void act("quit")}>
              Quit Matters
            </button>
            <span class="flex-1 text-right text-[12px] text-secondary">
              This list is not kept anywhere.
            </span>
          </div>
        </Show>
      )}
    </Show>
  );

  async function readAgain() {
    setBusy(true);
    takeUnreadable(await askEraseWindow("retry"));
    setBusy(false);
  }

  return (
    <div class="flex h-full flex-col bg-bg px-14 pt-[52px] pb-8">
      <div class="drag flex items-center gap-2 text-[13px] font-semibold">
        <MattersMark size={16} />
        Matters
      </div>
      <Show when={unreadable()} fallback={erasing()}>
        {(u) => (
          <>
            <h1 class="mt-7 font-serif text-[21px] leading-[1.2] font-semibold">
              Matters could not read its folder
            </h1>
            <p role="alert" class="mt-1.5 text-[13px] text-late">
              {unreadableReason(u().code)}
            </p>
            <p class="mt-4 truncate text-[13px]" title={u().folder}>
              {u().folder}
            </p>
            <p class={`mt-3 ${hint}`}>
              Until it can, Matters opens nothing and erases nothing: it cannot tell whether you
              asked it to erase everything.
            </p>
            <div class="mt-auto flex items-center gap-2">
              <button
                type="button"
                class={pillSmallPrimary}
                disabled={busy()}
                ref={(el) => queueMicrotask(() => el.focus())}
                onClick={() => void readAgain()}
              >
                Try again
              </button>
              <button type="button" class={pillSmall} onClick={() => void act("quit")}>
                Quit Matters
              </button>
              <span class="flex-1" />
              <button type="button" class={small} onClick={() => void act("show")}>
                Show in Finder
              </button>
            </div>
          </>
        )}
      </Show>
    </div>
  );
}
