(function initRenderTraceTextHelpers(global) {
  "use strict";

  function normalizeFileRefs(fileRefs) {
    if (!Array.isArray(fileRefs)) return [];
    const normalized = [];
    for (const candidate of fileRefs) {
      const refId = String(candidate?.ref_id || "").trim();
      const rawText = String(candidate?.raw_text || "");
      const resolvedPath = String(candidate?.resolved_path || candidate?.path || "").trim();
      const lineStart = Number(candidate?.line_start || 0);
      const lineEnd = Number(candidate?.line_end || 0);
      if (!refId || !rawText) continue;
      normalized.push({
        refId,
        rawText,
        resolvedPath,
        lineStart: Number.isFinite(lineStart) && lineStart > 0 ? Math.floor(lineStart) : 0,
        lineEnd: Number.isFinite(lineEnd) && lineEnd > 0 ? Math.floor(lineEnd) : 0,
      });
    }
    return normalized;
  }

  function chooseNextFileRefMatch(text, cursor, fileRefs) {
    let bestMatch = null;
    for (let fileRefIndex = 0; fileRefIndex < fileRefs.length; fileRefIndex += 1) {
      const fileRef = fileRefs[fileRefIndex];
      const matchIndex = text.indexOf(fileRef.rawText, cursor);
      if (matchIndex < 0) continue;
      if (!bestMatch) {
        bestMatch = { ...fileRef, index: matchIndex, fileRefIndex };
        continue;
      }
      if (matchIndex < bestMatch.index) {
        bestMatch = { ...fileRef, index: matchIndex, fileRefIndex };
        continue;
      }
      if (matchIndex === bestMatch.index && fileRef.rawText.length > bestMatch.rawText.length) {
        bestMatch = { ...fileRef, index: matchIndex, fileRefIndex };
      }
    }
    return bestMatch;
  }

  function buildFileRefButtonHtml(label, escapeHtmlFn, attrs = {}) {
    const safeLabel = escapeHtmlFn(label);
    const attrText = Object.entries(attrs)
      .filter(([, value]) => value != null && String(value).trim())
      .map(([key, value]) => ` ${key}="${escapeHtmlFn(String(value))}"`)
      .join("");
    return `<button type="button" class="message-file-ref"${attrText} aria-label="Open file preview for ${safeLabel}">${safeLabel}</button>`;
  }

  function splitTrailingPunctuation(rawText) {
    const value = String(rawText || "");
    const match = value.match(/^(.*?)([\]),.;!?"'`>]+)?$/);
    if (!match) {
      return { core: value, trailing: "" };
    }
    return {
      core: String(match[1] || ""),
      trailing: String(match[2] || ""),
    };
  }

  const SPECIAL_BARE_FILENAMES = new Set([
    "dockerfile",
    "makefile",
    "procfile",
    "containerfile",
    "jenkinsfile",
    "vagrantfile",
    "brewfile",
    "gemfile",
    "rakefile",
    "justfile",
    "tiltfile",
    "readme",
    "license",
  ]);

  function isSupportedBareFilename(value) {
    const candidate = String(value || "").trim();
    if (!candidate) return false;
    if (/^(?:[A-Za-z0-9][A-Za-z0-9._-]*\.(?:py|js|mjs|cjs|ts|tsx|jsx|json|md|yaml|yml|toml|txt|sh|go|rs|java|c|cc|cpp|h|hpp|css|scss|html|htm|sql|ini|cfg|conf|env|lock|csv|tsv|log)|\.[A-Za-z0-9][A-Za-z0-9._-]*)$/i.test(candidate)) {
      return true;
    }
    const lowered = candidate.toLowerCase();
    if (SPECIAL_BARE_FILENAMES.has(lowered)) return true;
    const dotIndex = lowered.indexOf(".");
    return dotIndex > 0 && SPECIAL_BARE_FILENAMES.has(lowered.slice(0, dotIndex));
  }

  function isSupportedInlinePath(pathText, { hasLineHint = false } = {}) {
    const candidate = String(pathText || "").trim();
    if (!candidate) return false;
    if (candidate.includes("://")) return false;
    if (candidate.startsWith("//")) return false;
    const basenameSupported = (value) => isSupportedBareFilename(String(value || "").split("/").pop());
    if (candidate.startsWith("/")) return Boolean(hasLineHint || basenameSupported(candidate));
    if (candidate.startsWith("~/")) return candidate.length > 2 && Boolean(hasLineHint || basenameSupported(candidate));
    if (candidate.startsWith("./")) return candidate.length > 2 && Boolean(hasLineHint || basenameSupported(candidate));
    if (candidate.startsWith("../")) return candidate.length > 3 && Boolean(hasLineHint || basenameSupported(candidate));
    if (/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(candidate)) return Boolean(hasLineHint || basenameSupported(candidate));
    return isSupportedBareFilename(candidate);
  }

  function parseInlinePathRef(rawText) {
    const trimmed = String(rawText || "").trim();
    if (!trimmed) return null;

    const { core, trailing } = splitTrailingPunctuation(trimmed);
    let pathPart = core;
    let lineStart = 0;
    let lineEnd = 0;

    const hashMatch = pathPart.match(/^(.*)#L?(\d+)(?:-L?(\d+))?$/i);
    if (hashMatch) {
      pathPart = String(hashMatch[1] || "");
      lineStart = Number(hashMatch[2] || 0);
      lineEnd = Number(hashMatch[3] || 0);
    } else {
      const lineSpecMatch = pathPart.match(/^(.+?):L?(\d+)(?::\d+)?(?:-(?:L)?(\d+)(?::\d+)?)?$/i);
      if (lineSpecMatch) {
        pathPart = String(lineSpecMatch[1] || "");
        lineStart = Number(lineSpecMatch[2] || 0);
        lineEnd = Number(lineSpecMatch[3] || 0);
      }
    }

    let path = String(pathPart || "").trim();
    if (path.toLowerCase().startsWith("file://")) {
      path = path.slice(7);
    }
    const hasLineHint = lineStart > 0 || lineEnd > 0;
    if (!isSupportedInlinePath(path, { hasLineHint })) return null;

    const normalizedLineStart = Number.isFinite(lineStart) && lineStart > 0 ? Math.floor(lineStart) : 0;
    const normalizedLineEnd = Number.isFinite(lineEnd) && lineEnd > 0 ? Math.floor(lineEnd) : 0;
    return {
      path,
      lineStart: normalizedLineStart,
      lineEnd: normalizedLineEnd,
      trailing,
    };
  }

  function isLikelyUrlPathMatch(text, startIndex) {
    const index = Number(startIndex || 0);
    if (!Number.isFinite(index) || index <= 0) return false;
    let tokenStart = index;
    while (tokenStart > 0 && !/\s/.test(text[tokenStart - 1])) {
      tokenStart -= 1;
    }
    const tokenPrefix = text.slice(tokenStart, index);
    if (tokenPrefix.includes("://")) return true;
    if (index > 0 && text[index - 1] === ":" && text[index] === "/" && text[index + 1] === "/") {
      return /^[a-z][a-z0-9+.-]*$/i.test(tokenPrefix);
    }
    return false;
  }

  function normalizeAllowedRoots(allowedRoots) {
    if (!Array.isArray(allowedRoots)) return [];
    const roots = [];
    for (const root of allowedRoots) {
      const value = String(root || "").trim();
      if (!value || !value.startsWith("/")) continue;
      roots.push(value.endsWith("/") && value.length > 1 ? value.slice(0, -1) : value);
    }
    return roots;
  }

  function isPathAllowedByRoots(pathText, allowedRoots) {
    const candidate = String(pathText || "").trim();
    if (!candidate || !candidate.startsWith("/")) return false;
    const normalizedRoots = normalizeAllowedRoots(allowedRoots);
    if (!normalizedRoots.length) return false;
    return normalizedRoots.some((root) => candidate === root || candidate.startsWith(`${root}/`));
  }

  function renderPlainTextWithInlinePathFallback(text, escapeHtmlFn, { allowedRoots = [] } = {}) {
    const pattern = /(?:(?:file:\/\/)?\/(?:[^\s`<>"'(){}\[\],;]+)|(?:~\/|\.{1,2}\/|[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+))(?::L?\d+(?::\d+)?(?:-(?:L)?\d+(?::\d+)?)?)?(?:#L?\d+(?:-L?\d+)?)?[\]),.;!?"'`>]*/gi;
    let cursor = 0;
    let html = "";
    let match = pattern.exec(text);
    while (match) {
      const raw = String(match[0] || "");
      const start = Number(match.index || 0);
      if (start > cursor) {
        html += escapeHtmlFn(text.slice(cursor, start));
      }
      if (isLikelyUrlPathMatch(text, start)) {
        html += escapeHtmlFn(raw);
        cursor = start + raw.length;
        match = pattern.exec(text);
        continue;
      }
      const parsed = parseInlinePathRef(raw);
      const canPreview = parsed && isPathAllowedByRoots(parsed.path, allowedRoots);
      if (!parsed || !canPreview || (!parsed.path.includes(".") && parsed.lineStart <= 0 && parsed.lineEnd <= 0)) {
        html += escapeHtmlFn(raw);
      } else {
        const label = raw.endsWith(parsed.trailing || "")
          ? raw.slice(0, raw.length - String(parsed.trailing || "").length)
          : raw;
        html += buildFileRefButtonHtml(label, escapeHtmlFn, {
          "data-file-path": parsed.path,
          "data-file-line-start": parsed.lineStart > 0 ? String(parsed.lineStart) : "",
          "data-file-line-end": parsed.lineEnd > 0 ? String(parsed.lineEnd) : "",
        });
        if (parsed.trailing) {
          html += escapeHtmlFn(parsed.trailing);
        }
      }
      cursor = start + raw.length;
      match = pattern.exec(text);
    }
    if (cursor < text.length) {
      html += escapeHtmlFn(text.slice(cursor));
    }
    return html.replace(/\n/g, "<br>");
  }

  function renderPlainTextWithFileRefs(text, fileRefs, escapeHtmlFn, { allowedRoots = [] } = {}) {
    const refs = normalizeFileRefs(fileRefs);
    if (!refs.length) {
      return escapeHtmlFn(text).replace(/\n/g, "<br>");
    }

    let html = "";
    let cursor = 0;
    const remainingRefs = refs.slice();
    while (cursor < text.length) {
      const match = chooseNextFileRefMatch(text, cursor, remainingRefs);
      if (!match) {
        html += escapeHtmlFn(text.slice(cursor));
        break;
      }
      if (match.index > cursor) {
        html += escapeHtmlFn(text.slice(cursor, match.index));
      }
      const parsed = parseInlinePathRef(match.rawText);
      const trailing = String(parsed?.trailing || "");
      const label = trailing && match.rawText.endsWith(trailing)
        ? match.rawText.slice(0, match.rawText.length - trailing.length)
        : match.rawText;
      html += buildFileRefButtonHtml(label, escapeHtmlFn, {
        "data-file-ref-id": match.refId,
        "data-file-path": match.resolvedPath,
        "data-file-line-start": match.lineStart > 0 ? String(match.lineStart) : "",
        "data-file-line-end": match.lineEnd > 0 ? String(match.lineEnd) : "",
      });
      if (trailing) {
        html += escapeHtmlFn(trailing);
      }
      cursor = match.index + match.rawText.length;
      remainingRefs.splice(match.fileRefIndex, 1);
    }

    return html.replace(/\n/g, "<br>");
  }

  function renderAttachmentsHtml(attachments, escapeHtmlFn, buildAttachmentUrlFn) {
    if (!Array.isArray(attachments) || !attachments.length) {
      return "";
    }
    const items = [];
    attachments.forEach((attachment) => {
      if (!attachment || typeof attachment !== "object") return;
      const id = String(attachment.id || "").trim();
      const filename = String(attachment.filename || "").trim() || "attachment";
      const kind = String(attachment.kind || "file").trim() || "file";
      const rawHref = String(attachment.preview_url || attachment.download_url || "").trim();
      const href = typeof buildAttachmentUrlFn === "function" ? buildAttachmentUrlFn(rawHref) : rawHref;
      if (!id || !href) return;
      const contentType = String(attachment.content_type || "application/octet-stream").trim() || "application/octet-stream";
      const sizeBytes = Number(attachment.size_bytes || 0);
      const sizeLabel = Number.isFinite(sizeBytes) && sizeBytes > 0
        ? (sizeBytes >= 1024 * 1024 ? `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB` : sizeBytes >= 1024 ? `${Math.round(sizeBytes / 102.4) / 10} KB` : `${sizeBytes} B`)
        : "";
      const metaBits = [kind === "image" ? "image" : contentType, sizeLabel].filter(Boolean).join(" · ");
      if (kind === "image") {
        items.push(
          `<a class="message-attachment message-attachment--image" href="${escapeHtmlFn(href)}" target="_blank" rel="noopener noreferrer">`
          + `<img class="message-attachment__thumb" src="${escapeHtmlFn(href)}" alt="${escapeHtmlFn(filename)}">`
          + `<span class="message-attachment__label">${escapeHtmlFn(filename)}</span>`
          + (metaBits ? `<span class="message-attachment__meta">${escapeHtmlFn(metaBits)}</span>` : "")
          + `</a>`
        );
        return;
      }
      items.push(
        `<a class="message-attachment" href="${escapeHtmlFn(href)}" target="_blank" rel="noopener noreferrer">`
        + `<span class="message-attachment__label">${escapeHtmlFn(filename)}</span>`
        + (metaBits ? `<span class="message-attachment__meta">${escapeHtmlFn(metaBits)}</span>` : "")
        + `</a>`
      );
    });
    if (!items.length) return "";
    return `<div class="message-attachments">${items.join("")}</div>`;
  }

  function renderBody(container, rawText, {
    cleanDisplayTextFn,
    escapeHtmlFn,
    fileRefs = null,
    attachments = [],
    buildAttachmentUrlFn = null,
    allowedRoots = [],
  } = {}) {
    if (!container || typeof cleanDisplayTextFn !== "function" || typeof escapeHtmlFn !== "function") return;
    const text = cleanDisplayTextFn(rawText);
    const fenced = text.includes("```");
    const attachmentsHtml = renderAttachmentsHtml(attachments, escapeHtmlFn, buildAttachmentUrlFn);
    if (!fenced) {
      const bodyHtml = renderPlainTextWithFileRefs(text, fileRefs, escapeHtmlFn, { allowedRoots });
      container.innerHTML = [bodyHtml, attachmentsHtml].filter(Boolean).join("");
      return;
    }

    const fragments = text.split("```");
    const parts = [];
    fragments.forEach((fragment, index) => {
      if (index % 2 === 0) {
        const rendered = renderPlainTextWithFileRefs(fragment, fileRefs, escapeHtmlFn, { allowedRoots });
        if (rendered) parts.push(`<div>${rendered}</div>`);
        return;
      }
      const trimmed = fragment.replace(/^\n/, "");
      const lines = trimmed.split("\n");
      const maybeLang = lines[0].trim();
      const code = lines.slice(1).join("\n").trimEnd() || trimmed;
      const renderedCode = renderPlainTextWithFileRefs(code, fileRefs, escapeHtmlFn, { allowedRoots });
      parts.push(`<pre class="code-block" data-lang="${escapeHtmlFn(maybeLang)}"><code>${renderedCode}</code></pre>`);
    });
    if (attachmentsHtml) {
      parts.push(attachmentsHtml);
    }
    container.innerHTML = parts.join("");
  }

  const api = {
    parseInlinePathRef,
    isPathAllowedByRoots,
    renderPlainTextWithInlinePathFallback,
    renderPlainTextWithFileRefs,
    renderBody,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.HermesMiniappRenderTraceText = api;
})(typeof window !== "undefined" ? window : globalThis);
