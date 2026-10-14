import { Connections } from "./connections";
import { Deps } from "./deps";
import { claudeKeychainService, readKeychainPassword } from "./keychain";
import {
  CLI_SIGN_IN,
  CURSOR_BUNDLE_ID,
  findExecutable,
  openApp,
  openInTerminal,
  readCodexLogin,
  readCursorLogin,
  readGeminiLogin,
  resolveUserPath,
  waitFor,
} from "./sign-in";

// Connect is the one-click sign-in for each provider. The UI runs the OAuth methods itself. The local ones are run here
// with the helpers in sign-in.ts and keychain.ts. Nothing here imports Raycast, so the flows are tested with fakeDeps.

export type ApiKeyField = "openrouterApiKey" | "zaiApiKey" | "kimiApiKey" | "deepseekApiKey" | "moonshotApiKey";
export type RegionField = "zaiRegion" | "moonshotRegion";

// How a provider connects. "github" and "openrouter" use Raycast's OAuth and are run by the UI.
export type ConnectMethod =
  | { kind: "claude" }
  | { kind: "codex" }
  | { kind: "gemini" }
  | { kind: "cursor" }
  | { kind: "github" }
  | { kind: "openrouter" }
  | {
      kind: "api-key";
      field: ApiKeyField;
      region?: RegionField;
      keyUrl: string;
      keyPattern: RegExp;
      placeholder: string;
    };

export type LocalConnectMethod = Extract<ConnectMethod, { kind: "claude" | "codex" | "gemini" | "cursor" }>;

export interface ConnectUi {
  // Shows what Connect is doing now, such as "Finish signing in in Terminal".
  progress(title: string, message?: string): void;
  // Stores credentials the extension keeps itself (LocalStorage in the real UI).
  save(patch: Partial<Connections>): Promise<void>;
  // Fetches this provider's usage with the latest saved connections. True when it works, false when the login is
  // missing or rejected.
  verify(): Promise<boolean>;
  // Aborted when the user leaves the command, which stops any waiting.
  signal?: AbortSignal;
  // Replaces the wait between checks in tests. The real UI leaves it out.
  sleep?: (ms: number) => Promise<void>;
}

export type ConnectOutcome =
  { kind: "connected" } | { kind: "failed"; title: string; message?: string; help?: { title: string; url: string } };

// The sign-in runs outside Raycast (in Terminal, or in the Cursor app), so the login is checked every few seconds
// for up to 10 minutes.
const POLL_INTERVAL_MS = 3_000;
const POLL_TIMEOUT_MS = 10 * 60_000;
const GEMINI_INSTALL_URL = "https://github.com/google-gemini/gemini-cli";
const CURSOR_DOWNLOAD_URL = "https://cursor.com/download";

const CONNECTED: ConnectOutcome = { kind: "connected" };
// Closing the command stops the wait, but the sign-in itself keeps going in Terminal or the app.
const STOPPED: ConnectOutcome = {
  kind: "failed",
  title: "Connect stopped",
  message: "Finish signing in, then refresh",
};

// Each sign-in starts with the login that is already there. When it works (ui.verify), nothing is run. Otherwise the
// sign-in runs and the login is polled until a new one appears.
export async function connectLocal(deps: Deps, method: LocalConnectMethod, ui: ConnectUi): Promise<ConnectOutcome> {
  switch (method.kind) {
    case "claude":
      return connectClaude(deps, ui);
    case "codex":
      return connectCodex(deps, ui);
    case "gemini":
      return connectGemini(deps, ui);
    case "cursor":
      return connectCursor(deps, ui);
  }
}

// Clicking Connect is the consent to read Claude Code's login, so the setting is saved before anything is read.
async function connectClaude(deps: Deps, ui: ConnectUi): Promise<ConnectOutcome> {
  await ui.save({ claudeKeychain: true });
  ui.progress("Connecting Claude Code", "If macOS asks for access to Claude Code's login, choose Always Allow");

  const read = await readKeychainPassword(deps, claudeKeychainService(deps.env.CLAUDE_CONFIG_DIR, deps.homedir));
  if (read.kind === "denied") {
    // Turning the setting back off stops later refreshes from asking macOS again. Choosing Connect turns it on again.
    await ui.save({ claudeKeychain: false });
    return {
      kind: "failed",
      title: "macOS denied access to Claude Code's login",
      message: "Choose Connect again and click Always Allow",
    };
  }
  // The Keychain item is the login when there is one. Otherwise the credentials file is, as claude.ts reads it.
  const before = read.kind === "found" ? read.text : await readClaudeCredentials(deps);
  if (before !== null && (await ui.verify())) {
    return CONNECTED;
  }
  return signInClaude(deps, ui, before);
}

async function signInClaude(deps: Deps, ui: ConnectUi, before: string | null): Promise<ConnectOutcome> {
  const executable = await findExecutable(deps, CLI_SIGN_IN.claude.name, await resolveUserPath(deps));
  if (!executable) {
    // Connect saved the Keychain setting above, but there is nothing to read without Claude Code. It is turned back off
    // so the item doesn't show Disconnect for nothing.
    await ui.save({ claudeKeychain: false });
    return {
      kind: "failed",
      title: "Claude Code isn't installed",
      message: "Install Claude Code, then choose Connect again",
      help: { title: "Install Claude Code", url: CLI_SIGN_IN.claude.installUrl },
    };
  }
  return signInInTerminal(deps, ui, {
    argv: [executable, ...CLI_SIGN_IN.claude.args],
    progressTitle: "Finish signing in in Terminal",
    progressMessage: "Paste the code in Terminal if Claude Code asks for it",
    check: async () => isNewLogin(before, await readClaudeLogin(deps)),
    failure: "Claude Code sign-in didn't finish",
  });
}

// Claude Code's login as text, read the way claude.ts reads it: the Keychain item first, then the credentials file when
// the item is missing. A denied Keychain read is no login, since the file may be the stale copy.
async function readClaudeLogin(deps: Deps): Promise<string | null> {
  const read = await readKeychainPassword(deps, claudeKeychainService(deps.env.CLAUDE_CONFIG_DIR, deps.homedir));
  if (read.kind === "found") {
    return read.text;
  }
  return read.kind === "denied" ? null : readClaudeCredentials(deps);
}

// The credentials file Claude Code keeps outside the Keychain, as text. An unreadable file counts as missing.
async function readClaudeCredentials(deps: Deps): Promise<string | null> {
  const configDir = deps.env.CLAUDE_CONFIG_DIR || `${deps.homedir}/.claude`;
  try {
    return await deps.readFile(`${configDir}/.credentials.json`);
  } catch {
    return null;
  }
}

// Whether a login read after sign-in counts as new. Any login counts when there was none before. Otherwise it must
// differ from the login read before the sign-in, since the rejected one stays in place until the CLI replaces it.
function isNewLogin(before: string | null, after: string | null): boolean {
  return after !== null && (before === null || after !== before);
}

async function connectCodex(deps: Deps, ui: ConnectUi): Promise<ConnectOutcome> {
  const before = await readCodexLogin(deps);
  if (before !== null && (await ui.verify())) {
    return CONNECTED;
  }

  const executable = await findExecutable(deps, CLI_SIGN_IN.codex.name, await resolveUserPath(deps));
  if (!executable) {
    return {
      kind: "failed",
      title: "Codex CLI isn't installed",
      help: { title: "Install Codex CLI", url: CLI_SIGN_IN.codex.installUrl },
    };
  }
  return signInInTerminal(deps, ui, {
    argv: [executable, ...CLI_SIGN_IN.codex.args],
    progressTitle: "Finish signing in in Terminal",
    progressMessage: "Codex is waiting for its sign-in to finish",
    check: async () => isNewLogin(before, await readCodexLogin(deps)),
    failure: "Codex sign-in didn't finish",
  });
}

async function connectGemini(deps: Deps, ui: ConnectUi): Promise<ConnectOutcome> {
  const before = await readGeminiLogin(deps);
  if (before !== null && (await ui.verify())) {
    return CONNECTED;
  }

  const executable = await findExecutable(deps, "gemini", await resolveUserPath(deps));
  if (!executable) {
    return {
      kind: "failed",
      title: "Gemini CLI isn't installed",
      help: { title: "Install Gemini CLI", url: GEMINI_INSTALL_URL },
    };
  }
  // Gemini signs in through its own interactive screen, so it runs in Terminal, like Claude and Codex.
  return signInInTerminal(deps, ui, {
    argv: [executable],
    progressTitle: "Sign in to Gemini CLI in Terminal",
    progressMessage: "Choose Sign in with Google, then come back",
    check: async () => isNewLogin(before, await readGeminiLogin(deps)),
    failure: "Gemini CLI sign-in didn't finish",
  });
}

async function connectCursor(deps: Deps, ui: ConnectUi): Promise<ConnectOutcome> {
  // Connect Cursor means the app's login. A cookie saved as a fallback is used before the app's login, so it is cleared
  // first, and the check below then looks at the app.
  await ui.save({ cursorCookie: "" });
  const before = await readCursorLogin(deps);
  if (before !== null && (await ui.verify())) {
    return CONNECTED;
  }

  if (!(await openApp(deps, CURSOR_BUNDLE_ID))) {
    return {
      kind: "failed",
      title: "Cursor isn't installed",
      help: { title: "Download Cursor", url: CURSOR_DOWNLOAD_URL },
    };
  }
  ui.progress("Sign in to Cursor in the app", "Waiting for Cursor to finish signing in");
  return waitForLogin(
    deps,
    ui,
    async () => isNewLogin(before, await readCursorLogin(deps)),
    "Cursor sign-in didn't finish",
  );
}

// Opens Terminal with a CLI's sign-in, then waits for its login. The sign-in keeps running in Terminal after this
// returns, so it isn't stopped when the wait gives up.
async function signInInTerminal(
  deps: Deps,
  ui: ConnectUi,
  options: {
    argv: string[];
    progressTitle: string;
    progressMessage: string;
    check: () => Promise<boolean>;
    failure: string;
  },
): Promise<ConnectOutcome> {
  try {
    await openInTerminal(deps, options.argv);
  } catch (error) {
    return {
      kind: "failed",
      title: "Couldn't open Terminal",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  ui.progress(options.progressTitle, options.progressMessage);
  return waitForLogin(deps, ui, options.check, options.failure);
}

// Polls until the login is new. The clock comes from deps, so a test can move it forward. When the wait ends because
// the command closed, the result says so, since the sign-in may still be running.
async function waitForLogin(
  deps: Deps,
  ui: ConnectUi,
  check: () => Promise<boolean>,
  failure: string,
): Promise<ConnectOutcome> {
  const signedIn = await waitFor(check, {
    intervalMs: POLL_INTERVAL_MS,
    timeoutMs: POLL_TIMEOUT_MS,
    now: () => deps.now(),
    sleep: ui.sleep,
    signal: ui.signal,
  });
  if (signedIn) {
    return CONNECTED;
  }
  return ui.signal?.aborted ? STOPPED : { kind: "failed", title: failure };
}
