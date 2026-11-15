// The words of an account's removal (ADR 0138, rules 5 and 6): its size before, and what became of
// the freed pages after.
import type { RemovalCompaction, StorageReport } from "@matters/contracts";
import { storageSize } from "./storageView.ts";

/** An account's messages and its share of the mail's bytes in the last measurement. */
export function accountShare(
  report: StorageReport | null,
  id: string,
): { readonly messages: number; readonly bytes: number | null } | null {
  const row = report?.accounts.find((a) => a.accountId === id);
  if (!report || !row) return null;
  const sample = report.samples.at(-1);
  const mail = sample
    ? sample.htmlBytes + sample.textBytes + sample.mailBytes + sample.searchBytes
    : 0;
  const bytes = sample && report.messages > 0 ? (row.messages / report.messages) * mail : null;
  return { messages: row.messages, bytes };
}

/** What a removal says once it is done (ADR 0138, rule 6). */
export function removalNotice(address: string, compaction: RemovalCompaction | undefined): string {
  if (compaction === undefined) return `${address} is removed from this computer.`;
  if (compaction.kind === "compacted") {
    return `${address} is removed from this computer, and the database is compacted: ${storageSize(compaction.freedBytes)} given back.`;
  }
  if (compaction.kind === "lowDisk") {
    return `${address} is removed. The disk has too little free space to compact the database (it needs about ${storageSize(compaction.neededBytes)}, ${storageSize(compaction.freeBytes)} is free), so the space, and traces of the removed mail, stay in the file until it is compacted in Storage.`;
  }
  return `${address} is removed. Compacting the database did not work, so traces of the removed mail stay in the file until it is compacted in Storage.`;
}
