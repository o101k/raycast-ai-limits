import { describe, expect, it, vi } from "vitest";
import {
  connectLocal,
  ConnectMethod,
  ConnectUi,
  isConnectOverridden,
  LocalConnectMethod,
  loginCheckFromError,
} from "../src/lib/connect";
import { Connections } from "../src/lib/connections";
import { RunResult } from "../src/lib/deps";
import { claudeKeychainService } from "../src/lib/keychain";
import { STATE_DB } from "../src/lib/providers/cursor";
import { CURSOR_BUNDLE_ID } from "../src/lib/sign-in";
import { ProviderError, Settings } from "../src/lib/types";
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
const POLL_INTERVAL_MS = 3_000;
const AUTOMATION_HINT = "Allow it in System Settings > Privacy & Security > Automation.";

const LOGIN_JSON = '{"claudeAiOauth":{"accessToken":"oauth-token-123"}}';
const RENEWED_JSON = '{"claudeAiOauth":{"accessToken":"renewed-token-456"}}';
const FOUND: RunResult = { exitCode: 0, stdout: `${LOGIN_JSON}\n`, stderr: "" };
const MISSING: RunResult = { exitCode: 44, stdout: "", stderr: "" };
const DENIED: RunResult = { exitCode: 128, stdout: "", stderr: "" };
const OK: RunResult = { exitCode: 0, stdout: "", stderr: "" };
const CURSOR_TOKEN = "eyJhbGciOiJub25lIn0.e30.sig";
// The modified date of the Keychain item as security prints it, and a later one for a login that was written again.
const WRITTEN = "20261014120000Z\\000";
const REWRITTEN = "20261014130000Z\\000";

function failure(stderr: string): RunResult {
  return { exitCode: 1, stdout: "", stderr };
}

// What `security find-generic-password` prints for an item without -w: the attributes, with the modified date on its
// "mdat" line. Connect reads that date as the Claude Code login marker.
function itemAttributes(modified: string): RunResult {
  return {
    exitCode: 0,
    stdout: [
      'keychain: "/Users/tester/Library/Keychains/login.keychain-db"',
      "version: 512",
      'class: "genp"',
      "attributes:",
      '    0x00000007 <blob>="Claude Code-credentials"',
      '    "acct"<blob>="tester"',
      '    "cdat"<timedate>=0x32303236303130313130303030305A00  "20260101100000Z\\000"',
      `    "mdat"<timedate>=0x32303236313031343132303030305A00  "${modified}"`,
      '    "svce"<blob>="Claude Code-credentials"',
      "",
    ].join("\n"),
    stderr: "",
  };
}
const ITEM = itemAttributes(WRITTEN);
const ITEM_REWRITTEN = itemAttributes(REWRITTEN);

// Answers the two Keychain reads Connect makes, by their arguments. A read with -w asks macOS for the password, and any
// other read is the item's attributes, which macOS answers without asking. Each kind is answered in turn.
function keychain(deps: FakeDeps, password: () => RunResult, attributes: () => RunResult) {
  deps.programs.push({ file: SECURITY, respond: (args) => (args.includes("-w") ? password() : attributes()) });
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

// The UI side of Connect. Saved patches are kept in order, and progress calls are recorded by title. By default the
// saved login is taken to work, so a test sets `verify` when it means a rejected one.
function testUi(overrides: Partial<ConnectUi> = {}) {
  const saved: Partial<Connections>[] = [];
  const progress = vi.fn();
  const ui: ConnectUi = {
    progress,
    save: async (patch) => {
      saved.push(patch);
    },
    verify: async () => "ok",
    // A wait only happens when the login hasn't changed yet. A test that gets here without a clock to move would wait
    // forever, so it fails at once instead.
    sleep: async () => {
      throw new Error("Connect waited for a login change that never came");
    },
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

// The script that the Terminal sign-in ran, or undefined when osascript was never run.
function terminalScript(deps: FakeDeps): string | undefined {
  return deps.runCalls.find((call) => call.file === OSASCRIPT)?.args[1];
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
    keychain(
      deps,
      () => {
        consentAtRead = saved.length;
        return FOUND;
      },
      inOrder(ITEM),
    );

    await connectLocal(deps, CLAUDE, ui);

    expect(consentAtRead).toBe(1);
    expect(saved).toEqual([{ claudeKeychain: true }]);
  });

  it("connects without signing in when the Keychain login works", async () => {
    const deps = withTools(fakeDeps());
    keychain(deps, inOrder(FOUND), inOrder(ITEM));
    const { ui, progress } = testUi();

    expect(await connectLocal(deps, CLAUDE, ui)).toEqual({ kind: "connected" });
    expect(progress).toHaveBeenCalledWith(
      "Connecting Claude Code",
      "If macOS asks for access to Claude Code's login, choose Always Allow",
    );
    expect(deps.runCalls.map((call) => call.file)).toEqual([SECURITY, SECURITY]);
  });

  it("reads the Keychain item for the config folder Claude Code uses", async () => {
    const deps = withTools(fakeDeps());
    deps.env.CLAUDE_CONFIG_DIR = "/work/claude";
    keychain(deps, inOrder(FOUND), inOrder(ITEM));

    await connectLocal(deps, CLAUDE, testUi().ui);

    expect(deps.runCalls[0].args).toEqual([
      "find-generic-password",
      "-s",
      claudeKeychainService("/work/claude", HOME),
      "-w",
    ]);
    expect(deps.runCalls[1].args).toEqual(["find-generic-password", "-s", claudeKeychainService("/work/claude", HOME)]);
  });

  it("signs in again when verify says the Keychain login was rejected, and connects once it changes", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    keychain(deps, inOrder(FOUND), inOrder(ITEM, ITEM_REWRITTEN));
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const verify = vi.fn(async () => "broken" as const);

    expect(await connectLocal(deps, CLAUDE, testUi({ verify }).ui)).toEqual({ kind: "connected" });
    expect(verify).toHaveBeenCalledTimes(1);
    expect(terminalScript(deps)).toContain(`do script "'${CLAUDE_BIN}' 'auth' 'login'"`);
  });

  it("keeps polling while the Keychain item is unchanged, and gives up after 10 minutes", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    keychain(deps, inOrder(FOUND), inOrder(ITEM));
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const clock = steppingClock(deps);

    expect(await connectLocal(deps, CLAUDE, testUi({ verify: async () => "broken", sleep: clock.sleep }).ui)).toEqual({
      kind: "failed",
      title: "Claude Code sign-in didn't finish",
    });
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(POLL_TOTAL_MS);
    expect(clock.sleeps.every((ms) => ms === POLL_INTERVAL_MS)).toBe(true);
  });

  it("reads the password once, at the start, and only reads the item's date while it waits for the sign-in", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    let passwordReads = 0;
    let dateReads = 0;
    keychain(
      deps,
      () => {
        passwordReads++;
        return FOUND;
      },
      () => {
        dateReads++;
        return ITEM;
      },
    );
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const clock = steppingClock(deps);

    await connectLocal(deps, CLAUDE, testUi({ verify: async () => "broken", sleep: clock.sleep }).ui);

    expect(passwordReads).toBe(1);
    expect(dateReads).toBeGreaterThan(POLL_TOTAL_MS / POLL_INTERVAL_MS);
  });

  it("fails with the Always Allow steps when macOS denies the Keychain read, without signing in", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.programs.push({ file: SECURITY, respond: DENIED });
    const verify = vi.fn(async () => "ok" as const);

    expect(await connectLocal(deps, CLAUDE, testUi({ verify }).ui)).toEqual({
      kind: "failed",
      title: "macOS denied access to Claude Code's login",
      message: "Choose Connect again and click Always Allow",
    });
    expect(deps.runCalls.map((call) => call.file)).toEqual([SECURITY]);
    expect(verify).not.toHaveBeenCalled();
  });

  it("turns the Keychain setting back off when macOS denies the read, so later refreshes don't ask again", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.programs.push({ file: SECURITY, respond: DENIED });
    const { ui, saved } = testUi();

    await connectLocal(deps, CLAUDE, ui);

    expect(saved).toEqual([{ claudeKeychain: true }, { claudeKeychain: false }]);
  });

  it("ends like a denied read when macOS denies the password during verify, and does not sign in", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    keychain(deps, inOrder(FOUND), inOrder(ITEM));
    const { ui, saved, progress } = testUi({ verify: async () => "denied" });

    expect(await connectLocal(deps, CLAUDE, ui)).toEqual({
      kind: "failed",
      title: "macOS denied access to Claude Code's login",
      message: "Choose Connect again and click Always Allow",
    });
    expect(saved).toEqual([{ claudeKeychain: true }, { claudeKeychain: false }]);
    expect(terminalScript(deps)).toBeUndefined();
    expect(progress).not.toHaveBeenCalledWith("Finish signing in in Terminal", expect.anything());
  });

  it("signs in in Terminal when the Keychain has no login, then connects once one appears", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    keychain(deps, inOrder(MISSING), inOrder(MISSING, ITEM));
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const verify = vi.fn(async () => "ok" as const);
    const { ui, progress } = testUi({ verify });

    expect(await connectLocal(deps, CLAUDE, ui)).toEqual({ kind: "connected" });
    // With no login before the sign-in there is nothing to verify.
    expect(verify).not.toHaveBeenCalled();
    expect(progress).toHaveBeenCalledWith(
      "Finish signing in in Terminal",
      "Paste the code in Terminal if Claude Code asks for it",
    );
    expect(terminalScript(deps)).toContain(`do script "'${CLAUDE_BIN}' 'auth' 'login'"`);
  });

  it("signs in without verifying when the item's date can't be read, since there is no marker to compare", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    keychain(deps, inOrder(FOUND), inOrder(failure("security: unexpected failure")));
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const verify = vi.fn(async () => "ok" as const);
    const clock = steppingClock(deps);

    expect(await connectLocal(deps, CLAUDE, testUi({ verify, sleep: clock.sleep }).ui)).toEqual({
      kind: "failed",
      title: "Claude Code sign-in didn't finish",
    });
    expect(verify).not.toHaveBeenCalled();
  });

  it("uses the credentials file as the login when the Keychain has no item", async () => {
    const deps = withTools(fakeDeps({ files: { [CLAUDE_CREDENTIALS]: "{}" } }), [CLAUDE_BIN]);
    deps.programs.push({ file: SECURITY, respond: MISSING });

    expect(await connectLocal(deps, CLAUDE, testUi().ui)).toEqual({ kind: "connected" });
    expect(deps.runCalls.map((call) => call.file)).toEqual([SECURITY, SECURITY]);
  });

  it("signs in again when verify rejects the credentials file, and connects once the file changes", async () => {
    const deps = withTools(fakeDeps({ files: { [CLAUDE_CREDENTIALS]: "{}" } }), [CLAUDE_BIN]);
    deps.programs.push({ file: SECURITY, respond: MISSING });
    deps.programs.push({
      file: OSASCRIPT,
      respond: () => {
        deps.files.set(CLAUDE_CREDENTIALS, RENEWED_JSON);
        return OK;
      },
    });

    expect(await connectLocal(deps, CLAUDE, testUi({ verify: async () => "broken" }).ui)).toEqual({
      kind: "connected",
    });
  });

  it("turns the Keychain setting back off when Claude Code isn't installed, so no Disconnect is shown", async () => {
    const deps = withTools(fakeDeps());
    deps.programs.push({ file: SECURITY, respond: MISSING });
    const { ui, progress, saved } = testUi();

    expect(await connectLocal(deps, CLAUDE, ui)).toEqual({
      kind: "failed",
      title: "Claude Code isn't installed",
      message: "Install Claude Code, then choose Connect again",
      help: { title: "Install Claude Code", url: "https://code.claude.com/docs/en/setup" },
    });
    expect(saved).toEqual([{ claudeKeychain: true }, { claudeKeychain: false }]);
    expect(progress).not.toHaveBeenCalledWith("Finish signing in in Terminal", expect.anything());
  });

  it("runs the CLI through env with CLAUDE_CONFIG_DIR, so the login is written to the folder the extension reads", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.env.CLAUDE_CONFIG_DIR = "/work/claude";
    deps.programs.push({ file: SECURITY, respond: MISSING });
    deps.programs.push({
      file: OSASCRIPT,
      respond: () => {
        deps.files.set("/work/claude/.credentials.json", "{}");
        return OK;
      },
    });

    expect(await connectLocal(deps, CLAUDE, testUi().ui)).toEqual({ kind: "connected" });
    expect(terminalScript(deps)).toContain(
      `do script "'/usr/bin/env' 'CLAUDE_CONFIG_DIR=/work/claude' '${CLAUDE_BIN}' 'auth' 'login'"`,
    );
  });

  it("says Raycast needs permission to control Terminal when macOS refuses it", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.programs.push({ file: SECURITY, respond: MISSING });
    deps.programs.push({ file: OSASCRIPT, respond: failure("Not authorized to send Apple events (-1743)") });

    expect(await connectLocal(deps, CLAUDE, testUi().ui)).toEqual({
      kind: "failed",
      title: "Couldn't open Terminal",
      message: `Raycast isn't allowed to control Terminal. ${AUTOMATION_HINT}`,
    });
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

  it("signs in in Terminal and connects once the credentials file appears", async () => {
    const deps = withTools(fakeDeps(), [CLAUDE_BIN]);
    deps.platform = "linux";
    deps.programs.push({
      file: OSASCRIPT,
      respond: () => {
        deps.files.set(CLAUDE_CREDENTIALS, "{}");
        return OK;
      },
    });

    expect(await connectLocal(deps, CLAUDE, testUi().ui)).toEqual({ kind: "connected" });
  });

  it("keeps polling while the credentials file still holds the login verify rejected", async () => {
    const deps = withTools(fakeDeps({ files: { [CLAUDE_CREDENTIALS]: "{}" } }), [CLAUDE_BIN]);
    deps.platform = "linux";
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const clock = steppingClock(deps);

    expect(await connectLocal(deps, CLAUDE, testUi({ verify: async () => "broken", sleep: clock.sleep }).ui)).toEqual({
      kind: "failed",
      title: "Claude Code sign-in didn't finish",
    });
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(POLL_TOTAL_MS);
  });

  it("connects once the credentials file changes after a rejected login", async () => {
    const deps = withTools(fakeDeps({ files: { [CLAUDE_CREDENTIALS]: "{}" } }), [CLAUDE_BIN]);
    deps.platform = "linux";
    deps.programs.push({
      file: OSASCRIPT,
      respond: () => {
        deps.files.set(CLAUDE_CREDENTIALS, RENEWED_JSON);
        return OK;
      },
    });

    expect(await connectLocal(deps, CLAUDE, testUi({ verify: async () => "broken" }).ui)).toEqual({
      kind: "connected",
    });
  });
});

describe("connectLocal for Codex", () => {
  it("connects without running anything when the saved login works", async () => {
    const deps = withTools(fakeDeps({ files: { [CODEX_AUTH]: "{}" } }), [CODEX_BIN]);
    const { ui, progress } = testUi();

    expect(await connectLocal(deps, CODEX, ui)).toEqual({ kind: "connected" });
    expect(deps.runCalls).toEqual([]);
    expect(progress).not.toHaveBeenCalled();
  });

  it("does not verify anything when there is no saved login", async () => {
    const deps = withTools(fakeDeps({ files: {} }), [CODEX_BIN]);
    deps.programs.push({
      file: OSASCRIPT,
      respond: () => {
        deps.files.set(CODEX_AUTH, "{}");
        return OK;
      },
    });
    const verify = vi.fn(async () => "ok" as const);

    expect(await connectLocal(deps, CODEX, testUi({ verify }).ui)).toEqual({ kind: "connected" });
    expect(verify).not.toHaveBeenCalled();
  });

  it("runs codex login in Terminal when verify rejects the login, and connects once auth.json changes", async () => {
    const deps = withTools(fakeDeps({ files: { [CODEX_AUTH]: "{}" } }), [CODEX_BIN]);
    deps.programs.push({
      file: OSASCRIPT,
      respond: () => {
        deps.files.set(CODEX_AUTH, '{"renewed":true}');
        return OK;
      },
    });
    const { ui, progress } = testUi({ verify: async () => "broken" });

    expect(await connectLocal(deps, CODEX, ui)).toEqual({ kind: "connected" });
    expect(progress).toHaveBeenCalledWith(
      "Finish signing in in Terminal",
      "Codex is waiting for its sign-in to finish",
    );
    expect(terminalScript(deps)).toContain(`do script "'${CODEX_BIN}' 'login'"`);
  });

  it("runs codex login through env with CODEX_HOME, so auth.json is written to the folder the extension reads", async () => {
    const deps = withTools(fakeDeps(), [CODEX_BIN]);
    deps.env.CODEX_HOME = "/work/codex";
    deps.programs.push({
      file: OSASCRIPT,
      respond: () => {
        deps.files.set("/work/codex/auth.json", "{}");
        return OK;
      },
    });

    expect(await connectLocal(deps, CODEX, testUi().ui)).toEqual({ kind: "connected" });
    expect(terminalScript(deps)).toContain(
      `do script "'/usr/bin/env' 'CODEX_HOME=/work/codex' '${CODEX_BIN}' 'login'"`,
    );
  });

  it("runs codex login in Terminal and connects once auth.json appears", async () => {
    const deps = withTools(fakeDeps(), [CODEX_BIN]);
    deps.programs.push({
      file: OSASCRIPT,
      respond: () => {
        deps.files.set(CODEX_AUTH, "{}");
        return OK;
      },
    });

    expect(await connectLocal(deps, CODEX, testUi().ui)).toEqual({ kind: "connected" });
  });

  it("asks for the Codex CLI to be installed when it isn't on the PATH", async () => {
    expect(await connectLocal(withTools(fakeDeps()), CODEX, testUi().ui)).toEqual({
      kind: "failed",
      title: "Codex CLI isn't installed",
      help: { title: "Install Codex CLI", url: "https://developers.openai.com/codex/cli" },
    });
  });

  it("reports when Terminal can't be opened, with osascript's exit code and no script", async () => {
    const deps = withTools(fakeDeps(), [CODEX_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: failure("syntax error near it") });

    expect(await connectLocal(deps, CODEX, testUi().ui)).toEqual({
      kind: "failed",
      title: "Couldn't open Terminal",
      message: "Couldn't open Terminal (osascript exit 1)",
    });
  });

  it("gives up after 10 minutes while auth.json still holds the rejected login", async () => {
    const deps = withTools(fakeDeps({ files: { [CODEX_AUTH]: "{}" } }), [CODEX_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const clock = steppingClock(deps);

    expect(await connectLocal(deps, CODEX, testUi({ verify: async () => "broken", sleep: clock.sleep }).ui)).toEqual({
      kind: "failed",
      title: "Codex sign-in didn't finish",
    });
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(POLL_TOTAL_MS);
    expect(clock.sleeps.every((ms) => ms === POLL_INTERVAL_MS)).toBe(true);
  });
});

describe("connectLocal for Gemini CLI", () => {
  it("connects without running anything when the saved login works", async () => {
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

  it("reports when Terminal can't be controlled", async () => {
    const deps = withTools(fakeDeps(), [GEMINI_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: failure("Not authorized to send Apple events (-1743)") });

    expect(await connectLocal(deps, GEMINI, testUi().ui)).toEqual({
      kind: "failed",
      title: "Couldn't open Terminal",
      message: `Raycast isn't allowed to control Terminal. ${AUTOMATION_HINT}`,
    });
  });

  it("runs gemini by its absolute path in Terminal and connects once its login is written", async () => {
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
    expect(terminalScript(deps)).toContain(`do script "'${GEMINI_BIN}'"`);
  });

  it("gives up after 10 minutes without a login, checking every 3 seconds", async () => {
    const deps = withTools(fakeDeps(), [GEMINI_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const clock = steppingClock(deps);

    expect(await connectLocal(deps, GEMINI, testUi({ sleep: clock.sleep }).ui)).toEqual({
      kind: "failed",
      title: "Gemini CLI sign-in didn't finish",
    });
    expect(clock.sleeps.reduce((total, ms) => total + ms, 0)).toBe(POLL_TOTAL_MS);
    expect(clock.sleeps.every((ms) => ms === POLL_INTERVAL_MS)).toBe(true);
  });

  it("runs Terminal again when verify rejects the saved login, and connects once the login is replaced", async () => {
    const deps = withTools(fakeDeps({ files: { [GEMINI_CREDENTIALS]: "{}" } }), [GEMINI_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const { ui } = testUi({
      verify: async () => "broken",
      sleep: async () => {
        deps.files.set(GEMINI_CREDENTIALS, '{"renewed":true}');
      },
    });

    expect(await connectLocal(deps, GEMINI, ui)).toEqual({ kind: "connected" });
    expect(terminalScript(deps)).toBeDefined();
  });
});

describe("connectLocal for Cursor", () => {
  it("clears a saved Cursor session cookie before it checks the app's login", async () => {
    const deps = fakeDeps();
    deps.sqliteResults.set(CURSOR_DB, CURSOR_TOKEN);
    const { ui, saved } = testUi({
      verify: async () => {
        expect(saved).toEqual([{ cursorCookie: "" }]);
        return "ok";
      },
    });

    expect(await connectLocal(deps, CURSOR, ui)).toEqual({ kind: "connected" });
    expect(saved).toEqual([{ cursorCookie: "" }]);
  });

  it("connects without opening Cursor when the app's login works", async () => {
    const deps = fakeDeps();
    deps.sqliteResults.set(CURSOR_DB, `${CURSOR_TOKEN}\n`);
    const { ui, progress } = testUi();

    expect(await connectLocal(deps, CURSOR, ui)).toEqual({ kind: "connected" });
    expect(deps.runCalls).toEqual([]);
    expect(progress).not.toHaveBeenCalled();
  });

  it("opens Cursor when verify rejects the app's login, and connects once its token changes", async () => {
    const deps = fakeDeps();
    deps.sqliteResults.set(CURSOR_DB, "eyJhbGciOiJub25lIn0.old.sig");
    deps.programs.push({ file: OPEN, respond: OK });
    const { ui } = testUi({
      verify: async () => "broken",
      sleep: async () => {
        deps.sqliteResults.set(CURSOR_DB, "eyJhbGciOiJub25lIn0.new.sig");
      },
    });

    expect(await connectLocal(deps, CURSOR, ui)).toEqual({ kind: "connected" });
    expect(deps.runCalls.some((call) => call.file === OPEN)).toBe(true);
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
        deps.sqliteResults.set(CURSOR_DB, CURSOR_TOKEN);
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

describe("connectLocal when Connect is closed during a sign-in", () => {
  it("stops waiting for Terminal, says the sign-in is still running there, and leaves it to finish", async () => {
    const deps = withTools(fakeDeps(), [CODEX_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const controller = new AbortController();

    expect(
      await connectLocal(
        deps,
        CODEX,
        testUi({
          signal: controller.signal,
          sleep: async () => controller.abort(),
        }).ui,
      ),
    ).toEqual({
      kind: "failed",
      title: "Connect stopped",
      message: "Finish signing in, then refresh",
    });
    expect(terminalScript(deps)).toBeDefined();
  });

  it("stops waiting for the Cursor app the same way", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: OPEN, respond: OK });
    const controller = new AbortController();

    expect(
      await connectLocal(deps, CURSOR, testUi({ signal: controller.signal, sleep: async () => controller.abort() }).ui),
    ).toEqual({
      kind: "failed",
      title: "Connect stopped",
      message: "Finish signing in, then refresh",
    });
  });

  it("does not open Terminal when the Connect is stopped during the check, such as by Disconnect", async () => {
    const deps = withTools(fakeDeps({ files: { [CODEX_AUTH]: "{}" } }), [CODEX_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const controller = new AbortController();

    expect(
      await connectLocal(
        deps,
        CODEX,
        testUi({
          signal: controller.signal,
          verify: async () => {
            controller.abort();
            return "broken";
          },
        }).ui,
      ),
    ).toEqual({
      kind: "failed",
      title: "Connect stopped",
      message: "Finish signing in, then refresh",
    });
    expect(terminalScript(deps)).toBeUndefined();
  });

  it("does not open Cursor when the Connect is stopped during the check", async () => {
    const deps = fakeDeps();
    deps.sqliteResults.set(CURSOR_DB, "eyJhbGciOiJub25lIn0.old.sig");
    deps.programs.push({ file: OPEN, respond: OK });
    const controller = new AbortController();

    await connectLocal(
      deps,
      CURSOR,
      testUi({
        signal: controller.signal,
        verify: async () => {
          controller.abort();
          return "broken";
        },
      }).ui,
    );
    expect(deps.runCalls.some((call) => call.file === OPEN)).toBe(false);
  });

  it("does not report a stop when the sign-in simply timed out", async () => {
    const deps = withTools(fakeDeps(), [CODEX_BIN]);
    deps.programs.push({ file: OSASCRIPT, respond: OK });
    const clock = steppingClock(deps);

    expect(await connectLocal(deps, CODEX, testUi({ sleep: clock.sleep }).ui)).toEqual({
      kind: "failed",
      title: "Codex sign-in didn't finish",
    });
  });
});

describe("loginCheckFromError", () => {
  it("is denied for the keychain-denied code, even though that error is an auth error", () => {
    expect(loginCheckFromError(new ProviderError("auth", "denied", undefined, undefined, "keychain-denied"))).toBe(
      "denied",
    );
  });

  it.each(["auth", "not-connected"] as const)(
    "is broken for a %s error, which is a rejected or missing login",
    (kind) => {
      expect(loginCheckFromError(new ProviderError(kind, "rejected"))).toBe("broken");
    },
  );

  it.each(["http", "parse"] as const)("is ok for a %s error, which says nothing about the login", (kind) => {
    expect(loginCheckFromError(new ProviderError(kind, "unreachable"))).toBe("ok");
  });

  it("is ok for an error that isn't a ProviderError, such as no network", () => {
    expect(loginCheckFromError(new TypeError("fetch failed"))).toBe("ok");
  });
});

describe("isConnectOverridden", () => {
  const apiKey = (field: "zaiApiKey" | "kimiApiKey"): ConnectMethod => ({
    kind: "api-key",
    field,
    keyUrl: "https://example.com/keys",
    keyPattern: /^.+$/,
    placeholder: "key",
  });

  it("hides Connect GitHub when a GitHub token is in the preferences", () => {
    expect(isConnectOverridden({ kind: "github" }, { githubToken: "ghp_pref" })).toBe(true);
    expect(isConnectOverridden({ kind: "github" }, { githubOAuthToken: "gho_saved" })).toBe(false);
  });

  it("hides Connect OpenRouter and its key form when an OpenRouter key is in the preferences", () => {
    expect(isConnectOverridden({ kind: "openrouter" }, { openrouterApiKey: "sk-or-pref" })).toBe(true);
    expect(isConnectOverridden({ kind: "openrouter" }, { openrouterApiKey: undefined })).toBe(false);
  });

  it("hides an API key Connect only for the key set in the preferences for that provider", () => {
    expect(isConnectOverridden(apiKey("zaiApiKey"), { zaiApiKey: "pref-key" })).toBe(true);
    expect(isConnectOverridden(apiKey("zaiApiKey"), { kimiApiKey: "other-key" })).toBe(false);
  });

  it("never hides the local sign-ins", () => {
    const preferences: Settings = { githubToken: "ghp_pref", openrouterApiKey: "sk-or-pref", claudeSessionKey: "sk" };

    expect(isConnectOverridden({ kind: "claude" }, preferences)).toBe(false);
    expect(isConnectOverridden({ kind: "codex" }, preferences)).toBe(false);
    expect(isConnectOverridden({ kind: "cursor" }, preferences)).toBe(false);
    expect(isConnectOverridden({ kind: "gemini" }, preferences)).toBe(false);
  });
});
