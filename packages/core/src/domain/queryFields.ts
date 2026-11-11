/** ADR 0026. The fields of the query language, read by the parser and by suggestions. */
export type QueryFieldType =
  | "person"
  | "text"
  | "enum"
  | "label"
  | "account"
  | "date"
  | "prompt"
  | "limit";

export interface QueryFieldInfo {
  readonly type: QueryFieldType;
  readonly hint: string;
  /** Enum fields only: each value with its hint, in display order. */
  readonly values?: Readonly<Record<string, string>>;
}

export const QUERY_FIELDS = {
  from: { type: "person", hint: "Sender" },
  to: { type: "person", hint: "Recipient" },
  cc: { type: "person", hint: "Copied" },
  subject: { type: "text", hint: "Words in the subject" },
  is: {
    type: "enum",
    hint: "State of the message",
    values: {
      unread: "Not read yet",
      read: "Already read",
      starred: "Marked with a star",
      replied: "You answered it",
      draft: "Not sent yet",
    },
  },
  has: {
    type: "enum",
    hint: "What it carries",
    values: { attachment: "Has a file attached" },
  },
  in: {
    type: "enum",
    hint: "Where it is",
    values: {
      inbox: "In the inbox",
      archive: "Put away",
      sent: "Sent by you",
      drafts: "Drafts",
      trash: "Deleted",
      spam: "Marked as spam",
    },
  },
  label: { type: "label", hint: "Label or folder" },
  account: { type: "account", hint: "One of your accounts" },
  after: { type: "date", hint: "On or after a day" },
  before: { type: "date", hint: "Before a day" },
  /** ADR 0116: the person's own question, read by the agent; it has no values to suggest. */
  prompt: { type: "prompt", hint: "Your question, read by the assistant" },
  /** ADR 0116, rule 4a: the person's own cap; a number, so nothing to suggest. */
  limit: { type: "limit", hint: "At most this many results" },
  /** ADR 0116, rule 4b: the order of the results. `fit` only with a prompt. */
  sort: {
    type: "enum",
    hint: "Order of the results",
    values: {
      newest: "Newest first",
      oldest: "Oldest first",
      relevance: "Best match first, after ↵",
      fit: "Best fit to the prompt",
    },
  },
} as const satisfies Record<string, QueryFieldInfo>;

export type QueryFieldName = keyof typeof QUERY_FIELDS;

export function isQueryField(name: string): name is QueryFieldName {
  return Object.hasOwn(QUERY_FIELDS, name);
}

/** The values of an enum field. */
export function enumValues(field: "is" | "has" | "in" | "sort"): readonly string[] {
  return Object.keys(QUERY_FIELDS[field].values);
}
