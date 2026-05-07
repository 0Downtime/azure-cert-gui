import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import { delimiter } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const DEFAULT_BUFFER_BYTES = 1024 * 1024 * 100;

export class AzureCliError extends Error {
  constructor(args: string[], stderr: string) {
    super(`az ${args.join(" ")} failed: ${stderr.trim() || "no stderr"}`);
    this.name = "AzureCliError";
  }
}

export function azureCliCandidates(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  return uniqueStrings([
    env.AZURE_CLI_PATH,
    platform === "win32" ? "az.cmd" : null,
    "az",
    platform === "win32" ? "C:\\Program Files (x86)\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd" : null,
    platform === "win32" ? "C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2\\wbin\\az.cmd" : null,
    platform === "darwin" ? "/opt/homebrew/bin/az" : null,
    platform === "darwin" ? "/usr/local/bin/az" : null,
    platform !== "win32" ? "/usr/bin/az" : null,
    platform !== "win32" ? "/usr/local/bin/az" : null
  ]);
}

export async function execAzureCliJson<T>(
  args: string[],
  options: { maxBuffer?: number } = {}
): Promise<T> {
  const stdout = await execAzureCliText([...args, "--only-show-errors", "-o", "json"], options);
  return JSON.parse(stdout || "null") as T;
}

export async function execAzureCliText(
  args: string[],
  options: { maxBuffer?: number } = {}
): Promise<string> {
  const candidates = azureCliCandidates();
  let lastError: unknown = null;

  for (const candidate of candidates) {
    if (!(await canAttempt(candidate))) {
      continue;
    }

    try {
      const { stdout } = await execFileAsync(candidate, args, {
        maxBuffer: options.maxBuffer ?? DEFAULT_BUFFER_BYTES,
        env: process.env
      });
      return stdout;
    } catch (error) {
      if (isMissingCommand(error)) {
        lastError = error;
        continue;
      }
      const stderr =
        error && typeof error === "object" && "stderr" in error ? String(error.stderr) : String(error);
      throw new AzureCliError(args, stderr);
    }
  }

  throw new AzureCliError(args, cliNotFoundMessage(candidates, lastError));
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!value) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

async function canAttempt(candidate: string): Promise<boolean> {
  if (!candidate.includes("/") && !candidate.includes("\\") && !candidate.includes(delimiter)) {
    return true;
  }
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

function isMissingCommand(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}

function cliNotFoundMessage(candidates: string[], lastError: unknown): string {
  const suffix = lastError instanceof Error && lastError.message ? ` Last error: ${lastError.message}` : "";
  return `Azure CLI was not found. Set AZURE_CLI_PATH or install Azure CLI. Tried: ${candidates.join(", ")}.${suffix}`;
}
