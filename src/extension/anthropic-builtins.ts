import type {
  AnthropicMessagesCompat,
  ModelPromptCache,
} from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

const BUILTIN = new Map(
  getBuiltinModels("anthropic").map((model) => [model.id, model])
);

/** pi-ai's own Anthropic model, matched on the id or its segment after the last "/". */
const builtin = (id: string) => {
  const modelId = id.trim().toLowerCase();
  const segment = modelId.slice(modelId.lastIndexOf("/") + 1);

  return BUILTIN.get(modelId) ?? BUILTIN.get(segment);
};

/** pi-ai's own Anthropic prompt cache lifetimes. */
export const anthropicPromptCache = (
  id: string
): ModelPromptCache | undefined => {
  const lifetimes = builtin(id)?.promptCache;

  return lifetimes ? { ...lifetimes } : undefined;
};

/** pi-ai's own Anthropic compat flags, such as forceAdaptiveThinking. */
export const anthropicCompat = (
  id: string
): AnthropicMessagesCompat | undefined => {
  const compat = builtin(id)?.compat;

  return compat ? { ...compat } : undefined;
};
