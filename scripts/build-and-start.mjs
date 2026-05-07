#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { access, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import path from "node:path";

const root = process.cwd();
const runtimePowerShellEnvPath = path.join(root, ".runtime", "azure-cert-gui.env.ps1");
const runtimeEnvPath = path.join(root, ".runtime", "azure-cert-gui.env");
const cachePath = path.join(root, ".next", "azure-cert-gui-build-cache.json");
const buildIdPath = path.join(root, ".next", "BUILD_ID");
const inputPaths = [
  "package.json",
  "package-lock.json",
  "next.config.mjs",
  "tsconfig.json",
  "next-env.d.ts",
  "src",
  "public",
];

loadRuntimeEnvFile();

const nextCliPath = path.join(root, "node_modules", "next", "dist", "bin", "next");
const host = process.env.UI_HOST ?? "127.0.0.1";
const requestedPort = parsePort(process.env.PORT ?? "3000");

async function main() {
  await ensureDependencies();

  const buildHash = await hashBuildInputs();
  const cache = await readJson(cachePath);
  const hasProductionBuild = await exists(buildIdPath);

  if (cache?.buildHash === buildHash && hasProductionBuild) {
    console.log(`[ui] Build is current (${buildHash.slice(0, 12)}); skipping npm run build.`);
  } else {
    console.log("[ui] Build is missing or stale; running next build.");
    await run(process.execPath, [nextCliPath, "build"]);
    await mkdir(path.dirname(cachePath), { recursive: true });
    await writeFile(
      cachePath,
      `${JSON.stringify({ buildHash, builtAt: new Date().toISOString() }, null, 2)}\n`,
    );
  }

  const port = await findAvailablePort(requestedPort, host);
  const url = `http://${host}:${port}`;

  if (port !== requestedPort) {
    console.log(`[ui] Port ${requestedPort} is busy; using ${port}.`);
  }

  console.log(`[ui] Open ${url}`);
  console.log("[ui] Press Ctrl+C to stop the UI.");

  await run(process.execPath, [nextCliPath, "start", "-p", String(port), "-H", host], {
    PORT: String(port),
  });
}

function parsePort(value) {
  const port = Number.parseInt(value, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${value}`);
  }
  return port;
}

function loadRuntimeEnvFile() {
  let loaded = 0;

  if (existsSync(runtimeEnvPath)) {
    loaded += loadDotEnvFile(runtimeEnvPath);
  }
  if (existsSync(runtimePowerShellEnvPath)) {
    loaded += loadPowerShellEnvFile(runtimePowerShellEnvPath);
  }

  if (loaded > 0) {
    console.log("[ui] Loaded runtime environment from .runtime.");
  }
}

function loadPowerShellEnvFile(absolutePath) {
  const content = readFileSync(absolutePath, "utf8");
  let loaded = 0;
  for (const line of content.split(/\r?\n/)) {
    const singleQuoted = line.match(/^\s*\$env:([A-Za-z0-9_]+)\s*=\s*'(.*)'\s*$/);
    const doubleQuoted = line.match(/^\s*\$env:([A-Za-z0-9_]+)\s*=\s*"(.*)"\s*$/);
    const match = singleQuoted ?? doubleQuoted;
    if (!match) {
      continue;
    }

    const [, name, rawValue] = match;
    if (process.env[name] !== undefined) {
      continue;
    }

    process.env[name] = singleQuoted ? rawValue.replaceAll("''", "'") : rawValue.replaceAll('`"', '"');
    loaded += 1;
  }
  return loaded;
}

function loadDotEnvFile(absolutePath) {
  const content = readFileSync(absolutePath, "utf8");
  let loaded = 0;
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!match) continue;
    const [, name, rawValue] = match;
    if (process.env[name] !== undefined) continue;
    process.env[name] = parseEnvValue(rawValue);
    loaded += 1;
  }
  return loaded;
}

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).replaceAll("\\$", "$").replaceAll('\\"', '"').replaceAll("\\`", "`").replaceAll("\\\\", "\\");
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function ensureDependencies() {
  if (!(await exists(nextCliPath))) {
    throw new Error("Dependencies are missing. Run npm install first, then run npm run ui.");
  }
}

async function hashBuildInputs() {
  const hash = createHash("sha256");
  const files = [];

  for (const inputPath of inputPaths) {
    const absolutePath = path.join(root, inputPath);
    if (!(await exists(absolutePath))) {
      continue;
    }
    await collectFiles(absolutePath, files);
  }

  files.sort();

  for (const file of files) {
    const relativePath = path.relative(root, file);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(await readFile(file));
    hash.update("\0");
  }

  return hash.digest("hex");
}

async function collectFiles(absolutePath, files) {
  const fileStat = await stat(absolutePath);
  if (fileStat.isFile()) {
    files.push(absolutePath);
    return;
  }

  if (!fileStat.isDirectory()) {
    return;
  }

  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(absolutePath, entry.name);
    if (entry.isDirectory()) {
      await collectFiles(entryPath, files);
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
}

async function findAvailablePort(startPort, listenHost) {
  for (let port = startPort; port <= 65535; port += 1) {
    if (await isPortAvailable(port, listenHost)) {
      return port;
    }
  }
  throw new Error(`No available port found at or above ${startPort}.`);
}

function isPortAvailable(port, listenHost) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();

    server.once("error", (error) => {
      if (error.code === "EADDRINUSE" || error.code === "EACCES") {
        resolve(false);
        return;
      }
      reject(error);
    });

    server.once("listening", () => {
      server.close(() => resolve(true));
    });

    server.listen(port, listenHost);
  });
}

function run(command, args, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: root,
      env: { ...process.env, ...extraEnv },
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      if (signal) {
        reject(new Error(`${command} ${args.join(" ")} stopped with signal ${signal}.`));
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with code ${code}.`));
    });
  });
}

async function exists(absolutePath) {
  try {
    await access(absolutePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(absolutePath) {
  try {
    return JSON.parse(await readFile(absolutePath, "utf8"));
  } catch {
    return null;
  }
}

main().catch((error) => {
  console.error(`[ui] ${error.message}`);
  process.exit(1);
});
