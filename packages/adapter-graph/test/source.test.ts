// The source of a message over Microsoft Graph (ADR 0145, rule 2), against the stand-in service.
import { describeMessageSourceContract } from "@matters/testkit";
import { harness, target } from "./support.ts";

describeMessageSourceContract("Graph on the stand-in", async () => {
  const h = await harness();
  const connection = await h.connector.connect(target());
  return {
    async put(raw) {
      const id = h.server.addMessage("inbox", raw, { isRead: false });
      return { accountId: "a1", folderId: "inbox", uidValidity: "1", uid: 1, itemId: id };
    },
    port: async () => connection.attachments,
    seen: async (location) => h.server.messages.get(location.itemId ?? "")?.isRead ?? false,
    missing: (location) => ({ ...location, itemId: "AAMk-not-there" }),
    async close() {
      await connection.close();
    },
  };
});
