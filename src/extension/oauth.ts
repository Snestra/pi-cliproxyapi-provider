import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  listAccounts,
  pollOAuthStatus,
  startOAuth,
  submitOAuthCallback,
} from "../core/oauth.ts";
import type { Account } from "../core/oauth.ts";
import { LOGIN_PROVIDERS } from "../core/upstreams.ts";
import { completeFrom } from "./completions.ts";
import type { ManagementAccess, Settings } from "./config.ts";
import { errorText } from "./error-text.ts";

export interface RegisterOAuthLoginOptions {
  settings: Settings;
  /** Refreshes the model catalog the way /cliproxyapi-refresh does. */
  refresh: (ctx: ExtensionContext) => Promise<void>;
}

const KNOWN_PROVIDERS = `${LOGIN_PROVIDERS.join(", ")}, or a plugin provider id`;

const LOGIN_ARGUMENTS = /^(?<provider>\S+)(?:\s+(?<account>[\s\S]*))?$/u;

/** An undefined provider means the picker was cancelled. */
const chooseProvider = async (
  args: string,
  ctx: ExtensionContext
): Promise<{ provider: string | undefined; account: string }> => {
  const { provider = "", account = "" } =
    LOGIN_ARGUMENTS.exec(args.trim())?.groups ?? {};

  if (provider || !ctx.hasUI) {
    return { account: account.trim(), provider };
  }

  return {
    account: "",
    provider: await ctx.ui.select("CLIProxyAPI account provider", [
      ...LOGIN_PROVIDERS,
    ]),
  };
};

const chooseAccount = async (
  accounts: Account[],
  provider: string,
  argument: string,
  ctx: ExtensionContext
): Promise<Account | null | undefined> => {
  if (argument) {
    const search = argument.toLowerCase();

    const matches = accounts.filter((account) =>
      [account.label, account.name, account.authIndex].some(
        (value) => value.toLowerCase() === search
      )
    );

    if (matches.length === 0) {
      ctx.ui.notify(
        accounts.length > 0
          ? `No ${provider} account matches "${argument}". Available accounts: ${accounts.map((account) => account.label).join(", ")}.`
          : `No ${provider} accounts are available.`,
        "error"
      );

      return;
    }

    if (matches.length > 1) {
      ctx.ui.notify(
        `More than one ${provider} account matches "${argument}". Use the file name: ${matches.map((account) => account.name).join(", ")}.`,
        "error"
      );

      return;
    }

    return matches[0];
  }

  if (!ctx.hasUI || accounts.length === 0) {
    return null;
  }

  const choices = accounts.map((account) => {
    const duplicateLabel = accounts.some(
      (other) => other !== account && other.label === account.label
    );

    return `Sign in again: ${account.label}${duplicateLabel ? ` (${account.name})` : ""}${account.disabled ? " (disabled)" : ""}`;
  });

  const addNew = `Add a new ${provider} account`;

  const selected = await ctx.ui.select("CLIProxyAPI account", [
    addNew,
    ...choices,
  ]);

  if (selected === undefined) {
    return;
  }

  return selected === addNew ? null : accounts[choices.indexOf(selected)];
};

const refreshAfterLogin = async (
  options: RegisterOAuthLoginOptions,
  ctx: ExtensionContext,
  provider: string,
  account: Account | null
): Promise<void> => {
  const signedIn = account
    ? `Signed in to the ${provider} account ${account.label} again`
    : `Added the ${provider} account to CLIProxyAPI`;

  try {
    await options.refresh(ctx);
  } catch (error) {
    ctx.ui.notify(
      `${signedIn}, but refreshing models failed: ${errorText(error)}`,
      "warning"
    );

    return;
  }

  ctx.ui.notify(`${signedIn} and refreshed the model catalog.`, "info");
};

export const registerOAuthLogin = (
  pi: ExtensionAPI,
  options: RegisterOAuthLoginOptions
): void => {
  pi.registerCommand("cliproxyapi-login", {
    description: `Add an upstream account or sign in again (/cliproxyapi-login <provider> [account]: ${KNOWN_PROVIDERS}).`,
    getArgumentCompletions: (prefix) => completeFrom(LOGIN_PROVIDERS, prefix),
    handler: async (args, ctx) => {
      let access: ManagementAccess;

      // Check the setup first, so the picker never opens for a login that cannot run.
      try {
        access = options.settings.requireManagementAccess();
      } catch (error) {
        ctx.ui.notify(errorText(error), "error");

        return;
      }

      const { provider, account: accountArgument } = await chooseProvider(
        args,
        ctx
      );

      if (provider === undefined) {
        return;
      }

      if (!provider) {
        ctx.ui.notify(
          `Usage: /cliproxyapi-login <provider> [account] (${KNOWN_PROVIDERS})`,
          "error"
        );

        return;
      }

      const { baseUrl, managementKey } = access;
      const { signal } = ctx;

      try {
        const allAccounts = await listAccounts({
          baseUrl,
          managementKey,
          signal,
        });

        const accounts = allAccounts.filter(
          (account) => account.provider.toLowerCase() === provider.toLowerCase()
        );

        const account = await chooseAccount(
          accounts,
          provider,
          accountArgument,
          ctx
        );

        if (account === undefined) {
          return;
        }

        const start = await startOAuth({
          authIndex: account?.authIndex,
          baseUrl,
          managementKey,
          provider,
          signal,
        });

        ctx.ui.notify(
          `Open this URL in a browser to sign in to ${provider}:\n${start.url}`,
          "info"
        );

        if (start.flow === "device") {
          // Device logins (Kimi, xAI, Meta) never redirect back: the server
          // polls the provider itself, so only the status needs polling.
          if (start.userCode) {
            ctx.ui.notify(`Enter this code: ${start.userCode}`, "info");
          }
        } else {
          const redirectUrl = await ctx.ui.input(
            `Paste the full redirect URL for ${provider}`,
            "http://127.0.0.1/callback?code=...&state=...",
            signal ? { signal } : undefined
          );

          if (!redirectUrl?.trim()) {
            ctx.ui.notify(
              `CLIProxyAPI login for ${provider} was cancelled.`,
              "warning"
            );

            return;
          }

          await submitOAuthCallback({
            baseUrl,
            managementKey,
            provider,
            redirectUrl: redirectUrl.trim(),
            signal,
          });
        }

        ctx.ui.notify(
          `Completing the ${provider} login with CLIProxyAPI...`,
          "info"
        );

        const result = await pollOAuthStatus({
          baseUrl,
          managementKey,
          signal,
          state: start.state,
        });

        if (result.status !== "ok") {
          ctx.ui.notify(
            `CLIProxyAPI login for ${provider} failed: ${result.error ?? "the server reported an error"}`,
            "error"
          );

          return;
        }

        await refreshAfterLogin(options, ctx, provider, account);
      } catch (error) {
        if (signal?.aborted) {
          ctx.ui.notify(
            `CLIProxyAPI login for ${provider} was cancelled.`,
            "warning"
          );

          return;
        }

        ctx.ui.notify(
          `CLIProxyAPI login for ${provider} failed: ${errorText(error)}`,
          "error"
        );
      }
    },
  });
};
