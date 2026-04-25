(function initHermesMiniappVisualDevPromptContext(globalScope) {
  function normalizeText(value) {
    return String(value || '').trim();
  }

  function joinSnippetLines(lines = []) {
    return lines
      .map((line) => normalizeText(line))
      .filter(Boolean)
      .join('\n');
  }

  function buildSelectionSnippet(selection = {}) {
    const label = normalizeText(selection?.label || selection?.selector || selection?.tagName || 'selected element');
    const selector = normalizeText(selection?.selector || '');
    const tagName = normalizeText(selection?.tagName || '');
    const text = normalizeText(selection?.text || '');
    return joinSnippetLines([
      '[Visual UI context]',
      `Selected element: ${label}`,
      selector ? `Selector: ${selector}` : '',
      tagName ? `Tag: ${tagName}` : '',
      text ? `Visible text: ${text}` : '',
      'Please use this selected UI context for the next change.',
    ]);
  }

  function screenshotBasename(screenshot = {}) {
    const path = normalizeText(screenshot?.storage_path || screenshot?.artifact_path || screenshot?.artifactPath || '');
    return path ? path.split(/[\\/]/).filter(Boolean).pop() || '' : '';
  }

  function compactScreenshotBasename(basename = '') {
    const normalized = normalizeText(basename);
    const match = normalized.match(/^screenshot-\d+-([a-f0-9]{6,12})\.(png|jpe?g|webp)$/i);
    if (match) {
      return `screenshot ${match[1]}`;
    }
    if (normalized.length > 28) {
      return `${normalized.slice(0, 12)}…${normalized.slice(-10)}`;
    }
    return normalized;
  }

  function screenshotLabel(screenshot = {}) {
    const metadataLabel = normalizeText(screenshot?.label || screenshot?.metadata?.label || '');
    const basename = screenshotBasename(screenshot);
    if (metadataLabel && basename) {
      return metadataLabel.includes(basename) ? metadataLabel : `${metadataLabel} • ${basename}`;
    }
    return metadataLabel || basename || normalizeText(screenshot?.storage_path || screenshot?.artifact_path || screenshot?.artifactPath || '');
  }

  function screenshotChipLabel(screenshot = {}) {
    const metadataLabel = normalizeText(screenshot?.label || screenshot?.metadata?.label || '');
    const basename = screenshotBasename(screenshot);
    const compactName = compactScreenshotBasename(basename);
    if (metadataLabel && compactName) {
      return `${metadataLabel} • ${compactName}`;
    }
    return metadataLabel || compactName || '';
  }

  function buildScreenshotSnippet(screenshot = {}) {
    const label = screenshotLabel(screenshot) || 'latest screenshot';
    const path = normalizeText(screenshot?.storage_path || screenshot?.artifact_path || screenshot?.artifactPath || '');
    return joinSnippetLines([
      '[Visual screenshot context]',
      `Latest screenshot: ${label}`,
      path ? `Artifact path: ${path}` : '',
      'Please use the latest visual-dev screenshot context for the next change.',
    ]);
  }

  function buildPreviewSnippet(preview = {}) {
    const title = normalizeText(preview?.preview_title || preview?.previewTitle || preview?.title || 'attached preview');
    const url = normalizeText(preview?.preview_url || preview?.previewUrl || preview?.url || '');
    return joinSnippetLines([
      '[Visual preview context]',
      `Attached preview: ${title}`,
      url ? `Preview URL: ${url}` : '',
      'Please use this active preview context for the next change.',
    ]);
  }

  function buildConsoleSnippet(consoleContext = {}) {
    const runtimeState = normalizeText(consoleContext?.runtime_state || consoleContext?.runtimeState || 'runtime state unknown');
    const runtimeMessage = normalizeText(consoleContext?.runtime_message || consoleContext?.runtimeMessage || '');
    const level = normalizeText(consoleContext?.level || '');
    const message = normalizeText(consoleContext?.message || '');
    return joinSnippetLines([
      '[Visual runtime context]',
      `Runtime state: ${runtimeState}`,
      runtimeMessage ? `Runtime message: ${runtimeMessage}` : '',
      level ? `Console level: ${level}` : '',
      message ? `Console message: ${message}` : '',
      'Please use this preview runtime/debug context for the next change.',
    ]);
  }

  function appendSnippetToPrompt(promptEl, snippet, {
    ensureComposerVisible = () => {},
    focusPrompt = () => {},
    notifyInput = () => {},
  } = {}) {
    if (!promptEl) return '';
    const normalizedSnippet = normalizeText(snippet);
    if (!normalizedSnippet) {
      return String(promptEl.value || '');
    }
    const currentValue = String(promptEl.value || '');
    const nextValue = currentValue.trim()
      ? `${currentValue.replace(/\s*$/g, '')}\n\n${normalizedSnippet}`
      : normalizedSnippet;
    promptEl.value = nextValue;
    ensureComposerVisible();
    notifyInput(nextValue);
    focusPrompt();
    return nextValue;
  }

  function setHidden(element, hidden) {
    if (!element) return;
    element.hidden = Boolean(hidden);
  }

  function setText(element, value) {
    if (!element) return;
    element.textContent = String(value || '');
  }

  function previewLabel(preview = {}) {
    return normalizeText(preview?.preview_title || preview?.previewTitle || preview?.title || preview?.preview_url || preview?.previewUrl || preview?.url || '');
  }

  function consoleLabel(consoleContext = {}) {
    const runtimeState = normalizeText(consoleContext?.runtime_state || consoleContext?.runtimeState || '');
    const runtimeMessage = normalizeText(consoleContext?.runtime_message || consoleContext?.runtimeMessage || '');
    const level = normalizeText(consoleContext?.level || '');
    const message = normalizeText(consoleContext?.message || '');
    return runtimeState || runtimeMessage || level || message;
  }

  function createController(deps) {
    const {
      enabled = false,
      promptEl,
      selectionChip,
      screenshotChip,
      previewChip,
      consoleChip,
      attachedSelectionChip,
      attachedSelectionClearButton,
      attachedScreenshotChip,
      attachedScreenshotClearButton,
      attachedPreviewChip,
      attachedPreviewClearButton,
      attachedConsoleChip,
      attachedConsoleClearButton,
      getSelectionContext = () => null,
      getScreenshotContext = () => null,
      getPreviewContext = () => null,
      getConsoleContext = () => null,
      ensureComposerVisible = () => {},
      focusPrompt = () => promptEl?.focus?.(),
      notifyInput = () => {},
    } = deps || {};

    let bound = false;
    let attachedSelection = null;
    let attachedScreenshot = null;
    let attachedPreview = null;
    let attachedConsole = null;

    function renderAttachedRequestContext() {
      const selectionLabel = normalizeText(attachedSelection?.label || attachedSelection?.selector || attachedSelection?.tagName || '');
      const screenshotLabelText = screenshotChipLabel(attachedScreenshot);
      const nextPreviewLabel = previewLabel(attachedPreview);
      const nextConsoleLabel = consoleLabel(attachedConsole);
      setText(attachedSelectionChip, `Next send UI: ${selectionLabel || 'none'}`);
      setText(attachedScreenshotChip, `Next send screenshot: ${screenshotLabelText || 'none'}`);
      setText(attachedPreviewChip, `Next send preview: ${nextPreviewLabel || 'none'}`);
      setText(attachedConsoleChip, `Next send console: ${nextConsoleLabel || 'none'}`);
      setHidden(attachedSelectionChip, !selectionLabel);
      setHidden(attachedSelectionClearButton, !selectionLabel);
      setHidden(attachedScreenshotChip, !screenshotLabelText);
      setHidden(attachedScreenshotClearButton, !screenshotLabelText);
      setHidden(attachedPreviewChip, !nextPreviewLabel);
      setHidden(attachedPreviewClearButton, !nextPreviewLabel);
      setHidden(attachedConsoleChip, !nextConsoleLabel);
      setHidden(attachedConsoleClearButton, !nextConsoleLabel);
    }

    function handleSelectionChipClick() {
      if (!enabled) return;
      const selection = getSelectionContext?.();
      attachedSelection = selection || null;
      renderAttachedRequestContext();
      const snippet = buildSelectionSnippet(selection || {});
      appendSnippetToPrompt(promptEl, snippet, { ensureComposerVisible, focusPrompt, notifyInput });
    }

    function handleScreenshotChipClick() {
      if (!enabled) return;
      const screenshot = getScreenshotContext?.();
      attachedScreenshot = screenshot || null;
      renderAttachedRequestContext();
      const snippet = buildScreenshotSnippet(screenshot || {});
      appendSnippetToPrompt(promptEl, snippet, { ensureComposerVisible, focusPrompt, notifyInput });
    }

    function handlePreviewChipClick() {
      if (!enabled) return;
      const preview = getPreviewContext?.();
      attachedPreview = preview || null;
      renderAttachedRequestContext();
      const snippet = buildPreviewSnippet(preview || {});
      appendSnippetToPrompt(promptEl, snippet, { ensureComposerVisible, focusPrompt, notifyInput });
    }

    function handleConsoleChipClick() {
      if (!enabled) return;
      const consoleContext = getConsoleContext?.();
      attachedConsole = consoleContext || null;
      renderAttachedRequestContext();
      const snippet = buildConsoleSnippet(consoleContext || {});
      appendSnippetToPrompt(promptEl, snippet, { ensureComposerVisible, focusPrompt, notifyInput });
    }

    function clearSelectionRequestContext() {
      attachedSelection = null;
      renderAttachedRequestContext();
    }

    function clearScreenshotRequestContext() {
      attachedScreenshot = null;
      renderAttachedRequestContext();
    }

    function clearPreviewRequestContext() {
      attachedPreview = null;
      renderAttachedRequestContext();
    }

    function clearConsoleRequestContext() {
      attachedConsole = null;
      renderAttachedRequestContext();
    }

    function getRequestContext() {
      return {
        selection: attachedSelection,
        screenshot: attachedScreenshot,
        preview: attachedPreview,
        console: attachedConsole,
      };
    }

    function clearRequestContext() {
      attachedSelection = null;
      attachedScreenshot = null;
      attachedPreview = null;
      attachedConsole = null;
      renderAttachedRequestContext();
    }

    function bind() {
      if (bound) return;
      selectionChip?.addEventListener?.('click', handleSelectionChipClick);
      screenshotChip?.addEventListener?.('click', handleScreenshotChipClick);
      previewChip?.addEventListener?.('click', handlePreviewChipClick);
      consoleChip?.addEventListener?.('click', handleConsoleChipClick);
      attachedSelectionClearButton?.addEventListener?.('click', clearSelectionRequestContext);
      attachedScreenshotClearButton?.addEventListener?.('click', clearScreenshotRequestContext);
      attachedPreviewClearButton?.addEventListener?.('click', clearPreviewRequestContext);
      attachedConsoleClearButton?.addEventListener?.('click', clearConsoleRequestContext);
      renderAttachedRequestContext();
      bound = true;
    }

    return {
      bind,
      handleSelectionChipClick,
      handleScreenshotChipClick,
      handlePreviewChipClick,
      handleConsoleChipClick,
      clearSelectionRequestContext,
      clearScreenshotRequestContext,
      clearPreviewRequestContext,
      clearConsoleRequestContext,
      getRequestContext,
      clearRequestContext,
      buildSelectionSnippet,
      buildScreenshotSnippet,
      buildPreviewSnippet,
      buildConsoleSnippet,
      appendSnippetToPrompt,
    };
  }

  const api = {
    createController,
    buildSelectionSnippet,
    buildScreenshotSnippet,
    buildPreviewSnippet,
    buildConsoleSnippet,
    appendSnippetToPrompt,
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappVisualDevPromptContext = api;
})(typeof window !== 'undefined' ? window : globalThis);
