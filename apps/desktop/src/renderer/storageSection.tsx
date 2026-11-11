import type { MainStorageInfo, StorageReport } from "@matters/contracts";
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { accountMarks } from "./accountMarks.ts";
import type { AccountsStore } from "./accounts.ts";
import type { Backend } from "./client.ts";
import { askMainStorage } from "./files.ts";
import { Ring } from "./icons.tsx";
import {
  canClearFileText,
  canCompact,
  count,
  filesReadLine,
  linePoints,
  measuredAgo,
  overTime,
  processLabel,
  storageParts,
  storageSize,
  totalBytes,
} from "./storageView.ts";

const small =
  "h-[26px] min-w-[76px] shrink-0 cursor-default rounded-[7px] bg-button px-2.5 text-[12px] font-medium text-ink disabled:opacity-40";
const hint = "text-[12px] leading-[1.5] text-secondary";
/** While the section is open, the cheap numbers and the memory are read again this often. */
const REFRESH_MS = 5000;
const CHART_W = 532;
const CHART_H = 72;

/**
 * Settings › Storage (ADR 0089): what the app keeps on this Mac and holds in memory, where the
 * space goes, and the two things that give some back.
 */
export function StorageSection(props: { backend: Backend; accounts: AccountsStore }) {
  const [report, setReport] = createSignal<StorageReport | null>(null);
  const [main, setMain] = createSignal<MainStorageInfo | null>(null);
  const [now, setNow] = createSignal(Date.now());
  const [measuring, setMeasuring] = createSignal(false);
  const [confirming, setConfirming] = createSignal(false);
  const [compacting, setCompacting] = createSignal(false);
  const [clearing, setClearing] = createSignal(false);
  const [confirmingFiles, setConfirmingFiles] = createSignal(false);
  const [clearingFiles, setClearingFiles] = createSignal(false);
  const [notice, setNotice] = createSignal("");
  const [failure, setFailure] = createSignal("");

  async function refresh() {
    const [r, m] = await Promise.all([props.backend.getStorage(), askMainStorage("overview")]);
    setReport(r);
    if (m) setMain(m);
    setNow(Date.now());
    return r;
  }

  async function measure() {
    if (measuring()) return;
    setMeasuring(true);
    setFailure("");
    try {
      setReport(await props.backend.measureStorage());
      setNow(Date.now());
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Measuring did not work.");
    } finally {
      setMeasuring(false);
    }
  }

  async function compact() {
    setConfirming(false);
    setCompacting(true);
    setFailure("");
    setNotice("");
    try {
      const { freedBytes, ms } = await props.backend.compactStorage();
      setNotice(
        `Compacted in ${Math.max(1, Math.round(ms / 1000))} s: ${storageSize(freedBytes)} given back.`,
      );
      await measure();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Compacting did not work.");
    } finally {
      setCompacting(false);
    }
  }

  /** Empties the text the agent read from attachments; it is a copy, and is read again when needed. */
  async function clearFileText() {
    setConfirmingFiles(false);
    setClearingFiles(true);
    setFailure("");
    setNotice("");
    try {
      const cleared = await props.backend.clearFileText();
      setNotice(`Text of ${count(cleared)} ${cleared === 1 ? "file" : "files"} cleared.`);
      await measure();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "Clearing the text of files did not work.");
    } finally {
      setClearingFiles(false);
    }
  }

  async function clearCaches() {
    setClearing(true);
    setFailure("");
    setNotice("");
    const before = main()?.folders.cachesBytes ?? 0;
    const after = await askMainStorage("clearCaches");
    setClearing(false);
    if (!after) {
      setFailure("Clearing caches did not work.");
      return;
    }
    setMain(after);
    setNotice(
      `Caches cleared: ${storageSize(Math.max(0, before - after.folders.cachesBytes))} given back.`,
    );
  }

  onMount(() => {
    // No measurement yet: the first one runs at once, so the bar is never empty for long.
    void refresh()
      .then((r) => {
        if (r.samples.length === 0) void measure();
      })
      .catch((e) => setFailure(e instanceof Error ? e.message : "Storage could not be read."));
    const timer = setInterval(() => void refresh().catch(() => {}), REFRESH_MS);
    onCleanup(() => clearInterval(timer));
  });

  const parts = createMemo(() => {
    const r = report();
    return r ? storageParts(r, main()) : [];
  });
  const total = createMemo(() => {
    const r = report();
    return r ? totalBytes(r, main()) : 0;
  });
  const lastSample = () => report()?.samples.at(-1);
  const history = createMemo(() => overTime(report()?.samples ?? [], now()));
  const marks = createMemo(() => accountMarks(props.accounts.accounts(), props.accounts.colors()));
  const accountRows = createMemo(() => {
    const r = report();
    if (!r) return [];
    const sample = r.samples.at(-1);
    const mailBytes = sample ? sample.htmlBytes + sample.textBytes + sample.mailBytes : 0;
    const names = new Map(props.accounts.accounts().map((a) => [a.id, a.address]));
    return [...r.accounts]
      .sort((a, b) => b.messages - a.messages)
      .map((a) => {
        const share = r.messages > 0 ? a.messages / r.messages : 0;
        return {
          id: a.accountId,
          name: names.get(a.accountId) ?? "Removed account",
          color: marks().get(a.accountId)?.dot ?? "var(--acct-graphite)",
          messages: a.messages,
          share,
          bytes: sample ? share * mailBytes : null,
        };
      });
  });
  const processes = () => main()?.processes ?? [];
  const memoryTotal = () => processes().reduce((n, p) => n + p.memoryBytes, 0);
  const cpuTotal = () => processes().reduce((n, p) => n + p.cpuPercent, 0);
  const memoryMax = () => Math.max(1, ...processes().map((p) => p.memoryBytes));
  const repack = () => report()?.repack;
  const packing = () => {
    const r = repack();
    return r !== undefined && (r.listing || r.left > 0);
  };

  return (
    <section aria-label="Storage" class="flex h-full flex-col">
      <div class="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-5">
        <h2 class="flex-1 font-serif text-[17px] font-semibold">Storage</h2>
        <span class="text-[12px] text-secondary">
          {measuring() ? "Measuring…" : measuredAgo(lastSample()?.atMs, now())}
        </span>
        <button
          type="button"
          class={small}
          disabled={measuring() || compacting()}
          onClick={() => void measure()}
        >
          Measure again
        </button>
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto">
        <Show
          when={report()}
          fallback={
            <p class="flex items-center gap-2.5 px-5 py-6 text-[13px] text-secondary">
              <span class="inline-flex animate-spin">
                <Ring size={14} />
              </span>
              Reading what the app keeps…
            </p>
          }
        >
          {(r) => (
            <>
              <section class="border-b border-hairline px-5 py-4" aria-label="On this Mac">
                <div class="flex flex-wrap items-baseline gap-x-2">
                  <span class="text-[22px] font-semibold tabular-nums">{storageSize(total())}</span>
                  <span class="text-[13px] text-secondary">
                    on this Mac · {count(r().messages)} messages
                    <Show when={r().messages > 0}>
                      {" "}
                      · about {storageSize(total() / r().messages)} each
                    </Show>
                  </span>
                </div>

                <div
                  role="img"
                  aria-label={parts()
                    .map((p) => `${p.label} ${storageSize(p.bytes)}`)
                    .join(", ")}
                  class="mt-3 flex h-[10px] gap-[2px] overflow-hidden rounded-[5px] bg-fill"
                >
                  <For each={parts()}>
                    {(p) => (
                      <span
                        classList={{ "storage-free": p.id === "free" }}
                        style={{
                          flex: `${p.bytes} 0 0`,
                          "min-width": p.bytes > 0 ? "3px" : "0",
                          background: p.id === "free" ? undefined : p.color,
                        }}
                      />
                    )}
                  </For>
                </div>

                <Show when={packing()}>
                  <div
                    class="mt-3 flex flex-col gap-1 rounded-[9px] bg-fill px-3 py-2.5"
                    role="status"
                  >
                    <div class="flex items-baseline gap-2">
                      <span class="flex-1 text-[13px] font-medium">Packing HTML by sender</span>
                      <span class="text-[12px] text-secondary tabular-nums">
                        {repack()?.listing
                          ? "listing messages…"
                          : `${count(repack()?.left ?? 0)} messages left`}
                      </span>
                    </div>
                    <span class={hint}>
                      Runs in small steps while you work; new mail is never held up for long.
                      Messages as sent take about half the space when it ends.
                    </span>
                  </div>
                </Show>

                <div class="mt-3 flex flex-col">
                  <For each={parts()}>
                    {(p) => (
                      <div
                        data-storage-part={p.id}
                        class="flex min-h-[40px] items-center gap-2.5 border-b border-hairline py-1"
                      >
                        <span
                          class="h-[10px] w-[10px] shrink-0 rounded-[3px]"
                          classList={{ "storage-free": p.id === "free" }}
                          style={{ background: p.id === "free" ? undefined : p.color }}
                        />
                        <div class="flex min-w-0 flex-1 flex-col">
                          <span class="text-[13px]">{p.label}</span>
                          <span class="text-[12px] text-secondary">
                            {p.detail}
                            <Show when={p.id === "filesText"}>
                              <span data-files-read> · {filesReadLine(r().filesRead)}</span>
                            </Show>
                          </span>
                        </div>
                        <span class="text-[13px] text-mid tabular-nums">
                          {storageSize(p.bytes)}
                        </span>
                        <Show
                          when={
                            p.id === "caches" ||
                            (p.id === "filesText" && canClearFileText(r())) ||
                            (p.id === "free" && canCompact(r()))
                          }
                          fallback={<span class="w-[76px] shrink-0" />}
                        >
                          <Show
                            when={p.id === "caches" || p.id === "filesText"}
                            fallback={
                              <button
                                type="button"
                                class={small}
                                disabled={compacting() || measuring()}
                                onClick={() => setConfirming(true)}
                              >
                                {compacting() ? "Compacting…" : "Compact…"}
                              </button>
                            }
                          >
                            <Show
                              when={p.id === "caches"}
                              fallback={
                                <button
                                  type="button"
                                  class={small}
                                  disabled={clearingFiles() || measuring()}
                                  onClick={() => setConfirmingFiles(true)}
                                >
                                  {clearingFiles() ? "Clearing…" : "Clear…"}
                                </button>
                              }
                            >
                              <button
                                type="button"
                                class={small}
                                disabled={clearing()}
                                onClick={() => void clearCaches()}
                              >
                                {clearing() ? "Clearing…" : "Clear"}
                              </button>
                            </Show>
                          </Show>
                        </Show>
                      </div>
                    )}
                  </For>
                </div>

                <Show when={confirming()}>
                  <div
                    role="alertdialog"
                    aria-label="Confirm compacting"
                    class="mt-3 rounded-[9px] bg-fill p-3"
                  >
                    <p class="mb-2 text-[13px]">
                      Compact the database? It is rewritten without its free space, about{" "}
                      {storageSize(r().freeBytes)} smaller. That takes a few seconds, sync waits
                      meanwhile, and it needs about {storageSize(r().fileBytes)} of free disk.
                    </p>
                    <div class="flex gap-2">
                      <button type="button" class={small} onClick={() => void compact()}>
                        Compact
                      </button>
                      <button
                        type="button"
                        class={small}
                        ref={(el) => queueMicrotask(() => el.focus())}
                        onClick={() => setConfirming(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </Show>
                <Show when={confirmingFiles()}>
                  <div
                    role="alertdialog"
                    aria-label="Confirm clearing the text of files"
                    class="mt-3 rounded-[9px] bg-fill p-3"
                  >
                    <p class="mb-2 text-[13px]">
                      Clear the text of {filesReadLine(r().filesRead).replace(" read", "")} the
                      agent read? It is only a copy of what is in your mail. The agent reads a file
                      again when it needs it, which takes a download.
                    </p>
                    <div class="flex gap-2">
                      <button type="button" class={small} onClick={() => void clearFileText()}>
                        Clear
                      </button>
                      <button
                        type="button"
                        class={small}
                        ref={(el) => queueMicrotask(() => el.focus())}
                        onClick={() => setConfirmingFiles(false)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </Show>
                <Show when={notice() !== ""}>
                  <p role="status" class="mt-2 text-[13px] text-good">
                    {notice()}
                  </p>
                </Show>
                <Show when={failure() !== ""}>
                  <p role="alert" class="mt-2 text-[13px] text-late">
                    {failure()}
                  </p>
                </Show>
                <p class={`mt-2.5 ${hint}`}>
                  Clearing caches removes no mail and no setting; the app builds them again as it
                  needs them.
                </p>
              </section>

              <section class="border-b border-hairline px-5 py-4" aria-label="Mail by account">
                <h3 class="mb-1 font-semibold">Mail by account</h3>
                <For each={accountRows()}>
                  {(a) => (
                    <div class="flex h-[34px] items-center gap-2.5 border-b border-hairline">
                      <span class="h-2 w-2 shrink-0 rounded-full" style={{ background: a.color }} />
                      <span class="min-w-0 flex-1 truncate text-[13px]">{a.name}</span>
                      <span class="h-1 w-[120px] shrink-0 overflow-hidden rounded-[2px] bg-fill">
                        <span
                          class="block h-1"
                          style={{ width: `${Math.round(a.share * 100)}%`, background: a.color }}
                        />
                      </span>
                      <span class="w-[120px] shrink-0 text-right text-[12px] text-secondary tabular-nums">
                        {count(a.messages)} messages
                      </span>
                      <span class="w-[64px] shrink-0 text-right text-[13px] text-mid tabular-nums">
                        {a.bytes === null ? "" : storageSize(a.bytes)}
                      </span>
                    </div>
                  )}
                </For>
                <p class={`mt-2 ${hint}`}>
                  An account's size is its share of the mail; the search index and caches are
                  shared.
                </p>
              </section>

              <section class="border-b border-hairline px-5 py-4" aria-label="Over time">
                <div class="flex items-baseline gap-2">
                  <h3 class="flex-1 font-semibold">Database over time</h3>
                  <Show when={history().change30 !== undefined}>
                    <span class="text-[12px] text-secondary tabular-nums">
                      {(history().change30 ?? 0) >= 0 ? "+" : "−"}
                      {storageSize(Math.abs(history().change30 ?? 0))} in 30 days ·{" "}
                      {count(history().newMessages30 ?? 0)} new messages
                    </span>
                  </Show>
                </div>
                <Show
                  when={history().points.length >= 2}
                  fallback={
                    <p class={`mt-1 ${hint}`}>
                      One measurement a day is kept from now on; the line starts with the second.
                    </p>
                  }
                >
                  <svg
                    role="img"
                    aria-label={`Database size over ${history().points.length} days`}
                    viewBox={`0 0 ${CHART_W} ${CHART_H}`}
                    preserveAspectRatio="none"
                    class="mt-2.5 block h-[72px] w-full"
                  >
                    <line
                      x1="0"
                      y1={CHART_H - 0.5}
                      x2={CHART_W}
                      y2={CHART_H - 0.5}
                      stroke="var(--hairline)"
                    />
                    <polyline
                      fill="none"
                      stroke="var(--acct-blue)"
                      stroke-width="1.5"
                      stroke-linejoin="round"
                      vector-effect="non-scaling-stroke"
                      points={linePoints(history().points, CHART_W, CHART_H)}
                    />
                  </svg>
                  <div class="mt-1 flex justify-between text-[11px] text-secondary">
                    <span>
                      {new Date(history().points[0]?.atMs ?? 0).toLocaleDateString("en-GB", {
                        day: "numeric",
                        month: "short",
                      })}
                    </span>
                    <span>Today</span>
                  </div>
                </Show>
              </section>

              <section class="px-5 py-4" aria-label="While running">
                <div class="flex items-baseline gap-2">
                  <h3 class="flex-1 font-semibold">While running</h3>
                  <Show when={processes().length > 0}>
                    <span class="text-[12px] text-secondary tabular-nums">
                      {storageSize(memoryTotal())} of memory · {Math.round(cpuTotal())}% CPU
                    </span>
                  </Show>
                </div>
                <For each={processes()}>
                  {(p) => (
                    <div
                      data-process={p.kind}
                      class="flex h-[34px] items-center gap-2.5 border-b border-hairline"
                    >
                      <div class="flex min-w-0 flex-1 items-baseline gap-2">
                        <span class="text-[13px]">{processLabel(p.kind).label}</span>
                        <span class="truncate text-[12px] text-secondary">
                          {processLabel(p.kind).detail}
                        </span>
                      </div>
                      <span class="h-1 w-[120px] shrink-0 overflow-hidden rounded-[2px] bg-fill">
                        <span
                          class="block h-1 bg-[var(--acct-graphite)]"
                          style={{ width: `${Math.round((p.memoryBytes / memoryMax()) * 100)}%` }}
                        />
                      </span>
                      <span class="w-[64px] shrink-0 text-right text-[13px] text-mid tabular-nums">
                        {storageSize(p.memoryBytes)}
                      </span>
                    </div>
                  )}
                </For>
                <p class={`mt-2 ${hint}`}>
                  Agents run as their own programs and are not counted here.
                </p>
              </section>
            </>
          )}
        </Show>
      </div>
    </section>
  );
}
