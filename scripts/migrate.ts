import { migrate, openDatabase, dbPath } from "../src/lib/db";

const db = openDatabase();
migrate(db);
console.log(`Migrated SQLite database: ${dbPath()}`);
