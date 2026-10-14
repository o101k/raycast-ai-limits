import { describe, expect, it } from "vitest";
import {
  detailMarkdown,
  formatBalance,
  formatMoney,
  formatPercent,
  formatReset,
  formatUpdated,
  headlineWindow,
  hintSteps,
  levelColor,
  listSummary,
  progressBar,
  ProviderState,
  summaryText,
} from "../src/lib/format";
import type { ProviderUsage, UsageWindow } from "../src/lib/types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-10-14T12:00:00Z");

function window(label: string, usedPercent: number, resetsAt: number | null = null): UsageWindow {
  return { label, usedPercent, resetsAt };
}

function usage(overrides: Partial<ProviderUsage> = {}): ProviderUsage {
  return {
    provider: "claude",
    plan: "Max 5x",
    windows: [window("Session", 62, NOW + 2 * HOUR + 13 * MINUTE), window("Weekly", 30, NOW + 3 * DAY + 4 * HOUR)],
    balances: [],
    notes: [],
    source: "claude.ai session",
    fetchedAt: NOW - 2 * MINUTE,
    ...overrides,
  };
}

describe("headlineWindow", () => {
  it("picks the window closest to its limit", () => {
    expect(headlineWindow(usage())?.label).toBe("Session");
  });

  it("keeps the earlier window when two are tied", () => {
    const tied = usage({ windows: [window("A", 50), window("B", 50)] });
    expect(headlineWindow(tied)?.label).toBe("A");
  });

  it("returns undefined without windows or usage", () => {
    expect(headlineWindow(usage({ windows: [] }))).toBeUndefined();
    expect(headlineWindow(undefined)).toBeUndefined();
  });
});

describe("formatPercent", () => {
  it("shows the percent used", () => {
    expect(formatPercent(window("Session", 62), "used")).toBe("62% used");
  });

  it("shows the percent left", () => {
    expect(formatPercent(window("Session", 62), "remaining")).toBe("38% left");
  });

  it("rounds to a whole percent", () => {
    expect(formatPercent(window("Session", 62.4), "used")).toBe("62% used");
    expect(formatPercent(window("Session", 62.6), "remaining")).toBe("37% left");
  });

  it("clamps values outside 0 to 100", () => {
    expect(formatPercent(window("Session", 120), "used")).toBe("100% used");
    expect(formatPercent(window("Session", 120), "remaining")).toBe("0% left");
    expect(formatPercent(window("Session", -5), "used")).toBe("0% used");
  });
});

describe("levelColor", () => {
  it("is ok below 70 percent used", () => {
    expect(levelColor(0)).toBe("ok");
    expect(levelColor(69.9)).toBe("ok");
  });

  it("is warning from 70 up to 90 percent used", () => {
    expect(levelColor(70)).toBe("warning");
    expect(levelColor(89.9)).toBe("warning");
  });

  it("is critical from 90 percent used", () => {
    expect(levelColor(90)).toBe("critical");
    expect(levelColor(100)).toBe("critical");
    expect(levelColor(140)).toBe("critical");
  });
});

describe("progressBar", () => {
  it("is 20 cells wide by default", () => {
    expect(progressBar(62)).toBe("█".repeat(12) + "░".repeat(8));
  });

  it("is empty at 0 and full at 100", () => {
    expect(progressBar(0)).toBe("░".repeat(20));
    expect(progressBar(100)).toBe("█".repeat(20));
  });

  it("takes a width", () => {
    expect(progressBar(50, 10)).toBe("█████░░░░░");
  });

  it("clamps out-of-range values", () => {
    expect(progressBar(-5)).toBe("░".repeat(20));
    expect(progressBar(150)).toBe("█".repeat(20));
  });
});

describe("formatReset", () => {
  it("is empty when the provider gives no reset time", () => {
    expect(formatReset(null, NOW)).toBe("");
  });

  it("says resets now when the time has passed", () => {
    expect(formatReset(NOW - MINUTE, NOW)).toBe("resets now");
    expect(formatReset(NOW, NOW)).toBe("resets now");
  });

  it("shows minutes under an hour", () => {
    expect(formatReset(NOW + 45 * MINUTE, NOW)).toBe("resets in 45m");
  });

  it("rounds a few seconds up to one minute", () => {
    expect(formatReset(NOW + 30_000, NOW)).toBe("resets in 1m");
  });

  it("shows hours and zero-padded minutes under a day", () => {
    expect(formatReset(NOW + 2 * HOUR + 13 * MINUTE, NOW)).toBe("resets in 2h 13m");
    expect(formatReset(NOW + 2 * HOUR + 5 * MINUTE, NOW)).toBe("resets in 2h 05m");
  });

  it("shows days and hours up to a week", () => {
    expect(formatReset(NOW + 3 * DAY + 4 * HOUR, NOW)).toBe("resets in 3d 4h");
    expect(formatReset(NOW + 6 * DAY + 23 * HOUR + 30 * MINUTE, NOW)).toBe("resets in 6d 23h");
  });

  it("shows the date from a week on, since a relative time stops being useful", () => {
    const resetsAt = NOW + 8 * DAY;
    const date = new Date(resetsAt).toLocaleDateString("en-US", { month: "short", day: "numeric" });
    expect(formatReset(resetsAt, NOW)).toBe(`resets ${date}`);
  });
});

describe("formatMoney", () => {
  it("formats dollars with two decimals", () => {
    expect(formatMoney(12.34, "USD")).toBe("$12.34");
    expect(formatMoney(40, "USD")).toBe("$40.00");
  });

  it("formats other currencies with their symbol", () => {
    expect(formatMoney(5, "EUR")).toBe("€5.00");
  });

  it("formats credits as a count, not money", () => {
    expect(formatMoney(125.5, "credits")).toBe("125.5 credits");
    expect(formatMoney(1234.5, "credits")).toBe("1,234.5 credits");
  });

  it("shows the raw code when Intl rejects the currency", () => {
    expect(formatMoney(12.34, "US")).toBe("12.34 US");
  });
});

describe("formatBalance", () => {
  it("shows the amount left when there is no limit", () => {
    expect(formatBalance({ label: "Balance", amount: 40, currency: "USD" })).toBe("$40.00");
  });

  it("says a capped amount is used out of the limit, not left", () => {
    expect(formatBalance({ label: "Extra Usage", amount: 12.34, currency: "USD", limit: 50 })).toBe(
      "$12.34 of $50.00 used",
    );
  });
});

describe("formatUpdated", () => {
  it("is just now under a minute, and for a time in the future", () => {
    expect(formatUpdated(NOW, NOW)).toBe("just now");
    expect(formatUpdated(NOW + MINUTE, NOW)).toBe("just now");
  });

  it("counts minutes, hours and days", () => {
    expect(formatUpdated(NOW - 2 * MINUTE, NOW)).toBe("2 min ago");
    expect(formatUpdated(NOW - 90 * MINUTE, NOW)).toBe("1 h ago");
    expect(formatUpdated(NOW - 3 * DAY, NOW)).toBe("3 d ago");
  });
});

describe("hintSteps", () => {
  it("keeps a single short sentence as one step", () => {
    expect(hintSteps("Run `codex login` in a terminal.")).toEqual(["Run `codex login` in a terminal."]);
  });

  it("splits a one-line hint with several sentences into steps", () => {
    expect(hintSteps("Run `codex login`. Then reopen this list.")).toEqual([
      "Run `codex login`.",
      "Then reopen this list.",
    ]);
  });

  it("keeps each line of a multi-line hint as a step", () => {
    expect(hintSteps("Open claude.ai\n\n  Copy the sessionKey cookie  \n")).toEqual([
      "Open claude.ai",
      "Copy the sessionKey cookie",
    ]);
  });
});

describe("listSummary", () => {
  const ok = (overrides: Partial<ProviderState> = {}): ProviderState => ({
    loading: false,
    usage: usage(),
    ...overrides,
  });

  it("shows Loading while there is nothing to show yet", () => {
    expect(listSummary({ loading: true }, "used", NOW)).toEqual({ text: "Loading…" });
  });

  it("shows the headline percent as a tag, colored by level, and the reset time", () => {
    expect(listSummary(ok(), "used", NOW)).toEqual({
      tag: { text: "62% used", tone: "ok" },
      text: "resets in 2h 13m",
    });
  });

  it("uses the percent left in remaining mode, still colored by usage", () => {
    const summary = listSummary(ok({ usage: usage({ windows: [window("Session", 95, null)] }) }), "remaining", NOW);
    expect(summary).toEqual({ tag: { text: "5% left", tone: "critical" } });
  });

  it("shows the first balance when there are no windows", () => {
    const balances = [{ label: "Balance", amount: 12.34, currency: "USD" }];
    expect(listSummary(ok({ usage: usage({ windows: [], balances }) }), "used", NOW)).toEqual({ text: "$12.34" });
  });

  it("shows the Not connected tag for a provider with no credentials", () => {
    const state: ProviderState = {
      loading: false,
      failure: { kind: "not-connected", message: "No Codex login found", hint: "Run codex login" },
    };
    expect(listSummary(state, "used", NOW)).toEqual({
      tag: { text: "Not connected", tone: "neutral" },
      tooltip: "No Codex login found",
    });
  });

  it("shows Sign in needed for rejected credentials, and keeps the saved numbers", () => {
    const state = ok({ failure: { kind: "auth", message: "Claude rejected the credentials (HTTP 401)" } });
    expect(listSummary(state, "used", NOW)).toEqual({
      tag: { text: "Sign in needed", tone: "error" },
      text: "resets in 2h 13m",
      tooltip: "Claude rejected the credentials (HTTP 401)",
    });
  });

  it("shows Error for a failed request with no saved numbers", () => {
    const state: ProviderState = { loading: false, failure: { kind: "http", message: "Couldn't reach Claude" } };
    expect(listSummary(state, "used", NOW)).toEqual({
      tag: { text: "Error", tone: "error" },
      tooltip: "Couldn't reach Claude",
    });
  });
});

describe("detailMarkdown", () => {
  it("has a heading and a progress bar for each window", () => {
    const markdown = detailMarkdown("Claude", { loading: false, usage: usage() }, "used", NOW);
    expect(markdown).toContain("# Claude");
    expect(markdown).toContain("**Session** · resets in 2h 13m");
    expect(markdown).toContain("`" + progressBar(62) + "` 62% used");
    expect(markdown).toContain("**Weekly** · resets in 3d 4h");
  });

  it("lists balances and notes after the windows", () => {
    const state = {
      loading: false,
      usage: usage({
        windows: [],
        balances: [{ label: "Extra Usage", amount: 12.34, currency: "USD", limit: 50 }],
        notes: ["Token expired, using claude.ai session"],
      }),
    };
    const markdown = detailMarkdown("Claude", state, "used", NOW);
    expect(markdown).toContain("**Extra Usage** $12.34 of $50.00 used");
    expect(markdown).toContain("- Token expired, using claude.ai session");
    expect(markdown.indexOf("**Extra Usage**")).toBeLessThan(markdown.indexOf("- Token expired"));
  });

  it("says there are no limits when a provider reports none", () => {
    const markdown = detailMarkdown("Kimi Code", { loading: false, usage: usage({ windows: [] }) }, "used", NOW);
    expect(markdown).toContain("No limits reported for this account.");
  });

  it("shows the message and the hint as numbered steps for a failure", () => {
    const state: ProviderState = {
      loading: false,
      failure: {
        kind: "not-connected",
        message: "No Claude credentials found",
        hint: "Open claude.ai in Chrome.\nCopy the sessionKey cookie.\nPaste it into preferences.",
      },
    };
    const markdown = detailMarkdown("Claude", state, "used", NOW);
    expect(markdown).toContain("**Not connected**");
    expect(markdown).toContain("No Claude credentials found");
    expect(markdown).toContain(
      "1. Open claude.ai in Chrome.\n2. Copy the sessionKey cookie.\n3. Paste it into preferences.",
    );
  });

  it("says the data is saved when a refresh failed after a cached result", () => {
    const state = {
      loading: false,
      usage: usage(),
      failure: { kind: "http" as const, message: "Couldn't reach Claude" },
    };
    expect(detailMarkdown("Claude", state, "used", NOW)).toContain("_Showing saved data. The last refresh failed._");
  });

  it("says Loading when there is nothing yet", () => {
    expect(detailMarkdown("Claude", { loading: true }, "used", NOW)).toContain("Loading…");
  });
});

describe("summaryText", () => {
  it("copies the name, plan, each window, balances and the update time", () => {
    const state = {
      loading: false,
      usage: usage({ balances: [{ label: "Extra Usage", amount: 12.34, currency: "USD", limit: 50 }] }),
    };
    expect(summaryText("Claude", state, "used", NOW)).toBe(
      [
        "Claude (Max 5x)",
        "Session: 62% used, resets in 2h 13m",
        "Weekly: 30% used, resets in 3d 4h",
        "Extra Usage: $12.34 of $50.00 used",
        "Updated 2 min ago",
      ].join("\n"),
    );
  });

  it("copies the error for a provider that failed", () => {
    const state: ProviderState = { loading: false, failure: { kind: "auth", message: "Token expired" } };
    expect(summaryText("Codex", state, "used", NOW)).toBe("Codex\nSign in needed: Token expired");
  });
});
