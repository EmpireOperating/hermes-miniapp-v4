from __future__ import annotations

import json
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def test_chat_tabs_restore_and_append_open_order_from_local_storage() -> None:
    node_script = r'''
const chatTabs = require('./static/chat_tabs_helpers.js');

const storageState = {
  hermes_chat_tab_order: JSON.stringify([2, 1]),
};
const localStorageRef = {
  getItem(key) {
    return Object.prototype.hasOwnProperty.call(storageState, key) ? storageState[key] : null;
  },
  setItem(key, value) {
    storageState[key] = String(value);
  },
  removeItem(key) {
    delete storageState[key];
  },
};

const controller = chatTabs.createChatStateController({
  chats: new Map(),
  pinnedChats: new Map(),
  histories: new Map(),
  pendingChats: new Set(),
  streamPhaseByChat: new Map(),
  unseenStreamChats: new Set(),
  prefetchingHistories: new Set(),
  chatScrollTop: new Map(),
  chatStickToBottom: new Map(),
  virtualizationRanges: new Map(),
  virtualMetrics: new Map(),
  renderedHistoryLength: new Map(),
  renderedHistoryVirtualized: new Map(),
  tabNodes: new Map(),
  clearChatStreamState: () => {},
  applyResumeCooldownPendingSuppression: () => {},
  reapplyResumeCooldownPendingSuppression: () => {},
  localStorageRef,
  orderedChatIdsStorageKey: 'hermes_chat_tab_order',
});

controller.syncChats([
  { id: 1, title: 'Main', unread_count: 0, pending: false, is_pinned: false },
  { id: 2, title: 'Pinned reopened earlier', unread_count: 0, pending: false, is_pinned: true },
]);
const restoredOrder = controller.getOrderedChatIds();

controller.syncChats([
  { id: 1, title: 'Main', unread_count: 0, pending: false, is_pinned: false },
  { id: 2, title: 'Pinned reopened earlier', unread_count: 0, pending: false, is_pinned: true },
  { id: 3, title: 'Just opened now', unread_count: 0, pending: false, is_pinned: true },
]);
const appendedOrder = controller.getOrderedChatIds();

process.stdout.write(JSON.stringify({
  restoredOrder,
  appendedOrder,
  persistedOrder: JSON.parse(storageState.hermes_chat_tab_order || '[]'),
}));
'''
    completed = subprocess.run(
        ["node", "-e", node_script],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    payload = json.loads(completed.stdout)

    assert payload["restoredOrder"] == [2, 1]
    assert payload["appendedOrder"] == [2, 1, 3]
    assert payload["persistedOrder"] == [2, 1, 3]
