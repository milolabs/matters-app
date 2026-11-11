import type { GeneralImages } from "@matters/core";
import { For, onMount, Show } from "solid-js";
import type { Backend } from "./client.ts";
import { createImageRulesStore } from "./imageRules.ts";

const small =
  "h-[28px] cursor-default rounded-[8px] bg-button px-3 text-[12px] font-semibold disabled:opacity-40";

const CHOICES: readonly { value: GeneralImages; label: string }[] = [
  { value: "ask", label: "Ask each time" },
  { value: "always", label: "Always show images" },
];

/**
 * What the reader decided about remote images (ADR 0037): the general setting and the list of
 * rules, each of which can be taken back. A section of the settings window.
 */
export function ImagesSection(props: { backend: Backend }) {
  const images = createImageRulesStore(props.backend);
  onMount(() => void images.refresh().catch(() => {}));

  return (
    <section aria-label="Images" class="flex h-full flex-col">
      <div class="drag flex h-[52px] shrink-0 items-center gap-3 border-b border-hairline px-5">
        <h2 class="flex-1 font-serif text-[17px] font-semibold">Images</h2>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <div class="border-b border-hairline px-5 py-4">
          <fieldset class="m-0 border-0 p-0">
            <legend class="mb-2 font-semibold">Remote images in messages</legend>
            <For each={CHOICES}>
              {(choice) => (
                <label class="flex cursor-default items-center gap-2.5 py-1 text-[13px]">
                  <input
                    type="radio"
                    name="images-general"
                    value={choice.value}
                    checked={images.general() === choice.value}
                    onChange={() => void images.setGeneral(choice.value)}
                  />
                  {choice.label}
                </label>
              )}
            </For>
          </fieldset>
          <p class="mt-3 text-[12px] text-secondary">
            Images that are shown load directly from the sender's servers, which can see your IP
            address and that you opened the message. Until you allow them, no image loads.
          </p>
          <p class="mt-1.5 text-[12px] text-secondary">
            Always show images does not apply to senders that fail verification, and neither does a
            rule that allows images. A rule for a whole domain applies only to senders that pass it.
            You can still show images for a single message.
          </p>
          <Show when={images.failure() !== ""}>
            <p role="alert" class="mt-2 text-[13px] text-late">
              {images.failure()}
            </p>
          </Show>
        </div>
        <h3 class="px-5 pt-4 pb-1 font-semibold">Rules</h3>
        <For
          each={images.rules()}
          fallback={
            <Show when={images.loaded()}>
              <p class="px-5 py-6 text-[13px] text-secondary">
                No rules yet. When a message asks, choose Always from a sender or a domain, and it
                will be listed here.
              </p>
            </Show>
          }
        >
          {(rule) => (
            <div
              data-image-rule={`${rule.scope}:${rule.value}`}
              class="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-hairline px-5 py-2.5 last:border-b-0"
            >
              <span class="w-[58px] shrink-0 text-[12px] text-secondary capitalize">
                {rule.scope}
              </span>
              <span class="min-w-0 flex-1 [overflow-wrap:anywhere]">{rule.value}</span>
              <span
                class="shrink-0 text-[12px]"
                classList={{
                  "text-secondary": rule.decision === "allow",
                  "text-late": rule.decision === "deny",
                }}
              >
                {rule.decision === "allow" ? "Show images" : "Never show"}
              </span>
              <button
                type="button"
                class={small}
                aria-label={`Remove the rule for ${rule.value}`}
                onClick={() => void images.remove(rule)}
              >
                Remove
              </button>
            </div>
          )}
        </For>
      </div>
    </section>
  );
}
