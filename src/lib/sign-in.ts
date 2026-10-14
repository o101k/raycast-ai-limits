import { basename } from "node:path";
import { Deps, RunResult } from "./deps";
import { STATE_DB, TOKEN_QUERY } from "./providers/cursor";

// Connect runs each tool's own sign-in. Nothing here imports Raycast, so the helpers are tested with fakeDeps.

// Sign-ins open the browser and wait for its callback, so they get far longer than the default 10 seconds.
const SIGN_IN_TIMEOUT_MS = 10 * 60_000;
const MESSAGE_MAX_LENGTH = 200;

// A marker around the PATH, so text an interactive shell prints before it (a banner, a greeting) is ignored.
const PATH_MARKER = "__AI_LIMITS__";
const PATH_PATTERN = new RegExp(`${PATH_MARKER}(.*?)${PATH_MARKER}`, "s");
const PATH_COMMAND = `printf "${PATH_MARKER}%s${PATH_MARKER}" "$PATH"`;
// Fish stores PATH as a list, and "$PATH" would join its entries with spaces, so they are joined with colons here.
const FISH_PATH_COMMAND = `printf "${PATH_MARKER}%s${PATH_MARKER}" (string join : $PATH)`;
// Shells that accept the -ilc form used below. Anything else, or a relative SHELL, falls back to zsh, the macOS default.
const KNOWN_SHELL = /^\/(?:.*\/)?(bash|zsh|fish|sh)$/;
const DEFAULT_SHELL = "/bin/zsh";

// Where Homebrew puts its commands, plus the system directories. A minimal PATH often leaves these out.
const WELL_KNOWN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

// Where the Gemini CLI keeps its login. gemini.ts reads the same file.
const GEMINI_CREDENTIALS = ".gemini/oauth_creds.json";

export interface SignInCommand {
  executable: string;
  // Readonly so a table entry such as CLI_SIGN_IN.claude.args can be passed as it is.
  args: readonly string[];
}

export type SignInResult = { ok: true } | { ok: false; reason: "cancelled" | "failed"; message: string };

// The sign-in each CLI runs, and where to get the CLI when it isn't installed. `name` is what findExecutable looks for.
export const CLI_SIGN_IN = {
  claude: { name: "claude", args: ["auth", "login"], installUrl: "https://code.claude.com/docs/en/setup" },
  codex: { name: "codex", args: ["login"], installUrl: "https://developers.openai.com/codex/cli" },
} as const;

export const CURSOR_BUNDLE_ID = "com.todesktop.230313mzl4w4u92";

// The PATH a Terminal window on this Mac would have. Raycast starts extensions with a minimal PATH, which leaves out
// Homebrew and npm installs, so the login shell is asked for its PATH. When that fails, the process PATH is used.
export async function resolveUserPath(deps: Deps): Promise<string> {
  const loginPath = await loginShellPath(deps);
  const parts = [...(loginPath ?? deps.env.PATH ?? "").split(":"), `${deps.homedir}/.local/bin`, ...WELL_KNOWN_DIRS];
  // An empty entry would mean the current directory, so it is dropped. The Set keeps the first copy of each entry, so a
  // directory the login shell already lists keeps its place and the well-known ones are only added when missing.
  return [...new Set(parts.filter((part) => part !== ""))].join(":");
}

// Returns the login shell's PATH, or undefined when the shell fails or prints no marker, so the caller can fall back.
async function loginShellPath(deps: Deps): Promise<string | undefined> {
  const shell = loginShell(deps.env.SHELL);
  const command = shell.endsWith("/fish") ? FISH_PATH_COMMAND : PATH_COMMAND;
  try {
    const result = await deps.run(shell, ["-ilc", command], { timeoutMs: 5_000 });
    if (result.exitCode !== 0) {
      return undefined;
    }
    return PATH_PATTERN.exec(result.stdout)?.[1];
  } catch {
    return undefined;
  }
}

function loginShell(shell: string | undefined): string {
  return shell && KNOWN_SHELL.test(shell) ? shell : DEFAULT_SHELL;
}

// The first directory in `path` that holds an executable called `name`, or undefined. Claude Code's older installer put
// its binary in ~/.claude/local, which isn't on PATH, so that place is checked after PATH.
export async function findExecutable(deps: Deps, name: string, path: string): Promise<string | undefined> {
  const candidates = path
    .split(":")
    .filter((dir) => dir !== "")
    .map((dir) => `${dir}/${name}`);
  if (name === "claude") {
    candidates.push(`${deps.homedir}/.claude/local/claude`);
  }
  for (const candidate of candidates) {
    if (await deps.isExecutable(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

// Runs a CLI's own sign-in and resolves when it exits. PATH goes in the child's environment so that a
// `#!/usr/bin/env node` script can find node. A run that rejects (it took longer than the timeout, or was killed) is
// reported as cancelled.
export async function runSignIn(deps: Deps, command: SignInCommand, path: string): Promise<SignInResult> {
  let result: RunResult;
  try {
    result = await deps.run(command.executable, [...command.args], {
      timeoutMs: SIGN_IN_TIMEOUT_MS,
      env: { ...deps.env, PATH: path },
    });
  } catch {
    return { ok: false, reason: "cancelled", message: "Sign-in timed out" };
  }
  if (result.exitCode === 0) {
    return { ok: true };
  }

  // CLIs print their progress first and the error last, so the last line with text is the useful one.
  const fallback = `${basename(command.executable)} exited with code ${result.exitCode}`;
  const message = lastLine(result.stderr) ?? lastLine(result.stdout) ?? fallback;
  return { ok: false, reason: "failed", message: message.slice(0, MESSAGE_MAX_LENGTH) };
}

function lastLine(text: string): string | undefined {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.at(-1);
}

// Opens Terminal and runs `command` in a new window. Gemini uses this because its sign-in is in its interactive UI, and
// Terminal's shell has the user's PATH.
export async function openInTerminal(deps: Deps, command: string): Promise<void> {
  // Backslashes are escaped first, so the ones added for the quotes aren't escaped again.
  const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const script = ['tell application "Terminal"', "activate", `do script "${escaped}"`, "end tell"].join("\n");
  const result = await deps.run("/usr/bin/osascript", ["-e", script]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `osascript exited with code ${result.exitCode}`);
  }
}

// Launches an app by its bundle id. `open` exits non-zero when the app isn't installed, which is reported as false.
export async function openApp(deps: Deps, bundleId: string): Promise<boolean> {
  try {
    const result = await deps.run("/usr/bin/open", ["-b", bundleId]);
    return result.exitCode === 0;
  } catch {
    return false;
  }
}

// Polls `check` until it passes, the timeout runs out or `signal` aborts. A check that throws counts as not yet. The
// clock and sleep are passed in so tests can run without waiting.
export async function waitFor(
  check: () => Promise<boolean>,
  options: {
    intervalMs: number;
    timeoutMs: number;
    now: () => number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
  },
): Promise<boolean> {
  const { intervalMs, timeoutMs, now, signal } = options;
  const sleep = options.sleep ?? defaultSleep;
  const deadline = now() + timeoutMs;
  while (!signal?.aborted) {
    if (await passes(check)) {
      return true;
    }
    const remaining = deadline - now();
    if (remaining <= 0) {
      return false;
    }
    // The last wait stops at the deadline, so the timeout isn't overshot by a whole interval.
    await sleep(Math.min(intervalMs, remaining));
  }
  return false;
}

async function passes(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Whether Codex has a login file. It lives in CODEX_HOME when that is set, the same as codex.ts reads it.
export async function hasCodexLogin(deps: Deps): Promise<boolean> {
  const home = deps.env.CODEX_HOME || `${deps.homedir}/.codex`;
  return fileExists(deps, `${home}/auth.json`);
}

export async function hasGeminiLogin(deps: Deps): Promise<boolean> {
  return fileExists(deps, `${deps.homedir}/${GEMINI_CREDENTIALS}`);
}

// Whether the Cursor app has a login token in its state database. A missing or unreadable database means no login.
export async function hasCursorLogin(deps: Deps): Promise<boolean> {
  try {
    const output = await deps.sqlite(deps.homedir + STATE_DB, TOKEN_QUERY);
    return output.trim() !== "";
  } catch {
    return false;
  }
}

// Deps has no existence check, so a read stands in for one. A read error is treated as "not there yet", since the
// caller is polling.
async function fileExists(deps: Deps, path: string): Promise<boolean> {
  try {
    return (await deps.readFile(path)) !== null;
  } catch {
    return false;
  }
}
