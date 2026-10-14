import { describe, expect, it } from "vitest";
import { PROVIDERS } from "../src/lib/providers";
import { ProviderError, ProviderId, Settings } from "../src/lib/types";
import { fakeDeps } from "./fake-deps";

// A fresh install has no credentials, so every provider must say "not connected" without a request. This guards the
// promise that a new user sees the Not Connected section, not errors.

const ALL_PROVIDER_IDS: ProviderId[] = [
  "claude",
  "codex",
  "cursor",
  "gemini",
  "copilot",
  "openrouter",
  "zai",
  "kimi",
  "deepseek",
  "moonshot",
];

const EMPTY_SETTINGS: Settings = {};

describe("provider registry", () => {
  it("has a unique id for every provider", () => {
    const ids = PROVIDERS.map((provider) => provider.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("covers exactly the ProviderId values", () => {
    const ids = PROVIDERS.map((provider) => provider.id).sort();
    expect(ids).toEqual([...ALL_PROVIDER_IDS].sort());
  });

  it("has a name, dashboard and icon for every provider", () => {
    for (const provider of PROVIDERS) {
      expect(provider.name.trim()).not.toBe("");
      expect(provider.dashboardUrl).toMatch(/^https:\/\//);
      expect(provider.iconUrl).toMatch(/^https:\/\//);
    }
  });
});

describe.each(PROVIDERS.map((provider) => [provider.name, provider] as const))(
  "%s with no credentials",
  (_name, provider) => {
    it("rejects with a not-connected error", async () => {
      const deps = fakeDeps();
      const error = await provider.fetchUsage(deps, EMPTY_SETTINGS).then(
        () => undefined,
        (reason: unknown) => reason,
      );
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).kind).toBe("not-connected");
    });

    it("makes no network request", async () => {
      const deps = fakeDeps();
      await provider.fetchUsage(deps, EMPTY_SETTINGS).catch(() => undefined);
      expect(deps.requests).toEqual([]);
    });

    it("gives steps to connect in the hint", async () => {
      const deps = fakeDeps();
      const error = (await provider
        .fetchUsage(deps, EMPTY_SETTINGS)
        .catch((reason: unknown) => reason)) as ProviderError;
      expect(error.hint?.trim()).toBeTruthy();
    });
  },
);
