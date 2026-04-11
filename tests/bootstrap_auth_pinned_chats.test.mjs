import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const bootstrapAuth = require('../static/bootstrap_auth_helpers.js');

function buildHarness() {
  const chats = new Map([[5, { pending: false }]]);
  const histories = new Map();
  const pinnedSyncs = [];
  const renderPinnedChatsCalls = [];

  const controller = bootstrapAuth.createController({
    desktopTestingEnabled: false,
    devAuthSessionStorageKey: 'dev-auth',
    getIsAuthenticated: () => false,
    setIsAuthenticated: () => {},
    sessionStorageRef: { getItem: () => null, setItem: () => {} },
    authStatus: { textContent: '' },
    appendSystemMessage: () => {},
    fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }),
    initData: 'init',
    setOperatorDisplayName: () => {},
    operatorName: { textContent: '' },
    messagesEl: { querySelectorAll: () => [] },
    refreshOperatorRoleLabels: () => {},
    setSkin: () => {},
    syncChats: () => {},
    syncPinnedChats: (items) => pinnedSyncs.push(items),
    histories,
    setActiveChatMeta: () => {},
    renderPinnedChats: () => { renderPinnedChatsCalls.push(true); },
    renderMessages: () => {},
    warmChatHistoryCache: () => {},
    chats,
    pendingChats: new Set(),
    resumePendingChatStream: () => {},
    addLocalMessage: () => {},
    hasFreshPendingStreamSnapshot: () => false,
    restorePendingStreamSnapshot: () => false,
    operatorName: { textContent: '' },
    updateComposerState: () => {},
    isMobileQuoteMode: () => false,
    onBootstrapStage: () => {},
    windowObject: { setTimeout: (cb) => { cb(); return 1; } },
  });

  return { controller, pinnedSyncs, renderPinnedChatsCalls, histories };
}

test('applyAuthBootstrap hydrates pinned chats from pinned_chats payload even when active chat list is partial', async () => {
  const harness = buildHarness();

  harness.controller.applyAuthBootstrap({
    user: { username: 'desktop', display_name: 'Desktop Tester' },
    skin: 'terminal',
    active_chat_id: 5,
    chats: [{ id: 5, pending: false, title: 'Visible Chat' }],
    pinned_chats: [
      { id: 5, is_pinned: true, title: 'Visible Chat' },
      { id: 11, is_pinned: true, title: 'Pinned Only' },
      { id: 12, is_pinned: true, title: 'Also Pinned' },
    ],
    history: [],
  }, { preferredUsername: 'desktop' });

  assert.deepEqual(harness.pinnedSyncs, [[
    { id: 5, is_pinned: true, title: 'Visible Chat' },
    { id: 11, is_pinned: true, title: 'Pinned Only' },
    { id: 12, is_pinned: true, title: 'Also Pinned' },
  ]]);
  await Promise.resolve();
  assert.equal(harness.renderPinnedChatsCalls.length, 1);
});
