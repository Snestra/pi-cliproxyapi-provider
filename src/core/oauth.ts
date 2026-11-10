/* oxlint-disable eslint/no-await-in-loop -- OAuth status polling is intentionally sequential so each check sees the latest server state. */
import { setTimeout as delay } from "node:timers/promises";

import { Type } from "typebox";

import { ManagementHttpError, managementRequest } from "./management.ts";
import type { ManagementRequestOptions } from "./management.ts";

/** Shared options for the CLIProxyAPI v8 management OAuth flow. */
export type OAuthRequestOptions = ManagementRequestOptions;

export interface Account {
  authIndex: string;
  name: string;
  provider: string;
  label: string;
  disabled: boolean;
}

export interface StartOAuthOptions extends OAuthRequestOptions {
  authIndex?: string;
  /**
   * CLIProxyAPI provider id: `claude`, `codex`, `antigravity`, `kimi`,
   * `kimi-ai`, `xai`, `devin`, `meta`, or a registered plugin provider id.
   * Any other non-empty id is passed through for the server to judge.
   */
  provider: string;
}

/** A started login: open `url`, then poll or cancel with `state`. */
export interface OAuthStart {
  state: string;
  url: string;
  /** `device` for device-code logins (Kimi, xAI, Meta): no callback URL comes back, so poll the status directly. */
  flow?: string;
  /** The code to enter at `url` during a device login, when the server sends one. */
  userCode?: string;
}

export interface SubmitOAuthCallbackOptions extends OAuthRequestOptions {
  provider?: string;
  /** The complete callback URL the browser landed on, with its code and state. */
  redirectUrl?: string;
  state?: string;
  code?: string;
  error?: string;
}

export interface PollOAuthStatusOptions extends OAuthRequestOptions {
  state: string;
  /** Delay between status checks while the login is pending. */
  pollIntervalMs?: number;
  /** Longest total wait before the pending login counts as failed. */
  maxWaitMs?: number;
}

export type OAuthStatusValue = "error" | "ok" | "wait";

export interface OAuthStatus {
  status: OAuthStatusValue;
  error?: string;
}

const DEFAULT_POLL_INTERVAL_MS = 2000;
const DEFAULT_MAX_WAIT_MS = 5 * 60_000;

const StartSchema = Type.Object({
  flow: Type.Optional(Type.String()),
  state: Type.String(),
  status: Type.Optional(Type.String()),
  url: Type.String(),
  user_code: Type.Optional(Type.String()),
});

const StatusSchema = Type.Object({
  error: Type.Optional(Type.String()),
  status: Type.Union([
    Type.Literal("error"),
    Type.Literal("ok"),
    Type.Literal("wait"),
  ]),
});

const RefreshSchema = Type.Object({
  changed_providers: Type.Optional(Type.Array(Type.String())),
  ok: Type.Boolean(),
});

const AccountsSchema = Type.Object({
  files: Type.Array(
    Type.Object({
      auth_index: Type.String(),
      disabled: Type.Optional(Type.Boolean()),
      email: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      label: Type.Optional(Type.Union([Type.String(), Type.Null()])),
      name: Type.String(),
      provider: Type.String(),
    })
  ),
});

const nonEmpty = (value: string | undefined, name: string): string => {
  const trimmed = value?.trim() ?? "";

  if (!trimmed) {
    throw new Error(`${name} is empty`);
  }

  return trimmed;
};

export const refreshServerCatalog = async (
  options: OAuthRequestOptions
): Promise<boolean> => {
  try {
    await managementRequest(options, "/models/refresh", RefreshSchema, {
      method: "POST",
    });

    return true;
  } catch (error) {
    if (error instanceof ManagementHttpError && error.status === 404) {
      return false;
    }

    throw error;
  }
};

export const listAccounts = async (
  options: OAuthRequestOptions
): Promise<Account[]> => {
  const result = await managementRequest(
    options,
    "/credentials",
    AccountsSchema
  );

  return result.files.map((file) => ({
    authIndex: file.auth_index,
    disabled: file.disabled ?? false,
    label: file.label || file.email || file.name,
    name: file.name,
    provider: file.provider,
  }));
};

interface OAuthCallbackBody {
  provider?: string;
  redirect_url?: string;
  state?: string;
  code?: string;
  error?: string;
}

/**
 * Starts an upstream account login. The server answers
 * `{ status, url, state }`: `url` is the authorization URL to open and
 * `state` identifies the pending session for the callback, status, and
 * cancellation calls.
 */
export const startOAuth = async (
  options: StartOAuthOptions
): Promise<OAuthStart> => {
  const provider = nonEmpty(options.provider, "provider");

  const result = await managementRequest(
    options,
    options.authIndex === undefined
      ? `/oauth/auth-url?provider=${encodeURIComponent(provider)}`
      : "/oauth/auth-url",
    StartSchema,
    options.authIndex === undefined
      ? {}
      : {
          body: JSON.stringify({ auth_index: options.authIndex, provider }),
          method: "POST",
        }
  );

  const start: OAuthStart = { state: result.state, url: result.url };

  if (result.flow) {
    start.flow = result.flow;
  }

  if (result.user_code) {
    start.userCode = result.user_code;
  }

  return start;
};

/**
 * Submits the callback for a started login, either as the complete
 * `redirect_url` the browser landed on or as a bare `state` plus `code`.
 * Acceptance only hands the values to the pending session; poll the status
 * to learn whether the credential exchange finished.
 */
export const submitOAuthCallback = async (
  options: SubmitOAuthCallbackOptions
): Promise<OAuthStatus> => {
  const body: OAuthCallbackBody = {};

  if (options.provider?.trim()) {
    body.provider = options.provider.trim();
  }

  if (options.redirectUrl?.trim()) {
    body.redirect_url = options.redirectUrl.trim();
  } else {
    const state = nonEmpty(options.state, "state");
    const code = options.code?.trim() ?? "";
    const error = options.error?.trim() ?? "";

    if (!code && !error) {
      throw new Error(
        "submitOAuthCallback requires a redirectUrl, or a state with a code or error"
      );
    }

    body.state = state;

    if (code) {
      body.code = code;
    }

    if (error) {
      body.error = error;
    }
  }

  return await managementRequest(options, "/oauth/callback", StatusSchema, {
    body: JSON.stringify(body),
    method: "POST",
  });
};

/**
 * Polls a started login until the server reports `ok` or `error`; `wait`
 * means the login is still pending. A wait past `maxWaitMs` comes back as
 * an `error` status, and aborting `signal` rejects instead.
 */
export const pollOAuthStatus = async (
  options: PollOAuthStatusOptions
): Promise<OAuthStatus> => {
  const state = nonEmpty(options.state, "state");
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = Date.now() + (options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS);

  while (true) {
    options.signal?.throwIfAborted();

    const result = await managementRequest(
      options,
      `/oauth/status?state=${encodeURIComponent(state)}`,
      StatusSchema
    );

    if (result.status !== "wait") {
      return result;
    }

    const remaining = deadline - Date.now();

    if (remaining <= 0) {
      return {
        error: "Timed out waiting for the CLIProxyAPI OAuth login to complete.",
        status: "error",
      };
    }

    await delay(Math.min(interval, remaining), undefined, {
      signal: options.signal,
    });
  }
};
