/// <reference types="node" />
import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// Raycast runs with a minimal PATH, so the system binary is referenced by absolute path.
const SQLITE3 = "/usr/bin/sqlite3";

// Everything a provider touches outside its own code. Commands use realDeps(); tests pass fakes, so no test reads real
// files, runs a real binary or makes a network request.
export interface Deps {
  fetch: typeof fetch;
  // The file's text, or null when it doesn't exist. Other read errors throw.
  readFile(path: string): Promise<string | null>;
  // The names of the entries in a directory, or null when it doesn't exist. Other read errors throw.
  listDir(path: string): Promise<string[] | null>;
  // Runs a read-only query with /usr/bin/sqlite3 and returns its stdout. Throws when the database can't be opened.
  sqlite(dbPath: string, sql: string): Promise<string>;
  homedir: string;
  env: Record<string, string | undefined>;
  now(): number;
}

export function realDeps(): Deps {
  return {
    fetch: (input, init) => fetch(input, init),
    readFile: async (path) => {
      try {
        return await readFile(path, "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return null;
        }
        throw error;
      }
    },
    listDir: async (path) => {
      try {
        return await readdir(path);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") {
          return null;
        }
        throw error;
      }
    },
    sqlite: async (dbPath, sql) => {
      const { stdout } = await execFileAsync(SQLITE3, ["-readonly", dbPath, sql], { timeout: 10_000 });
      return stdout;
    },
    homedir: os.homedir(),
    env: process.env,
    now: () => Date.now(),
  };
}
