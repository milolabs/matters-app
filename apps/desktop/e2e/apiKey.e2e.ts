// ADR 0141: the agent on the person's own API key, in the window. The demo mailbox, and a stand-in
// for the Anthropic API on 127.0.0.1 that the dev build is pointed at (`MATTERS_TEST_ANTHROPIC_BASE`,
// loopback only, never read by a packaged app). The key is made up; no real key and no real
// provider are ever used.
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "./fixtures.ts";

const KEY = "sk-ant-e2e-3333333333333333333333333333-made-up";
const OTHER = "sk-ant-e2e-4444444444444444444444444444-made-up";
/** The quote of the made-up message the runtime test sends (agentService.ts, TEST_PROMPT_QUOTE). */
const TEST_QUOTE = "I will send you the signed contract by Friday";

interface Seen {
  readonly method: string;
  readonly path: string;
  readonly key: string | undefined;
}

const yes = { supported: true };
const model = (id: string, line: string) => ({
  type: "model",
  id,
  display_name: id,
  created_at: "2026-09-21T00:00:00Z",
  lifecycle: "active",
  line,
  max_input_tokens: 1_000_000,
  max_tokens: 128_000,
  capabilities: {
    structured_outputs: yes,
    image_input: yes,
    pdf_input: yes,
    effort: { supported: true, low: yes, medium: yes, high: yes, xhigh: yes, max: yes },
  },
});

/** The stand-in: lists two models, answers the test, and refuses a key it is told to. */
async function standIn() {
  const seen: Seen[] = [];
  const refused = new Set<string>();
  const server: Server = createServer((req: IncomingMessage, res) => {
    req.resume();
    req.on("end", () => {
      const key = req.headers["x-api-key"];
      const path = (req.url ?? "").split("?")[0] ?? "";
      seen.push({ method: req.method ?? "", path, key: typeof key === "string" ? key : undefined });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(value));
      };
      if (typeof key === "string" && refused.has(key)) {
        return send(401, { type: "error", error: { type: "authentication_error", message: "no" } });
      }
      if (req.method === "GET" && path === "/v1/models") {
        return send(200, {
          data: [model("claude-opus-5-5", "opus"), model("claude-haiku-5-5", "haiku")],
          has_more: false,
          first_id: null,
          last_id: null,
        });
      }
      if (req.method === "POST" && path === "/v1/messages") {
        const verdicts = [
          { thread: 1, fit: 3, why: "It promises it.", message: 1, quote: TEST_QUOTE },
        ];
        return send(200, {
          id: "msg_1",
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: JSON.stringify({ verdicts }) }],
          stop_reason: "end_turn",
          usage: { input_tokens: 100, output_tokens: 20 },
        });
      }
      send(404, { type: "error", error: { type: "not_found_error" } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
    refused,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

test("a key is pasted, checked, refused, replaced and removed, and the window never holds it", async ({
  start,
}, testInfo) => {
  const api = await standIn();
  try {
    const { app, window } = await start({
      env: { MATTERS_SEED: "1", MATTERS_TEST_ANTHROPIC_BASE: api.base },
    });
    await expect(window.getByRole("listbox", { name: "Messages" })).toBeVisible();
    const [settings] = await Promise.all([
      app.waitForEvent("window"),
      window.getByRole("button", { name: "Settings" }).click(),
    ]);
    await settings.getByRole("button", { name: "Agents" }).click();
    const card = settings.locator('[data-runtime-option="anthropic-api"]');
    const status = card.locator("[data-runtime-status]");

    // No key: it says what to do and who bills each turn; nothing has gone to the provider.
    await expect(status).toHaveText(/No API key yet/);
    await expect(card.locator("[data-billed-line]")).toHaveText(
      "Every turn is billed by Anthropic to your API key.",
    );
    await expect(card.getByText(/Paste an API key/)).toBeVisible();
    expect(api.seen).toEqual([]);

    // The key goes into a password field, and the provider is asked only for its list.
    const input = card.locator("[data-key-input]");
    await expect(input).toHaveAttribute("type", "password");
    await input.fill(KEY);
    await card.locator("[data-key-save]").click();
    await expect(status).toHaveText(/Key saved · not checked yet/);
    expect(api.seen.every((s) => s.method === "GET" && s.key === KEY)).toBe(true);
    await expect(card.locator("[data-key-replace]")).toBeVisible();
    await expect(card.locator("[data-key-input]")).toHaveCount(0);

    // Ready only after the same test as every runtime: one made-up message.
    await card.locator('[data-runtime-check="anthropic-api"]').click();
    await expect(status).toHaveText(/Ready · key saved/);
    expect(api.seen.filter((s) => s.path === "/v1/messages")).toHaveLength(1);
    // Kept, it may read in the background only once the person says so; off to start with.
    const background = settings.locator('[data-key-reading="anthropic-api"] input');
    await expect(background).not.toBeChecked();
    await settings.screenshot({ path: testInfo.outputPath("ready.png") });

    // The key is nowhere in what the window holds.
    expect(await settings.content()).not.toContain(KEY);
    expect(await settings.evaluate(() => JSON.stringify(localStorage))).not.toContain(KEY);

    // A key the provider refuses says so, in our words, with the field open again.
    api.refused.add(OTHER);
    await card.locator("[data-key-replace]").click();
    await card.locator("[data-key-input]").fill(OTHER);
    await card.locator("[data-key-save]").click();
    await expect(status).toHaveText(/The key was refused/);
    await expect(
      card.getByText("Anthropic refused the key. Paste the key again, or another one."),
    ).toBeVisible();
    await expect(card.locator("[data-key-input]")).toBeVisible();

    // Removed, it is as before any key.
    await card.locator("[data-key-remove]").click();
    await expect(status).toHaveText(/No API key yet/);
    expect(await settings.content()).not.toContain(OTHER);
  } finally {
    await api.close();
  }
});
