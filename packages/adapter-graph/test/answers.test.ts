// Answers of Graph that the stand-in never gives: a success that is not JSON, and a next link
// given twice (ADR 0136, rules 5 and 11). A small scripted server on the loopback address.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { PostalMimeParser } from "@matters/adapter-mime";
import type { FolderSyncContext, Label } from "@matters/core";
import { afterEach, describe, expect, it } from "vitest";
import { GraphClient, GraphFolders, GraphMailSync, RefusedTokens } from "../src/index.ts";
import { ACCOUNT, instantSchedule, TOKEN } from "./support.ts";

const stops: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) await stop();
});

/** A server whose answers `answer` writes; returns a client of it and the paths it was asked. */
async function scripted(answer: (path: string, base: string, response: ServerResponse) => void) {
  const asked: string[] = [];
  let base = "";
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "/").replace(/^\/v1\.0/, "");
    asked.push(path);
    answer(path, base, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1.0`;
  stops.push(
    () =>
      new Promise<void>((done) => {
        server.closeAllConnections();
        server.close(() => done());
      }),
  );
  const client = new GraphClient({
    base,
    token: TOKEN,
    refused: new RefusedTokens(),
    schedule: instantSchedule(),
    pageSize: 2,
  });
  return { client, asked };
}

const send = (response: ServerResponse, body: string) => {
  response.writeHead(200, { "content-type": "application/json" });
  response.end(body);
};

describe("answers the stand-in does not give", () => {
  it("fails a success whose body is not JSON, rather than read it as an empty folder list", async () => {
    const { client } = await scripted((path, _base, response) => {
      if (path.startsWith("/me/mailFolders?")) send(response, "<html>gateway</html>");
      else send(response, JSON.stringify({ id: "f" }));
    });
    const folders = new GraphFolders(client);
    await expect(folders.list(ACCOUNT)).rejects.toMatchObject({
      name: "GraphRequestError",
      status: 200,
    });
  });

  it("stops listing folders when a next link comes twice", async () => {
    const { client, asked } = await scripted((path, base, response) => {
      if (path.startsWith("/me/mailFolders?")) {
        send(
          response,
          JSON.stringify({ value: [], "@odata.nextLink": `${base}/me/mailFolders?page=2` }),
        );
      } else send(response, JSON.stringify({ id: "f" }));
    });
    await expect(new GraphFolders(client).list(ACCOUNT)).rejects.toThrow(/repeated a page link/);
    expect(asked.filter((p) => p.startsWith("/me/mailFolders?")).length).toBe(2);
  });

  it("stops a folder's delta round when a next link comes twice", async () => {
    const { client, asked } = await scripted((path, base, response) => {
      send(
        response,
        JSON.stringify({
          value: [],
          "@odata.nextLink": `${base}/me/mailFolders/f/messages/delta?$skiptoken=same`,
        }),
      );
      void path;
    });
    const sync = new GraphMailSync({
      client,
      folders: new GraphFolders(client),
      parser: new PostalMimeParser(),
    });
    const folder: Label = {
      id: "f",
      accountId: ACCOUNT.id,
      name: "Inbox",
      role: "inbox",
      exclusive: true,
    };
    const context = {} as FolderSyncContext;
    const run = async () => {
      for await (const _batch of sync.syncFolder(ACCOUNT, folder, null, context)) {
        // Each page is committed; the repeat is caught before it is asked again.
      }
    };
    await expect(run()).rejects.toThrow(/repeated a page link/);
    expect(asked.length).toBe(2);
  });
});
