(function initHermesMiniappBootstrapAuth(globalScope) {
  function createController(deps) {
    const {
      desktopTestingEnabled,
      devAuthSessionStorageKey,
      devAuthControls = null,
      devModeBadge = null,
      devSignInButton = null,
      devAuthHashSecret = "",
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
      safeReadJson: safeReadJsonOverride,
      fetchImpl,
      normalizeHandle,
      initData = "",
      parseSseEvent = null,
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
      onBootstrapStage = null,
    } = deps;

    async function safeReadJson(response) {
      try {
        if (typeof safeReadJsonOverride === "function") {
          return await safeReadJsonOverride(response);
        }
        return await response.json();
      } catch {
        return null;
      }
    }

    function authPayload(extra = {}) {
      return { init_data: initData, ...extra };
    }

    function summarizeUiFailure(rawBody, { status = 0, fallback = "Request failed." } = {}) {
      const raw = String(rawBody || "");
      const trimmed = raw.trim();
      const normalizedStatus = Number(status) || 0;
      const looksLikeHtml = /<!doctype html|<html\b|<head\b|<body\b|<style\b|<script\b/i.test(trimmed);
      const looksLikeCss = !looksLikeHtml && /(^|\n)\s*[.#@a-zA-Z0-9_-]+\s*\{|--[a-z0-9_-]+\s*:/m.test(trimmed);
      const tooLong = trimmed.length > 500;
      if (normalizedStatus === 502 || normalizedStatus === 503 || normalizedStatus === 504) {
        return "Mini app backend temporarily unavailable. Please wait a moment and reopen if needed.";
      }
      if (looksLikeHtml || looksLikeCss || tooLong) {
        return fallback;
      }
      return trimmed || fallback;
    }

    function parseStreamErrorPayload(rawBody) {
      if (typeof parseSseEvent !== "function") {
        return { eventName: "", error: "", chatId: 0 };
      }
      const parsed = parseSseEvent(String(rawBody || ""));
      const payload = parsed?.payload && typeof parsed.payload === "object" ? parsed.payload : null;
      const error = String(payload?.error || "").trim();
      const chatId = Number(payload?.chat_id || 0);
      return {
        eventName: parsed?.eventName || "",
        error,
        chatId: Number.isFinite(chatId) && chatId > 0 ? chatId : 0,
      };
    }

    function syncDevAuthUi() {
      const revealed = Boolean(desktopTestingEnabled);
      const authenticated = Boolean(getIsAuthenticated?.());
      if (devAuthControls) {
        devAuthControls.hidden = !revealed;
      }
      if (devModeBadge) {
        devModeBadge.hidden = !revealed;
      }
      if (devSignInButton) {
        devSignInButton.hidden = !revealed || authenticated;
        devSignInButton.disabled = !revealed || authenticated;
      }
      return revealed;
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
      onBootstrapStage?.("auth-bootstrap-applied-start", {
        activeChatId: Number(data?.active_chat_id || 0),
        chatCount: Array.isArray(data?.chats) ? data.chats.length : 0,
      });
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

      onBootstrapStage?.("auth-bootstrap-sync-chats-start", {
        chatCount: Array.isArray(data?.chats) ? data.chats.length : 0,
      });
      syncChats(data.chats || []);
      syncPinnedChats(data.pinned_chats || []);
      onBootstrapStage?.("auth-bootstrap-sync-chats-finished", {
        chatCount: Array.isArray(data?.chats) ? data.chats.length : 0,
      });
      const activeId = Number(data.active_chat_id || 0);
      if (!activeId) {
        setActiveChatMeta(null);
        renderPinnedChats();
        syncDevAuthUi();
        onBootstrapStage?.("auth-bootstrap-applied-finished", {
          activeChatId: 0,
          chatCount: Array.isArray(data?.chats) ? data.chats.length : 0,
          pendingResumeTriggered: false,
        });
        return;
      }

      histories.set(activeId, data.history || []);
      setActiveChatMeta(activeId);
      renderPinnedChats();
      onBootstrapStage?.("initial-render-start", {
        activeChatId: activeId,
        historyCount: Array.isArray(data?.history) ? data.history.length : 0,
      });
      renderMessages(activeId);
      onBootstrapStage?.("initial-render-finished", {
        activeChatId: activeId,
        historyCount: Array.isArray(data?.history) ? data.history.length : 0,
      });
      onBootstrapStage?.("warm-history-cache-triggered", {
        activeChatId: activeId,
      });
      warmChatHistoryCache();
      const shouldResumePending = Boolean(chats.get(activeId)?.pending) && !pendingChats.has(activeId);
      if (shouldResumePending) {
        onBootstrapStage?.("pending-stream-resume-triggered", {
          activeChatId: activeId,
        });
        void resumePendingChatStream(activeId);
      }
      if (!(data.history || []).length) {
        addLocalMessage(activeId, {
          role: "system",
          body: "You're all set. This chat is empty.",
          created_at: new Date().toISOString(),
        });
        onBootstrapStage?.("initial-empty-chat-render-start", {
          activeChatId: activeId,
        });
        renderMessages(activeId);
        onBootstrapStage?.("initial-empty-chat-render-finished", {
          activeChatId: activeId,
        });
      }
      syncDevAuthUi();
      onBootstrapStage?.("auth-bootstrap-applied-finished", {
        activeChatId: activeId,
        chatCount: Array.isArray(data?.chats) ? data.chats.length : 0,
        pendingResumeTriggered: shouldResumePending,
      });
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

    async function signInWithDevAuth({ interactive = true, secretOverride = "" } = {}) {
      if (!desktopTestingEnabled) return false;
      const defaults = readDevAuthDefaults();
      const overrideSecret = String(secretOverride || devAuthHashSecret || "").trim();
      let secret = overrideSecret || defaults.secret || "";
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
      authPayload,
      safeReadJson,
      summarizeUiFailure,
      parseStreamErrorPayload,
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
