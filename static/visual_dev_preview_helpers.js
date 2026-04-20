(function initHermesMiniappVisualDevPreview(globalScope) {
  function createController(deps) {
    const {
      sessionId,
      previewOrigin,
      parentOrigin,
      previewFrame,
      windowObject = globalScope,
      onSelection = () => {},
      onScreenshot = () => {},
      onConsole = () => {},
      onRuntime = () => {},
    } = deps || {};

    let messageHandler = null;

    function postToPreview(payload) {
      previewFrame?.contentWindow?.postMessage?.(payload, previewOrigin);
    }

    function sendHandshake() {
      postToPreview({
        type: 'hermes-visual-dev:connect',
        sessionId,
        parentOrigin,
      });
    }

    function sendCommand(command, payload = {}) {
      postToPreview({
        type: 'hermes-visual-dev:command',
        sessionId,
        command,
        payload,
      });
    }

    function routeMessage(payload) {
      const type = String(payload?.type || '');
      if (type === 'hermes-visual-dev:selection') {
        onSelection(payload.selection || {});
        return;
      }
      if (type === 'hermes-visual-dev:screenshot') {
        onScreenshot(payload.screenshot || {});
        return;
      }
      if (type === 'hermes-visual-dev:console') {
        onConsole(payload.consoleEvent || {});
        return;
      }
      if (type === 'hermes-visual-dev:runtime' || type === 'hermes-visual-dev:ready') {
        onRuntime(payload.runtime || payload);
      }
    }

    function installMessageBridge() {
      if (messageHandler || !windowObject?.addEventListener) {
        return;
      }
      messageHandler = (event) => {
        if (String(event?.origin || '') !== String(previewOrigin || '')) {
          return;
        }
        const payload = event?.data || {};
        if (String(payload?.sessionId || '') !== String(sessionId || '')) {
          return;
        }
        routeMessage(payload);
      };
      windowObject.addEventListener('message', messageHandler);
    }

    function dispose() {
      if (!messageHandler || !windowObject?.removeEventListener) {
        return;
      }
      windowObject.removeEventListener('message', messageHandler);
      messageHandler = null;
    }

    return {
      sendHandshake,
      sendCommand,
      installMessageBridge,
      dispose,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappVisualDevPreview = api;
})(typeof window !== 'undefined' ? window : globalThis);
