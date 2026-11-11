// Throwaway certificates for the transport tier, made with the `openssl` command at test time: no
// key or certificate is ever committed. Node cannot build X.509 itself, and a dev dependency for
// it would need a licence review (ADR 0013); `openssl` is on every machine that builds this repo.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface KeyPair {
  readonly key: string;
  readonly cert: string;
}

export interface TestPki {
  /** The CA the process is made to trust for the control case only. */
  readonly caPem: string;
  /** Valid for 127.0.0.1 and localhost, issued by the trusted CA. */
  readonly good: KeyPair;
  /** Issued by the trusted CA, valid for other.example.test only. */
  readonly wrongHost: KeyPair;
  /** Issued by the trusted CA for 127.0.0.1, expired in 2020. */
  readonly expired: KeyPair;
  /** Self-signed for 127.0.0.1. */
  readonly selfSigned: KeyPair;
  /** Valid name, issued by a CA nobody trusts. */
  readonly unknownCa: KeyPair;
  dispose(): void;
}

function openssl(args: string[], cwd: string): void {
  try {
    execFileSync("openssl", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
  } catch (error) {
    const e = error as { stderr?: Buffer; code?: string };
    throw new Error(
      e.code === "ENOENT"
        ? "the transport tier needs the openssl command to make throwaway certificates; it is not on PATH"
        : `openssl ${args.join(" ")} failed: ${e.stderr?.toString() ?? error}`,
    );
  }
}

const EC = ["-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes"];

function makeCa(dir: string, name: string): void {
  openssl(
    [
      "req",
      "-x509",
      ...EC,
      "-keyout",
      `${name}.key`,
      "-out",
      `${name}.crt`,
      "-days",
      "2",
      "-subj",
      `/CN=Matters corpus ${name}`,
      "-addext",
      "basicConstraints=critical,CA:TRUE",
      "-addext",
      "keyUsage=critical,keyCertSign,cRLSign",
    ],
    dir,
  );
}

/** A leaf signed by a CA with `openssl ca`, which lets us choose the validity period. */
function makeLeaf(
  dir: string,
  name: string,
  ca: string,
  san: string,
  window?: [string, string],
): KeyPair {
  openssl(
    ["req", "-new", ...EC, "-keyout", `${name}.key`, "-out", `${name}.csr`, "-subj", `/CN=${name}`],
    dir,
  );
  writeFileSync(
    join(dir, `${name}.ext`),
    `subjectAltName=${san}\nbasicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\n`,
  );
  writeFileSync(
    join(dir, "ca.cnf"),
    "[ca]\ndefault_ca=d\n[d]\ndatabase=index.txt\nnew_certs_dir=out\nserial=serial\ndefault_md=sha256\npolicy=p\nunique_subject=no\n[p]\ncommonName=supplied\n",
  );
  const [start, end] = window ?? [];
  openssl(
    [
      "ca",
      "-config",
      "ca.cnf",
      "-batch",
      "-notext",
      "-cert",
      `${ca}.crt`,
      "-keyfile",
      `${ca}.key`,
      "-in",
      `${name}.csr`,
      "-out",
      `${name}.crt`,
      "-extfile",
      `${name}.ext`,
      ...(window ? ["-startdate", start as string, "-enddate", end as string] : ["-days", "2"]),
    ],
    dir,
  );
  return {
    key: readFileSync(join(dir, `${name}.key`), "utf8"),
    cert: readFileSync(join(dir, `${name}.crt`), "utf8"),
  };
}

export function makePki(): TestPki {
  const dir = mkdtempSync(join(tmpdir(), "matters-pki-"));
  mkdirSync(join(dir, "out"));
  writeFileSync(join(dir, "index.txt"), "");
  writeFileSync(join(dir, "serial"), "01\n");
  makeCa(dir, "ca");
  makeCa(dir, "other-ca");
  const local = "IP:127.0.0.1,DNS:localhost";
  const good = makeLeaf(dir, "good", "ca", local);
  const wrongHost = makeLeaf(dir, "wronghost", "ca", "DNS:other.example.test");
  const expired = makeLeaf(dir, "expired", "ca", local, ["20200101000000Z", "20200102000000Z"]);
  const unknownCa = makeLeaf(dir, "unknown", "other-ca", local);
  openssl(
    [
      "req",
      "-x509",
      ...EC,
      "-keyout",
      "self.key",
      "-out",
      "self.crt",
      "-days",
      "2",
      "-subj",
      "/CN=self",
      "-addext",
      `subjectAltName=${local}`,
    ],
    dir,
  );
  const selfSigned = {
    key: readFileSync(join(dir, "self.key"), "utf8"),
    cert: readFileSync(join(dir, "self.crt"), "utf8"),
  };
  const caPem = readFileSync(join(dir, "ca.crt"), "utf8");
  return {
    caPem,
    good,
    wrongHost,
    expired,
    selfSigned,
    unknownCa,
    dispose: () => rmSync(dir, { recursive: true, force: true }),
  };
}
