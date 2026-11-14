import type { Account, Label, LabelRole } from "@matters/core";
import type { GraphClient } from "./client.ts";

/** Microsoft's well-known folder names and the roles they give (ADR 0136, rule 5). */
export const WELL_KNOWN: Readonly<Record<string, Exclude<LabelRole, "other">>> = {
  inbox: "inbox",
  sentitems: "sent",
  drafts: "drafts",
  deleteditems: "trash",
  junkemail: "spam",
  archive: "archive",
};

interface GraphFolder {
  readonly id: string;
  readonly displayName: string;
  readonly childFolderCount: number;
}

function foldersOf(body: unknown): GraphFolder[] {
  const value = (body as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) return [];
  const out: GraphFolder[] = [];
  for (const raw of value) {
    const f = raw as Record<string, unknown>;
    if (typeof f.id !== "string" || f.id === "") continue;
    out.push({
      id: f.id,
      displayName: typeof f.displayName === "string" ? f.displayName : f.id,
      childFolderCount: typeof f.childFolderCount === "number" ? f.childFolderCount : 0,
    });
  }
  return out;
}

const nextLinkOf = (body: unknown): string | undefined => {
  const link = (body as Record<string, unknown> | null)?.["@odata.nextLink"];
  return typeof link === "string" && link !== "" ? link : undefined;
};

const SELECT = "$select=id,displayName,childFolderCount";

/**
 * The folders of one connection: listed once, and the ids of the well-known ones kept for the
 * moves and the Sent folder that come after.
 */
export class GraphFolders {
  private readonly client: GraphClient;
  private readonly wellKnownIds = new Map<string, string | null>();

  constructor(client: GraphClient) {
    this.client = client;
  }

  /** The id behind a well-known name; null when the mailbox has no such folder. */
  async wellKnownId(name: string): Promise<string | null> {
    const kept = this.wellKnownIds.get(name);
    if (kept !== undefined) return kept;
    const answer = await this.client.json(`/me/mailFolders/${name}?$select=id`, { allow404: true });
    const id = (answer.body as { id?: unknown } | null)?.id;
    const found = answer.status === 404 || typeof id !== "string" ? null : id;
    this.wellKnownIds.set(name, found);
    return found;
  }

  /** Every folder with its children, a child named under its parent (`Parent/Child`). */
  async list(account: Account): Promise<readonly Label[]> {
    const roles = new Map<string, LabelRole>();
    for (const [name, role] of Object.entries(WELL_KNOWN)) {
      const id = await this.wellKnownId(name);
      if (id !== null && !roles.has(id)) roles.set(id, role);
    }
    const out: Label[] = [];
    const walk = async (path: string, prefix: string, depth: number): Promise<void> => {
      for (let link: string | undefined = `${path}?${SELECT}`; link !== undefined; ) {
        const answer = await this.client.json(link);
        for (const folder of foldersOf(answer.body)) {
          const name = prefix === "" ? folder.displayName : `${prefix}/${folder.displayName}`;
          out.push({
            id: folder.id,
            accountId: account.id,
            name,
            role: roles.get(folder.id) ?? "other",
            exclusive: true,
          });
          // Deep trees are cut where no person files mail; a loop in the answer cannot run on.
          if (folder.childFolderCount > 0 && depth < 16) {
            await walk(
              `/me/mailFolders/${encodeURIComponent(folder.id)}/childFolders`,
              name,
              depth + 1,
            );
          }
        }
        link = nextLinkOf(answer.body);
      }
    };
    await walk("/me/mailFolders", "", 0);
    return out;
  }
}

export { nextLinkOf };
