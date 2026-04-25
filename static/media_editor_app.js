(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
    return;
  }
  root.HermesMediaEditorApp = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function createController({
    documentObject,
    titleNode,
    trackListNode,
    emptyStateNode,
    inspectorNode,
    suggestionListNode,
    assetBinNode,
    exportPanelNode,
    previewStageNode,
    playheadTimeNode,
    scrubberNode,
    playButton,
    addTextButton,
    addImageButton,
    addAudioButton,
    addVideoButton,
    submitOperation,
    submitSuggestionAction,
    submitImageUpload,
    submitAudioUpload,
    submitVideoUpload,
    submitHistoryAction,
    submitExportAction,
    fetchFn,
    promptFn = typeof prompt === 'function' ? prompt.bind(globalThis) : null,
    initData,
    chatId,
    imageFileInput = null,
    audioFileInput = null,
    videoFileInput = null,
    visualDevBridge = null,
    nowFn = () => Date.now(),
    setIntervalFn = (handler, intervalMs) => setInterval(handler, intervalMs),
    clearIntervalFn = (intervalId) => clearInterval(intervalId),
  }) {
    const doc = documentObject || (typeof document !== 'undefined' ? document : null);
    const request = fetchFn || (typeof fetch === 'function' ? fetch.bind(globalThis) : null);
    let state = { project: {}, tracks: [], assets: [], clips: [], suggestion_batches: [], export_jobs: [] };
    let selectedClipId = '';
    let copiedClipId = '';
    let playheadMs = 0;
    let isPlaying = false;
    let playbackIntervalId = null;
    let playbackStartedAtMs = 0;
    let playbackStartPlayheadMs = 0;
    let isExporting = false;
    let exportErrorMessage = '';

    function clearChildren(node) {
      if (!node) {
        return;
      }
      if (Array.isArray(node.children)) {
        node.children.length = 0;
        return;
      }
      while (node.firstChild) {
        node.removeChild(node.firstChild);
      }
      if ('innerHTML' in node) {
        node.innerHTML = '';
      }
    }

    function clipLabel(clip) {
      const params = clip && clip.params && typeof clip.params === 'object' ? clip.params : {};
      return String(params.text || clip.kind || 'Clip');
    }

    function projectDurationMs() {
      const explicitDuration = Number(state.project && state.project.duration_ms);
      const clipEnd = state.clips.reduce((maxEnd, clip) => {
        const endMs = Number(clip.start_ms || 0) + Number(clip.duration_ms || 0);
        return Math.max(maxEnd, endMs);
      }, 0);
      const defaultAuthoringDurationMs = 60000;
      return Math.max(Number.isFinite(explicitDuration) ? explicitDuration : defaultAuthoringDurationMs, clipEnd, 1);
    }

    function formatTime(ms) {
      return `${(Math.max(Number(ms || 0), 0) / 1000).toFixed(2)}s`;
    }

    function clampPlayhead(ms) {
      const duration = projectDurationMs();
      return Math.min(Math.max(Number(ms || 0), 0), duration);
    }

    function isClipActiveAtPlayhead(clip) {
      const startMs = Number(clip.start_ms || 0);
      const endMs = startMs + Number(clip.duration_ms || 0);
      return playheadMs >= startMs && playheadMs < endMs;
    }

    function activeTextClips() {
      return state.clips.filter((clip) => String(clip.kind || '') === 'text' && isClipActiveAtPlayhead(clip));
    }

    function activeImageClips() {
      return state.clips.filter((clip) => String(clip.kind || '') === 'image' && isClipActiveAtPlayhead(clip));
    }

    function activeVideoClips() {
      return state.clips.filter((clip) => String(clip.kind || '') === 'video' && isClipActiveAtPlayhead(clip));
    }

    function activeAudioClips() {
      return state.clips.filter((clip) => String(clip.kind || '') === 'audio' && isClipActiveAtPlayhead(clip));
    }

    function withInitData(url) {
      const rawUrl = String(url || '');
      if (!rawUrl || !initData || !rawUrl.startsWith('/')) {
        return rawUrl;
      }
      const separator = rawUrl.includes('?') ? '&' : '?';
      return `${rawUrl}${separator}init_data=${encodeURIComponent(initData)}`;
    }

    function assetForClip(clip) {
      return state.assets.find((asset) => String(asset.asset_id || '') === String(clip.asset_id || '')) || null;
    }

    function renderPreview() {
      if (playheadTimeNode) {
        playheadTimeNode.textContent = `${formatTime(playheadMs)} / ${formatTime(projectDurationMs())}`;
      }
      if (scrubberNode) {
        scrubberNode.value = String(Math.round(playheadMs));
        scrubberNode.max = String(Math.round(projectDurationMs()));
        if (typeof scrubberNode.setAttribute === 'function') {
          scrubberNode.setAttribute('max', String(Math.round(projectDurationMs())));
          scrubberNode.setAttribute('aria-valuenow', String(Math.round(playheadMs)));
        }
      }
      if (playButton) {
        playButton.textContent = isPlaying ? 'Pause' : 'Play';
      }
      clearChildren(previewStageNode);
      if (!doc || !previewStageNode || typeof previewStageNode.appendChild !== 'function') {
        return;
      }
      activeVideoClips().forEach((clip) => {
        const asset = assetForClip(clip);
        if (!asset || !asset.storage_path) {
          return;
        }
        const video = doc.createElement('video');
        video.className = 'media-editor__preview-video';
        video.dataset.clipId = String(clip.clip_id || '');
        video.src = withInitData(asset.storage_path);
        video.muted = true;
        video.playsInline = true;
        const sourceOffsetMs = Number(clip.source_in_ms || 0) + Math.max(playheadMs - Number(clip.start_ms || 0), 0);
        video.currentTime = Math.max(sourceOffsetMs / 1000, 0);
        previewStageNode.appendChild(video);
        if (isPlaying && typeof video.play === 'function') {
          video.play().catch?.(() => {});
        }
      });
      activeImageClips().forEach((clip) => {
        const asset = assetForClip(clip);
        if (!asset || !asset.storage_path) {
          return;
        }
        const image = doc.createElement('img');
        image.className = 'media-editor__preview-image';
        image.dataset.clipId = String(clip.clip_id || '');
        image.src = withInitData(asset.storage_path);
        image.alt = String(asset.label || clipLabel(clip) || 'Image clip');
        previewStageNode.appendChild(image);
      });
      activeAudioClips().forEach((clip) => {
        const asset = assetForClip(clip);
        if (!asset || !asset.storage_path) {
          return;
        }
        const audio = doc.createElement('audio');
        audio.className = 'media-editor__preview-audio';
        audio.dataset.clipId = String(clip.clip_id || '');
        audio.src = withInitData(asset.storage_path);
        audio.controls = true;
        const params = clip && clip.params && typeof clip.params === 'object' ? clip.params : {};
        const sourceOffsetMs = Number(clip.source_in_ms || 0) + Math.max(playheadMs - Number(clip.start_ms || 0), 0);
        audio.currentTime = Math.max(sourceOffsetMs / 1000, 0);
        audio.volume = Math.min(Math.max(Number(params.gain ?? 1), 0), 1);
        previewStageNode.appendChild(audio);
        if (isPlaying && typeof audio.play === 'function') {
          audio.play().catch?.(() => {});
        }
      });
      activeTextClips().forEach((clip) => {
        const title = doc.createElement('div');
        title.className = 'media-editor__preview-text';
        title.dataset.clipId = String(clip.clip_id || '');
        title.textContent = clipLabel(clip);
        previewStageNode.appendChild(title);
      });
    }

    function setPlayheadMs(nextPlayheadMs) {
      playheadMs = clampPlayhead(nextPlayheadMs);
      renderPreview();
      return playheadMs;
    }

    function stopPlayback() {
      if (playbackIntervalId !== null) {
        clearIntervalFn(playbackIntervalId);
        playbackIntervalId = null;
      }
      isPlaying = false;
      renderPreview();
    }

    function tickPlayback() {
      const elapsedMs = Math.max(Number(nowFn()) - playbackStartedAtMs, 0);
      const nextPlayheadMs = playbackStartPlayheadMs + elapsedMs;
      const duration = projectDurationMs();
      if (nextPlayheadMs >= duration) {
        setPlayheadMs(duration);
        stopPlayback();
        return;
      }
      setPlayheadMs(nextPlayheadMs);
    }

    function startPlayback() {
      if (isPlaying) {
        return;
      }
      if (playheadMs >= projectDurationMs()) {
        playheadMs = 0;
      }
      isPlaying = true;
      playbackStartedAtMs = Number(nowFn());
      playbackStartPlayheadMs = playheadMs;
      playbackIntervalId = setIntervalFn(tickPlayback, 100);
      renderPreview();
    }

    function togglePlayback() {
      if (isPlaying) {
        stopPlayback();
      } else {
        startPlayback();
      }
    }

    function clipSelectionPayload(clip) {
      if (!clip) {
        return null;
      }
      return {
        selectionType: 'media_editor_clip',
        label: clipLabel(clip),
        selector: `media-editor-clip:${String(clip.clip_id || '')}`,
        tagName: 'media-editor-clip',
        text: clipLabel(clip),
        clip_id: String(clip.clip_id || ''),
        track_id: String(clip.track_id || ''),
        clip_kind: String(clip.kind || ''),
        start_ms: Number(clip.start_ms || 0),
        duration_ms: Number(clip.duration_ms || 0),
        params: clip && clip.params && typeof clip.params === 'object' ? { ...clip.params } : {},
      };
    }

    function reportSelectedClip(clip) {
      const payload = clipSelectionPayload(clip);
      if (!payload || typeof visualDevBridge?.reportSelection !== 'function') {
        return;
      }
      visualDevBridge.reportSelection(payload);
    }

    function renderInspector() {
      if (!inspectorNode) {
        return;
      }
      const clip = state.clips.find((candidate) => String(candidate.clip_id) === String(selectedClipId));
      if (!clip) {
        inspectorNode.textContent = 'Select a clip to inspect timing and text.';
        return;
      }
      const sourceInMs = Math.max(Number(clip.source_in_ms || 0), 0);
      const sourceOutMs = Math.max(Number(clip.source_out_ms || 0), 0);
      const sourceSummary = sourceInMs || sourceOutMs ? ` • source ${sourceInMs}–${sourceOutMs}ms` : '';
      inspectorNode.textContent = `${clipLabel(clip)} • start ${Number(clip.start_ms || 0)}ms • duration ${Number(clip.duration_ms || 0)}ms${sourceSummary}`;
      if (!doc || !inspectorNode.appendChild) {
        return;
      }
      const params = clip && clip.params && typeof clip.params === 'object' ? clip.params : {};
      const textInput = doc.createElement('input');
      textInput.value = String(params.text || '');
      textInput.placeholder = 'Text';
      textInput.className = 'media-editor__input';
      const startInput = doc.createElement('input');
      startInput.value = String(Number(clip.start_ms || 0));
      startInput.placeholder = 'Start ms';
      startInput.className = 'media-editor__input';
      const durationInput = doc.createElement('input');
      durationInput.value = String(Number(clip.duration_ms || 0));
      durationInput.placeholder = 'Duration ms';
      durationInput.className = 'media-editor__input';
      const sourceInInput = doc.createElement('input');
      sourceInInput.value = String(sourceInMs);
      sourceInInput.placeholder = 'Source in ms';
      sourceInInput.className = 'media-editor__input';
      const sourceOutInput = doc.createElement('input');
      sourceOutInput.value = String(sourceOutMs);
      sourceOutInput.placeholder = 'Source out ms';
      sourceOutInput.className = 'media-editor__input';
      const saveButton = doc.createElement('button');
      saveButton.type = 'button';
      saveButton.className = 'media-editor__button';
      saveButton.textContent = 'Save clip';
      if (typeof saveButton.addEventListener === 'function') {
        saveButton.addEventListener('click', () => {
          updateSelectedClip({
            text: textInput.value,
            start_ms: Number(startInput.value || 0),
            duration_ms: Number(durationInput.value || 1),
            source_in_ms: Number(sourceInInput.value || 0),
            source_out_ms: Number(sourceOutInput.value || 0),
          }).catch((error) => {
            inspectorNode.textContent = error && error.message ? error.message : 'Could not update clip.';
          });
        });
      }
      const deleteButton = doc.createElement('button');
      deleteButton.type = 'button';
      deleteButton.className = 'media-editor__button';
      deleteButton.textContent = 'Delete clip';
      if (typeof deleteButton.addEventListener === 'function') {
        deleteButton.addEventListener('click', () => {
          deleteSelectedClip().catch((error) => {
            inspectorNode.textContent = error && error.message ? error.message : 'Could not delete clip.';
          });
        });
      }
      const duplicateButton = doc.createElement('button');
      duplicateButton.type = 'button';
      duplicateButton.className = 'media-editor__button';
      duplicateButton.textContent = 'Duplicate clip';
      if (typeof duplicateButton.addEventListener === 'function') {
        duplicateButton.addEventListener('click', () => {
          duplicateSelectedClip().catch((error) => {
            inspectorNode.textContent = error && error.message ? error.message : 'Could not duplicate clip.';
          });
        });
      }
      const splitButton = doc.createElement('button');
      splitButton.type = 'button';
      splitButton.className = 'media-editor__button';
      splitButton.textContent = 'Split at playhead';
      if (typeof splitButton.addEventListener === 'function') {
        splitButton.addEventListener('click', () => {
          splitSelectedClip().catch((error) => {
            inspectorNode.textContent = error && error.message ? error.message : 'Could not split clip.';
          });
        });
      }
      const copyButton = doc.createElement('button');
      copyButton.type = 'button';
      copyButton.className = 'media-editor__button';
      copyButton.textContent = 'Copy clip';
      if (typeof copyButton.addEventListener === 'function') {
        copyButton.addEventListener('click', () => {
          copySelectedClip();
          renderInspector();
        });
      }
      const pasteButton = doc.createElement('button');
      pasteButton.type = 'button';
      pasteButton.className = 'media-editor__button';
      pasteButton.textContent = copiedClipId ? 'Paste clip at playhead' : 'Paste clip';
      pasteButton.disabled = copiedClipId ? false : true;
      if (typeof pasteButton.addEventListener === 'function') {
        pasteButton.addEventListener('click', () => {
          pasteCopiedClip().catch((error) => {
            inspectorNode.textContent = error && error.message ? error.message : 'Could not paste clip.';
          });
        });
      }
      const undoButton = doc.createElement('button');
      undoButton.type = 'button';
      undoButton.className = 'media-editor__button';
      undoButton.textContent = 'Undo';
      if (typeof undoButton.addEventListener === 'function') {
        undoButton.addEventListener('click', () => {
          undoTimelineEdit().catch((error) => {
            inspectorNode.textContent = error && error.message ? error.message : 'Could not undo edit.';
          });
        });
      }
      const redoButton = doc.createElement('button');
      redoButton.type = 'button';
      redoButton.className = 'media-editor__button';
      redoButton.textContent = 'Redo';
      if (typeof redoButton.addEventListener === 'function') {
        redoButton.addEventListener('click', () => {
          redoTimelineEdit().catch((error) => {
            inspectorNode.textContent = error && error.message ? error.message : 'Could not redo edit.';
          });
        });
      }
      inspectorNode.appendChild(textInput);
      inspectorNode.appendChild(startInput);
      inspectorNode.appendChild(durationInput);
      inspectorNode.appendChild(sourceInInput);
      inspectorNode.appendChild(sourceOutInput);
      inspectorNode.appendChild(saveButton);
      inspectorNode.appendChild(deleteButton);
      inspectorNode.appendChild(duplicateButton);
      inspectorNode.appendChild(splitButton);
      inspectorNode.appendChild(copyButton);
      inspectorNode.appendChild(pasteButton);
      inspectorNode.appendChild(undoButton);
      inspectorNode.appendChild(redoButton);
    }


    function suggestionSummary(batch) {
      const operations = Array.isArray(batch && batch.operations) ? batch.operations : [];
      const count = operations.length;
      const editWord = count === 1 ? 'edit' : 'edits';
      const summary = String((batch && batch.summary) || 'Review proposed timeline changes');
      return `Hermes suggested ${count} timeline ${editWord}: ${summary}`;
    }

    function trackLabelForId(trackId) {
      const track = state.tracks.find((candidate) => String(candidate.track_id || '') === String(trackId || ''));
      return String((track && (track.label || track.kind)) || trackId || 'track');
    }

    function clipById(clipId) {
      return state.clips.find((candidate) => String(candidate.clip_id || '') === String(clipId || '')) || null;
    }

    function timingRange(startMs, durationMs) {
      const start = Math.max(Math.round(Number(startMs || 0)), 0);
      const duration = Math.max(Math.round(Number(durationMs || 0)), 0);
      return `${start}–${start + duration}ms`;
    }

    function quoted(value) {
      return `“${String(value || '')}”`;
    }

    function describeSuggestionOperation(operation) {
      const kind = String(operation && operation.kind || 'operation');
      const payload = operation && operation.payload && typeof operation.payload === 'object' ? operation.payload : {};
      if (kind === 'create_text_clip') {
        const text = String(payload.text || payload.params?.text || 'Text clip');
        return `Create text clip ${quoted(text)} on ${trackLabelForId(payload.track_id)} at ${timingRange(payload.start_ms, payload.duration_ms)}`;
      }
      if (kind === 'create_image_clip') {
        const label = String(payload.label || payload.storage_path || 'Image clip');
        return `Create image clip ${label} on ${trackLabelForId(payload.track_id)} at ${timingRange(payload.start_ms, payload.duration_ms)}`;
      }
      if (kind === 'create_audio_clip') {
        const label = String(payload.label || payload.storage_path || 'Audio clip');
        return `Create audio clip ${label} on ${trackLabelForId(payload.track_id)} at ${timingRange(payload.start_ms, payload.duration_ms)}`;
      }
      if (kind === 'create_video_clip') {
        const label = String(payload.label || payload.storage_path || 'Video clip');
        return `Create video clip ${label} on ${trackLabelForId(payload.track_id)} at ${timingRange(payload.start_ms, payload.duration_ms)}`;
      }
      if (kind === 'create_clip_from_asset') {
        const asset = state.assets.find((candidate) => String(candidate.asset_id || '') === String(payload.asset_id || ''));
        const label = asset ? assetLabel(asset) : String(payload.asset_id || 'Image asset');
        return `Place asset ${label} on ${trackLabelForId(payload.track_id)} at ${timingRange(payload.start_ms, payload.duration_ms)}`;
      }
      if (kind === 'duplicate_clip') {
        const clip = clipById(payload.clip_id || payload.source_clip_id);
        const label = clip ? clipLabel(clip) : String(payload.clip_id || payload.source_clip_id || 'unknown clip');
        const startMs = Object.prototype.hasOwnProperty.call(payload, 'start_ms') ? payload.start_ms : (clip ? Number(clip.start_ms || 0) + Number(clip.duration_ms || 0) : 0);
        const durationMs = Object.prototype.hasOwnProperty.call(payload, 'duration_ms') ? payload.duration_ms : (clip ? Number(clip.duration_ms || 0) : 0);
        return `Duplicate clip ${label} at ${timingRange(startMs, durationMs)}`;
      }
      if (kind === 'split_clip') {
        const clip = clipById(payload.clip_id);
        const label = clip ? clipLabel(clip) : String(payload.clip_id || 'unknown clip');
        const splitMs = Math.max(Math.round(Number(payload.split_ms || payload.playhead_ms || 0)), 0);
        return `Split clip ${label} at ${splitMs}ms`;
      }
      if (kind === 'delete_clip') {
        const clip = clipById(payload.clip_id);
        return `Delete clip ${clip ? clipLabel(clip) : String(payload.clip_id || 'unknown clip')}`;
      }
      if (kind === 'update_clip') {
        const clip = clipById(payload.clip_id);
        const currentParams = clip && clip.params && typeof clip.params === 'object' ? clip.params : {};
        const nextParams = payload.params && typeof payload.params === 'object' ? payload.params : {};
        const label = clip ? clipLabel(clip) : String(payload.clip_id || 'unknown clip');
        const parts = [`Update clip ${label}`];
        if (Object.prototype.hasOwnProperty.call(nextParams, 'text') && String(nextParams.text || '') !== String(currentParams.text || '')) {
          parts.push(`text ${quoted(currentParams.text || label)} → ${quoted(nextParams.text)}`);
        }
        const currentStart = clip ? Number(clip.start_ms || 0) : 0;
        const currentDuration = clip ? Number(clip.duration_ms || 0) : 0;
        const nextStart = Object.prototype.hasOwnProperty.call(payload, 'start_ms') ? Number(payload.start_ms || 0) : currentStart;
        const nextDuration = Object.prototype.hasOwnProperty.call(payload, 'duration_ms') ? Number(payload.duration_ms || 0) : currentDuration;
        if (nextStart !== currentStart || nextDuration !== currentDuration) {
          parts.push(`${timingRange(currentStart, currentDuration)} → ${timingRange(nextStart, nextDuration)}`);
        }
        return parts.join(': ');
      }
      return `${kind}: ${JSON.stringify(payload)}`;
    }

    function appendSuggestionInspector(batch, node) {
      const operations = Array.isArray(batch && batch.operations) ? batch.operations : [];
      if (!doc || !node || !operations.length) {
        return;
      }
      const inspector = doc.createElement('div');
      inspector.className = 'media-editor__suggestion-inspector';
      operations.forEach((operation, index) => {
        const row = doc.createElement('div');
        row.className = 'media-editor__suggestion-operation';
        row.dataset.operationIndex = String(index);
        row.textContent = describeSuggestionOperation(operation);
        inspector.appendChild(row);
      });
      node.appendChild(inspector);
    }

    function renderSuggestionBatches() {
      if (!suggestionListNode) {
        return;
      }
      clearChildren(suggestionListNode);
      const pendingBatches = state.suggestion_batches.filter((batch) => String(batch.status || 'pending') === 'pending');
      if (!pendingBatches.length) {
        suggestionListNode.textContent = 'No pending Hermes timeline suggestions.';
        return;
      }
      suggestionListNode.textContent = '';
      pendingBatches.forEach((batch) => {
        const node = doc && doc.createElement ? doc.createElement('article') : null;
        if (!node) {
          return;
        }
        node.className = 'media-editor__suggestion';
        node.dataset.batchId = String(batch.batch_id || '');
        node.textContent = suggestionSummary(batch);
        const acceptButton = doc.createElement('button');
        acceptButton.type = 'button';
        acceptButton.className = 'media-editor__button';
        acceptButton.textContent = 'Accept';
        if (typeof acceptButton.addEventListener === 'function') {
          acceptButton.addEventListener('click', () => applySuggestionAction(batch.batch_id, 'accept').catch((error) => {
            node.textContent = error && error.message ? error.message : 'Could not accept suggestion.';
          }));
        }
        const rejectButton = doc.createElement('button');
        rejectButton.type = 'button';
        rejectButton.className = 'media-editor__button';
        rejectButton.textContent = 'Reject';
        if (typeof rejectButton.addEventListener === 'function') {
          rejectButton.addEventListener('click', () => applySuggestionAction(batch.batch_id, 'reject').catch((error) => {
            node.textContent = error && error.message ? error.message : 'Could not reject suggestion.';
          }));
        }
        node.appendChild(acceptButton);
        node.appendChild(rejectButton);
        appendSuggestionInspector(batch, node);
        suggestionListNode.appendChild(node);
      });
    }

    function mediaAssets() {
      return state.assets.filter((asset) => {
        const kind = String(asset.kind || '');
        return kind === 'image' || kind === 'audio' || kind === 'video';
      });
    }

    function imageAssets() {
      return mediaAssets();
    }

    function assetLabel(asset) {
      return String(asset.label || asset.storage_path || asset.asset_id || 'Media asset');
    }

    async function placeAssetOnTimeline(asset) {
      const assetKind = String(asset && asset.kind || 'image');
      const targetKind = assetKind === 'audio' ? 'audio' : 'visual';
      const track = state.tracks.find((candidate) => String(candidate.kind) === targetKind) || state.tracks[0];
      if (!track) {
        throw new Error(`${targetKind} track is unavailable`);
      }
      const params = assetKind === 'audio' ? { gain: 1 } : { fit: 'cover' };
      return applyOperation({
        kind: 'create_clip_from_asset',
        payload: {
          track_id: track.track_id,
          asset_id: String(asset.asset_id || ''),
          start_ms: playheadMs,
          duration_ms: 3000,
          params,
        },
      });
    }

    function renderAssetBin() {
      if (!assetBinNode) {
        return;
      }
      clearChildren(assetBinNode);
      const assets = imageAssets();
      if (!assets.length) {
        assetBinNode.textContent = 'No media assets yet — upload an image, video, or audio file to build your library.';
        return;
      }
      assetBinNode.textContent = '';
      assets.forEach((asset) => {
        if (!doc || !doc.createElement || !assetBinNode.appendChild) {
          return;
        }
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'media-editor__asset-card';
        button.dataset.assetId = String(asset.asset_id || '');
        const assetKindLabel = String(asset.kind || 'media');
        button.textContent = `${assetLabel(asset)} ${assetKindLabel.charAt(0).toUpperCase()}${assetKindLabel.slice(1)}`;
        const label = doc.createElement('span');
        label.className = 'media-editor__asset-label';
        label.textContent = assetLabel(asset);
        if (asset.storage_path && String(asset.kind || '') === 'image') {
          const thumb = doc.createElement('img');
          thumb.className = 'media-editor__asset-thumb';
          thumb.src = withInitData(asset.storage_path);
          thumb.alt = assetLabel(asset);
          button.appendChild(thumb);
        } else if (String(asset.kind || '') === 'video') {
          const badge = doc.createElement('span');
          badge.className = 'media-editor__asset-thumb media-editor__asset-thumb--video';
          badge.textContent = 'Video';
          button.appendChild(badge);
        } else if (String(asset.kind || '') === 'audio') {
          const badge = doc.createElement('span');
          badge.className = 'media-editor__asset-thumb media-editor__asset-thumb--audio';
          badge.textContent = 'Audio';
          button.appendChild(badge);
        }
        button.appendChild(label);
        if (typeof button.addEventListener === 'function') {
          button.addEventListener('click', () => {
            placeAssetOnTimeline(asset).catch((error) => {
              assetBinNode.textContent = error && error.message ? error.message : 'Could not place asset on timeline.';
            });
          });
        }
        assetBinNode.appendChild(button);
      });
    }

    function exportJobError(job) {
      const metadata = job && job.metadata && typeof job.metadata === 'object' ? job.metadata : {};
      return String(metadata.error || metadata.detail || metadata.message || 'render failed');
    }

    function exportJobLabel(job, index = 0) {
      const status = String(job && job.status || 'queued');
      const ordinal = index === 0 ? 'Latest export' : `Export ${index + 1}`;
      if (status === 'rendering' || status === 'queued') {
        return `${ordinal}: Rendering…`;
      }
      if (status === 'failed') {
        return `${ordinal}: Failed: ${exportJobError(job)}`;
      }
      if (status === 'completed') {
        return `${ordinal}: completed${job && job.output_path ? ' Download mp4' : ''}`;
      }
      return `${ordinal}: ${status}`;
    }

    function hasActiveExport(jobs) {
      return isExporting || jobs.some((job) => {
        const status = String(job && job.status || '');
        return status === 'queued' || status === 'rendering';
      });
    }

    function renderExportPanel() {
      if (!exportPanelNode) {
        return;
      }
      clearChildren(exportPanelNode);
      const jobs = Array.isArray(state.export_jobs) ? state.export_jobs : [];
      const activeExport = hasActiveExport(jobs);
      const summaryParts = [];
      if (exportErrorMessage) {
        summaryParts.push(exportErrorMessage);
      }
      if (isExporting || activeExport) {
        summaryParts.push('Latest export: Rendering…');
      }
      if (jobs.length) {
        summaryParts.push('Recent exports');
        jobs.slice(0, 5).forEach((job, index) => summaryParts.push(exportJobLabel(job, index)));
      } else if (!summaryParts.length) {
        summaryParts.push('No exports yet.');
      }
      if (!doc || !exportPanelNode.appendChild) {
        exportPanelNode.textContent = summaryParts.join('\n');
        return;
      }
      const exportButton = doc.createElement('button');
      exportButton.type = 'button';
      exportButton.className = 'media-editor__button';
      exportButton.textContent = activeExport ? 'Rendering…' : 'Export mp4';
      if (typeof exportButton.setAttribute === 'function' && activeExport) {
        exportButton.setAttribute('disabled', 'disabled');
        exportButton.setAttribute('aria-busy', 'true');
      }
      exportButton.disabled = Boolean(activeExport);
      if (typeof exportButton.addEventListener === 'function') {
        exportButton.addEventListener('click', () => {
          if (activeExport) {
            return;
          }
          exportProject().catch((error) => {
            isExporting = false;
            exportPanelNode.textContent = error && error.message ? error.message : 'Could not export project.';
            renderExportPanel();
          });
        });
      }
      exportPanelNode.appendChild(exportButton);
      if (exportErrorMessage) {
        const error = doc.createElement('div');
        error.className = 'media-editor__export-job media-editor__export-job--failed';
        error.textContent = exportErrorMessage;
        exportPanelNode.appendChild(error);
      }
      if (!jobs.length && !isExporting) {
        const empty = doc.createElement('div');
        empty.className = 'media-editor__muted';
        empty.textContent = 'No exports yet.';
        exportPanelNode.appendChild(empty);
        return;
      }
      const list = doc.createElement('div');
      list.className = 'media-editor__export-list';
      const heading = doc.createElement('strong');
      heading.textContent = 'Recent exports';
      list.appendChild(heading);
      if (isExporting && !jobs.length) {
        const row = doc.createElement('div');
        row.className = 'media-editor__export-job media-editor__export-job--rendering';
        row.textContent = 'Latest export: Rendering…';
        list.appendChild(row);
      }
      jobs.slice(0, 5).forEach((job, index) => {
        const row = doc.createElement('div');
        const status = String(job && job.status || 'queued');
        row.className = `media-editor__export-job media-editor__export-job--${status}`;
        row.dataset.exportJobId = String(job && job.export_job_id || '');
        row.textContent = exportJobLabel(job, index);
        list.appendChild(row);
      });
      exportPanelNode.appendChild(list);
      jobs.slice(0, 5).forEach((job) => {
        if (String(job && job.status || '') === 'completed' && job.output_path) {
          const link = doc.createElement('a');
          link.href = withInitData(job.output_path);
          link.textContent = 'Download mp4';
          link.className = 'media-editor__export-link';
          if (typeof link.setAttribute === 'function') {
            link.setAttribute('target', '_blank');
            link.setAttribute('rel', 'noopener');
          }
          exportPanelNode.appendChild(link);
        }
      });
    }

    function selectClip(clipId) {
      selectedClipId = String(clipId || '');
      const clip = state.clips.find((candidate) => String(candidate.clip_id) === String(selectedClipId));
      renderInspector();
      reportSelectedClip(clip);
    }

    function clipTimingLabel(clip, startMs = Number(clip.start_ms || 0)) {
      const durationMs = Number(clip.duration_ms || 0);
      return `${clipLabel(clip)} (${startMs}–${startMs + durationMs}ms)`;
    }

    function updateClipTiming(clip, nextStartMs, nextDurationMs) {
      const params = clip && clip.params && typeof clip.params === 'object' ? { ...clip.params } : {};
      return applyOperation({
        kind: 'update_clip',
        payload: {
          clip_id: String(clip.clip_id || ''),
          start_ms: Math.max(Math.round(Number(nextStartMs || 0)), 0),
          duration_ms: Math.max(Math.round(Number(nextDurationMs || 1)), 1),
          params,
        },
      });
    }

    function moveClipStartMs(clip, nextStartMs) {
      return updateClipTiming(clip, nextStartMs, Number(clip.duration_ms || 1));
    }

    function setClipNodeTimingLabel(clipNode, labelNode, clip, startMs = Number(clip.start_ms || 0), durationMs = Number(clip.duration_ms || 0)) {
      const previewClip = Object.assign({}, clip, { duration_ms: durationMs });
      const label = clipTimingLabel(previewClip, startMs);
      if (labelNode) {
        labelNode.textContent = label;
      }
      if (clipNode && typeof clipNode.setAttribute === 'function') {
        clipNode.setAttribute('aria-label', label);
      }
      if (clipNode && Array.isArray(clipNode.children)) {
        clipNode.textContent = label;
      }
    }

    function installClipDragHandlers(clipNode, clip, labelNode = null) {
      if (!clipNode || typeof clipNode.addEventListener !== 'function') {
        return;
      }
      const canDrag = doc && typeof doc.addEventListener === 'function';
      const msPerPixel = 10;
      let dragState = null;
      let didDrag = false;
      function nextStartFromEvent(event) {
        const clientX = Number(event && event.clientX);
        const deltaPx = Number.isFinite(clientX) ? clientX - dragState.startClientX : 0;
        return Math.max(Math.round(dragState.startMs + deltaPx * msPerPixel), 0);
      }
      function cleanup() {
        if (typeof doc.removeEventListener === 'function') {
          doc.removeEventListener('pointermove', onPointerMove);
          doc.removeEventListener('pointerup', onPointerUp);
          doc.removeEventListener('pointercancel', onPointerCancel);
        }
        if (clipNode.dataset) {
          delete clipNode.dataset.dragging;
        }
        dragState = null;
      }
      function onPointerMove(event) {
        if (!dragState) {
          return;
        }
        if (typeof event?.preventDefault === 'function') {
          event.preventDefault();
        }
        didDrag = true;
        const nextStartMs = nextStartFromEvent(event);
        setClipNodeTimingLabel(clipNode, labelNode, clip, nextStartMs, Number(clip.duration_ms || 0));
      }
      async function onPointerUp(event) {
        if (!dragState) {
          return;
        }
        if (typeof event?.preventDefault === 'function') {
          event.preventDefault();
        }
        const nextStartMs = nextStartFromEvent(event);
        cleanup();
        if (nextStartMs === Number(clip.start_ms || 0)) {
          return;
        }
        try {
          await moveClipStartMs(clip, nextStartMs);
        } catch (error) {
          setClipNodeTimingLabel(clipNode, labelNode, clip);
          reportShortcutError(error, 'Could not move clip.');
        }
      }
      function onPointerCancel() {
        setClipNodeTimingLabel(clipNode, labelNode, clip);
        cleanup();
      }
      if (canDrag) {
        clipNode.addEventListener('pointerdown', (event) => {
          const clientX = Number(event && event.clientX);
          if (!Number.isFinite(clientX)) {
            return;
          }
          if (typeof event?.preventDefault === 'function') {
            event.preventDefault();
          }
          selectClip(clip.clip_id);
          didDrag = false;
          dragState = {
            startClientX: clientX,
            startMs: Number(clip.start_ms || 0),
          };
          if (clipNode.dataset) {
            clipNode.dataset.dragging = 'true';
          }
          doc.addEventListener('pointermove', onPointerMove);
          doc.addEventListener('pointerup', onPointerUp);
          doc.addEventListener('pointercancel', onPointerCancel);
        });
      }
      clipNode.addEventListener('click', (event) => {
        if (didDrag) {
          if (typeof event?.preventDefault === 'function') {
            event.preventDefault();
          }
          didDrag = false;
          return;
        }
        selectClip(clip.clip_id);
      });
    }

    function installClipTrimHandlers(clipNode, labelNode, clip) {
      if (!clipNode || typeof clipNode.addEventListener !== 'function' || !doc || typeof doc.addEventListener !== 'function') {
        return;
      }
      const msPerPixel = 10;
      const originalStartMs = Number(clip.start_ms || 0);
      const originalDurationMs = Math.max(Number(clip.duration_ms || 1), 1);
      const originalEndMs = originalStartMs + originalDurationMs;

      function createTrimHandle(edge) {
        const handle = doc.createElement('span');
        handle.className = `media-editor__trim-handle media-editor__trim-handle--${edge}`;
        handle.dataset.trimEdge = edge;
        handle.setAttribute?.('aria-label', `${edge} trim handle`);
        handle.setAttribute?.('role', 'presentation');
        let trimState = null;
        function nextTimingFromEvent(event) {
          const clientX = Number(event && event.clientX);
          const deltaPx = Number.isFinite(clientX) && trimState ? clientX - trimState.startClientX : 0;
          const deltaMs = Math.round(deltaPx * msPerPixel);
          if (edge === 'left') {
            const nextStartMs = Math.min(Math.max(originalStartMs + deltaMs, 0), originalEndMs - 1);
            return { startMs: nextStartMs, durationMs: Math.max(originalEndMs - nextStartMs, 1) };
          }
          return { startMs: originalStartMs, durationMs: Math.max(originalDurationMs + deltaMs, 1) };
        }
        function cleanup() {
          if (typeof doc.removeEventListener === 'function') {
            doc.removeEventListener('pointermove', onPointerMove);
            doc.removeEventListener('pointerup', onPointerUp);
            doc.removeEventListener('pointercancel', onPointerCancel);
          }
          if (clipNode.dataset) {
            delete clipNode.dataset.trimming;
          }
          trimState = null;
        }
        function onPointerMove(event) {
          if (!trimState) {
            return;
          }
          if (typeof event?.preventDefault === 'function') {
            event.preventDefault();
          }
          const next = nextTimingFromEvent(event);
          setClipNodeTimingLabel(clipNode, labelNode, clip, next.startMs, next.durationMs);
        }
        async function onPointerUp(event) {
          if (!trimState) {
            return;
          }
          if (typeof event?.preventDefault === 'function') {
            event.preventDefault();
          }
          const next = nextTimingFromEvent(event);
          cleanup();
          if (next.startMs === originalStartMs && next.durationMs === originalDurationMs) {
            return;
          }
          try {
            await updateClipTiming(clip, next.startMs, next.durationMs);
          } catch (error) {
            setClipNodeTimingLabel(clipNode, labelNode, clip);
            reportShortcutError(error, 'Could not trim clip.');
          }
        }
        function onPointerCancel() {
          setClipNodeTimingLabel(clipNode, labelNode, clip);
          cleanup();
        }
        handle.addEventListener('pointerdown', (event) => {
          const clientX = Number(event && event.clientX);
          if (!Number.isFinite(clientX)) {
            return;
          }
          if (typeof event?.preventDefault === 'function') {
            event.preventDefault();
          }
          if (typeof event?.stopPropagation === 'function') {
            event.stopPropagation();
          }
          selectClip(clip.clip_id);
          trimState = { startClientX: clientX };
          if (clipNode.dataset) {
            clipNode.dataset.trimming = edge;
          }
          doc.addEventListener('pointermove', onPointerMove);
          doc.addEventListener('pointerup', onPointerUp);
          doc.addEventListener('pointercancel', onPointerCancel);
        });
        return handle;
      }

      clipNode.appendChild(createTrimHandle('left'));
      clipNode.appendChild(createTrimHandle('right'));
    }

    function appendClip(trackNode, clip) {
      if (!doc || !trackNode) {
        return;
      }
      const clipNode = doc.createElement('button');
      clipNode.className = 'media-editor__clip';
      clipNode.dataset.clipId = String(clip.clip_id || '');
      const labelNode = doc.createElement('span');
      labelNode.className = 'media-editor__clip-label';
      setClipNodeTimingLabel(clipNode, labelNode, clip);
      clipNode.appendChild(labelNode);
      installClipTrimHandlers(clipNode, labelNode, clip);
      installClipDragHandlers(clipNode, clip, labelNode);
      trackNode.appendChild(clipNode);
    }

    function appendTrack(track) {
      if (!doc || !trackListNode) {
        return;
      }
      const node = doc.createElement('section');
      node.className = 'media-editor__track';
      node.dataset.kind = String(track.kind || 'track');
      node.dataset.trackId = String(track.track_id || '');
      const label = doc.createElement('div');
      label.className = 'media-editor__track-label';
      label.textContent = String(track.label || track.kind || 'Track');
      node.appendChild(label);
      state.clips
        .filter((clip) => String(clip.track_id) === String(track.track_id))
        .forEach((clip) => appendClip(node, clip));
      trackListNode.appendChild(node);
    }

    function loadProject(payload) {
      const project = payload && payload.project ? payload.project : {};
      const tracks = Array.isArray(payload && payload.tracks) ? payload.tracks : [];
      const clips = Array.isArray(payload && payload.clips) ? payload.clips : [];
      state = {
        project,
        tracks,
        assets: Array.isArray(payload && payload.assets) ? payload.assets : [],
        clips,
        suggestion_batches: Array.isArray(payload && payload.suggestion_batches) ? payload.suggestion_batches : [],
        export_jobs: Array.isArray(payload && payload.export_jobs) ? payload.export_jobs : [],
      };
      if (titleNode) {
        titleNode.textContent = String(project.title || 'Untitled media project');
      }
      clearChildren(trackListNode);
      tracks.forEach(appendTrack);
      if (emptyStateNode) {
        emptyStateNode.textContent = clips.length ? 'Timeline clips loaded.' : 'No clips yet — Hermes can assemble the first draft here.';
      }
      playheadMs = clampPlayhead(playheadMs);
      renderInspector();
      renderSuggestionBatches();
      renderAssetBin();
      renderExportPanel();
      renderPreview();
    }

    async function loadProjectForChat() {
      if (!request || !chatId) {
        return null;
      }
      const params = new URLSearchParams();
      if (initData) {
        params.set('init_data', initData);
      }
      const response = await request(`/api/media-projects/chat/${encodeURIComponent(chatId)}?${params.toString()}`);
      if (!response.ok) {
        throw new Error(`project load failed: ${response.status}`);
      }
      const payload = await response.json();
      loadProject(payload);
      return payload;
    }

    async function defaultSubmitOperation(operation) {
      if (!request) {
        throw new Error('fetch is unavailable');
      }
      const projectId = state.project && state.project.project_id;
      if (!projectId) {
        throw new Error('project is not loaded');
      }
      const body = Object.assign({}, operation);
      if (initData) {
        body.init_data = initData;
      }
      const response = await request(`/api/media-projects/${encodeURIComponent(projectId)}/operations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`operation failed: ${response.status}`);
      }
      return response.json();
    }

    async function applyOperation(operation) {
      const responsePayload = await (submitOperation || defaultSubmitOperation)(operation);
      loadProject(responsePayload);
      return responsePayload;
    }

    async function defaultSubmitImageUpload({ file, trackId, startMs, durationMs }) {
      if (!request) {
        throw new Error('fetch is unavailable');
      }
      const projectId = state.project && state.project.project_id;
      if (!projectId) {
        throw new Error('project is not loaded');
      }
      if (typeof FormData !== 'function') {
        throw new Error('image upload is unavailable');
      }
      const formData = new FormData();
      if (initData) {
        formData.append('init_data', initData);
      }
      formData.append('track_id', String(trackId || ''));
      formData.append('start_ms', String(Math.max(Number(startMs || 0), 0)));
      formData.append('duration_ms', String(Math.max(Number(durationMs || 3000), 1)));
      formData.append('file', file);
      const response = await request(`/api/media-projects/${encodeURIComponent(projectId)}/image-assets`, {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`image upload failed: ${response.status}`);
      }
      return response.json();
    }

    async function uploadImageClip(file, visualTrack) {
      const responsePayload = await (submitImageUpload || defaultSubmitImageUpload)({
        file,
        trackId: visualTrack.track_id,
        startMs: playheadMs,
        durationMs: 3000,
      });
      if (imageFileInput) {
        imageFileInput.value = '';
      }
      loadProject(responsePayload);
      return responsePayload;
    }

    async function defaultSubmitAudioUpload({ file, trackId, startMs, durationMs, gain }) {
      if (!request) {
        throw new Error('fetch is unavailable');
      }
      const projectId = state.project && state.project.project_id;
      if (!projectId) {
        throw new Error('project is not loaded');
      }
      if (typeof FormData !== 'function') {
        throw new Error('audio upload is unavailable');
      }
      const formData = new FormData();
      if (initData) {
        formData.append('init_data', initData);
      }
      formData.append('track_id', String(trackId || ''));
      formData.append('start_ms', String(Math.max(Number(startMs || 0), 0)));
      formData.append('duration_ms', String(Math.max(Number(durationMs || 3000), 1)));
      formData.append('gain', String(Number.isFinite(Number(gain)) ? Number(gain) : 1));
      formData.append('file', file);
      const response = await request(`/api/media-projects/${encodeURIComponent(projectId)}/audio-assets`, {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`audio upload failed: ${response.status}`);
      }
      return response.json();
    }

    async function uploadAudioClip(file, audioTrack) {
      const responsePayload = await (submitAudioUpload || defaultSubmitAudioUpload)({
        file,
        trackId: audioTrack.track_id,
        startMs: playheadMs,
        durationMs: 3000,
        gain: 1,
      });
      if (audioFileInput) {
        audioFileInput.value = '';
      }
      loadProject(responsePayload);
      return responsePayload;
    }

    async function defaultSubmitVideoUpload({ file, trackId, startMs, durationMs }) {
      if (!request) {
        throw new Error('fetch is unavailable');
      }
      const projectId = state.project && state.project.project_id;
      if (!projectId) {
        throw new Error('project is not loaded');
      }
      if (typeof FormData !== 'function') {
        throw new Error('video upload is unavailable');
      }
      const formData = new FormData();
      if (initData) {
        formData.append('init_data', initData);
      }
      formData.append('track_id', String(trackId || ''));
      formData.append('start_ms', String(Math.max(Number(startMs || 0), 0)));
      formData.append('duration_ms', String(Math.max(Number(durationMs || 3000), 1)));
      formData.append('file', file);
      const response = await request(`/api/media-projects/${encodeURIComponent(projectId)}/video-assets`, {
        method: 'POST',
        body: formData,
      });
      if (!response.ok) {
        throw new Error(`video upload failed: ${response.status}`);
      }
      return response.json();
    }

    async function uploadVideoClip(file, visualTrack) {
      const responsePayload = await (submitVideoUpload || defaultSubmitVideoUpload)({
        file,
        trackId: visualTrack.track_id,
        startMs: playheadMs,
        durationMs: 3000,
      });
      if (videoFileInput) {
        videoFileInput.value = '';
      }
      loadProject(responsePayload);
      return responsePayload;
    }

    async function defaultSubmitHistoryAction(action) {
      if (!request) {
        throw new Error('fetch is unavailable');
      }
      const projectId = state.project && state.project.project_id;
      if (!projectId) {
        throw new Error('project is not loaded');
      }
      const normalizedAction = action === 'redo' ? 'redo' : 'undo';
      const body = {};
      if (initData) {
        body.init_data = initData;
      }
      const response = await request(`/api/media-projects/${encodeURIComponent(projectId)}/${normalizedAction}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`${normalizedAction} failed: ${response.status}`);
      }
      return response.json();
    }

    async function applyHistoryAction(action) {
      const responsePayload = await (submitHistoryAction || defaultSubmitHistoryAction)(action === 'redo' ? 'redo' : 'undo');
      loadProject(responsePayload);
      return responsePayload;
    }

    function undoTimelineEdit() {
      return applyHistoryAction('undo');
    }

    function redoTimelineEdit() {
      return applyHistoryAction('redo');
    }

    async function defaultSubmitExportAction() {
      if (!request) {
        throw new Error('fetch is unavailable');
      }
      const projectId = state.project && state.project.project_id;
      if (!projectId) {
        throw new Error('project is not loaded');
      }
      const body = {};
      if (initData) {
        body.init_data = initData;
      }
      const response = await request(`/api/media-projects/${encodeURIComponent(projectId)}/exports`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        throw new Error(`export failed: ${response.status}`);
      }
      return response.json();
    }

    async function exportProject() {
      isExporting = true;
      exportErrorMessage = '';
      renderExportPanel();
      try {
        const responsePayload = await (submitExportAction || defaultSubmitExportAction)();
        isExporting = false;
        exportErrorMessage = '';
        loadProject(responsePayload);
        return responsePayload;
      } catch (error) {
        isExporting = false;
        exportErrorMessage = error && error.message ? error.message : 'Could not export project.';
        renderExportPanel();
        throw error;
      }
    }

    async function defaultSubmitSuggestionAction(batchId, action) {
      if (!request) {
        throw new Error('fetch is unavailable');
      }
      const projectId = state.project && state.project.project_id;
      if (!projectId) {
        throw new Error('project is not loaded');
      }
      const body = {};
      if (initData) {
        body.init_data = initData;
      }
      const normalizedAction = action === 'reject' ? 'reject' : 'accept';
      const response = await request(
        `/api/media-projects/${encodeURIComponent(projectId)}/suggestion-batches/${encodeURIComponent(String(batchId || ''))}/${normalizedAction}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!response.ok) {
        throw new Error(`suggestion ${normalizedAction} failed: ${response.status}`);
      }
      return response.json();
    }

    async function applySuggestionAction(batchId, action) {
      const responsePayload = await (submitSuggestionAction || defaultSubmitSuggestionAction)(String(batchId || ''), action);
      loadProject(responsePayload);
      return responsePayload;
    }

    async function addTextClip() {
      const textTrack = state.tracks.find((track) => String(track.kind) === 'text') || state.tracks[0];
      if (!textTrack) {
        throw new Error('text track is unavailable');
      }
      return applyOperation({
        kind: 'create_text_clip',
        payload: {
          track_id: textTrack.track_id,
          text: 'New text clip',
          start_ms: playheadMs,
          duration_ms: 2000,
        },
      });
    }

    async function addImageClip() {
      const visualTrack = state.tracks.find((track) => String(track.kind) === 'visual') || state.tracks[0];
      if (!visualTrack) {
        throw new Error('visual track is unavailable');
      }
      const selectedFile = imageFileInput && imageFileInput.files && imageFileInput.files[0] ? imageFileInput.files[0] : null;
      if (selectedFile) {
        return uploadImageClip(selectedFile, visualTrack);
      }
      const storagePath = promptFn ? String(promptFn('Image URL or project path', '') || '').trim() : '';
      if (!storagePath) {
        throw new Error('image URL or path is required');
      }
      return applyOperation({
        kind: 'create_image_clip',
        payload: {
          track_id: visualTrack.track_id,
          storage_path: storagePath,
          label: 'Imported image',
          content_type: 'image/*',
          start_ms: playheadMs,
          duration_ms: 3000,
          params: { fit: 'cover' },
        },
      });
    }

    async function addVideoClip() {
      const visualTrack = state.tracks.find((track) => String(track.kind) === 'visual') || state.tracks[0];
      if (!visualTrack) {
        throw new Error('visual track is unavailable');
      }
      const selectedFile = videoFileInput && videoFileInput.files && videoFileInput.files[0] ? videoFileInput.files[0] : null;
      if (selectedFile) {
        return uploadVideoClip(selectedFile, visualTrack);
      }
      const storagePath = promptFn ? String(promptFn('Video URL or project path', '') || '').trim() : '';
      if (!storagePath) {
        throw new Error('video URL or path is required');
      }
      return applyOperation({
        kind: 'create_video_clip',
        payload: {
          track_id: visualTrack.track_id,
          storage_path: storagePath,
          label: 'Imported video',
          content_type: 'video/*',
          start_ms: playheadMs,
          duration_ms: 3000,
          params: { fit: 'cover' },
        },
      });
    }

    async function addAudioClip() {
      const audioTrack = state.tracks.find((track) => String(track.kind) === 'audio') || state.tracks[0];
      if (!audioTrack) {
        throw new Error('audio track is unavailable');
      }
      const selectedFile = audioFileInput && audioFileInput.files && audioFileInput.files[0] ? audioFileInput.files[0] : null;
      if (selectedFile) {
        return uploadAudioClip(selectedFile, audioTrack);
      }
      const storagePath = promptFn ? String(promptFn('Audio URL or project path', '') || '').trim() : '';
      if (!storagePath) {
        throw new Error('audio URL or path is required');
      }
      return applyOperation({
        kind: 'create_audio_clip',
        payload: {
          track_id: audioTrack.track_id,
          storage_path: storagePath,
          label: 'Imported audio',
          content_type: 'audio/*',
          start_ms: playheadMs,
          duration_ms: 3000,
          params: { gain: 1 },
        },
      });
    }

    async function updateSelectedClip({ text, start_ms, duration_ms, source_in_ms, source_out_ms } = {}) {
      if (!selectedClipId) {
        throw new Error('select a clip before updating');
      }
      const clip = selectedClip();
      const params = clip && clip.params && typeof clip.params === 'object' ? { ...clip.params } : {};
      if (clip && String(clip.kind || '') === 'text') {
        params.text = String(text || '');
      }
      return applyOperation({
        kind: 'update_clip',
        payload: {
          clip_id: selectedClipId,
          start_ms: Math.max(Number(start_ms || 0), 0),
          duration_ms: Math.max(Number(duration_ms || 1), 1),
          source_in_ms: Math.max(Number(source_in_ms || 0), 0),
          source_out_ms: Math.max(Number(source_out_ms || 0), 0),
          params,
        },
      });
    }

    async function deleteSelectedClip() {
      if (!selectedClipId) {
        throw new Error('select a clip before deleting');
      }
      const clipId = selectedClipId;
      selectedClipId = '';
      return applyOperation({
        kind: 'delete_clip',
        payload: { clip_id: clipId },
      });
    }

    function selectedClip() {
      return state.clips.find((candidate) => String(candidate.clip_id) === String(selectedClipId)) || null;
    }

    async function duplicateClipAt(clipId, startMs) {
      const source = state.clips.find((candidate) => String(candidate.clip_id) === String(clipId));
      if (!source) {
        throw new Error('select a clip before duplicating');
      }
      return applyOperation({
        kind: 'duplicate_clip',
        payload: {
          clip_id: String(source.clip_id || ''),
          start_ms: Math.max(Math.round(Number(startMs || 0)), 0),
        },
      });
    }

    async function duplicateSelectedClip() {
      const clip = selectedClip();
      if (!clip) {
        throw new Error('select a clip before duplicating');
      }
      return duplicateClipAt(clip.clip_id, Number(clip.start_ms || 0) + Number(clip.duration_ms || 0));
    }

    function copySelectedClip() {
      const clip = selectedClip();
      if (!clip) {
        throw new Error('select a clip before copying');
      }
      copiedClipId = String(clip.clip_id || '');
      return copiedClipId;
    }

    async function pasteCopiedClip() {
      if (!copiedClipId) {
        throw new Error('copy a clip before pasting');
      }
      return duplicateClipAt(copiedClipId, playheadMs);
    }

    async function splitSelectedClip() {
      const clip = selectedClip();
      if (!clip) {
        throw new Error('select a clip before splitting');
      }
      const startMs = Number(clip.start_ms || 0);
      const endMs = startMs + Number(clip.duration_ms || 0);
      if (playheadMs <= startMs || playheadMs >= endMs) {
        throw new Error('move the playhead inside the selected clip before splitting');
      }
      return applyOperation({
        kind: 'split_clip',
        payload: {
          clip_id: String(clip.clip_id || ''),
          split_ms: Math.max(Math.round(Number(playheadMs || 0)), 0),
        },
      });
    }

    function isTypingTarget(target) {
      if (!target) {
        return false;
      }
      const tagName = String(target.tagName || '').toLowerCase();
      return tagName === 'input' || tagName === 'textarea' || tagName === 'select' || target.isContentEditable === true;
    }

    function reportShortcutError(error, fallbackMessage) {
      if (emptyStateNode) {
        emptyStateNode.textContent = error && error.message ? error.message : fallbackMessage;
      }
    }

    async function handleKeyboardShortcut(event) {
      if (isTypingTarget(event && event.target)) {
        return;
      }
      const key = String(event && event.key || '').toLowerCase();
      const hasModifier = Boolean(event && (event.ctrlKey || event.metaKey));
      if (hasModifier && key === 'z') {
        event?.preventDefault?.();
        try {
          if (event && event.shiftKey) {
            await redoTimelineEdit();
          } else {
            await undoTimelineEdit();
          }
        } catch (error) {
          reportShortcutError(error, event && event.shiftKey ? 'Could not redo edit.' : 'Could not undo edit.');
        }
        return;
      }
      if ((key === 'delete' || key === 'backspace') && selectedClipId) {
        event?.preventDefault?.();
        try {
          await deleteSelectedClip();
        } catch (error) {
          reportShortcutError(error, 'Could not delete clip.');
        }
        return;
      }
      if (hasModifier && key === 'c' && selectedClipId) {
        event?.preventDefault?.();
        try {
          copySelectedClip();
          renderInspector();
        } catch (error) {
          reportShortcutError(error, 'Could not copy clip.');
        }
        return;
      }
      if (hasModifier && key === 'v' && copiedClipId) {
        event?.preventDefault?.();
        try {
          await pasteCopiedClip();
        } catch (error) {
          reportShortcutError(error, 'Could not paste clip.');
        }
        return;
      }
      if (hasModifier && key === 'd' && selectedClipId) {
        event?.preventDefault?.();
        try {
          await duplicateSelectedClip();
        } catch (error) {
          reportShortcutError(error, 'Could not duplicate clip.');
        }
        return;
      }
      if (hasModifier && key === 's' && selectedClipId) {
        event?.preventDefault?.();
        try {
          await splitSelectedClip();
        } catch (error) {
          reportShortcutError(error, 'Could not split clip.');
        }
        return;
      }
      if (key === ' ' || key === 'spacebar') {
        event?.preventDefault?.();
        togglePlayback();
      }
    }

    if (doc && typeof doc.addEventListener === 'function') {
      doc.addEventListener('keydown', handleKeyboardShortcut);
    }

    if (addTextButton) {
      addTextButton.textContent = 'Add text clip';
      if (typeof addTextButton.addEventListener === 'function') {
        addTextButton.addEventListener('click', () => {
          addTextClip().catch((error) => {
            if (emptyStateNode) {
              emptyStateNode.textContent = error && error.message ? error.message : 'Could not add text clip.';
            }
          });
        });
      }
    }

    if (addImageButton) {
      addImageButton.textContent = 'Add image clip';
      if (typeof addImageButton.addEventListener === 'function') {
        addImageButton.addEventListener('click', () => {
          if (imageFileInput && !imageFileInput.files?.[0] && typeof imageFileInput.click === 'function') {
            imageFileInput.click();
            return;
          }
          addImageClip().catch((error) => {
            if (emptyStateNode) {
              emptyStateNode.textContent = error && error.message ? error.message : 'Could not add image clip.';
            }
          });
        });
      }
    }

    if (addVideoButton) {
      addVideoButton.textContent = 'Add video clip';
      if (typeof addVideoButton.addEventListener === 'function') {
        addVideoButton.addEventListener('click', () => {
          if (videoFileInput && !videoFileInput.files?.[0] && typeof videoFileInput.click === 'function') {
            videoFileInput.click();
            return;
          }
          addVideoClip().catch((error) => {
            if (emptyStateNode) {
              emptyStateNode.textContent = error && error.message ? error.message : 'Could not add video clip.';
            }
          });
        });
      }
    }

    if (addAudioButton) {
      addAudioButton.textContent = 'Add audio clip';
      if (typeof addAudioButton.addEventListener === 'function') {
        addAudioButton.addEventListener('click', () => {
          if (audioFileInput && !audioFileInput.files?.[0] && typeof audioFileInput.click === 'function') {
            audioFileInput.click();
            return;
          }
          addAudioClip().catch((error) => {
            if (emptyStateNode) {
              emptyStateNode.textContent = error && error.message ? error.message : 'Could not add audio clip.';
            }
          });
        });
      }
    }

    if (imageFileInput && typeof imageFileInput.addEventListener === 'function') {
      imageFileInput.addEventListener('change', () => {
        addImageClip().catch((error) => {
          if (emptyStateNode) {
            emptyStateNode.textContent = error && error.message ? error.message : 'Could not upload image clip.';
          }
        });
      });
    }

    if (audioFileInput && typeof audioFileInput.addEventListener === 'function') {
      audioFileInput.addEventListener('change', () => {
        addAudioClip().catch((error) => {
          if (emptyStateNode) {
            emptyStateNode.textContent = error && error.message ? error.message : 'Could not upload audio clip.';
          }
        });
      });
    }

    if (videoFileInput && typeof videoFileInput.addEventListener === 'function') {
      videoFileInput.addEventListener('change', () => {
        addVideoClip().catch((error) => {
          if (emptyStateNode) {
            emptyStateNode.textContent = error && error.message ? error.message : 'Could not upload video clip.';
          }
        });
      });
    }

    if (scrubberNode && typeof scrubberNode.addEventListener === 'function') {
      scrubberNode.addEventListener('input', (event) => {
        setPlayheadMs(Number(event?.currentTarget?.value || scrubberNode.value || 0));
      });
    }

    if (playButton) {
      playButton.textContent = 'Play';
      if (typeof playButton.addEventListener === 'function') {
        playButton.addEventListener('click', togglePlayback);
      }
    }

    function getPlaybackState() {
      return {
        playheadMs,
        durationMs: projectDurationMs(),
        isPlaying,
      };
    }

    function getState() {
      return JSON.parse(JSON.stringify(state));
    }

    return {
      loadProject,
      addTextClip,
      addImageClip,
      addAudioClip,
      addVideoClip,
      updateSelectedClip,
      deleteSelectedClip,
      duplicateSelectedClip,
      splitSelectedClip,
      copySelectedClip,
      pasteCopiedClip,
      applyOperation,
      undoTimelineEdit,
      redoTimelineEdit,
      exportProject,
      applySuggestionAction,
      placeAssetOnTimeline,
      loadProjectForChat,
      selectClip,
      setPlayheadMs,
      togglePlayback,
      getPlaybackState,
      getState,
    };
  }

  function bootFromDocument() {
    if (typeof document === 'undefined') {
      return null;
    }
    const titleNode = document.getElementById('media-editor-title');
    const trackListNode = document.getElementById('media-editor-track-list');
    const emptyStateNode = document.getElementById('media-editor-empty-state');
    const inspectorNode = document.getElementById('media-editor-inspector');
    const suggestionListNode = document.getElementById('media-editor-suggestions');
    const assetBinNode = document.getElementById('media-editor-asset-bin');
    const exportPanelNode = document.getElementById('media-editor-exports');
    const previewStageNode = document.getElementById('media-editor-preview-stage');
    const playheadTimeNode = document.getElementById('media-editor-playhead-time');
    const scrubberNode = document.getElementById('media-editor-scrubber');
    const playButton = document.getElementById('media-editor-play');
    const addTextButton = document.getElementById('media-editor-add-text');
    const addImageButton = document.getElementById('media-editor-add-image');
    const addAudioButton = document.getElementById('media-editor-add-audio');
    const addVideoButton = document.getElementById('media-editor-add-video');
    const imageFileInput = document.getElementById('media-editor-image-file');
    const audioFileInput = document.getElementById('media-editor-audio-file');
    const videoFileInput = document.getElementById('media-editor-video-file');
    const bridgeFactory = globalThis.HermesMiniappVisualDevBridge;
    const visualDevBridge = bridgeFactory?.createController
      ? bridgeFactory.createController({ windowObject: globalThis, documentObject: document })
      : null;
    visualDevBridge?.install?.();
    const controller = createController({
      documentObject: document,
      titleNode,
      trackListNode,
      emptyStateNode,
      inspectorNode,
      suggestionListNode,
      assetBinNode,
      exportPanelNode,
      previewStageNode,
      playheadTimeNode,
      scrubberNode,
      playButton,
      addTextButton,
      addImageButton,
      addAudioButton,
      addVideoButton,
      imageFileInput,
      audioFileInput,
      videoFileInput,
      initData: globalThis.__HERMES_MEDIA_EDITOR_INIT_DATA__ || '',
      chatId: globalThis.__HERMES_MEDIA_EDITOR_CHAT_ID__ || '',
      visualDevBridge,
    });
    controller.loadProject(globalThis.__HERMES_MEDIA_EDITOR_BOOT__ || {});
    if (globalThis.__HERMES_MEDIA_EDITOR_CHAT_ID__) {
      controller.loadProjectForChat().catch((error) => {
        if (emptyStateNode) {
          emptyStateNode.textContent = error && error.message ? error.message : 'Could not load media project.';
        }
      });
    }
    return controller;
  }

  if (typeof window !== 'undefined' && typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', bootFromDocument, { once: true });
    } else {
      bootFromDocument();
    }
  }

  return {
    createController,
    bootFromDocument,
  };
});
