// src/ledger/ledger.ts — append-only 请求账本（node:sqlite，WAL）。
// 设计口径（plan.md 第十节 S1 切片）：
//   - requests 表只存结构元数据，无任何正文列（正文零持久化，schema 层保证，而非靠自觉）；
//   - settlements 幂等：UNIQUE(request_id, attempt_no) + INSERT ... DO NOTHING，0 行受影响=重复结算不双记；
//   - token 必记但可 NULL（NULL 必带 token_source / token_missing_reason，禁止写 0 冒充缺失）；
//   - 冗余 channel_id/alias 列：聚合不 join requests，requests 插入失败不产生口径失真；
//   - error_source 三值（upstream|gateway|client）分离归因——渠道评分只消费 upstream，网关自身故障绝不冤枉渠道；
//   - 写失败 fail-open：绝不向调用方抛异常、绝不影响转发，只自增 degraded/writeErrors 计数（同步落库，绝无丢弃队列）。
// 本版 user_version=2：v1 旧库经 ALTER TABLE ADD COLUMN 幂等迁移（补 row_hash / ttft_contaminated），retention 仍后置。
// hash 链规则：row_hash = sha256(上一非 NULL row_hash + 当期列集合的规范 JSON（不含 row_hash 自身）)；
//   requests 与 settlements 两表各自成链；迁移前 legacy 行（row_hash IS NULL）不上链、也不切断链（链尾等价于最近非 NULL 行）。
// 写入原子化：recordRequest/settle 经 BEGIN IMMEDIATE 事务（读链尾 → 插入 → 回填 row_hash → 提交），失败回滚，不留半链行。
// canonical 固定为当期列集：未来版本加列必须同步演进校验规则（否则旧 hash 校验必断）。
// dbPath 为 ':memory:' 时为内存库（跳过 WAL PRAGMA，供单元测试用）。
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export type LedgerOrigin = 'user' | 'probe' | 'health';
export type LedgerClientStatus = 'ok' | 'truncated' | 'aborted' | 'timeout' | 'interrupted';
export type LedgerErrorSource = 'upstream' | 'gateway' | 'client';
export type LedgerTokenSource = 'usage' | 'none';
export type LedgerTokenMissingReason = 'absent' | 'missing' | 'negative' | 'inconsistent';

/** 请求元数据入账输入（id 缺省时由账本生成）；不包含任何正文内容字段。 */
export interface LedgerRequestInput {
  id?: string;
  ts_ms: number;
  origin: LedgerOrigin;
  channel_id: string;
  alias: string;
  model_upstream: string | null;
  req_bytes: number | null;
  has_tools: number | null;
  has_image: number | null;
  messages_count: number | null;
}

/** 结算入账输入（id 缺省时由账本生成；attempt_no 缺省 1）。token 缺失一律 null，绝不写 0。 */
export interface LedgerSettlementInput {
  id?: string;
  request_id: string;
  attempt_no?: number;
  ts_ms: number;
  channel_id: string;
  alias: string;
  upstream_status: number | null;
  client_status: LedgerClientStatus;
  error_source: LedgerErrorSource | null;
  error_class: string | null;
  finish_reason: string | null;
  ttft_upstream_ms: number | null;
  ttft_client_ms: number | null;
  /** 因事件循环滞后被剔除、不进分位的 TTFT 样本数；无样本（无 TTFT）为 null——NULL=无 TTFT 样本，绝不写 0 冒充。 */
  ttft_contaminated?: number | null;
  token_prompt: number | null;
  token_completion: number | null;
  token_cached: number | null;
  token_reasoning: number | null;
  token_source: LedgerTokenSource;
  token_missing_reason: LedgerTokenMissingReason | null;
  usage_valid: number;
  amount: number | null;
}

export interface LedgerStats {
  writeErrors: number;
  degraded: boolean;
  recovered: number;
}

/** 按 (channel_id, alias) 的聚合行：requests 来自请求表，ok/error/token SUM 来自结算表。 */
export interface LedgerUsageRow {
  channelId: string;
  alias: string;
  requests: number;
  ok: number;
  errors: number;
  tokenPrompt: number;
  tokenCompletion: number;
  tokenCached: number;
  tokenReasoning: number;
}

/** 结算行读取视图（排障 / 证据链下钻用；表内本无正文列，此处也不含）。 */
export interface LedgerSettlementRow {
  id: string;
  requestId: string;
  attemptNo: number;
  tsMs: number;
  channelId: string;
  alias: string;
  upstreamStatus: number | null;
  clientStatus: LedgerClientStatus | null;
  errorSource: LedgerErrorSource | null;
  errorClass: string | null;
  finishReason: string | null;
  ttftUpstreamMs: number | null;
  ttftClientMs: number | null;
  /** 1=因事件循环滞后剔除、不进分位；0=正常计入分位；null=无 TTFT 样本（绝不写 0 冒充）。 */
  ttftContaminated: number | null;
  tokenPrompt: number | null;
  tokenCompletion: number | null;
  tokenCached: number | null;
  tokenReasoning: number | null;
  tokenSource: LedgerTokenSource | null;
  tokenMissingReason: LedgerTokenMissingReason | null;
  usageValid: number | null;
  amount: number | null;
}

/** hash 链校验报告：ok=true 时 table 仅表示最后完成校验的表（两表各自成链、均通过），不代表唯一被校验的表。 */
export interface LedgerChainReport {
  ok: boolean;
  table: 'requests' | 'settlements';
  brokenAtId: string | null;
  checked: number;
  legacy: { requests: number; settlements: number };
}

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY,
  ts_ms INTEGER NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('user','probe','health')),
  channel_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  model_upstream TEXT,
  req_bytes INTEGER,
  has_tools INTEGER,
  has_image INTEGER,
  messages_count INTEGER,
  row_hash TEXT
);
CREATE TABLE IF NOT EXISTS settlements (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  attempt_no INTEGER NOT NULL DEFAULT 1,
  ts_ms INTEGER NOT NULL,
  channel_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  upstream_status INTEGER,
  client_status TEXT CHECK(client_status IN ('ok','truncated','aborted','timeout','interrupted')),
  error_source TEXT CHECK(error_source IN ('upstream','gateway','client')),
  error_class TEXT,
  finish_reason TEXT,
  ttft_upstream_ms REAL,
  ttft_client_ms REAL,
  ttft_contaminated INTEGER,
  token_prompt INTEGER,
  token_completion INTEGER,
  token_cached INTEGER,
  token_reasoning INTEGER,
  token_source TEXT CHECK(token_source IN ('usage','none')),
  token_missing_reason TEXT CHECK(token_missing_reason IN ('absent','missing','negative','inconsistent')),
  usage_valid INTEGER,
  amount INTEGER,
  row_hash TEXT,
  UNIQUE(request_id, attempt_no)
);
CREATE INDEX IF NOT EXISTS idx_requests_channel_alias ON requests(channel_id, alias);
CREATE INDEX IF NOT EXISTS idx_settlements_channel_alias ON settlements(channel_id, alias);
`;

/** 链起点：空链（或全部 legacy 行）时上一 hash 的约定值。 */
const CHAIN_GENESIS = '0'.repeat(64);

export class Ledger {
  private readonly db: DatabaseSync;
  private readonly memory: boolean;
  private writeErrors = 0;
  private degraded = false;
  private recovered = 0;
  private closed = false;

  constructor(dbPath: string) {
    this.memory = dbPath === ':memory:';
    this.db = new DatabaseSync(dbPath);
    try {
      if (!this.memory) {
        // 文件库：WAL + 折中耐久（本地观测账本，不为每次结算阻塞 fsync）；内存库跳过 WAL。
        this.db.exec('PRAGMA journal_mode = WAL');
        this.db.exec('PRAGMA synchronous = NORMAL');
      }
      this.db.exec('PRAGMA busy_timeout = 5000');
      this.db.exec(SCHEMA_SQL);
      this.migrateSchema(); // schema 版本锚：迁移到 v2（v1 旧库 ALTER 补列；更高版本照常打开）
    } catch (error) {
      // 建库失败：关闭句柄后原样抛出（启动路径由调用方决策，属配置错误而非运行期写失败）
      try {
        this.db.close();
      } catch {
        /* 关闭兜底 */
      }
      this.closed = true;
      throw error;
    }
  }

  /**
   * 请求元数据同步入账。返回账本 id；任何写入失败只自增 degraded/writeErrors 并返回 null，绝不抛出。
   * 写入经 BEGIN IMMEDIATE 事务：读链尾 → INSERT ... RETURNING 取库内实际行 → 回填 row_hash → 提交；任何一步失败回滚，不留半链行。
   */
  recordRequest(entry: LedgerRequestInput): string | null {
    const id = entry.id ?? randomUUID();
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const prevHash = this.chainTailHash('requests');
        const stored = this.db
          .prepare(
            'INSERT INTO requests (id, ts_ms, origin, channel_id, alias, model_upstream, req_bytes, has_tools, has_image, messages_count) ' +
              'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *',
          )
          .get(
            id,
            entry.ts_ms,
            entry.origin,
            entry.channel_id,
            entry.alias,
            entry.model_upstream ?? null,
            entry.req_bytes ?? null,
            entry.has_tools ?? null,
            entry.has_image ?? null,
            entry.messages_count ?? null,
          ) as Record<string, unknown> | undefined;
        if (stored === undefined) throw new Error('requests 插入未返回行');
        const hash = this.chainRowHash(prevHash, stored);
        this.db.prepare('UPDATE requests SET row_hash = ? WHERE id = ?').run(hash, id);
        this.db.exec('COMMIT');
        return id;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* 回滚兜底：事务可能已被 SQLite 自动回滚 */
        }
        throw error;
      }
    } catch {
      this.noteWriteError();
      return null;
    }
  }

  /**
   * 结算同步落库（幂等）：INSERT ... ON CONFLICT(request_id, attempt_no) DO NOTHING RETURNING *，
   * .get() 返回 undefined=重复结算被拒（false，不触碰链、不记写错误）；有行则回填 row_hash 后提交（true）。
   * 写入经 BEGIN IMMEDIATE 事务，失败回滚不留半链行；任何失败只计数不抛出。
   */
  settle(entry: LedgerSettlementInput): boolean {
    try {
      this.db.exec('BEGIN IMMEDIATE');
      try {
        const stored = this.db
          .prepare(
            'INSERT INTO settlements (id, request_id, attempt_no, ts_ms, channel_id, alias, upstream_status, client_status, error_source, error_class, ' +
              'finish_reason, ttft_upstream_ms, ttft_client_ms, ttft_contaminated, token_prompt, token_completion, token_cached, token_reasoning, token_source, ' +
              'token_missing_reason, usage_valid, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(request_id, attempt_no) DO NOTHING RETURNING *',
          )
          .get(
            entry.id ?? randomUUID(),
            entry.request_id,
            entry.attempt_no ?? 1,
            entry.ts_ms,
            entry.channel_id,
            entry.alias,
            entry.upstream_status ?? null,
            entry.client_status,
            entry.error_source ?? null,
            entry.error_class ?? null,
            entry.finish_reason ?? null,
            entry.ttft_upstream_ms ?? null,
            entry.ttft_client_ms ?? null,
            entry.ttft_contaminated ?? null,
            entry.token_prompt ?? null,
            entry.token_completion ?? null,
            entry.token_cached ?? null,
            entry.token_reasoning ?? null,
            entry.token_source,
            entry.token_missing_reason ?? null,
            entry.usage_valid,
            entry.amount ?? null,
          ) as Record<string, unknown> | undefined;
        if (stored === undefined) {
          // 重复结算被拒：提交空事务收尾，不触碰链、不 noteWriteError（与旧 changes===0 语义一致）
          this.db.exec('COMMIT');
          return false;
        }
        const prevHash = this.chainTailHash('settlements');
        const hash = this.chainRowHash(prevHash, stored);
        this.db.prepare('UPDATE settlements SET row_hash = ? WHERE id = ?').run(hash, String(stored['id']));
        this.db.exec('COMMIT');
        return true;
      } catch (error) {
        try {
          this.db.exec('ROLLBACK');
        } catch {
          /* 回滚兜底：事务可能已被 SQLite 自动回滚 */
        }
        throw error;
      }
    } catch {
      this.noteWriteError();
      return false;
    }
  }

  /**
   * 启动恢复：为无结算的请求补记 client_status='interrupted' / error_source='gateway'（网关自身重启，非渠道失败）。
   * 返回本次补结条数；重复调用不重复补（幂等）。
   */
  recover(): number {
    try {
      const rows = this.db
        .prepare(
          'SELECT r.id AS id, r.channel_id AS channel_id, r.alias AS alias FROM requests r ' +
            // 不限定 attempt_no：只要存在任意一次结算就视为已落账（多 attempt 结算各自成行，见 settle 的 UNIQUE 冲突语义）
            'WHERE NOT EXISTS (SELECT 1 FROM settlements s WHERE s.request_id = r.id)',
        )
        .all() as Array<{ id: string; channel_id: string; alias: string }>;
      let filled = 0;
      for (const row of rows) {
        const ok = this.settle({
          request_id: row.id,
          attempt_no: 1,
          ts_ms: Date.now(),
          channel_id: row.channel_id,
          alias: row.alias,
          upstream_status: null,
          client_status: 'interrupted',
          error_source: 'gateway',
          error_class: null,
          finish_reason: null,
          ttft_upstream_ms: null,
          ttft_client_ms: null,
          token_prompt: null,
          token_completion: null,
          token_cached: null,
          token_reasoning: null,
          token_source: 'none',
          token_missing_reason: 'absent',
          usage_valid: 0,
          amount: null,
        });
        if (ok) filled += 1;
      }
      this.recovered += filled;
      return filled;
    } catch {
      this.noteWriteError();
      return 0;
    }
  }

  /**
   * 按 (channel_id, alias) 聚合：requests 来自请求表；ok/errors/token 四项 SUM 来自结算表（不 join）。
   * ok 口径 = 客户端侧完整送达且上游为 2xx；error = 其余结算（含截断/超时/中断/上游错误响应）。
   * 聚合中 token 缺失（NULL）按 0 参与 SUM 展示，但库内绝不写 0 冒充缺失。
   */
  usageSummary(): LedgerUsageRow[] {
    try {
      const requestRows = this.db
        .prepare('SELECT channel_id, alias, COUNT(*) AS n FROM requests GROUP BY channel_id, alias')
        .all() as Array<{ channel_id: string; alias: string; n: number }>;
      const settlementRows = this.db
        .prepare(
          'SELECT channel_id, alias, COUNT(*) AS n, ' +
            "SUM(CASE WHEN client_status = 'ok' AND (upstream_status IS NULL OR (upstream_status >= 200 AND upstream_status < 300)) THEN 1 ELSE 0 END) AS ok, " +
            'COALESCE(SUM(token_prompt), 0) AS token_prompt, COALESCE(SUM(token_completion), 0) AS token_completion, ' +
            'COALESCE(SUM(token_cached), 0) AS token_cached, COALESCE(SUM(token_reasoning), 0) AS token_reasoning ' +
            'FROM settlements GROUP BY channel_id, alias',
        )
        .all() as Array<{
        channel_id: string;
        alias: string;
        n: number;
        ok: number;
        token_prompt: number;
        token_completion: number;
        token_cached: number;
        token_reasoning: number;
      }>;
      const merged = new Map<string, LedgerUsageRow>();
      const keyOf = (channelId: string, alias: string): string => `${channelId}\u0000${alias}`;
      for (const row of requestRows) {
        merged.set(keyOf(row.channel_id, row.alias), {
          channelId: row.channel_id,
          alias: row.alias,
          requests: Number(row.n),
          ok: 0,
          errors: 0,
          tokenPrompt: 0,
          tokenCompletion: 0,
          tokenCached: 0,
          tokenReasoning: 0,
        });
      }
      for (const row of settlementRows) {
        const key = keyOf(row.channel_id, row.alias);
        const target = merged.get(key) ?? {
          channelId: row.channel_id,
          alias: row.alias,
          requests: 0,
          ok: 0,
          errors: 0,
          tokenPrompt: 0,
          tokenCompletion: 0,
          tokenCached: 0,
          tokenReasoning: 0,
        };
        target.ok = Number(row.ok);
        target.errors = Number(row.n) - target.ok;
        target.tokenPrompt = Number(row.token_prompt);
        target.tokenCompletion = Number(row.token_completion);
        target.tokenCached = Number(row.token_cached);
        target.tokenReasoning = Number(row.token_reasoning);
        merged.set(key, target);
      }
      return [...merged.values()];
    } catch {
      this.noteWriteError();
      return [];
    }
  }

  /** 按 request_id 读取结算行（排障/证据链下钻；只读，不抛异常，失败返回 []）。 */
  settlementsOf(requestId: string): LedgerSettlementRow[] {
    try {
      const rows = this.db
        .prepare('SELECT * FROM settlements WHERE request_id = ? ORDER BY attempt_no')
        .all(requestId) as Array<Record<string, unknown>>;
      return rows.map((row) => ({
        id: String(row['id']),
        requestId: String(row['request_id']),
        attemptNo: Number(row['attempt_no']),
        tsMs: Number(row['ts_ms']),
        channelId: String(row['channel_id']),
        alias: String(row['alias']),
        upstreamStatus: row['upstream_status'] === null ? null : Number(row['upstream_status']),
        clientStatus: row['client_status'] === null ? null : (row['client_status'] as LedgerClientStatus),
        errorSource: row['error_source'] === null ? null : (row['error_source'] as LedgerErrorSource),
        errorClass: row['error_class'] === null ? null : String(row['error_class']),
        finishReason: row['finish_reason'] === null ? null : String(row['finish_reason']),
        ttftUpstreamMs: row['ttft_upstream_ms'] === null ? null : Number(row['ttft_upstream_ms']),
        ttftClientMs: row['ttft_client_ms'] === null ? null : Number(row['ttft_client_ms']),
        ttftContaminated: row['ttft_contaminated'] === null ? null : Number(row['ttft_contaminated']),
        tokenPrompt: row['token_prompt'] === null ? null : Number(row['token_prompt']),
        tokenCompletion: row['token_completion'] === null ? null : Number(row['token_completion']),
        tokenCached: row['token_cached'] === null ? null : Number(row['token_cached']),
        tokenReasoning: row['token_reasoning'] === null ? null : Number(row['token_reasoning']),
        tokenSource: row['token_source'] === null ? null : (row['token_source'] as LedgerTokenSource),
        tokenMissingReason: row['token_missing_reason'] === null ? null : (row['token_missing_reason'] as LedgerTokenMissingReason),
        usageValid: row['usage_valid'] === null ? null : Number(row['usage_valid']),
        amount: row['amount'] === null ? null : Number(row['amount']),
      }));
    } catch {
      this.noteWriteError();
      return [];
    }
  }

  stats(): LedgerStats {
    return { writeErrors: this.writeErrors, degraded: this.degraded, recovered: this.recovered };
  }

  /**
   * 校验两张表的 hash 链（先 requests 后 settlements）。只读、不抛：内部异常只自增 writeErrors 并返回降级报告。
   * ok=true 时 table 仅表示最后完成校验的表（两表均通过）；legacy 为两表未上链（row_hash IS NULL）的行数。
   */
  verifyChain(): LedgerChainReport {
    try {
      const requests = this.verifyTableChain('requests');
      const settlements = this.verifyTableChain('settlements');
      const legacy = { requests: requests.legacy, settlements: settlements.legacy };
      const checked = requests.checked + settlements.checked;
      if (!requests.ok) {
        return { ok: false, table: 'requests', brokenAtId: requests.brokenAtId, checked, legacy };
      }
      if (!settlements.ok) {
        return { ok: false, table: 'settlements', brokenAtId: settlements.brokenAtId, checked, legacy };
      }
      return { ok: true, table: 'settlements', brokenAtId: null, checked, legacy };
    } catch {
      this.noteWriteError();
      return { ok: false, table: 'requests', brokenAtId: null, checked: 0, legacy: { requests: 0, settlements: 0 } };
    }
  }

  /**
   * 仅测试用（篡改注入 / integrity_check 等完整性检查）；生产代码禁止使用，也不要在生产路径调用。
   */
  get rawDbForTest(): DatabaseSync {
    return this.db;
  }

  /** 关闭顺序：停收新写（调用方负责）→ wal_checkpoint(TRUNCATE)（内存库跳过）→ close。 */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      if (!this.memory) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      /* 关停兜底：checkpoint 失败不影响关闭 */
    }
    try {
      this.db.close();
    } catch {
      /* 关停兜底 */
    }
  }

  private noteWriteError(): void {
    this.writeErrors += 1;
    this.degraded = true;
  }

  /** schema 迁移：user_version <2 时补列并升锚；>=2 直接返回（前向兼容：更高版本库照常打开不报错）。幂等。 */
  private migrateSchema(): void {
    const versionRow = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
    const version = versionRow === undefined ? 0 : Number(versionRow.user_version);
    if (version >= 2) return;
    this.ensureColumn('requests', 'row_hash', 'TEXT');
    this.ensureColumn('settlements', 'row_hash', 'TEXT');
    this.ensureColumn('settlements', 'ttft_contaminated', 'INTEGER');
    this.db.exec('PRAGMA user_version = 2');
  }

  /** 列存在性检查后 ALTER TABLE ADD COLUMN（幂等：已存在则跳过）。 */
  private ensureColumn(table: 'requests' | 'settlements', column: string, type: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((info) => info.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }

  /**
   * 该表链尾 hash：最近一条「非 NULL」row_hash；无行或取不到 → CHAIN_GENESIS。
   * NULL 行（迁移前 legacy）被跳过：链只串起有 hash 的行（防 NULL 行切断/洗白链）。
   */
  private chainTailHash(table: 'requests' | 'settlements'): string {
    const row = this.db
      .prepare(`SELECT row_hash FROM ${table} WHERE row_hash IS NOT NULL ORDER BY rowid DESC LIMIT 1`)
      .get() as { row_hash: string } | undefined;
    return row === undefined || row.row_hash === null ? CHAIN_GENESIS : String(row.row_hash);
  }

  /** 链输入规范 = 当期列集合的规范 JSON：剔除 row_hash 自身后按列名字典序装载再序列化。 */
  private canonicalRowJson(row: Record<string, unknown>): string {
    const keys = Object.keys(row)
      .filter((key) => key !== 'row_hash')
      .sort();
    const canonical: Record<string, unknown> = {};
    for (const key of keys) canonical[key] = row[key];
    return JSON.stringify(canonical);
  }

  /** 单行链 hash：sha256(上一 hash + 规范 JSON)。 */
  private chainRowHash(prevHash: string, row: Record<string, unknown>): string {
    return createHash('sha256')
      .update(prevHash + this.canonicalRowJson(row))
      .digest('hex');
  }

  /**
   * 单表链遍历校验：全量行按 rowid 顺序；row_hash 为 NULL → legacy++ 且不改 expected（链尾等价于最近非 NULL 行）；
   * 非 NULL → checked++ 并比对，不等立即返回 brokenAtId（该行 id）。
   */
  private verifyTableChain(table: 'requests' | 'settlements'): { ok: boolean; brokenAtId: string | null; checked: number; legacy: number } {
    const rows = this.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all() as Array<Record<string, unknown>>;
    let expected = CHAIN_GENESIS;
    let checked = 0;
    let legacy = 0;
    for (const row of rows) {
      const stored = row['row_hash'];
      if (stored === null || stored === undefined) {
        legacy += 1;
        continue;
      }
      checked += 1;
      if (this.chainRowHash(expected, row) !== String(stored)) {
        return { ok: false, brokenAtId: String(row['id']), checked, legacy };
      }
      expected = String(stored);
    }
    return { ok: true, brokenAtId: null, checked, legacy };
  }
}
