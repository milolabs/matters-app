import type { SenderAuth } from "@matters/core";

/** Maps a host to its registrable domain, or `undefined` when it has none (ADR 0037). */
export type RegistrableDomain = (host: string) => string | undefined;

type Token =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "quoted"; readonly text: string }
  | { readonly kind: "eq" }
  | { readonly kind: "semi" };

/**
 * Splits a header value into words, quoted strings, `=` and `;`. Comments (RFC 5322, nested,
 * with quoted pairs) are dropped, and a quoted string stays one token: whatever it holds can
 * never be read as a result. An unclosed comment or quote swallows the rest, so malformed
 * input loses results instead of gaining them.
 */
function tokenize(value: string): Token[] {
  const tokens: Token[] = [];
  let word = "";
  const flush = () => {
    if (word !== "") tokens.push({ kind: "word", text: word });
    word = "";
  };
  let i = 0;
  while (i < value.length) {
    const c = value.charAt(i);
    if (c === "(") {
      flush();
      let depth = 1;
      i++;
      while (i < value.length && depth > 0) {
        const d = value.charAt(i);
        if (d === "\\") i++;
        else if (d === "(") depth++;
        else if (d === ")") depth--;
        i++;
      }
    } else if (c === '"') {
      flush();
      let text = "";
      i++;
      while (i < value.length && value.charAt(i) !== '"') {
        if (value.charAt(i) === "\\") i++;
        text += value.charAt(i);
        i++;
      }
      i++;
      tokens.push({ kind: "quoted", text });
    } else if (c === ";") {
      flush();
      tokens.push({ kind: "semi" });
      i++;
    } else if (c === "=") {
      flush();
      tokens.push({ kind: "eq" });
      i++;
    } else if (/\s/.test(c)) {
      flush();
      i++;
    } else {
      word += c;
      i++;
    }
  }
  flush();
  return tokens;
}

interface MethodResult {
  readonly method: string;
  readonly result: string;
  /** `ptype.property` in lower case, e.g. `header.d`. */
  readonly props: ReadonlyMap<string, string>;
}

/** The `method=result` entries after the authserv-id, each with its properties. */
function results(value: string): MethodResult[] {
  const segments: Token[][] = [[]];
  for (const t of tokenize(value)) {
    if (t.kind === "semi") segments.push([]);
    else segments[segments.length - 1]?.push(t);
  }
  const out: MethodResult[] = [];
  // The first segment is the authserv-id and an optional version.
  for (const seg of segments.slice(1)) {
    const [method, eq, result] = seg;
    if (method?.kind !== "word" || eq?.kind !== "eq" || result?.kind !== "word") continue;
    const props = new Map<string, string>();
    for (let i = 3; i < seg.length; ) {
      const key = seg[i];
      const sign = seg[i + 1];
      const val = seg[i + 2];
      if (
        key?.kind === "word" &&
        sign?.kind === "eq" &&
        (val?.kind === "word" || val?.kind === "quoted")
      ) {
        // The first one wins: a repeated property cannot override what came before.
        if (!props.has(key.text.toLowerCase())) props.set(key.text.toLowerCase(), val.text);
        i += 3;
      } else {
        i++;
      }
    }
    out.push({ method: method.text.toLowerCase(), result: result.text.toLowerCase(), props });
  }
  return out;
}

function hostOf(address: string): string {
  return address
    .slice(address.lastIndexOf("@") + 1)
    .toLowerCase()
    .replace(/\.$/, "");
}

/**
 * The authserv-id of a header: its first segment, a plain word (RFC 8601 section 2.2), lower case
 * and without a trailing dot. `undefined` when the header does not start with one. Microsoft's
 * header commonly starts straight with `spf=pass ...`; that first segment is a result, so the
 * header has no id, and nothing can be said about who wrote it.
 */
export function authservId(value: string): string | undefined {
  const [first, second] = tokenize(value);
  if (first?.kind !== "word" || second?.kind === "eq") return undefined;
  const id = first.text.toLowerCase().replace(/\.$/, "");
  return id === "" ? undefined : id;
}

/**
 * The header to read: walking `values` from the top, the first whose authserv-id the account
 * trusts (RFC 8601 sections 4.1 and 7.1). Every other header is ignored, whatever it says. With no
 * `isTrusted` the list of trusted ids is empty, so nothing is read.
 */
export function firstTrustedHeader(
  values: readonly string[],
  isTrusted: ((id: string) => boolean) | undefined,
): string | undefined {
  if (isTrusted === undefined) return undefined;
  for (const value of values) {
    const id = authservId(value);
    if (id !== undefined && isTrusted(id)) return value;
  }
  return undefined;
}

/**
 * The verdict on the sender from one `Authentication-Results` header that the caller has already
 * chosen as the receiving server's (`firstTrustedHeader`; ADR 0037, 0048). DMARC decides; without a
 * DMARC result an aligned DKIM pass counts. Anything else is `unknown`.
 *
 * A `dmarc=pass` counts only when its `header.from` has the registrable domain of the address the
 * reader sees: a pass for another domain, or one that names none, is `unknown` (and the DKIM
 * fallback does not apply, since DMARC did answer). A `dmarc=fail` is `fail` whatever it names.
 *
 * `from` is the single address of the `From` header, or `undefined` when there is not exactly one.
 */
export function readSenderAuth(
  header: string | undefined,
  from: string | undefined,
  registrable: RegistrableDomain,
): SenderAuth {
  if (header === undefined || from === undefined || !from.includes("@")) return "unknown";
  const fromHost = hostOf(from);
  if (fromHost === "") return "unknown";
  const all = results(header);
  const fromDomain = registrable(fromHost);

  const dmarc = all.filter((r) => r.method === "dmarc");
  // A failure wins over a pass in the same header: the server meant at least one of them.
  if (dmarc.some((r) => r.result === "fail")) return "fail";
  const passes = dmarc.filter((r) => r.result === "pass");
  if (passes.length > 0) {
    const aligned = passes.some((r) => {
      const named = r.props.get("header.from");
      if (named === undefined || fromDomain === undefined) return false;
      const host = named.includes("@") ? hostOf(named) : named.toLowerCase().replace(/\.$/, "");
      return host !== "" && registrable(host) === fromDomain;
    });
    return aligned ? "pass" : "unknown";
  }

  if (fromDomain === undefined) return "unknown";
  for (const r of all) {
    if (r.method !== "dkim" || r.result !== "pass") continue;
    const signer = r.props.get("header.d") ?? signerOfIdentity(r.props.get("header.i"));
    if (signer === undefined) continue;
    if (registrable(signer.toLowerCase().replace(/\.$/, "")) === fromDomain) return "pass";
  }
  return "unknown";
}

/** `header.i` is `@domain` or `local@domain`. */
function signerOfIdentity(identity: string | undefined): string | undefined {
  if (identity === undefined || !identity.includes("@")) return undefined;
  const host = hostOf(identity);
  return host === "" ? undefined : host;
}
