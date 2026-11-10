import type {
  AnthropicMessagesCompat,
  ModelPromptCache,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

import { modelSegment } from "../core/catalog.ts";

const BUILTIN = new Map(
  getBuiltinModels("anthropic").map((model) => [model.id, model])
);

const builtin = (id: string) => {
  const modelId = id.trim().toLowerCase();

  return BUILTIN.get(modelId) ?? BUILTIN.get(modelSegment(modelId));
};

export const anthropicPromptCache = (
  id: string
): ModelPromptCache | undefined => {
  const lifetimes = builtin(id)?.promptCache;

  return lifetimes ? { ...lifetimes } : undefined;
};

export const anthropicCompat = (
  id: string
): AnthropicMessagesCompat | undefined => {
  const compat = builtin(id)?.compat;

  return compat ? { ...compat } : undefined;
};
