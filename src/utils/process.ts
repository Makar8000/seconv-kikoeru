import { execFile } from "node:child_process";

export type RunResult = { code: number | null; signal: string | null; stdout: string; stderr: string };
export type RunOptions = { signal?: AbortSignal; cwd?: string; env?: NodeJS.ProcessEnv };

/**
 * Runs `exe` to completion and collects its output. A non-zero exit still resolves (the caller reads `code`); it
 * rejects when the program can't be started, or when `signal` aborts (the program is killed). `windowsHide` keeps
 * Windows from opening a console window for a console program started from this windowless app; stdin is closed and
 * stderr captured, as the packaged app has no console to inherit.
 */
export const run = (exe: string, args: string[], { signal, cwd, env }: RunOptions = {}) =>
  new Promise<RunResult>((resolve, reject) => {
    if (signal?.aborted) {
      return reject(new Error("Stopped"));
    }
    const child = execFile(exe, args, { windowsHide: true, signal, cwd, env, maxBuffer: Infinity, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error && typeof error.code !== "number") {
        return reject(new Error(signal?.aborted ? "Stopped" : `Could not run "${exe}".\n${error}`));
      }
      resolve({ code: child.exitCode, signal: child.signalCode, stdout, stderr });
    });
    child.stdin?.end();
  });
