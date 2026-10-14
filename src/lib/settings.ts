import type { Connections } from "./connections";
import type { Settings } from "./types";

// Empty and whitespace-only preferences mean "not set", so providers can check for undefined alone.
function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

// Builds the provider settings from the Raycast preferences and the connections the extension stored itself. A value
// typed into the preferences wins over a stored one, because the user typed it on purpose. The GitHub token from signing
// in is kept apart from both, because it lives in OAuth storage.
// A region belongs to its key. When the key came from the preferences, the preferences' region is used. When it came
// from a connection, the region stored with that connection is used, defaulting to "global".
export function toSettings(prefs: Preferences, connections: Connections = {}, githubOAuthToken?: string): Settings {
  const zaiFromPrefs = clean(prefs.zaiApiKey);
  const zaiFromConnection = clean(connections.zaiApiKey);
  const moonshotFromPrefs = clean(prefs.moonshotApiKey);
  const moonshotFromConnection = clean(connections.moonshotApiKey);

  return {
    // Only a connection can turn this on, since Raycast preferences have no such setting.
    claudeKeychain: connections.claudeKeychain,
    claudeSessionKey: clean(prefs.claudeSessionKey) ?? clean(connections.claudeSessionKey),
    cursorCookie: clean(prefs.cursorCookie) ?? clean(connections.cursorCookie),
    githubToken: clean(prefs.githubToken),
    githubOAuthToken: clean(githubOAuthToken),
    openrouterApiKey: clean(prefs.openrouterApiKey) ?? clean(connections.openrouterApiKey),
    zaiApiKey: zaiFromPrefs ?? zaiFromConnection,
    zaiRegion:
      zaiFromPrefs === undefined && zaiFromConnection !== undefined
        ? (connections.zaiRegion ?? "global")
        : prefs.zaiRegion,
    kimiApiKey: clean(prefs.kimiApiKey) ?? clean(connections.kimiApiKey),
    deepseekApiKey: clean(prefs.deepseekApiKey) ?? clean(connections.deepseekApiKey),
    moonshotApiKey: moonshotFromPrefs ?? moonshotFromConnection,
    moonshotRegion:
      moonshotFromPrefs === undefined && moonshotFromConnection !== undefined
        ? (connections.moonshotRegion ?? "global")
        : prefs.moonshotRegion,
  };
}
