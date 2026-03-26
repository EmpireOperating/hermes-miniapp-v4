(function initHermesMiniappSharedUtils(global) {
  const MESSAGE_TIMEZONE = "America/Regina";
  const REGINA_FIXED_OFFSET_MINUTES = -6 * 60;

  function parseSseEvent(rawChunk) {
    const chunk = (rawChunk || "").trim();
    if (!chunk) return null;
    const lines = chunk.split("\n");
    let event = "message";
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice(6).trim() || "message";
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trim());
      }
    }
    if (!dataLines.length) return null;
    const payload = dataLines.join("\n");
    try {
      return { event, payload: JSON.parse(payload) };
    } catch {
      return { event, payload: { text: payload } };
    }
  }

  function buildMessageTimeFormatter() {
    try {
      const formatter = new Intl.DateTimeFormat([], {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
        timeZone: MESSAGE_TIMEZONE,
      });
      const resolvedZone = formatter.resolvedOptions?.().timeZone;
      return { formatter, supportsReginaZone: resolvedZone === MESSAGE_TIMEZONE };
    } catch {
      return { formatter: null, supportsReginaZone: false };
    }
  }

  const { formatter: messageTimeFormatter, supportsReginaZone } = buildMessageTimeFormatter();

  function parseMessageTimestamp(rawValue) {
    if (!rawValue) return null;
    const value = String(rawValue).trim();
    if (!value) return null;

    const match = value.match(
      /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,6}))?)?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i,
    );
    if (match) {
      const [, year, month, day, hour, minute, second = "00", fraction = "", rawTz = ""] = match;
      const millis = Number((fraction || "").slice(0, 3).padEnd(3, "0"));
      let epochMs = Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
        millis,
      );

      if (rawTz && rawTz.toUpperCase() !== "Z") {
        const tz = rawTz.replace(":", "");
        const sign = tz.startsWith("-") ? -1 : 1;
        const tzHours = Number(tz.slice(1, 3));
        const tzMinutes = Number(tz.slice(3, 5));
        const offsetMinutes = sign * ((tzHours * 60) + tzMinutes);
        epochMs -= offsetMinutes * 60_000;
      }

      // No timezone in DB values means SQLite CURRENT_TIMESTAMP in UTC.
      return new Date(epochMs);
    }

    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return null;
    return parsed;
  }

  function formatReginaTimeFallback(date) {
    const shifted = new Date(date.getTime() + (REGINA_FIXED_OFFSET_MINUTES * 60_000));
    const hours = String(shifted.getUTCHours()).padStart(2, "0");
    const minutes = String(shifted.getUTCMinutes()).padStart(2, "0");
    return `${hours}:${minutes}`;
  }

  function formatMessageTime(rawValue) {
    const parsed = parseMessageTimestamp(rawValue) || new Date();
    if (messageTimeFormatter && supportsReginaZone) {
      return messageTimeFormatter.format(parsed);
    }
    return formatReginaTimeFallback(parsed);
  }

  function nowStamp() {
    return formatMessageTime(new Date().toISOString());
  }

  function formatLatency(msValue) {
    const ms = Number(msValue);
    if (!Number.isFinite(ms) || ms < 0) return "--";
    if (ms < 1000) return `${Math.round(ms)} ms`;

    const totalSeconds = Math.round(ms / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
    if (minutes > 0) return `${minutes}m ${seconds}s`;
    return `${seconds}s`;
  }

  function escapeHtml(input) {
    return (input || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#39;");
  }

  function cleanDisplayText(rawText) {
    const text = String(rawText || "");
    const lines = text.split("\n");
    const kept = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (/^session_id\s*:/i.test(trimmed)) continue;
      if (/^\d{8}_\d{6}_[a-z0-9]+$/i.test(trimmed)) continue;
      kept.push(line);
    }

    return kept.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function legacyCopyTextToClipboard(text) {
    const selection = global.getSelection?.();
    const previousRanges = [];
    if (selection && selection.rangeCount > 0) {
      for (let index = 0; index < selection.rangeCount; index += 1) {
        previousRanges.push(selection.getRangeAt(index).cloneRange());
      }
    }

    const restoreSelection = () => {
      if (!selection) return;
      try {
        selection.removeAllRanges();
        for (const range of previousRanges) {
          selection.addRange(range);
        }
      } catch {
        // Selection restoration is best-effort only.
      }
    };

    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    textarea.style.pointerEvents = "none";
    // Keep the element in-viewport for iOS/WebView copy reliability.
    textarea.style.left = "0";
    textarea.style.top = "0";
    textarea.style.width = "1px";
    textarea.style.height = "1px";

    let copied = false;
    try {
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);
      copied = document.execCommand("copy");
    } catch {
      copied = false;
    } finally {
      textarea.remove();
    }

    if (!copied) {
      // Some iOS/WebView variants are unreliable with textarea selection but
      // work with a contenteditable element and explicit range selection.
      const probe = document.createElement("div");
      probe.textContent = text;
      probe.setAttribute("contenteditable", "true");
      probe.style.position = "fixed";
      probe.style.opacity = "0";
      probe.style.pointerEvents = "none";
      probe.style.left = "0";
      probe.style.top = "0";
      probe.style.whiteSpace = "pre-wrap";

      try {
        document.body.appendChild(probe);
        const range = document.createRange();
        range.selectNodeContents(probe);
        selection?.removeAllRanges?.();
        selection?.addRange?.(range);
        copied = document.execCommand("copy");
      } catch {
        copied = false;
      } finally {
        probe.remove();
      }
    }

    restoreSelection();
    return copied;
  }

  async function copyTextToClipboard(rawText) {
    const text = String(rawText || "");
    if (!text) return false;

    // Try legacy copy first while still inside the direct pointer gesture.
    if (legacyCopyTextToClipboard(text)) {
      return true;
    }

    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
        return true;
      } catch {
        return false;
      }
    }

    return false;
  }

  global.HermesMiniappSharedUtils = {
    parseSseEvent,
    formatMessageTime,
    nowStamp,
    formatLatency,
    escapeHtml,
    cleanDisplayText,
    copyTextToClipboard,
  };
})(window);
