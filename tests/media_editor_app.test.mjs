import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const mediaEditor = require('../static/media_editor_app.js');

function createElement(tagName = 'div') {
  return {
    tagName,
    textContent: '',
    innerHTML: '',
    children: [],
    dataset: {},
    className: '',
    value: '',
    max: '',
    style: {},
    attributes: {},
    listeners: {},
    setAttribute(name, value) {
      this.attributes[name] = String(value);
      this[name] = String(value);
    },
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      this.children = this.children.filter((candidate) => candidate !== child);
      return child;
    },
    addEventListener(type, handler) {
      this.listeners[type] = handler;
    },
    removeEventListener(type, handler) {
      if (this.listeners[type] === handler) {
        delete this.listeners[type];
      }
    },
    click() {
      if (this.listeners.click) {
        return this.listeners.click({ currentTarget: this, preventDefault() {} });
      }
      return undefined;
    },
  };
}

function elementText(node) {
  if (!node) {
    return '';
  }
  const ownText = typeof node.textContent === 'string' ? node.textContent : '';
  const childText = Array.isArray(node.children) ? node.children.map(elementText).join('') : '';
  return `${ownText}${childText}`;
}

test('createController renders default timeline tracks and title', () => {
  const titleNode = createElement('h1');
  const trackListNode = createElement('section');
  const emptyStateNode = createElement('p');
  const controller = mediaEditor.createController({
    documentObject: {
      createElement,
    },
    titleNode,
    trackListNode,
    emptyStateNode,
  });

  controller.loadProject({
    project: { title: 'Video editor draft' },
    tracks: [
      { track_id: 'track_visual', kind: 'visual', label: 'Visual' },
      { track_id: 'track_text', kind: 'text', label: 'Text' },
      { track_id: 'track_audio', kind: 'audio', label: 'Audio' },
    ],
    clips: [],
  });

  assert.equal(titleNode.textContent, 'Video editor draft');
  assert.equal(trackListNode.children.length, 3);
  assert.deepEqual(trackListNode.children.map((child) => child.dataset.kind), ['visual', 'text', 'audio']);
  assert.match(emptyStateNode.textContent, /No clips yet/i);
});


test('createController renders selectable clips and inspector fields', () => {
  const titleNode = createElement('h1');
  const trackListNode = createElement('section');
  const emptyStateNode = createElement('p');
  const inspectorNode = createElement('aside');
  const controller = mediaEditor.createController({
    documentObject: {
      createElement,
    },
    titleNode,
    trackListNode,
    emptyStateNode,
    inspectorNode,
  });

  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [
      {
        clip_id: 'clip_1',
        track_id: 'track_text',
        kind: 'text',
        start_ms: 250,
        duration_ms: 1750,
        source_in_ms: 100,
        source_out_ms: 1850,
        params: { text: 'Opening title' },
      },
    ],
  });

  const track = trackListNode.children[0];
  const clip = track.children[1];
  assert.equal(clip.dataset.clipId, 'clip_1');
  assert.match(clip.textContent, /Opening title/);

  clip.click();

  assert.match(inspectorNode.textContent, /Opening title/);
  assert.match(inspectorNode.textContent, /250ms/);
  assert.match(inspectorNode.textContent, /1750ms/);
  assert.match(inspectorNode.textContent, /source 100–1850ms/);
  assert.ok(inspectorNode.children.some((child) => child.placeholder === 'Source in ms' && child.value === '100'));
  assert.ok(inspectorNode.children.some((child) => child.placeholder === 'Source out ms' && child.value === '1850'));
});


test('inspector save includes source trim and preserves non-text clip params', async () => {
  const submittedOperations = [];
  const trackListNode = createElement('section');
  const inspectorNode = createElement('aside');
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode,
    emptyStateNode: createElement('p'),
    inspectorNode,
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 6000 },
        tracks: [{ track_id: 'track_audio', kind: 'audio', label: 'Audio' }],
        clips: [{ clip_id: 'clip_audio', track_id: 'track_audio', kind: 'audio', start_ms: operation.payload.start_ms, duration_ms: operation.payload.duration_ms, source_in_ms: operation.payload.source_in_ms, source_out_ms: operation.payload.source_out_ms, params: operation.payload.params }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 6000 },
    tracks: [{ track_id: 'track_audio', kind: 'audio', label: 'Audio' }],
    clips: [{ clip_id: 'clip_audio', track_id: 'track_audio', kind: 'audio', start_ms: 500, duration_ms: 3000, source_in_ms: 0, source_out_ms: 3000, params: { gain: 0.5 } }],
  });

  trackListNode.children[0].children[1].click();
  const sourceInInput = inspectorNode.children.find((child) => child.placeholder === 'Source in ms');
  const sourceOutInput = inspectorNode.children.find((child) => child.placeholder === 'Source out ms');
  const saveButton = inspectorNode.children.find((child) => child.textContent === 'Save clip');
  sourceInInput.value = '750';
  sourceOutInput.value = '2750';

  await saveButton.click();

  assert.equal(submittedOperations.length, 1);
  assert.deepEqual(submittedOperations[0], {
    kind: 'update_clip',
    payload: {
      clip_id: 'clip_audio',
      start_ms: 500,
      duration_ms: 3000,
      source_in_ms: 750,
      source_out_ms: 2750,
      params: { gain: 0.5 },
    },
  });
});


test('asset bin renders imported assets and reuses an image asset as a new visual clip', async () => {
  const assetBinNode = createElement('section');
  const submittedOperations = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    assetBinNode,
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 4500 },
        tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
        assets: [{ asset_id: 'asset_1', kind: 'image', storage_path: '/uploads/opening.png', label: 'Opening still' }],
        clips: [{ clip_id: 'clip_reused', track_id: 'track_visual', asset_id: 'asset_1', kind: 'image', start_ms: 1500, duration_ms: 3000, params: { fit: 'cover' } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
    assets: [{ asset_id: 'asset_1', kind: 'image', storage_path: '/uploads/opening.png', label: 'Opening still' }],
    clips: [],
  });
  controller.setPlayheadMs(1500);

  assert.equal(assetBinNode.children.length, 1);
  assert.equal(assetBinNode.children[0].dataset.assetId, 'asset_1');
  assert.match(assetBinNode.children[0].textContent, /Opening still/);

  await assetBinNode.children[0].click();

  assert.deepEqual(submittedOperations, [
    {
      kind: 'create_clip_from_asset',
      payload: {
        track_id: 'track_visual',
        asset_id: 'asset_1',
        start_ms: 1500,
        duration_ms: 3000,
        params: { fit: 'cover' },
      },
    },
  ]);
  assert.equal(controller.getState().assets.length, 1);
  assert.equal(controller.getState().clips[0].asset_id, 'asset_1');
});


test('asset bin shows an empty state when no assets are available', () => {
  const assetBinNode = createElement('section');
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    assetBinNode,
  });

  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
    assets: [],
    clips: [],
  });

  assert.match(assetBinNode.textContent, /No media assets yet/i);
});


test('addImageClip uploads a selected file onto the visual rail', async () => {
  const imageFile = { name: 'opening.png', type: 'image/png', size: 12 };
  const imageFileInput = { files: [imageFile], value: 'opening.png' };
  const uploads = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    imageFileInput,
    submitImageUpload: async ({ file, trackId, startMs, durationMs }) => {
      uploads.push({ file, trackId, startMs, durationMs });
      return {
        ok: true,
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 3000 },
        tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
        assets: [{ asset_id: 'asset_1', kind: 'image', storage_path: '/api/media-projects/proj_1/uploaded-assets/opening.png', label: 'opening.png' }],
        clips: [{ clip_id: 'clip_1', track_id: 'track_visual', asset_id: 'asset_1', kind: 'image', start_ms: 0, duration_ms: 3000, params: { fit: 'cover' } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
    clips: [],
  });

  await controller.addImageClip();

  assert.deepEqual(uploads, [{ file: imageFile, trackId: 'track_visual', startMs: 0, durationMs: 3000 }]);
  assert.equal(imageFileInput.value, '');
  assert.equal(controller.getState().assets[0].label, 'opening.png');
  assert.equal(controller.getState().clips[0].kind, 'image');
});


test('addTextClip submits create_text_clip operation for text rail', async () => {
  const addTextButton = createElement('button');
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    addTextButton,
    submitOperation: async (operation) => ({
      ok: true,
      operation,
      project: { project_id: 'proj_1', title: 'Video editor draft' },
      tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
      clips: [
        {
          clip_id: 'clip_created',
          track_id: 'track_text',
          kind: 'text',
          start_ms: 0,
          duration_ms: 2000,
          params: { text: operation.payload.text },
        },
      ],
    }),
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [],
  });

  await controller.addTextClip();

  assert.equal(addTextButton.textContent, 'Add text clip');
  assert.equal(controller.getState().clips[0].clip_id, 'clip_created');
  assert.equal(controller.getState().clips[0].params.text, 'New text clip');
});


test('suggestion batches render accept and reject controls', async () => {
  const suggestionNode = createElement('section');
  const accepted = [];
  const rejected = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    suggestionListNode: suggestionNode,
    submitSuggestionAction: async (batchId, action) => {
      if (action === 'accept') {
        accepted.push(batchId);
      } else {
        rejected.push(batchId);
      }
      return {
        ok: true,
        suggestion_batch: { batch_id: batchId, status: action === 'accept' ? 'accepted' : 'rejected' },
        project: { project_id: 'proj_1', title: 'Video editor draft' },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: action === 'accept' ? [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', params: { text: 'Hermes hook' } }] : [],
        suggestion_batches: [{ batch_id: batchId, status: action === 'accept' ? 'accepted' : 'rejected', summary: 'Add hook', operations: [] }],
      };
    },
  });

  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [],
    suggestion_batches: [
      {
        batch_id: 'batch_1',
        status: 'pending',
        summary: 'Add hook',
        operations: [{ kind: 'create_text_clip', payload: { text: 'Hermes hook' } }],
      },
    ],
  });

  assert.equal(suggestionNode.children.length, 1);
  assert.match(suggestionNode.children[0].textContent, /Hermes suggested 1 timeline edit/);
  assert.match(suggestionNode.children[0].textContent, /Add hook/);

  const acceptButton = suggestionNode.children[0].children[0];
  const rejectButton = suggestionNode.children[0].children[1];
  await acceptButton.click();
  assert.deepEqual(accepted, ['batch_1']);

  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [],
    suggestion_batches: [{ batch_id: 'batch_2', status: 'pending', summary: 'Try alternate', operations: [] }],
  });
  await rejectButton.click();
  assert.deepEqual(rejected, ['batch_1']);
});


test('suggestion batches render a readable operation inspector', () => {
  const suggestionNode = createElement('section');
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    suggestionListNode: suggestionNode,
  });

  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [
      { track_id: 'track_visual', kind: 'visual', label: 'Visual' },
      { track_id: 'track_text', kind: 'text', label: 'Text' },
    ],
    clips: [
      { clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 250, duration_ms: 1750, params: { text: 'Opening title' } },
    ],
    suggestion_batches: [
      {
        batch_id: 'batch_1',
        status: 'pending',
        summary: 'Tighten the hook',
        operations: [
          { kind: 'update_clip', payload: { clip_id: 'clip_1', start_ms: 500, duration_ms: 1500, params: { text: 'Sharper hook' } } },
          { kind: 'create_image_clip', payload: { track_id: 'track_visual', label: 'Product still', storage_path: 'https://example.test/product.png', start_ms: 0, duration_ms: 2000 } },
        ],
      },
    ],
  });

  const batchNode = suggestionNode.children[0];
  assert.equal(batchNode.dataset.batchId, 'batch_1');
  const inspector = batchNode.children.find((child) => child.className === 'media-editor__suggestion-inspector');
  assert.ok(inspector);
  assert.equal(inspector.children.length, 2);
  assert.match(inspector.children[0].textContent, /Update clip Opening title/);
  assert.match(inspector.children[0].textContent, /text “Opening title” → “Sharper hook”/);
  assert.match(inspector.children[0].textContent, /250–2000ms → 500–2000ms/);
  assert.match(inspector.children[1].textContent, /Create image clip Product still/);
  assert.match(inspector.children[1].textContent, /Visual/);
  assert.match(inspector.children[1].textContent, /0–2000ms/);
});


test('selectClip reports structured clip selection to the visual-dev bridge', () => {
  const selections = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    inspectorNode: createElement('aside'),
    visualDevBridge: {
      reportSelection(selection) {
        selections.push(selection);
      },
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [
      {
        clip_id: 'clip_1',
        track_id: 'track_text',
        kind: 'text',
        start_ms: 250,
        duration_ms: 1750,
        params: { text: 'Opening title' },
      },
    ],
  });

  controller.selectClip('clip_1');

  assert.deepEqual(selections, [
    {
      selectionType: 'media_editor_clip',
      label: 'Opening title',
      selector: 'media-editor-clip:clip_1',
      tagName: 'media-editor-clip',
      text: 'Opening title',
      clip_id: 'clip_1',
      track_id: 'track_text',
      clip_kind: 'text',
      start_ms: 250,
      duration_ms: 1750,
      params: { text: 'Opening title' },
    },
  ]);
});


test('preview stage renders only active text clips at the playhead', () => {
  const previewStageNode = createElement('section');
  const playheadTimeNode = createElement('output');
  const scrubberNode = createElement('input');
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    previewStageNode,
    playheadTimeNode,
    scrubberNode,
  });

  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [
      { clip_id: 'clip_intro', track_id: 'track_text', kind: 'text', start_ms: 0, duration_ms: 2000, params: { text: 'Intro title' } },
      { clip_id: 'clip_outro', track_id: 'track_text', kind: 'text', start_ms: 3000, duration_ms: 1000, params: { text: 'Outro title' } },
    ],
  });

  assert.equal(previewStageNode.children.length, 1);
  assert.equal(previewStageNode.children[0].textContent, 'Intro title');
  assert.equal(playheadTimeNode.textContent, '0.00s / 5.00s');
  assert.equal(scrubberNode.max, '5000');

  controller.setPlayheadMs(3500);

  assert.equal(previewStageNode.children.length, 1);
  assert.equal(previewStageNode.children[0].textContent, 'Outro title');
  assert.equal(playheadTimeNode.textContent, '3.50s / 5.00s');
  assert.equal(scrubberNode.value, '3500');

  controller.setPlayheadMs(2500);

  assert.equal(previewStageNode.children.length, 0);
  assert.match(playheadTimeNode.textContent, /2\.50s/);
});

test('preview stage renders active image clips beneath text overlays', () => {
  const previewStageNode = createElement('section');
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    previewStageNode,
  });

  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 4000 },
    tracks: [
      { track_id: 'track_visual', kind: 'visual', label: 'Visual' },
      { track_id: 'track_text', kind: 'text', label: 'Text' },
    ],
    assets: [
      { asset_id: 'asset_image', kind: 'image', storage_path: 'https://example.test/shot-01.png', label: 'Opening still' },
    ],
    clips: [
      { clip_id: 'clip_image', track_id: 'track_visual', asset_id: 'asset_image', kind: 'image', start_ms: 0, duration_ms: 4000, params: { fit: 'cover' } },
      { clip_id: 'clip_text', track_id: 'track_text', kind: 'text', start_ms: 1000, duration_ms: 2000, params: { text: 'Overlay title' } },
    ],
  });

  assert.equal(previewStageNode.children.length, 1);
  assert.equal(previewStageNode.children[0].tagName, 'img');
  assert.equal(previewStageNode.children[0].src, 'https://example.test/shot-01.png');
  assert.equal(previewStageNode.children[0].alt, 'Opening still');

  controller.setPlayheadMs(1500);

  assert.equal(previewStageNode.children.length, 2);
  assert.equal(previewStageNode.children[0].tagName, 'img');
  assert.equal(previewStageNode.children[1].textContent, 'Overlay title');
});

test('addImageClip submits create_image_clip operation for visual rail', async () => {
  const addImageButton = createElement('button');
  const prompts = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    addImageButton,
    promptFn(message, defaultValue) {
      prompts.push({ message, defaultValue });
      return 'https://example.test/imported.png';
    },
    submitOperation: async (operation) => ({
      operation,
      project: { project_id: 'proj_1', title: 'Video editor draft' },
      tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
      assets: [{ asset_id: 'asset_created', kind: 'image', storage_path: operation.payload.storage_path, label: 'Imported image' }],
      clips: [{ clip_id: 'clip_created', track_id: 'track_visual', asset_id: 'asset_created', kind: 'image', start_ms: 0, duration_ms: 3000, params: { fit: 'cover' } }],
    }),
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
    clips: [],
  });

  await controller.addImageClip();

  assert.equal(addImageButton.textContent, 'Add image clip');
  assert.equal(prompts.length, 1);
  assert.equal(controller.getState().assets[0].storage_path, 'https://example.test/imported.png');
  assert.equal(controller.getState().clips[0].kind, 'image');
});

test('dragging a timeline clip moves it in time and persists through update_clip', async () => {
  const documentListeners = {};
  const submittedOperations = [];
  const doc = {
    createElement,
    addEventListener(type, handler) {
      documentListeners[type] = handler;
    },
    removeEventListener(type, handler) {
      if (documentListeners[type] === handler) {
        delete documentListeners[type];
      }
    },
  };
  const trackListNode = createElement('section');
  const inspectorNode = createElement('aside');
  const controller = mediaEditor.createController({
    documentObject: doc,
    titleNode: createElement('h1'),
    trackListNode,
    emptyStateNode: createElement('p'),
    inspectorNode,
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      assert.equal(operation.kind, 'update_clip');
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: operation.payload.start_ms, duration_ms: operation.payload.duration_ms, params: { text: 'Opening title' } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 1000, duration_ms: 1500, params: { text: 'Opening title' } }],
  });

  const clipNode = trackListNode.children[0].children[1];
  assert.equal(clipNode.dataset.clipId, 'clip_1');

  clipNode.listeners.pointerdown({ currentTarget: clipNode, clientX: 100, preventDefault() {} });
  documentListeners.pointermove({ clientX: 160, preventDefault() {} });
  await documentListeners.pointerup({ clientX: 160, preventDefault() {} });

  assert.equal(submittedOperations.length, 1);
  assert.deepEqual(submittedOperations[0], {
    kind: 'update_clip',
    payload: {
      clip_id: 'clip_1',
      start_ms: 1600,
      duration_ms: 1500,
      params: { text: 'Opening title' },
    },
  });
  assert.match(inspectorNode.textContent, /1600ms/);
  assert.equal(controller.getState().clips[0].start_ms, 1600);
});

test('dragging a timeline clip clamps start time at zero', async () => {
  const documentListeners = {};
  const doc = {
    createElement,
    addEventListener(type, handler) {
      documentListeners[type] = handler;
    },
    removeEventListener(type, handler) {
      if (documentListeners[type] === handler) {
        delete documentListeners[type];
      }
    },
  };
  const submittedOperations = [];
  const trackListNode = createElement('section');
  const controller = mediaEditor.createController({
    documentObject: doc,
    titleNode: createElement('h1'),
    trackListNode,
    emptyStateNode: createElement('p'),
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: operation.payload.start_ms, duration_ms: operation.payload.duration_ms, params: { text: 'Opening title' } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 300, duration_ms: 1500, params: { text: 'Opening title' } }],
  });

  const clipNode = trackListNode.children[0].children[1];
  clipNode.listeners.pointerdown({ currentTarget: clipNode, clientX: 100, preventDefault() {} });
  await documentListeners.pointerup({ clientX: 20, preventDefault() {} });

  assert.equal(submittedOperations[0].payload.start_ms, 0);
});

test('dragging the right trim handle changes clip duration without moving the start', async () => {
  const documentListeners = {};
  const submittedOperations = [];
  const doc = {
    createElement,
    addEventListener(type, handler) {
      documentListeners[type] = handler;
    },
    removeEventListener(type, handler) {
      if (documentListeners[type] === handler) {
        delete documentListeners[type];
      }
    },
  };
  const trackListNode = createElement('section');
  const controller = mediaEditor.createController({
    documentObject: doc,
    titleNode: createElement('h1'),
    trackListNode,
    emptyStateNode: createElement('p'),
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: operation.payload.start_ms, duration_ms: operation.payload.duration_ms, params: { text: 'Opening title' } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 1000, duration_ms: 1500, params: { text: 'Opening title' } }],
  });

  const clipNode = trackListNode.children[0].children[1];
  const rightHandle = clipNode.children.find((child) => child.dataset.trimEdge === 'right');
  assert.ok(rightHandle);

  rightHandle.listeners.pointerdown({ currentTarget: rightHandle, clientX: 100, preventDefault() {}, stopPropagation() {} });
  documentListeners.pointermove({ clientX: 150, preventDefault() {} });
  await documentListeners.pointerup({ clientX: 150, preventDefault() {} });

  assert.deepEqual(submittedOperations[0], {
    kind: 'update_clip',
    payload: {
      clip_id: 'clip_1',
      start_ms: 1000,
      duration_ms: 2000,
      params: { text: 'Opening title' },
    },
  });
});

test('dragging the left trim handle moves start and preserves the original end', async () => {
  const documentListeners = {};
  const submittedOperations = [];
  const doc = {
    createElement,
    addEventListener(type, handler) {
      documentListeners[type] = handler;
    },
    removeEventListener(type, handler) {
      if (documentListeners[type] === handler) {
        delete documentListeners[type];
      }
    },
  };
  const trackListNode = createElement('section');
  const controller = mediaEditor.createController({
    documentObject: doc,
    titleNode: createElement('h1'),
    trackListNode,
    emptyStateNode: createElement('p'),
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: operation.payload.start_ms, duration_ms: operation.payload.duration_ms, params: { text: 'Opening title' } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 1000, duration_ms: 1500, params: { text: 'Opening title' } }],
  });

  const clipNode = trackListNode.children[0].children[1];
  const leftHandle = clipNode.children.find((child) => child.dataset.trimEdge === 'left');
  assert.ok(leftHandle);

  leftHandle.listeners.pointerdown({ currentTarget: leftHandle, clientX: 100, preventDefault() {}, stopPropagation() {} });
  documentListeners.pointermove({ clientX: 140, preventDefault() {} });
  await documentListeners.pointerup({ clientX: 140, preventDefault() {} });

  assert.deepEqual(submittedOperations[0], {
    kind: 'update_clip',
    payload: {
      clip_id: 'clip_1',
      start_ms: 1400,
      duration_ms: 1100,
      params: { text: 'Opening title' },
    },
  });
});

test('left trim handle clamps at zero and extends duration to the original end', async () => {
  const documentListeners = {};
  const submittedOperations = [];
  const doc = {
    createElement,
    addEventListener(type, handler) {
      documentListeners[type] = handler;
    },
    removeEventListener(type, handler) {
      if (documentListeners[type] === handler) {
        delete documentListeners[type];
      }
    },
  };
  const trackListNode = createElement('section');
  const controller = mediaEditor.createController({
    documentObject: doc,
    titleNode: createElement('h1'),
    trackListNode,
    emptyStateNode: createElement('p'),
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: operation.payload.start_ms, duration_ms: operation.payload.duration_ms, params: { text: 'Opening title' } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 300, duration_ms: 1200, params: { text: 'Opening title' } }],
  });

  const clipNode = trackListNode.children[0].children[1];
  const leftHandle = clipNode.children.find((child) => child.dataset.trimEdge === 'left');
  leftHandle.listeners.pointerdown({ currentTarget: leftHandle, clientX: 100, preventDefault() {}, stopPropagation() {} });
  await documentListeners.pointerup({ clientX: 20, preventDefault() {} });

  assert.equal(submittedOperations[0].payload.start_ms, 0);
  assert.equal(submittedOperations[0].payload.duration_ms, 1500);
});

test('duplicateSelectedClip submits duplicate_clip at the source clip end', async () => {
  const submittedOperations = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 3500 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [
          { clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1500, params: { text: 'Opening title' } },
          { clip_id: 'clip_2', track_id: 'track_text', kind: 'text', start_ms: 2000, duration_ms: 1500, params: { text: 'Opening title' } },
        ],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 2000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1500, params: { text: 'Opening title' } }],
  });
  controller.selectClip('clip_1');

  await controller.duplicateSelectedClip();

  assert.deepEqual(submittedOperations, [
    {
      kind: 'duplicate_clip',
      payload: { clip_id: 'clip_1', start_ms: 2000 },
    },
  ]);
  assert.equal(controller.getState().clips.length, 2);
});


test('copySelectedClip and pasteCopiedClip duplicate a clip at the current playhead', async () => {
  const submittedOperations = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5750 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [
          { clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1500, params: { text: 'Opening title' } },
          { clip_id: 'clip_pasted', track_id: 'track_text', kind: 'text', start_ms: 4250, duration_ms: 1500, params: { text: 'Opening title' } },
        ],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1500, params: { text: 'Opening title' } }],
  });
  controller.selectClip('clip_1');
  controller.copySelectedClip();
  controller.setPlayheadMs(4250);

  await controller.pasteCopiedClip();

  assert.deepEqual(submittedOperations, [
    {
      kind: 'duplicate_clip',
      payload: { clip_id: 'clip_1', start_ms: 4250 },
    },
  ]);
  assert.equal(controller.getState().clips[1].clip_id, 'clip_pasted');
});


test('splitSelectedClip submits split_clip at the current playhead', async () => {
  const submittedOperations = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 3000 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [
          { clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1000, params: { text: 'Opening title' } },
          { clip_id: 'clip_split', track_id: 'track_text', kind: 'text', start_ms: 1500, duration_ms: 1000, params: { text: 'Opening title' } },
        ],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 3000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 2000, params: { text: 'Opening title' } }],
  });
  controller.selectClip('clip_1');
  controller.setPlayheadMs(1500);

  await controller.splitSelectedClip();

  assert.deepEqual(submittedOperations, [
    {
      kind: 'split_clip',
      payload: { clip_id: 'clip_1', split_ms: 1500 },
    },
  ]);
  assert.equal(controller.getState().clips.length, 2);
});


test('scrubber input updates playhead and preview text', () => {
  const previewStageNode = createElement('section');
  const scrubberNode = createElement('input');
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    previewStageNode,
    scrubberNode,
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [
      { clip_id: 'clip_intro', track_id: 'track_text', kind: 'text', start_ms: 0, duration_ms: 1000, params: { text: 'Intro' } },
      { clip_id: 'clip_middle', track_id: 'track_text', kind: 'text', start_ms: 1000, duration_ms: 1000, params: { text: 'Middle' } },
    ],
  });

  scrubberNode.value = '1250';
  scrubberNode.listeners.input({ currentTarget: scrubberNode });

  assert.equal(controller.getPlaybackState().playheadMs, 1250);
  assert.equal(previewStageNode.children[0].textContent, 'Middle');
});

test('play button toggles playback and advances playhead with injected clock', () => {
  const playButton = createElement('button');
  const previewStageNode = createElement('section');
  let now = 1000;
  const intervals = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    previewStageNode,
    playButton,
    nowFn: () => now,
    setIntervalFn: (handler, _ms) => {
      intervals.push(handler);
      return 'interval_1';
    },
    clearIntervalFn: () => {},
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 4000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 0, duration_ms: 4000, params: { text: 'Playing title' } }],
  });

  playButton.click();
  now = 1750;
  intervals[0]();

  assert.equal(controller.getPlaybackState().isPlaying, true);
  assert.equal(controller.getPlaybackState().playheadMs, 750);
  assert.equal(playButton.textContent, 'Pause');

  playButton.click();
  assert.equal(controller.getPlaybackState().isPlaying, false);
  assert.equal(playButton.textContent, 'Play');
});

test('keyboard shortcuts delete duplicate copy paste and play selected timeline clips', async () => {
  const documentListeners = {};
  const submittedOperations = [];
  const doc = {
    createElement,
    addEventListener(type, handler) {
      documentListeners[type] = handler;
    },
    removeEventListener(type, handler) {
      if (documentListeners[type] === handler) {
        delete documentListeners[type];
      }
    },
  };
  const prevented = [];
  const playButton = createElement('button');
  const controller = mediaEditor.createController({
    documentObject: doc,
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    playButton,
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      if (operation.kind === 'delete_clip') {
        return {
          project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
          tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
          clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1500, params: { text: 'Opening title' } }],
        };
      }
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1500, params: { text: 'Opening title' } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1500, params: { text: 'Opening title' } }],
  });
  controller.selectClip('clip_1');
  controller.setPlayheadMs(3500);

  assert.equal(typeof documentListeners.keydown, 'function');
  await documentListeners.keydown({ key: 'd', ctrlKey: true, preventDefault() { prevented.push('duplicate'); } });
  await documentListeners.keydown({ key: 'c', metaKey: true, preventDefault() { prevented.push('copy'); } });
  await documentListeners.keydown({ key: 'v', ctrlKey: true, preventDefault() { prevented.push('paste'); } });
  controller.setPlayheadMs(1500);
  await documentListeners.keydown({ key: 's', ctrlKey: true, preventDefault() { prevented.push('split'); } });
  await documentListeners.keydown({ key: 'Backspace', preventDefault() { prevented.push('delete'); } });
  await documentListeners.keydown({ key: ' ', preventDefault() { prevented.push('space'); } });

  assert.deepEqual(submittedOperations, [
    { kind: 'duplicate_clip', payload: { clip_id: 'clip_1', start_ms: 2000 } },
    { kind: 'duplicate_clip', payload: { clip_id: 'clip_1', start_ms: 3500 } },
    { kind: 'split_clip', payload: { clip_id: 'clip_1', split_ms: 1500 } },
    { kind: 'delete_clip', payload: { clip_id: 'clip_1' } },
  ]);
  assert.deepEqual(prevented, ['duplicate', 'copy', 'paste', 'split', 'delete', 'space']);
  assert.equal(controller.getPlaybackState().isPlaying, true);
  assert.equal(playButton.textContent, 'Pause');
});

test('keyboard shortcuts do not fire while typing in editor inputs', async () => {
  const documentListeners = {};
  const submittedOperations = [];
  const doc = {
    createElement,
    addEventListener(type, handler) {
      documentListeners[type] = handler;
    },
  };
  const playButton = createElement('button');
  const inputTarget = createElement('input');
  const controller = mediaEditor.createController({
    documentObject: doc,
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    playButton,
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return { project: { project_id: 'proj_1' }, tracks: [], clips: [] };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1500, params: { text: 'Opening title' } }],
  });
  controller.selectClip('clip_1');

  await documentListeners.keydown({ key: 'Backspace', target: inputTarget, preventDefault() { throw new Error('shortcut should not prevent input typing'); } });
  await documentListeners.keydown({ key: ' ', target: inputTarget, preventDefault() { throw new Error('shortcut should not prevent input typing'); } });
  await documentListeners.keydown({ key: 'd', ctrlKey: true, target: inputTarget, preventDefault() { throw new Error('shortcut should not prevent input typing'); } });

  assert.equal(submittedOperations.length, 0);
  assert.equal(controller.getPlaybackState().isPlaying, false);
  assert.equal(playButton.textContent, 'Play');
});


test('undo and redo actions restore returned project state', async () => {
  const historyActions = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    submitHistoryAction: async (action) => {
      historyActions.push(action);
      if (action === 'undo') {
        return {
          project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 1000 },
          tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
          clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 0, duration_ms: 1000, params: { text: 'Before' } }],
          operation: { operation_id: 'op_2', kind: 'update_clip', status: 'undone' },
        };
      }
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 2000 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1500, params: { text: 'After' } }],
        operation: { operation_id: 'op_2', kind: 'update_clip', status: 'applied' },
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 2000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 500, duration_ms: 1500, params: { text: 'After' } }],
  });

  await controller.undoTimelineEdit();
  assert.equal(controller.getState().clips[0].params.text, 'Before');
  assert.equal(controller.getState().clips[0].start_ms, 0);

  await controller.redoTimelineEdit();
  assert.deepEqual(historyActions, ['undo', 'redo']);
  assert.equal(controller.getState().clips[0].params.text, 'After');
  assert.equal(controller.getState().clips[0].start_ms, 500);
});

test('keyboard shortcuts send ctrl-z to undo and ctrl-shift-z to redo', async () => {
  const documentListeners = {};
  const historyActions = [];
  const doc = {
    createElement,
    addEventListener(type, handler) {
      documentListeners[type] = handler;
    },
  };
  const prevented = [];
  const controller = mediaEditor.createController({
    documentObject: doc,
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    submitHistoryAction: async (action) => {
      historyActions.push(action);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 1000 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 0, duration_ms: 1000, params: { text: action } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 1000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 0, duration_ms: 1000, params: { text: 'Clip' } }],
  });

  await documentListeners.keydown({ key: 'z', ctrlKey: true, preventDefault() { prevented.push('undo'); } });
  await documentListeners.keydown({ key: 'z', metaKey: true, shiftKey: true, preventDefault() { prevented.push('redo'); } });

  assert.deepEqual(historyActions, ['undo', 'redo']);
  assert.deepEqual(prevented, ['undo', 'redo']);
  assert.equal(controller.getState().clips[0].params.text, 'redo');
});

test('exportProject submits an export and renders the completed job link', async () => {
  const exportPanelNode = createElement('section');
  const exportActions = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    exportPanelNode,
    submitExportAction: async () => {
      exportActions.push('export');
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 2000 },
        tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
        clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 0, duration_ms: 2000, params: { text: 'Exported' } }],
        export_jobs: [
          {
            export_job_id: 'export_1',
            status: 'completed',
            output_path: '/api/media-projects/proj_1/export-jobs/export_1/output.mp4',
            metadata: { format: 'mp4' },
          },
        ],
        export_job: {
          export_job_id: 'export_1',
          status: 'completed',
          output_path: '/api/media-projects/proj_1/export-jobs/export_1/output.mp4',
          metadata: { format: 'mp4' },
        },
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 2000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [{ clip_id: 'clip_1', track_id: 'track_text', kind: 'text', start_ms: 0, duration_ms: 2000, params: { text: 'Exported' } }],
    export_jobs: [],
  });

  assert.match(elementText(exportPanelNode), /No exports yet/i);

  await controller.exportProject();

  assert.deepEqual(exportActions, ['export']);
  assert.match(elementText(exportPanelNode), /completed/i);
  assert.match(elementText(exportPanelNode), /Download mp4/i);
  const completedLink = exportPanelNode.children.find((child) => child.tagName === 'a');
  assert.equal(completedLink.href, '/api/media-projects/proj_1/export-jobs/export_1/output.mp4');
});


test('export panel renders recent exports with readable failed errors and disabled rendering state', () => {
  const exportPanelNode = createElement('section');
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    exportPanelNode,
  });

  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 2000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [],
    export_jobs: [
      { export_job_id: 'export_rendering', status: 'rendering', metadata: {} },
      { export_job_id: 'export_failed', status: 'failed', metadata: { error: 'ffmpeg exited with code 1' } },
      { export_job_id: 'export_done', status: 'completed', output_path: '/api/media-projects/proj_1/export-jobs/export_done/output.mp4', metadata: { format: 'mp4' } },
    ],
  });

  assert.match(elementText(exportPanelNode), /Rendering…/i);
  assert.match(elementText(exportPanelNode), /Recent exports/i);
  assert.match(elementText(exportPanelNode), /Failed: ffmpeg exited with code 1/i);
  assert.match(elementText(exportPanelNode), /Download mp4/i);
  assert.equal(exportPanelNode.children[0].disabled, true);
});


test('exportProject shows rendering state immediately while export request is pending', async () => {
  const exportPanelNode = createElement('section');
  let resolveExport;
  const pendingExport = new Promise((resolve) => {
    resolveExport = resolve;
  });
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    exportPanelNode,
    submitExportAction: async () => pendingExport,
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 2000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [],
    export_jobs: [],
  });

  const exportPromise = controller.exportProject();

  assert.match(elementText(exportPanelNode), /Rendering…/i);
  assert.equal(exportPanelNode.children[0].disabled, true);

  resolveExport({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 2000 },
    tracks: [{ track_id: 'track_text', kind: 'text', label: 'Text' }],
    clips: [],
    export_jobs: [{ export_job_id: 'export_1', status: 'completed', output_path: '/api/media-projects/proj_1/export-jobs/export_1/output.mp4', metadata: { format: 'mp4' } }],
  });
  await exportPromise;

  assert.match(elementText(exportPanelNode), /completed/i);
  assert.equal(exportPanelNode.children[0].disabled, false);
});


test('addAudioClip uploads selected audio file onto audio rail', async () => {
  const audioFile = { name: 'music.mp3' };
  const audioFileInput = { files: [audioFile], value: 'music.mp3' };
  const uploads = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    audioFileInput,
    submitAudioUpload: async (payload) => {
      uploads.push(payload);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft' },
        tracks: [{ track_id: 'track_audio', kind: 'audio', label: 'Audio' }],
        assets: [{ asset_id: 'asset_audio', kind: 'audio', label: 'music.mp3', storage_path: '/api/media-projects/proj_1/uploaded-assets/music.mp3' }],
        clips: [{ clip_id: 'clip_audio', kind: 'audio', track_id: 'track_audio', asset_id: 'asset_audio', start_ms: 1000, duration_ms: 3000, params: { gain: 0.5 } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_audio', kind: 'audio', label: 'Audio' }],
    clips: [],
  });
  controller.setPlayheadMs(1000);

  await controller.addAudioClip();

  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].file, audioFile);
  assert.equal(uploads[0].trackId, 'track_audio');
  assert.equal(uploads[0].startMs, 1000);
  assert.equal(uploads[0].durationMs, 3000);
  assert.equal(audioFileInput.value, '');
  assert.equal(controller.getState().clips[0].kind, 'audio');
});

test('asset bin renders audio assets and places them on the audio rail', async () => {
  const assetBinNode = createElement('section');
  const submittedOperations = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    assetBinNode,
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft' },
        tracks: [{ track_id: 'track_audio', kind: 'audio', label: 'Audio' }],
        assets: [{ asset_id: 'asset_audio', kind: 'audio', label: 'Music bed', storage_path: '/api/media-projects/proj_1/uploaded-assets/music.mp3' }],
        clips: [{ clip_id: 'clip_audio', kind: 'audio', track_id: 'track_audio', asset_id: 'asset_audio', start_ms: 2000, duration_ms: 3000, params: { gain: 1 } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_audio', kind: 'audio', label: 'Audio' }],
    assets: [{ asset_id: 'asset_audio', kind: 'audio', label: 'Music bed', storage_path: '/api/media-projects/proj_1/uploaded-assets/music.mp3' }],
    clips: [],
  });
  controller.setPlayheadMs(2000);

  await assetBinNode.children[0].click();

  assert.equal(submittedOperations[0].kind, 'create_clip_from_asset');
  assert.equal(submittedOperations[0].payload.track_id, 'track_audio');
  assert.equal(submittedOperations[0].payload.asset_id, 'asset_audio');
  assert.equal(submittedOperations[0].payload.start_ms, 2000);
  assert.deepEqual(submittedOperations[0].payload.params, { gain: 1 });
});


test('addVideoClip uploads a selected file onto the visual rail', async () => {
  const videoFile = { name: 'opening.mp4', type: 'video/mp4', size: 128 };
  const videoFileInput = { files: [videoFile], value: 'opening.mp4' };
  const uploads = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    videoFileInput,
    submitVideoUpload: async ({ file, trackId, startMs, durationMs }) => {
      uploads.push({ file, trackId, startMs, durationMs });
      return {
        ok: true,
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 3000 },
        tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
        assets: [{ asset_id: 'asset_video', kind: 'video', storage_path: '/api/media-projects/proj_1/uploaded-assets/opening.mp4', label: 'opening.mp4' }],
        clips: [{ clip_id: 'clip_video', track_id: 'track_visual', asset_id: 'asset_video', kind: 'video', start_ms: 0, duration_ms: 3000, params: { fit: 'cover' } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft' },
    tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
    clips: [],
  });

  await controller.addVideoClip();

  assert.deepEqual(uploads, [{ file: videoFile, trackId: 'track_visual', startMs: 0, durationMs: 3000 }]);
  assert.equal(videoFileInput.value, '');
  assert.equal(controller.getState().assets[0].kind, 'video');
  assert.equal(controller.getState().clips[0].kind, 'video');
});

test('preview renders active video clips below text overlays', () => {
  const previewStageNode = createElement('section');
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    previewStageNode,
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [
      { track_id: 'track_visual', kind: 'visual', label: 'Visual' },
      { track_id: 'track_text', kind: 'text', label: 'Text' },
    ],
    assets: [{ asset_id: 'asset_video', kind: 'video', storage_path: '/uploads/shot.mp4', label: 'Opening shot' }],
    clips: [
      { clip_id: 'clip_video', track_id: 'track_visual', asset_id: 'asset_video', kind: 'video', start_ms: 0, duration_ms: 3000, params: { fit: 'cover' } },
      { clip_id: 'clip_text', track_id: 'track_text', kind: 'text', start_ms: 1000, duration_ms: 1000, params: { text: 'Overlay title' } },
    ],
  });

  controller.setPlayheadMs(1500);

  assert.equal(previewStageNode.children[0].tagName, 'video');
  assert.equal(previewStageNode.children[0].className, 'media-editor__preview-video');
  assert.equal(previewStageNode.children[0].src, '/uploads/shot.mp4');
  assert.equal(previewStageNode.children[1].textContent, 'Overlay title');
});

test('asset bin renders video assets and places them on the visual rail', async () => {
  const assetBinNode = createElement('section');
  const submittedOperations = [];
  const controller = mediaEditor.createController({
    documentObject: { createElement },
    titleNode: createElement('h1'),
    trackListNode: createElement('section'),
    emptyStateNode: createElement('p'),
    assetBinNode,
    submitOperation: async (operation) => {
      submittedOperations.push(operation);
      return {
        project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 4500 },
        tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
        assets: [{ asset_id: 'asset_video', kind: 'video', storage_path: '/uploads/shot.webm', label: 'B-roll' }],
        clips: [{ clip_id: 'clip_reused', track_id: 'track_visual', asset_id: 'asset_video', kind: 'video', start_ms: 1500, duration_ms: 3000, params: { fit: 'cover' } }],
      };
    },
  });
  controller.loadProject({
    project: { project_id: 'proj_1', title: 'Video editor draft', duration_ms: 5000 },
    tracks: [{ track_id: 'track_visual', kind: 'visual', label: 'Visual' }],
    assets: [{ asset_id: 'asset_video', kind: 'video', storage_path: '/uploads/shot.webm', label: 'B-roll' }],
    clips: [],
  });
  controller.setPlayheadMs(1500);

  assert.equal(assetBinNode.children.length, 1);
  assert.match(assetBinNode.children[0].textContent, /B-roll/);
  assert.match(assetBinNode.children[0].textContent, /Video/);
  await assetBinNode.children[0].click();

  assert.equal(submittedOperations[0].kind, 'create_clip_from_asset');
  assert.equal(submittedOperations[0].payload.track_id, 'track_visual');
  assert.equal(submittedOperations[0].payload.asset_id, 'asset_video');
  assert.deepEqual(submittedOperations[0].payload.params, { fit: 'cover' });
});
