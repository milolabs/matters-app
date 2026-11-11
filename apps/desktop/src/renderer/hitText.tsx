import {
  type Accessor,
  createContext,
  createMemo,
  For,
  type JSX,
  Show,
  useContext,
} from "solid-js";
import { type HitSegment, highlight } from "./hits.ts";

/**
 * ADR 0077. The words the reader marks, handed down to the parts that show text: the thread's
 * title, the snippets of folded letters, the open letter's words, the names of the files. Empty
 * unless the thread was opened from a search that has free words.
 */
const NONE: readonly string[] = [];
export const HitsContext = createContext<Accessor<readonly string[]>>(() => NONE);
export const useHits = (): Accessor<readonly string[]> => useContext(HitsContext);

/** Segments as elements: the marked ones become `mark.hit`, the rest stay text nodes. */
export function Segments(props: {
  segments: readonly HitSegment[];
  /** The marks are stops of the match navigation (ADR 0077). */
  nav?: boolean;
}): JSX.Element {
  return (
    <For each={props.segments}>
      {(seg) =>
        seg.hit ? (
          <mark class="hit" data-nav={props.nav === true ? "" : undefined}>
            {seg.text}
          </mark>
        ) : (
          seg.text
        )
      }
    </For>
  );
}

/** Text with the reader's words marked. Without words it is the text itself, and nothing is cut. */
export function HitText(props: {
  text: string;
  anywhere?: boolean;
  nav?: boolean;
  /** Overrides the words of the context. */
  words?: readonly string[];
}): JSX.Element {
  const ctx = useHits();
  const words = () => props.words ?? ctx();
  const segments = createMemo<readonly HitSegment[]>(() =>
    words().length === 0 ? [] : highlight(props.text, words(), { anywhere: props.anywhere }),
  );
  return (
    <Show when={segments().length > 0} fallback={props.text}>
      <Segments segments={segments()} nav={props.nav} />
    </Show>
  );
}
