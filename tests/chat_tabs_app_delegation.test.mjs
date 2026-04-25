import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const appJsUrl = new URL('../static/app.js', import.meta.url);

function extractFunctionBody(source, functionName) {
  const fnPattern = new RegExp(
    String.raw`function\s+${functionName}\s*\([^)]*\)\s*\{([\s\S]*?)\n\}`,
    'm',
  );
  const match = source.match(fnPattern);
  assert.ok(match, `expected to find function ${functionName}`);
  return match[1];
}

test('app.js chat tab wrappers delegate to chatTabsController', async () => {
  const source = await readFile(appJsUrl, 'utf8');
  assert.match(
    source,
    /function\s+createChatTabsControllerStateDeps\s*\([\s\S]*?return\s+\{[\s\S]*?renderedHistoryVirtualized,[\s\S]*?tabNodes,[\s\S]*?\};\s*\}/m,
    'app.js should isolate chat tab state/store wiring in createChatTabsControllerStateDeps(...)',
  );
  assert.match(
    source,
    /function\s+createChatTabsControllerUiDeps\s*\([\s\S]*?return\s+\{[\s\S]*?pinChatButton,[\s\S]*?renderTraceLog,[\s\S]*?\};\s*\}/m,
    'app.js should isolate chat tab DOM/presentation wiring in createChatTabsControllerUiDeps(...)',
  );
  assert.match(
    source,
    /function\s+createChatTabsControllerPolicyDeps\s*\([\s\S]*?return\s+\{[\s\S]*?resumeCycleCountByChat,[\s\S]*?nowFn,[\s\S]*?\};\s*\}/m,
    'app.js should isolate chat tab policy wiring in createChatTabsControllerPolicyDeps(...)',
  );
  assert.match(
    source,
    /function\s+createChatTabsControllerDeps\s*\(args\)\s*\{[\s\S]*?createChatTabsControllerStateDeps\(args\)[\s\S]*?createChatTabsControllerUiDeps\(args\)[\s\S]*?createChatTabsControllerPolicyDeps\(args\)[\s\S]*?\}/m,
    'app.js should compose chat tab deps from narrower helper bands',
  );
  assert.match(
    source,
    /function\s+createChatTabsController\s*\(\)\s*\{[\s\S]*?chatTabsHelpers\.createController\(createChatTabsControllerDeps\(\{[\s\S]*?mobileTabCarouselEnabled:\s*mobileTabCarouselFeatureEnabled,[\s\S]*?\}\)\);[\s\S]*?\}/m,
    'app.js should instantiate chatTabsController through createChatTabsController(...)',
  );
  assert.match(
    source,
    /(?:const\s+chatTabsController\s*=|chatTabsController\s*=)\s*createChatTabsController\(\);/m,
    'app.js should allocate chatTabsController through the createChatTabsController wrapper',
  );
  assert.match(
    source,
    /applyStoredPinnedChatsCollapsePreference\(\{[\s\S]*?chatTabsController,[\s\S]*?setPinnedChatsCollapsed:[\s\S]*?setHasPinnedChatsCollapsePreference:[\s\S]*?\}\);/m,
    'app.js should apply stored pinned-collapse state through a dedicated helper',
  );
  const delegateExpectations = [
    ['suppressBlockedChatPending', /return\s+chatTabsController\.suppressBlockedChatPending\(chatId\);/],
    ['clearReconnectResumeBlock', /return\s+chatTabsController\.clearReconnectResumeBlock\(chatId\);/],
    ['resetReconnectResumeBudget', /return\s+chatTabsController\.resetReconnectResumeBudget\(chatId\);/],
    ['consumeReconnectResumeBudget', /return\s+chatTabsController\.consumeReconnectResumeBudget\(chatId\);/],
    ['blockReconnectResume', /return\s+chatTabsController\.blockReconnectResume\(chatId\);/],
    ['isReconnectResumeBlocked', /return\s+chatTabsController\.isReconnectResumeBlocked\(chatId\);/],
    ['upsertChat', /return\s+chatTabsController\.upsertChat\(chat\);/],
    ['syncPinnedChats', /return\s+chatTabsController\.syncPinnedChats\(chatList\);/],
    ['syncChats', /return\s+chatTabsController\.syncChats\(chatList\);/],
  ];

  for (const [fnName, delegatedCall] of delegateExpectations) {
    const body = extractFunctionBody(source, fnName);
    assert.match(body, delegatedCall, `${fnName} should delegate through chatTabsController`);
  }
});
