const label = process.env.LAUNCHAGENT_LABEL ?? "com.local.azure-cert-gui.sync";
const hour = boundedInt(process.env.SYNC_HOUR, 7, 0, 23);
const minute = boundedInt(process.env.SYNC_MINUTE, 30, 0, 59);
const cwd = process.cwd();
const command = [
  `cd ${shellQuote(cwd)}`,
  "mkdir -p logs",
  "npm run db:migrate",
  "npm run sync:azure -- --verbose"
].join(" && ");

process.stdout.write(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(label)}</string>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(cwd)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-lc</string>
    <string>${xmlEscape(command)}</string>
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${hour}</integer>
    <key>Minute</key>
    <integer>${minute}</integer>
  </dict>
  <key>StandardOutPath</key>
  <string>${xmlEscape(`${cwd}/logs/scheduled-sync.out.log`)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(`${cwd}/logs/scheduled-sync.err.log`)}</string>
</dict>
</plist>
`);

function boundedInt(value: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
