import { createRequire } from "node:module";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { checkBars, type DailyBar } from "./bars";

type Statement = { run(...p: unknown[]): unknown; get(...p: unknown[]): Record<string, unknown> | undefined; all(...p: unknown[]): Record<string, unknown>[] };
type DB = { exec(sql: string): void; prepare(sql: string): Statement; close(): void };
const { DatabaseSync } = createRequire(path.join(process.cwd(), "package.json"))("node:sqlite") as { DatabaseSync: new (file: string) => DB };

export type Instrument = {
  symbol: string;
  name: string;
  /** 비용 모델의 상품 분류와 같은 값을 쓴다. */
  instrumentClass: string;
  tickSize: number;
};

/**
 * 일봉 저장소. 같은 (symbol, date)는 덮어쓰되 변경 이력을 남긴다.
 * 수정계수가 소급 변경되면 과거 백테스트 결과가 달라지므로 datasetVersion으로 구분한다.
 */
export class BarStore {
  readonly db: DB;
  constructor(readonly file: string, readonly clock = Date.now) {
    mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS instruments(symbol TEXT PRIMARY KEY, name TEXT NOT NULL, instrument_class TEXT NOT NULL, tick_size REAL NOT NULL);
      CREATE TABLE IF NOT EXISTS bars(symbol TEXT NOT NULL, date TEXT NOT NULL, open REAL NOT NULL, high REAL NOT NULL,
        low REAL NOT NULL, close REAL NOT NULL, volume REAL NOT NULL, adjusted_close REAL NOT NULL, distribution REAL NOT NULL,
        dataset_version TEXT NOT NULL, ingested_at INTEGER NOT NULL, PRIMARY KEY(symbol, date));
      CREATE TABLE IF NOT EXISTS bar_revisions(id INTEGER PRIMARY KEY, symbol TEXT NOT NULL, date TEXT NOT NULL,
        field TEXT NOT NULL, previous REAL NOT NULL, next REAL NOT NULL, at INTEGER NOT NULL);`);
  }
  close() { this.db.close(); }

  putInstrument(i: Instrument) {
    this.db.prepare("INSERT OR REPLACE INTO instruments VALUES(?,?,?,?)").run(i.symbol, i.name, i.instrumentClass, i.tickSize);
  }
  getInstrument(symbol: string): Instrument | undefined {
    const r = this.db.prepare("SELECT * FROM instruments WHERE symbol=?").get(symbol);
    return r && { symbol: String(r.symbol), name: String(r.name), instrumentClass: String(r.instrument_class), tickSize: Number(r.tick_size) };
  }

  /**
   * 적재 전에 무결성을 검사하고, 통과한 경우에만 트랜잭션으로 쓴다.
   * 기존 값과 달라진 필드는 bar_revisions에 남겨 소급 변경을 추적한다.
   */
  ingest(bars: DailyBar[], datasetVersion: string) {
    if (!bars.length) return { written: 0, revisions: 0, issues: [] };
    const issues = checkBars(bars);
    if (issues.length) return { written: 0, revisions: 0, issues };
    const now = this.clock();
    let written = 0, revisions = 0;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const existing = this.db.prepare("SELECT * FROM bars WHERE symbol=?").all(bars[0].symbol);
      const byDate = new Map(existing.map(r => [String(r.date), r]));
      const insert = this.db.prepare("INSERT OR REPLACE INTO bars VALUES(?,?,?,?,?,?,?,?,?,?,?)");
      const revision = this.db.prepare("INSERT INTO bar_revisions(symbol,date,field,previous,next,at) VALUES(?,?,?,?,?,?)");
      for (const bar of bars) {
        const before = byDate.get(bar.date);
        if (before) {
          for (const [field, value] of [["open", bar.open], ["high", bar.high], ["low", bar.low], ["close", bar.close],
            ["adjusted_close", bar.adjustedClose], ["distribution", bar.distribution], ["volume", bar.volume]] as const) {
            const previous = Number(before[field]);
            if (previous !== value) { revision.run(bar.symbol, bar.date, field, previous, value, now); revisions++; }
          }
        }
        insert.run(bar.symbol, bar.date, bar.open, bar.high, bar.low, bar.close, bar.volume, bar.adjustedClose, bar.distribution, datasetVersion, now);
        written++;
      }
      this.db.exec("COMMIT");
    } catch (e) { this.db.exec("ROLLBACK"); throw e; }
    return { written, revisions, issues };
  }

  read(symbol: string, options: { from?: string; to?: string } = {}): DailyBar[] {
    const { from = "0000-00-00", to = "9999-99-99" } = options;
    return this.db.prepare("SELECT * FROM bars WHERE symbol=? AND date>=? AND date<=? ORDER BY date").all(symbol, from, to).map(r => ({
      symbol: String(r.symbol), date: String(r.date), open: Number(r.open), high: Number(r.high), low: Number(r.low),
      close: Number(r.close), volume: Number(r.volume), adjustedClose: Number(r.adjusted_close), distribution: Number(r.distribution),
    }));
  }
  revisions(symbol: string) {
    return this.db.prepare("SELECT * FROM bar_revisions WHERE symbol=? ORDER BY id").all(symbol);
  }
}
