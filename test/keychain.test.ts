import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { claudeKeychainService, readKeychainItemDate, readKeychainPassword } from "../src/lib/keychain";
import { fakeDeps, HOME } from "./fake-deps";

const SECURITY = "/usr/bin/security";
const DEFAULT_SERVICE = "Claude Code-credentials";
const READ_ARGS = ["find-generic-password", "-s", DEFAULT_SERVICE, "-w"];
const DATE_ARGS = ["find-generic-password", "-s", DEFAULT_SERVICE];
const LOGIN_JSON = '{"claudeAiOauth":{"accessToken":"oauth-token-123"}}';

describe("claudeKeychainService", () => {
  it("uses the plain name for the default folder, with or without a trailing slash", () => {
    expect(claudeKeychainService(undefined, HOME)).toBe(DEFAULT_SERVICE);
    expect(claudeKeychainService(`${HOME}/.claude`, HOME)).toBe(DEFAULT_SERVICE);
    expect(claudeKeychainService(`${HOME}/.claude/`, HOME)).toBe(DEFAULT_SERVICE);
  });

  it("treats an empty CLAUDE_CONFIG_DIR as the default folder", () => {
    expect(claudeKeychainService("", HOME)).toBe(DEFAULT_SERVICE);
  });

  it("adds the first 8 hex characters of the SHA-256 of the path for any other folder", () => {
    const hash = createHash("sha256").update("/Volumes/work/claude").digest("hex").slice(0, 8);

    expect(claudeKeychainService("/Volumes/work/claude", HOME)).toBe(`${DEFAULT_SERVICE}-${hash}`);
  });
});

describe("readKeychainPassword", () => {
  it("reads the password with security, with a long timeout, and trims the trailing newline", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: SECURITY, respond: { exitCode: 0, stdout: `${LOGIN_JSON}\n`, stderr: "" } });

    const read = await readKeychainPassword(deps, DEFAULT_SERVICE);

    expect(read).toEqual({ kind: "found", text: LOGIN_JSON });
    expect(deps.runCalls).toEqual([{ file: SECURITY, args: READ_ARGS, options: { timeoutMs: 60_000 } }]);
  });

  it("returns unsupported without running anything when the platform is not macOS", async () => {
    const deps = fakeDeps();
    deps.platform = "linux";

    await expect(readKeychainPassword(deps, DEFAULT_SERVICE)).resolves.toEqual({ kind: "unsupported" });
    expect(deps.runCalls).toEqual([]);
  });

  it("reports a missing item for exit code 44", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: SECURITY, respond: { exitCode: 44, stdout: "", stderr: "not found" } });

    await expect(readKeychainPassword(deps, DEFAULT_SERVICE)).resolves.toEqual({ kind: "missing" });
  });

  it.each([
    ["the user cancels the dialog", 128],
    ["the Keychain is locked", 36],
    ["security reports any other failure", 1],
  ])("reports denied when %s", async (_, exitCode) => {
    const deps = fakeDeps();
    deps.programs.push({ file: SECURITY, respond: { exitCode, stdout: "", stderr: "" } });

    await expect(readKeychainPassword(deps, DEFAULT_SERVICE)).resolves.toEqual({ kind: "denied" });
  });

  it("reports denied when security can't be run or times out", async () => {
    const deps = fakeDeps();
    deps.programs.push({
      file: SECURITY,
      respond: () => {
        throw new Error("security timed out");
      },
    });

    await expect(readKeychainPassword(deps, DEFAULT_SERVICE)).resolves.toEqual({ kind: "denied" });
  });

  it.each([
    ["hex of the login JSON", Buffer.from(LOGIN_JSON).toString("hex") + "\n", LOGIN_JSON],
    ["upper-case hex of the login JSON", Buffer.from(LOGIN_JSON).toString("hex").toUpperCase() + "\n", LOGIN_JSON],
    ["hex that doesn't decode to JSON", "abcd\n", "abcd"],
    ["text with an odd number of hex digits", "abc\n", "abc"],
    ["text that isn't hex", "not hex\n", "not hex"],
  ])("returns %s as the password text", async (_, stdout, text) => {
    const deps = fakeDeps();
    deps.programs.push({ file: SECURITY, respond: { exitCode: 0, stdout, stderr: "" } });

    await expect(readKeychainPassword(deps, DEFAULT_SERVICE)).resolves.toEqual({ kind: "found", text });
  });
});

// What `security find-generic-password` prints for an item without -w. The attributes are printed, not the password.
const ITEM_ATTRIBUTES = [
  'keychain: "/Users/me/Library/Keychains/login.keychain-db"',
  "version: 512",
  'class: "genp"',
  "attributes:",
  '    0x00000007 <blob>="Claude Code-credentials"',
  '    "acct"<blob>="me"',
  '    "cdat"<timedate>=0x32303236303130313130303030305A00  "20260101100000Z\\000"',
  '    "mdat"<timedate>=0x32303236313031343132303030305A00  "20261014120000Z\\000"',
  '    "svce"<blob>="Claude Code-credentials"',
  "",
].join("\n");

describe("readKeychainItemDate", () => {
  it("reads the modified date from the attributes, without -w, so macOS doesn't show the access dialog", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: SECURITY, respond: { exitCode: 0, stdout: ITEM_ATTRIBUTES, stderr: "" } });

    expect(await readKeychainItemDate(deps, DEFAULT_SERVICE)).toEqual({
      kind: "found",
      modified: "20261014120000Z\\000",
    });
    expect(deps.runCalls).toEqual([{ file: SECURITY, args: DATE_ARGS, options: undefined }]);
  });

  it("uses the hex of the date when security prints no quoted text after it", async () => {
    const deps = fakeDeps();
    const stdout = ITEM_ATTRIBUTES.replace(/ {2}"20261014120000Z\\000"/, "");
    deps.programs.push({ file: SECURITY, respond: { exitCode: 0, stdout, stderr: "" } });

    expect(await readKeychainItemDate(deps, DEFAULT_SERVICE)).toEqual({
      kind: "found",
      modified: "32303236313031343132303030305A00",
    });
  });

  it("reports a missing item for exit code 44", async () => {
    const deps = fakeDeps();
    deps.programs.push({ file: SECURITY, respond: { exitCode: 44, stdout: "", stderr: "not found" } });

    await expect(readKeychainItemDate(deps, DEFAULT_SERVICE)).resolves.toEqual({ kind: "missing" });
  });

  it.each([
    ["security reports another failure", 1],
    ["the Keychain is locked", 36],
    ["the output has no modified date", 0],
  ])("reports an error when %s", async (_, exitCode) => {
    const deps = fakeDeps();
    deps.programs.push({
      file: SECURITY,
      respond: { exitCode, stdout: exitCode === 0 ? "attributes:\n" : "", stderr: "" },
    });

    await expect(readKeychainItemDate(deps, DEFAULT_SERVICE)).resolves.toEqual({ kind: "error" });
  });

  it("reports an error when security can't be run", async () => {
    const deps = fakeDeps();
    deps.programs.push({
      file: SECURITY,
      respond: () => {
        throw new Error("security timed out");
      },
    });

    await expect(readKeychainItemDate(deps, DEFAULT_SERVICE)).resolves.toEqual({ kind: "error" });
  });

  it("returns unsupported without running anything when the platform is not macOS", async () => {
    const deps = fakeDeps();
    deps.platform = "linux";

    await expect(readKeychainItemDate(deps, DEFAULT_SERVICE)).resolves.toEqual({ kind: "unsupported" });
    expect(deps.runCalls).toEqual([]);
  });
});
