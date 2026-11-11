// `tls.setDefaultCACertificates` is newer than the Node typings in this repo.
import * as tls from "node:tls";

interface TlsWithTrust {
  getCACertificates(type: "default"): string[];
  setDefaultCACertificates(certs: string[]): void;
}
export const tlsApi = tls as unknown as TlsWithTrust;
export { tlsApi as tls };
