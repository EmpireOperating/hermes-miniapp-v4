(function initHermesMiniappVisualDevAttach(globalScope) {
  function setText(element, value) {
    if (!element) return;
    element.textContent = String(value || '');
  }

  function setDisabled(element, disabled) {
    if (!element) return;
    element.disabled = Boolean(disabled);
  }

  function createController(deps) {
    const {
      enabled = false,
      getActiveChatId = () => 0,
      getActiveChatLabel = () => '',
      visualDevController,
      dialog,
      form,
      previewUrlInput,
      previewTitleInput,
      currentChatLabel,
      currentSessionLabel,
      settingsOpenButton,
      attachButton,
      refreshButton,
      inspectButton,
      screenshotButton,
      openExternalButton,
      logsButton,
      detachButton,
      cancelButton,
      openExternalUrl = (url) => globalScope?.open?.(url, '_blank', 'noopener'),
      reloadPreview = () => {},
      onError = () => {},
    } = deps || {};

    let bound = false;

    function activeSession() {
      const state = visualDevController?.getState?.() || {};
      const sessions = Array.isArray(state.sessions) ? state.sessions : [];
      const chatId = Number(getActiveChatId?.() || 0);
      return sessions.find((session) => Number(session?.chat_id || session?.chatId || 0) === chatId) || null;
    }

    function refreshUi() {
      const chatId = Number(getActiveChatId?.() || 0);
      const session = activeSession();
      const attachDisabled = !enabled || chatId <= 0;
      const sessionDisabled = !session?.session_id;
      setDisabled(settingsOpenButton, attachDisabled);
      setDisabled(attachButton, attachDisabled);
      setDisabled(refreshButton, !session?.preview_url);
      setDisabled(inspectButton, sessionDisabled);
      setDisabled(screenshotButton, sessionDisabled);
      setDisabled(openExternalButton, !session?.preview_url);
      setDisabled(logsButton, sessionDisabled);
      setDisabled(detachButton, sessionDisabled);
      setText(currentChatLabel, getActiveChatLabel?.() || 'No chat selected');
      setText(currentSessionLabel, session?.preview_title || session?.preview_url || 'No preview attached');
      return { chatId, session };
    }

    function openAttachModal() {
      const { session } = refreshUi();
      if (!enabled || !dialog?.showModal) {
        return;
      }
      previewUrlInput.value = String(session?.preview_url || '');
      previewTitleInput.value = String(session?.preview_title || '');
      dialog.showModal();
      previewUrlInput.focus?.();
      previewUrlInput.select?.();
    }

    function closeAttachModal(returnValue = '') {
      dialog?.close?.(returnValue);
    }

    async function handleAttachSubmit(event) {
      event?.preventDefault?.();
      try {
        await visualDevController?.attachSession?.({
          previewUrl: String(previewUrlInput?.value || '').trim(),
          previewTitle: String(previewTitleInput?.value || '').trim(),
        });
        refreshUi();
        closeAttachModal('attached');
      } catch (error) {
        onError(error);
      }
    }

    async function handleDetach() {
      try {
        await visualDevController?.detachSession?.(activeSession()?.session_id || '');
        refreshUi();
        closeAttachModal('detached');
      } catch (error) {
        onError(error);
      }
    }

    function handleRefresh() {
      if (!activeSession()?.preview_url) return;
      reloadPreview();
    }

    function handleInspect() {
      if (!activeSession()?.session_id) return;
      visualDevController?.requestInspectMode?.();
    }

    function handleScreenshot(event = null) {
      if (!activeSession()?.session_id) return;
      const wantsRegionCapture = Boolean(event?.shiftKey);
      if (wantsRegionCapture && typeof visualDevController?.requestRegionScreenshot === 'function') {
        visualDevController.requestRegionScreenshot();
        return;
      }
      visualDevController?.requestScreenshot?.();
    }

    function handleOpenExternal() {
      const previewUrl = String(activeSession()?.preview_url || '').trim();
      if (!previewUrl) return;
      openExternalUrl(previewUrl);
    }

    function handleLogs() {
      if (!activeSession()?.session_id) return;
      visualDevController?.toggleConsoleDrawer?.(null);
    }

    function bind() {
      if (bound) return;
      settingsOpenButton?.addEventListener?.('click', openAttachModal);
      attachButton?.addEventListener?.('click', openAttachModal);
      refreshButton?.addEventListener?.('click', handleRefresh);
      inspectButton?.addEventListener?.('click', handleInspect);
      screenshotButton?.addEventListener?.('click', (event) => handleScreenshot(event));
      openExternalButton?.addEventListener?.('click', handleOpenExternal);
      logsButton?.addEventListener?.('click', handleLogs);
      detachButton?.addEventListener?.('click', () => {
        void handleDetach();
      });
      cancelButton?.addEventListener?.('click', () => closeAttachModal('cancel'));
      form?.addEventListener?.('submit', (event) => {
        void handleAttachSubmit(event);
      });
      bound = true;
      refreshUi();
    }

    return {
      bind,
      refreshUi,
      openAttachModal,
      closeAttachModal,
      handleAttachSubmit,
      handleDetach,
      handleRefresh,
      handleInspect,
      handleScreenshot,
      handleOpenExternal,
      handleLogs,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappVisualDevAttach = api;
})(typeof window !== 'undefined' ? window : globalThis);
