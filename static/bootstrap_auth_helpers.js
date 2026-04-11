(function initHermesMiniappBootstrapAuth(globalScope) {
  function createDelayController({ windowObject }) {
    function delayMs(ms) {
      return new Promise((resolve) => {
        const scheduleTimeout = typeof windowObject?.setTimeout === "function"
          ? windowObject.setTimeout.bind(windowObject)
          : globalScope.setTimeout;
        scheduleTimeout(resolve, Math.max(0, Number(ms) || 0));
      });
    }

    return { delayMs };
  }

  function createIdentityController({
    normalizeHandleOverride = null,
    fallbackHandleFromDisplayNameOverride = null,
    refreshOperatorRoleLabelsOverride = null,
    getOperatorDisplayName = null,
    messagesEl = null,
    isMobileQuoteMode = null,
  }) {
    function normalizeHandle(value) {
      if (typeof normalizeHandleOverride === "function") {
        return normalizeHandleOverride(value);
      }
      return String(value || "").trim().replace(/^@+/, "");
    }

    function fallbackHandleFromDisplayName(value) {
      if (typeof fallbackHandleFromDisplayNameOverride === "function") {
        return fallbackHandleFromDisplayNameOverride(value);
      }
      const cleaned = String(value || "").trim();
      if (!cleaned) return "";
      if (/^[\w .-]+$/.test(cleaned)) {
        return cleaned.replace(/\s+/g, "");
      }
      return cleaned;
    }

    function refreshOperatorRoleLabels() {
      if (typeof refreshOperatorRoleLabelsOverride === "function") {
        return refreshOperatorRoleLabelsOverride();
      }
      if (!messagesEl) return;
      const label = typeof getOperatorDisplayName === "function"
        ? String(getOperatorDisplayName() || "") || "Operator"
        : "Operator";
      for (const roleNode of messagesEl.querySelectorAll('.message--operator .message__role, .message[data-role="operator"] .message__role, .message[data-role="user"] .message__role')) {
        roleNode.textContent = label;
      }
    }

    function isMobileBootstrapPath() {
      if (typeof isMobileQuoteMode === "function") {
        return Boolean(isMobileQuoteMode());
      }
      return false;
    }

    return {
      normalizeHandle,
      fallbackHandleFromDisplayName,
      refreshOperatorRoleLabels,
      isMobileBootstrapPath,
    };
  }

  function createRequestController({
    initData = "",
    parseSseEvent = null,
    safeReadJsonOverride = null,
    fetchImpl,
    setIsAuthenticated,
    authStatus,
    updateComposerState = null,
    authBootstrapMaxAttempts = 1,
    authBootstrapBaseDelayMs = 0,
    authBootstrapRetryableStatus = null,
    bootBootstrapVersion = "",
    bootstrapVersionReloadStorageKey = "",
    sessionStorageRef,
    recordBootMetric = null,
    syncBootLatencyChip = null,
    onBootstrapStage = null,
    markVersionSyncReloadIntent = null,
    windowObject = null,
    delayMs,
  }) {
    function authPayload(extra = {}) {
      return { init_data: initData, ...extra };
    }

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

    async function apiPost(url, payload) {
      const response = await fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(authPayload(payload)),
      });
      const data = await safeReadJson(response);
      if (!response.ok || !data?.ok) {
        const fallbackText = data?.error || summarizeUiFailure("", {
          status: response.status,
          fallback: `Request failed: ${response.status}`,
        });
        const message = summarizeUiFailure(data?.error || "", {
          status: response.status,
          fallback: fallbackText,
        });
        if (/Telegram init data is too old/i.test(message)) {
          setIsAuthenticated(false);
          if (authStatus) {
            authStatus.textContent = "Session expired";
          }
          updateComposerState?.();
          throw new Error("Telegram session expired. Close and reopen the mini app to refresh auth.");
        }
        throw new Error(message);
      }
      return data;
    }

    function isRetryableAuthBootstrapFailure(response, data) {
      const status = Number(response?.status || 0);
      if (!status) return true;
      if (authBootstrapRetryableStatus?.has?.(status)) return true;
      const text = String(data?.error || "");
      return /temporarily unavailable|try again|timeout/i.test(text);
    }

    async function fetchAuthBootstrapWithRetry() {
      let lastResponse = null;
      let lastData = null;
      let lastError = null;
      const maxAttempts = Math.max(1, Number(authBootstrapMaxAttempts) || 1);

      recordBootMetric?.("authBootstrapStartMs");
      syncBootLatencyChip?.("auth-request");

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        onBootstrapStage?.("auth-bootstrap-attempt-start", { attempt });
        try {
          const response = await fetchImpl("/api/auth", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ init_data: initData, allow_empty: true }),
          });
          const data = await safeReadJson(response);
          if (response.ok && data?.ok) {
            recordBootMetric?.("authBootstrapSuccessMs");
            onBootstrapStage?.("auth-bootstrap-ok", { attempt, status: response.status });
            return { response, data };
          }
          lastResponse = response;
          lastData = data;
          if (!isRetryableAuthBootstrapFailure(response, data) || attempt >= maxAttempts) {
            recordBootMetric?.("authBootstrapFailureMs");
            onBootstrapStage?.("auth-bootstrap-failed", { attempt, status: response.status, retryable: false });
            return { response, data };
          }
          onBootstrapStage?.("auth-bootstrap-attempt-retryable-failure", {
            attempt,
            status: response.status,
            retryable: true,
          });
        } catch (error) {
          lastError = error;
          onBootstrapStage?.("auth-bootstrap-attempt-error", {
            attempt,
            message: String(error?.message || error || ""),
          });
          if (attempt >= maxAttempts) {
            break;
          }
        }

        const jitterMs = Math.floor(Math.random() * 120);
        const backoffMs = Math.max(0, Number(authBootstrapBaseDelayMs) || 0) * attempt + jitterMs;
        onBootstrapStage?.("auth-bootstrap-retry-scheduled", {
          attempt,
          backoffMs,
        });
        await delayMs(backoffMs);
      }

      if (lastResponse) {
        return { response: lastResponse, data: lastData };
      }
      if (lastError) {
        recordBootMetric?.("authBootstrapErrorMs");
        onBootstrapStage?.("auth-bootstrap-failed", {
          attempt: maxAttempts,
          status: 0,
          retryable: false,
          message: String(lastError?.message || lastError || ""),
        });
        throw lastError;
      }
      recordBootMetric?.("authBootstrapErrorMs");
      throw new Error("Session bootstrap failed before response.");
    }

    async function maybeRefreshForBootstrapVersionMismatch() {
      if (!bootBootstrapVersion) return false;

      try {
        const response = await fetchImpl("/api/state", {
          method: "GET",
          cache: "no-store",
          headers: { "Cache-Control": "no-cache" },
        });
        const data = await safeReadJson(response);
        if (!response.ok || !data?.ok) {
          return false;
        }
        const serverVersion = String(data?.bootstrap_version || "").trim();
        if (!serverVersion || serverVersion === bootBootstrapVersion) {
          sessionStorageRef?.removeItem?.(bootstrapVersionReloadStorageKey);
          return false;
        }

        const reloadMarker = `${bootBootstrapVersion}->${serverVersion}`;
        const priorMarker = sessionStorageRef?.getItem?.(bootstrapVersionReloadStorageKey) || "";
        if (priorMarker === reloadMarker) {
          return false;
        }
        sessionStorageRef?.setItem?.(bootstrapVersionReloadStorageKey, reloadMarker);

        if (authStatus) {
          authStatus.textContent = "Refreshing app…";
          authStatus.title = "Detected a newer app build. Reloading once to sync assets.";
        }
        const pathName = String(windowObject?.location?.pathname || "");
        const target = `${pathName}?v=${encodeURIComponent(serverVersion)}`;
        markVersionSyncReloadIntent?.({
          fromVersion: bootBootstrapVersion,
          toVersion: serverVersion,
          trigger: "bootstrap-version-mismatch",
          target,
        });
        windowObject?.location?.replace?.(target);
        return true;
      } catch {
        return false;
      }
    }

    return {
      authPayload,
      safeReadJson,
      summarizeUiFailure,
      parseStreamErrorPayload,
      apiPost,
      fetchAuthBootstrapWithRetry,
      maybeRefreshForBootstrapVersionMismatch,
    };
  }

  function createDevAuthUiController({
    desktopTestingEnabled,
    getIsAuthenticated,
    devAuthControls = null,
    devModeBadge = null,
    devSignInButton = null,
    sessionStorageRef,
    devAuthSessionStorageKey,
  }) {
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

    return {
      syncDevAuthUi,
      readDevAuthDefaults,
      writeDevAuthDefaults,
    };
  }

  function createBootstrapApplyController({
    setIsAuthenticated,
    normalizeHandle,
    fallbackHandleFromDisplayName,
    setOperatorDisplayName,
    operatorName,
    authStatus,
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
    hasFreshPendingStreamSnapshot = null,
    restorePendingStreamSnapshot = null,
    ensureActivationReadThreshold = null,
    onBootstrapStage = null,
    delayMs,
    isMobileBootstrapPath,
    syncDevAuthUi,
  }) {
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
      onBootstrapStage?.("auth-bootstrap-sync-chats-finished", {
        chatCount: Array.isArray(data?.chats) ? data.chats.length : 0,
      });
      const bootstrapChats = Array.isArray(data?.chats) ? data.chats : [];
      const bootstrapPinnedChats = Array.isArray(data?.pinned_chats) ? data.pinned_chats : [];
      syncPinnedChats(bootstrapPinnedChats);
      const hasPinnedChats = bootstrapPinnedChats.length > 0 || bootstrapChats.some((chat) => Boolean(chat?.is_pinned));
      const activeId = Number(data.active_chat_id || 0);
      if (activeId > 0 && typeof ensureActivationReadThreshold === "function") {
        const activeChat = chats?.get?.(activeId) || data?.chats?.find?.((chat) => Number(chat?.id) === activeId) || null;
        ensureActivationReadThreshold(activeId, activeChat?.unread_count);
      }
      if (!activeId) {
        setActiveChatMeta(null);
        if (hasPinnedChats) {
          void delayMs(0).then(() => renderPinnedChats());
        }
        syncDevAuthUi();
        onBootstrapStage?.("auth-bootstrap-applied-finished", {
          activeChatId: 0,
          chatCount: Array.isArray(data?.chats) ? data.chats.length : 0,
          pendingResumeTriggered: false,
        });
        return;
      }

      const bootstrapHistory = Array.isArray(data?.history) ? [...data.history] : [];
      const mobileBootstrapPath = isMobileBootstrapPath();
      const bootstrapForceVirtualize = !mobileBootstrapPath && bootstrapHistory.length >= 96;
      const hasFreshPendingSnapshot = typeof hasFreshPendingStreamSnapshot === "function"
        ? Boolean(hasFreshPendingStreamSnapshot(activeId))
        : false;
      const restoredPendingSnapshot = hasFreshPendingSnapshot && typeof restorePendingStreamSnapshot === "function"
        ? Boolean(restorePendingStreamSnapshot(activeId))
        : false;
      if (restoredPendingSnapshot) {
        const chat = chats.get(activeId);
        if (chat && typeof chat === "object" && !chat.pending) {
          chat.pending = true;
        }
      }
      const restoredHistory = restoredPendingSnapshot ? histories.get(activeId) : null;
      if (restoredPendingSnapshot && Array.isArray(restoredHistory) && restoredHistory.length > bootstrapHistory.length) {
        bootstrapHistory.splice(0, bootstrapHistory.length, ...restoredHistory);
      }
      const shouldInjectEmptyState = !bootstrapHistory.length && !restoredPendingSnapshot;
      if (shouldInjectEmptyState) {
        bootstrapHistory.push({
          role: "system",
          body: "You're all set. This chat is empty.",
          created_at: new Date().toISOString(),
        });
      }
      histories.set(activeId, bootstrapHistory);
      setActiveChatMeta(activeId, { deferNonCritical: true });
      if (hasPinnedChats) {
        void delayMs(0).then(() => renderPinnedChats());
      }
      onBootstrapStage?.("initial-render-start", {
        activeChatId: activeId,
        historyCount: bootstrapHistory.length,
        restoredPendingSnapshot,
      });
      renderMessages(activeId, { forceVirtualize: bootstrapForceVirtualize });
      onBootstrapStage?.("initial-render-finished", {
        activeChatId: activeId,
        historyCount: bootstrapHistory.length,
        restoredPendingSnapshot,
      });
      if (!mobileBootstrapPath && bootstrapChats.length > 1) {
        onBootstrapStage?.("warm-history-cache-triggered", {
          activeChatId: activeId,
        });
        void delayMs(0).then(() => warmChatHistoryCache());
      }
      const shouldResumePending = (Boolean(chats.get(activeId)?.pending) || restoredPendingSnapshot) && !pendingChats.has(activeId);
      if (shouldResumePending) {
        onBootstrapStage?.("pending-stream-resume-triggered", {
          activeChatId: activeId,
          force: Boolean(restoredPendingSnapshot && !Boolean(data?.chats?.find?.((chat) => Number(chat?.id) === activeId)?.pending)),
        });
        void delayMs(0).then(() => resumePendingChatStream(activeId, {
          force: restoredPendingSnapshot && !Boolean(data?.chats?.find?.((chat) => Number(chat?.id) === activeId)?.pending),
        }));
      }
      syncDevAuthUi();
      onBootstrapStage?.("auth-bootstrap-applied-finished", {
        activeChatId: activeId,
        chatCount: Array.isArray(data?.chats) ? data.chats.length : 0,
        pendingResumeTriggered: shouldResumePending,
      });
    }

    return { applyAuthBootstrap };
  }

  function createDevAuthSignInController({
    desktopTestingEnabled,
    devAuthHashSecret = "",
    devAuthModal,
    devAuthForm,
    devAuthSecretInput,
    devAuthUserIdInput,
    devAuthDisplayNameInput,
    devAuthUsernameInput,
    devAuthCancelButton,
    authStatus,
    appendSystemMessage,
    fetchImpl,
    safeReadJson,
    readDevAuthDefaults,
    writeDevAuthDefaults,
    applyAuthBootstrap,
    syncDevAuthUi,
    windowObject = null,
  }) {
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

      const promptWindow = globalScope.window || windowObject || null;
      const secret = promptWindow?.prompt ? promptWindow.prompt("Dev auth secret", defaults.secret || "") : null;
      if (secret === null) return null;
      const userId = promptWindow?.prompt ? promptWindow.prompt("Dev user id", defaults.userId || "9001") : null;
      if (userId === null) return null;
      const displayName = promptWindow?.prompt ? promptWindow.prompt("Display name", defaults.displayName || "Desktop Tester") : null;
      if (displayName === null) return null;
      const username = promptWindow?.prompt ? promptWindow.prompt("Username", defaults.username || "desktop") : null;
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
      if (authStatus) {
        authStatus.textContent = "Signing in (dev)…";
      }

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
        if (authStatus) {
          authStatus.textContent = "Dev sign-in failed";
        }
        appendSystemMessage(data?.error || `Dev sign-in failed (${response.status}).`);
        syncDevAuthUi();
        return false;
      }

      applyAuthBootstrap(data, { preferredUsername: data?.user?.username || "" });
      return true;
    }

    return {
      askForDevAuth,
      signInWithDevAuth,
    };
  }

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
      normalizeHandle: normalizeHandleOverride = null,
      initData = "",
      parseSseEvent = null,
      fallbackHandleFromDisplayName: fallbackHandleFromDisplayNameOverride = null,
      setOperatorDisplayName,
      getOperatorDisplayName = null,
      operatorName,
      messagesEl = null,
      refreshOperatorRoleLabels: refreshOperatorRoleLabelsOverride = null,
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
      hasFreshPendingStreamSnapshot = null,
      restorePendingStreamSnapshot = null,
      ensureActivationReadThreshold = null,
      onBootstrapStage = null,
      windowObject = globalScope.window || null,
      authBootstrapMaxAttempts = 1,
      authBootstrapBaseDelayMs = 0,
      authBootstrapRetryableStatus = null,
      bootBootstrapVersion = "",
      bootstrapVersionReloadStorageKey = "",
      recordBootMetric = null,
      syncBootLatencyChip = null,
      updateComposerState = null,
      isMobileQuoteMode = null,
      markVersionSyncReloadIntent = null,
    } = deps;

    const delayController = createDelayController({ windowObject });
    const identityController = createIdentityController({
      normalizeHandleOverride,
      fallbackHandleFromDisplayNameOverride,
      refreshOperatorRoleLabelsOverride,
      getOperatorDisplayName,
      messagesEl,
      isMobileQuoteMode,
    });
    const devAuthUiController = createDevAuthUiController({
      desktopTestingEnabled,
      getIsAuthenticated,
      devAuthControls,
      devModeBadge,
      devSignInButton,
      sessionStorageRef,
      devAuthSessionStorageKey,
    });
    const bootstrapApplyController = createBootstrapApplyController({
      setIsAuthenticated,
      normalizeHandle: identityController.normalizeHandle,
      fallbackHandleFromDisplayName: identityController.fallbackHandleFromDisplayName,
      setOperatorDisplayName,
      operatorName,
      authStatus,
      refreshOperatorRoleLabels: identityController.refreshOperatorRoleLabels,
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
      hasFreshPendingStreamSnapshot,
      restorePendingStreamSnapshot,
      ensureActivationReadThreshold,
      onBootstrapStage,
      delayMs: delayController.delayMs,
      isMobileBootstrapPath: identityController.isMobileBootstrapPath,
      syncDevAuthUi: devAuthUiController.syncDevAuthUi,
    });
    const requestController = createRequestController({
      initData,
      parseSseEvent,
      safeReadJsonOverride,
      fetchImpl,
      setIsAuthenticated,
      authStatus,
      updateComposerState,
      authBootstrapMaxAttempts,
      authBootstrapBaseDelayMs,
      authBootstrapRetryableStatus,
      bootBootstrapVersion,
      bootstrapVersionReloadStorageKey,
      sessionStorageRef,
      recordBootMetric,
      syncBootLatencyChip,
      onBootstrapStage,
      markVersionSyncReloadIntent,
      windowObject,
      delayMs: delayController.delayMs,
    });
    const devAuthSignInController = createDevAuthSignInController({
      desktopTestingEnabled,
      devAuthHashSecret,
      devAuthModal,
      devAuthForm,
      devAuthSecretInput,
      devAuthUserIdInput,
      devAuthDisplayNameInput,
      devAuthUsernameInput,
      devAuthCancelButton,
      authStatus,
      appendSystemMessage,
      fetchImpl,
      safeReadJson: requestController.safeReadJson,
      readDevAuthDefaults: devAuthUiController.readDevAuthDefaults,
      writeDevAuthDefaults: devAuthUiController.writeDevAuthDefaults,
      applyAuthBootstrap: bootstrapApplyController.applyAuthBootstrap,
      syncDevAuthUi: devAuthUiController.syncDevAuthUi,
      windowObject,
    });

    return {
      normalizeHandle: identityController.normalizeHandle,
      fallbackHandleFromDisplayName: identityController.fallbackHandleFromDisplayName,
      refreshOperatorRoleLabels: identityController.refreshOperatorRoleLabels,
      authPayload: requestController.authPayload,
      safeReadJson: requestController.safeReadJson,
      summarizeUiFailure: requestController.summarizeUiFailure,
      parseStreamErrorPayload: requestController.parseStreamErrorPayload,
      apiPost: requestController.apiPost,
      syncDevAuthUi: devAuthUiController.syncDevAuthUi,
      readDevAuthDefaults: devAuthUiController.readDevAuthDefaults,
      writeDevAuthDefaults: devAuthUiController.writeDevAuthDefaults,
      applyAuthBootstrap: bootstrapApplyController.applyAuthBootstrap,
      askForDevAuth: devAuthSignInController.askForDevAuth,
      signInWithDevAuth: devAuthSignInController.signInWithDevAuth,
      fetchAuthBootstrapWithRetry: requestController.fetchAuthBootstrapWithRetry,
      maybeRefreshForBootstrapVersionMismatch: requestController.maybeRefreshForBootstrapVersionMismatch,
    };
  }

  const api = { createController };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappBootstrapAuth = api;
})(typeof window !== "undefined" ? window : globalThis);
