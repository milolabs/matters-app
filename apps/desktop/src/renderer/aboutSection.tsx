import { createEffect, createSignal, Match, onCleanup, Show, Switch } from "solid-js";
import { askRelease, type ReleaseAsk } from "./files.ts";
import { MattersMark } from "./icons.tsx";
import {
  type AboutState,
  aboutState,
  checkedLine,
  publishedLine,
  type ReleaseStore,
  versionLine,
} from "./newerVersion.ts";
import { pill, pillPrimary } from "./ui.ts";

const link = "cursor-default text-secondary underline underline-offset-2 hover:text-ink";

/** The words of a state that has its own (could not check, not checked yet). */
const lineOf = (s: AboutState) => (s.kind === "failed" || s.kind === "unchecked" ? s.line : "");
const subOf = (s: AboutState) => (s.kind === "failed" ? s.sub : "");

/**
 * Settings › About (ADR 0137, rule 11): the name, the version and its stage, the line that says
 * where the check stands, the switch, when it last checked, and Check now. With a newer version,
 * two actions that open the browser; the app installs nothing. Main opens the links by name.
 */
export function AboutSection(props: { release: ReleaseStore }) {
  const info = () => props.release.info();
  const ask = (a: ReleaseAsk) => void askRelease(a).then((next) => props.release.take(next));
  const open = (which: Extract<ReleaseAsk, { action: "open" }>["which"]) =>
    ask({ action: "open", which });
  // Seeing About takes the dot away, in every window, until a newer one is out (rule 10). Seeing:
  // a version that comes while the window is minimized or hidden is not seen until it is back.
  const [visible, setVisible] = createSignal(document.visibilityState === "visible");
  const onVisibility = () => setVisible(document.visibilityState === "visible");
  document.addEventListener("visibilitychange", onVisibility);
  onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));
  createEffect(() => {
    if (visible() && info()?.dot) ask({ action: "seen" });
  });

  return (
    <section aria-label="About" class="flex h-full flex-col">
      <div class="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-5">
        <h2 class="flex-1 font-serif text-[17px] font-semibold">About</h2>
      </div>
      <Show when={info()}>
        {(i) => (
          <div class="min-h-0 flex-1 overflow-y-auto">
            <div class="border-b border-hairline px-5 py-4">
              <div class="flex items-center gap-3">
                <span class="inline-flex size-10 shrink-0 items-center justify-center rounded-[9px] bg-fill">
                  <MattersMark size={22} />
                </span>
                <div>
                  <strong class="block font-serif text-[15px] font-semibold">Matters</strong>
                  <small class="text-[12px] text-secondary">{versionLine(i())}</small>
                </div>
              </div>
              <Switch>
                <Match when={aboutState(i()).kind === "newer" && i().newer}>
                  {(newer) => (
                    <>
                      <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                        <p role="status" class="m-0 min-w-[200px] flex-1">
                          <b>{newer().version} is out.</b> {publishedLine(newer().dateMs)}
                        </p>
                        <Show when={newer().notes}>
                          <button type="button" class={pill} onClick={() => open("notes")}>
                            Release notes<span class="ml-0.5 text-secondary">↗</span>
                          </button>
                        </Show>
                        <Show when={newer().download}>
                          <button
                            type="button"
                            class={pillPrimary}
                            onClick={() => open("download")}
                          >
                            Download ↗
                          </button>
                        </Show>
                      </div>
                      <p class="mt-1.5 max-w-[520px] text-[12px] text-secondary">
                        Matters does not install it. The download opens in your browser.
                        <Show when={newer().preRelease}>
                          {" "}
                          It is a pre-release, so macOS will ask before it opens it.
                        </Show>
                      </p>
                    </>
                  )}
                </Match>
                <Match when={aboutState(i()).kind === "source"}>
                  <p role="status" class="mt-3">
                    This build does not check for newer versions.
                  </p>
                  <p class="mt-1.5 text-[12px] text-secondary">
                    It was not made by the release workflow.
                  </p>
                </Match>
                <Match when={aboutState(i()).kind === "off"}>
                  <p role="status" class="mt-3">
                    Matters does not check for newer versions.
                  </p>
                  <p class="mt-1.5 text-[12px] text-secondary">
                    Releases are listed at{" "}
                    <button type="button" class={link} onClick={() => open("site")}>
                      getmatters.app ↗
                    </button>
                  </p>
                </Match>
                <Match when={aboutState(i()).kind === "newest"}>
                  <p role="status" class="mt-3">
                    This is the newest version.
                  </p>
                </Match>
                <Match when={lineOf(aboutState(i()))}>
                  {(line) => (
                    <>
                      <p role="status" class="mt-3">
                        {line()}
                      </p>
                      <Show when={subOf(aboutState(i()))}>
                        {(sub) => <p class="mt-1.5 text-[12px] text-secondary">{sub()}</p>}
                      </Show>
                    </>
                  )}
                </Match>
              </Switch>
            </div>
            <div class="border-b border-hairline px-5 py-4">
              <h3 class="mb-2 font-semibold">Newer versions</h3>
              <label class="flex cursor-default items-center gap-2.5 py-1 text-[13px]">
                <input
                  type="checkbox"
                  checked={i().asks && i().enabled}
                  disabled={!i().asks}
                  onChange={(e) => ask({ action: "enable", on: e.currentTarget.checked })}
                />
                Check for a newer version
              </label>
              <div class="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">
                <p class="m-0 min-w-[200px] flex-1 text-[12px] text-secondary">
                  {checkedLine(i())}
                </p>
                <button
                  type="button"
                  class={pill}
                  disabled={!i().asks || !i().enabled || i().checking}
                  onClick={() => ask({ action: "check" })}
                >
                  Check now
                </button>
              </div>
            </div>
            <div class="px-5 py-4">
              <p class="m-0 text-[12px] text-secondary">
                AGPL-3.0-only ·{" "}
                <button type="button" class={link} onClick={() => open("source")}>
                  Source
                </button>{" "}
                ↗ ·{" "}
                <button type="button" class={link} onClick={() => open("issues")}>
                  Report a problem
                </button>{" "}
                ↗
              </p>
            </div>
          </div>
        )}
      </Show>
    </section>
  );
}
