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

  function positiveDimension(value, fallback = 1) {
    const number = Number(value);
    if (Number.isFinite(number) && number > 0) {
      return Math.round(number);
    }
    return fallback;
  }

  function nonNegativeNumber(value, fallback = 0) {
    const number = Number(value);
    if (Number.isFinite(number) && number >= 0) {
      return number;
    }
    return fallback;
  }

  function scrollOffset(windowObject, documentObject) {
    const documentElement = documentObject?.documentElement || {};
    const body = documentObject?.body || {};
    return {
      left: Math.max(0, Math.round(nonNegativeNumber(
        windowObject?.scrollX,
        windowObject?.pageXOffset ?? documentElement.scrollLeft ?? body.scrollLeft ?? 0,
      ))),
      top: Math.max(0, Math.round(nonNegativeNumber(
        windowObject?.scrollY,
        windowObject?.pageYOffset ?? documentElement.scrollTop ?? body.scrollTop ?? 0,
      ))),
    };
  }

  function buildScreenshotPlan(windowObject, documentObject, payload = {}) {
    const documentElement = documentObject?.documentElement || {};
    const body = documentObject?.body || {};
    const scroll = scrollOffset(windowObject, documentObject);
    const viewportWidth = positiveDimension(
      windowObject?.innerWidth || documentElement.clientWidth || body.clientWidth,
      1,
    );
    const viewportHeight = positiveDimension(
      windowObject?.innerHeight || documentElement.clientHeight || body.clientHeight,
      1,
    );
    const fullWidth = positiveDimension(
      Math.max(
        viewportWidth,
        Number(documentElement.scrollWidth || 0),
        Number(body.scrollWidth || 0),
        Number(documentElement.clientWidth || 0),
        Number(body.clientWidth || 0),
      ),
      viewportWidth,
    );
    const fullHeight = positiveDimension(
      Math.max(
        viewportHeight,
        Number(documentElement.scrollHeight || 0),
        Number(body.scrollHeight || 0),
        Number(documentElement.clientHeight || 0),
        Number(body.clientHeight || 0),
      ),
      viewportHeight,
    );
    const region = payload?.region && typeof payload.region === 'object'
      ? {
          left: Math.max(0, scroll.left + Number(payload.region.left || 0)),
          top: Math.max(0, scroll.top + Number(payload.region.top || 0)),
          width: positiveDimension(payload.region.width, viewportWidth),
          height: positiveDimension(payload.region.height, viewportHeight),
        }
      : null;
    if (String(payload?.capture || '') === 'region' && region) {
      return {
        capture: 'region',
        sourceWidth: fullWidth,
        sourceHeight: fullHeight,
        canvasWidth: region.width,
        canvasHeight: region.height,
        offsetLeft: region.left,
        offsetTop: region.top,
        region,
      };
    }
    return {
      capture: 'full',
      sourceWidth: fullWidth,
      sourceHeight: fullHeight,
      canvasWidth: viewportWidth,
      canvasHeight: viewportHeight,
      offsetLeft: scroll.left,
      offsetTop: scroll.top,
      region: null,
    };
  }

  function isElementHidden(windowObject, element) {
    if (!element || typeof element !== 'object') return true;
    let current = element;
    while (current && typeof current === 'object' && Number(current.nodeType || 1) === 1) {
      if (current.hidden) return true;
      const computedStyle = windowObject?.getComputedStyle?.(current);
      if (computedStyle) {
        const display = String(computedStyle.display || '').trim().toLowerCase();
        const visibility = String(computedStyle.visibility || '').trim().toLowerCase();
        if (display === 'none') return true;
        if (visibility === 'hidden' || visibility === 'collapse') return true;
      }
      current = current.parentElement || current.parentNode || null;
    }
    return false;
  }

  function elementIntersectsViewport(windowObject, documentObject, element) {
    if (!element || typeof element !== 'object') return false;
    if (typeof element.getBoundingClientRect !== 'function') return true;
    const rect = element.getBoundingClientRect();
    const left = Number(rect?.left || 0);
    const top = Number(rect?.top || 0);
    const width = Number(rect?.width || ((rect?.right || 0) - left) || 0);
    const height = Number(rect?.height || ((rect?.bottom || 0) - top) || 0);
    if (width <= 0 || height <= 0) return false;
    const right = Number(rect?.right || (left + width));
    const bottom = Number(rect?.bottom || (top + height));
    const documentElement = documentObject?.documentElement || {};
    const body = documentObject?.body || {};
    const viewportWidth = positiveDimension(
      windowObject?.innerWidth || documentElement.clientWidth || body.clientWidth,
      1,
    );
    const viewportHeight = positiveDimension(
      windowObject?.innerHeight || documentElement.clientHeight || body.clientHeight,
      1,
    );
    return right > 0 && bottom > 0 && left < viewportWidth && top < viewportHeight;
  }

  function applyInlineComputedStyles(windowObject, sourceElement, targetElement) {
    if (!sourceElement || !targetElement || !windowObject?.getComputedStyle) {
      return;
    }
    const computedStyle = windowObject.getComputedStyle(sourceElement);
    if (!computedStyle) {
      return;
    }
    if (typeof computedStyle.cssText === 'string' && computedStyle.cssText.trim()) {
      targetElement.style.cssText = computedStyle.cssText;
    } else {
      Array.from(computedStyle).forEach((propertyName) => {
        targetElement.style.setProperty(
          propertyName,
          computedStyle.getPropertyValue(propertyName),
          computedStyle.getPropertyPriority?.(propertyName) || '',
        );
      });
    }
    const sourceRect = sourceElement?.getBoundingClientRect?.();
    if (sourceRect && targetElement.style && String(computedStyle.position || '').trim().toLowerCase() === 'fixed') {
      targetElement.style.left = `${Math.round(Number(sourceRect.left || 0))}px`;
      targetElement.style.top = `${Math.round(Number(sourceRect.top || 0))}px`;
      targetElement.style.right = 'auto';
      targetElement.style.bottom = 'auto';
    }
  }

  function copyElementAttributes(sourceElement, targetElement) {
    if (!sourceElement?.attributes || !targetElement?.setAttribute) {
      return;
    }
    Array.from(sourceElement.attributes).forEach((attribute) => {
      const attributeName = String(attribute?.name || '');
      if (!attributeName || attributeName === 'style') return;
      targetElement.setAttribute(attributeName, String(attribute?.value || ''));
    });
  }

  function cloneNodeForScreenshot(windowObject, documentObject, snapshotDocument, sourceNode) {
    const nodeType = Number(sourceNode?.nodeType || 0);
    if (nodeType === 3) {
      return snapshotDocument.createTextNode(String(sourceNode.textContent || ''));
    }
    if (nodeType !== 1) {
      return null;
    }
    const tagName = String(sourceNode.tagName || '').trim().toLowerCase();
    if (!tagName || tagName === 'script' || tagName === 'noscript' || tagName === 'template') {
      return null;
    }
    if (isElementHidden(windowObject, sourceNode)) {
      return null;
    }
    if (!elementIntersectsViewport(windowObject, documentObject, sourceNode)) {
      return null;
    }
    const namespace = String(sourceNode.namespaceURI || '').trim();
    const clone = namespace
      ? snapshotDocument.createElementNS(namespace, sourceNode.tagName)
      : snapshotDocument.createElement(sourceNode.tagName);
    copyElementAttributes(sourceNode, clone);
    applyInlineComputedStyles(windowObject, sourceNode, clone);
    if (tagName === 'canvas' && typeof sourceNode.toDataURL === 'function') {
      try {
        const imageClone = snapshotDocument.createElement('img');
        copyElementAttributes(sourceNode, imageClone);
        applyInlineComputedStyles(windowObject, sourceNode, imageClone);
        imageClone.setAttribute('src', sourceNode.toDataURL('image/png'));
        imageClone.setAttribute('alt', String(sourceNode.getAttribute?.('aria-label') || sourceNode.getAttribute?.('alt') || ''));
        return imageClone;
      } catch (_error) {
        // Fall through to a normal element clone.
      }
    }
    if (tagName === 'img') {
      const currentSrc = String(sourceNode.currentSrc || sourceNode.src || sourceNode.getAttribute?.('src') || '').trim();
      if (currentSrc) {
        clone.setAttribute('src', currentSrc);
      }
    }
    if (tagName === 'input') {
      clone.setAttribute('value', String(sourceNode.value || ''));
      if (sourceNode.checked) clone.setAttribute('checked', 'checked');
    } else if (tagName === 'textarea') {
      clone.textContent = String(sourceNode.value || sourceNode.textContent || '');
    } else if (tagName === 'select') {
      clone.setAttribute('value', String(sourceNode.value || ''));
    }
    Array.from(sourceNode.childNodes || []).forEach((childNode) => {
      const childClone = cloneNodeForScreenshot(windowObject, documentObject, snapshotDocument, childNode);
      if (childClone) {
        clone.appendChild(childClone);
      }
    });
    return clone;
  }

  function serializeVisibleDocument(windowObject, documentObject) {
    const serializerCtor = windowObject?.XMLSerializer || globalScope?.XMLSerializer;
    const serializer = serializerCtor ? new serializerCtor() : null;
    const implementation = documentObject?.implementation;
    const snapshotDocument = implementation?.createHTMLDocument?.('visual-dev-screenshot') || documentObject;
    if (
      !snapshotDocument?.documentElement
      || !snapshotDocument?.body
      || typeof snapshotDocument.createElement !== 'function'
      || typeof snapshotDocument.createTextNode !== 'function'
      || typeof snapshotDocument.documentElement?.appendChild !== 'function'
    ) {
      const fallbackDocument = documentObject?.documentElement;
      return serializer?.serializeToString
        ? serializer.serializeToString(fallbackDocument)
        : String(fallbackDocument?.outerHTML || '<html></html>');
    }
    const snapshotRoot = snapshotDocument.documentElement;
    const snapshotBody = snapshotDocument.body;
    snapshotRoot.innerHTML = '';
    snapshotRoot.appendChild(snapshotBody);
    copyElementAttributes(documentObject.documentElement, snapshotRoot);
    copyElementAttributes(documentObject.body, snapshotBody);
    applyInlineComputedStyles(windowObject, documentObject.documentElement, snapshotRoot);
    applyInlineComputedStyles(windowObject, documentObject.body, snapshotBody);
    Array.from(documentObject.body?.childNodes || []).forEach((childNode) => {
      const childClone = cloneNodeForScreenshot(windowObject, documentObject, snapshotDocument, childNode);
      if (childClone) {
        snapshotBody.appendChild(childClone);
      }
    });
    return serializer?.serializeToString
      ? serializer.serializeToString(snapshotRoot)
      : String(snapshotRoot.outerHTML || '<html></html>');
  }

  function svgMarkupForDocument(windowObject, documentObject, plan) {
    const serializedDocument = serializeVisibleDocument(windowObject, documentObject);
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${plan.canvasWidth}" height="${plan.canvasHeight}" viewBox="0 0 ${plan.canvasWidth} ${plan.canvasHeight}">`,
      '<foreignObject width="100%" height="100%">',
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${plan.sourceWidth}px;height:${plan.sourceHeight}px;overflow:hidden;transform:translate(${-plan.offsetLeft}px, ${-plan.offsetTop}px);transform-origin:top left;">`,
      serializedDocument,
      '</div>',
      '</foreignObject>',
      '</svg>',
    ].join('');
  }

  function dataUrlPayload(dataUrl) {
    const normalized = String(dataUrl || '');
    const match = normalized.match(/^data:([^;,]+)(?:;charset=[^;,]+)?;base64,(.+)$/);
    if (!match) {
      return null;
    }
    return {
      contentType: String(match[1] || '').trim().toLowerCase(),
      bytesB64: String(match[2] || '').trim(),
    };
  }

  function createDomScreenshotCapture(windowObject, documentObject) {
    const imageCtor = windowObject?.Image || globalScope?.Image;
    const createCanvas = () => documentObject?.createElement?.('canvas');
    if (typeof imageCtor !== 'function' || typeof createCanvas !== 'function') {
      return null;
    }
    return async (payload = {}) => {
      const plan = buildScreenshotPlan(windowObject, documentObject, payload);
      const svgMarkup = svgMarkupForDocument(windowObject, documentObject, plan);
      const svgUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgMarkup)}`;
      const image = await new Promise((resolve, reject) => {
        const nextImage = new imageCtor();
        nextImage.onload = () => resolve(nextImage);
        nextImage.onerror = () => reject(new Error('Preview screenshot render failed.'));
        nextImage.src = svgUrl;
      });
      const canvas = createCanvas();
      const context = canvas?.getContext?.('2d');
      if (!canvas || !context) {
        throw new Error('Preview screenshot canvas unavailable.');
      }
      canvas.width = plan.canvasWidth;
      canvas.height = plan.canvasHeight;
      context.drawImage(image, 0, 0);
      const encoded = dataUrlPayload(canvas.toDataURL('image/png'));
      if (!encoded?.bytesB64) {
        throw new Error('Preview screenshot encoding failed.');
      }
      return {
        contentType: encoded.contentType || 'image/png',
        bytesB64: encoded.bytesB64,
        label: plan.capture === 'region' ? 'region screenshot' : 'viewport screenshot',
        width: plan.canvasWidth,
        height: plan.canvasHeight,
      };
    };
  }

  async function captureDocumentScreenshot(payload = {}, options = {}) {
    const windowObject = options?.windowObject || globalScope;
    const documentObject = options?.documentObject || windowObject?.document || globalScope?.document || null;
    const capture = createDomScreenshotCapture(windowObject, documentObject);
    if (typeof capture !== 'function') {
      throw new Error('Document screenshot capture unavailable.');
    }
    return capture(payload);
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
    const screenshotCapture = typeof captureScreenshot === 'function'
      ? captureScreenshot
      : createDomScreenshotCapture(windowObject, documentObject);
    const heartbeatIntervalMs = 5000;
    let heartbeatIntervalId = null;

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

    function clearHeartbeat() {
      if (heartbeatIntervalId === null || typeof windowObject?.clearInterval !== 'function') {
        heartbeatIntervalId = null;
        return;
      }
      windowObject.clearInterval(heartbeatIntervalId);
      heartbeatIntervalId = null;
    }

    function postHeartbeat() {
      post('hermes-visual-dev:runtime', {
        runtime: { state: 'live' },
      });
    }

    function startHeartbeat() {
      clearHeartbeat();
      if (typeof windowObject?.setInterval !== 'function') {
        return;
      }
      heartbeatIntervalId = windowObject.setInterval(postHeartbeat, heartbeatIntervalMs);
      heartbeatIntervalId?.unref?.();
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
      startHeartbeat();
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
      if (typeof screenshotCapture !== 'function') {
        reportConsole({
          level: 'warn',
          message: 'Preview screenshot hook unavailable',
          source: payload?.source || 'toolbar',
        });
        return;
      }
      let result = null;
      try {
        result = await screenshotCapture(payload);
      } catch (error) {
        reportConsole({
          level: 'error',
          message: String(error?.message || error || 'Preview screenshot failed.'),
          source: payload?.source || 'toolbar',
        });
        return;
      }
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
      clearHeartbeat();
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

  const api = {
    createController,
    captureDocumentScreenshot,
    _test: {
      buildScreenshotPlan,
      scrollOffset,
      serializeVisibleDocument,
    },
  };
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappVisualDevBridge = api;

  if (
    globalScope
    && globalScope === globalScope?.window
    && globalScope?.document
    && !globalScope.__hermesMiniappVisualDevBridgeController
  ) {
    try {
      const controller = createController({
        windowObject: globalScope,
        documentObject: globalScope.document,
      });
      controller.install?.();
      globalScope.__hermesMiniappVisualDevBridgeController = controller;
    } catch (_error) {
      // Preview pages without a DOM-capable environment should fail closed.
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
