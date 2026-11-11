/**
 * Names of received files (ADR 0043, rules 5 and 12). A name in a message is written by whoever
 * sent it, so it is never trusted: it is shown and written only after `safeFileName`, and a file
 * is handed to the operating system only when `isRunnableFile` says it does not run.
 */

/** The longest a stored name may be, in UTF-8 bytes. Common file systems allow 255; this leaves room. */
export const MAX_FILE_NAME_BYTES = 200;

/** Longest extension kept whole when a name must be cut; a longer "extension" is just text. */
const MAX_EXTENSION_BYTES = 24;

/**
 * Path separators, control characters (Cc), line and paragraph separators, and every format
 * character (Cf), which draws nothing but changes what is read. Among those are the bidirectional
 * controls, so `invoice.pdf` + U+202E + `exe` cannot read as `invoice.exe.pdf`, and the zero-width
 * characters and soft hyphen, so an extension that looks like `.pdf` is `.pdf`.
 */
const REMOVED = /[/\\\p{Cc}\p{Cf}\u2028\u2029]/gu;

/** A run of spaces can push the real extension out of sight: `report.pdf` + many spaces + `.exe`. */
const SPACE_RUN = /\s+/gu;

/** A half of a surrogate pair with no other half: not a character, and not writable in a name. */
const LONE_SURROGATE = /\p{Cs}/gu;

/** Windows will not make a file with one of these names, with or without an extension. */
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

const encoder = new TextEncoder();
const byteLength = (text: string): number => encoder.encode(text).byteLength;

/** Cuts `text` to at most `bytes` UTF-8 bytes, never in the middle of a character. */
function cutToBytes(text: string, bytes: number): string {
  let out = "";
  let used = 0;
  for (const char of text) {
    const n = byteLength(char);
    if (used + n > bytes) break;
    out += char;
    used += n;
  }
  return out;
}

/** `[stem, ".ext"]`; the extension is empty when there is none, or when it is not short enough to be one. */
function splitExtension(name: string): [string, string] {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return [name, ""];
  const extension = name.slice(dot);
  return byteLength(extension) > MAX_EXTENSION_BYTES ? [name, ""] : [name.slice(0, dot), extension];
}

const stripEdges = (text: string): string => text.replace(/^[.\s]+/, "").replace(/[.\s]+$/, "");

/**
 * A name that is safe to show and to create on any supported platform, always non-empty:
 *
 * - separators, control and format characters are removed, and a run of spaces becomes one;
 * - leading dots go (no hidden file, no `..`), and so do trailing dots and spaces, which Windows
 *   ignores and would turn `a.exe.` into `a.exe`;
 * - a Windows device name gets an underscore in front;
 * - it is cut to 200 bytes of UTF-8, keeping the extension;
 * - what is left of nothing is `fallback` (a name made from the type, see `nameFromType`).
 *
 * It decodes nothing: encoded words and RFC 2231 are the mail library's job. Applying it twice
 * gives what applying it once gives.
 */
export function safeFileName(name: string, fallback = "attachment"): string {
  const cleaned = stripEdges(
    name.replace(LONE_SURROGATE, "�").replace(REMOVED, "").replace(SPACE_RUN, " "),
  );
  const base = cleaned === "" ? stripEdges(fallback.replace(REMOVED, "")) || "attachment" : cleaned;
  const named = DEVICE_NAME.test(base) ? `_${base}` : base;
  if (byteLength(named) <= MAX_FILE_NAME_BYTES) return named;
  const [stem, extension] = splitExtension(named);
  const room = MAX_FILE_NAME_BYTES - byteLength(extension);
  // Cutting can leave a dot or a space at the end of the stem, or nothing at all.
  const cut = stripEdges(cutToBytes(stem, room));
  return `${cut === "" ? "attachment" : cut}${extension}`;
}

/** The extension a type is usually saved with; unknown types get none. */
const EXTENSIONS: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/json": "json",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/pkcs7-signature": "p7s",
  "application/x-pkcs7-signature": "p7s",
  "application/pgp-signature": "asc",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/heic": "heic",
  "image/svg+xml": "svg",
  "text/plain": "txt",
  "text/html": "html",
  "text/csv": "csv",
  "audio/mpeg": "mp3",
  "video/mp4": "mp4",
};

/**
 * What a part with no name is called (ADR 0043, rule 3): `message.eml` for a forwarded message,
 * `invite.ics` for a calendar invitation, else `attachment` with the type's usual extension.
 */
export function nameFromType(mimeType: string): string {
  const type = mimeType.toLowerCase().trim();
  if (type === "message/rfc822") return "message.eml";
  if (type === "text/calendar") return "invite.ics";
  const extension = EXTENSIONS[type];
  return extension === undefined ? "attachment" : `attachment.${extension}`;
}

/**
 * Extensions of files that execute, install or open a program when they are opened, on any
 * platform we may run on: opening a downloaded file must never be how code runs (ADR 0043,
 * rule 12). The list errs toward refusing; Save and Preview are always available.
 */
const RUNNABLE: ReadonlySet<string> = new Set([
  // macOS
  "app",
  "command",
  "tool",
  "workflow",
  "action",
  "terminal",
  "scpt",
  "scptd",
  "applescript",
  "dmg",
  "pkg",
  "mpkg",
  "webloc",
  "inetloc",
  "fileloc",
  "ftploc",
  "mobileconfig",
  "prefpane",
  "saver",
  "osax",
  "kext",
  "qlgenerator",
  "ipa",
  "iso",
  "img",
  "cdr",
  "sparseimage",
  // Pages that run scripts in the browser, with a local file's access
  "html",
  "htm",
  "xhtml",
  "shtml",
  "svg",
  "mht",
  "mhtml",
  "webarchive",
  // Documents that carry macros
  "docm",
  "dotm",
  "xlsm",
  "xltm",
  "xlam",
  "pptm",
  "potm",
  "ppam",
  // Windows
  "exe",
  "com",
  "scr",
  "pif",
  "msi",
  "msp",
  "bat",
  "cmd",
  "lnk",
  "url",
  "vbs",
  "vbe",
  "wsf",
  "wsh",
  "ps1",
  "psm1",
  "reg",
  "hta",
  "cpl",
  "chm",
  "gadget",
  "jse",
  "ws",
  "wsc",
  "sct",
  "msc",
  "inf",
  "ins",
  "isp",
  "scf",
  "hlp",
  "xll",
  "appx",
  "msix",
  "appref-ms",
  // Linux and Android
  "desktop",
  "run",
  "appimage",
  "deb",
  "rpm",
  "apk",
  // Scripts and runtimes
  "sh",
  "bash",
  "zsh",
  "csh",
  "tcsh",
  "ksh",
  "fish",
  "js",
  "mjs",
  "jar",
  "jnlp",
  "py",
  "pyc",
  "pyz",
  "pl",
  "rb",
  "php",
]);

/**
 * Whether opening this file may run something. Decided by the last extension only, as the
 * operating system does: `a.pdf.exe` runs and `a.exe.pdf` does not. Trailing dots and spaces are
 * ignored first, since Windows ignores them. A name with no extension does not count as
 * runnable: the files we write are mode 0600, so they have no execute bit to be launched by.
 */
export function isRunnableFile(name: string): boolean {
  const trimmed = name.replace(/[.\s]+$/, "");
  const dot = trimmed.lastIndexOf(".");
  if (dot < 0 || dot === trimmed.length - 1) return false;
  return RUNNABLE.has(trimmed.slice(dot + 1).toLowerCase());
}
