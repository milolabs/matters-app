import type { GeneralImages, ImageRule } from "@matters/core";
import { batch, createSignal } from "solid-js";
import type { Backend } from "./client.ts";

/** The image rules and the general setting, kept current by the backend's pushes (ADR 0037). */
export function createImageRulesStore(backend: Backend) {
  const [rules, setRules] = createSignal<readonly ImageRule[]>([]);
  const [general, setGeneral] = createSignal<GeneralImages>("ask");
  const [loaded, setLoaded] = createSignal(false);
  const [failure, setFailure] = createSignal("");

  async function refresh() {
    const r = await backend.listImageRules();
    batch(() => {
      setRules(r.rules);
      setGeneral(r.general);
      setLoaded(true);
    });
  }

  // A change from the other window, or from a message that was open: read it again.
  backend.onEvent((event) => {
    if (event.type === "imageRulesChanged") void refresh().catch(() => {});
  });

  /** Runs a write; a refusal is shown, and the lists are read again either way. */
  async function change(action: () => Promise<unknown>) {
    setFailure("");
    try {
      await action();
    } catch (e) {
      setFailure(e instanceof Error ? e.message : "That did not work.");
    }
    await refresh().catch(() => {});
  }

  return {
    rules,
    general,
    /** False until the first answer: the empty state must not flash before it. */
    loaded,
    failure,
    refresh,
    setGeneral: (value: GeneralImages) => {
      // The choice shows at once; the answer decides whether it stays.
      setGeneral(value);
      return change(() => backend.setGeneralImages(value));
    },
    remove: (rule: ImageRule) => change(() => backend.removeImageRule(rule.scope, rule.value)),
  };
}

export type ImageRulesStore = ReturnType<typeof createImageRulesStore>;
