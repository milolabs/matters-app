import {
  createView,
  deleteView,
  InvalidViewError,
  MAX_VIEW_NAME,
  MAX_VIEW_QUERY,
  MAX_VIEWS,
  moveView,
  renameView,
  updateViewQuery,
  type ViewDeps,
  ViewNotFoundError,
} from "@matters/core";
import { describe, expect, it } from "vitest";
import { InMemorySavedViewStore } from "../src/index.ts";

function rig() {
  let n = 0;
  let t = 1000;
  const views = new InMemorySavedViewStore();
  const deps: ViewDeps = { views, newId: () => `v${++n}`, now: () => ++t };
  const names = async () => (await views.list()).map((v) => v.name);
  return { views, deps, names };
}

const refused = (p: Promise<unknown>) =>
  p.then(
    () => null,
    (e: unknown) => e,
  );

describe("createView", () => {
  it("trims the name, keeps the text as typed, appends at the end", async () => {
    const { deps, names } = rig();
    const a = await createView(deps, { name: "  Invoices ", query: " faktura  has:attachment " });
    const b = await createView(deps, { name: "Unread", query: "is:unread" });
    expect(a).toMatchObject({
      id: "v1",
      name: "Invoices",
      query: " faktura  has:attachment ",
      position: 0,
    });
    expect(b.position).toBe(1);
    expect(a.createdMs).toBe(a.updatedMs);
    expect(await names()).toEqual(["Invoices", "Unread"]);
  });

  it("refuses a blank, long or duplicate name, with a message to show", async () => {
    const { deps } = rig();
    await createView(deps, { name: "Invoices", query: "faktura" });
    const blank = await refused(createView(deps, { name: "   ", query: "x" }));
    expect(blank).toBeInstanceOf(InvalidViewError);
    expect((blank as Error).message).toBe("Give the view a name.");
    const long = await refused(
      createView(deps, { name: "x".repeat(MAX_VIEW_NAME + 1), query: "x" }),
    );
    expect((long as Error).message).toMatch(/at most 40/);
    await createView(deps, { name: "x".repeat(MAX_VIEW_NAME), query: "x" });
    const dup = await refused(createView(deps, { name: " INVOICES ", query: "x" }));
    expect(dup).toBeInstanceOf(InvalidViewError);
    expect((dup as Error).message).toBe('A view named "INVOICES" already exists.');
  });

  it("folds diacritics when comparing names", async () => {
    const { deps } = rig();
    await createView(deps, { name: "Łódź", query: "x" });
    expect(await refused(createView(deps, { name: "lodz", query: "x" }))).toBeInstanceOf(
      InvalidViewError,
    );
  });

  it("refuses a blank or oversized query", async () => {
    const { deps, views } = rig();
    expect(await refused(createView(deps, { name: "A", query: "  \n" }))).toBeInstanceOf(
      InvalidViewError,
    );
    const big = await refused(
      createView(deps, { name: "A", query: "a".repeat(MAX_VIEW_QUERY + 1) }),
    );
    expect((big as Error).message).toMatch(/at most 1024/);
    await createView(deps, { name: "A", query: "a".repeat(MAX_VIEW_QUERY) });
    expect(await views.list()).toHaveLength(1);
  });

  it("allows at most 50 views", async () => {
    const { deps, views } = rig();
    for (let i = 0; i < MAX_VIEWS; i++) await createView(deps, { name: `v${i}`, query: "x" });
    const e = await refused(createView(deps, { name: "one more", query: "x" }));
    expect((e as Error).message).toBe("You can have at most 50 views.");
    expect(await views.list()).toHaveLength(MAX_VIEWS);
  });
});

describe("updateViewQuery and renameView", () => {
  it("updates the query and the time, nothing else", async () => {
    const { deps, views } = rig();
    const a = await createView(deps, { name: "A", query: "x" });
    const next = await updateViewQuery(deps, a.id, "is:unread");
    expect(next).toMatchObject({
      name: "A",
      query: "is:unread",
      position: 0,
      createdMs: a.createdMs,
    });
    expect(next.updatedMs).toBeGreaterThan(a.updatedMs);
    expect(await views.get(a.id)).toEqual(next);
  });

  it("refuses a blank query and an unknown view", async () => {
    const { deps, views } = rig();
    const a = await createView(deps, { name: "A", query: "x" });
    expect(await refused(updateViewQuery(deps, a.id, " "))).toBeInstanceOf(InvalidViewError);
    expect((await views.get(a.id))?.query).toBe("x");
    expect(await refused(updateViewQuery(deps, "nope", "x"))).toBeInstanceOf(ViewNotFoundError);
    expect(await refused(renameView(deps, "nope", "x"))).toBeInstanceOf(ViewNotFoundError);
  });

  it("renames, may change only the case of its own name, refuses another view's name", async () => {
    const { deps, names } = rig();
    const a = await createView(deps, { name: "Invoices", query: "x" });
    await createView(deps, { name: "Unread", query: "y" });
    expect((await renameView(deps, a.id, " invoices ")).name).toBe("invoices");
    const e = await refused(renameView(deps, a.id, "UNREAD"));
    expect((e as Error).message).toBe('A view named "UNREAD" already exists.');
    expect(await names()).toEqual(["invoices", "Unread"]);
  });
});

describe("deleteView and moveView", () => {
  it("deletes and says whether the view existed", async () => {
    const { deps, names } = rig();
    const a = await createView(deps, { name: "A", query: "x" });
    expect(await deleteView(deps, a.id)).toBe(true);
    expect(await deleteView(deps, a.id)).toBe(false);
    expect(await names()).toEqual([]);
  });

  it("moves to an index, clamped, keeping the others in order", async () => {
    const { deps, names } = rig();
    const [a, b, c, d] = [
      await createView(deps, { name: "A", query: "x" }),
      await createView(deps, { name: "B", query: "x" }),
      await createView(deps, { name: "C", query: "x" }),
      await createView(deps, { name: "D", query: "x" }),
    ];
    await moveView(deps, d.id, 0);
    expect(await names()).toEqual(["D", "A", "B", "C"]);
    await moveView(deps, d.id, 2);
    expect(await names()).toEqual(["A", "B", "D", "C"]);
    await moveView(deps, a.id, 99);
    expect(await names()).toEqual(["B", "D", "C", "A"]);
    await moveView(deps, c.id, -5);
    expect(await names()).toEqual(["C", "B", "D", "A"]);
    expect(await refused(moveView(deps, "nope", 0))).toBeInstanceOf(ViewNotFoundError);
    // A view created after deleting one still goes last.
    await deleteView(deps, b.id);
    await createView(deps, { name: "E", query: "x" });
    expect(await names()).toEqual(["C", "D", "A", "E"]);
  });
});
