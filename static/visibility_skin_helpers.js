(function initHermesMiniappVisibilitySkin(globalScope) {
  function createController(deps) {
    const {
      windowObject,
      documentObject,
      localStorageRef,
      fetchImpl,
      devConfig,
      pendingChats,
      skinStorageKey,
      allowedSkins,
      skinSyncChannel,
      body,
      skinName,
      panelHint,
      skinButtons,
      getCurrentSkin,
      setCurrentSkin,
      apiPost,
      syncTelegramChromeForSkin,
      getIsAuthenticated,
      getActiveChatId,
      refreshChats,
      warmChatHistoryCache,
      syncVisibleActiveChat,
      syncActiveMessageView,
      getStreamAbortControllers,
      shouldDeferImmediateActiveMessageView = null,
      maybeRefreshForBootstrapVersionMismatch = null,
      markBackgrounded = null,
      markVisibilityResume = null,
      getPresenceInstanceId = null,
      suppressDevAutoRefresh = false,
    } = deps || {};

    async function syncUnreadNotificationPresence(options = {}) {
      if (!getIsAuthenticated()) return null;
      const {
        visible = true,
        chatId = Number(getActiveChatId()),
      } = options;
      const instanceId = typeof getPresenceInstanceId === 'function'
        ? String(getPresenceInstanceId() || '').trim()
        : '';
      if (!visible) {
        try {
          await fetchImpl('/api/presence/state', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
            },
            credentials: 'same-origin',
            keepalive: true,
            body: JSON.stringify({ visible: false, instance_id: instanceId || undefined }),
          });
        } catch {
          // best effort hidden-state sync
        }
        return null;
      }
      const normalizedChatId = Number(chatId || 0);
      if (normalizedChatId <= 0) return null;
      try {
        return await apiPost('/api/presence/state', {
          visible: true,
          chat_id: normalizedChatId,
          instance_id: instanceId || undefined,
        });
      } catch {
        return null;
      }
    }

    function normalizeSkin(value) {
      const candidate = String(value || '').trim().toLowerCase();
      return allowedSkins.has(candidate) ? candidate : null;
    }

    function getStoredSkin() {
      try {
        return normalizeSkin(localStorageRef.getItem(skinStorageKey));
      } catch {
        return null;
      }
    }

    function broadcastSkinUpdate(skin) {
      if (!skinSyncChannel) return;
      try {
        skinSyncChannel.postMessage({ type: 'skin', skin });
      } catch {
        // best effort
      }
    }

    function setSkin(skin, { persist = true, broadcast = true } = {}) {
      const nextSkin = normalizeSkin(skin);
      if (!nextSkin) return;

      setCurrentSkin(nextSkin);
      if (body) {
        body.dataset.skin = nextSkin;
      }
      documentObject.documentElement?.setAttribute('data-skin', nextSkin);

      if (persist) {
        try {
          localStorageRef.setItem(skinStorageKey, nextSkin);
        } catch {
          // non-fatal
        }
      }

      if (broadcast) {
        broadcastSkinUpdate(nextSkin);
      }

      if (skinName) {
        skinName.textContent = nextSkin;
      }
      skinButtons.forEach((button) => {
        button.classList.toggle('is-active', button.dataset.skin === nextSkin);
      });
      if (panelHint) {
        panelHint.textContent = '';
      }
      syncTelegramChromeForSkin(nextSkin);
    }

    function syncSkinFromStorage() {
      const storedSkin = getStoredSkin();
      const currentSkin = getCurrentSkin();
      if (!storedSkin || storedSkin === currentSkin) return;
      setSkin(storedSkin, { persist: false, broadcast: false });
    }

    async function saveSkinPreference(skin) {
      const data = await apiPost('/api/preferences/skin', { skin });
      setSkin(data?.skin ?? skin);
      return data;
    }

    function shouldApplyDevReload() {
      return documentObject.visibilityState === 'visible' && pendingChats.size === 0;
    }

    function startDevAutoRefresh() {
      if (suppressDevAutoRefresh || !devConfig.enabled || !devConfig.reloadStateUrl) return;

      let currentVersion = String(devConfig.version || '');
      let reloadQueued = false;

      const maybeReload = () => {
        if (!reloadQueued || !shouldApplyDevReload()) return;
        windowObject.location.reload();
      };

      const poll = async () => {
        try {
          const response = await fetchImpl(`${devConfig.reloadStateUrl}?t=${Date.now()}`, {
            cache: 'no-store',
            headers: { 'Cache-Control': 'no-store' },
          });
          if (!response.ok) return;
          const data = await response.json();
          const nextVersion = String(data.version || '');
          if (!nextVersion) return;
          if (!currentVersion) {
            currentVersion = nextVersion;
            return;
          }
          if (nextVersion !== currentVersion) {
            currentVersion = nextVersion;
            reloadQueued = true;
            maybeReload();
          }
        } catch {
          // dev-only best effort polling
        }
      };

      documentObject.addEventListener('visibilitychange', maybeReload);
      windowObject.setInterval(poll, Math.max(Number(devConfig.intervalMs) || 1200, 500));
    }

    let focusResumeArmed = false;
    let visibleResumeInFlight = null;

    async function syncVisibleActiveChatDelegate(options = {}) {
      return syncVisibleActiveChat(options);
    }

    async function runVisibleResume(trigger = 'visibilitychange') {
      markVisibilityResume?.({
        trigger,
        pendingChatCount: Number(pendingChats?.size || 0),
      });
      syncSkinFromStorage();
      if (!getIsAuthenticated()) return;

      const hidden = documentObject.visibilityState !== 'visible';
      const streamAbortControllers = getStreamAbortControllers();
      const presenceSyncPromise = syncUnreadNotificationPresence({ visible: true });
      const activeId = Number(getActiveChatId());
      const shouldSkipImmediateActiveSync = activeId > 0
        && typeof shouldDeferImmediateActiveMessageView === 'function'
        && Boolean(shouldDeferImmediateActiveMessageView(activeId));
      if (activeId > 0 && !shouldSkipImmediateActiveSync) {
        // Visibility/focus resumption is a common point where throttled UI work catches up.
        // Force an immediate reconciliation from canonical history for the active chat unless
        // unread metadata says local transcript is known stale and active hydration should win first.
        syncActiveMessageView(activeId, { preserveViewport: true });
      }

      try {
        if (activeId > 0) {
          await syncVisibleActiveChatDelegate({
            hidden,
            streamAbortControllers,
          });
        }
      } catch {
        // best effort active-chat sync
      }

      try {
        await refreshChats();
      } catch {
        // best effort status sync
      }

      try {
        warmChatHistoryCache?.();
      } catch {
        // best effort inactive-chat warm sync
      }

      await Promise.allSettled([presenceSyncPromise]);
    }

    function resumeVisibleApp(trigger = 'visibilitychange') {
      if (visibleResumeInFlight) {
        return visibleResumeInFlight;
      }
      visibleResumeInFlight = (async () => {
        try {
          await runVisibleResume(trigger);
        } finally {
          visibleResumeInFlight = null;
        }
      })();
      return visibleResumeInFlight;
    }

    async function handleVisibilityChange() {
      if (documentObject.visibilityState !== 'visible') {
        focusResumeArmed = true;
        await syncUnreadNotificationPresence({ visible: false });
        markBackgrounded?.({ trigger: 'visibilitychange' });
        return;
      }
      focusResumeArmed = false;
      await resumeVisibleApp('visibilitychange');
    }

    function handleStorageEvent(event) {
      if (event.key !== skinStorageKey) return;
      const nextSkin = normalizeSkin(event.newValue);
      if (!nextSkin || nextSkin === getCurrentSkin()) return;
      setSkin(nextSkin, { persist: false, broadcast: false });
    }

    function handleSkinChannelMessage(event) {
      const payload = event?.data;
      if (!payload || payload.type !== 'skin') return;
      const nextSkin = normalizeSkin(payload.skin);
      if (!nextSkin || nextSkin === getCurrentSkin()) return;
      setSkin(nextSkin, { persist: true, broadcast: false });
    }

    function installLifecycleListeners() {
      documentObject.addEventListener('visibilitychange', () => {
        void handleVisibilityChange();
      });

      windowObject.addEventListener('focus', () => {
        if (documentObject.visibilityState !== 'visible') {
          syncSkinFromStorage();
          return;
        }
        if (!focusResumeArmed) {
          syncSkinFromStorage();
          return;
        }
        focusResumeArmed = false;
        void resumeVisibleApp('focus');
      });
      windowObject.addEventListener?.('pagehide', () => {
        focusResumeArmed = true;
        void syncUnreadNotificationPresence({ visible: false });
        markBackgrounded?.({ trigger: 'pagehide' });
      });
      windowObject.setInterval(() => {
        if (documentObject.visibilityState !== 'visible') return;
        void syncUnreadNotificationPresence({ visible: true });
      }, 15000);

      windowObject.addEventListener('storage', handleStorageEvent);
      skinSyncChannel?.addEventListener?.('message', handleSkinChannelMessage);
    }

    return {
      normalizeSkin,
      getStoredSkin,
      setSkin,
      syncSkinFromStorage,
      saveSkinPreference,
      shouldApplyDevReload,
      startDevAutoRefresh,
      syncVisibleActiveChat: syncVisibleActiveChatDelegate,
      syncUnreadNotificationPresence,
      handleVisibilityChange,
      installLifecycleListeners,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappVisibilitySkin = api;
})(typeof window !== 'undefined' ? window : globalThis);
