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
  /** Offered by /cliproxyapi-login. */
  login: boolean;
  /**
   * Whether one quota error covers every model of the account, as
   * CLIProxyAPI treats it. Claude also has per-model weekly limits, and its
   * account-wide windows come from the usage fetch instead.
   */
  accountWideQuota: boolean;
  usage?: UsageSource;
}

/** CLIProxyAPI's built-in upstream providers, in the order the login picker lists them. Plugins can add more ids. */
const UPSTREAMS: readonly Upstream[] = [
  {
    accountWideQuota: false,
    footerName: "claude",
    id: "claude",
    login: true,
    usage: "claude-signals",
  },
  {
    accountWideQuota: true,
    footerName: "codex",
    id: "codex",
    login: true,
    usage: "codex-signals",
  },
  {
    accountWideQuota: true,
    footerName: "antigravity",
    id: "antigravity",
    login: true,
  },
  {
    accountWideQuota: true,
    footerName: "kimi",
    id: "kimi",
    login: true,
    usage: "kimi-com-usages",
  },
  {
    accountWideQuota: true,
    footerName: "kimi",
    id: "kimi-ai",
    login: true,
    usage: "kimi-ai-usages",
  },
  {
    accountWideQuota: true,
    footerName: "grok",
    id: "xai",
    login: true,
    usage: "xai-billing",
  },
  {
    accountWideQuota: true,
    footerName: "devin",
    id: "devin",
    login: true,
    usage: "devin-signals",
  },
  // Meta's quota endpoint reports no usage and returns an API key, so it has no usage source.
  { accountWideQuota: true, footerName: "muse", id: "meta", login: true },
  { accountWideQuota: true, footerName: "gemini", id: "gemini", login: false },
];

const upstream = (provider: string): Upstream | undefined =>
  UPSTREAMS.find((entry) => entry.id === provider);

export const LOGIN_PROVIDERS: readonly string[] = UPSTREAMS.flatMap((entry) =>
  entry.login ? [entry.id] : []
);

export const footerName = (provider: string): string =>
  upstream(provider)?.footerName ?? provider;

export const hasAccountWideQuota = (provider: string): boolean =>
  upstream(provider)?.accountWideQuota ?? true;

export const usageSource = (provider: string): UsageSource | undefined =>
  upstream(provider)?.usage;
