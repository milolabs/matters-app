import type { NoticeSystem } from "@matters/contracts";
import type {
  BadgeSource,
  BannerContent,
  NoticeChannels,
  NoticeKind,
  NotificationPrefs,
  SavedView,
} from "@matters/core";
import {
  BANNERS_TOGETHER,
  clockText,
  DEFAULT_NOTIFICATION_PREFS,
  IN_APP_SECONDS,
  isPaused,
  NEEDS_YOU_VIEW,
  type PauseChoice,
  parseClock,
  pausedText,
  pauseUntil,
} from "@matters/core";
import { createSignal, For, type JSX, onCleanup, onMount, Show } from "solid-js";
import type { AccountsStore } from "./accounts.ts";
import type { Backend } from "./client.ts";
import { askNoticeSystem } from "./files.ts";
import { AppIcon, BadgeIcon, BannerIcon, InsideIcon } from "./icons.tsx";

const row = "border-b border-hairline px-5 py-4";
const heading = "mb-1 font-semibold";
const hint = "text-[12px] leading-[1.5] text-secondary";
const small =
  "h-[26px] cursor-default rounded-[7px] bg-button px-2.5 text-[12px] font-medium text-ink disabled:opacity-40";

const KINDS: readonly { kind: NoticeKind; label: string; hint: string }[] = [
  { kind: "replies", label: "Replies to you", hint: "A thread you wrote in got an answer" },
  { kind: "people", label: "Other mail from people", hint: "Someone wrote to you" },
  { kind: "lists", label: "Lists and programs", hint: "Newsletters, receipts, alerts" },
  {
    kind: "matters",
    label: "What matters",
    hint: "The agent put it in Matters, or it is due within a day",
  },
];

const CHANNELS: readonly { key: keyof NoticeChannels; label: string; icon: () => JSX.Element }[] = [
  { key: "banner", label: "Banner", icon: () => <BannerIcon /> },
  { key: "inApp", label: "In app", icon: () => <InsideIcon /> },
  { key: "badge", label: "Badge", icon: () => <BadgeIcon /> },
];

const CONTENT: readonly { value: BannerContent; label: string }[] = [
  { value: "full", label: "Sender, subject and first line" },
  { value: "subject", label: "Sender and subject" },
  { value: "minimal", label: "Only that mail came" },
];

const BADGE: readonly { value: BadgeSource; label: string }[] = [
  { value: "matters", label: "What is in Matters" },
  { value: "view", label: "The number of a view" },
  { value: "notified", label: "Mail you were told about" },
  { value: "inbox", label: "All unread in the Inbox" },
  { value: "off", label: "Nothing" },
];

const NO_CHANNELS: NoticeChannels = { banner: false, inApp: false, badge: false };

/** The local time zone, as the shared pause rule takes it. */
const zone = (ms: number) => -new Date(ms).getTimezoneOffset();

/**
 * What tells you that mail came (ADR 0071): which mail, through which channel, and how much. A
 * section of the settings window; every change is kept at once and reaches the mail window.
 */
export function NotificationsSection(props: { backend: Backend; accounts: AccountsStore }) {
  const [prefs, setPrefs] = createSignal<NotificationPrefs>(DEFAULT_NOTIFICATION_PREFS);
  const [views, setViews] = createSignal<readonly SavedView[]>([]);
  const [problem, setProblem] = createSignal("");
  const [now, setNow] = createSignal(Date.now());
  const [system, setSystem] = createSignal<NoticeSystem | null>(null);

  onMount(() => {
    void props.backend.getNotificationPrefs().then(setPrefs, () => {});
    void props.backend.listViews().then(setViews, () => {});
    void askNoticeSystem("status").then(setSystem, () => {});
    const off = props.backend.onEvent((event) => {
      if (event.type === "notificationPrefsChanged") setPrefs(event.prefs);
      if (event.type === "notificationTestFailed") {
        setProblem(
          event.reason === ""
            ? "The system did not show the test banner."
            : `The system did not show the test banner: ${event.reason}`,
        );
      }
    });
    const clock = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => {
      off();
      clearInterval(clock);
    });
  });

  async function change(next: NotificationPrefs) {
    setPrefs(next);
    setProblem("");
    try {
      setPrefs(await props.backend.setNotificationPrefs(next));
    } catch {
      setProblem("That could not be kept. Try again.");
    }
  }
  const p = prefs;
  const patch = (part: Partial<NotificationPrefs>) => void change({ ...p(), ...part });

  const setKind = (kind: NoticeKind, key: keyof NoticeChannels, on: boolean) =>
    patch({ kinds: { ...p().kinds, [kind]: { ...p().kinds[kind], [key]: on } } });
  const setView = (id: string, key: keyof NoticeChannels, on: boolean) => {
    const next = { ...(p().views[id] ?? NO_CHANNELS), [key]: on };
    const all = { ...p().views };
    if (next.banner || next.inApp || next.badge) all[id] = next;
    else delete all[id];
    patch({ views: all });
  };

  const paused = () => isPaused(p(), now());
  const pause = (choice: PauseChoice) =>
    patch({ pausedUntilMs: pauseUntil(choice, Date.now(), zone) });
  const pausedLine = () => pausedText(p().pausedUntilMs ?? 0, now(), zone);

  const off = () => !p().enabled;

  return (
    <section aria-label="Notifications" class="flex h-full flex-col">
      <div class="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-5">
        <h2 class="flex-1 font-serif text-[17px] font-semibold">Notifications</h2>
        <button
          type="button"
          class={small}
          disabled={off()}
          onClick={() => void props.backend.testNotification().catch(() => {})}
        >
          Send a test
        </button>
        <Switch label="Notifications" on={p().enabled} onChange={(enabled) => patch({ enabled })} />
      </div>

      <div class="min-h-0 flex-1 overflow-y-auto" classList={{ "opacity-45": off() }} inert={off()}>
        <Show when={problem() !== ""}>
          <p role="alert" class="border-b border-hairline px-5 py-2 text-[12.5px] text-late">
            {problem()}
          </p>
        </Show>

        {/* Pause and quiet hours first: the answer to "it rang at night" is at the top. */}
        <div class={row} data-quiet>
          <div class="flex flex-wrap items-center gap-2">
            <Show
              when={paused()}
              fallback={
                <>
                  <span class="mr-1 text-[13px]">Pause</span>
                  <button type="button" class={small} onClick={() => pause("hour")}>
                    For an hour
                  </button>
                  <button type="button" class={small} onClick={() => pause("tomorrow")}>
                    Until tomorrow
                  </button>
                </>
              }
            >
              <span class="mr-1 text-[13px] font-medium text-late">{pausedLine()}</span>
              <button type="button" class={small} onClick={() => patch({ pausedUntilMs: null })}>
                Resume
              </button>
            </Show>
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            <label class="flex cursor-default items-center gap-2.5">
              <input
                type="checkbox"
                checked={p().quiet.on}
                onChange={(e) => patch({ quiet: { ...p().quiet, on: e.currentTarget.checked } })}
              />
              Quiet every day from
            </label>
            <TimeField
              label="Quiet from"
              minute={p().quiet.fromMin}
              disabled={!p().quiet.on}
              onChange={(fromMin) => patch({ quiet: { ...p().quiet, fromMin } })}
            />
            <span>to</span>
            <TimeField
              label="Quiet until"
              minute={p().quiet.toMin}
              disabled={!p().quiet.on}
              onChange={(toMin) => patch({ quiet: { ...p().quiet, toMin } })}
            />
          </div>
          <p class={`${hint} mt-2`}>
            While paused or quiet, no banner and no sound. The badge and the notices inside the
            window go on.
          </p>
          <SystemLine system={system()} />
        </div>

        {/* What notifies, and where: one line per kind of mail, one column per channel. */}
        <div class={row} data-kinds>
          <div class="grid grid-cols-[minmax(0,1fr)_repeat(3,52px)] items-center">
            <h3 class="font-semibold">What tells you</h3>
            <For each={CHANNELS}>
              {(c) => (
                <span class="flex flex-col items-center gap-0.5 text-[11px] text-secondary">
                  {c.icon()}
                  {c.label}
                </span>
              )}
            </For>
            <For each={KINDS}>
              {(k) => (
                <ChannelRow
                  label={k.label}
                  hint={k.hint}
                  channels={p().kinds[k.kind]}
                  badgeOff={p().badge.source !== "notified"}
                  onChange={(key, on) => setKind(k.kind, key, on)}
                />
              )}
            </For>
            <p class="col-span-4 mt-4 mb-0.5 text-[12px] font-medium text-secondary">Saved views</p>
            <For
              each={views()}
              fallback={
                <p class={`${hint} col-span-4`}>
                  Save a search as a view, and you can be told about its mail alone, wherever it is.
                </p>
              }
            >
              {(view) => (
                <ChannelRow
                  label={view.name}
                  hint={view.query}
                  channels={p().views[view.id] ?? NO_CHANNELS}
                  badgeOff={p().badge.source !== "notified"}
                  onChange={(key, on) => setView(view.id, key, on)}
                />
              )}
            </For>
          </div>
        </div>

        {/* What a banner says, beside what it would look like. */}
        <div class={row} data-banner>
          <h3 class={heading}>Banners</h3>
          <div class="mt-2 flex flex-wrap items-start gap-x-6 gap-y-3">
            <fieldset class="m-0 flex min-w-[220px] flex-1 flex-col border-0 p-0">
              <legend class="sr-only">What a banner says</legend>
              <For each={CONTENT}>
                {(c) => (
                  <label class="flex cursor-default items-center gap-2.5 py-1 text-[13px]">
                    <input
                      type="radio"
                      name="banner-content"
                      checked={p().banner.content === c.value}
                      onChange={() => patch({ banner: { ...p().banner, content: c.value } })}
                    />
                    {c.label}
                  </label>
                )}
              </For>
            </fieldset>
            <BannerPreview content={p().banner.content} />
          </div>
          <div class="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
            <span>Mail that comes together:</span>
            <Segmented
              label="Banners at most"
              options={BANNERS_TOGETHER.map((n) => ({ value: n, label: String(n) }))}
              value={p().banner.together}
              onChange={(together) => patch({ banner: { ...p().banner, together } })}
            />
            <span class="text-secondary">
              {p().banner.together === 1 ? "summary" : "banners at most, then a summary"}
            </span>
          </div>
          <div class="mt-3 flex flex-col gap-1">
            <label class="flex cursor-default items-center gap-2.5 text-[13px]">
              <input
                type="checkbox"
                checked={p().banner.sound}
                onChange={(e) =>
                  patch({ banner: { ...p().banner, sound: e.currentTarget.checked } })
                }
              />
              Play a sound
            </label>
            <label class="flex cursor-default items-center gap-2.5 text-[13px]">
              <input
                type="checkbox"
                checked={p().banner.whenFront}
                onChange={(e) =>
                  patch({ banner: { ...p().banner, whenFront: e.currentTarget.checked } })
                }
              />
              Also while Matters is in front
            </label>
          </div>
          <p class={`${hint} mt-2`}>
            Your system decides the rest: whether banners show on the lock screen, and Focus.
          </p>
        </div>

        <div class={row} data-badge>
          <h3 class={heading}>Badge on the icon</h3>
          <div class="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <span>Counts</span>
            <select
              aria-label="What the badge counts"
              class="h-[26px] cursor-default rounded-[7px] bg-fill px-2 text-[12.5px] outline-none focus:ring-1 focus:ring-edge"
              onChange={(e) => {
                const source = e.currentTarget.value as BadgeSource;
                // A view's number starts with `Needs you` when it is there, else the first view.
                const viewId =
                  p().badge.viewId ??
                  (views().find((v) => v.id === NEEDS_YOU_VIEW.id) ?? views()[0])?.id;
                patch({
                  badge: {
                    ...p().badge,
                    source,
                    ...(source === "view" && viewId !== undefined ? { viewId } : {}),
                  },
                });
              }}
            >
              <For each={BADGE}>
                {(b) => (
                  <option value={b.value} selected={p().badge.source === b.value}>
                    {b.label}
                  </option>
                )}
              </For>
            </select>
            <Show when={p().badge.source === "view"}>
              <select
                aria-label="The view the badge counts"
                class="h-[26px] cursor-default rounded-[7px] bg-fill px-2 text-[12.5px] outline-none focus:ring-1 focus:ring-edge"
                onChange={(e) => patch({ badge: { ...p().badge, viewId: e.currentTarget.value } })}
              >
                <Show when={!views().some((v) => v.id === p().badge.viewId)}>
                  <option value="" selected>
                    Choose a view
                  </option>
                </Show>
                <For each={views()}>
                  {(v) => (
                    <option value={v.id} selected={p().badge.viewId === v.id}>
                      {v.name}
                    </option>
                  )}
                </For>
              </select>
            </Show>
            <Show when={p().badge.source !== "off"}>
              <span>as</span>
              <Segmented
                label="Badge style"
                options={[
                  { value: "count" as const, label: "Number" },
                  { value: "dot" as const, label: "Dot" },
                ]}
                value={p().badge.style}
                onChange={(style) => patch({ badge: { ...p().badge, style } })}
              />
            </Show>
          </div>
          <p class={`${hint} mt-2`}>
            {p().badge.source === "matters"
              ? "The same number as the Matters tab: what is still on you."
              : p().badge.source === "view"
                ? "The same number as that view's tab. With no view, or AI off for a view with a prompt, the unread in the Inbox."
                : p().badge.source === "notified"
                  ? "The mail ticked in the Badge column, until you read it."
                  : p().badge.source === "inbox"
                    ? "Every unread message in the Inbox, up to 999."
                    : "The icon stays clean."}
          </p>
        </div>

        <div class={row} data-inside>
          <h3 class={heading}>Inside the window</h3>
          <div class="mt-2 flex flex-wrap items-center gap-2 text-[13px]">
            <span>A notice stays</span>
            <Segmented
              label="How long a notice stays"
              options={IN_APP_SECONDS.map((s) => ({
                value: s,
                label: s === 0 ? "Until closed" : `${s} s`,
              }))}
              value={p().inApp.seconds}
              onChange={(seconds) => patch({ inApp: { seconds } })}
            />
          </div>
          <p class={`${hint} mt-2`}>
            Its time runs only while you look: not while the window is in the back, nor under the
            pointer.
          </p>
        </div>

        <Show when={props.accounts.accounts().length > 1}>
          <div class={row} data-accounts>
            <h3 class={heading}>Accounts</h3>
            <div class="mt-1 flex flex-col gap-1">
              <For each={props.accounts.accounts()}>
                {(a) => (
                  <label class="flex cursor-default items-center gap-2.5 py-0.5 text-[13px]">
                    <input
                      type="checkbox"
                      checked={!p().mutedAccounts.includes(a.id)}
                      onChange={(e) =>
                        patch({
                          mutedAccounts: e.currentTarget.checked
                            ? p().mutedAccounts.filter((id) => id !== a.id)
                            : [...p().mutedAccounts, a.id],
                        })
                      }
                    />
                    <span
                      aria-hidden="true"
                      class="size-[7px] shrink-0 rounded-full"
                      style={{ background: props.accounts.marks().get(a.id)?.dot }}
                    />
                    {a.address}
                  </label>
                )}
              </For>
            </div>
          </div>
        </Show>
      </div>
    </section>
  );
}

/** One kind of mail or one view: its name and a box per channel. */
function ChannelRow(props: {
  label: string;
  hint: string;
  channels: NoticeChannels;
  /** The badge counts something else: its box says so and cannot be ticked. */
  badgeOff: boolean;
  onChange: (key: keyof NoticeChannels, on: boolean) => void;
}) {
  return (
    <>
      <div class="min-w-0 border-t border-hairline py-2.5 pr-2">
        <span class="block truncate text-[13px]">{props.label}</span>
        <span class="block truncate text-[12px] text-secondary">{props.hint}</span>
      </div>
      <For each={CHANNELS}>
        {(c) => (
          <span class="flex h-full items-center justify-center border-t border-hairline">
            <input
              type="checkbox"
              aria-label={`${props.label}: ${c.label}`}
              checked={c.key === "badge" && props.badgeOff ? false : props.channels[c.key]}
              disabled={c.key === "badge" && props.badgeOff}
              title={
                c.key === "badge" && props.badgeOff
                  ? "The badge counts something else (see Badge on the icon)"
                  : undefined
              }
              onChange={(e) => props.onChange(c.key, e.currentTarget.checked)}
            />
          </span>
        )}
      </For>
    </>
  );
}

/**
 * What the system adds (ADR 0108). Matters cannot read whether macOS allows its banners, so this
 * says only what is known: run as the stock Electron runtime, macOS shows none; run as Matters.app,
 * they also need the person's yes in System Settings.
 */
function SystemLine(props: { system: NoticeSystem | null }) {
  const [opened, setOpened] = createSignal(true);
  const open = () =>
    void askNoticeSystem("openSettings").then(
      (r) => setOpened(r?.opened === true),
      () => setOpened(false),
    );
  return (
    <Show when={props.system?.platform === "macos" ? props.system.app : null}>
      {(app) => (
        <Show
          when={app() === "own"}
          fallback={
            <Show when={app() === "runtime"}>
              <p class={`${hint} mt-2`} data-system="runtime">
                macOS shows no banners for Matters started this way. Open Matters.app instead, built
                with <code>bun run bundle:macos</code>. The notices inside the window and the badge
                still work.
              </p>
            </Show>
          }
        >
          <div class="mt-2 flex flex-wrap items-center gap-2" data-system="own">
            <p class={`${hint} m-0`}>Banners also need to be allowed in System Settings.</p>
            <button type="button" class={small} onClick={open}>
              Open System Settings
            </button>
            <Show when={!opened()}>
              <span class={hint}>
                It did not open. Find Matters in System Settings › Notifications.
              </span>
            </Show>
          </div>
        </Show>
      )}
    </Show>
  );
}

/** A made-up banner that says what yours would, in the system's shape. */
function BannerPreview(props: { content: BannerContent }) {
  const title = () => (props.content === "minimal" ? "New mail" : "Anna Kowalska");
  return (
    <figure
      aria-label="What a banner would say"
      class="m-0 flex w-[264px] shrink-0 items-start gap-2.5 rounded-[14px] border border-hairline bg-soft p-2.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
    >
      <span class="mt-0.5 shrink-0">
        <AppIcon size={26} />
      </span>
      <span class="min-w-0 flex-1 text-[12px] leading-[1.35]">
        <span class="flex items-baseline gap-2">
          <span class="truncate font-semibold">{title()}</span>
          <span class="ml-auto shrink-0 text-[11px] text-secondary">now</span>
        </span>
        <Show when={props.content !== "minimal"}>
          <span class="block truncate" classList={{ "font-medium": props.content === "full" }}>
            Contract for the spring
          </span>
        </Show>
        <span class="block truncate text-secondary">
          {props.content === "full"
            ? "Could you look at the second page before Friday?"
            : props.content === "minimal"
              ? "Open Matters to read it."
              : ""}
        </span>
      </span>
    </figure>
  );
}

/** A few choices side by side, one of them on. */
function Segmented<T extends string | number>(props: {
  label: string;
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <fieldset class="m-0 inline-flex rounded-[8px] border-0 bg-fill p-[2px]">
      <legend class="sr-only">{props.label}</legend>
      <For each={props.options}>
        {(o) => (
          <label
            class="flex h-[22px] cursor-default items-center rounded-[6px] px-2.5 text-[12px] has-[:focus-visible]:ring-1 has-[:focus-visible]:ring-edge"
            classList={{
              "bg-bg font-medium text-ink shadow-[0_1px_2px_rgb(0_0_0/0.08)]":
                props.value === o.value,
              "text-mid hover:text-ink": props.value !== o.value,
            }}
          >
            <input
              type="radio"
              class="sr-only"
              name={props.label}
              checked={props.value === o.value}
              onChange={() => props.onChange(o.value)}
            />
            {o.label}
          </label>
        )}
      </For>
    </fieldset>
  );
}

/** On and off, as the system draws it. */
function Switch(props: { label: string; on: boolean; onChange: (on: boolean) => void }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={props.on}
      aria-label={props.label}
      class="relative h-[18px] w-[30px] shrink-0 cursor-default rounded-full transition-colors duration-150"
      classList={{ "bg-ink": props.on, "bg-button": !props.on }}
      onClick={() => props.onChange(!props.on)}
    >
      <span
        aria-hidden="true"
        class="absolute top-[2px] left-[2px] size-[14px] rounded-full bg-bg shadow-[0_1px_2px_rgb(0_0_0/0.2)] transition-transform duration-150"
        classList={{ "translate-x-[12px]": props.on }}
      />
    </button>
  );
}

/** A time of day, typed as 22:00; a wrong one is put back. */
function TimeField(props: {
  label: string;
  minute: number;
  disabled: boolean;
  onChange: (minute: number) => void;
}) {
  return (
    <input
      type="text"
      inputmode="numeric"
      aria-label={props.label}
      value={clockText(props.minute)}
      disabled={props.disabled}
      class="selectable h-[26px] w-[58px] rounded-[7px] bg-fill px-2 text-center text-[12.5px] tabular-nums outline-none focus:bg-bg focus:ring-1 focus:ring-edge disabled:opacity-50"
      onChange={(e) => {
        const minute = parseClock(e.currentTarget.value);
        if (minute === null) e.currentTarget.value = clockText(props.minute);
        else props.onChange(minute);
      }}
    />
  );
}
