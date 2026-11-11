/**
 * The agent's queries tolerate inflection (ADR 0081): each plain word of a parsed query becomes
 * the stem of the word, which the search takes as a prefix. A quoted phrase stays exact, and so
 * do the words of `from:`, `to:` and `cc:` (names and addresses). The person's own search does
 * not come through here. Pure.
 */
import { stemWord } from "../domain/stem.ts";
import type { ParsedQuery, QueryNode } from "./parseQuery.ts";

function stemNode(node: QueryNode): QueryNode {
  switch (node.kind) {
    case "and":
    case "or":
      return { kind: node.kind, children: node.children.map(stemNode) };
    case "not":
      return { kind: "not", child: stemNode(node.child) };
    case "text": {
      if (node.match !== "prefix" || (node.field !== "any" && node.field !== "subject")) {
        return node;
      }
      return { ...node, value: node.value.split(" ").map(stemWord).join(" ") };
    }
    default:
      return node;
  }
}

/** The same query with the plain words stemmed. */
export function stemQuery(query: ParsedQuery): ParsedQuery {
  return query.root === null ? query : { ...query, root: stemNode(query.root) };
}
