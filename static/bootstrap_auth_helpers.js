(function initHermesMiniappBootstrapAuth(globalScope) {
  function createController(deps) {
    const {
      desktopTestingEnabled,
      devAuthSessionStorageKey,
      devAuthControls,
      devModeBadge,
      devSignInButton,
      getIsAuthenticated,
      setIsAuthenticated,
      sessionStorageRef,
      devAuthModal,
      devAuthForm,
      devAuthSecretInput,
      devAuthUserIdInput,
      devAuthDisplayNameInput,
      devAuthUsernameInput,
      devAuthCancelButton,
      authStatus,
      appendSystemMessage,
      safeReadJson,
      fetchImpl,
      normalizeHandle,
      fallbackHandleFromDisplayName,
      setOperatorDisplayName,
      operatorName,
      refreshOperatorRoleLabels,
      setSkin,
      syncChats,
      syncPinnedChats,
      histories,
      setActiveChatMeta,
      renderPinnedChats,
      renderMessages,
      warmChatHistoryCache,
      chats,
      pendingChats,
      resumePendingChatStream,
      addLocalMessage,
    } = deps;

    function syncDevAuthUi() {
      if (devAuthControls) {
        devAuthControls.hidden = !desktopTestingEnabled;
      }
      if (devModeBadge) {
        devModeBadge.hidden = !desktopTestingEnabled;
      }
      if (devSignInButton) {
        devSignInButton.hidden = !desktopTestingEnabled || getIsAuthenticated();
        devSignInButton.disabled = !desktopTestingEnabled;
      }
    }

    function readDevAuthDefaults() {
      try {
        const raw = sessionStorageRef.getItem(devAuthSessionStorageKey);
        const parsed = raw ? JSON.parse(raw) : null;
        return {
          secret: String(parsed?.secret || ""),
          userId: String(parsed?.userId || "9001"),
          displayName: String(parsed?.displayName || "Desktop Tester"),
          username: String(parsed?.username || "desktop"),
        };
      } catch {
        return {
          secret: "",
          userId: "9001",
          displayName: "Desktop Tester",
          username: "desktop",
        };
      }
    }

    function writeDevAuthDefaults(value) {
      try {
        sessionStorageRef.setItem(devAuthSessionStorageKey, JSON.stringify(value));
      } catch {
        // best effort only
      }
    }

    function applyAuthBootstrap(data, { preferredUsername = "" } = {}) {
      setIsAuthenticated(true);
      const telegramUsername = normalizeHandle(preferredUsername);
      const apiUsername = normalizeHandle(data?.user?.username);
      const displayName = String(data?.user?.display_name || "").trim();
      const signedInName = telegramUsername || apiUsername || fallbackHandleFromDisplayName(displayName) || "Operator";
      setOperatorDisplayName(signedInName);
      operatorName.textContent = signedInName;
      authStatus.textContent = `Signed in as ${signedInName}`;
      refreshOperatorRoleLabels();
      setSkin(data.skin || "terminal");

      syncChats(data.chats || []);
      syncPinnedChats(data.pinned_chats || []);
      const activeId = Number(data.active_chat_id || 0);
      if (!activeId) {
        setActiveChatMeta(null);
        renderPinnedChats();
        syncDevAuthUi();
        return;
      }

      histories.set(activeId, data.history || []);
      setActiveChatMeta(activeId);
      renderPinnedChats();
      renderMessages(activeId);
      warmChatHistoryCache();
      if (Boolean(chats.get(activeId)?.pending) && !pendingChats.has(activeId)) {
        void resumePendingChatStream(activeId);
      }
      if (!(data.history || []).length) {
        addLocalMessage(activeId, {
          role: "system",
          body: "You're all set. This chat is empty.",
          created_at: new Date().toISOString(),
        });
        renderMessages(activeId);
      }
      syncDevAuthUi();
    }

    async function askForDevAuth(defaults) {
      if (devAuthModal && devAuthForm && devAuthSecretInput && devAuthUserIdInput && devAuthDisplayNameInput && devAuthUsernameInput && devAuthCancelButton && devAuthModal.showModal) {
        devAuthSecretInput.value = String(defaults.secret || "");
        devAuthUserIdInput.value = String(defaults.userId || "9001");
        devAuthDisplayNameInput.value = String(defaults.displayName || "Desktop Tester");
        devAuthUsernameInput.value = String(defaults.username || "desktop");

        return new Promise((resolve) => {
          let finished = false;
          const finish = (value) => {
            if (finished) return;
            finished = true;
            cleanup();
            resolve(value);
          };
          const cleanup = () => {
            devAuthForm.removeEventListener("submit", onSubmit);
            devAuthCancelButton.removeEventListener("click", onCancel);
            devAuthModal.removeEventListener("cancel", onCancel);
            devAuthModal.removeEventListener("close", onClose);
          };
          const onSubmit = (event) => {
            event.preventDefault();
            finish({
              secret: String(devAuthSecretInput.value || "").trim(),
              userId: String(devAuthUserIdInput.value || "").trim(),
              displayName: String(devAuthDisplayNameInput.value || "").trim(),
              username: String(devAuthUsernameInput.value || "").trim(),
            });
            devAuthModal.close();
          };
          const onCancel = (event) => {
            event?.preventDefault?.();
            finish(null);
            devAuthModal.close();
          };
          const onClose = () => finish(null);
          devAuthForm.addEventListener("submit", onSubmit);
          devAuthCancelButton.addEventListener("click", onCancel);
          devAuthModal.addEventListener("cancel", onCancel);
          devAuthModal.addEventListener("close", onClose);
          devAuthModal.showModal();
          devAuthSecretInput.focus();
          devAuthSecretInput.select?.();
        });
      }

      const secret = globalScope.window?.prompt ? window.prompt("Dev auth secret", defaults.secret || "") : null;
      if (secret === null) return null;
      const userId = window.prompt("Dev user id", defaults.userId || "9001");
      if (userId === null) return null;
      const displayName = window.prompt("Display name", defaults.displayName || "Desktop Tester");
      if (displayName === null) return null;
      const username = window.prompt("Username", defaults.username || "desktop");
      if (username === null) return null;
      return { secret, userId, displayName, username };
    }

    async function signInWithDevAuth({ interactive = true } = {}) {
      if (!desktopTestingEnabled) return false;
      const defaults = readDevAuthDefaults();
      let secret = defaults.secret || "";
      let userId = defaults.userId || "9001";
      let displayName = defaults.displayName || "Desktop Tester";
      let username = defaults.username || "desktop";

      if (interactive) {
        const provided = await askForDevAuth({ secret, userId, displayName, username });
        if (!provided) return false;
        secret = provided.secret;
        userId = provided.userId;
        displayName = provided.displayName;
        username = provided.username;
      } else if (!secret) {
        return false;
      }

      writeDevAuthDefaults({ secret, userId, displayName, username });
      authStatus.textContent = "Signing in (dev)…";

      const response = await fetchImpl("/api/dev/auth", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Dev-Auth": String(secret || "").trim(),
        },
        body: JSON.stringify({
          user_id: Number(userId),
          display_name: String(displayName || "").trim(),
          username: String(username || "").trim(),
          allow_empty: true,
        }),
      });
      const data = await safeReadJson(response);
      if (!response.ok || !data?.ok) {
        authStatus.textContent = "Dev sign-in failed";
        appendSystemMessage(data?.error || `Dev sign-in failed (${response.status}).`);
        syncDevAuthUi();
        return false;
      }

      applyAuthBootstrap(data, { preferredUsername: data?.user?.username || "" });
      return true;
    }

    return {
      syncDevAuthUi,
      readDevAuthDefaults,
      writeDevAuthDefaults,
      applyAuthBootstrap,
      askForDevAuth,
      signInWithDevAuth,
    };
  }

  const api = { createController };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappBootstrapAuth = api;
})(typeof window !== "undefined" ? window : globalThis);
