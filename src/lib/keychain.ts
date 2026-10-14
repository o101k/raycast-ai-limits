import { createHash } from "node:crypto";
import { Deps, RunResult } from "./deps";

// On macOS Claude Code keeps its login in a generic-password Keychain item instead of the credentials file. The tool is
// referenced by absolute path, because Raycast runs with a minimal PATH.
const SECURITY = "/usr/bin/security";
const DEFAULT_SERVICE = "Claude Code-credentials";
// `security` exits with 44 (errSecItemNotFound) when no item has the service name.
const ITEM_NOT_FOUND = 44;
// macOS can show an "allow access" dialog before it answers, and the user may take a while to click, so this waits
// longer than the default timeout.
const READ_TIMEOUT_MS = 60_000;

export type KeychainRead =
  // The item's password as text.
  | { kind: "found"; text: string }
  // No item has this service name.
  | { kind: "missing" }
  // The user clicked Deny or Cancel, or the Keychain is locked or can't be read.
  | { kind: "denied" }
  // Not macOS, so there is no Keychain to read.
  | { kind: "unsupported" };

// The name of the Keychain item Claude Code uses for a config folder. The default folder keeps the plain name. Any other
// folder gets a suffix from a short hash of its path, so each folder has its own login. An empty CLAUDE_CONFIG_DIR counts
// as unset, as it does for the credentials file.
export function claudeKeychainService(configDir: string | undefined, homedir: string): string {
  if (!configDir || configDir.replace(/\/+$/, "") === `${homedir}/.claude`) {
    return DEFAULT_SERVICE;
  }
  const hash = createHash("sha256").update(configDir).digest("hex").slice(0, 8);
  return `${DEFAULT_SERVICE}-${hash}`;
}

// Reads the password of a generic-password item. Only exit code 0 and 44 are answers about the item. Any other exit code
// is a refused or cancelled access dialog, so it counts as denied.
export async function readKeychainPassword(deps: Deps, service: string): Promise<KeychainRead> {
  if (deps.platform !== "darwin") {
    return { kind: "unsupported" };
  }

  let result: RunResult;
  try {
    result = await deps.run(SECURITY, ["find-generic-password", "-s", service, "-w"], { timeoutMs: READ_TIMEOUT_MS });
  } catch {
    // The tool couldn't start, or it ran past the timeout, which is what an unanswered dialog looks like.
    return { kind: "denied" };
  }
  if (result.exitCode === 0) {
    return { kind: "found", text: decodePassword(result.stdout.trim()) };
  }
  if (result.exitCode === ITEM_NOT_FOUND) {
    return { kind: "missing" };
  }
  return { kind: "denied" };
}

// `security -w` prints the password as hex when it has newlines or other non-printable characters. Hex is decoded only
// when the result is the credentials JSON, so any other text that happens to be hex is returned unchanged.
function decodePassword(output: string): string {
  if (output.length % 2 !== 0 || !/^[0-9a-fA-F]+$/.test(output)) {
    return output;
  }
  const decoded = Buffer.from(output, "hex").toString("utf8");
  return decoded.startsWith("{") ? decoded : output;
}
