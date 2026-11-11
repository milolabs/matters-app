// The reads that walk a lot of mail to answer (ADR 0070, rule 2). They run on the read thread so that
// no list or thread waits behind them; if that thread is gone the router runs the same code itself.
import type { SqliteStorageUsage, StorageOverview, StorageSample } from "@matters/adapter-sqlite";
import type { ThreadAgentView } from "@matters/core";
import type { ReadEstimate } from "./agentApi.ts";
import { type AgentReadDeps, listThings, readEstimate, readThreadAgent } from "./agentReads.ts";

export type HeavyRead =
  | { readonly name: "things"; readonly limit?: number }
  | { readonly name: "threadAgent"; readonly threadId: string }
  | {
      readonly name: "readEstimate";
      readonly input: { readonly accountIds: readonly string[]; readonly windowDays: number };
    }
  /** Settings › Storage (ADR 0089): the cheap numbers with the kept measurements. */
  | { readonly name: "storageOverview" }
  /** The breakdown by table: reads the whole database once. */
  | { readonly name: "storageMeasure" };

/** What the heavy reads need: the agent's reads and the database's own numbers. */
export type HeavyReadDeps = AgentReadDeps & {
  /** Absent where nothing asks for storage (agent tests). */
  readonly storage?: Pick<SqliteStorageUsage, "overview" | "measure" | "samples">;
};

export interface StorageOverviewAnswer {
  readonly overview: StorageOverview;
  readonly samples: readonly StorageSample[];
}

/** What each read answers. */
export type HeavyAnswer<R extends HeavyRead> = R extends { name: "things" }
  ? Awaited<ReturnType<typeof listThings>>
  : R extends { name: "threadAgent" }
    ? ThreadAgentView
    : R extends { name: "storageOverview" }
      ? StorageOverviewAnswer
      : R extends { name: "storageMeasure" }
        ? StorageSample
        : ReadEstimate;

export function serveHeavyRead(
  deps: HeavyReadDeps,
  read: HeavyRead,
  nowMs: number,
): Promise<unknown> {
  switch (read.name) {
    case "things":
      return listThings(deps, nowMs, read.limit);
    case "threadAgent":
      return readThreadAgent(deps, read.threadId, nowMs);
    case "readEstimate":
      return readEstimate(deps, nowMs, read.input);
    case "storageOverview": {
      const storage = needStorage(deps);
      return Promise.resolve({ overview: storage.overview(), samples: storage.samples() });
    }
    case "storageMeasure":
      return Promise.resolve(needStorage(deps).measure(nowMs));
  }
}

function needStorage(deps: HeavyReadDeps): NonNullable<HeavyReadDeps["storage"]> {
  if (!deps.storage) throw new Error("storage is not readable here");
  return deps.storage;
}

/** The same reads with no thread: what a test or a single-threaded caller asks. */
export function readsHere(deps: HeavyReadDeps, now: () => number = Date.now) {
  return {
    ask<R extends HeavyRead>(read: R): Promise<HeavyAnswer<R>> {
      return serveHeavyRead(deps, read, now()) as Promise<HeavyAnswer<R>>;
    },
  };
}
