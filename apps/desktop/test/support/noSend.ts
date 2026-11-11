import { registrableDomain } from "@matters/adapter-publicsuffix";
import type {
  AttachmentsApi,
  CountApi,
  ImagesApi,
  LimitsApi,
  MoveApi,
  SeenApi,
  SendApi,
  ViewsApi,
} from "../../src/backend/handler.ts";

/** For tests of the read paths: sending is not exercised there. */
export const noSend: SendApi = {
  saveDraft: async () => {
    throw new Error("not used");
  },
  deleteDraft: async () => false,
  requestSend: async () => {
    throw new Error("not used");
  },
  undoSend: async () => "notFound",
  sendAction: async () => false,
};

/** The same for saved views. */
export const noViewWrites: ViewsApi = {
  create: async () => {
    throw new Error("not used");
  },
  updateQuery: async () => {
    throw new Error("not used");
  },
  rename: async () => {
    throw new Error("not used");
  },
  remove: async () => false,
  move: async () => {},
  noteSearch: async () => {},
  forgetSearch: async () => {},
  clearSearches: async () => {},
};

export const noCounts: CountApi = {
  count: async () => ({ count: 0 }),
};

/** Image rule writes are not exercised where this is used. */
export const noImages: ImagesApi = {
  setRule: async () => {
    throw new Error("not used");
  },
  removeRule: async () => false,
  stop: async () => {},
  setGeneral: async () => {},
  importAddresses: async () => 0,
};

/** Marking read is not exercised where this is used. */
export const noSeen: SeenApi = {
  setSeen: async () => ({ changeSeq: 0, changedKeys: [] }),
};

/** Moving mail is not exercised where this is used. */
export const noMoves: MoveApi = {
  moveThread: async () => ({ operationId: null, keys: [], changeSeq: 0 }),
  undoMove: async () => ({ kind: "gone" }),
  deleteForever: async () => ({ queued: [], removed: [], refused: [] }),
};

/** Attaching files is not exercised where this is used. */
export const noAttachmentWrites: AttachmentsApi = {
  add: async () => {
    throw new Error("not used");
  },
  addForwarded: async () => {
    throw new Error("not used");
  },
  check: async () => [],
  recapture: async () => null,
};

/** No limit is asked for where this is used. */
export const noLimits: LimitsApi = { ensure: () => {} };

/**
 * What `BackendDeps` and the sync runtime need for image rules, where they are not the subject,
 * and the stub for marking read that goes with them.
 */
export const imageDeps = {
  images: noImages,
  registrableDomain,
  seen: noSeen,
  moves: noMoves,
  // The attachment parts of `BackendDeps`, likewise out of the way.
  attachmentWrites: noAttachmentWrites,
  attachmentRows: { forDraft: async () => [] },
  limits: noLimits,
};
export { registrableDomain };
