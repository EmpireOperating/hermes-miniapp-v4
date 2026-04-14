(function (globalScope) {
  function resolveAttentionEffectsHelpers() {
    if (globalScope.HermesMiniappRuntimeAttentionEffects) {
      return globalScope.HermesMiniappRuntimeAttentionEffects;
    }
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try {
        return require("./runtime_attention_effects.js");
      } catch {
        return null;
      }
    }
    return null;
  }

  const attentionEffects = resolveAttentionEffectsHelpers();
  if (!attentionEffects) {
    throw new Error("HermesMiniappRuntimeAttentionEffects is required before runtime_unread_helpers.js");
  }

  function latestCompletedAssistantHapticKey(args) {
    return attentionEffects.latestCompletedAssistantEffectKey(args);
  }

  function createHapticUnreadController(args) {
    return attentionEffects.createAttentionEffectsController(args);
  }

  const api = {
    ...attentionEffects,
    latestCompletedAssistantHapticKey,
    createHapticUnreadController,
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  globalScope.HermesMiniappRuntimeUnread = api;
})(typeof window !== "undefined" ? window : globalThis);
