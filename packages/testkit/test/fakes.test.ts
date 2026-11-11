import {
  createInMemoryStorage,
  describeAccountStoreContract,
  describeAgentInsightStoreContract,
  describeAgentSettingsContract,
  describeAttachmentStoreContract,
  describeDraftStoreContract,
  describeFileSearchContract,
  describeFlagOutboxContract,
  describeImageRuleStoreContract,
  describeMessageBodyContract,
  describeMessageStoreContract,
  describeMoveContract,
  describeMoveOutboxContract,
  describeOutboxAttachmentsContract,
  describeOutboxContract,
  describePeopleContract,
  describeSavedViewStoreContract,
  describeSearchIndexContract,
  describeSeenContract,
  describeSyncBatchContract,
  describeUnitOfWorkContract,
  InMemoryAccountStore,
  InMemoryAgentInsightStore,
  InMemoryAgentSettings,
  InMemoryAttachmentStore,
  InMemoryBodyStore,
  InMemoryDraftStore,
  InMemoryFlagOutbox,
  InMemoryImageRuleStore,
  InMemoryMessageStore,
  InMemoryMoveOutbox,
  InMemoryOutbox,
  InMemorySavedViewStore,
  InMemorySearchIndex,
} from "../src/index.ts";

describeAttachmentStoreContract("in-memory", () => ({ instance: new InMemoryAttachmentStore() }));
describeOutboxAttachmentsContract("in-memory", () => {
  const attachments = new InMemoryAttachmentStore();
  return { instance: { outbox: new InMemoryOutbox(attachments), attachments } };
});
describeAgentInsightStoreContract("in-memory", () => ({
  instance: new InMemoryAgentInsightStore(),
}));
describeAgentSettingsContract("in-memory", () => ({ instance: new InMemoryAgentSettings() }));
describeAccountStoreContract("in-memory", () => ({ instance: new InMemoryAccountStore() }));
describeDraftStoreContract("in-memory", () => ({ instance: new InMemoryDraftStore() }));
describeSavedViewStoreContract("in-memory", () => ({ instance: new InMemorySavedViewStore() }));
describeImageRuleStoreContract("in-memory", () => ({ instance: new InMemoryImageRuleStore() }));
describeFlagOutboxContract("in-memory", () => ({ instance: new InMemoryFlagOutbox() }));
describeOutboxContract("in-memory", () => ({ instance: new InMemoryOutbox() }));
describeMessageStoreContract("in-memory", () => ({ instance: new InMemoryMessageStore() }));
describeSearchIndexContract("in-memory", () => ({ instance: new InMemorySearchIndex() }));
describeFileSearchContract("in-memory", () => {
  const store = new InMemoryMessageStore();
  return { instance: { store, files: new InMemorySearchIndex(store) } };
});
describePeopleContract("in-memory", () => ({ instance: new InMemorySearchIndex() }));
describeMessageBodyContract("in-memory", () => ({ instance: new InMemoryBodyStore() }));
describeUnitOfWorkContract("in-memory", () => {
  const storage = createInMemoryStorage();
  return { instance: { ...storage, read: storage } };
});
describeSyncBatchContract("in-memory", () => {
  const storage = createInMemoryStorage();
  return { instance: { ...storage, read: storage } };
});
describeSeenContract("in-memory", () => {
  const storage = createInMemoryStorage();
  return { instance: { ...storage, read: storage } };
});
describeMoveContract("in-memory", () => {
  const storage = createInMemoryStorage();
  return { instance: { ...storage, read: storage } };
});
describeMoveOutboxContract("in-memory", () => ({ instance: new InMemoryMoveOutbox() }));
