import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
type Statement = { run(...p: unknown[]): unknown; get(...p: unknown[]): Record<string, unknown> | undefined; all(...p: unknown[]): Record<string, unknown>[] };
type DB = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
const { DatabaseSync } = createRequire(path.join(process.cwd(), "package.json"))("node:sqlite") as { DatabaseSync: new (file: string) => DB };
export class RangeStore {
  readonly db: DB;
  readonly owner = randomUUID();
  constructor(readonly file: string, readonly clock = Date.now) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS kv(key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS quotes(at INTEGER PRIMARY KEY, bid REAL, ask REAL, bid_size INTEGER, ask_size INTEGER);
      CREATE TABLE IF NOT EXISTS quote_source_times(at INTEGER PRIMARY KEY, symbol TEXT NOT NULL, provider_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS lease(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires INTEGER);`);
  }
  claim() {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db.prepare("SELECT * FROM lease WHERE id=1").get();
      if (row && Number(row.expires) > this.clock()) throw new Error("Another range runner owns this database");
      this.db.prepare("INSERT OR REPLACE INTO lease VALUES(1,?,?)").run(this.owner, this.clock() + 60_000);
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  assertOwner() {
    const row = this.db.prepare("SELECT * FROM lease WHERE id=1").get();
    if (!row || row.owner !== this.owner || Number(row.expires) <= this.clock()) throw new Error("Range runner lease lost");
  }
  heartbeat() { this.assertOwner(); this.db.prepare("UPDATE lease SET expires=? WHERE owner=?").run(this.clock() + 60_000, this.owner); }
  get<T>(key: string): T | undefined { const row = this.db.prepare("SELECT value FROM kv WHERE key=?").get(key); return row ? JSON.parse(String(row.value)) : undefined; }
  save(key: string, value: unknown) { this.assertOwner(); this.db.prepare("INSERT OR REPLACE INTO kv VALUES(?,?)").run(key, JSON.stringify(value)); }
  event(kind: string, payload: unknown) { this.assertOwner(); this.db.prepare("INSERT INTO events(at,kind,payload) VALUES(?,?,?)").run(this.clock(), kind, JSON.stringify(payload)); }
  backup(date: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("Invalid backup date");
    if (this.get(`backup:${date}`)) return;
    const target = `${this.file}.${date}.bak`;
    this.db.prepare("VACUUM INTO ?").run(target);
    this.save(`backup:${date}`, target);
  }
  close() { this.db.prepare("DELETE FROM lease WHERE owner=?").run(this.owner); this.db.close(); }
}
