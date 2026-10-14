import { Connections } from "./connections";
import { Deps } from "./deps";
import { claudeKeychainService, readKeychainPassword } from "./keychain";
import {
  CLI_SIGN_IN,
  CURSOR_BUNDLE_ID,
  findExecutable,
  hasCodexLogin,
  hasCursorLogin,
  hasGeminiLogin,
  openApp,
  openInTerminal,
  resolveUserPath,
  runSignIn,
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
  // Shows what Connect is doing now, such as "Finish signing in in your browser".
  progress(title: string, message?: string): void;
  // Stores credentials the extension keeps itself (LocalStorage in the real UI).
  save(patch: Partial<Connections>): Promise<void>;
  // Aborted when the user leaves the command, which stops any waiting.
  signal?: AbortSignal;
  // Replaces the wait between checks in tests. The real UI leaves it out.
  sleep?: (ms: number) => Promise<void>;
}

export type ConnectOutcome =
  { kind: "connected" } | { kind: "failed"; title: string; message?: string; help?: { title: string; url: string } };

// Gemini and Cursor finish signing in outside the extension, so the login is checked every few seconds for up to 10
// minutes.
const POLL_INTERVAL_MS = 2_000;
const POLL_TIMEOUT_MS = 10 * 60_000;
const GEMINI_INSTALL_URL = "https://github.com/google-gemini/gemini-cli";
const CURSOR_DOWNLOAD_URL = "https://cursor.com/download";

const CONNECTED: ConnectOutcome = { kind: "connected" };

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

  if (deps.platform !== "darwin") {
    if (await claudeCredentialsExist(deps)) {
      return CONNECTED;
    }
    return signInClaude(deps, ui, () => claudeCredentialsExist(deps));
  }

  const service = claudeKeychainService(deps.env.CLAUDE_CONFIG_DIR, deps.homedir);
  ui.progress("Connecting Claude Code", "If macOS asks for access to Claude Code's login, choose Always Allow");
  const read = await readKeychainPassword(deps, service);
  if (read.kind === "found") {
    return CONNECTED;
  }
  if (read.kind === "denied") {
    return {
      kind: "failed",
      title: "macOS denied access to Claude Code's login",
      message: "Choose Connect again and click Always Allow",
    };
  }
  return signInClaude(deps, ui, async () => (await readKeychainPassword(deps, service)).kind === "found");
}

// Runs `claude auth login`, then checks again for the login. `hasLogin` reads the Keychain on macOS and the credentials
// file elsewhere.
async function signInClaude(deps: Deps, ui: ConnectUi, hasLogin: () => Promise<boolean>): Promise<ConnectOutcome> {
  const path = await resolveUserPath(deps);
  const executable = await findExecutable(deps, CLI_SIGN_IN.claude.name, path);
  if (!executable) {
    return {
      kind: "failed",
      title: "Claude Code isn't installed",
      message: "Install Claude Code, then choose Connect again",
      help: { title: "Install Claude Code", url: CLI_SIGN_IN.claude.installUrl },
    };
  }

  ui.progress("Finish signing in in your browser", "Claude Code opened its sign-in page");
  const result = await runSignIn(deps, { executable, args: CLI_SIGN_IN.claude.args }, path);
  if (!result.ok) {
    return { kind: "failed", title: "Claude Code sign-in didn't finish", message: result.message };
  }
  if (await hasLogin()) {
    return CONNECTED;
  }
  return { kind: "failed", title: "Claude Code signed in, but its login wasn't found" };
}

// The credentials file Claude Code keeps outside macOS. An unreadable file counts as missing, as in sign-in.ts.
async function claudeCredentialsExist(deps: Deps): Promise<boolean> {
  const configDir = deps.env.CLAUDE_CONFIG_DIR || `${deps.homedir}/.claude`;
  try {
    return (await deps.readFile(`${configDir}/.credentials.json`)) !== null;
  } catch {
    return false;
  }
}

async function connectCodex(deps: Deps, ui: ConnectUi): Promise<ConnectOutcome> {
  if (await hasCodexLogin(deps)) {
    return CONNECTED;
  }

  const path = await resolveUserPath(deps);
  const executable = await findExecutable(deps, CLI_SIGN_IN.codex.name, path);
  if (!executable) {
    return {
      kind: "failed",
      title: "Codex CLI isn't installed",
      help: { title: "Install Codex CLI", url: CLI_SIGN_IN.codex.installUrl },
    };
  }

  ui.progress("Finish signing in in your browser", "Codex opened its sign-in page");
  const result = await runSignIn(deps, { executable, args: CLI_SIGN_IN.codex.args }, path);
  // The login file is the real test, so it is checked even when the CLI exited with an error.
  if (await hasCodexLogin(deps)) {
    return CONNECTED;
  }
  return {
    kind: "failed",
    title: "Codex sign-in didn't finish",
    message: result.ok ? undefined : result.message,
  };
}

async function connectGemini(deps: Deps, ui: ConnectUi): Promise<ConnectOutcome> {
  if (await hasGeminiLogin(deps)) {
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

  // Gemini signs in through its own interactive screen, so it runs in Terminal, whose shell has the user's PATH.
  try {
    await openInTerminal(deps, "gemini");
  } catch (error) {
    return {
      kind: "failed",
      title: "Couldn't open Terminal",
      message: error instanceof Error ? error.message : String(error),
    };
  }
  ui.progress("Sign in to Gemini CLI in Terminal", "Choose Sign in with Google, then come back");
  return waitForLogin(deps, ui, () => hasGeminiLogin(deps), "Gemini CLI sign-in didn't finish");
}

async function connectCursor(deps: Deps, ui: ConnectUi): Promise<ConnectOutcome> {
  if (await hasCursorLogin(deps)) {
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
  return waitForLogin(deps, ui, () => hasCursorLogin(deps), "Cursor sign-in didn't finish");
}

// Polls until the login appears. The clock comes from deps, so a test can move it forward.
async function waitForLogin(
  deps: Deps,
  ui: ConnectUi,
  check: () => Promise<boolean>,
  title: string,
): Promise<ConnectOutcome> {
  const signedIn = await waitFor(check, {
    intervalMs: POLL_INTERVAL_MS,
    timeoutMs: POLL_TIMEOUT_MS,
    now: () => deps.now(),
    sleep: ui.sleep,
    signal: ui.signal,
  });
  return signedIn ? CONNECTED : { kind: "failed", title };
}
