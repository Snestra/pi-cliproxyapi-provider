import { spawnSync } from "node:child_process";
import path from "node:path";

import type { Credential, OAuthCredentials } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import { Value } from "typebox/value";

import { DEFAULT_PROVIDER_ID, TrackedEntrySchema } from "../core/catalog.ts";
import type { TrackedEntry } from "../core/catalog.ts";
import {
  connectionTo,
  resolveBaseUrl,
  resolveConnection,
  resolveConnectionSources,
} from "../core/connection.ts";
import type {
  ConnectionSources,
  ConnectionValues,
  ResolvedConnection,
} from "../core/connection.ts";
import {
  memoByFile,
  readJsonFile,
  readJsonMemo,
  writeJsonAtomic,
} from "./files.ts";

const CONFIG_FILE_NAME = "cliproxyapi.json";
const MODELS_CACHE_FILE_NAME = "cliproxyapi-provider-models.json";
const DEFAULT_PROVIDER_NAME = "CLIProxyAPI";

/** pi keeps the /login key as an OAuth credential so it can carry the base URL, so it must never expire. */
const CREDENTIAL_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;

export const loginExpiry = (): number => Date.now() + CREDENTIAL_TTL_MS;
export const MANAGEMENT_KEY_ENV = "CLIPROXY_MANAGEMENT_KEY";
const KEY_COMMAND_TIMEOUT_MS = 10_000;
const OFFLINE_FLAG = /^(?:1|true|yes)$/iu;

/** The catalog as last fetched, before any local setting is applied. */
export interface ModelsCache {
  baseUrl: string;
  fetchedAt: number;
  entries: TrackedEntry[];
}

export type ManagementKeySource = "env" | "cliproxyapi.json";

export interface ManagementAccess {
  baseUrl: string;
  managementKey: string;
}

type Env = Readonly<Record<string, string | undefined>>;

const OptionalString = Type.Optional(Type.String());

const ConfigFileSchema = Type.Object({
  apiKey: OptionalString,
  baseUrl: OptionalString,
  fast: Type.Optional(Type.Boolean()),
  /** Own the footer with account usage rows. Defaults to true; false restores pi's stock footer. */
  footer: Type.Optional(Type.Boolean()),
  imageInput: Type.Optional(Type.Record(Type.String(), Type.Boolean())),
  /** Unlocks the usage footer and account-wide hiding. A value starting with "!" is a shell command. */
  managementKey: OptionalString,
  maxTokens: Type.Optional(
    Type.Record(Type.String(), Type.Integer({ minimum: 1 }))
  ),
  pause: Type.Optional(Type.Boolean()),
  providerId: OptionalString,
  providerName: OptionalString,
  searchModel: OptionalString,
  thinkingDisplay: Type.Optional(
    Type.Record(
      Type.String(),
      Type.Union([Type.Literal("summarized"), Type.Literal("omitted")])
    )
  ),
});

export type CliproxyConfig = Static<typeof ConfigFileSchema>;

const RefreshMetaSchema = Type.Object({ baseUrl: OptionalString });

const SettingsFileSchema = Type.Object({
  compaction: Type.Optional(
    Type.Object({ enabled: Type.Optional(Type.Boolean()) })
  ),
  defaultModel: OptionalString,
  defaultProvider: OptionalString,
});

const ModelsCacheFileSchema = Type.Object({
  baseUrl: Type.String(),
  entries: Type.Array(TrackedEntrySchema),
  fetchedAt: Type.Number(),
});

const nonEmpty = (value: string | undefined): string | undefined =>
  value?.trim() || undefined;

/** A key command's output, or why it gave none. Never holds the command text. */
type KeyCommandResult = { key: string } | { error: string };

const commandKeys = new Map<string, KeyCommandResult>();

const runKeyCommand = (command: string): KeyCommandResult => {
  const result = spawnSync("/bin/sh", ["-c", command], {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: KEY_COMMAND_TIMEOUT_MS,
  });

  if (result.error || result.signal) {
    return { error: "the key command timed out or could not start" };
  }

  if (result.status !== 0) {
    return { error: `the key command exited with status ${result.status}` };
  }

  const key = result.stdout.trim();

  return key ? { key } : { error: "the key command printed nothing" };
};

/**
 * A managementKey that starts with "!" is a shell command whose output is the key, as with keys in
 * pi's auth.json. Each command runs once per process, and a failure stays cached, as in pi.
 */
const resolveKeyValue = (value: string): KeyCommandResult => {
  if (!value.startsWith("!")) {
    return { key: value };
  }

  const cached = commandKeys.get(value) ?? runKeyCommand(value.slice(1));
  commandKeys.set(value, cached);

  return cached;
};

const decodeRefreshMeta = (refresh: string | undefined): ConnectionValues => {
  if (!refresh?.trim()) {
    return {};
  }

  try {
    const value: unknown = JSON.parse(refresh);

    return Value.Check(RefreshMetaSchema, value)
      ? { baseUrl: nonEmpty(value.baseUrl) }
      : {};
  } catch {
    return {};
  }
};

const credentialValues = (credential: Credential): ConnectionValues => {
  if (credential.type === "oauth" && credential.access.trim()) {
    return {
      apiKey: credential.access.trim(),
      ...decodeRefreshMeta(credential.refresh),
    };
  }

  if (credential.type === "api_key" && credential.key?.trim()) {
    return { apiKey: credential.key.trim() };
  }

  return {};
};

export const loginCredentials = (
  baseUrl: string,
  apiKey: string
): OAuthCredentials => ({
  access: apiKey,
  expires: loginExpiry(),
  refresh: JSON.stringify({ baseUrl }),
});

/**
 * Every file and environment value the extension reads, for one agent dir.
 * Each call reads again, so edits by other pi processes show at once; the
 * file memo keeps that cheap.
 */
export class Settings {
  readonly agentDir: string;
  readonly providerId: string;
  readonly providerName: string;
  private readonly env: Env;

  constructor(agentDir: string, env: Env = process.env) {
    this.agentDir = agentDir;
    this.env = env;
    const config = this.config();
    this.providerId =
      nonEmpty(env.CLIPROXYAPI_PROVIDER_ID) ??
      config.providerId ??
      DEFAULT_PROVIDER_ID;
    this.providerName =
      nonEmpty(env.CLIPROXYAPI_PROVIDER_NAME) ??
      config.providerName ??
      DEFAULT_PROVIDER_NAME;
  }

  private file(name: string): string {
    return path.join(this.agentDir, name);
  }

  /** A fresh object callers may change. A blank string reads as unset. */
  config(): CliproxyConfig {
    const value = readJsonMemo(this.file(CONFIG_FILE_NAME), ConfigFileSchema);

    // SAFETY: Only string fields change, each to a trimmed string or to absent, which the schema's optional strings allow.
    return Object.fromEntries(
      Object.entries(structuredClone(value ?? {})).flatMap(
        ([key, field]): [string, unknown][] => {
          if (!Value.Check(Type.String(), field)) {
            return [[key, field]];
          }

          const trimmed = field.trim();

          return trimmed ? [[key, trimmed]] : [];
        }
      )
    ) as CliproxyConfig;
  }

  save(update: Partial<CliproxyConfig>): void {
    writeJsonAtomic(this.file(CONFIG_FILE_NAME), {
      ...this.config(),
      ...update,
    });
  }

  stored(): ConnectionValues {
    const authPath = this.file("auth.json");

    try {
      const credential = memoByFile(
        authPath,
        () => readStoredCredential(this.providerId, authPath),
        this.providerId
      );

      return credential ? credentialValues(credential) : {};
    } catch {
      return {};
    }
  }

  connection(): ResolvedConnection | null {
    return resolveConnection(this.env, this.config(), this.stored());
  }

  /** Gaps in the credential come from the settings. */
  connectionFor(credential: Credential | undefined): ResolvedConnection | null {
    const values = credential ? credentialValues(credential) : {};

    if (!values.apiKey) {
      return this.connection();
    }

    return connectionTo(values.baseUrl ?? this.baseUrl(), values.apiKey);
  }

  /** pi's PI_OFFLINE: no network at startup. */
  offline(): boolean {
    return OFFLINE_FLAG.test(this.env.PI_OFFLINE ?? "");
  }

  home(): string | undefined {
    return this.env.HOME || this.env.USERPROFILE;
  }

  baseUrl(): string {
    return resolveBaseUrl(this.env, this.config(), this.stored());
  }

  sources(): ConnectionSources {
    return resolveConnectionSources(this.env, this.config(), this.stored());
  }

  managementKey():
    | { key: string; source: ManagementKeySource }
    | { error: string }
    | undefined {
    const fromEnv = nonEmpty(this.env[MANAGEMENT_KEY_ENV]);

    if (fromEnv) {
      return { key: fromEnv, source: "env" };
    }

    const configured = this.config().managementKey;

    if (!configured) {
      return undefined;
    }

    const result = resolveKeyValue(configured);

    return "key" in result ? { ...result, source: "cliproxyapi.json" } : result;
  }

  managementAccess(): ManagementAccess | undefined {
    const managed = this.managementKey();
    const connection = this.connection();

    if (!managed || !("key" in managed) || !connection) {
      return undefined;
    }

    return { baseUrl: connection.baseUrl, managementKey: managed.key };
  }

  requireManagementAccess(): ManagementAccess {
    const managed = this.managementKey();

    if (!managed || !("key" in managed)) {
      const reason =
        managed && "error" in managed
          ? `The management key from cliproxyapi.json is unavailable: ${managed.error}.`
          : "No CLIProxyAPI management key is configured.";

      throw new Error(
        `${reason} Set ${MANAGEMENT_KEY_ENV} in the environment or "managementKey" in cliproxyapi.json, then try again.`
      );
    }

    const connection = this.connection();

    if (!connection) {
      throw new Error(
        `CLIProxyAPI is not configured. Run /login ${this.providerId} first.`
      );
    }

    return { baseUrl: connection.baseUrl, managementKey: managed.key };
  }

  private piSettings() {
    try {
      return readJsonMemo(this.file("settings.json"), SettingsFileSchema);
    } catch {
      // pi owns settings.json, so a shape this extension doesn't expect reads as defaults.
      return null;
    }
  }

  /** Whether pi's automatic compaction is on. Defaults to true, as pi does. */
  autoCompact(): boolean {
    return this.piSettings()?.compaction?.enabled ?? true;
  }

  isDefaultModel(modelId: string): boolean {
    const settings = this.piSettings();
    const defaultModel = nonEmpty(settings?.defaultModel);
    const defaultProvider = nonEmpty(settings?.defaultProvider);

    return (
      defaultModel === `${this.providerId}/${modelId}` ||
      defaultModel === `${this.providerId}:${modelId}` ||
      (defaultModel === modelId &&
        (!defaultProvider || defaultProvider === this.providerId))
    );
  }

  modelsCache(baseUrl: string): ModelsCache | undefined {
    try {
      const value = readJsonFile(
        this.file(MODELS_CACHE_FILE_NAME),
        ModelsCacheFileSchema
      );

      return value?.baseUrl === baseUrl ? value : undefined;
    } catch {
      // A cache from an older version, or a damaged one, is fetched again.
      return undefined;
    }
  }

  saveModelsCache(cache: ModelsCache): void {
    writeJsonAtomic(this.file(MODELS_CACHE_FILE_NAME), cache);
  }
}
