import { describe, expect, it } from "vitest";
import type { ProviderState } from "../src/lib/format";
import {
  applyFailure,
  applySuccess,
  Cached,
  FRESH_MS,
  initialStates,
  isNotConnected,
  providersToRefresh,
  sections,
  startRefresh,
  States,
  toFailure,
} from "../src/lib/usage-state";
import { ProviderError, ProviderUsage } from "../src/lib/types";

const IDS = ["claude", "codex", "copilot"] as const;
const NOW = Date.parse("2026-10-14T12:00:00Z");

function usage(id: "claude" | "codex" | "copilot", fetchedAt = NOW): ProviderUsage {
  return {
    provider: id,
    windows: [{ label: "Session", usedPercent: 40, resetsAt: null }],
    balances: [],
    notes: [],
    source: "test",
    fetchedAt,
  };
}

const notConnected = { kind: "not-connected" as const, message: "No credentials", hint: "Sign in" };

describe("initialStates", () => {
  it("starts providers with no saved result loading", () => {
    const states = initialStates(IDS, {});
    expect(Object.values(states).every((state) => state.loading)).toBe(true);
  });

  it("shows saved data at once, and not as loading", () => {
    const cached: Cached = { claude: usage("claude") };
    const states = initialStates(IDS, cached);
    expect(states.claude).toEqual({ loading: false, usage: cached.claude });
    expect(states.codex).toEqual({ loading: true, usage: undefined });
  });
});

describe("providersToRefresh", () => {
  const ALL = [...IDS];

  function statesWith(cached: Cached): States {
    return initialStates(IDS, cached);
  }

  it("skips a provider whose saved result is fresh", () => {
    const states = statesWith({ claude: usage("claude", NOW - 60_000) });
    expect(providersToRefresh(states, ALL, NOW, { force: false })).toEqual(["codex", "copilot"]);
  });

  it("refetches a provider whose saved result is stale", () => {
    const states = statesWith({ claude: usage("claude", NOW - 5 * 60_000) });
    expect(providersToRefresh(states, ALL, NOW, { force: false })).toEqual(ALL);
  });

  it("fetches a provider with no saved result, since that finds not-connected for free", () => {
    const states = statesWith({ claude: usage("claude", NOW) });
    expect(providersToRefresh(states, ALL, NOW, { force: false })).toEqual(["codex", "copilot"]);
  });

  it("treats a result exactly FRESH_MS old as stale", () => {
    const states = statesWith({ claude: usage("claude", NOW - FRESH_MS) });
    expect(providersToRefresh(states, ALL, NOW, { force: false })).toContain("claude");
  });

  it("treats a result just under FRESH_MS old as fresh", () => {
    const states = statesWith({ claude: usage("claude", NOW - FRESH_MS + 1) });
    expect(providersToRefresh(states, ALL, NOW, { force: false })).not.toContain("claude");
  });

  it("fetches every provider when forced, even fresh ones", () => {
    const states = statesWith({ claude: usage("claude", NOW), codex: usage("codex", NOW) });
    expect(providersToRefresh(states, ALL, NOW, { force: true })).toEqual(ALL);
  });

  it("keeps the order of the ids it is given", () => {
    const states = statesWith({});
    expect(providersToRefresh(states, ["copilot", "claude"], NOW, { force: false })).toEqual(["copilot", "claude"]);
  });
});

describe("startRefresh", () => {
  it("marks only the given providers loading, and keeps their saved data", () => {
    const cached: Cached = { claude: usage("claude"), codex: usage("codex") };
    const states = initialStates(IDS, cached);
    const refreshing = startRefresh(states, ["claude"]);
    expect(refreshing.claude).toEqual({ loading: true, usage: cached.claude });
    expect(refreshing.codex).toEqual({ loading: false, usage: cached.codex });
    expect(refreshing.copilot.loading).toBe(true);
  });

  it("marks nothing loading for an empty list", () => {
    const states = initialStates(IDS, { claude: usage("claude"), codex: usage("codex"), copilot: usage("copilot") });
    expect(Object.values(startRefresh(states, [])).some((state) => state.loading)).toBe(false);
  });
});

describe("applySuccess", () => {
  it("replaces the data in the state and the cache", () => {
    const old = usage("claude", NOW - 60_000);
    const fresh = usage("claude", NOW);
    const states = initialStates(IDS, { claude: old });
    const cached: Cached = { claude: old };
    const result = applySuccess(states, cached, "claude", fresh);
    expect(result.states.claude).toEqual({ loading: false, usage: fresh });
    expect(result.cached.claude).toBe(fresh);
  });

  it("does not touch other providers", () => {
    const states = initialStates(IDS, {});
    const result = applySuccess(states, {}, "claude", usage("claude"));
    expect(result.states.codex.loading).toBe(true);
    expect(result.cached.codex).toBeUndefined();
  });

  it("clears an earlier failure", () => {
    const states = applyFailure(initialStates(IDS, {}), {}, "claude", { kind: "http", message: "down" }).states;
    const result = applySuccess(states, {}, "claude", usage("claude"));
    expect(result.states.claude.failure).toBeUndefined();
  });
});

describe("applyFailure", () => {
  it("keeps saved data and shows an http failure next to it", () => {
    const saved = usage("claude");
    const states = initialStates(IDS, { claude: saved });
    const cached: Cached = { claude: saved };
    const failure = { kind: "http" as const, message: "Couldn't reach Claude" };
    const result = applyFailure(states, cached, "claude", failure);
    expect(result.states.claude).toEqual({ loading: false, usage: saved, failure });
    expect(result.cached.claude).toBe(saved);
  });

  it("keeps saved data for an auth failure", () => {
    const saved = usage("codex");
    const failure = { kind: "auth" as const, message: "rejected", hint: "Run codex login" };
    const result = applyFailure(initialStates(IDS, { codex: saved }), { codex: saved }, "codex", failure);
    expect(result.states.codex.usage).toBe(saved);
    expect(result.states.codex.failure).toEqual(failure);
    expect(result.cached.codex).toBe(saved);
  });

  it("drops saved data and the cache entry for a not-connected failure", () => {
    const saved = usage("copilot");
    const states = initialStates(IDS, { copilot: saved, claude: usage("claude") });
    const cached: Cached = { copilot: saved, claude: usage("claude") };
    const result = applyFailure(states, cached, "copilot", notConnected);
    expect(result.states.copilot).toEqual({ loading: false, failure: notConnected });
    expect(result.states.copilot.usage).toBeUndefined();
    expect(result.cached).not.toHaveProperty("copilot");
    expect(result.cached.claude).toBeDefined();
  });

  it("moves a dropped provider to Not Connected", () => {
    const saved = usage("copilot");
    const result = applyFailure(initialStates(IDS, { copilot: saved }), { copilot: saved }, "copilot", notConnected);
    expect(isNotConnected(result.states.copilot)).toBe(true);
    expect(sections(result.states, IDS, true).notConnected).toEqual(["copilot"]);
  });
});

describe("isNotConnected", () => {
  it("is false when there is saved data, even with a not-connected failure", () => {
    const state: ProviderState = { loading: false, usage: usage("claude"), failure: notConnected };
    expect(isNotConnected(state)).toBe(false);
  });
});

describe("sections", () => {
  const states: States = {
    claude: { loading: false, usage: usage("claude") },
    codex: { loading: false, failure: notConnected },
    copilot: { loading: false, failure: { kind: "auth", message: "rejected" } },
  } as States;

  it("puts providers with data or a non-not-connected error under Usage, in registry order", () => {
    expect(sections(states, IDS, true).usage).toEqual(["claude", "copilot"]);
  });

  it("puts not-connected providers under Not Connected", () => {
    expect(sections(states, IDS, true).notConnected).toEqual(["codex"]);
  });

  it("hides Not Connected entirely when showNotConnected is false", () => {
    expect(sections(states, IDS, false)).toEqual({ usage: ["claude", "copilot"], notConnected: [] });
  });

  it("keeps loading providers with no data under Usage", () => {
    const loading = initialStates(IDS, {});
    expect(sections(loading, IDS, true)).toEqual({ usage: [...IDS], notConnected: [] });
  });
});

describe("toFailure", () => {
  it("keeps the kind, message and hint of a ProviderError", () => {
    expect(toFailure(new ProviderError("auth", "rejected", "Sign in again"))).toEqual({
      kind: "auth",
      message: "rejected",
      hint: "Sign in again",
    });
  });

  it("carries the error code, so the view can act on a denied Keychain read", () => {
    const error = new ProviderError(
      "auth",
      "macOS denied access",
      "Choose Connect again",
      undefined,
      "keychain-denied",
    );

    expect(toFailure(error)).toEqual({
      kind: "auth",
      message: "macOS denied access",
      hint: "Choose Connect again",
      code: "keychain-denied",
    });
  });

  it("turns other errors into an http failure", () => {
    expect(toFailure(new Error("socket hang up"))).toEqual({ kind: "http", message: "socket hang up" });
    expect(toFailure("plain")).toEqual({ kind: "http", message: "plain" });
  });
});
