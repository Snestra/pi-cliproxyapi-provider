import type { JsonRepresentation } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { CliproxyModel } from "../core/catalog.ts";
import { canSearch, selectSearchModel } from "../web-search/model-selector.ts";
import { runWebSearch } from "../web-search/search.ts";
import type { WebSearchSource } from "../web-search/search.ts";
import { completeFrom } from "./completions.ts";
import type { Settings } from "./config.ts";
import { errorText } from "./error-text.ts";

const WebSearchParameters = Type.Object({
  query: Type.String({
    description: "The web search query keywords or question to look up online",
    minLength: 1,
  }),
});

const WebSearchOutputSchema = Type.Object({
  query: Type.String({ description: "The trimmed search query" }),
  sources: Type.Array(
    Type.Object({
      title: Type.Optional(Type.String()),
      url: Type.String(),
    }),
    { description: "All unique sources reported by the search response" }
  ),
  text: Type.String({
    description: "Search summary, including any appended source links",
  }),
});

export interface WebSearchOutput {
  query: string;
  sources: WebSearchSource[];
  text: string;
}

export interface WebSearchDetails {
  durationMs?: number;
  model?: string;
  provider?: string;
  query?: string;
  sourcesCount?: number;
}

export interface RegisterWebSearchOptions {
  settings: Settings;
  getModels: () => readonly CliproxyModel[];
  /** The catalog without models that are out of quota. Searches pick from these. */
  getAvailableModels: () => readonly CliproxyModel[];
  getStandardCost: (modelId: string) => CliproxyModel["cost"];
}

export interface PickSearchModelOptions {
  models: readonly CliproxyModel[];
  /** Search requests never ask for the priority tier, so they rank and bill at standard prices. */
  getStandardCost: (modelId: string) => CliproxyModel["cost"];
  preferred?: string;
}

/** The search model, priced at standard rates. */
export const pickSearchModel = (
  options: PickSearchModelOptions
): CliproxyModel | undefined =>
  selectSearchModel(
    options.models.map((model) => ({
      ...model,
      cost: options.getStandardCost(model.id),
    })),
    options.preferred
  );

/** Arguments that hand the choice back to pickSearchModel. A bare command means the same without a UI. */
const AUTO_ARGUMENTS = new Set(["", "auto", "clear", "current", "reset"]);

const appendSources = (answer: string, sources: WebSearchSource[]): string => {
  if (
    sources.length === 0 ||
    answer.includes("http://") ||
    answer.includes("https://")
  ) {
    return answer;
  }

  const links = sources
    .slice(0, 8)
    .map(
      (source, index) =>
        `${index + 1}. [${source.title || source.url}](${source.url})`
    );

  return `${answer}\n\n## Sources\n${links.join("\n")}`;
};

export const registerWebSearch = (
  pi: ExtensionAPI,
  options: RegisterWebSearchOptions
): void => {
  pi.registerTool({
    annotations: {
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
      readOnlyHint: true,
    },
    description:
      "Search the web for real-time, current, or online information (such as weather, news, recent events, documentation, or public web data) and return the results.",
    execute: async (_toolCallId, params, signal, onUpdate) => {
      const startedAt = Date.now();
      const query = params.query.trim();

      const { settings } = options;
      const connection = settings.connection();

      if (!connection) {
        throw new Error(
          `CLIProxyAPI is not configured. Run /login ${settings.providerId}.`
        );
      }

      const model = pickSearchModel({
        getStandardCost: options.getStandardCost,
        models: options.getAvailableModels(),
        preferred: settings.config().searchModel,
      });

      if (!model) {
        throw new Error(
          "No CLIProxyAPI search model is available. Run /cliproxyapi-refresh."
        );
      }

      const details: WebSearchDetails = {
        model: model.id,
        provider: model.provider,
        query,
      };

      const result = await runWebSearch({
        apiKey: connection.apiKey,
        model,
        onProgress: (event) => {
          onUpdate?.({
            content: [{ text: event.message, type: "text" }],
            details,
          });
        },
        query,
        responsesUrl: connection.responsesUrl,
        signal,
      });

      const text = appendSources(result.answer, result.sources);

      const structuredContent: JsonRepresentation<WebSearchOutput> = {
        query,
        sources: result.sources,
        text,
      };

      const toolResult = {
        content: [{ text, type: "text" as const }],
        details: {
          ...details,
          durationMs: Date.now() - startedAt,
          sourcesCount: result.sources.length,
        },
        structuredContent,
      };

      if (result.usage) {
        return { ...toolResult, usage: result.usage };
      }

      return toolResult;
    },
    exposure: "direct",
    label: "web_search",
    name: "web_search",
    outputSchema: WebSearchOutputSchema,
    parameters: WebSearchParameters,
    promptGuidelines: [
      "Use the `web_search` tool for any questions that require real-time, current, or online information (e.g., weather, news, recent events, latest releases).",
      "Do NOT attempt to run shell commands (such as bash, PowerShell, curl, wget, python, or scripts) to search the web or check weather/news when `web_search` is available.",
      "Use the returned web search results to formulate your response accurately.",
    ],
    promptSnippet: "Search current and real-time information",
  });

  const searchModelIds = (): string[] =>
    options
      .getModels()
      .filter(canSearch)
      .map((model) => model.id);

  const saveSearchModel = (
    ctx: ExtensionCommandContext,
    searchModel: string | undefined
  ): void => {
    try {
      options.settings.save({ searchModel });
    } catch (error) {
      ctx.ui.notify(
        `Failed to save the web search model: ${errorText(error)}`,
        "error"
      );

      return;
    }

    ctx.ui.notify(
      searchModel
        ? `Web search model set to: ${searchModel}`
        : "Web search will choose a model automatically.",
      "info"
    );
  };

  const pickFromMenu = async (ctx: ExtensionCommandContext): Promise<void> => {
    const ids = searchModelIds();

    const automatic = pickSearchModel({
      getStandardCost: options.getStandardCost,
      models: options.getAvailableModels(),
    });

    const autoChoice = `auto (currently ${automatic?.id ?? "none"})`;

    const choice = await ctx.ui.select("Web search model", [
      autoChoice,
      ...ids,
    ]);

    if (choice === undefined) {
      return;
    }

    saveSearchModel(ctx, choice === autoChoice ? undefined : choice);
  };

  pi.registerCommand("websearch-model", {
    description:
      "Set the CLIProxyAPI model used for web_search (/websearch-model [model-id|auto])",
    getArgumentCompletions: (prefix) =>
      completeFrom(["auto", ...searchModelIds()], prefix),
    handler: async (args, ctx) => {
      const requested = args.trim();

      if (!requested && ctx.hasUI) {
        await pickFromMenu(ctx);

        return;
      }

      if (AUTO_ARGUMENTS.has(requested)) {
        saveSearchModel(ctx, undefined);

        return;
      }

      const model = searchModelIds().find(
        (id) => id.toLowerCase() === requested.toLowerCase()
      );

      if (!model) {
        ctx.ui.notify(
          `Model "${requested}" is not a CLIProxyAPI model that can search the web.`,
          "warning"
        );

        return;
      }

      saveSearchModel(ctx, model);
    },
  });
};
