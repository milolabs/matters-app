import type {
  AppearanceInfo,
  AppearanceMode,
  ThemeListing,
  ThemeProblem,
  ThemeScheme,
  ThemeSwatch,
} from "@matters/contracts";
import { MAX_THEMES, THEMES_FULL } from "@matters/contracts";
import type { AgentStatus } from "@matters/core";
import { MAX_THEME_DESCRIPTION_CHARS } from "@matters/core";
import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { DEFAULT_SWATCHES } from "./appTheme.ts";
import type { Backend } from "./client.ts";
import {
  type AppearanceAsk,
  addTheme,
  askAppearance,
  onAppearanceChanged,
  themeText,
} from "./files.ts";
import { appearanceWatch, makeTheme, themeMaker } from "./themeMaking.ts";

const small =
  "h-[26px] cursor-default rounded-[7px] bg-button px-2.5 text-[12px] font-medium text-ink disabled:opacity-40";

const MODES: readonly { value: AppearanceMode; label: string }[] = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The keys of the way back, as this computer writes them (main handles them, ADR 0134, rule 11). */
const mac = typeof navigator !== "undefined" && /Mac/.test(navigator.platform);
export const RESET_KEYS = mac ? "⌥⇧⌘0" : "Ctrl+Alt+Shift+0";

const schemesLabel = (schemes: readonly ThemeScheme[]) =>
  schemes.length === 2 ? "Light and dark" : schemes[0] === "dark" ? "Dark only" : "Light only";

/** A refused theme in plain words: what failed, so the person knows what to change. */
function problemLines(problems: readonly ThemeProblem[]): string[] {
  // A theme can fail many pairs; the first few say enough to act on.
  const shown = problems.slice(0, 6).map((p) => p.message);
  if (problems.length > shown.length) shown.push(`And ${problems.length - shown.length} more.`);
  return shown;
}

function Swatches(props: { swatches: readonly ThemeSwatch[] }) {
  return (
    <span aria-hidden="true" class="flex shrink-0 gap-1.5">
      <For each={props.swatches}>
        {(s) => (
          <span
            class="flex h-[18px] items-center gap-[3px] rounded-[5px] px-[5px] shadow-[inset_0_0_0_1px_var(--edge)]"
            style={{ background: s.ground }}
          >
            <span class="h-[8px] w-[8px] rounded-full" style={{ background: s.ink }} />
            <span class="h-[8px] w-[8px] rounded-full" style={{ background: s.accent }} />
          </span>
        )}
      </For>
    </span>
  );
}

/**
 * How the app looks (ADR 0134): the mode, the theme, and the way back. Main keeps the choice and
 * every window follows it at once; this section shows what main says, including a change made
 * from the menu, the shortcut or another window. A section of the settings window.
 */
export function AppearanceSection(props: {
  backend: Backend;
  /** Settings › Agents, where the runtime and model of the kind are chosen (ADR 0134, rule 16). */
  onAgents: () => void;
}) {
  const [info, setInfo] = createSignal<AppearanceInfo | null>(null);
  const [problem, setProblem] = createSignal("");

  // A theme from a description (ADR 0134, rules 12 to 16). The section works the same without AI:
  // this part only says what is missing then.
  const [agent, setAgent] = createSignal<AgentStatus | null>(null);
  const [agentGone, setAgentGone] = createSignal(false);
  const [description, setDescription] = createSignal("");
  const [fromCurrent, setFromCurrent] = createSignal(false);
  const [making, setMaking] = createSignal(false);
  const [madeRefused, setMadeRefused] = createSignal<readonly string[]>([]);
  const [madeProblem, setMadeProblem] = createSignal("");
  const [made, setMade] = createSignal("");
  let stop = false;
  /** What the person does to the appearance while a theme is made (ADR 0134, rule 11). */
  let watch = appearanceWatch(null);

  /** What main says now. The way back while a theme is made stops it; see `appearanceWatch`. */
  function seen(a: AppearanceInfo) {
    if (making() && watch.seen(a)) cancel();
    setInfo(a);
  }

  async function readAgent() {
    try {
      setAgent(await props.backend.agentStatus());
      setAgentGone(false);
    } catch {
      setAgentGone(true);
    }
  }

  onMount(() => {
    const off = onAppearanceChanged(seen);
    onCleanup(off);
    void askAppearance({ action: "get" }).then((a) => {
      if (a) setInfo(a);
    });
    void readAgent();
    // AI turned on, a kind moved or a runtime checked, in Agents or another window.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const offAgent = props.backend.onEvent((event) => {
      if (event.type !== "agentChanged" || timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        void readAgent();
      }, 500);
    });
    onCleanup(() => {
      offAgent();
      clearTimeout(timer);
    });
  });

  const maker = () =>
    agentGone()
      ? { ready: false as const, why: "The agent cannot be reached now." }
      : themeMaker(agent());
  const why = () => {
    const m = maker();
    return m.ready ? "" : m.why;
  };
  const by = () => {
    const m = maker();
    return m.ready ? m.by : "";
  };
  const asked = () => description().replace(/\s+/g, " ").trim();
  /** The theme on, which the person may ask to change; the default is not a theme (rule 3). */
  const current = () => {
    const a = info();
    if (a === null || a.theme === null) return null;
    return a.themes.find((t) => t.id === a.theme) ?? null;
  };

  async function make() {
    if (making() || !maker().ready || asked() === "") return;
    setMadeRefused([]);
    setMadeProblem("");
    setMade("");
    // A full list keeps no more (`MAX_THEMES`): say so before a turn is spent on it.
    if ((info()?.themes.length ?? 0) >= MAX_THEMES) {
      setMadeProblem(THEMES_FULL);
      return;
    }
    setMaking(true);
    stop = false;
    watch = appearanceWatch(info());
    try {
      const on = fromCurrent() ? current() : null;
      // Cancel while this is read is honoured before the first turn: `makeTheme` asks `stopped`.
      const currentText = on === null ? null : await themeText(on.id);
      const result = await makeTheme(
        {
          make: (input) => props.backend.agentMakeTheme(input),
          add: (text) => addTheme(text, watch.putOn()),
          stopped: () => stop,
        },
        { description: asked(), ...(currentText === null ? {} : { current: currentText }) },
      );
      if (result.kind === "added") {
        setInfo(result.answer.appearance);
        setDescription("");
        setFromCurrent(false);
        const added =
          result.answer.appearance.theme === result.answer.theme.id
            ? `${result.answer.theme.name} was added and is on.`
            : `${result.answer.theme.name} was added. The theme you chose meanwhile stays on.`;
        setMade(
          result.tries === 2
            ? `${added} The agent's first theme did not pass the check, so it was asked once more.`
            : added,
        );
      } else if (result.kind === "refused") {
        setMadeRefused(problemLines(result.problems));
      } else if (result.kind === "failed") {
        setMadeProblem(result.message);
      }
    } finally {
      setMaking(false);
    }
  }

  function cancel() {
    stop = true;
    void props.backend.agentMakeThemeStop().catch(() => {});
  }

  async function change(ask: AppearanceAsk) {
    setProblem("");
    const a = await askAppearance(ask);
    if (a) seen(a);
    else setProblem("That could not be kept. Try again.");
  }

  const fixed = () => info()?.fixedScheme ?? null;
  const themeName = () => info()?.themes.find((t) => t.id === info()?.theme)?.name ?? "";
  const differs = () => {
    const a = info();
    return a !== null && (a.mode !== "system" || a.themeChosen);
  };

  const themeRow = (
    theme: { id: string | null; name: string; detail: string; swatches: readonly ThemeSwatch[] },
    own: ThemeListing | null,
  ) => (
    <div
      data-theme-row={theme.id ?? "default"}
      class="flex items-center gap-3 border-b border-hairline py-1.5 last:border-b-0"
    >
      {/* The radio is named by the theme alone; which sets it has is its description. */}
      <label class="flex min-w-0 cursor-default items-center gap-2.5 text-[13px]">
        <input
          type="radio"
          name="appearance-theme"
          value={theme.id ?? ""}
          aria-describedby={`theme-detail-${theme.id ?? "default"}`}
          checked={info() !== null && (info()?.theme ?? null) === theme.id}
          onChange={() => void change({ action: "theme", id: theme.id })}
        />
        <span class="min-w-0 truncate">{theme.name}</span>
      </label>
      <span
        id={`theme-detail-${theme.id ?? "default"}`}
        class="min-w-0 flex-1 truncate text-[12px] text-secondary"
      >
        {theme.detail}
      </span>
      <Swatches swatches={theme.swatches} />
      <Show when={own}>
        {(t) => (
          <button
            type="button"
            class={small}
            aria-label={`Remove the theme ${t().name}`}
            onClick={() => void change({ action: "remove", id: t().id })}
          >
            Remove
          </button>
        )}
      </Show>
    </div>
  );

  return (
    <section aria-label="Appearance" class="flex h-full flex-col">
      <div class="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-5">
        <h2 class="flex-1 font-serif text-[17px] font-semibold">Appearance</h2>
        {/* The way back (ADR 0134, rule 11): mode System and no theme; nothing to undo there. */}
        <button
          type="button"
          class={small}
          disabled={!differs()}
          onClick={() => {
            // The way back also stops a theme being made, so its late answer cannot undo it.
            if (making()) cancel();
            void change({ action: "reset" });
          }}
        >
          Use default
        </button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="border-b border-hairline px-5 py-4">
          <fieldset class="m-0 border-0 p-0" disabled={fixed() !== null}>
            <legend class="mb-2 font-semibold">Mode</legend>
            <For each={MODES}>
              {(choice) => (
                <label class="flex cursor-default items-center gap-2.5 py-1 text-[13px]">
                  <input
                    type="radio"
                    name="appearance-mode"
                    value={choice.value}
                    checked={info()?.mode === choice.value}
                    onChange={() => void change({ action: "set", mode: choice.value })}
                  />
                  {choice.label}
                </label>
              )}
            </For>
          </fieldset>
          <Show when={fixed()}>
            {(scheme) => (
              <p class="mt-2 text-[12px] text-secondary">
                {themeName()} has {scheme()} colours only, so Matters stays {scheme()} while it is
                on. The mode you chose comes back with another theme.
              </p>
            )}
          </Show>
          <p class="mt-3 text-[12px] text-secondary">
            System follows your computer. Light or Dark keeps every Matters window that way,
            whatever the system does. If the screen cannot be read, {RESET_KEYS} in any Matters
            window goes back to the default.
          </p>
        </div>
        <div class="border-b border-hairline px-5 py-4">
          <fieldset class="m-0 border-0 p-0">
            <legend class="mb-1 font-semibold">Theme</legend>
            {themeRow(
              { id: null, name: "Matters", detail: "Light and dark", swatches: DEFAULT_SWATCHES },
              null,
            )}
            <For each={info()?.themes ?? []}>
              {(t) =>
                themeRow(
                  { id: t.id, name: t.name, detail: schemesLabel(t.schemes), swatches: t.swatches },
                  t.source === "own" ? t : null,
                )
              }
            </For>
          </fieldset>
          <Show when={info()?.fallback}>
            {(why) => (
              <p role="status" class="mt-2 text-[13px] text-late">
                {why()}
              </p>
            )}
          </Show>
          <Show when={problem() !== ""}>
            <p role="alert" class="mt-2 text-[13px] text-late">
              {problem()}
            </p>
          </Show>
        </div>
        <div class="border-b border-hairline px-5 py-4" data-theme-maker>
          <label for="theme-description" class="mb-2 block font-semibold">
            Describe a theme
          </label>
          <textarea
            id="theme-description"
            rows={3}
            maxLength={MAX_THEME_DESCRIPTION_CHARS}
            class="selectable block w-full resize-none rounded-[9px] bg-fill px-3 py-2 text-[13px] outline-none placeholder:text-secondary focus:bg-bg focus:ring-1 focus:ring-edge disabled:opacity-60"
            placeholder="Warm paper with dark brown text and a deep green accent, in light and dark"
            aria-describedby="theme-maker-line"
            disabled={!maker().ready}
            readOnly={making()}
            aria-busy={making()}
            value={description()}
            onInput={(e) => setDescription(e.currentTarget.value)}
            onKeyDown={(e) => {
              // ⌘↵ makes it, as a field of more than one line sends elsewhere; Esc stops it.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void make();
              } else if (e.key === "Escape" && making()) {
                e.preventDefault();
                cancel();
              }
            }}
          />
          <Show when={current()}>
            {(t) => (
              <label class="mt-2 flex cursor-default items-center gap-2.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={fromCurrent()}
                  disabled={!maker().ready || making()}
                  onChange={(e) => setFromCurrent(e.currentTarget.checked)}
                />
                Start from {t().name}, the theme that is on
              </label>
            )}
          </Show>
          <div class="mt-3 flex items-center gap-3">
            <Show
              when={making()}
              fallback={
                <button
                  type="button"
                  class={small}
                  disabled={!maker().ready || asked() === ""}
                  onClick={() => void make()}
                >
                  Make theme
                </button>
              }
            >
              <span role="status" class="text-[12px] text-agent">
                Making a theme…
              </span>
              <button type="button" class={small} onClick={cancel}>
                Cancel
              </button>
            </Show>
          </div>
          <p
            id="theme-maker-line"
            class="mt-3 text-[12px]"
            classList={{ "text-secondary": maker().ready, "text-mid": !maker().ready }}
            data-theme-maker-line
          >
            {by() || why()}{" "}
            <button
              type="button"
              class="cursor-default text-mid underline underline-offset-2 hover:text-ink"
              onClick={() => props.onAgents()}
            >
              {maker().ready ? "Change in Agents" : "Open Agents"}
            </button>
          </p>
          <Show when={maker().ready}>
            <p class="mt-1 text-[12px] text-secondary">
              {fromCurrent() && current() !== null
                ? "Your words and the colours of the theme that is on go to the agent; no mail."
                : "Only your words go to the agent; no mail."}{" "}
              Its theme is checked so its text stays readable, and asked for once more if it does
              not pass. The new theme is added beside the others and put on, unless you choose
              another theme meanwhile; Use default stops it.
            </p>
          </Show>
          <Show when={made() !== ""}>
            <p role="status" class="mt-2 text-[13px] text-good">
              {made()}
            </p>
          </Show>
          <Show when={madeRefused().length > 0}>
            <div role="alert" class="mt-2 text-[13px] text-late">
              <p>The agent's theme was not added, after a second try:</p>
              <ul class="mt-1 list-disc pl-5">
                <For each={madeRefused()}>{(line) => <li>{line}</li>}</For>
              </ul>
            </div>
          </Show>
          <Show when={madeProblem() !== ""}>
            <p role="alert" class="mt-2 text-[13px] text-late">
              {madeProblem()}
            </p>
          </Show>
        </div>
      </div>
    </section>
  );
}
