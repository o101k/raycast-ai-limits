import type { Settings } from "./types";

// Empty and whitespace-only preferences mean "not set", so providers can check for undefined alone.
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Builds the provider settings from the Raycast preferences. The GitHub token from signing in is kept apart from the
// preferences, because it lives in OAuth storage rather than in the preferences file.
export function toSettings(prefs: Preferences, githubOAuthToken?: string): Settings {
  return {
    claudeSessionKey: clean(prefs.claudeSessionKey),
    cursorCookie: clean(prefs.cursorCookie),
    githubToken: clean(prefs.githubToken),
    githubOAuthToken: clean(githubOAuthToken),
    openrouterApiKey: clean(prefs.openrouterApiKey),
    zaiApiKey: clean(prefs.zaiApiKey),
    zaiRegion: prefs.zaiRegion,
    kimiApiKey: clean(prefs.kimiApiKey),
    deepseekApiKey: clean(prefs.deepseekApiKey),
    moonshotApiKey: clean(prefs.moonshotApiKey),
    moonshotRegion: prefs.moonshotRegion,
  };
}
