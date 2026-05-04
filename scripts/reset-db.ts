import { existsSync, rmSync } from "node:fs";
import { dbPath, migrate, openDatabase } from "../src/lib/db";

const path = dbPath();
for (const candidate of [path, `${path}-shm`, `${path}-wal`]) {
  if (existsSync(candidate)) rmSync(candidate);
}
migrate(openDatabase());
console.log(`Reset SQLite database: ${path}`);
