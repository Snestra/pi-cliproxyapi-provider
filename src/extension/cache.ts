import { rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { memoByFile, readJsonFile, writeJsonAtomic } from "./files.ts";

type Env = Readonly<Record<string, string | undefined>>;

/** One file for every cache the extension keeps, outside pi's agent dir. */
export const cacheFilePath = (env: Env): string =>
  path.join(
    env.XDG_CACHE_HOME?.trim() || path.join(os.homedir(), ".cache"),
    "pi-cliproxyapi",
    "cache.json"
  );

/** The cache files older versions wrote into the agent dir. */
const OLD_CACHE_FILES = [
  "cliproxyapi-provider-models.json",
  "cliproxyapi-prices.json",
  "cliproxyapi-usage.json",
] as const;

export const removeOldCacheFiles = (agentDir: string): void => {
  for (const name of OLD_CACHE_FILES) {
    rmSync(path.join(agentDir, name), { force: true });
  }
};

export type CacheSectionName = "models" | "prices" | "usage";

const CacheFileSchema = Type.Record(Type.String(), Type.Unknown());

/** The whole file, or an empty one when it is missing or damaged, since it only holds caches. */
const readAll = (filePath: string): Static<typeof CacheFileSchema> => {
  try {
    return readJsonFile(filePath, CacheFileSchema) ?? {};
  } catch {
    return {};
  }
};

/**
 * One part of the shared cache file. A section with an unexpected shape, for
 * example one an older version wrote, reads as missing, and the other
 * sections still read.
 */
export class CacheSection<Schema extends TSchema> {
  private readonly filePath: string;
  private readonly name: CacheSectionName;
  private readonly schema: Schema;

  constructor(filePath: string, name: CacheSectionName, schema: Schema) {
    this.filePath = filePath;
    this.name = name;
    this.schema = schema;
  }

  /** Shared through the file memo, so callers build new objects instead of changing it. */
  read(): Static<Schema> | undefined {
    return memoByFile(
      this.filePath,
      () => {
        const value = readAll(this.filePath)[this.name];

        return Value.Check(this.schema, value) ? value : undefined;
      },
      this.name
    );
  }

  /** Reads the file again just before the write, so sections other pi processes wrote stay. */
  write(value: Static<Schema>): void {
    writeJsonAtomic(this.filePath, {
      ...readAll(this.filePath),
      [this.name]: value,
    });
  }
}
