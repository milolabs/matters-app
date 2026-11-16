import type { BackupAnswer, BackupOverview, RestoreAnswer, SetAsideInfo } from "@matters/contracts";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import {
  BACKUP_HOLDS,
  BACKUP_LEAVES,
  BACKUP_NOT_ENCRYPTED,
  backupLine,
  jobLine,
  pendingLines,
  restoreLine,
  setAsideLabel,
} from "./backupView.ts";
import { askBackup } from "./files.ts";
import { Ring } from "./icons.tsx";
import { storageSize } from "./storageView.ts";

const small =
  "h-[26px] min-w-[76px] shrink-0 cursor-default rounded-[7px] bg-button px-2.5 text-[12px] font-medium text-ink disabled:opacity-40";
const hint = "text-[12px] leading-[1.5] text-secondary";
/** While a job runs, how often its line is read again. */
const BUSY_MS = 500;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const asOverview = (v: unknown): BackupOverview | null =>
  isRecord(v) && isRecord(v.job) && Array.isArray(v.setAside)
    ? (v as unknown as BackupOverview)
    : null;

/**
 * Settings › Storage › Backups (ADR 0145, rules 6 to 9): Back Up… and Restore from a Backup…,
 * what a backup holds and does not, said before one is written, the restore that waits for the
 * next start, and the databases a restore set aside, each with its size and a way to remove it.
 */
export function BackupSection() {
  const [overview, setOverview] = createSignal<BackupOverview | null>(null);
  const [notice, setNotice] = createSignal("");
  const [failure, setFailure] = createSignal("");
  const [removing, setRemoving] = createSignal<string | null>(null);
  let timer: ReturnType<typeof setInterval> | undefined;

  async function refresh() {
    const next = asOverview(await askBackup("backupOverview"));
    if (next) setOverview(next);
    return next;
  }
  const busy = () => (overview()?.job.kind ?? "idle") !== "idle";

  /** Reads the busy line again while a job runs, and stops when it ends. */
  function watch() {
    clearInterval(timer);
    timer = setInterval(() => void refresh(), BUSY_MS);
  }
  function settle() {
    clearInterval(timer);
    timer = undefined;
    void refresh();
  }
  onMount(() => void refresh());
  onCleanup(() => clearInterval(timer));

  function say(line: { text: string; failure: boolean } | null) {
    setNotice(line && !line.failure ? line.text : "");
    setFailure(line?.failure ? line.text : "");
  }

  async function backUp() {
    say(null);
    watch();
    const answer = (await askBackup("backup")) as BackupAnswer | null;
    settle();
    say(answer ? backupLine(answer) : { text: "The backup could not be written.", failure: true });
  }

  async function restore(name?: string) {
    say(null);
    watch();
    const answer = (await askBackup(
      name ? "restoreSetAside" : "restoreBackup",
      name,
    )) as RestoreAnswer | null;
    settle();
    say(answer ? restoreLine(answer) : { text: "The backup could not be read.", failure: true });
  }

  async function act(action: "cancelRestore" | "removeSetAside", name?: string) {
    setRemoving(null);
    const next = asOverview(await askBackup(action, name));
    if (next) setOverview(next);
  }

  return (
    <section class="border-b border-hairline px-5 py-4" aria-label="Backups">
      <h3 class="mb-1 font-semibold">Backups</h3>
      <p class={hint}>{BACKUP_HOLDS}</p>
      <p class={`mt-1 ${hint}`}>{BACKUP_LEAVES}</p>
      <p class="mt-1 text-[12px] leading-[1.5] text-mid" data-backup-unencrypted>
        {BACKUP_NOT_ENCRYPTED}
      </p>
      <div class="mt-2.5 flex flex-wrap items-center gap-2">
        <button type="button" class={small} disabled={busy()} onClick={() => void backUp()}>
          Back Up…
        </button>
        <button type="button" class={small} disabled={busy()} onClick={() => void restore()}>
          Restore from a Backup…
        </button>
      </div>

      <Show when={overview() && jobLine(overview()?.job ?? { kind: "idle" })}>
        {(line) => (
          <div
            data-backup-busy
            class="mt-2.5 flex items-center gap-2.5 text-[13px] text-secondary"
            role="status"
          >
            <span class="inline-flex animate-spin">
              <Ring size={14} />
            </span>
            <span class="flex-1 tabular-nums">{line()}</span>
            <button type="button" class={small} onClick={() => void askBackup("stopBackup")}>
              Stop
            </button>
          </div>
        )}
      </Show>
      <Show when={notice() !== ""}>
        <p role="status" class="mt-2 text-[13px] text-good" data-backup-notice>
          {notice()}
        </p>
      </Show>
      <Show when={failure() !== ""}>
        <p role="alert" class="mt-2 text-[13px] text-late" data-backup-failure>
          {failure()}
        </p>
      </Show>

      <Show when={overview()?.pending}>
        {(pending) => (
          <section
            data-restore-pending
            aria-label="Restore waiting"
            class="mt-3 rounded-[9px] bg-fill p-3"
          >
            <p class="mb-1 text-[13px] font-medium">A restore waits for the next start</p>
            <For each={pendingLines(pending())}>
              {(line) => <p class="text-[12.5px] leading-[1.5]">{line}</p>}
            </For>
            <div class="mt-2 flex gap-2">
              <button
                type="button"
                class={small}
                onClick={() => void askBackup("restartToRestore")}
              >
                Restart to Restore
              </button>
              <button type="button" class={small} onClick={() => void act("cancelRestore")}>
                Cancel Restore
              </button>
            </div>
          </section>
        )}
      </Show>

      <Show when={(overview()?.setAside.length ?? 0) > 0}>
        <section class="mt-3 flex flex-col" aria-label="Set-aside databases">
          <For each={overview()?.setAside ?? []}>
            {(item: SetAsideInfo) => (
              <div
                data-set-aside={item.name}
                class="flex min-h-[40px] flex-wrap items-center gap-2.5 border-b border-hairline py-1"
              >
                <div class="flex min-w-0 flex-1 flex-col">
                  <span class="text-[13px]">{setAsideLabel(item)}</span>
                  <span class="text-[12px] text-secondary">What Matters kept before a restore</span>
                </div>
                <span class="text-[13px] text-mid tabular-nums">{storageSize(item.bytes)}</span>
                <button
                  type="button"
                  class={small}
                  disabled={busy()}
                  onClick={() => void restore(item.name)}
                >
                  Put Back…
                </button>
                <button type="button" class={small} onClick={() => setRemoving(item.name)}>
                  Remove…
                </button>
                <Show when={removing() === item.name}>
                  <div
                    role="alertdialog"
                    aria-label="Confirm removing a set-aside database"
                    class="mb-1 w-full rounded-[9px] bg-fill p-3"
                  >
                    <p class="mb-2 text-[13px]">
                      Remove this database? It is the mail Matters kept before the restore,{" "}
                      {storageSize(item.bytes)}. It cannot be brought back.
                    </p>
                    <div class="flex gap-2">
                      <button
                        type="button"
                        class={small}
                        onClick={() => void act("removeSetAside", item.name)}
                      >
                        Remove
                      </button>
                      <button
                        type="button"
                        class={small}
                        ref={(el) => queueMicrotask(() => el.focus())}
                        onClick={() => setRemoving(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </Show>
              </div>
            )}
          </For>
        </section>
      </Show>
    </section>
  );
}
