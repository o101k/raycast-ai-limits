import { describe, expect, it } from "vitest";
import { toSettings } from "../src/lib/settings";

function prefs(overrides: Partial<Record<string, string>> = {}): Preferences {
  return {
    displayMode: "used",
    showNotConnected: true,
    zaiRegion: "global",
    moonshotRegion: "global",
    ...overrides,
  } as Preferences;
}

describe("toSettings", () => {
  it("trims the strings it keeps", () => {
    const settings = toSettings(prefs({ claudeSessionKey: "  sk-ant-sid01-abc  ", openrouterApiKey: " sk-or-v1-x " }));
    expect(settings.claudeSessionKey).toBe("sk-ant-sid01-abc");
    expect(settings.openrouterApiKey).toBe("sk-or-v1-x");
  });

  it("turns empty and whitespace-only strings into undefined", () => {
    const settings = toSettings(prefs({ cursorCookie: "", githubToken: "   ", kimiApiKey: "" }));
    expect(settings.cursorCookie).toBeUndefined();
    expect(settings.githubToken).toBeUndefined();
    expect(settings.kimiApiKey).toBeUndefined();
  });

  it("leaves a missing preference undefined", () => {
    expect(toSettings(prefs()).zaiApiKey).toBeUndefined();
  });

  it("passes the regions through", () => {
    const settings = toSettings(prefs({ zaiRegion: "china", moonshotRegion: "china" }));
    expect(settings.zaiRegion).toBe("china");
    expect(settings.moonshotRegion).toBe("china");
  });

  it("keeps the GitHub sign-in token apart from the preference token", () => {
    const settings = toSettings(prefs({ githubToken: "" }), "gho_signedin");
    expect(settings.githubToken).toBeUndefined();
    expect(settings.githubOAuthToken).toBe("gho_signedin");
  });

  it("treats an empty sign-in token as absent", () => {
    expect(toSettings(prefs(), "  ").githubOAuthToken).toBeUndefined();
  });
});
