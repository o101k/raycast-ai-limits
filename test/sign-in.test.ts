import { describe, expect, it } from "vitest";
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
  runSignIn,
  waitFor,
} from "../src/lib/sign-in";
import { TOKEN_QUERY } from "../src/lib/providers/cursor";
import { fakeDeps, HOME } from "./fake-deps";

// The PATH segments added after whatever the login shell (or the fallback) provided, in the order they are appended.
const APPENDED = `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`;
const DONE = { exitCode: 0, stdout: "", stderr: "" };

describe("resolveUserPath", () => {
  it("takes the PATH between the markers, so a banner printed before it is ignored", async () => {
    const deps = fakeDeps();
    deps.programs.push({
      file: "/bin/zsh",
      respond: { exitCode: 0, stdout: "Welcome back!\n__AI_LIMITS__/opt/x/bin:/usr/bin__AI_LIMITS__\n", stderr: "" },
    });

    expect(await resolveUserPath(deps)).toBe(
      `/opt/x/bin:/usr/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/bin`,
    );
  });

  it("asks the default shell for its PATH with an interactive login command and a 5 second timeout", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: "/bin/zsh", respond: DONE });

    await resolveUserPath(deps);

    expect(deps.runCalls).toEqual([
      {
        file: "/bin/zsh",
        args: ["-ilc", 'printf "__AI_LIMITS__%s__AI_LIMITS__" "$PATH"'],
        options: { timeoutMs: 5_000 },
      },
    ]);
  });

  it("runs the shell from SHELL when it is an absolute path to bash, zsh, fish or sh", async () => {
    for (const shell of ["/bin/bash", "/usr/local/bin/fish", "/bin/sh"]) {
      const deps = fakeDeps();
      deps.env.SHELL = shell;
      deps.programs.push({ file: shell, respond: DONE });

      await resolveUserPath(deps);

      expect(deps.runCalls[0].file).toBe(shell);
    }
  });

  it("uses zsh when SHELL is another shell, or a relative path", async () => {
    for (const shell of ["/bin/tcsh", "zsh", "/usr/bin/notsh"]) {
      const deps = fakeDeps();
      deps.env.SHELL = shell;
      deps.programs.push({ file: "/bin/zsh", respond: DONE });

      await resolveUserPath(deps);

      expect(deps.runCalls[0].file).toBe("/bin/zsh");
    }
  });

  it("joins fish's PATH list with colons, since fish's \"$PATH\" would join it with spaces", async () => {
    const deps = fakeDeps();
    deps.env.SHELL = "/usr/local/bin/fish";
    deps.programs.push({
      file: "/usr/local/bin/fish",
      respond: { exitCode: 0, stdout: "__AI_LIMITS__/opt/x/bin:/usr/bin__AI_LIMITS__", stderr: "" },
    });

    const path = await resolveUserPath(deps);

    expect(deps.runCalls[0].args).toEqual(["-ilc", 'printf "__AI_LIMITS__%s__AI_LIMITS__" (string join : $PATH)']);
    expect(path).toBe(`/opt/x/bin:/usr/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/bin`);
  });

  it("falls back to the process PATH when the shell exits non-zero", async () => {
    const deps = fakeDeps();
    deps.env.PATH = "/custom/bin:/usr/bin";
    deps.programs.push({ file: "/bin/zsh", respond: { exitCode: 1, stdout: "", stderr: "boom" } });

    expect(await resolveUserPath(deps)).toBe(
      `/custom/bin:/usr/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/bin`,
    );
  });

  it("falls back to the process PATH when the shell can't be started", async () => {
    const deps = fakeDeps();
    deps.env.PATH = "/custom/bin:/usr/bin";

    expect(await resolveUserPath(deps)).toBe(
      `/custom/bin:/usr/bin:${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:/bin`,
    );
  });

  it("falls back to the process PATH when the output has no marker", async () => {
    const deps = fakeDeps();
    deps.env.PATH = "/custom/bin";
    deps.programs.push({ file: "/bin/zsh", respond: { exitCode: 0, stdout: "/opt/x/bin", stderr: "" } });

    expect(await resolveUserPath(deps)).toBe(`/custom/bin:${APPENDED}`);
  });

  it("appends the well-known directories, including ~/.local/bin, when the PATH lacks them", async () => {
    const deps = fakeDeps();
    deps.env.PATH = "/custom/bin";

    expect(await resolveUserPath(deps)).toBe(`/custom/bin:${APPENDED}`);
  });

  it("keeps each directory once, at its first position, and drops empty entries", async () => {
    const deps = fakeDeps();
    deps.programs.push({
      file: "/bin/zsh",
      respond: { exitCode: 0, stdout: "__AI_LIMITS__/usr/bin:/opt/homebrew/bin:/usr/bin::/a__AI_LIMITS__", stderr: "" },
    });

    expect(await resolveUserPath(deps)).toBe(`/usr/bin:/opt/homebrew/bin:/a:${HOME}/.local/bin:/usr/local/bin:/bin`);
  });
});

describe("findExecutable", () => {
  it("returns the first directory in the PATH that holds an executable of that name", async () => {
    const deps = fakeDeps();
    deps.executables.add("/usr/bin/codex");
    deps.executables.add("/opt/homebrew/bin/codex");

    expect(await findExecutable(deps, "codex", "/opt/homebrew/bin:/usr/bin")).toBe("/opt/homebrew/bin/codex");
  });

  it("skips a directory that has no executable of that name", async () => {
    const deps = fakeDeps();
    deps.executables.add("/usr/bin/codex");

    expect(await findExecutable(deps, "codex", "/opt/homebrew/bin:/usr/bin")).toBe("/usr/bin/codex");
  });

  it("ignores empty PATH entries rather than looking in the current directory", async () => {
    const deps = fakeDeps();
    deps.executables.add("/codex");
    deps.executables.add("/usr/bin/codex");

    expect(await findExecutable(deps, "codex", "::/usr/bin")).toBe("/usr/bin/codex");
  });

  it("returns undefined when no directory holds it", async () => {
    expect(await findExecutable(fakeDeps(), "codex", "/opt/homebrew/bin:/usr/bin")).toBeUndefined();
  });

  it("checks ~/.claude/local for claude after the PATH, for older Claude Code installs", async () => {
    const deps = fakeDeps();
    deps.executables.add(`${HOME}/.claude/local/claude`);

    expect(await findExecutable(deps, "claude", "/usr/bin")).toBe(`${HOME}/.claude/local/claude`);
  });

  it("prefers claude on the PATH over ~/.claude/local", async () => {
    const deps = fakeDeps();
    deps.executables.add(`${HOME}/.claude/local/claude`);
    deps.executables.add("/opt/homebrew/bin/claude");

    expect(await findExecutable(deps, "claude", "/opt/homebrew/bin")).toBe("/opt/homebrew/bin/claude");
  });

  it("checks ~/.claude/local only for claude", async () => {
    const deps = fakeDeps();
    deps.executables.add(`${HOME}/.claude/local/codex`);

    expect(await findExecutable(deps, "codex", "/usr/bin")).toBeUndefined();
  });
});

describe("runSignIn", () => {
  const COMMAND = { executable: "/opt/homebrew/bin/codex", args: ["login"] };

  it("resolves ok when the CLI exits 0", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: COMMAND.executable, respond: DONE });

    expect(await runSignIn(deps, COMMAND, "/usr/bin")).toEqual({ ok: true });
  });

  it("runs the CLI with its arguments, a 10 minute timeout, and PATH in a copy of the environment", async () => {
    const deps = fakeDeps();
    deps.env.HOME = HOME;
    deps.env.PATH = "/old/bin";
    deps.programs.push({ file: COMMAND.executable, respond: DONE });

    await runSignIn(deps, COMMAND, "/new/bin:/usr/bin");

    expect(deps.runCalls).toEqual([
      {
        file: COMMAND.executable,
        args: ["login"],
        options: { timeoutMs: 600_000, env: { HOME, PATH: "/new/bin:/usr/bin" } },
      },
    ]);
  });

  it("reports the last line of stderr when the CLI fails", async () => {
    const deps = fakeDeps();
    deps.programs.push({
      file: COMMAND.executable,
      respond: {
        exitCode: 1,
        stdout: "Opening browser\n",
        stderr: "Starting login\nError: the browser was closed\n\n",
      },
    });

    expect(await runSignIn(deps, COMMAND, "/usr/bin")).toEqual({
      ok: false,
      reason: "failed",
      message: "Error: the browser was closed",
    });
  });

  it("reports the last line of stdout when stderr is empty", async () => {
    const deps = fakeDeps();
    deps.programs.push({
      file: COMMAND.executable,
      respond: { exitCode: 1, stdout: "Waiting for login\nLogin was not completed\n", stderr: "" },
    });

    expect(await runSignIn(deps, COMMAND, "/usr/bin")).toMatchObject({ message: "Login was not completed" });
  });

  it("names the CLI and its exit code when it printed nothing", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: COMMAND.executable, respond: { exitCode: 2, stdout: "", stderr: "  \n" } });

    expect(await runSignIn(deps, COMMAND, "/usr/bin")).toEqual({
      ok: false,
      reason: "failed",
      message: "codex exited with code 2",
    });
  });

  it("trims a long message to 200 characters", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: COMMAND.executable, respond: { exitCode: 1, stdout: "", stderr: "x".repeat(300) } });

    const result = await runSignIn(deps, COMMAND, "/usr/bin");

    expect(result).toEqual({ ok: false, reason: "failed", message: "x".repeat(200) });
  });

  it("reports a run that rejects (timed out or killed) as cancelled", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: COMMAND.executable, respond: () => Promise.reject(new Error("killed")) });

    expect(await runSignIn(deps, COMMAND, "/usr/bin")).toEqual({
      ok: false,
      reason: "cancelled",
      message: "Sign-in timed out",
    });
  });

  it("passes the signal to the run, so the CLI is stopped when the command closes", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: COMMAND.executable, respond: DONE });
    const controller = new AbortController();

    await runSignIn(deps, COMMAND, "/usr/bin", controller.signal);

    expect(deps.runCalls[0].options?.signal).toBe(controller.signal);
  });

  it("reports a run stopped by the signal as cancelled by the user, not as a timeout", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: COMMAND.executable, respond: DONE });
    const controller = new AbortController();
    controller.abort();

    expect(await runSignIn(deps, COMMAND, "/usr/bin", controller.signal)).toEqual({
      ok: false,
      reason: "cancelled",
      message: "Sign-in was cancelled",
    });
  });
});

describe("CLI_SIGN_IN", () => {
  it("has the sign-in command for Claude and Codex", () => {
    expect(CLI_SIGN_IN.claude).toMatchObject({ name: "claude", args: ["auth", "login"] });
    expect(CLI_SIGN_IN.codex).toMatchObject({ name: "codex", args: ["login"] });
  });
});

describe("openInTerminal", () => {
  const script = (command: string) =>
    ['tell application "Terminal"', "activate", `do script "${command}"`, "end tell"].join("\n");

  it("opens Terminal and runs the command in it", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: "/usr/bin/osascript", respond: DONE });

    await openInTerminal(deps, "gemini");

    expect(deps.runCalls).toEqual([{ file: "/usr/bin/osascript", args: ["-e", script("gemini")] }]);
  });

  it("escapes double quotes and backslashes for AppleScript", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: "/usr/bin/osascript", respond: DONE });
    const command = String.raw`echo "hi" \ done`;

    await openInTerminal(deps, command);

    expect(deps.runCalls[0].args[1]).toBe(
      ['tell application "Terminal"', "activate", String.raw`do script "echo \"hi\" \\ done"`, "end tell"].join("\n"),
    );
  });

  it("throws osascript's error when Terminal can't be controlled", async () => {
    const deps = fakeDeps();
    deps.programs.push({
      file: "/usr/bin/osascript",
      respond: { exitCode: 1, stdout: "", stderr: "Not authorized to send Apple events (-1743)\n" },
    });

    await expect(openInTerminal(deps, "gemini")).rejects.toThrow("Not authorized to send Apple events (-1743)");
  });
});

describe("openApp", () => {
  it("launches the app by bundle id and returns true when open exits 0", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: "/usr/bin/open", respond: DONE });

    expect(await openApp(deps, CURSOR_BUNDLE_ID)).toBe(true);
    expect(deps.runCalls).toEqual([{ file: "/usr/bin/open", args: ["-b", CURSOR_BUNDLE_ID] }]);
  });

  it("returns false when open exits non-zero, as it does for an app that isn't installed", async () => {
    const deps = fakeDeps();
    deps.programs.push({
      file: "/usr/bin/open",
      respond: { exitCode: 1, stdout: "", stderr: "Unable to find application" },
    });

    expect(await openApp(deps, CURSOR_BUNDLE_ID)).toBe(false);
  });

  it("returns false when open can't be run", async () => {
    expect(await openApp(fakeDeps(), CURSOR_BUNDLE_ID)).toBe(false);
  });
});

// A clock that only moves when the code sleeps, so waitFor runs instantly and its timing can be checked exactly.
function fakeClock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    },
  };
}

describe("waitFor", () => {
  it("returns true as soon as the check passes, without waiting longer", async () => {
    const clock = fakeClock();
    let calls = 0;

    const found = await waitFor(
      async () => {
        calls += 1;
        return calls === 3;
      },
      { intervalMs: 100, timeoutMs: 1_000, ...clock },
    );

    expect(found).toBe(true);
    expect(calls).toBe(3);
    expect(clock.now()).toBe(200);
  });

  it("returns false when the timeout passes first, and the last wait stops at the deadline", async () => {
    const clock = fakeClock();
    let calls = 0;

    const found = await waitFor(
      async () => {
        calls += 1;
        return false;
      },
      { intervalMs: 100, timeoutMs: 350, ...clock },
    );

    expect(found).toBe(false);
    // Checks at 0, 100, 200, 300 and once more at the 350ms deadline.
    expect(calls).toBe(5);
    expect(clock.now()).toBe(350);
  });

  it("returns false as soon as the signal aborts, without checking again", async () => {
    const clock = fakeClock();
    const controller = new AbortController();
    let calls = 0;

    const found = await waitFor(
      async () => {
        calls += 1;
        return false;
      },
      {
        intervalMs: 100,
        timeoutMs: 1_000,
        now: clock.now,
        sleep: async (ms) => {
          await clock.sleep(ms);
          controller.abort();
        },
        signal: controller.signal,
      },
    );

    expect(found).toBe(false);
    expect(calls).toBe(1);
  });

  it("does not check at all when the signal has already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;

    const found = await waitFor(
      async () => {
        calls += 1;
        return true;
      },
      { intervalMs: 100, timeoutMs: 1_000, ...fakeClock(), signal: controller.signal },
    );

    expect(found).toBe(false);
    expect(calls).toBe(0);
  });

  it("counts a check that throws as not yet passed, and keeps polling", async () => {
    const clock = fakeClock();
    let calls = 0;

    const found = await waitFor(
      async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("not signed in yet");
        }
        return true;
      },
      { intervalMs: 100, timeoutMs: 1_000, ...clock },
    );

    expect(found).toBe(true);
    expect(calls).toBe(3);
  });

  it("returns false, without rejecting, when the check always throws", async () => {
    const found = await waitFor(
      async () => {
        throw new Error("sqlite is locked");
      },
      { intervalMs: 100, timeoutMs: 250, ...fakeClock() },
    );

    expect(found).toBe(false);
  });
});

describe("readCodexLogin", () => {
  it("returns the text of auth.json under ~/.codex", async () => {
    const deps = fakeDeps({ files: { [`${HOME}/.codex/auth.json`]: '{"tokens":{}}' } });

    expect(await readCodexLogin(deps)).toBe('{"tokens":{}}');
  });

  it("is null when there is no login file", async () => {
    expect(await readCodexLogin(fakeDeps())).toBeNull();
  });

  it("looks in CODEX_HOME instead of ~/.codex when it is set", async () => {
    const deps = fakeDeps({ files: { [`${HOME}/.codex/auth.json`]: "{}" } });
    deps.env.CODEX_HOME = "/Volumes/work/codex";

    expect(await readCodexLogin(deps)).toBeNull();

    deps.files.set("/Volumes/work/codex/auth.json", '{"work":true}');
    expect(await readCodexLogin(deps)).toBe('{"work":true}');
  });

  it("is null when the file can't be read", async () => {
    const deps = fakeDeps();
    deps.readFile = async () => {
      throw new Error("EACCES: permission denied");
    };

    expect(await readCodexLogin(deps)).toBeNull();
  });
});

describe("readGeminiLogin", () => {
  it("returns the text of oauth_creds.json", async () => {
    const deps = fakeDeps({ files: { [`${HOME}/.gemini/oauth_creds.json`]: '{"refresh_token":"r"}' } });

    expect(await readGeminiLogin(deps)).toBe('{"refresh_token":"r"}');
  });

  it("is null when there is no login file", async () => {
    expect(await readGeminiLogin(fakeDeps())).toBeNull();
  });
});

describe("readCursorLogin", () => {
  const DB_PATH = `${HOME}/Library/Application Support/Cursor/User/globalStorage/state.vscdb`;

  it("returns the access token from the app's state database, trimmed", async () => {
    const deps = fakeDeps();
    deps.sqliteResults.set(DB_PATH, "eyJhbGciOiJub25lIn0.e30.sig\n");

    expect(await readCursorLogin(deps)).toBe("eyJhbGciOiJub25lIn0.e30.sig");
    expect(deps.sqliteCalls).toEqual([{ dbPath: DB_PATH, sql: TOKEN_QUERY }]);
  });

  it("is null when the token is empty", async () => {
    const deps = fakeDeps();
    deps.sqliteResults.set(DB_PATH, "  \n");

    expect(await readCursorLogin(deps)).toBeNull();
  });

  it("is null when the database can't be opened, as when the app was never signed in", async () => {
    expect(await readCursorLogin(fakeDeps())).toBeNull();
  });
});
