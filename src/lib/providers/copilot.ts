import { Deps } from "../deps";
import { asNumber, asRecord, asString, asTimestamp, clampPercent, requestJson, titleCase } from "../http";
import { ProviderError, ProviderUsage, Settings, UsageWindow } from "../types";

const USAGE_URL = "https://api.github.com/copilot_internal/user";

// The plan names GitHub uses, mapped to the names shown in the list. Unknown plans are title-cased.
const PLAN_NAMES = new Map([
  ["individual", "Pro"],
  ["individual_pro", "Pro+"],
  ["business", "Business"],
  ["enterprise", "Enterprise"],
  ["free", "Free"],
  ["free_limited_copilot", "Free"],
]);

// quota_snapshots keys, in the order they are listed.
const SNAPSHOT_LABELS = [
  ["premium_interactions", "Premium Requests"],
  ["chat", "Chat"],
  ["completions", "Completions"],
] as const;

// The free plan reports its quotas as two flat maps instead of snapshots.
const FREE_LABELS = [
  ["chat", "Chat"],
  ["completions", "Completions"],
] as const;

export interface CopilotUsage {
  plan?: string;
  windows: UsageWindow[];
  notes: string[];
}

export async function fetchCopilotUsage(deps: Deps, settings: Settings): Promise<ProviderUsage> {
  // A token pasted in preferences wins over the one from signing in inside the extension.
  const preferenceToken = asString(settings.githubToken);
  const token = preferenceToken ?? asString(settings.githubOAuthToken);
  if (!token) {
    throw new ProviderError(
      "not-connected",
      "No GitHub token for Copilot",
      'Sign in with GitHub from this item\'s actions, or paste a GitHub token (for example the output of `gh auth token`) into the "GitHub Token for Copilot" preference',
    );
  }
  const source = preferenceToken ? "GitHub token" : "GitHub sign-in";

  let json: unknown;
  try {
    json = await requestJson(deps, USAGE_URL, {
      headers: {
        Authorization: `token ${token}`,
        "X-GitHub-Api-Version": "2025-04-01",
        "User-Agent": "AI-Limits-Raycast",
      },
      provider: "GitHub",
      authHint: preferenceToken ? "Check the GitHub token in preferences" : "Sign in with GitHub again",
    });
  } catch (error) {
    // 404 is how this endpoint says the account has no Copilot seat, which is a setup problem rather than an error.
    if (error instanceof ProviderError && error.status === 404) {
      throw new ProviderError(
        "not-connected",
        "No Copilot subscription on this GitHub account",
        "Use a GitHub account that has Copilot (see github.com/settings/copilot), or paste a token for that account",
      );
    }
    throw error;
  }

  const usage = parseCopilotUsage(json);
  return {
    provider: "copilot",
    plan: usage.plan,
    windows: usage.windows,
    balances: [],
    notes: usage.notes,
    source,
    fetchedAt: deps.now(),
  };
}

export function parseCopilotUsage(json: unknown): CopilotUsage {
  const root = asRecord(json);
  const resetsAt = asTimestamp(root?.quota_reset_date);
  const windows: UsageWindow[] = [];
  const unlimited: string[] = [];

  const snapshots = asRecord(root?.quota_snapshots);
  if (snapshots) {
    for (const [key, label] of SNAPSHOT_LABELS) {
      const snapshot = asRecord(snapshots[key]);
      if (!snapshot) {
        continue;
      }
      if (snapshot.unlimited === true) {
        unlimited.push(label);
        continue;
      }
      const window = snapshotWindow(label, snapshot, resetsAt);
      if (window) {
        windows.push(window);
      }
    }
  } else {
    windows.push(...freeWindows(root, resetsAt));
  }

  if (windows.length === 0 && unlimited.length === 0) {
    throw new ProviderError("parse", "Copilot's usage response had no usable quotas");
  }
  const notes = unlimited.length
    ? [`${joinNames(unlimited)} ${unlimited.length === 1 ? "is" : "are"} unlimited on this plan.`]
    : [];

  return { plan: planName(asString(root?.copilot_plan)), windows, notes };
}

function snapshotWindow(
  label: string,
  snapshot: Record<string, unknown>,
  resetsAt: number | null,
): UsageWindow | undefined {
  const entitlement = asNumber(snapshot.entitlement);
  const remaining = asNumber(snapshot.remaining);
  const percentRemaining = asNumber(snapshot.percent_remaining);

  let usedPercent: number | undefined;
  if (percentRemaining !== undefined) {
    usedPercent = 100 - percentRemaining;
  } else if (entitlement !== undefined && remaining !== undefined && entitlement > 0) {
    usedPercent = ((entitlement - remaining) / entitlement) * 100;
  }
  if (usedPercent === undefined) {
    return undefined;
  }
  return {
    label,
    usedPercent: clampPercent(usedPercent),
    resetsAt,
    detail: usageDetail(entitlement, remaining),
  };
}

// The free plan: `limited_user_quotas` holds what's left, `monthly_quotas` the monthly totals.
function freeWindows(root: Record<string, unknown> | undefined, resetsAt: number | null): UsageWindow[] {
  const remainingQuotas = asRecord(root?.limited_user_quotas);
  const totals = asRecord(root?.monthly_quotas);
  const windows: UsageWindow[] = [];
  for (const [key, label] of FREE_LABELS) {
    const total = asNumber(totals?.[key]);
    const remaining = asNumber(remainingQuotas?.[key]);
    if (total === undefined || total <= 0 || remaining === undefined) {
      continue;
    }
    windows.push({
      label,
      usedPercent: clampPercent(((total - remaining) / total) * 100),
      resetsAt,
      detail: usageDetail(total, remaining),
    });
  }
  return windows;
}

// "179.5 / 300 used", rounded to one decimal place.
function usageDetail(total: number | undefined, remaining: number | undefined): string | undefined {
  if (total === undefined || total <= 0 || remaining === undefined) {
    return undefined;
  }
  const used = Math.max(0, total - remaining);
  return `${formatCount(used)} / ${formatCount(total)} used`;
}

function formatCount(value: number): string {
  return String(Math.round(value * 10) / 10);
}

function planName(raw: string | undefined): string | undefined {
  if (!raw) {
    return undefined;
  }
  return PLAN_NAMES.get(raw) ?? titleCase(raw);
}

function joinNames(names: string[]): string {
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}
