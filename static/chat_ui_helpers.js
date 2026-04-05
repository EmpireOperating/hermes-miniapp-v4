(function initHermesMiniappChatUI(globalScope) {
  function toPositiveInt(value) {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
  }

  function getOrCreateTabNode({ tabNodes, tabTemplate, chatId }) {
    const key = toPositiveInt(chatId);
    if (!key) return null;
    if (tabNodes.has(key)) {
      return tabNodes.get(key);
    }
    const node = tabTemplate.content.firstElementChild.cloneNode(true);
    node.dataset.chatId = String(key);
    node.setAttribute("role", "tab");
    node.setAttribute("aria-controls", "messages");
    tabNodes.set(key, node);
    return node;
  }

  function getTabBadgeState({ chat, pendingChats, unseenStreamChats }) {
    const chatKey = toPositiveInt(chat?.id);
    if (!chatKey) {
      return { text: "", classes: [], ariaLabel: "" };
    }

    const pending = pendingChats.has(chatKey) || Boolean(chat.pending);
    const unread = Math.max(0, Number(chat.unread_count || 0));
    const hasUnseenInViewport = unseenStreamChats.has(chatKey);

    if (pending) {
      return {
        text: "…",
        classes: ["is-visible", "is-pending"],
        ariaLabel: "Pending response",
      };
    }

    if (unread > 0 || hasUnseenInViewport) {
      return {
        text: "•",
        classes: ["is-visible", "is-unread-dot"],
        ariaLabel:
          unread > 0
            ? `${unread} unread ${unread === 1 ? "message" : "messages"}`
            : "New messages below current scroll position",
      };
    }

    return {
      text: "",
      classes: [],
      ariaLabel: "",
    };
  }

  function applyTabBadgeState({ badge, badgeState }) {
    if (!badge) return;
    const state = badgeState || { text: "", classes: [], ariaLabel: "" };
    badge.classList.remove("is-visible", "is-pending", "is-unread-dot");
    badge.removeAttribute("aria-label");
    badge.textContent = state.text || "";
    if (Array.isArray(state.classes) && state.classes.length) {
      badge.classList.add(...state.classes);
    }
    if (state.ariaLabel) {
      badge.setAttribute("aria-label", state.ariaLabel);
    }
  }

  function applyTabNodeState({ node, chat, activeChatId, pendingChats, unseenStreamChats, getTabBadgeState: customBadgeState, applyTabBadgeState: customApplyBadgeState }) {
    if (!node || !chat) return;
    const chatId = toPositiveInt(chat.id);
    const isActive = chatId === Number(activeChatId);
    const isPending = Boolean(chatId && (pendingChats.has(chatId) || chat.pending));
    node.classList.toggle("is-active", isActive);
    node.classList.toggle("is-pinned", Boolean(chat.is_pinned));
    node.setAttribute("aria-selected", isActive ? "true" : "false");

    const pinEl = node.querySelector(".chat-tab__pin");
    if (pinEl) {
      pinEl.textContent = chat.is_pinned ? "📌" : "";
    }

    const titleEl = node.querySelector(".chat-tab__title");
    if (titleEl) {
      titleEl.textContent = chat.title || "Chat";
    }

    const badgeEl = node.querySelector(".chat-tab__badge");
    if (badgeEl) {
      const badgeResolver = typeof customBadgeState === "function" ? customBadgeState : (value) => getTabBadgeState({ chat: value, pendingChats, unseenStreamChats });
      const badgeApplier = typeof customApplyBadgeState === "function" ? customApplyBadgeState : (badge, badgeState) => applyTabBadgeState({ badge, badgeState });
      badgeApplier(badgeEl, badgeResolver(chat));
    }

    const overflowTrigger = node.querySelector("[data-chat-tab-menu-trigger]");
    if (overflowTrigger) {
      overflowTrigger.hidden = !isActive || isPending;
    }
  }

  function removeMissingTabNodes({ tabNodes, nextIds }) {
    [...tabNodes.entries()].forEach(([chatId, node]) => {
      if (!nextIds.has(chatId)) {
        node.remove();
        tabNodes.delete(chatId);
      }
    });
  }

  function renderTabs({ chats, tabNodes, tabTemplate, tabsEl, applyTabNodeState: customApplyTabNodeState }) {
    const ordered = [...chats.values()].sort((a, b) => a.id - b.id);
    const nextIds = new Set(ordered.map((chat) => Number(chat.id)));
    removeMissingTabNodes({ tabNodes, nextIds });
    ordered.forEach((chat) => {
      const node = getOrCreateTabNode({ tabNodes, tabTemplate, chatId: chat.id });
      if (!node) return;
      if (typeof customApplyTabNodeState === "function") {
        customApplyTabNodeState(node, chat);
      } else {
        applyTabNodeState({ node, chat });
      }
      if (node.parentElement !== tabsEl) {
        tabsEl.appendChild(node);
      }
    });
  }

  function createPinnedChatItem(doc, chat) {
    const button = doc.createElement("button");
    button.type = "button";
    button.className = "pinned-chat-item";
    button.dataset.chatId = String(Number(chat.id));
    button.setAttribute("role", "listitem");
    button.title = chat.title || "Chat";

    const pin = doc.createElement("span");
    pin.className = "pinned-chat-item__pin";
    pin.setAttribute("aria-hidden", "true");
    pin.textContent = "📌";

    const title = doc.createElement("span");
    title.className = "pinned-chat-item__title";
    title.textContent = chat.title || "Chat";

    button.append(pin, title);
    return button;
  }

  function renderPinnedChats({ pinnedChatsWrap, pinnedChatsEl, pinnedChats, doc = globalScope.document }) {
    if (!pinnedChatsWrap || !pinnedChatsEl) return;
    const ordered = [...pinnedChats.values()];
    pinnedChatsWrap.hidden = ordered.length === 0;
    pinnedChatsEl.replaceChildren();
    ordered.forEach((chat) => {
      pinnedChatsEl.appendChild(createPinnedChatItem(doc, chat));
    });
  }

  function refreshTabNode({ chatId, tabNodes, chats, applyTabNodeState: customApplyTabNodeState }) {
    const key = toPositiveInt(chatId);
    if (!key) return;
    const node = tabNodes.get(key);
    const chat = chats.get(key);
    if (!node || !chat) return;
    if (typeof customApplyTabNodeState === "function") {
      customApplyTabNodeState(node, chat);
      return;
    }
    applyTabNodeState({ node, chat });
  }

  function syncActiveTabSelection({ previousChatId, nextChatId, tabNodes, renderTabs, refreshTabNode }) {
    const prevKey = Number(previousChatId);
    const nextKey = Number(nextChatId);
    const hasPrevNode = !prevKey || tabNodes.has(prevKey);
    const hasNextNode = !!nextKey && tabNodes.has(nextKey);

    if (!hasPrevNode || !hasNextNode) {
      renderTabs();
      return;
    }

    refreshTabNode(prevKey);
    refreshTabNode(nextKey);
  }

  const api = {
    getOrCreateTabNode,
    getTabBadgeState,
    applyTabBadgeState,
    applyTabNodeState,
    removeMissingTabNodes,
    renderTabs,
    renderPinnedChats,
    refreshTabNode,
    syncActiveTabSelection,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappChatUI = api;
})(typeof window !== "undefined" ? window : globalThis);
