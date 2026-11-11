// The page's way to get files into a draft, as messages (ADR 0041, rule 3). Nothing here takes a
// path from the page: a pick takes nothing, a paste takes bytes and a type, and a drop reads the
// paths itself, from a trusted event, with `getPathForFile`. Main turns each path into a one-use
// grant and the page gets only the grant, the name and the size.
import type { PickedFile } from "@matters/contracts";

export const CHANNEL_PICK = "matters:pick-files";
export const CHANNEL_DROP = "matters:grant-paths";
export const CHANNEL_PASTE = "matters:paste-image";

export interface FileBridgeDeps {
  /** `webUtils.getPathForFile`; "" for a file made by script. Used only for trusted drops. */
  getPath(file: File): string;
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  /** To the page, which listens on `window`. */
  post(message: unknown): void;
}

export interface DropEventLike {
  readonly isTrusted: boolean;
  readonly dataTransfer: { readonly files: ArrayLike<File> } | null;
  preventDefault(): void;
}

export interface PageMessageLike {
  readonly source: unknown;
  readonly data: unknown;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isRequestId = (v: unknown): v is string => typeof v === "string" && v.length <= 100;

/** What a failed ask means for the page: nothing was granted. */
const none: PickedFile[] = [];

function asFiles(v: unknown): PickedFile[] {
  return Array.isArray(v) ? (v as PickedFile[]) : none;
}

export function createFileBridge(deps: FileBridgeDeps, pageWindow: unknown) {
  let dropSeq = 0;
  // Answers go out in the order the files were dropped, whichever ask main answers first.
  let tail: Promise<void> = Promise.resolve();

  return {
    /** Capture-phase `drop` on the window. */
    drop(event: DropEventLike): void {
      // A page script can build a drop event; only the user's own carries real files (and
      // `getPathForFile` would give nothing for a script's File anyway).
      if (!event.isTrusted) return;
      const files = event.dataTransfer?.files;
      if (!files || files.length === 0) return;
      // A dropped file must never navigate the window to it.
      event.preventDefault();
      const paths = Array.from(files, (file) => deps.getPath(file));
      const dropId = ++dropSeq;
      const asked = deps.invoke(CHANNEL_DROP, paths).then(asFiles, () => none);
      tail = tail
        .then(() => asked)
        .then((granted) => deps.post({ mattersDropped: { dropId, files: granted } }));
    },

    /** The page's messages to the preload on `window`. */
    message(event: PageMessageLike): void {
      const data = event.data;
      if (event.source !== pageWindow || !isRecord(data)) return;
      const pick = data.mattersPickFiles;
      if (isRecord(pick) && isRequestId(pick.requestId)) {
        const requestId = pick.requestId;
        deps
          .invoke(CHANNEL_PICK)
          .then(asFiles, () => none)
          .then((files) => deps.post({ mattersPicked: { requestId, files } }));
      }
      const paste = data.mattersPasteImage;
      if (isRecord(paste) && isRequestId(paste.requestId)) {
        const requestId = paste.requestId;
        const { mime, data: bytes } = paste;
        // Bytes and a type, never a path: main writes the file itself.
        if (
          typeof mime !== "string" ||
          !(bytes instanceof ArrayBuffer || ArrayBuffer.isView(bytes))
        ) {
          deps.post({ mattersPasted: { requestId, file: null } });
          return;
        }
        deps
          .invoke(CHANNEL_PASTE, mime, bytes)
          .then(
            (file) => (isRecord(file) ? (file as unknown as PickedFile) : null),
            () => null,
          )
          .then((file) => deps.post({ mattersPasted: { requestId, file } }));
      }
    },
  };
}
