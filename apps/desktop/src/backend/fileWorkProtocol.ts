// Messages between the sync worker (ThreadedFileWork) and the attachment worker thread. Plain
// data only, so every value survives structured clone. Paths travel here, from the sync worker
// to this thread, and nowhere else (ADR 0041, rules 3 and 4).
import type { ComposeInput, FileWorkErrorKind, ReadableKind } from "@matters/core";

export type ToFileWorker =
  | {
      readonly type: "capture";
      readonly id: number;
      readonly attachmentId: string;
      readonly sourcePath: string;
    }
  | {
      readonly type: "build";
      readonly id: number;
      readonly input: ComposeInput;
      readonly files: readonly {
        readonly attachmentId: string;
        readonly name: string;
        readonly sha256: string;
      }[];
      readonly operationId: string;
    }
  /** Reads the text of a file in the cache of received files (ADR 0087, rule 3). */
  | {
      readonly type: "text";
      readonly id: number;
      readonly sourcePath: string;
      readonly kind: ReadableKind;
    }
  /** Stops a capture in flight and removes its partial copy. */
  | { readonly type: "abort"; readonly id: number };

export interface WireFileError {
  readonly kind: FileWorkErrorKind;
  readonly message: string;
  readonly file?: string;
}

export type FromFileWorker =
  | { readonly type: "progress"; readonly id: number; readonly fraction: number }
  | { readonly type: "done"; readonly id: number; readonly value: unknown }
  | { readonly type: "failed"; readonly id: number; readonly error: WireFileError };
