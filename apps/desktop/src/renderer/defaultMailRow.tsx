import type { DefaultMailInfo } from "@matters/contracts";
import { createSignal, Match, onCleanup, Switch } from "solid-js";
import { askDefaultMail } from "./files.ts";
import { pill } from "./ui.ts";

/**
 * Settings › About's row for the default mail app (ADR 0143, rule 2): whether Matters opens the
 * `mailto:` links of other apps now, and the one button that asks macOS to make it so. Only the
 * person's press asks; nothing here asks at first run. macOS keeps the choice and may ask before
 * it changes it, so the row reads the state again when the window comes back to the front. macOS
 * has no way back that an app may call: the row says where the person chooses another app.
 */
export function DefaultMailRow() {
  const [info, setInfo] = createSignal<DefaultMailInfo | null>(null);
  const [asked, setAsked] = createSignal(false);
  const read = () => void askDefaultMail("get").then((next) => next && setInfo(next));
  read();
  window.addEventListener("focus", read);
  onCleanup(() => window.removeEventListener("focus", read));
  const make = () => {
    setAsked(true);
    void askDefaultMail("make").then((next) => next && setInfo(next));
  };

  return (
    <div data-default-mail class="border-b border-hairline px-5 py-4">
      <h3 class="mb-2 font-semibold">Default mail app</h3>
      <Switch>
        <Match when={info()?.offered === false}>
          <p role="status">This build cannot be the default mail app.</p>
          <p class="mt-1.5 text-[12px] text-secondary">
            It was not made by the release workflow. Mail links in messages still open a new message
            here.
          </p>
        </Match>
        <Match when={info()?.isDefault === true}>
          <p role="status">Matters is the default mail app.</p>
          <p class="mt-1.5 max-w-[520px] text-[12px] text-secondary">
            Mail links in your browser and other apps open a new message here. To choose another
            app, open Mail's settings: General › Default email reader.
          </p>
        </Match>
        <Match when={info()?.offered === true}>
          <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <p role="status" class="m-0 min-w-[200px] flex-1">
              Mail links in your browser and other apps open in another mail app.
            </p>
            <button type="button" class={pill} onClick={make}>
              Make Matters the default mail app
            </button>
          </div>
          <p class="mt-1.5 max-w-[520px] text-[12px] text-secondary">
            {asked()
              ? "If macOS asks whether to change the default, confirm there."
              : "macOS may ask you to confirm. Mail links in messages open a new message here either way."}
          </p>
        </Match>
      </Switch>
    </div>
  );
}
