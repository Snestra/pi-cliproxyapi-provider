export interface Endpoints {
  rootUrl: string;
  anthropicBaseUrl: string;
  openaiBaseUrl: string;
  modelsUrl: string;
  responsesUrl: string;
}

export interface ConnectionValues {
  baseUrl?: string;
  apiKey?: string;
}

export interface ResolvedConnection extends Endpoints {
  baseUrl: string;
  apiKey: string;
}

/** Where a connection value came from: the environment, cliproxyapi.json, pi's /login, or the built-in default. */
export type ValueSource = "env" | "cliproxyapi.json" | "login" | "default";

export interface ConnectionSources {
  baseUrl: ValueSource;
  /** Undefined when no API key is configured. */
  apiKey?: ValueSource;
}

const HTTP_SCHEME = /^https?:\/\//iu;
const OTHER_SCHEME = /^[a-z][a-z\d+.-]*:\/\//iu;
const TRAILING_SLASHES = /\/+$/u;
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "[::1]", "localhost"]);

const bareHost = (input: string): string =>
  new URL(`http://${input}`).hostname.toLowerCase();

const ENDPOINT_SUFFIX =
  /\/(?:v1(?:\/(?:models|messages|responses|chat\/completions))?|backend-api(?:\/codex\/responses)?)$/u;

const DEFAULT_BASE_URL = "http://127.0.0.1:8317";

export const resolveEndpoints = (baseUrl: string): Endpoints => {
  const input = baseUrl.trim();

  if (!input) {
    throw new Error("baseUrl is empty");
  }

  if (OTHER_SCHEME.test(input) && !HTTP_SCHEME.test(input)) {
    throw new Error("baseUrl must use HTTP or HTTPS");
  }

  const withScheme = HTTP_SCHEME.test(input)
    ? input
    : `${LOOPBACK_HOSTS.has(bareHost(input)) ? "http" : "https"}://${input}`;

  const url = new URL(withScheme);

  if (url.username || url.password) {
    throw new Error("baseUrl must not contain credentials");
  }

  // The API key and the management key would cross the network unencrypted.
  if (url.protocol === "http:" && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      "baseUrl must use HTTPS unless it points at this machine (localhost, 127.0.0.1, or ::1)"
    );
  }

  const path = url.pathname
    .replace(TRAILING_SLASHES, "")
    .replace(ENDPOINT_SUFFIX, "");

  const rootUrl = `${url.origin}${path}`;

  return {
    anthropicBaseUrl: rootUrl,
    modelsUrl: `${rootUrl}/v1/models?client_version=cpa`,
    openaiBaseUrl: `${rootUrl}/v1`,
    responsesUrl: `${rootUrl}/v1/responses`,
    rootUrl,
  };
};

interface Sourced {
  source: ValueSource;
  value: string;
}

type Env = Readonly<Record<string, string | undefined>>;

interface ResolvedValues {
  baseUrl: Sourced;
  apiKey?: Sourced;
}

const pick = (
  key: keyof ConnectionValues,
  envName: string,
  env: Env,
  file: ConnectionValues,
  stored: ConnectionValues
): Sourced | undefined => {
  const candidates: [ValueSource, string | undefined][] = [
    ["env", env[envName]],
    ["cliproxyapi.json", file[key]],
    ["login", stored[key]],
  ];

  for (const [source, raw] of candidates) {
    const value = raw?.trim();

    if (value) {
      return { source, value };
    }
  }

  return undefined;
};

const resolveValues = (
  env: Env,
  file: ConnectionValues,
  stored: ConnectionValues
): ResolvedValues => {
  const baseUrl = pick("baseUrl", "CLIPROXYAPI_BASE_URL", env, file, stored);
  const apiKey = pick("apiKey", "CLIPROXYAPI_API_KEY", env, file, stored);

  return {
    baseUrl: baseUrl ?? { source: "default", value: DEFAULT_BASE_URL },
    ...(apiKey && { apiKey }),
  };
};

export const resolveConnectionSources = (
  env: Env,
  file: ConnectionValues = {},
  stored: ConnectionValues = {}
): ConnectionSources => {
  const { apiKey, baseUrl } = resolveValues(env, file, stored);

  return apiKey
    ? { apiKey: apiKey.source, baseUrl: baseUrl.source }
    : { baseUrl: baseUrl.source };
};

export const resolveBaseUrl = (
  env: Env,
  file: ConnectionValues = {},
  stored: ConnectionValues = {}
): string => resolveValues(env, file, stored).baseUrl.value;

export const connectionTo = (
  baseUrl: string,
  apiKey: string
): ResolvedConnection => ({ apiKey, baseUrl, ...resolveEndpoints(baseUrl) });

export const resolveConnection = (
  env: Env,
  file: ConnectionValues = {},
  stored: ConnectionValues = {}
): ResolvedConnection | null => {
  const { apiKey, baseUrl } = resolveValues(env, file, stored);

  return apiKey ? connectionTo(baseUrl.value, apiKey.value) : null;
};
