(function initHermesMiniappVisualDevShell(globalScope) {
  const PREVIEW_SIZE_STORAGE_KEY = 'hermes.visualDev.previewSize.v1';
  const SIDEBAR_SIZE_STORAGE_KEY = 'hermes.visualDev.sidebarWidth.v1';
  const DESKTOP_MEDIA_QUERY = '(min-width: 861px)';
  const SIDEBAR_DEFAULT_WIDTH = 380;
  const SIDEBAR_MIN_WIDTH = 320;
  const SIDEBAR_MAX_WIDTH = 1400;
  const SIDEBAR_RESIZE_TRACK_WIDTH = 12;
  const WORKSPACE_MIN_WIDTH_DURING_SIDEBAR_RESIZE = 96;
  const PREVIEW_MIN_WIDTH = 420;
  const PREVIEW_MIN_HEIGHT = 480;
  const PREVIEW_VIEWPORT_MARGIN = 24;
  const PREVIEW_CACHE_LIMIT = 3;

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

  function clampNumber(value, min, max) {
    if (!Number.isFinite(value)) return null;
    if (Number.isFinite(min) && value < min) return min;
    if (Number.isFinite(max) && value > max) return max;
    return value;
  }

  function parseStoredPreviewSize(rawValue) {
    if (!rawValue) return { width: null, height: null };
    try {
      const parsed = JSON.parse(String(rawValue));
      const width = Number(parsed?.width || 0) || null;
      const height = Number(parsed?.height || 0) || null;
      return { width, height };
    } catch (_error) {
      return { width: null, height: null };
    }
  }

  function parseStoredSidebarSize(rawValue) {
    if (!rawValue) return { width: null };
    try {
      const parsed = JSON.parse(String(rawValue));
      const width = Number(parsed?.width || 0) || null;
      return { width };
    } catch (_error) {
      return { width: null };
    }
  }

  function isDesktopViewport(windowObject) {
    if (!windowObject) return false;
    if (typeof windowObject.matchMedia === 'function') {
      try {
        return Boolean(windowObject.matchMedia(DESKTOP_MEDIA_QUERY)?.matches);
      } catch (_error) {
        // Fall through to innerWidth.
      }
    }
    return Number(windowObject.innerWidth || 0) >= 861;
  }

  function createController(deps) {
    const {
      appShell,
      workspaceRoot,
      shellRoot,
      toggleButton,
      sidebarResizeHandle,
      previewFrame,
      previewWrap,
      previewResizeHandle,
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
      onWorkspaceOpenChange,
      documentObject = typeof document !== 'undefined' ? document : null,
      windowObject = typeof window !== 'undefined' ? window : null,
      localStorageRef = null,
      initialEnabled = false,
    } = deps || {};

    const featureEnabled = Boolean(initialEnabled);
    let workspaceOpen = false;
    let sidebarSize = { width: null };
    let previewSize = { width: null, height: null };
    let activeSidebarResizePointerId = null;
    let pendingSidebarResizeWidth = null;
    let sidebarResizeFrameId = null;
    let sidebarResizeOriginLeft = 0;
    let sidebarResizeActiveMaxWidth = null;
    let sidebarResizePreviewRight = null;
    let sidebarResizePreviewHeight = null;
    let activeResizePointerId = null;
    const cachedPreviewFrames = new Map();
    let previewFrameLru = [];
    let activePreviewSessionId = '';

    function normalizeUrlForComparison(value) {
      const candidate = String(value || '').trim();
      if (!candidate) return '';
      if (typeof URL === 'function') {
        try {
          return new URL(candidate, String(windowObject?.location?.href || 'https://example.invalid')).toString();
        } catch {
          return candidate;
        }
      }
      return candidate;
    }

    function syncPreviewFrameElementSrc(frame, nextValue) {
      if (!frame) return;
      const nextSrc = String(nextValue || 'about:blank') || 'about:blank';
      const currentSrc = normalizeUrlForComparison(frame.src || frame.getAttribute?.('src') || '');
      const normalizedNextSrc = normalizeUrlForComparison(nextSrc);
      if (normalizedNextSrc && currentSrc === normalizedNextSrc) {
        return;
      }
      frame.src = nextSrc;
    }

    function syncPreviewFrameSrc(nextValue) {
      syncPreviewFrameElementSrc(previewFrame, nextValue);
    }

    function allManagedFrames() {
      return [previewFrame, ...Array.from(cachedPreviewFrames.values()).map((entry) => entry.frame)].filter(Boolean);
    }

    function syncManagedFrameVisibility(activeFrame = null) {
      const resolvedActiveFrame = activeFrame || null;
      allManagedFrames().forEach((frame) => {
        const isActive = Boolean(resolvedActiveFrame) && frame === resolvedActiveFrame;
        setHidden(frame, !isActive);
        setDataAttribute(frame, 'data-preview-active', isActive ? 'true' : 'false');
      });
      if (!resolvedActiveFrame && previewFrame) {
        setHidden(previewFrame, false);
        setDataAttribute(previewFrame, 'data-preview-active', 'true');
      }
    }

    function applySizeStylesToFrame(frame) {
      if (!frame?.style) return;
      frame.style.height = previewSize.height ? `${previewSize.height}px` : '';
      frame.style.minHeight = previewSize.height ? `${previewSize.height}px` : '';
    }

    function readStoredPreviewSize() {
      if (!localStorageRef?.getItem || !isDesktopViewport(windowObject)) {
        return { width: null, height: null };
      }
      return parseStoredPreviewSize(localStorageRef.getItem(PREVIEW_SIZE_STORAGE_KEY));
    }

    function persistPreviewSize(nextSize) {
      if (!localStorageRef?.setItem) return;
      if (!nextSize?.width && !nextSize?.height) {
        localStorageRef.removeItem?.(PREVIEW_SIZE_STORAGE_KEY);
        return;
      }
      localStorageRef.setItem(PREVIEW_SIZE_STORAGE_KEY, JSON.stringify({
        width: nextSize?.width ?? null,
        height: nextSize?.height ?? null,
      }));
    }

    function readStoredSidebarSize() {
      if (!localStorageRef?.getItem || !isDesktopViewport(windowObject)) {
        return { width: null };
      }
      return parseStoredSidebarSize(localStorageRef.getItem(SIDEBAR_SIZE_STORAGE_KEY));
    }

    function persistSidebarSize(nextSize) {
      if (!localStorageRef?.setItem) return;
      if (!nextSize?.width) {
        localStorageRef.removeItem?.(SIDEBAR_SIZE_STORAGE_KEY);
        return;
      }
      localStorageRef.setItem(SIDEBAR_SIZE_STORAGE_KEY, JSON.stringify({
        width: nextSize?.width ?? null,
      }));
    }

    function sidebarBounds() {
      const workspaceWidth = Number(workspaceRoot?.getBoundingClientRect?.()?.width || 0);
      if (!Number.isFinite(workspaceWidth) || workspaceWidth <= 0) {
        return { maxWidth: SIDEBAR_MAX_WIDTH };
      }
      const layoutMaxWidth = workspaceWidth - SIDEBAR_RESIZE_TRACK_WIDTH - WORKSPACE_MIN_WIDTH_DURING_SIDEBAR_RESIZE;
      return { maxWidth: Math.max(SIDEBAR_MIN_WIDTH, Math.min(SIDEBAR_MAX_WIDTH, layoutMaxWidth)) };
    }

    function clearSidebarSizeStyles() {
      sidebarSize = { width: null };
      workspaceRoot?.style?.removeProperty?.('--workspace-sidebar-width');
    }

    function setSidebarResizeActive(active) {
      const value = active ? 'true' : 'false';
      setDataAttribute(appShell, 'data-sidebar-resizing', value);
      setDataAttribute(workspaceRoot, 'data-sidebar-resizing', value);
      setDataAttribute(shellRoot, 'data-sidebar-resizing', value);
      setDataAttribute(sidebarResizeHandle, 'data-dragging', value);
    }

    function applySidebarSize(nextSize = {}, { persist = true, maxWidthOverride = null } = {}) {
      if (!isDesktopViewport(windowObject)) {
        clearSidebarSizeStyles();
        if (persist) {
          localStorageRef?.removeItem?.(SIDEBAR_SIZE_STORAGE_KEY);
        }
        return sidebarSize;
      }
      const maxWidth = Number.isFinite(maxWidthOverride) ? maxWidthOverride : sidebarBounds().maxWidth;
      const width = clampNumber(Number(nextSize?.width || 0) || null, SIDEBAR_MIN_WIDTH, maxWidth);
      sidebarSize = { width };
      if (width) {
        workspaceRoot?.style?.setProperty?.('--workspace-sidebar-width', `${width}px`);
      } else {
        workspaceRoot?.style?.removeProperty?.('--workspace-sidebar-width');
      }
      if (persist) {
        persistSidebarSize(sidebarSize);
      }
      return sidebarSize;
    }

    function previewBounds() {
      const rect = previewWrap?.getBoundingClientRect?.() || { left: 0, top: 0 };
      const viewportWidth = Math.max(0, Number(windowObject?.innerWidth || 0));
      const viewportHeight = Math.max(0, Number(windowObject?.innerHeight || 0));
      const maxWidth = Math.max(PREVIEW_MIN_WIDTH, viewportWidth - Number(rect.left || 0) - PREVIEW_VIEWPORT_MARGIN);
      const maxHeight = Math.max(PREVIEW_MIN_HEIGHT, viewportHeight - Number(rect.top || 0) - PREVIEW_VIEWPORT_MARGIN);
      return { maxWidth, maxHeight };
    }

    function clearPreviewSizeStyles() {
      if (previewWrap?.style) {
        previewWrap.style.width = '';
        previewWrap.style.minHeight = '';
      }
      allManagedFrames().forEach((frame) => {
        if (frame?.style) {
          frame.style.height = '';
          frame.style.minHeight = '';
        }
      });
    }

    function applyPreviewSize(nextSize = {}, { persist = true, minWidthOverride = null } = {}) {
      if (!isDesktopViewport(windowObject)) {
        previewSize = { width: null, height: null };
        clearPreviewSizeStyles();
        if (persist) {
          localStorageRef?.removeItem?.(PREVIEW_SIZE_STORAGE_KEY);
        }
        return previewSize;
      }
      const { maxWidth, maxHeight } = previewBounds();
      const minWidth = Number.isFinite(minWidthOverride) ? minWidthOverride : PREVIEW_MIN_WIDTH;
      const width = clampNumber(Number(nextSize?.width || 0) || null, minWidth, maxWidth);
      const height = clampNumber(Number(nextSize?.height || 0) || null, PREVIEW_MIN_HEIGHT, maxHeight);
      previewSize = { width, height };
      if (previewWrap?.style) {
        previewWrap.style.width = width ? `${width}px` : '';
        previewWrap.style.minHeight = height ? `${height}px` : '';
      }
      allManagedFrames().forEach(applySizeStylesToFrame);
      if (persist) {
        persistPreviewSize(previewSize);
      }
      return previewSize;
    }

    function syncResizeHandleVisibility() {
      if (!previewResizeHandle) return;
      previewResizeHandle.hidden = !featureEnabled || !isDesktopViewport(windowObject);
      setDataAttribute(previewResizeHandle, 'data-enabled', previewResizeHandle.hidden ? 'false' : 'true');
    }

    function syncSidebarResizeHandleVisibility() {
      if (!sidebarResizeHandle) return;
      const visible = featureEnabled && workspaceOpen && isDesktopViewport(windowObject);
      sidebarResizeHandle.hidden = !visible;
      setDataAttribute(sidebarResizeHandle, 'data-enabled', visible ? 'true' : 'false');
    }

    function syncWorkspaceVisibility() {
      const visible = featureEnabled && workspaceOpen;
      if (!visible) {
        stopSidebarResize();
      }
      setDataAttribute(appShell, 'data-workspace-open', visible ? 'true' : 'false');
      setDataAttribute(workspaceRoot, 'data-workspace-open', visible ? 'true' : 'false');
      setDataAttribute(shellRoot, 'data-workspace-open', visible ? 'true' : 'false');
      setHidden(shellRoot, !visible);
      syncResizeHandleVisibility();
      syncSidebarResizeHandleVisibility();
      if (toggleButton) {
        toggleButton.hidden = !featureEnabled;
        toggleButton.textContent = 'Workspace';
        toggleButton.setAttribute('aria-pressed', visible ? 'true' : 'false');
        toggleButton.setAttribute('title', visible ? 'Close workspace' : 'Open workspace');
      }
    }

    function setEnabled(enabled) {
      const sessionEnabled = Boolean(enabled);
      setDataAttribute(shellRoot, 'data-visual-dev-enabled', sessionEnabled ? 'true' : 'false');
      syncWorkspaceVisibility();
    }

    function toggleWorkspace(forceOpen = null) {
      if (!featureEnabled) {
        workspaceOpen = false;
        syncWorkspaceVisibility();
        return workspaceOpen;
      }
      workspaceOpen = forceOpen == null ? !workspaceOpen : Boolean(forceOpen);
      syncWorkspaceVisibility();
      onWorkspaceOpenChange?.(workspaceOpen);
      return workspaceOpen;
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

    function touchPreviewSession(sessionId = '') {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) return;
      previewFrameLru = previewFrameLru.filter((entry) => entry !== normalizedSessionId);
      previewFrameLru.push(normalizedSessionId);
    }

    function removePreviewFrameElement(frame) {
      if (!frame) return;
      const parent = frame.parentNode;
      if (parent && typeof parent.removeChild === 'function') {
        parent.removeChild(frame);
      } else if (typeof frame.remove === 'function') {
        frame.remove();
      }
    }

    function createCachedPreviewFrame(sessionId) {
      if (!documentObject?.createElement) {
        return null;
      }
      const frame = documentObject.createElement('iframe');
      frame.className = previewFrame?.className || 'visual-dev-workspace__preview';
      frame.hidden = true;
      frame.title = previewFrame?.title || 'Visual dev preview';
      frame.loading = previewFrame?.loading || 'lazy';
      frame.referrerPolicy = previewFrame?.referrerPolicy || previewFrame?.referrerpolicy || 'strict-origin-when-cross-origin';
      if (typeof frame.setAttribute === 'function') {
        frame.setAttribute('title', frame.title);
        frame.setAttribute('loading', frame.loading);
        frame.setAttribute('referrerpolicy', frame.referrerPolicy);
        frame.setAttribute('data-preview-session-id', String(sessionId || ''));
      }
      applySizeStylesToFrame(frame);
      if (previewWrap?.insertBefore) {
        previewWrap.insertBefore(frame, previewResizeHandle || null);
      } else if (previewWrap?.appendChild) {
        previewWrap.appendChild(frame);
      }
      return frame;
    }

    function evictPreviewFrames(excludedSessionId = '') {
      while (previewFrameLru.length > PREVIEW_CACHE_LIMIT) {
        const candidateSessionId = previewFrameLru[0];
        if (!candidateSessionId || candidateSessionId === String(excludedSessionId || '') || candidateSessionId === String(activePreviewSessionId || '')) {
          previewFrameLru = previewFrameLru.filter((entry, index) => index !== 0 || entry === String(excludedSessionId || '') || entry === String(activePreviewSessionId || ''));
          if (previewFrameLru.length <= PREVIEW_CACHE_LIMIT) {
            break;
          }
          const removable = previewFrameLru.find((entry) => entry !== String(excludedSessionId || '') && entry !== String(activePreviewSessionId || ''));
          if (!removable) {
            break;
          }
          invalidateSessionPreview(removable);
          continue;
        }
        invalidateSessionPreview(candidateSessionId);
      }
    }

    function activateSessionPreview(session = {}) {
      const sessionId = String(session?.session_id || session?.sessionId || '').trim();
      const previewUrl = String(
        session?.previewFrameUrl
        || session?.preview_frame_url
        || session?.previewUrl
        || session?.preview_url
        || 'about:blank'
      ) || 'about:blank';
      if (!sessionId) {
        activePreviewSessionId = '';
        syncPreviewFrameSrc('about:blank');
        syncManagedFrameVisibility(previewFrame);
        return previewFrame;
      }
      let cachedEntry = cachedPreviewFrames.get(sessionId) || null;
      if (!cachedEntry) {
        const frame = createCachedPreviewFrame(sessionId);
        if (frame) {
          cachedEntry = { frame, sessionId };
          cachedPreviewFrames.set(sessionId, cachedEntry);
        }
      }
      const activeFrame = cachedEntry?.frame || previewFrame;
      syncPreviewFrameElementSrc(activeFrame, previewUrl);
      activePreviewSessionId = sessionId;
      syncManagedFrameVisibility(activeFrame);
      touchPreviewSession(sessionId);
      evictPreviewFrames(sessionId);
      return activeFrame;
    }

    function getActivePreviewFrame() {
      if (activePreviewSessionId && cachedPreviewFrames.has(activePreviewSessionId)) {
        return cachedPreviewFrames.get(activePreviewSessionId).frame;
      }
      return previewFrame;
    }

    function getActivePreviewRegion() {
      const frame = getActivePreviewFrame();
      const rect = frame?.getBoundingClientRect?.();
      if (!rect) {
        return null;
      }
      const width = Number(rect.width || 0);
      const height = Number(rect.height || 0);
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
        return null;
      }
      return {
        left: Math.max(0, Math.round(Number(rect.left || 0))),
        top: Math.max(0, Math.round(Number(rect.top || 0))),
        width: Math.max(1, Math.round(width)),
        height: Math.max(1, Math.round(height)),
      };
    }

    function invalidateSessionPreview(sessionId = '') {
      const normalizedSessionId = String(sessionId || '').trim();
      if (!normalizedSessionId) return;
      const cachedEntry = cachedPreviewFrames.get(normalizedSessionId);
      if (!cachedEntry) {
        previewFrameLru = previewFrameLru.filter((entry) => entry !== normalizedSessionId);
        return;
      }
      removePreviewFrameElement(cachedEntry.frame);
      cachedPreviewFrames.delete(normalizedSessionId);
      previewFrameLru = previewFrameLru.filter((entry) => entry !== normalizedSessionId);
      if (activePreviewSessionId === normalizedSessionId) {
        activePreviewSessionId = '';
        syncPreviewFrameSrc('about:blank');
        syncManagedFrameVisibility(previewFrame);
      }
    }

    function applySessionState(session = {}) {
      const runtimeState = session?.runtime || { state: String(session?.state || 'idle') };
      setEnabled(Boolean(session?.enabled));
      activateSessionPreview(session);
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

    function compactScreenshotBasename(basename = '') {
      const normalized = String(basename || '').trim();
      const match = normalized.match(/^screenshot-\d+-([a-f0-9]{6,12})\.(png|jpe?g|webp)$/i);
      if (match) {
        return `screenshot ${match[1]}`;
      }
      if (normalized.length > 28) {
        return `${normalized.slice(0, 12)}…${normalized.slice(-10)}`;
      }
      return normalized;
    }

    function screenshotSummaryLabel(screenshot = {}) {
      const metadataLabel = String(screenshot?.label || screenshot?.metadata?.label || '').trim();
      const storagePath = String(screenshot?.storage_path || screenshot?.artifact_path || screenshot?.artifactPath || '').trim();
      const basename = storagePath ? storagePath.split(/[\\/]/).filter(Boolean).pop() || '' : '';
      const compactName = compactScreenshotBasename(basename);
      if (metadataLabel && compactName) {
        return `${metadataLabel} • ${compactName}`;
      }
      return metadataLabel || compactName || 'none';
    }

    function applyScreenshotSummary(screenshot = {}) {
      const label = screenshotSummaryLabel(screenshot);
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

    function clearSessionState(options = {}) {
      const enabled = Boolean(options?.enabled);
      setEnabled(enabled);
      activePreviewSessionId = '';
      syncPreviewFrameSrc('about:blank');
      syncManagedFrameVisibility(previewFrame);
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

    function adjustPreviewForAnchoredSidebarResize({ persist = false } = {}) {
      if (!Number.isFinite(sidebarResizePreviewRight)) {
        return previewSize;
      }
      const rect = previewWrap?.getBoundingClientRect?.() || {};
      const left = Number(rect.left || 0);
      if (!Number.isFinite(left)) {
        return previewSize;
      }
      const width = sidebarResizePreviewRight - left;
      if (!Number.isFinite(width)) {
        return previewSize;
      }
      return applyPreviewSize({
        width,
        height: sidebarResizePreviewHeight || previewSize.height || Number(rect.height || 0) || null,
      }, { persist, minWidthOverride: WORKSPACE_MIN_WIDTH_DURING_SIDEBAR_RESIZE });
    }

    function flushPendingSidebarResize({ persist = false } = {}) {
      const width = pendingSidebarResizeWidth;
      pendingSidebarResizeWidth = null;
      if (!Number.isFinite(width)) {
        return sidebarSize;
      }
      const nextSidebarSize = applySidebarSize({ width }, { persist, maxWidthOverride: sidebarResizeActiveMaxWidth });
      adjustPreviewForAnchoredSidebarResize({ persist });
      return nextSidebarSize;
    }

    function cancelScheduledSidebarResize() {
      if (sidebarResizeFrameId == null) {
        return;
      }
      windowObject?.cancelAnimationFrame?.(sidebarResizeFrameId);
      sidebarResizeFrameId = null;
    }

    function scheduleSidebarResizeFlush() {
      if (sidebarResizeFrameId != null) {
        return;
      }
      const requestFrame = windowObject?.requestAnimationFrame;
      if (typeof requestFrame === 'function') {
        sidebarResizeFrameId = requestFrame(() => {
          sidebarResizeFrameId = null;
          flushPendingSidebarResize({ persist: false });
        });
        return;
      }
      flushPendingSidebarResize({ persist: false });
    }

    function handleSidebarPointerMove(event = {}) {
      if (activeSidebarResizePointerId == null || Number(event?.pointerId) !== Number(activeSidebarResizePointerId)) {
        return;
      }
      event.preventDefault?.();
      pendingSidebarResizeWidth = Number(event?.clientX || 0) - Number(sidebarResizeOriginLeft || 0);
      scheduleSidebarResizeFlush();
    }

    function stopSidebarResize(event = {}) {
      if (activeSidebarResizePointerId == null) {
        setSidebarResizeActive(false);
        sidebarResizeActiveMaxWidth = null;
        sidebarResizePreviewRight = null;
        sidebarResizePreviewHeight = null;
        return;
      }
      if (event?.pointerId != null && Number(event.pointerId) !== Number(activeSidebarResizePointerId)) {
        return;
      }
      const pointerId = activeSidebarResizePointerId;
      activeSidebarResizePointerId = null;
      cancelScheduledSidebarResize();
      if (Number.isFinite(pendingSidebarResizeWidth)) {
        flushPendingSidebarResize({ persist: true });
      } else {
        persistSidebarSize(sidebarSize);
        if (Number.isFinite(sidebarResizePreviewRight)) {
          persistPreviewSize(previewSize);
        }
      }
      sidebarResizeOriginLeft = 0;
      sidebarResizeActiveMaxWidth = null;
      sidebarResizePreviewRight = null;
      sidebarResizePreviewHeight = null;
      setSidebarResizeActive(false);
      sidebarResizeHandle?.releasePointerCapture?.(pointerId);
      documentObject?.removeEventListener?.('pointermove', handleSidebarPointerMove);
      documentObject?.removeEventListener?.('pointerup', stopSidebarResize);
      documentObject?.removeEventListener?.('pointercancel', stopSidebarResize);
      sidebarResizeHandle?.removeEventListener?.('lostpointercapture', stopSidebarResize);
    }

    function startSidebarResize(event = {}) {
      if (!featureEnabled || !workspaceOpen || !isDesktopViewport(windowObject)) {
        return;
      }
      stopSidebarResize();
      activeSidebarResizePointerId = Number(event?.pointerId || 0) || 1;
      sidebarResizeOriginLeft = Number(workspaceRoot?.getBoundingClientRect?.()?.left || 0);
      sidebarResizeActiveMaxWidth = sidebarBounds().maxWidth;
      const previewRect = previewWrap?.getBoundingClientRect?.() || {};
      sidebarResizePreviewRight = Number(previewRect.right || 0) || null;
      sidebarResizePreviewHeight = previewSize.height || Number(previewRect.height || 0) || null;
      pendingSidebarResizeWidth = null;
      event.preventDefault?.();
      setSidebarResizeActive(true);
      sidebarResizeHandle?.setPointerCapture?.(activeSidebarResizePointerId);
      documentObject?.addEventListener?.('pointermove', handleSidebarPointerMove);
      documentObject?.addEventListener?.('pointerup', stopSidebarResize);
      documentObject?.addEventListener?.('pointercancel', stopSidebarResize);
      sidebarResizeHandle?.addEventListener?.('lostpointercapture', stopSidebarResize);
    }

    function handlePointerMove(event = {}) {
      if (activeResizePointerId == null || Number(event?.pointerId) !== Number(activeResizePointerId)) {
        return;
      }
      event.preventDefault?.();
      applyPreviewSize({
        width: Number(event?.clientX || 0) - Number(previewWrap?.getBoundingClientRect?.().left || 0),
        height: Number(event?.clientY || 0) - Number(previewWrap?.getBoundingClientRect?.().top || 0),
      });
    }

    function stopResize(event = {}) {
      if (activeResizePointerId == null) {
        return;
      }
      if (event?.pointerId != null && Number(event.pointerId) !== Number(activeResizePointerId)) {
        return;
      }
      activeResizePointerId = null;
      documentObject?.removeEventListener?.('pointermove', handlePointerMove);
      documentObject?.removeEventListener?.('pointerup', stopResize);
      documentObject?.removeEventListener?.('pointercancel', stopResize);
    }

    function startResize(event = {}) {
      if (!featureEnabled || !isDesktopViewport(windowObject)) {
        return;
      }
      activeResizePointerId = Number(event?.pointerId || 0) || 1;
      event.preventDefault?.();
      documentObject?.addEventListener?.('pointermove', handlePointerMove);
      documentObject?.addEventListener?.('pointerup', stopResize);
      documentObject?.addEventListener?.('pointercancel', stopResize);
    }

    function syncViewportResizeState() {
      syncResizeHandleVisibility();
      syncSidebarResizeHandleVisibility();
      if (isDesktopViewport(windowObject)) {
        const storedSidebarSize = sidebarSize.width ? sidebarSize : readStoredSidebarSize();
        if (storedSidebarSize.width) {
          applySidebarSize(storedSidebarSize, { persist: false });
        }
        const storedSize = previewSize.width || previewSize.height ? previewSize : readStoredPreviewSize();
        if (storedSize.width || storedSize.height) {
          applyPreviewSize(storedSize, { persist: false });
        }
      } else {
        clearSidebarSizeStyles();
        previewSize = { width: null, height: null };
        clearPreviewSizeStyles();
      }
    }

    if (typeof toggleButton?.addEventListener === 'function') {
      toggleButton.addEventListener('click', () => {
        toggleWorkspace();
      });
    }

    if (typeof sidebarResizeHandle?.addEventListener === 'function') {
      sidebarResizeHandle.addEventListener('pointerdown', startSidebarResize);
    }

    if (typeof previewResizeHandle?.addEventListener === 'function') {
      previewResizeHandle.addEventListener('pointerdown', startResize);
    }

    windowObject?.addEventListener?.('resize', syncViewportResizeState);

    if (initialEnabled) {
      setEnabled(true);
      applyRuntimeSummary({ state: 'idle' });
      setConsoleEvents([]);
      toggleConsoleDrawer(false);
    } else {
      clearSessionState();
    }
    sidebarSize = readStoredSidebarSize();
    if (sidebarSize.width) {
      applySidebarSize(sidebarSize, { persist: false });
    }
    previewSize = readStoredPreviewSize();
    if (previewSize.width || previewSize.height) {
      applyPreviewSize(previewSize, { persist: false });
    }
    syncWorkspaceVisibility();

    return {
      setEnabled,
      toggleWorkspace,
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
      activateSessionPreview,
      invalidateSessionPreview,
      getActivePreviewFrame,
      getActivePreviewRegion,
      getCachedPreviewSessionIds: () => previewFrameLru.slice(),
      getSidebarSize: () => ({ width: sidebarSize.width }),
      getPreviewSize: () => ({ width: previewSize.width, height: previewSize.height }),
      isWorkspaceOpen: () => workspaceOpen,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappVisualDevShell = api;
})(typeof window !== 'undefined' ? window : globalThis);
