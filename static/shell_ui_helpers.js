(function initHermesMiniappShellUI(globalScope) {
  function createController(deps) {
    const {
      tg,
      pendingChats,
      fullscreenAppTopButton,
      appendSystemMessage,
      scheduleTimeout,
    } = deps;

    function syncClosingConfirmation() {
      if (!tg?.isVersionAtLeast?.('6.2')) return;
      try {
        if (pendingChats.size > 0) {
          tg.enableClosingConfirmation?.();
          return;
        }
        tg.disableClosingConfirmation?.();
      } catch {
        // Best effort only; some Telegram clients expose partial WebApp APIs.
      }
    }

    function syncTelegramChromeForSkin(skin) {
      if (!tg) return;
      const palette = {
        terminal: { header: '#0f1218', background: '#0b0d12' },
        oracle: { header: '#140f1b', background: '#09070c' },
        obsidian: { header: '#0d1216', background: '#080d10' },
      };
      const picked = palette[skin] || palette.terminal;
      try {
        tg.setHeaderColor?.(picked.header);
        tg.setBackgroundColor?.(picked.background);
      } catch {
        // Best effort only; desktop clients vary.
      }
    }

    function syncFullscreenControlState() {
      if (!fullscreenAppTopButton) return;
      const isFullscreen = Boolean(tg?.isFullscreen);
      fullscreenAppTopButton.textContent = isFullscreen ? '🗗' : '⛶';
      fullscreenAppTopButton.title = isFullscreen ? 'Exit fullscreen' : 'Enter fullscreen';
    }

    function handleFullscreenToggle() {
      try {
        if (!tg?.requestFullscreen) {
          appendSystemMessage('Fullscreen is not supported by this Telegram client.');
          return;
        }

        const isFullscreen = Boolean(tg?.isFullscreen);
        if (isFullscreen && tg?.exitFullscreen) {
          tg.exitFullscreen();
        } else {
          tg.requestFullscreen();
        }

        scheduleTimeout(syncFullscreenControlState, 120);
      } catch {
        appendSystemMessage('Fullscreen toggle failed on this Telegram client.');
      }
    }

    function handleCloseApp() {
      try {
        if (!tg?.close) {
          appendSystemMessage('Close action is not available on this Telegram client.');
          return;
        }
        tg.close();
      } catch {
        appendSystemMessage('Close action is not available on this Telegram client.');
      }
    }

    return {
      syncClosingConfirmation,
      syncTelegramChromeForSkin,
      syncFullscreenControlState,
      handleFullscreenToggle,
      handleCloseApp,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappShellUI = api;
})(typeof window !== 'undefined' ? window : globalThis);
