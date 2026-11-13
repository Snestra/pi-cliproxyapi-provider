/**
 * Where an upstream's usage windows come from: quota signals CLIProxyAPI
 * recorded from response headers, or a live call to the upstream's own
 * usage endpoint. Without one, a quota plugin named on the credential is
 * used, else the account shows no windows.
 */
export type UsageSource =
  | "claude-signals"
  | "codex-signals"
  | "devin-signals"
  | "xai-billing"
  | "kimi-com-usages"
  | "kimi-ai-usages";

interface Upstream {
  /** CLIProxyAPI's provider id. */
  id: string;
  /** The short name the usage footer shows. */
  footerName: string;
  /**
   * Whether one quota error covers every model of the account, as
   * CLIProxyAPI treats it. Claude also has per-model weekly limits, and its
   * account-wide windows come from the usage fetch instead.
   */
  accountWideQuota: boolean;
  usage?: UsageSource;
}

/** CLIProxyAPI's built-in upstream providers. Plugins can add more ids. */
const UPSTREAMS: readonly Upstream[] = [
  {
    accountWideQuota: false,
    footerName: "claude",
    id: "claude",
    usage: "claude-signals",
  },
  {
    accountWideQuota: true,
    footerName: "codex",
    id: "codex",
    usage: "codex-signals",
  },
  {
    accountWideQuota: true,
    footerName: "antigravity",
    id: "antigravity",
  },
  {
    accountWideQuota: true,
    footerName: "kimi",
    id: "kimi",
    usage: "kimi-com-usages",
  },
  {
    accountWideQuota: true,
    footerName: "kimi",
    id: "kimi-ai",
    usage: "kimi-ai-usages",
  },
  {
    accountWideQuota: true,
    footerName: "grok",
    id: "xai",
    usage: "xai-billing",
  },
  {
    accountWideQuota: true,
    footerName: "devin",
    id: "devin",
    usage: "devin-signals",
  },
  // Meta's quota endpoint reports no usage and returns an API key, so it has no usage source.
  { accountWideQuota: true, footerName: "muse", id: "meta" },
  { accountWideQuota: true, footerName: "gemini", id: "gemini" },
];

const upstream = (provider: string): Upstream | undefined =>
  UPSTREAMS.find((entry) => entry.id === provider);

export const footerName = (provider: string): string =>
  upstream(provider)?.footerName ?? provider;

export const hasAccountWideQuota = (provider: string): boolean =>
  upstream(provider)?.accountWideQuota ?? true;

export const usageSource = (provider: string): UsageSource | undefined =>
  upstream(provider)?.usage;
