import type {
  DeleteForeverResult,
  MoveThreadInput,
  MoveThreadResult,
  UndoMoveResult,
} from "@matters/core";
import type { MoveApi } from "./handler.ts";
import type { SyncHost } from "./syncHost.ts";

/**
 * Moving mail as the router serves it: a command to the sync worker, which writes the labels and
 * the request for the server in one unit (ADR 0044). The router tells the windows through the
 * change log, like any other write.
 */
export class RemoteMoves implements MoveApi {
  private readonly host: SyncHost;

  constructor(host: SyncHost) {
    this.host = host;
  }

  moveThread(input: MoveThreadInput): Promise<MoveThreadResult> {
    return this.host.command({ name: "moveThread", ...input });
  }

  undoMove(operationId: string): Promise<UndoMoveResult> {
    return this.host.command({ name: "undoMove", operationId });
  }

  deleteForever(keys: readonly number[]): Promise<DeleteForeverResult> {
    return this.host.command({ name: "deleteForever", keys });
  }
}
