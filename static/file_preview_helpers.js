(function initHermesMiniappFilePreview(globalScope) {
  function createController(deps) {
    const {
      documentObject,
      requestAnimationFrameFn,
      filePreviewModal,
      filePreviewPath,
      filePreviewStatus,
      filePreviewLines,
      filePreviewExpandUp,
      filePreviewLoadFull,
      filePreviewExpandDown,
      filePreviewClose,
      messagesEl,
      apiPost,
      getActiveChatId,
      getCurrentFilePreviewRequest,
      setCurrentFilePreviewRequest,
      getCurrentFilePreview,
      setCurrentFilePreview,
    } = deps;

    const MOBILE_MESSAGE_FILE_REF_TAP_SLOP_PX = 14;
    let filePreviewRequestGeneration = 0;
    let pendingMessageFileRefTouch = null;
    let unbindFilePreviewBindings = null;

    function nextFilePreviewRequestGeneration() {
      filePreviewRequestGeneration += 1;
      return filePreviewRequestGeneration;
    }

    function isLatestFilePreviewRequestGeneration(generation) {
      return Number(generation) === filePreviewRequestGeneration;
    }

    function cloneFilePreviewRequest(previewRequest = {}) {
      const payload = {};
      const refId = String(previewRequest?.ref_id || '').trim();
      const path = String(previewRequest?.path || '').trim();
      const lineStart = Number(previewRequest?.line_start || 0);
      const lineEnd = Number(previewRequest?.line_end || 0);
      const windowStart = Number(previewRequest?.window_start || 0);
      const windowEnd = Number(previewRequest?.window_end || 0);
      if (refId) payload.ref_id = refId;
      if (path) payload.path = path;
      if (Number.isFinite(lineStart) && lineStart > 0) payload.line_start = Math.floor(lineStart);
      if (Number.isFinite(lineEnd) && lineEnd > 0) payload.line_end = Math.floor(lineEnd);
      if (Number.isFinite(windowStart) && windowStart > 0) payload.window_start = Math.floor(windowStart);
      if (Number.isFinite(windowEnd) && windowEnd > 0) payload.window_end = Math.floor(windowEnd);
      if (previewRequest?.full_file === true) payload.full_file = true;
      return payload;
    }

    function syncFilePreviewExpandControls(preview = null, { isLoading = false } = {}) {
      const canExpandUp = Boolean(preview?.can_expand_up);
      const canExpandDown = Boolean(preview?.can_expand_down);
      const canLoadFullFile = Boolean(preview?.can_load_full_file);
      const fullFileLoaded = Boolean(preview?.full_file_loaded);
      if (filePreviewExpandUp) {
        filePreviewExpandUp.disabled = isLoading || !canExpandUp;
      }
      if (filePreviewLoadFull) {
        filePreviewLoadFull.disabled = isLoading || fullFileLoaded || !canLoadFullFile;
        filePreviewLoadFull.textContent = fullFileLoaded ? 'Full file loaded' : 'Load full file';
      }
      if (filePreviewExpandDown) {
        filePreviewExpandDown.disabled = isLoading || !canExpandDown;
      }
    }

    function resetFilePreviewState() {
      setCurrentFilePreview(null);
      if (filePreviewPath) filePreviewPath.textContent = '';
      if (filePreviewStatus) {
        filePreviewStatus.textContent = '';
        filePreviewStatus.hidden = true;
      }
      if (filePreviewLines) {
        filePreviewLines.innerHTML = '';
        filePreviewLines.scrollTop = 0;
      }
      syncFilePreviewExpandControls(null);
    }

    function closeFilePreviewModal() {
      if (!filePreviewModal) return;
      nextFilePreviewRequestGeneration();
      setCurrentFilePreviewRequest(null);
      if (filePreviewModal.open) {
        filePreviewModal.close();
      }
      resetFilePreviewState();
    }

    function createFilePreviewLineNode(row, { focusStart = 0, focusEnd = 0 } = {}) {
      const lineNumber = Number(row?.line || 0);
      const wrap = documentObject.createElement('div');
      wrap.className = 'file-preview-line';
      if (lineNumber > 0) {
        wrap.dataset.lineNumber = String(lineNumber);
      }
      if (focusStart > 0 && lineNumber >= focusStart && lineNumber <= Math.max(focusStart, focusEnd)) {
        wrap.classList.add('is-focus');
      }

      const numberEl = documentObject.createElement('span');
      numberEl.className = 'file-preview-line__number';
      numberEl.textContent = String(lineNumber || '');

      const textEl = documentObject.createElement('span');
      textEl.className = 'file-preview-line__text';
      textEl.textContent = String(row?.text || '');

      wrap.appendChild(numberEl);
      wrap.appendChild(textEl);
      return wrap;
    }

    function captureFilePreviewViewportAnchor() {
      if (!filePreviewLines) return null;
      const lineNodes = Array.from(filePreviewLines.querySelectorAll('.file-preview-line[data-line-number]'));
      if (!lineNodes.length) return null;
      const scrollTop = filePreviewLines.scrollTop;
      const anchorNode = lineNodes.find((node) => (node.offsetTop + node.offsetHeight) >= scrollTop) || lineNodes[0];
      const lineNumber = Number(anchorNode?.dataset?.lineNumber || 0);
      if (!Number.isFinite(lineNumber) || lineNumber <= 0) return null;
      return {
        lineNumber,
        offsetTopDelta: anchorNode.offsetTop - scrollTop,
      };
    }

    function restoreFilePreviewViewportAnchor(anchor) {
      if (!filePreviewLines || !anchor) return false;
      const lineNumber = Number(anchor?.lineNumber || 0);
      if (!Number.isFinite(lineNumber) || lineNumber <= 0) return false;
      const anchorNode = filePreviewLines.querySelector(`.file-preview-line[data-line-number="${lineNumber}"]`);
      if (!anchorNode) return false;
      const offsetTopDelta = Number(anchor?.offsetTopDelta || 0);
      filePreviewLines.scrollTop = Math.max(0, anchorNode.offsetTop - offsetTopDelta);
      return true;
    }

    function canIncrementallyExpandFilePreview(previousPreview, nextPreview) {
      if (!previousPreview || !nextPreview) return false;
      if (String(previousPreview?.path || '') !== String(nextPreview?.path || '')) return false;
      if (Number(previousPreview?.line_start || 0) !== Number(nextPreview?.line_start || 0)) return false;
      if (Number(previousPreview?.line_end || 0) !== Number(nextPreview?.line_end || 0)) return false;
      const previousRows = Array.isArray(previousPreview?.lines) ? previousPreview.lines : [];
      const nextRows = Array.isArray(nextPreview?.lines) ? nextPreview.lines : [];
      if (!previousRows.length || !nextRows.length) return false;
      const previousWindowStart = Number(previousPreview?.window_start || previousRows[0]?.line || 0);
      const previousWindowEnd = Number(previousPreview?.window_end || previousRows[previousRows.length - 1]?.line || 0);
      const nextWindowStart = Number(nextPreview?.window_start || nextRows[0]?.line || 0);
      const nextWindowEnd = Number(nextPreview?.window_end || nextRows[nextRows.length - 1]?.line || 0);
      return nextWindowStart <= previousWindowStart && nextWindowEnd >= previousWindowEnd;
    }

    function expandFilePreviewInPlace(previousPreview, nextPreview) {
      if (!filePreviewLines) return false;
      if (!canIncrementallyExpandFilePreview(previousPreview, nextPreview)) return false;
      const focusStart = Number(nextPreview?.line_start || 0);
      const focusEnd = Number(nextPreview?.line_end || 0);
      const previousRows = Array.isArray(previousPreview?.lines) ? previousPreview.lines : [];
      const nextRows = Array.isArray(nextPreview?.lines) ? nextPreview.lines : [];
      if (!previousRows.length || !nextRows.length) return false;

      const previousWindowStart = Number(previousPreview?.window_start || previousRows[0]?.line || 0);
      const previousWindowEnd = Number(previousPreview?.window_end || previousRows[previousRows.length - 1]?.line || 0);
      const linesByNumber = new Map(nextRows.map((row) => [Number(row?.line || 0), row]));
      const firstExistingNode = filePreviewLines.querySelector(`.file-preview-line[data-line-number="${previousWindowStart}"]`);

      let prepended = false;
      let prependedHeight = 0;
      if (firstExistingNode) {
        const prependFragment = documentObject.createDocumentFragment();
        for (let lineNumber = previousWindowStart - 1; lineNumber >= 1; lineNumber -= 1) {
          if (lineNumber < Number(nextPreview?.window_start || 0)) break;
          const row = linesByNumber.get(lineNumber);
          if (!row) continue;
          prependFragment.insertBefore(createFilePreviewLineNode(row, { focusStart, focusEnd }), prependFragment.firstChild);
          prepended = true;
        }
        if (prepended) {
          const previousScrollTop = filePreviewLines.scrollTop;
          const previousScrollHeight = filePreviewLines.scrollHeight;
          filePreviewLines.insertBefore(prependFragment, firstExistingNode);
          prependedHeight = filePreviewLines.scrollHeight - previousScrollHeight;
          filePreviewLines.scrollTop = previousScrollTop + prependedHeight;
        }
      }

      const appendFragment = documentObject.createDocumentFragment();
      let appended = false;
      for (let lineNumber = previousWindowEnd + 1; lineNumber <= Number(nextPreview?.window_end || 0); lineNumber += 1) {
        const row = linesByNumber.get(lineNumber);
        if (!row) continue;
        appendFragment.appendChild(createFilePreviewLineNode(row, { focusStart, focusEnd }));
        appended = true;
      }
      if (appended) {
        filePreviewLines.appendChild(appendFragment);
      }

      return prepended || appended;
    }

    function renderFilePreview(preview, { viewportAnchor = null, centerFocus = true, mergeInPlace = false } = {}) {
      if (!filePreviewLines) return;
      const previousPreview = getCurrentFilePreview();
      setCurrentFilePreview(preview || null);
      const rows = Array.isArray(preview?.lines) ? preview.lines : [];
      const focusStart = Number(preview?.line_start || 0);
      const focusEnd = Number(preview?.line_end || 0);
      const windowStart = Number(preview?.window_start || (rows[0]?.line || 0));
      const windowEnd = Number(preview?.window_end || (rows[rows.length - 1]?.line || 0));
      const totalLines = Number(preview?.total_lines || rows.length || 0);
      const isTruncated = Boolean(preview?.is_truncated);
      const fullFileLoaded = Boolean(preview?.full_file_loaded);
      if (filePreviewPath) {
        filePreviewPath.textContent = String(preview?.path || 'Preview');
      }
      if (filePreviewStatus) {
        if (rows.length) {
          const summary = totalLines > 0
            ? `Showing lines ${windowStart || 1}–${windowEnd || windowStart || 1} of ${totalLines}${fullFileLoaded ? ' (full file)' : isTruncated ? ' (focused excerpt)' : ''}`
            : 'Showing preview';
          filePreviewStatus.hidden = false;
          filePreviewStatus.textContent = summary;
        } else {
          filePreviewStatus.hidden = false;
          filePreviewStatus.textContent = 'No preview lines available for this file.';
        }
      }

      const mergedInPlace = mergeInPlace && expandFilePreviewInPlace(previousPreview, preview);
      let firstFocusLine = null;
      if (!mergedInPlace) {
        filePreviewLines.innerHTML = '';
        const fragment = documentObject.createDocumentFragment();
        rows.forEach((row) => {
          const node = createFilePreviewLineNode(row, { focusStart, focusEnd });
          if (!firstFocusLine && node.classList.contains('is-focus')) {
            firstFocusLine = node;
          }
          fragment.appendChild(node);
        });
        filePreviewLines.appendChild(fragment);
      }

      syncFilePreviewExpandControls(preview);

      if (mergedInPlace) {
        return;
      }
      if (restoreFilePreviewViewportAnchor(viewportAnchor)) {
        return;
      }
      if (centerFocus && !firstFocusLine) {
        firstFocusLine = filePreviewLines.querySelector('.file-preview-line.is-focus');
      }
      if (centerFocus && firstFocusLine) {
        requestAnimationFrameFn(() => {
          const targetTop = Math.max(
            0,
            firstFocusLine.offsetTop - Math.floor(filePreviewLines.clientHeight / 2) + Math.floor(firstFocusLine.offsetHeight / 2),
          );
          filePreviewLines.scrollTop = targetTop;
        });
      }
    }

    function showFilePreviewStatus(message) {
      if (!filePreviewStatus) return;
      filePreviewStatus.hidden = false;
      filePreviewStatus.textContent = String(message || 'Preview unavailable');
    }

    async function openFilePreview(previewRequest = {}, { preserveViewport = false, loadingMessage = 'Loading preview…' } = {}) {
      if (!filePreviewModal) return;
      const requestGeneration = nextFilePreviewRequestGeneration();
      const nextPreviewRequest = cloneFilePreviewRequest(previewRequest);
      const viewportAnchor = preserveViewport ? captureFilePreviewViewportAnchor() : null;
      if (!preserveViewport) {
        resetFilePreviewState();
      }
      syncFilePreviewExpandControls(getCurrentFilePreview(), { isLoading: true });
      showFilePreviewStatus(loadingMessage);
      if (!filePreviewModal.open) {
        filePreviewModal.showModal();
      }

      try {
        const data = await apiPost('/api/chats/file-preview', {
          chat_id: getActiveChatId(),
          ...nextPreviewRequest,
        });
        if (!isLatestFilePreviewRequestGeneration(requestGeneration) || !filePreviewModal.open) {
          return;
        }
        const preview = data?.preview || null;
        if (!preview) {
          throw new Error('Preview unavailable');
        }
        setCurrentFilePreviewRequest(nextPreviewRequest);
        renderFilePreview(preview, {
          viewportAnchor,
          centerFocus: !preserveViewport,
          mergeInPlace: preserveViewport,
        });
      } catch (error) {
        if (!isLatestFilePreviewRequestGeneration(requestGeneration) || !filePreviewModal.open) {
          return;
        }
        syncFilePreviewExpandControls(getCurrentFilePreview());
        showFilePreviewStatus(error?.message || 'Preview unavailable');
      }
    }

    function openFilePreviewByRef(refId) {
      const cleanedRefId = String(refId || '').trim();
      if (!cleanedRefId || !getActiveChatId()) return;
      void openFilePreview({ ref_id: cleanedRefId });
    }

    function openFilePreviewByPath(pathText, { lineStart = 0, lineEnd = 0 } = {}) {
      const cleanedPath = String(pathText || '').trim();
      if (!cleanedPath || !getActiveChatId()) return;
      const payload = { path: cleanedPath };
      const start = Number(lineStart || 0);
      const end = Number(lineEnd || 0);
      if (Number.isFinite(start) && start > 0) {
        payload.line_start = Math.floor(start);
      }
      if (Number.isFinite(end) && end > 0) {
        payload.line_end = Math.floor(end);
      }
      void openFilePreview(payload);
    }

    function requestFilePreviewExpansion(direction) {
      const preview = getCurrentFilePreview();
      const baseRequest = getCurrentFilePreviewRequest();
      if (!preview || !baseRequest) return;
      const step = 40;
      const currentWindowStart = Number(preview?.window_start || 0);
      const currentWindowEnd = Number(preview?.window_end || 0);
      const totalLines = Number(preview?.total_lines || 0);
      let nextWindowStart = currentWindowStart;
      let nextWindowEnd = currentWindowEnd;

      if (direction === 'up') {
        if (!preview?.can_expand_up) return;
        nextWindowStart = Math.max(1, currentWindowStart - step);
      } else if (direction === 'down') {
        if (!preview?.can_expand_down) return;
        nextWindowEnd = totalLines > 0 ? Math.min(totalLines, currentWindowEnd + step) : currentWindowEnd + step;
      } else {
        return;
      }

      void openFilePreview({
        ...baseRequest,
        window_start: nextWindowStart,
        window_end: nextWindowEnd,
      }, {
        preserveViewport: true,
        loadingMessage: direction === 'up' ? 'Loading more above…' : 'Loading more below…',
      });
    }

    function requestFullFilePreview() {
      const preview = getCurrentFilePreview();
      const baseRequest = getCurrentFilePreviewRequest();
      if (!preview || !baseRequest || !preview?.can_load_full_file || preview?.full_file_loaded) return;
      void openFilePreview({
        ...baseRequest,
        full_file: true,
      }, {
        preserveViewport: true,
        loadingMessage: 'Loading full file…',
      });
    }

    function getMessageFileRefTrigger(event) {
      return event?.target?.closest?.('.message-file-ref') || null;
    }

    function getTouchPoint(event) {
      const touch = event?.changedTouches?.[0] || event?.touches?.[0] || null;
      if (touch) {
        return {
          clientX: Number(touch.clientX || 0),
          clientY: Number(touch.clientY || 0),
        };
      }
      return {
        clientX: Number(event?.clientX || 0),
        clientY: Number(event?.clientY || 0),
      };
    }

    function cancelPendingMessageFileRefTouch() {
      pendingMessageFileRefTouch = null;
    }

    function handleMessageFileRefTouchStart(event) {
      const trigger = getMessageFileRefTrigger(event);
      if (!trigger) return;
      const refId = String(trigger.dataset?.fileRefId || '').trim();
      if (!refId) {
        cancelPendingMessageFileRefTouch();
        return;
      }
      const { clientX, clientY } = getTouchPoint(event);
      pendingMessageFileRefTouch = {
        trigger,
        refId,
        startX: clientX,
        startY: clientY,
      };
    }

    function handleMessageFileRefTouchMove(event) {
      if (!pendingMessageFileRefTouch) return;
      const { clientX, clientY } = getTouchPoint(event);
      const deltaX = clientX - pendingMessageFileRefTouch.startX;
      const deltaY = clientY - pendingMessageFileRefTouch.startY;
      if (Math.hypot(deltaX, deltaY) > MOBILE_MESSAGE_FILE_REF_TAP_SLOP_PX) {
        cancelPendingMessageFileRefTouch();
      }
    }

    function handleMessageFileRefClick(event) {
      const trigger = getMessageFileRefTrigger(event);
      if (!trigger) {
        if (event?.type === 'touchend') {
          cancelPendingMessageFileRefTouch();
        }
        return;
      }

      const refId = String(trigger.dataset.fileRefId || '').trim();
      if (!refId) {
        if (event?.type === 'touchend') {
          cancelPendingMessageFileRefTouch();
        }
        return;
      }

      if (event?.type === 'touchend') {
        if (!pendingMessageFileRefTouch) return;
        const isSameTrigger = pendingMessageFileRefTouch.trigger === trigger;
        const isSameRefId = pendingMessageFileRefTouch.refId === refId;
        cancelPendingMessageFileRefTouch();
        if (!isSameTrigger || !isSameRefId) return;
      }

      // Telegram mobile webviews can occasionally miss delegated click for inline
      // buttons while still delivering touchend. Bind both and handle here.
      if (typeof event?.preventDefault === 'function') {
        event.preventDefault();
      }

      openFilePreviewByRef(refId);
    }

    function bindFilePreviewBindings() {
      if (unbindFilePreviewBindings) {
        return unbindFilePreviewBindings;
      }
      const cleanup = [];
      const bind = (target, eventName, handler, options) => {
        if (!target?.addEventListener) return;
        target.addEventListener(eventName, handler, options);
        cleanup.push(() => target.removeEventListener?.(eventName, handler, options));
      };
      const handleModalCancel = (event) => {
        event.preventDefault();
        closeFilePreviewModal();
      };

      bind(messagesEl, 'click', handleMessageFileRefClick);
      bind(messagesEl, 'touchstart', handleMessageFileRefTouchStart, { passive: true });
      bind(messagesEl, 'touchmove', handleMessageFileRefTouchMove, { passive: true });
      bind(messagesEl, 'touchend', handleMessageFileRefClick, { passive: false });
      bind(messagesEl, 'touchcancel', cancelPendingMessageFileRefTouch);
      bind(messagesEl, 'scroll', cancelPendingMessageFileRefTouch, { passive: true });
      bind(filePreviewExpandUp, 'click', () => requestFilePreviewExpansion('up'));
      bind(filePreviewLoadFull, 'click', requestFullFilePreview);
      bind(filePreviewExpandDown, 'click', () => requestFilePreviewExpansion('down'));
      bind(filePreviewClose, 'click', closeFilePreviewModal);
      bind(filePreviewModal, 'cancel', handleModalCancel);

      unbindFilePreviewBindings = () => {
        cleanup.splice(0).reverse().forEach((unbind) => unbind());
        unbindFilePreviewBindings = null;
      };
      return unbindFilePreviewBindings;
    }

    return {
      cloneFilePreviewRequest,
      syncFilePreviewExpandControls,
      resetFilePreviewState,
      closeFilePreviewModal,
      createFilePreviewLineNode,
      captureFilePreviewViewportAnchor,
      restoreFilePreviewViewportAnchor,
      canIncrementallyExpandFilePreview,
      expandFilePreviewInPlace,
      renderFilePreview,
      showFilePreviewStatus,
      openFilePreview,
      openFilePreviewByRef,
      openFilePreviewByPath,
      requestFilePreviewExpansion,
      requestFullFilePreview,
      bindFilePreviewBindings,
      handleMessageFileRefTouchStart,
      handleMessageFileRefTouchMove,
      cancelPendingMessageFileRefTouch,
      handleMessageFileRefClick,
    };
  }

  const api = { createController };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappFilePreview = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
