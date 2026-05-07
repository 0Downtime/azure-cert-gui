#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const root = process.cwd();
const outputDir = path.join(root, ".runtime", "systemd-user");
const nodePath = process.execPath;
const hour = boundedInt(process.env.SYNC_HOUR, 7, 0, 23);
const minute = boundedInt(process.env.SYNC_MINUTE, 30, 0, 59);
const uiServiceName = process.env.SYSTEMD_UI_SERVICE ?? "azure-cert-gui.service";
const syncServiceName = process.env.SYSTEMD_SYNC_SERVICE ?? "azure-cert-gui-sync.service";
const syncTimerName = process.env.SYSTEMD_SYNC_TIMER ?? "azure-cert-gui-sync.timer";

await mkdir(outputDir, { recursive: true });

const envFile = path.join(root, ".runtime", "azure-cert-gui.env");
const tsxCli = path.join(root, "node_modules", "tsx", "dist", "cli.mjs");
const uiServicePath = path.join(outputDir, uiServiceName);
const syncServicePath = path.join(outputDir, syncServiceName);
const syncTimerPath = path.join(outputDir, syncTimerName);

await writeFile(
  uiServicePath,
  `[Unit]
Description=Azure Cert GUI
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdEscape(root)}
EnvironmentFile=-${systemdEscape(envFile)}
Environment=NODE_ENV=production
ExecStart=${systemdEscape(nodePath)} scripts/build-and-start.mjs
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`,
);

await writeFile(
  syncServicePath,
  `[Unit]
Description=Azure Cert GUI Azure metadata sync
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${systemdEscape(root)}
EnvironmentFile=-${systemdEscape(envFile)}
ExecStart=${systemdEscape(nodePath)} ${systemdEscape(tsxCli)} scripts/sync-azure.ts --verbose
`,
);

await writeFile(
  syncTimerPath,
  `[Unit]
Description=Run Azure Cert GUI Azure metadata sync daily

[Timer]
OnCalendar=*-*-* ${pad(hour)}:${pad(minute)}:00
Persistent=true
Unit=${syncServiceName}

[Install]
WantedBy=timers.target
`,
);

const userSystemdDir = path.join(os.homedir(), ".config", "systemd", "user");
process.stdout.write(`Wrote systemd user units:
  ${uiServicePath}
  ${syncServicePath}
  ${syncTimerPath}

Install and enable them with:
  mkdir -p ${shellQuote(userSystemdDir)}
  cp ${shellQuote(outputDir)}/*.service ${shellQuote(outputDir)}/*.timer ${shellQuote(userSystemdDir)}/
  systemctl --user daemon-reload
  systemctl --user enable --now ${uiServiceName}
  systemctl --user enable --now ${syncTimerName}

For headless Linux servers, keep user services alive after logout:
  sudo loginctl enable-linger ${shellQuote(os.userInfo().username)}
`);

function boundedInt(value, fallback, min, max) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function systemdEscape(value) {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}
