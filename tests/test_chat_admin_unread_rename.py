from __future__ import annotations

import json
import subprocess
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parent.parent


def test_renaming_chat_preserves_existing_unread_dot() -> None:
    node_script = r'''
(async () => {
  const chatAdmin = require('./static/chat_admin_helpers.js');

  const chats = new Map([[7, { id: 7, title: 'Original', unread_count: 3, pending: false, is_pinned: false }]]);
  const pinnedChats = new Map();
  const upserted = [];

  const controller = chatAdmin.createController({
    windowObject: {
      prompt: (() => {
        const responses = ['Renamed', 'none'];
        return () => responses.shift() ?? null;
      })(),
    },
    apiPost: async (path, payload) => {
      if (path !== '/api/chats/rename') {
        throw new Error(`unexpected path: ${path}`);
      }
      return {
        chat: {
          id: Number(payload.chat_id),
          title: String(payload.title),
          unread_count: 0,
          pending: false,
          is_pinned: false,
        },
      };
    },
    chats,
    pinnedChats,
    histories: new Map(),
    pendingChats: new Set(),
    latencyByChat: new Map(),
    streamPhaseByChat: new Map(),
    unseenStreamChats: new Set(),
    clearChatStreamState: () => {},
    upsertChat: (chat) => {
      upserted.push(chat);
      chats.set(Number(chat.id), chat);
    },
    syncChats: () => {},
    syncPinnedChats: () => {},
    setActiveChatMeta: () => {},
    setNoActiveChatMeta: () => {},
    renderMessages: () => {},
    renderTabs: () => {},
    renderPinnedChats: () => {},
    syncPinChatButton: () => {},
    moveChatToEnd: () => {},
    chatLabel: (chatId) => chats.get(Number(chatId))?.title || 'Chat',
    getActiveChatId: () => 99,
    openChat: () => {},
    onLatencyByChatMutated: () => {},
    chatTabContextMenu: null,
    pinnedChatContextMenu: null,
    pinnedChatContextRemove: null,
    focusComposerForNewChat: () => {},
  });

  await controller.renameChatById(7);
  process.stdout.write(JSON.stringify(upserted[0] || null));
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
'''
    completed = subprocess.run(
        ["node", "-e", node_script],
        cwd=REPO_ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    renamed_chat = json.loads(completed.stdout)

    assert renamed_chat["title"] == "Renamed"
    assert renamed_chat["unread_count"] == 3
