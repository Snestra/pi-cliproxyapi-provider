const searchModelRank = (modelId: string): number => {
  const normalized = modelId.trim().toLowerCase();

  const isGpt =
    /(?:^|[^a-z0-9])gpt(?:[^a-z0-9]|$)/u.test(normalized) ||
    normalized.startsWith("gpt");

  const isClaude = normalized.includes("claude");

  if (isGpt && normalized.includes("fast")) {
    return 0;
  }

  if (isGpt) {
    return 1;
  }

  if (isClaude && normalized.includes("haiku")) {
    return 2;
  }

  if (isClaude) {
    return 3;
  }

  return 4;
};

/** Only a catalog that says no rules a model out; unknown support counts. */
export const canSearch = (model: { supportsWebSearch?: boolean }): boolean =>
  model.supportsWebSearch !== false;

/** A pi-ai Model fits this shape. */
export interface SearchCandidate {
  id: string;
  cost?: { input: number };
  supportsWebSearch?: boolean;
}

/** Zero means pricing is unknown, so it sorts after every priced model. */
const inputPrice = (candidate: SearchCandidate): number => {
  const input = candidate.cost?.input ?? 0;

  return input > 0 ? input : Number.POSITIVE_INFINITY;
};

export const selectSearchModel = <T extends SearchCandidate>(
  models: readonly T[],
  preferred?: string
): T | undefined => {
  const candidates = models.filter(
    (model) => model.id.trim().length > 0 && canSearch(model)
  );

  if (candidates.length === 0) {
    return undefined;
  }

  if (preferred?.trim()) {
    const wanted = preferred.trim().toLowerCase();

    const match = candidates.find(
      (model) => model.id.trim().toLowerCase() === wanted
    );

    if (match) {
      return match;
    }
  }

  const ranked = candidates
    .map((model, index) => ({
      index,
      model,
      price: inputPrice(model),
      rank: searchModelRank(model.id),
      supportGroup: model.supportsWebSearch === true ? 0 : 1,
    }))
    .toSorted(
      (a, b) =>
        a.supportGroup - b.supportGroup ||
        a.rank - b.rank ||
        (a.price === b.price ? 0 : a.price - b.price) ||
        a.index - b.index
    );

  return ranked[0]?.model;
};
