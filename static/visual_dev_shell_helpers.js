(function initHermesMiniappVisualDevShell(globalScope) {
  function setDataAttribute(element, name, value) {
    if (!element) return;
    element.setAttribute(name, String(value));
  }

  function setText(element, value) {
    if (!element) return;
    element.textContent = String(value || '');
  }

  function getDataAttribute(element, name) {
    if (!element) return '';
    if (typeof element.getAttribute === 'function') {
      return String(element.getAttribute(name) || '');
    }
    if (element.attributes?.get) {
      return String(element.attributes.get(name) || '');
    }
    return '';
  }

  function setHidden(element, hidden) {
    if (!element) return;
    element.hidden = Boolean(hidden);
  }

  function consoleLine(event = {}) {
    const level = String(event?.level || 'info').trim().toUpperCase() || 'INFO';
    const message = String(event?.message || '').trim() || 'No message';
    return `${level}: ${message}`;
  }

  function runtimeSummaryText(runtime = {}) {
    const state = String(runtime?.state || 'idle').trim() || 'idle';
    const message = String(runtime?.message || '').trim();
    return message ? `Runtime: ${state} — ${message}` : `Runtime: ${state}`;
  }

  function severityRank(level = 'info') {
    const normalized = String(level || 'info').trim().toLowerCase();
    if (normalized === 'error') return 3;
    if (normalized === 'warn' || normalized === 'warning') return 2;
    return 1;
  }

  function consoleSeverity(events = []) {
    if (!Array.isArray(events) || !events.length) return 'info';
    let strongest = 'info';
    events.forEach((event) => {
      const level = String(event?.level || 'info').trim().toLowerCase() || 'info';
      if (severityRank(level) > severityRank(strongest)) {
        strongest = level;
      }
    });
    return strongest;
  }

  function shouldAutoOpenDrawer(runtime = {}, events = []) {
    const state = String(runtime?.state || '').trim().toLowerCase();
    if (state === 'build_failed' || state === 'runtime_error' || state === 'restart_required') {
      return true;
    }
    return consoleSeverity(events) === 'error';
  }

  function createController(deps) {
    const {
      shellRoot,
      previewFrame,
      ownershipLabel,
      statusLabel,
      selectionChip,
      screenshotChip,
      composerSelectionChip,
      composerScreenshotChip,
      composerPreviewChip,
      composerConsoleChip,
      consoleDrawer,
      runtimeSummary,
      consoleList,
      initialEnabled = false,
    } = deps || {};

    function setEnabled(enabled) {
      setDataAttribute(shellRoot, 'data-visual-dev-enabled', enabled ? 'true' : 'false');
    }

    function toggleConsoleDrawer(forceOpen = null) {
      const open = forceOpen == null
        ? String(consoleDrawer?.getAttribute?.('data-open') || 'false') !== 'true'
        : Boolean(forceOpen);
      if (consoleDrawer) {
        consoleDrawer.hidden = !open;
        setDataAttribute(consoleDrawer, 'data-open', open ? 'true' : 'false');
      }
      return open;
    }

    function applyRuntimeSummary(runtime = {}) {
      const state = String(runtime?.state || 'idle');
      setText(statusLabel, state);
      setText(runtimeSummary, runtimeSummaryText(runtime));
      setDataAttribute(consoleDrawer, 'data-runtime-state', state.toLowerCase());
    }

    function applySessionState(session = {}) {
      const runtimeState = session?.runtime || { state: String(session?.state || 'idle') };
      setEnabled(Boolean(session?.enabled));
      if (previewFrame) {
        previewFrame.src = String(session?.previewUrl || session?.preview_url || 'about:blank') || 'about:blank';
      }
      setText(ownershipLabel, session?.chatLabel || session?.chat_label || 'No preview attached');
      if (ownershipLabel && session?.chatId != null) {
        setDataAttribute(ownershipLabel, 'data-chat-id', session.chatId);
      }
      applyRuntimeSummary(runtimeState);
      applyPreviewSummary(session);
    }

    function applySelectionSummary(selection = {}) {
      const label = String(selection?.label || selection?.selector || selection?.selectionType || selection?.selection_type || 'none');
      const hasSelection = label !== 'none';
      setText(selectionChip, `Selected: ${label}`);
      setText(composerSelectionChip, `UI context: ${label}`);
      setHidden(composerSelectionChip, !hasSelection);
    }

    function applyScreenshotSummary(screenshot = {}) {
      const label = String(screenshot?.label || screenshot?.artifact_path || screenshot?.artifactPath || screenshot?.storage_path || 'none');
      const hasScreenshot = label !== 'none';
      setText(screenshotChip, `Screenshot: ${label}`);
      setText(composerScreenshotChip, `Screenshot context: ${label}`);
      setHidden(composerScreenshotChip, !hasScreenshot);
    }

    function applyPreviewSummary(session = {}) {
      const label = String(session?.preview_title || session?.previewTitle || session?.preview_url || session?.previewUrl || 'none');
      const hasPreview = label !== 'none';
      setText(composerPreviewChip, `Preview URL: ${label}`);
      setHidden(composerPreviewChip, !hasPreview);
    }

    function applyConsoleSummary(runtime = {}, events = []) {
      const state = String(runtime?.state || '').trim();
      const runtimeMessage = String(runtime?.message || '').trim();
      const latestEvent = Array.isArray(events) && events.length ? events[0] : null;
      const latestLevel = String(latestEvent?.level || '').trim();
      const latestMessage = String(latestEvent?.message || '').trim();
      const label = runtimeMessage || latestMessage || state || latestLevel || 'none';
      const prefix = state || latestLevel || 'Console';
      const hasConsole = label !== 'none';
      setText(composerConsoleChip, `${prefix}: ${label}`);
      setHidden(composerConsoleChip, !hasConsole);
    }

    function setConsoleEvents(events = []) {
      const lines = Array.isArray(events) ? events.map((event) => consoleLine(event)) : [];
      setText(consoleList, lines.length ? lines.join('\n') : 'No console events yet.');
      setDataAttribute(consoleDrawer, 'data-severity', consoleSeverity(events));
    }

    function appendConsoleEvent(event = {}) {
      const existing = String(consoleList?.textContent || '').trim();
      const line = consoleLine(event);
      const nextText = !existing || existing === 'No console events yet.' ? line : `${line}\n${existing}`;
      setText(consoleList, nextText);
      const nextSeverity = consoleSeverity([{ level: event?.level }, { level: getDataAttribute(consoleDrawer, 'data-severity') || 'info' }]);
      setDataAttribute(consoleDrawer, 'data-severity', nextSeverity);
      applyConsoleSummary(
        { state: getDataAttribute(consoleDrawer, 'data-runtime-state') || '' },
        [{ level: event?.level, message: event?.message }],
      );
      if (nextSeverity === 'error') {
        toggleConsoleDrawer(true);
      }
    }

    function applySessionDetails(details = {}) {
      const runtime = details?.session?.runtime || {};
      if (details?.session?.runtime) {
        applyRuntimeSummary(runtime);
      }
      if (details?.latest_selection?.payload) {
        applySelectionSummary(details.latest_selection.payload);
      }
      if (Array.isArray(details?.artifacts) && details.artifacts[0]) {
        applyScreenshotSummary(details.artifacts[0]);
      }
      const events = details?.console_events || [];
      setConsoleEvents(events);
      applyConsoleSummary(runtime, events);
      if (shouldAutoOpenDrawer(runtime, events)) {
        toggleConsoleDrawer(true);
      }
    }

    function clearSessionState() {
      setEnabled(false);
      if (previewFrame) {
        previewFrame.src = 'about:blank';
      }
      setText(ownershipLabel, 'No preview attached');
      applyRuntimeSummary({ state: 'idle' });
      setText(selectionChip, 'Selected: none');
      setText(screenshotChip, 'Screenshot: none');
      setText(composerSelectionChip, 'UI context: none');
      setText(composerScreenshotChip, 'Screenshot context: none');
      setText(composerPreviewChip, 'Preview URL: none');
      setText(composerConsoleChip, 'Console: none');
      setHidden(composerSelectionChip, true);
      setHidden(composerScreenshotChip, true);
      setHidden(composerPreviewChip, true);
      setHidden(composerConsoleChip, true);
      setConsoleEvents([]);
      toggleConsoleDrawer(false);
      setDataAttribute(consoleDrawer, 'data-runtime-state', 'idle');
    }

    if (initialEnabled) {
      setEnabled(true);
      applyRuntimeSummary({ state: 'idle' });
      setConsoleEvents([]);
      toggleConsoleDrawer(false);
    } else {
      clearSessionState();
    }

    return {
      setEnabled,
      toggleConsoleDrawer,
      applySessionState,
      applySelectionSummary,
      applyScreenshotSummary,
      applyPreviewSummary,
      applyConsoleSummary,
      applyRuntimeSummary,
      applySessionDetails,
      appendConsoleEvent,
      clearSessionState,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappVisualDevShell = api;
})(typeof window !== 'undefined' ? window : globalThis);
