(function initHermesMiniappVisualDevBridge(globalScope) {
  function trimText(value, limit = 120) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  }

  function selectorForElement(element) {
    if (!element || typeof element !== 'object') return '';
    const id = trimText(element.id || '', 80);
    if (id) {
      return `#${id}`;
    }
    const className = trimText(element.className || '', 80);
    const classes = className
      .split(/\s+/)
      .map((token) => token.trim())
      .filter(Boolean)
      .slice(0, 3);
    if (classes.length > 0) {
      return `${String(element.tagName || 'div').toLowerCase()}.${classes.join('.')}`;
    }
    return String(element.tagName || 'div').toLowerCase();
  }

  function rectForElement(element) {
    if (!element?.getBoundingClientRect) {
      return null;
    }
    const rect = element.getBoundingClientRect();
    return {
      left: Number(rect?.left || 0),
      top: Number(rect?.top || 0),
      width: Number(rect?.width || 0),
      height: Number(rect?.height || 0),
    };
  }

  function selectionForElement(element, payload = {}) {
    const label = trimText(element?.getAttribute?.('aria-label') || element?.textContent || element?.id || element?.tagName || 'Selection');
    return {
      label,
      selector: selectorForElement(element),
      tagName: String(element?.tagName || '').toLowerCase(),
      text: trimText(element?.textContent || ''),
      rect: rectForElement(element),
      ...(payload && typeof payload === 'object' ? payload : {}),
    };
  }

  function createController(deps) {
    const {
      windowObject = globalScope,
      documentObject = globalScope?.document,
      captureScreenshot = null,
    } = deps || {};

    let activeSessionId = '';
    let activeParentOrigin = '';
    let messageHandler = null;
    let inspectHandler = null;

    function post(type, body) {
      if (!activeSessionId || !activeParentOrigin) {
        return;
      }
      windowObject?.parent?.postMessage?.({
        type,
        sessionId: activeSessionId,
        ...body,
      }, activeParentOrigin);
    }

    function clearInspectMode() {
      if (!inspectHandler) {
        return;
      }
      documentObject?.removeEventListener?.('click', inspectHandler, true);
      inspectHandler = null;
    }

    function handleConnect(payload = {}) {
      activeSessionId = String(payload?.sessionId || '');
      activeParentOrigin = String(payload?.parentOrigin || '');
      if (documentObject?.documentElement?.dataset) {
        documentObject.documentElement.dataset.visualDevSessionId = activeSessionId;
      }
      post('hermes-visual-dev:ready', {
        previewUrl: String(windowObject?.location?.href || ''),
        previewTitle: String(documentObject?.title || ''),
      });
    }

    function reportSelection(selection = {}) {
      post('hermes-visual-dev:selection', {
        selection,
      });
    }

    function reportConsole(consoleEvent = {}) {
      post('hermes-visual-dev:console', {
        consoleEvent,
      });
    }

    function reportScreenshot(screenshot = {}) {
      post('hermes-visual-dev:screenshot', {
        screenshot,
      });
    }

    function startInspectMode(payload = {}) {
      clearInspectMode();
      inspectHandler = (event) => {
        event?.preventDefault?.();
        event?.stopPropagation?.();
        const target = event?.target?.closest ? event.target.closest('*') : event?.target;
        if (!target) {
          return;
        }
        reportSelection(selectionForElement(target, payload));
        clearInspectMode();
      };
      documentObject?.addEventListener?.('click', inspectHandler, true);
    }

    async function runScreenshotCommand(payload = {}) {
      if (typeof captureScreenshot !== 'function') {
        reportConsole({
          level: 'warn',
          message: 'Preview screenshot hook unavailable',
          source: payload?.source || 'toolbar',
        });
        return;
      }
      const result = await captureScreenshot(payload);
      if (!result || typeof result !== 'object') {
        return;
      }
      reportScreenshot({
        ...result,
        ...(payload && typeof payload === 'object' ? payload : {}),
      });
    }

    async function handleCommand(command, payload = {}) {
      const normalizedCommand = String(command || '');
      if (normalizedCommand === 'inspect-start' || normalizedCommand === 'start-inspect') {
        startInspectMode(payload);
        return;
      }
      if (
        normalizedCommand === 'capture-screenshot'
        || normalizedCommand === 'capture-full'
        || normalizedCommand === 'capture-region'
      ) {
        const normalizedPayload = payload && typeof payload === 'object' ? { ...payload } : {};
        if (!normalizedPayload.capture) {
          normalizedPayload.capture = normalizedCommand === 'capture-region' ? 'region' : 'full';
        }
        await runScreenshotCommand(normalizedPayload);
      }
    }

    function install() {
      if (messageHandler || !windowObject?.addEventListener) {
        return;
      }
      messageHandler = async (event) => {
        const payload = event?.data || {};
        const type = String(payload?.type || '');
        if (type === 'hermes-visual-dev:connect') {
          handleConnect({
            sessionId: payload.sessionId,
            parentOrigin: event?.origin || payload.parentOrigin,
          });
          return;
        }
        if (type !== 'hermes-visual-dev:command') {
          return;
        }
        if (String(event?.origin || '') !== String(activeParentOrigin || '')) {
          return;
        }
        if (String(payload?.sessionId || '') !== String(activeSessionId || '')) {
          return;
        }
        await handleCommand(payload.command, payload.payload || {});
      };
      windowObject.addEventListener('message', messageHandler);
    }

    function dispose() {
      clearInspectMode();
      if (!messageHandler || !windowObject?.removeEventListener) {
        return;
      }
      windowObject.removeEventListener('message', messageHandler);
      messageHandler = null;
    }

    return {
      install,
      dispose,
      handleConnect,
      reportSelection,
      reportConsole,
      reportScreenshot,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappVisualDevBridge = api;
})(typeof window !== 'undefined' ? window : globalThis);
