import type { ParsedQuery } from "@matters/core";
import { createEffect, createSignal, For, onMount, Show } from "solid-js";
import type { MattersTab } from "./mattersView.ts";
import { menuPoint, PopMenu } from "./popMenu.tsx";
import { isBuiltInView, MATTERS_ID, type ViewsStore } from "./views.ts";

const mac = navigator.userAgent.includes("Macintosh");
const SAVE_KEY = mac ? "⌘S" : "Ctrl+S";

interface MenuAt {
  readonly id: string;
  readonly x: number;
  readonly y: number;
}

/** Tabs in the toolbar (ADR 0027, 0029): All mail first, then the saved views, then `+`. */
export function ViewTabs(props: {
  views: ViewsStore;
  /** What the Matters tab shows: how far the reading is, or the count of things (ADR 0053). */
  mattersTab?: () => MattersTab;
  /** A tab was chosen with the pointer: the list takes the keyboard. */
  onPicked: () => void;
  /** `+`: a fresh start in the query bar. */
  onNew: () => void;
}) {
  const { views } = props;
  let strip!: HTMLDivElement;
  const [menu, setMenu] = createSignal<MenuAt | null>(null);

  const tab = (id: string) => strip.querySelector<HTMLElement>(`[data-view="${CSS.escape(id)}"]`);

  // The active tab stays in view, however far the strip has scrolled.
  createEffect(() => {
    views.views();
    tab(views.active().id)?.scrollIntoView({ inline: "nearest", block: "nearest" });
  });

  function openMenu(id: string, x: number, y: number) {
    setMenu({ id, ...menuPoint(x, y) });
  }

  function openFromTab(id: string) {
    const r = tab(id)?.getBoundingClientRect();
    if (r) openMenu(id, r.left, r.bottom + 2);
  }

  function closeMenu(id: string | null) {
    setMenu(null);
    // The menu had the focus: give it back to the tab it came from.
    if (id) queueMicrotask(() => tab(id)?.focus());
  }

  function onStripKey(e: KeyboardEvent) {
    const from = (e.target as HTMLElement).closest<HTMLElement>("button");
    if (!from) return;
    const id = from.dataset.view;
    if (id && (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey))) {
      e.preventDefault();
      if (!isBuiltInView(id)) openFromTab(id);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return;
    const buttons = [...strip.querySelectorAll<HTMLElement>("button")];
    const at = buttons.indexOf(from);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : Math.min(Math.max(at + (e.key === "ArrowRight" ? 1 : -1), 0), buttons.length - 1);
    e.preventDefault();
    buttons[next]?.focus();
  }

  return (
    <>
      {/* The tablist owns the arrow keys of its buttons; the buttons are the interactive part. */}
      <div class="flex min-w-0 flex-1 items-center">
        <div
          ref={strip}
          role="tablist"
          aria-label="Views"
          class="views min-w-0 flex-1"
          onKeyDown={onStripKey}
        >
          <For each={views.views()}>
            {(view, i) => {
              const selected = () => views.active().id === view.id;
              // Every tab counts its unread mail, selected or not (ADR 0093).
              const matters = view.id === MATTERS_ID;
              const badge = () => (matters ? props.mattersTab?.().badge : views.badge(view.id));
              const spoken = () => {
                if (matters) return props.mattersTab?.().spoken ?? "";
                return badge() ? `, ${badge()} unread` : "";
              };
              const dirty = () => selected() && views.isSaved() && views.changed();
              return (
                <button
                  type="button"
                  role="tab"
                  data-view={view.id}
                  aria-selected={selected()}
                  aria-haspopup={isBuiltInView(view.id) ? undefined : "menu"}
                  aria-label={`${view.name}${spoken()}${dirty() ? ", changed, not saved" : ""}`}
                  // One tab is in the tab order; the arrow keys move between the others.
                  tabIndex={selected() ? 0 : -1}
                  title={`${matters ? "Things that matter" : view.query === "" ? "Everything" : view.query}${i() < 9 ? `  ·  key ${i() + 1}` : ""}`}
                  class="vt"
                  onClick={() => {
                    views.select(view.id);
                    props.onPicked();
                  }}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    if (!isBuiltInView(view.id)) openMenu(view.id, e.clientX, e.clientY);
                  }}
                >
                  {view.name}
                  <Show when={badge()}>{(text) => <small aria-hidden="true">{text()}</small>}</Show>
                  <Show when={dirty()}>
                    <span class="dirty-dot" aria-hidden="true" title="Changed, not saved" />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
        <div class="flex-none">
          <button
            type="button"
            class="vt"
            aria-label="New view"
            title="New view: write a query, then save it"
            onClick={() => props.onNew()}
          >
            +
          </button>
        </div>
      </div>
      <Show when={menu()}>{(at) => <TabMenu views={views} at={at()} onClose={closeMenu} />}</Show>
    </>
  );
}

/** Rename, move and delete of one saved view (ADR 0027). Delete asks once, in place. */
function TabMenu(props: {
  views: ViewsStore;
  at: MenuAt;
  onClose: (focusTab: string | null) => void;
}) {
  const { views } = props;
  const [sure, setSure] = createSignal(false);
  const id = () => props.at.id;
  const index = () => views.saved().findIndex((v) => v.id === id());
  const name = () => views.saved()[index()]?.name ?? "";

  async function move(delta: number) {
    const target = id();
    await views.move(target, delta);
    props.onClose(target);
  }

  async function remove() {
    if (!sure()) {
      setSure(true);
      return;
    }
    const out = await views.remove(id());
    props.onClose(out.ok ? null : id());
  }

  return (
    <PopMenu
      label={`${name()} view`}
      x={props.at.x}
      y={props.at.y}
      onClose={(back) => props.onClose(back ? id() : null)}
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          views.startRename(id());
          props.onClose(null);
        }}
      >
        Rename
      </button>
      <button type="button" role="menuitem" disabled={index() <= 0} onClick={() => void move(-1)}>
        Move left
      </button>
      <button
        type="button"
        role="menuitem"
        disabled={index() < 0 || index() >= views.saved().length - 1}
        onClick={() => void move(1)}
      >
        Move right
      </button>
      <button type="button" role="menuitem" class="danger" onClick={() => void remove()}>
        <Show when={sure()} fallback="Delete">
          <span>Delete "</span>
          <span class="trunc">{name()}</span>
          <span>"?</span>
        </Show>
      </button>
    </PopMenu>
  );
}

/**
 * One row under the query bar: what the parser or a save had to say, and what can be done
 * with the text in the bar. Becomes the naming field while a name is asked for.
 */
export function ViewStatus(props: {
  views: ViewsStore;
  parsed: () => ParsedQuery;
  focusBar: () => void;
  focusList: () => void;
}) {
  const { views } = props;
  const diagnostic = () => props.parsed().diagnostics[0]?.message ?? "";
  const changedSaved = () => views.isSaved() && views.changed();
  const error = () => views.problem() || diagnostic();
  const left = () => error() || (changedSaved() ? `${views.active().name} changed` : "");
  const showSaveAs = () => views.changed() && !views.isSaved() && views.canSaveAs();
  const showSaved = () => changedSaved();
  const visible = () => left() !== "" || showSaveAs() || showSaved();
  const hold = (e: MouseEvent) => e.preventDefault();

  function save() {
    void views.save().then((out) => {
      if (out.ok) props.focusList();
    });
  }

  return (
    <Show
      when={views.naming()}
      keyed
      fallback={
        <Show when={visible()}>
          <div class="vstatus">
            <span
              class="msg"
              classList={{ err: error() !== "" }}
              role={error() ? "alert" : "status"}
            >
              {left()}
            </span>
            <Show when={showSaveAs()}>
              <button
                type="button"
                class="act main"
                title={SAVE_KEY}
                onMouseDown={hold}
                onClick={() => views.startNaming()}
              >
                Save as view
              </button>
            </Show>
            <Show when={showSaved()}>
              <button
                type="button"
                class="act"
                title="Esc"
                onMouseDown={hold}
                onClick={() => {
                  views.revert();
                  props.focusList();
                }}
              >
                Revert
              </button>
              <Show when={!views.blank()}>
                <button
                  type="button"
                  class="act"
                  onMouseDown={hold}
                  onClick={() => views.startNaming()}
                >
                  Save as new
                </button>
                <button
                  type="button"
                  class="act main"
                  title={SAVE_KEY}
                  onMouseDown={hold}
                  onClick={save}
                >
                  Save
                </button>
              </Show>
            </Show>
          </div>
        </Show>
      }
    >
      {(mode) => (
        <NameRow
          views={views}
          initial={mode.mode === "rename" ? mode.name : ""}
          rename={mode.mode === "rename" ? mode.id : null}
          focusBar={props.focusBar}
          focusList={props.focusList}
        />
      )}
    </Show>
  );
}

function NameRow(props: {
  views: ViewsStore;
  initial: string;
  /** The view being renamed; null for a new one. */
  rename: string | null;
  focusBar: () => void;
  focusList: () => void;
}) {
  const { views } = props;
  let input!: HTMLInputElement;
  const [error, setError] = createSignal("");
  let busy = false;

  onMount(() => {
    input.focus();
    input.select();
  });

  function back() {
    if (props.rename)
      document.querySelector<HTMLElement>(`[data-view="${CSS.escape(props.rename)}"]`)?.focus();
    else props.focusBar();
  }

  async function submit() {
    if (busy) return;
    busy = true;
    const out = await views.submitName(input.value);
    busy = false;
    if (!out.ok) {
      // The row stays, with the reason, and the typing is kept.
      setError(out.message);
      input.focus();
    } else if (props.rename) back();
    else props.focusList();
  }

  function cancel() {
    views.cancelNaming();
    back();
  }

  return (
    <div class="vstatus">
      <Show when={error()}>
        <span class="msg err basis-full" role="alert">
          {error()}
        </span>
      </Show>
      <input
        ref={input}
        aria-label="View name"
        placeholder="Name this view"
        maxLength={40}
        value={props.initial}
        autocomplete="off"
        spellcheck={false}
        onInput={() => setError("")}
        // Not delegated: it runs on the input itself, before the window's shortcuts could see it.
        on:keydown={(e: KeyboardEvent) => {
          e.stopPropagation();
          if (e.isComposing) return;
          if (e.key === "Enter" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "s")) {
            e.preventDefault();
            void submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            cancel();
          }
        }}
      />
      <button type="button" class="act main" onClick={() => void submit()}>
        Save
      </button>
      <button type="button" class="act" onClick={cancel}>
        Cancel
      </button>
    </div>
  );
}
