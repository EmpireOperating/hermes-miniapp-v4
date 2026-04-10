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
      syncVisibleActiveChat,
      syncActiveMessageView,
      getStreamAbortControllers,
      maybeRefreshForBootstrapVersionMismatch = null,
      markBackgrounded = null,
      markVisibilityResume = null,
    } = deps;

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
      if (!devConfig.enabled || !devConfig.reloadStateUrl) return;

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

    async function syncVisibleActiveChatDelegate(options = {}) {
      return syncVisibleActiveChat(options);
    }

    async function handleVisibilityChange() {
      if (documentObject.visibilityState !== 'visible') {
        markBackgrounded?.({ trigger: 'visibilitychange' });
        return;
      }
      markVisibilityResume?.({
        trigger: 'visibilitychange',
        pendingChatCount: Number(pendingChats?.size || 0),
      });
      if (await maybeRefreshForBootstrapVersionMismatch?.()) return;
      syncSkinFromStorage();
      if (!getIsAuthenticated()) return;

      const activeId = Number(getActiveChatId());
      if (activeId > 0) {
        // Visibility changes are a common point where throttled UI work catches up.
        // Force an immediate reconciliation from canonical history for the active chat.
        syncActiveMessageView(activeId, { preserveViewport: true });
      }

      try {
        await refreshChats();
        await syncVisibleActiveChatDelegate({
          hidden: documentObject.visibilityState !== 'visible',
          streamAbortControllers: getStreamAbortControllers(),
        });
      } catch {
        // best effort sync
      }
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
        syncSkinFromStorage();
      });
      windowObject.addEventListener?.('pagehide', () => {
        markBackgrounded?.({ trigger: 'pagehide' });
      });

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
