import { describe, expect, it, vi } from "vitest";
import { connectLocal, ConnectUi, LocalConnectMethod } from "../src/lib/connect";
import { Connections } from "../src/lib/connections";
import { RunResult } from "../src/lib/deps";
import { claudeKeychainService } from "../src/lib/keychain";
import { STATE_DB } from "../src/lib/providers/cursor";
import { CURSOR_BUNDLE_ID } from "../src/lib/sign-in";
import { fakeDeps, FakeDeps, HOME, NOW } from "./fake-deps";

const SHELL = "/bin/zsh";
const SECURITY = "/usr/bin/security";
const OSASCRIPT = "/usr/bin/osascript";
const OPEN = "/usr/bin/open";
const CLAUDE_BIN = "/opt/homebrew/bin/claude";
const CODEX_BIN = "/opt/homebrew/bin/codex";
const GEMINI_BIN = "/opt/homebrew/bin/gemini";
const CLAUDE_CREDENTIALS = `${HOME}/.claude/.credentials.json`;
const CODEX_AUTH = `${HOME}/.codex/auth.json`;
const GEMINI_CREDENTIALS = `${HOME}/.gemini/oauth_creds.json`;
const CURSOR_DB = `${HOME}${STATE_DB}`;
const POLL_TOTAL_MS = 10 * 60_000;

const LOGIN_JSON = '{"claudeAiOauth":{"accessToken":"oauth-token-123"}}';
const FOUND: RunResult = { exitCode: 0, stdout: `${LOGIN_JSON}\n`, stderr: "" };
const MISSING: RunResult = { exitCode: 44, stdout: "", stderr: "" };
const DENIED: RunResult = { exitCode: 128, stdout: "", stderr: "" };
const OK: RunResult = { exitCode: 0, stdout: "", stderr: "" };

function failure(stderr: string): RunResult {
  return { exitCode: 1, stdout: "", stderr };
}

// Answers a program's calls in turn, so a second call can see what the first one changed. The last answer repeats.
function inOrder(...answers: RunResult[]): () => RunResult {
  let call = 0;
  return () => answers[Math.min(call++, answers.length - 1)];
}

// Each sign-in looks for its CLI on the user's PATH, which comes from the login shell. fakeDeps has no SHELL, so the
// default /bin/zsh answers with a PATH that has Homebrew on it. The tools listed are the executables on that PATH.
function withTools(deps: FakeDeps, tools: string[] = []): FakeDeps {
  deps.programs.push({
    file: SHELL,
    respond: { exitCode: 0, stdout: "__AI_LIMITS__/opt/homebrew/bin:/usr/bin__AI_LIMITS__", stderr: "" },
  });
  for (const tool of tools) {
    deps.executables.add(tool);
  }
  return deps;
}

// The UI side of Connect. Saved patches are kept in order, and progress calls are recorded by title.
function testUi(overrides: Partial<ConnectUi> = {}) {
  const saved: Partial<Connections>[] = [];
  const progress = vi.fn();
  const ui: ConnectUi = {
    progress,
    save: async (patch) => {
      saved.push(patch);
    },
    sleep: async () => {},
    ...overrides,
  };
  return { ui, progress, saved };
}

// Replaces the clock with one that only moves when a wait sleeps. A poll that never succeeds then ends at its timeout
// without any real waiting, and `sleeps` shows how long the waits added up to.
function steppingClock(deps: FakeDeps) {
  let now = NOW;
  deps.now = () => now;
  const sleeps: number[] = [];
  return {
    sleeps,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
  };
}

const CLAUDE: LocalConnectMethod = { kind: "claude" };
const CODEX: LocalConnectMethod = { kind: "codex" };
const GEMINI: LocalConnectMethod = { kind: "gemini" };
const CURSOR: LocalConnectMethod = { kind: "cursor" };

describe("connectLocal for Claude Code on macOS", () => {
  it("saves the Keychain setting before it reads the Keychain", async () => {
    const deps = withTools(fakeDeps());
    const { ui, saved } = testUi();
    let consentAtRead: number | undefined;
    deps.programs.push({
      file: SECURITY,
      respond: () => {
        consentAtRead = saved.length;
        return FOUND;
      },
    });

    await connectLocal(deps, CLAUDE, ui);

    expect(consentAtRead).toBe(1);
    expect(saved).toEqual([{ claudeKeychain: true }]);
  });

  it("connects when the Keychain holds Claude Code's login", async () => {
    const deps = withTools(fakeDeps());
    deps.programs.push({ file: SECURITY, respond: FOUND });
    const { ui, progress } = testUi();

    expect(await connectLocal(deps, CLAUDE, ui)).toEqual({ kind: "connected" });
    expect(progress).toHaveBeenCalledWith(
      "Connecting Claude Code",
      "If macOS asks for access to Claude Code's login, choose Always Allow",
    );
    expect(deps.runCalls.map((call) => call.file)).toEqual([SECURITY]);
  });

  it("reads the Keychain item for the config folder Claude Code uses", async () => {
    const deps = withTools(fakeDeps());
    deps.env.CLAUDE_CONFIG_DIR = "/work/claude";
    deps.programs.push({ file: SECURITY, respond: FOUND });

    await connectLocal(deps, CLAUDE, testUi().ui);

    expect(deps.runCalls[0].args).toEqual([
      "find-generic-password",
      "-s",
      claudeKeychainService("/work/claude", HOME),
      "-w",
    ]);
  });

  it("fails with the Always Allow steps when macOS denies the Keychain read, without signing in", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.programs.push({ file: SECURITY, respond: DENIED });

    expect(await connectLocal(deps, CLAUDE, testUi().ui)).toEqual({
      kind: "failed",
      title: "macOS denied access to Claude Code's login",
      message: "Choose Connect again and click Always Allow",
    });
    expect(deps.runCalls.map((call) => call.file)).toEqual([SECURITY]);
  });

  it("signs in when the Keychain has no login, then connects once one is there", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.programs.push({ file: SECURITY, respond: inOrder(MISSING, FOUND) });
    deps.programs.push({ file: CLAUDE_BIN, respond: OK });
    const { ui, progress } = testUi();

    expect(await connectLocal(deps, CLAUDE, ui)).toEqual({ kind: "connected" });
    expect(progress).toHaveBeenCalledWith("Finish signing in in your browser", "Claude Code opened its sign-in page");
    expect(deps.runCalls.find((call) => call.file === CLAUDE_BIN)?.args).toEqual(["auth", "login"]);
  });

  it("reports that the login is missing when sign-in finishes without storing one", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.programs.push({ file: SECURITY, respond: inOrder(MISSING, MISSING) });
    deps.programs.push({ file: CLAUDE_BIN, respond: OK });

    expect(await connectLocal(deps, CLAUDE, testUi().ui)).toEqual({
      kind: "failed",
      title: "Claude Code signed in, but its login wasn't found",
    });
  });

  it("reports the last line of the CLI's error when sign-in fails", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.programs.push({ file: SECURITY, respond: MISSING });
    deps.programs.push({ file: CLAUDE_BIN, respond: failure("Starting login\nLogin was cancelled\n") });

    expect(await connectLocal(deps, CLAUDE, testUi().ui)).toEqual({
      kind: "failed",
      title: "Claude Code sign-in didn't finish",
      message: "Login was cancelled",
    });
  });

  it("asks for Claude Code to be installed when it isn't on the PATH", async () => {
    const deps = withTools(fakeDeps());
    deps.programs.push({ file: SECURITY, respond: MISSING });
    const { ui, progress } = testUi();

    expect(await connectLocal(deps, CLAUDE, ui)).toEqual({
      kind: "failed",
      title: "Claude Code isn't installed",
      message: "Install Claude Code, then choose Connect again",
      help: { title: "Install Claude Code", url: "https://code.claude.com/docs/en/setup" },
    });
    expect(progress).not.toHaveBeenCalledWith("Finish signing in in your browser", expect.anything());
  });
});

describe("connectLocal for Claude Code on other platforms", () => {
  it("connects from the credentials file without touching the Keychain", async () => {
    const deps = fakeDeps({ files: { [CLAUDE_CREDENTIALS]: "{}" } });
    deps.platform = "linux";
    const { ui, saved } = testUi();

    expect(await connectLocal(deps, CLAUDE, ui)).toEqual({ kind: "connected" });
    expect(deps.runCalls).toEqual([]);
    expect(saved).toEqual([{ claudeKeychain: true }]);
  });

  it("reads the credentials file from CLAUDE_CONFIG_DIR when it is set", async () => {
    const deps = fakeDeps({ files: { "/work/claude/.credentials.json": "{}" } });
    deps.platform = "linux";
    deps.env.CLAUDE_CONFIG_DIR = "/work/claude";

    expect(await connectLocal(deps, CLAUDE, testUi().ui)).toEqual({ kind: "connected" });
  });

  it("signs in and connects once the credentials file appears", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.platform = "linux";
    deps.programs.push({
      file: CLAUDE_BIN,
      respond: () => {
        deps.files.set(CLAUDE_CREDENTIALS, "{}");
        return OK;
      },
    });

    expect(await connectLocal(deps, CLAUDE, testUi().ui)).toEqual({ kind: "connected" });
  });

  it("reports that the login is missing when sign-in leaves no credentials file", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.platform = "linux";
    deps.programs.push({ file: CLAUDE_BIN, respond: OK });

    expect(await connectLocal(deps, CLAUDE, testUi().ui)).toEqual({
      kind: "failed",
      title: "Claude Code signed in, but its login wasn't found",
    });
  });
});

describe("connectLocal for Codex", () => {
  it("connects when Codex already has a login, without running anything", async () => {
    const deps = withTools(fakeDeps({ files: { [CODEX_AUTH]: "{}" } }), [CODEX_BIN]);
    const { ui, progress } = testUi();

    expect(await connectLocal(deps, CODEX, ui)).toEqual({ kind: "connected" });
    expect(deps.runCalls).toEqual([]);
    expect(progress).not.toHaveBeenCalled();
  });

  it("runs codex login and connects once auth.json exists", async () => {
    const deps = withTools(fakeDeps(), [CODEX_BIN]);
    deps.programs.push({
      file: CODEX_BIN,
      respond: () => {
        deps.files.set(CODEX_AUTH, "{}");
        return OK;
      },
    });
    const { ui, progress } = testUi();

    expect(await connectLocal(deps, CODEX, ui)).toEqual({ kind: "connected" });
    expect(progress).toHaveBeenCalledWith("Finish signing in in your browser", "Codex opened its sign-in page");
    expect(deps.runCalls.find((call) => call.file === CODEX_BIN)?.args).toEqual(["login"]);
  });

  it("asks for the Codex CLI to be installed when it isn't on the PATH", async () => {
    expect(await connectLocal(withTools(fakeDeps()), CODEX, testUi().ui)).toEqual({
      kind: "failed",
      title: "Codex CLI isn't installed",
      help: { title: "Install Codex CLI", url: "https://developers.openai.com/codex/cli" },
    });
  });

  it("reports a failed sign-in with the CLI's message", async () => {
    const deps = withTools(fakeDeps(), [CODEX_BIN]);
    deps.programs.push({ file: CODEX_BIN, respond: failure("login cancelled") });

    expect(await connectLocal(deps, CODEX, testUi().ui)).toEqual({
      kind: "failed",
      title: "Codex sign-in didn't finish",
      message: "login cancelled",
    });
  });

  it("connects when the CLI exits with an error after writing the login", async () => {
    const deps = withTools(fakeDeps(), [CODEX_BIN]);
    deps.programs.push({
      file: CODEX_BIN,
      respond: () => {
        deps.files.set(CODEX_AUTH, "{}");
        return failure("warning: could not open browser");
      },
    });

    expect(await connectLocal(deps, CODEX, testUi().ui)).toEqual({ kind: "connected" });
  });

  it("reports a failed sign-in without a message when the CLI exited cleanly and wrote nothing", async () => {
    const deps = withTools(fakeDeps(), [CODEX_BIN]);
    deps.programs.push({ file: CODEX_BIN, respond: OK });

    expect(await connectLocal(deps, CODEX, testUi().ui)).toEqual({
      kind: "failed",
      title: "Codex sign-in didn't finish",
    });
  });
});

describe("connectLocal for Gemini CLI", () => {
  it("connects when Gemini CLI already has a login, without running anything", async () => {
    const deps = withTools(fakeDeps({ files: { [GEMINI_CREDENTIALS]: "{}" } }), [GEMINI_BIN]);

    expect(await connectLocal(deps, GEMINI, testUi().ui)).toEqual({ kind: "connected" });
    expect(deps.runCalls).toEqual([]);
  });

  it("asks for Gemini CLI to be installed when it isn't on the PATH", async () => {
    expect(await connectLocal(withTools(fakeDeps()), GEMINI, testUi().ui)).toEqual({
      kind: "failed",
      title: "Gemini CLI isn't installed",
      help: { title: "Install Gemini CLI", url: "https://github.com/google-gemini/gemini-cli" },
    });
  });

  it("reports when Terminal can't be opened", async () => {
    const deps = withTools(fakeDeps(), [GEMINI_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: failure("Not authorized to send Apple events") });

    expect(await connectLocal(deps, GEMINI, testUi().ui)).toEqual({
      kind: "failed",
      title: "Couldn't open Terminal",
      message: "Not authorized to send Apple events",
    });
  });

  it("runs gemini in Terminal and connects once its login is written", async () => {
    const deps = withTools(fakeDeps(), [GEMINI_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const { ui, progress } = testUi({
      sleep: async () => {
        deps.files.set(GEMINI_CREDENTIALS, "{}");
      },
    });

    expect(await connectLocal(deps, GEMINI, ui)).toEqual({ kind: "connected" });
    expect(progress).toHaveBeenCalledWith(
      "Sign in to Gemini CLI in Terminal",
      "Choose Sign in with Google, then come back",
    );
    expect(deps.runCalls.find((call) => call.file === OSASCRIPT)?.args).toEqual([
      "-e",
      expect.stringContaining('do script "gemini"'),
    ]);
  });

  it("gives up after 10 minutes without a login", async () => {
    const deps = withTools(fakeDeps(), [GEMINI_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const clock = steppingClock(deps);

    expect(await connectLocal(deps, GEMINI, testUi({ sleep: clock.sleep }).ui)).toEqual({
      kind: "failed",
      title: "Gemini CLI sign-in didn't finish",
    });
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(POLL_TOTAL_MS);
    expect(clock.sleeps.every((ms) => ms === 2_000)).toBe(true);
  });
});

describe("connectLocal for Cursor", () => {
  it("connects when the Cursor app already has a login, without opening it", async () => {
    const deps = fakeDeps();
    deps.sqliteResults.set(CURSOR_DB, "eyJhbGciOiJub25lIn0.e30.sig\n");
    const { ui, progress } = testUi();

    expect(await connectLocal(deps, CURSOR, ui)).toEqual({ kind: "connected" });
    expect(deps.runCalls).toEqual([]);
    expect(progress).not.toHaveBeenCalled();
  });

  it("asks for Cursor to be downloaded when the app can't be opened", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: OPEN, respond: failure("Unable to find application") });

    expect(await connectLocal(deps, CURSOR, testUi().ui)).toEqual({
      kind: "failed",
      title: "Cursor isn't installed",
      help: { title: "Download Cursor", url: "https://cursor.com/download" },
    });
    expect(deps.runCalls).toEqual([{ file: OPEN, args: ["-b", CURSOR_BUNDLE_ID], options: undefined }]);
  });

  it("opens Cursor and connects once its login is stored", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: OPEN, respond: OK });
    const { ui, progress } = testUi({
      sleep: async () => {
        deps.sqliteResults.set(CURSOR_DB, "eyJhbGciOiJub25lIn0.e30.sig");
      },
    });

    expect(await connectLocal(deps, CURSOR, ui)).toEqual({ kind: "connected" });
    expect(progress).toHaveBeenCalledWith("Sign in to Cursor in the app", "Waiting for Cursor to finish signing in");
  });

  it("gives up after 10 minutes without a login", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: OPEN, respond: OK });
    const clock = steppingClock(deps);

    expect(await connectLocal(deps, CURSOR, testUi({ sleep: clock.sleep }).ui)).toEqual({
      kind: "failed",
      title: "Cursor sign-in didn't finish",
    });
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(POLL_TOTAL_MS);
  });
});
