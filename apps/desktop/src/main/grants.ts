// Where a file gets its grant (ADR 0041, rule 3). The backend accepts grants, never paths: an API
// that took a path would let a compromised page attach ~/.ssh/id_rsa. Paths come only from here,
// from the open dialog or from a drop that the preload saw as a trusted event, and each becomes
// a one-use id. The page gets the id, the name and the size; the path goes to the router and no
// further. A pasted image has no path, so it is written to a private temporary file first and
// granted like any other, which leaves one way in for every file.
import { basename, isAbsolute } from "node:path";
import type { PickedFile } from "@matters/contracts";

/** A pasted image over this is refused (ADR 0041, rule 3). */
export const MAX_PASTE_BYTES = 50 * 1024 * 1024;
/** One drop or one dialog never names more than this; the rest is not a person's doing. */
const MAX_PATHS = 1000;

/** What a grant message to the router carries. */
export interface GrantMessage {
  readonly type: "grant";
  readonly grantId: string;
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

export interface GrantDeps {
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number } | null>;
  /** Writes a file only the app can read and returns where. */
  writeTemp(extension: string, bytes: Uint8Array): Promise<string>;
  removeTemp(path: string): Promise<void>;
  /** To the router, over the dedicated port. */
  send(message: GrantMessage): void;
  newId(): string;
}

const IMAGE_EXTENSIONS: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/heic": "heic",
};

const refused = (name: string, kind: PickedFile["kind"]): PickedFile => ({
  grantId: "",
  name,
  size: 0,
  kind,
});

export class GrantMint {
  private readonly deps: GrantDeps;
  /** Temporary files behind grants, to delete when the copy ends. */
  private readonly temps = new Map<string, string>();
  private pastes = 0;

  constructor(deps: GrantDeps) {
    this.deps = deps;
  }

  /** Grants for paths, in the order given; a folder or a missing path gets an answer, no grant. */
  async fromPaths(paths: unknown): Promise<PickedFile[]> {
    if (!Array.isArray(paths) || paths.length > MAX_PATHS) return [];
    const out: PickedFile[] = [];
    for (const path of paths) {
      // The preload gives "" for a file the operating system has no path for.
      if (typeof path !== "string" || path === "" || !isAbsolute(path)) {
        out.push(refused("", "missing"));
        continue;
      }
      const name = basename(path);
      const found = await this.deps.stat(path);
      if (!found) out.push(refused(name, "missing"));
      else if (found.isDirectory) out.push(refused(name, "directory"));
      else if (!found.isFile) out.push(refused(name, "missing"));
      else out.push(this.mint(path, name, found.size));
    }
    return out;
  }

  /** A pasted image: bytes to a private file, then a grant for that file. */
  async fromPaste(mime: unknown, bytes: unknown): Promise<PickedFile> {
    const extension = typeof mime === "string" ? IMAGE_EXTENSIONS[mime.toLowerCase()] : undefined;
    const data =
      bytes instanceof Uint8Array
        ? bytes
        : bytes instanceof ArrayBuffer
          ? new Uint8Array(bytes)
          : null;
    const name = this.pasteName(extension ?? "png");
    if (!extension || !data || data.byteLength === 0) return refused(name, "missing");
    if (data.byteLength > MAX_PASTE_BYTES) return refused(name, "tooLarge");
    const path = await this.deps.writeTemp(extension, data);
    const granted = this.mint(path, name, data.byteLength);
    this.temps.set(granted.grantId, path);
    return granted;
  }

  /** The copy behind this grant ended, or the grant was never used: a temporary file goes. */
  async release(grantId: string): Promise<void> {
    const path = this.temps.get(grantId);
    if (path === undefined) return;
    this.temps.delete(grantId);
    await this.deps.removeTemp(path).catch(() => {});
  }

  /** Quit: every temporary file goes. */
  async releaseAll(): Promise<void> {
    await Promise.all([...this.temps.keys()].map((id) => this.release(id)));
  }

  private mint(path: string, name: string, size: number): PickedFile {
    const grantId = this.deps.newId();
    this.deps.send({ type: "grant", grantId, path, name, size });
    return { grantId, name, size, kind: "file" };
  }

  private pasteName(extension: string): string {
    this.pastes++;
    return this.pastes === 1
      ? `Pasted image.${extension}`
      : `Pasted image ${this.pastes}.${extension}`;
  }
}
