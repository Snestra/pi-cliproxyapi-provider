import { Type } from "typebox";
import type { Static, TSchema } from "typebox";
import { Value } from "typebox/value";

import { resolveEndpoints } from "./connection.ts";

/** Connection to the CLIProxyAPI v8 management API. */
export interface ManagementRequestOptions {
  baseUrl: string;
  /** The CLIProxyAPI management key, not the client API key. */
  managementKey: string;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

const ErrorSchema = Type.Object({
  error: Type.Optional(Type.String()),
});

export const parseJson = <Schema extends TSchema>(
  schema: Schema,
  text: string
): Static<Schema> | undefined => {
  try {
    const value: unknown = JSON.parse(text);

    return Value.Check(schema, value) ? value : undefined;
  } catch {
    return undefined;
  }
};

export class ManagementHttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ManagementHttpError";
    this.status = status;
  }
}

export const managementRequest = async <Schema extends TSchema>(
  options: ManagementRequestOptions,
  route: string,
  schema: Schema,
  init: RequestInit = {}
): Promise<Static<Schema>> => {
  const managementKey = options.managementKey.trim();

  if (!managementKey) {
    throw new Error("managementKey is empty");
  }

  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  const response = await (options.fetch ?? globalThis.fetch)(
    `${resolveEndpoints(options.baseUrl).rootUrl}/v8/management${route}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${managementKey}`,
        "Content-Type": "application/json",
      },
      signal: options.signal
        ? AbortSignal.any([options.signal, timeout])
        : timeout,
    }
  );

  const [routePath] = route.split("?");
  const text = await response.text();

  if (!response.ok) {
    const detail = parseJson(ErrorSchema, text)?.error;

    throw new ManagementHttpError(
      response.status,
      `CLIProxyAPI management ${routePath} returned HTTP ${response.status}${detail ? `: ${detail}` : ""}`
    );
  }

  const value = parseJson(schema, text);

  if (value === undefined) {
    throw new Error(
      `CLIProxyAPI management ${routePath} returned an unexpected shape`
    );
  }

  return value;
};
