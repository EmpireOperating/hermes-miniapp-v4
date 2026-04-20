(function initHermesMiniappVisualDevMode(globalScope) {
  function normalizeConfig(rawConfig = {}) {
    return {
      enabled: Boolean(rawConfig?.enabled),
      allowedPreviewOrigins: Array.isArray(rawConfig?.allowedPreviewOrigins) ? rawConfig.allowedPreviewOrigins : [],
      allowedParentOrigins: Array.isArray(rawConfig?.allowedParentOrigins) ? rawConfig.allowedParentOrigins : [],
    };
  }

  function normalizeSession(session = {}, chatLabelForId = null) {
    const chatId = Number(session?.chat_id || session?.chatId || 0) || 0;
    const previewUrl = String(session?.preview_url || session?.previewUrl || 'about:blank');
    const previewOrigin = String(session?.preview_origin || session?.previewOrigin || '');
    const previewTitle = String(session?.preview_title || session?.previewTitle || '').trim();
    const labelPrefix = typeof chatLabelForId === 'function' && chatId > 0 ? String(chatLabelForId(chatId) || '').trim() : '';
    const labelSuffix = previewTitle || previewUrl;
    const chatLabel = labelPrefix && labelSuffix ? `${labelPrefix} · ${labelSuffix}` : (labelPrefix || labelSuffix || 'No preview attached');
    return {
      ...session,
      chat_id: chatId,
      preview_url: previewUrl,
      preview_origin: previewOrigin,
      preview_title: previewTitle,
      bridge_parent_origin: String(session?.bridge_parent_origin || session?.bridgeParentOrigin || ''),
      runtime: session?.runtime || {},
      chatLabel,
    };
  }

  function createController(deps) {
    const {
      config = {},
      shellHelpers,
      previewHelpers,
      shellRoot,
      previewFrame,
      ownershipLabel,
      statusLabel,
      selectionChip,
      screenshotChip,
      consoleDrawer,
      runtimeSummary,
      consoleList,
      getIsAuthenticated = () => false,
      getActiveChatId = () => 0,
      getParentOrigin = () => '',
      chatLabelForId = null,
      apiGetJson = async () => ({ ok: true, sessions: [] }),
      apiPost = async () => ({ ok: true }),
      onUiError = () => {},
      nowFn = () => Date.now(),
    } = deps || {};

    const visualDevConfig = normalizeConfig(config);
    const shellController = shellHelpers.createController({
      shellRoot,
      previewFrame,
      ownershipLabel,
      statusLabel,
      selectionChip,
      screenshotChip,
      consoleDrawer,
      runtimeSummary,
      consoleList,
      initialEnabled: visualDevConfig.enabled,
    });

    let currentState = { ok: true, enabled: visualDevConfig.enabled, sessions: [] };
    let activeSession = null;
    let activePreviewController = null;
    let activeSelection = null;
    let activeScreenshot = null;
    let activePreview = null;
    let activeConsole = null;
    let getActiveChatIdRef = getActiveChatId;
    let loadBound = false;

    function sessionByChatId(chatId) {
      const normalizedChatId = Number(chatId || 0);
      return (currentState.sessions || []).find((session) => Number(session?.chat_id || session?.chatId || 0) === normalizedChatId) || null;
    }

    function disposePreviewController() {
      if (!activePreviewController || typeof activePreviewController.dispose !== 'function') {
        activePreviewController = null;
        return;
      }
      activePreviewController.dispose();
      activePreviewController = null;
    }

    async function loadSessionDetails(chatId = null) {
      const resolvedChatId = Number(chatId || activeSession?.chat_id || activeSession?.chatId || 0);
      if (resolvedChatId <= 0) {
        activeSelection = null;
        activeScreenshot = null;
        activePreview = null;
        activeConsole = null;
        return null;
      }
      const details = await apiGetJson(`/api/visual-dev/session/${resolvedChatId}`);
      activeSelection = details?.latest_selection?.payload || null;
      activeScreenshot = Array.isArray(details?.artifacts) && details.artifacts[0] ? details.artifacts[0] : null;
      activePreview = details?.session
        ? {
            preview_url: String(details.session.preview_url || details.session.previewUrl || activeSession?.preview_url || ''),
            preview_title: String(details.session.preview_title || details.session.previewTitle || activeSession?.preview_title || ''),
          }
        : (activeSession
          ? {
              preview_url: String(activeSession.preview_url || ''),
              preview_title: String(activeSession.preview_title || ''),
            }
          : null);
      const consoleEvents = Array.isArray(details?.console_events) ? details.console_events : [];
      const latestConsoleEvent = consoleEvents[0] || null;
      const runtime = details?.session?.runtime || activeSession?.runtime || {};
      activeConsole = runtime?.state || latestConsoleEvent
        ? {
            runtime_state: String(runtime?.state || ''),
            runtime_message: String(runtime?.message || ''),
            level: String(latestConsoleEvent?.level || ''),
            message: String(latestConsoleEvent?.message || ''),
          }
        : null;
      shellController.applySessionDetails(details || {});
      return details;
    }

    async function postSelection(selection = {}) {
      if (!activeSession?.session_id) return null;
      const response = await apiPost('/api/visual-dev/session/select', {
        session_id: activeSession.session_id,
        selection_type: 'dom',
        payload: selection,
      });
      activeSelection = response?.selection?.payload || selection || null;
      shellController.applySelectionSummary(activeSelection || selection);
      return response;
    }

    async function postScreenshot(screenshot = {}) {
      if (!activeSession?.session_id) return null;
      const contentType = String(screenshot?.contentType || screenshot?.content_type || '');
      const bytesB64 = String(screenshot?.bytesB64 || screenshot?.bytes_b64 || '');
      const metadata = {};
      if (screenshot?.label) {
        metadata.label = screenshot.label;
      }
      if (screenshot?.capture) {
        metadata.capture = String(screenshot.capture);
      }
      if (screenshot?.region && typeof screenshot.region === 'object') {
        metadata.region = {
          left: Number(screenshot.region.left || 0),
          top: Number(screenshot.region.top || 0),
          width: Number(screenshot.region.width || 0),
          height: Number(screenshot.region.height || 0),
        };
      }
      const response = await apiPost('/api/visual-dev/session/screenshot', {
        session_id: activeSession.session_id,
        content_type: contentType,
        bytes_b64: bytesB64,
        metadata,
      });
      activeScreenshot = response?.artifact || screenshot || null;
      shellController.applyScreenshotSummary(activeScreenshot || screenshot);
      return response;
    }

    async function postConsole(consoleEvent = {}) {
      if (!activeSession?.session_id) return null;
      const metadata = {};
      Object.entries(consoleEvent || {}).forEach(([key, value]) => {
        if (key === 'level' || key === 'message' || key === 'type') return;
        metadata[key] = value;
      });
      const response = await apiPost('/api/visual-dev/session/console', {
        session_id: activeSession.session_id,
        event_type: String(consoleEvent?.type || 'console'),
        level: String(consoleEvent?.level || 'info'),
        message: String(consoleEvent?.message || ''),
        metadata,
      });
      if (response?.runtime) {
        shellController.applySessionState({
          enabled: true,
          ...activeSession,
          runtime: response.runtime,
        });
        shellController.applyRuntimeSummary(response.runtime);
      }
      activeConsole = {
        runtime_state: String(response?.runtime?.state || activeSession?.runtime?.state || ''),
        runtime_message: String(response?.runtime?.message || activeSession?.runtime?.message || ''),
        level: String(consoleEvent?.level || ''),
        message: String(consoleEvent?.message || ''),
      };
      shellController.appendConsoleEvent({
        level: consoleEvent?.level,
        message: consoleEvent?.message,
        type: consoleEvent?.type,
      });
      return response;
    }

    function runtimeCommandPayload(runtime = {}) {
      const normalizedType = String(runtime?.type || '').trim();
      if (normalizedType === 'hermes-visual-dev:ready') {
        return {
          command: 'bridge-ready',
          payload: {
            preview_url: String(runtime?.previewUrl || runtime?.preview_url || ''),
            preview_title: String(runtime?.previewTitle || runtime?.preview_title || ''),
          },
        };
      }
      return {
        command: String(runtime?.command || 'build-state'),
        payload: runtime?.payload && typeof runtime.payload === 'object'
          ? runtime.payload
          : {
              state: String(runtime?.state || 'live'),
              message: String(runtime?.message || ''),
            },
      };
    }

    async function postRuntime(runtime = {}) {
      if (!activeSession?.session_id) return null;
      const commandBody = runtimeCommandPayload(runtime);
      const response = await apiPost('/api/visual-dev/session/command', {
        session_id: activeSession.session_id,
        command: commandBody.command,
        payload: commandBody.payload,
      });
      if (response?.runtime) {
        shellController.applySessionState({
          enabled: true,
          ...activeSession,
          runtime: response.runtime,
        });
        shellController.applyRuntimeSummary(response.runtime);
        activeConsole = {
          runtime_state: String(response.runtime?.state || ''),
          runtime_message: String(response.runtime?.message || ''),
          level: String(activeConsole?.level || ''),
          message: String(activeConsole?.message || ''),
        };
      }
      return response;
    }

    function installPreviewLoadHandler() {
      if (loadBound || !previewFrame?.addEventListener) {
        return;
      }
      previewFrame.addEventListener('load', () => {
        if (activePreviewController?.sendHandshake) {
          activePreviewController.sendHandshake();
        }
      });
      loadBound = true;
    }

    async function activateSession(session = null) {
      if (!session?.session_id) {
        disposePreviewController();
        activeSession = null;
        activeSelection = null;
        activeScreenshot = null;
        activePreview = null;
        activeConsole = null;
        shellController.clearSessionState();
        return null;
      }
      const normalizedSession = normalizeSession(session, chatLabelForId);
      if (String(activeSession?.session_id || '') === String(normalizedSession.session_id || '')) {
        activeSession = normalizedSession;
        shellController.applySessionState({ enabled: true, ...normalizedSession, chatLabel: normalizedSession.chatLabel });
        await loadSessionDetails(normalizedSession.chat_id || normalizedSession.chatId);
        return activeSession;
      }
      disposePreviewController();
      activeSession = normalizedSession;
      activePreview = {
        preview_url: String(normalizedSession.preview_url || ''),
        preview_title: String(normalizedSession.preview_title || ''),
      };
      shellController.applySessionState({ enabled: true, ...normalizedSession, chatLabel: normalizedSession.chatLabel });
      activePreviewController = previewHelpers.createController({
        sessionId: normalizedSession.session_id,
        previewOrigin: normalizedSession.preview_origin,
        parentOrigin: normalizedSession.bridge_parent_origin,
        previewFrame,
        onSelection: async (selection) => postSelection(selection).catch(onUiError),
        onScreenshot: async (screenshot) => postScreenshot(screenshot).catch(onUiError),
        onConsole: async (consoleEvent) => postConsole(consoleEvent).catch(onUiError),
        onRuntime: async (runtime) => postRuntime(runtime).catch(onUiError),
      });
      activePreviewController.installMessageBridge?.();
      installPreviewLoadHandler();
      await loadSessionDetails(normalizedSession.chat_id || normalizedSession.chatId);
      return activeSession;
    }

    async function syncActiveChatSession() {
      const nextSession = sessionByChatId(getActiveChatIdRef?.());
      return activateSession(nextSession);
    }

    async function refreshState() {
      currentState = await apiGetJson('/api/visual-dev/state');
      const sessions = Array.isArray(currentState?.sessions) ? currentState.sessions : [];
      currentState = {
        ...currentState,
        sessions: sessions.map((session) => normalizeSession(session, chatLabelForId)),
      };
      await syncActiveChatSession();
      return currentState;
    }

    function buildSessionId(chatId) {
      return `visual-dev-${Number(chatId || 0)}-${Number(nowFn?.() || Date.now())}`;
    }

    async function attachSession({
      chatId = null,
      previewUrl = '',
      previewTitle = '',
      metadata = null,
    } = {}) {
      const resolvedChatId = Number(chatId || getActiveChatIdRef?.() || 0);
      if (resolvedChatId <= 0) {
        throw new Error('Select a chat before attaching a preview');
      }
      const normalizedPreviewUrl = String(previewUrl || '').trim();
      if (!normalizedPreviewUrl) {
        throw new Error('Preview URL is required');
      }
      const response = await apiPost('/api/visual-dev/session/attach', {
        chat_id: resolvedChatId,
        session_id: buildSessionId(resolvedChatId),
        preview_url: normalizedPreviewUrl,
        preview_title: String(previewTitle || '').trim(),
        bridge_parent_origin: String(getParentOrigin?.() || visualDevConfig.allowedParentOrigins?.[0] || '').trim(),
        metadata: metadata && typeof metadata === 'object' ? metadata : {},
      });
      await refreshState();
      return response;
    }

    async function detachSession(sessionId = '') {
      const resolvedSessionId = String(sessionId || activeSession?.session_id || '').trim();
      if (!resolvedSessionId) {
        throw new Error('No preview is attached to this chat');
      }
      const response = await apiPost('/api/visual-dev/session/detach', {
        session_id: resolvedSessionId,
      });
      await refreshState();
      return response;
    }

    function requestPreviewCommand(command, payload = {}) {
      if (activePreviewController?.sendCommand) {
        activePreviewController.sendCommand(command, payload);
      }
    }

    function activeRegionSelectionPayload() {
      const rect = activeSelection?.rect;
      if (!rect || typeof rect !== 'object') {
        return { source: 'toolbar' };
      }
      return {
        source: 'toolbar',
        capture: 'region',
        selector: String(activeSelection?.selector || ''),
        label: String(activeSelection?.label || ''),
        region: {
          left: Number(rect.left || 0),
          top: Number(rect.top || 0),
          width: Number(rect.width || 0),
          height: Number(rect.height || 0),
        },
      };
    }

    async function bootstrap() {
      if (!visualDevConfig.enabled) {
        shellController.clearSessionState();
        return { ok: true, enabled: false, sessions: [] };
      }
      if (!getIsAuthenticated()) {
        shellController.clearSessionState();
        return { ok: true, enabled: true, sessions: [] };
      }
      try {
        return await refreshState();
      } catch (error) {
        onUiError(error);
        shellController.clearSessionState();
        return { ok: false, enabled: true, sessions: [], error: String(error?.message || error || '') };
      }
    }

    function setActiveChatGetter(nextGetter) {
      if (typeof nextGetter === 'function') {
        getActiveChatIdRef = nextGetter;
      }
    }

    function dispose() {
      disposePreviewController();
      shellController.clearSessionState();
    }

    return {
      bootstrap,
      refreshState,
      attachSession,
      detachSession,
      requestInspectMode: () => requestPreviewCommand('inspect-start', { source: 'toolbar' }),
      requestScreenshot: () => requestPreviewCommand('capture-full', { source: 'toolbar', capture: 'full' }),
      requestRegionScreenshot: () => requestPreviewCommand('capture-region', activeRegionSelectionPayload()),
      toggleConsoleDrawer: (forceOpen = null) => shellController.toggleConsoleDrawer(forceOpen),
      syncActiveChatSession,
      setActiveChatGetter,
      getState: () => currentState,
      getActiveContext: () => ({
        selection: activeSelection,
        screenshot: activeScreenshot,
        preview: activePreview,
        console: activeConsole,
      }),
      dispose,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappVisualDevMode = api;
})(typeof window !== 'undefined' ? window : globalThis);
