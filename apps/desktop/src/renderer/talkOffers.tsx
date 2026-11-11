// The rows of what an answer offers, one component per kind, and the counts it rests on (ADR
// 0102). Only a press here does anything; the agent cannot.
import type {
  SavedView,
  TalkActOffer,
  TalkFact,
  TalkMessageOffer,
  TalkOffer,
  TalkViewOffer,
} from "@matters/core";
import { createSignal, For, Match, Show, Switch } from "solid-js";
import {
  type ActPaths,
  actButton,
  actDone,
  actLine,
  actQuestion,
  actTooMany,
  bodyPreview,
  type DraftPrefill,
  factLines,
  type OfferOutcome,
  offerCount,
  prefillOf,
  type ResolvedAct,
  runAct,
  savedViewFor,
  saveViewOffers,
  TOO_MANY,
  unknownLine,
  unreadOf,
} from "./talkOffers.ts";

const mini =
  "h-[22px] shrink-0 cursor-default rounded-[6px] bg-button px-2 text-[11.5px] text-ink disabled:opacity-35";
const row =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-0.5 border-t border-hairline px-0.5 py-1.5 first:border-t-0";
const queryButton =
  "col-span-2 min-w-0 cursor-default truncate text-left font-mono text-[12px] text-secondary hover:text-ink";

/** What the rows need of the app: the views, the list's own paths, the composer. */
export interface OfferActions {
  /** The saved views now: a view offer with the same name and query shows as saved. */
  readonly saved: () => readonly SavedView[];
  /** Saves a view through the sync worker (ADR 0027), and its notifications when it asks. */
  saveView(offer: TalkViewOffer): Promise<OfferOutcome>;
  /** Switches to a saved view's tab. */
  openView(id: string): void;
  /** All mail with this query in the bar: try it, or see what a clean-up would take. */
  showSearch(query: string): void;
  /** What a clean-up's query matches now. */
  resolve(query: string): Promise<ResolvedAct>;
  /** The list's move and mark. */
  readonly paths: ActPaths;
  /** The composer of a new message, filled in; nothing is saved until the person writes. */
  openDraft(prefill: DraftPrefill): void;
}

function Problem(props: { text: string | undefined }) {
  return (
    <Show when={props.text}>
      {(text) => (
        <p role="alert" class="col-span-2 text-[12px] text-late">
          {text()}
        </p>
      )}
    </Show>
  );
}

function Why(props: { text: string }) {
  // Why wraps, it is never cut, like the note of a thread.
  return (
    <span class="col-span-2 text-[12px] leading-[1.4] text-mid [overflow-wrap:anywhere]">
      {props.text}
    </span>
  );
}

function ViewRow(props: {
  offer: TalkViewOffer;
  actions: OfferActions;
  said: OfferOutcome | undefined;
  busy: boolean;
  onSave: () => void;
}) {
  const savedAs = () => savedViewFor(props.offer, props.actions.saved());
  const label = () => (props.offer.notify === true ? "Save view and notify" : "Save view");
  return (
    <div class={row}>
      <span class="truncate font-semibold">{props.offer.name}</span>
      <Show
        when={savedAs()}
        fallback={
          <button
            type="button"
            class={mini}
            disabled={props.busy}
            aria-label={`${label()} ${props.offer.name}`}
            onClick={() => props.onSave()}
          >
            {label()}
          </button>
        }
      >
        {(view) => (
          <button
            type="button"
            class={mini}
            aria-label={`Saved. Open view ${props.offer.name}`}
            onClick={() => props.actions.openView(view().id)}
          >
            Saved · Open
          </button>
        )}
      </Show>
      <button
        type="button"
        class={queryButton}
        title="Try this search in All mail"
        aria-label={`Try the search ${props.offer.query} in All mail`}
        onClick={() => props.actions.showSearch(props.offer.query)}
      >
        {props.offer.query}
      </button>
      <Why text={props.offer.why} />
      <span class="col-span-2 text-[11px] text-secondary">{offerCount(props.offer)}</span>
      <Problem
        text={
          props.said === undefined
            ? undefined
            : props.said.ok
              ? props.said.note
              : props.said.message
        }
      />
    </div>
  );
}

type ActState =
  | { readonly step: "idle" }
  | { readonly step: "asking"; readonly resolved: ResolvedAct; readonly question: string }
  | { readonly step: "done"; readonly resolved: ResolvedAct; readonly text: string };

function ActRow(props: { offer: TalkActOffer; actions: OfferActions }) {
  const [state, setState] = createSignal<ActState>({ step: "idle" });
  const [problem, setProblem] = createSignal<string | undefined>();
  const [busy, setBusy] = createSignal(false);
  const show = () => props.actions.showSearch(props.offer.query);
  async function ask() {
    setBusy(true);
    setProblem(undefined);
    try {
      // What the query matches now is what is acted on; the count of the offer is not.
      const resolved = await props.actions.resolve(props.offer.query);
      if (resolved.tooMany) return setProblem(TOO_MANY);
      const question = actQuestion(props.offer.action, resolved);
      if (question === null) return setProblem("Nothing matches this any more.");
      setState({ step: "asking", resolved, question });
    } catch {
      setProblem("That search did not work. Try again.");
    } finally {
      setBusy(false);
    }
  }
  async function run(resolved: ResolvedAct) {
    setBusy(true);
    const out = await runAct(props.offer.action, resolved, props.actions.paths);
    setBusy(false);
    if (out.ok) setState({ step: "done", resolved, text: actDone(props.offer.action, resolved) });
    else {
      setState({ step: "idle" });
      setProblem(out.message);
    }
  }
  return (
    <div class={row}>
      <span class="truncate font-semibold">{actLine(props.offer)}</span>
      <span class="flex shrink-0 gap-1">
        <button type="button" class={mini} onClick={show}>
          Show them
        </button>
        <Show when={!actTooMany(props.offer) && state().step === "idle"}>
          <button
            type="button"
            class={mini}
            disabled={busy()}
            aria-label={`${actButton(props.offer.action)}: ask before doing it`}
            onClick={() => void ask()}
          >
            {actButton(props.offer.action)}
          </button>
        </Show>
      </span>
      <button
        type="button"
        class={queryButton}
        title="Show this search in All mail"
        aria-label={`Show the search ${props.offer.query} in All mail`}
        onClick={show}
      >
        {props.offer.query}
      </button>
      <Why text={props.offer.why} />
      <Show when={actTooMany(props.offer)}>
        <span class="col-span-2 text-[11px] text-secondary">{TOO_MANY}</span>
      </Show>
      <Switch>
        <Match
          when={state().step === "asking" && (state() as Extract<ActState, { step: "asking" }>)}
        >
          {(asking) => (
            <fieldset
              class="col-span-2 m-0 flex min-w-0 items-center gap-2 border-0 p-0 pt-0.5"
              aria-label={asking().question}
            >
              <p class="m-0 min-w-0 flex-1 text-[12px]">{asking().question}</p>
              <button
                type="button"
                class={mini}
                disabled={busy()}
                onClick={() => void run(asking().resolved)}
              >
                {actButton(props.offer.action)}
              </button>
              <button
                type="button"
                class={mini}
                disabled={busy()}
                onClick={() => setState({ step: "idle" })}
              >
                Cancel
              </button>
            </fieldset>
          )}
        </Match>
        <Match when={state().step === "done" && (state() as Extract<ActState, { step: "done" }>)}>
          {(done) => (
            <div class="col-span-2 flex items-center gap-2 pt-0.5" role="status">
              <p class="m-0 min-w-0 flex-1 text-[12px] text-secondary">{done().text}</p>
              <Show when={props.offer.action === "markRead"}>
                <button
                  type="button"
                  class={mini}
                  onClick={() =>
                    void props.actions.paths
                      .markSeen(unreadOf(done().resolved), false)
                      .then(() => setState({ step: "idle" }))
                  }
                >
                  Undo
                </button>
              </Show>
            </div>
          )}
        </Match>
      </Switch>
      <Show when={state().step === "idle"}>
        <span class="col-span-2 text-[11px] text-secondary">
          {offerCount(props.offer)} when the agent counted
        </span>
      </Show>
      <Problem text={problem()} />
    </div>
  );
}

function MessageRow(props: { offer: TalkMessageOffer; actions: OfferActions }) {
  const to = () => (props.offer.to.length === 0 ? "nobody yet" : props.offer.to.join(", "));
  return (
    <div class={row}>
      <span class="truncate font-semibold">{props.offer.subject}</span>
      <button
        type="button"
        class={mini}
        aria-label={`Open draft ${props.offer.subject} in a new message`}
        onClick={() => props.actions.openDraft(prefillOf(props.offer))}
      >
        Open draft
      </button>
      <span class="col-span-2 truncate text-[12px] text-secondary">To: {to()}</span>
      <p class="col-span-2 m-0 whitespace-pre-wrap text-[12px] leading-[1.4] text-mid [overflow-wrap:anywhere]">
        {bodyPreview(props.offer.body)}
      </p>
      <Why text={props.offer.why} />
      <Show when={unknownLine(props.offer)}>
        {(line) => <span class="col-span-2 text-[11px] text-secondary">{line()}</span>}
      </Show>
    </div>
  );
}

/**
 * The block of offers under an answer (ADR 0102): one row per offer, in the answer's order, with
 * `Save all views` when more than one view is not saved yet.
 */
export function OfferRows(props: { offers: readonly TalkOffer[]; actions: OfferActions }) {
  // What the last save of a view said, by its place: an error, or a note; cleared on a new try.
  const [said, setSaid] = createSignal<ReadonlyMap<number, OfferOutcome>>(new Map());
  const [saving, setSaving] = createSignal(false);
  const unsaved = () =>
    props.offers.filter(
      (o) => o.kind === "view" && savedViewFor(o, props.actions.saved()) === undefined,
    ).length;
  async function save(only?: number) {
    if (saving()) return;
    setSaving(true);
    try {
      const list = props.offers.map((o, i) => (only === undefined || i === only ? o : null));
      const kept = list.flatMap((o) => (o === null ? [] : [o]));
      const at = list.flatMap((o, i) => (o === null ? [] : [i]));
      const out = await saveViewOffers(kept, props.actions.saved, (o) => props.actions.saveView(o));
      setSaid((was) => {
        const next = new Map(was);
        for (const i of at) next.delete(i);
        for (const [j, o] of out) next.set(at[j] as number, o);
        return next;
      });
    } finally {
      setSaving(false);
    }
  }
  return (
    <section aria-label="What the agent offers to do" class="flex flex-col">
      <For each={props.offers}>
        {(offer, i) => (
          <Switch>
            <Match when={offer.kind === "view" && offer}>
              {(view) => (
                <ViewRow
                  offer={view()}
                  actions={props.actions}
                  said={said().get(i())}
                  busy={saving()}
                  onSave={() => void save(i())}
                />
              )}
            </Match>
            <Match when={offer.kind === "act" && offer}>
              {(act) => <ActRow offer={act()} actions={props.actions} />}
            </Match>
            <Match when={offer.kind === "message" && offer}>
              {(message) => <MessageRow offer={message()} actions={props.actions} />}
            </Match>
          </Switch>
        )}
      </For>
      <Show when={unsaved() > 1}>
        <div class="pt-1">
          <button type="button" class={mini} disabled={saving()} onClick={() => void save()}>
            Save all views
          </button>
        </div>
      </Show>
    </section>
  );
}

/**
 * The counts an answer rests on (ADR 0102, rule 9), apart from its text: these numbers are the
 * code's, the text's are the model's.
 */
export function FactRows(props: { facts: readonly TalkFact[] }) {
  return (
    <section aria-label="Counted on this Mac" class="flex flex-col gap-0.5">
      <p class="m-0 text-[11px] text-secondary">Counted on this Mac, not by the agent:</p>
      <For each={factLines(props.facts)}>
        {(line) => (
          <p class="m-0 flex items-baseline gap-1.5 text-[12px] text-secondary" data-agent-fact>
            <span class="min-w-0 truncate">{line.label}</span>
            <Show when={line.query}>
              {(query) => <span class="min-w-0 truncate font-mono">{query()}</span>}
            </Show>
            <span class="shrink-0">{line.count}</span>
          </p>
        )}
      </For>
    </section>
  );
}
