import type { FileHit } from "../domain/fileHit.ts";
import type { FilesPort } from "../ports/index.ts";

export const DEFAULT_FILE_HITS = 5;
export const MAX_FILE_HITS = 50;
/** More than this is more than a person types into a search box. */
export const MAX_FILE_QUERY = 200;

export interface SearchFilesInput {
  readonly text: string;
  /** Default 5, at most 50. */
  readonly limit?: number;
  readonly accountId?: string;
}

/**
 * Files whose name contains what is typed (ADR 0074). Blank input gives nothing; the port is
 * not asked.
 */
export async function searchFiles(
  deps: { readonly files: FilesPort },
  input: SearchFilesInput,
): Promise<readonly FileHit[]> {
  const text = input.text.trim().slice(0, MAX_FILE_QUERY).trim();
  const asked = input.limit === undefined ? DEFAULT_FILE_HITS : Math.trunc(input.limit);
  const limit = Math.min(Math.max(Number.isFinite(asked) ? asked : 0, 0), MAX_FILE_HITS);
  if (text === "" || limit === 0) return [];
  return deps.files.searchFiles(text, limit, input.accountId);
}
