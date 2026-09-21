import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { AppError } from "../src/lib/errors.js";
import {
  backfillColorChanges,
  insertColorChange,
  lockActiveBatch,
  recalculateCurrentColor
} from "../src/lib/colorTimeline.js";
import type { DbClient } from "../src/lib/db.js";

const sqlDir = path.resolve(process.cwd(), "sql");

// PGlite 精简构建缺少 pgcrypto / pg_trgm / citext 扩展（生产 PG16 默认提供），
// 验证业务不变量时去掉扩展及其 gin trgm 索引。
function stripUnsupported(sql: string): string {
  return sql
    .replace(/CREATE EXTENSION IF NOT EXISTS \w+;/g, "")
    .replace(/CREATE INDEX \w+ ON \w+ USING gin \(lower\(\w+\) gin_trgm_ops\);/g, "");
}

// 让 lib 里的 client.query 与 PGlite 对齐（两者都返回 { rows, rowCount }）
function clientFor(db: PGlite): DbClient {
  return { query: ((text: string, params?: unknown[]) => db.query(text, params as never[])) as never } as DbClient;
}

const USER_ID = "11111111-1111-1111-1111-111111111111";
const MATERIAL_ID = "22222222-2222-2222-2222-222222222222";
const BATCH_ID = "33333333-3333-3333-3333-333333333333";

describe("颜色变化时间链（真实 PostgreSQL 语义 / PGlite）", () => {
  let db: PGlite;
  let client: DbClient;

  beforeAll(async () => {
    db = new PGlite();
    for (const file of ["001_init.sql", "002_unit_integrity.sql", "003_batch_status_integrity.sql", "004_color_change_timeline.sql"]) {
      await db.exec(stripUnsupported(readFileSync(path.join(sqlDir, file), "utf8")));
    }
    client = clientFor(db);
    await db.query(`INSERT INTO users(id, display_name, password_hash) VALUES ($1, 'op', 'x')`, [USER_ID]);
    await db.query(
      `INSERT INTO materials(id, name, craft_types, stock_unit, default_color_name, default_color_hex)
       VALUES ($1, '丝', '{DYEING}', 'g', '原色', '#EEEEEE')`,
      [MATERIAL_ID]
    );
    await db.query(
      `INSERT INTO batches(id, material_id, received_at, initial_quantity, remaining_quantity, stock_unit, entry_unit,
         initial_color_name, initial_color_hex, current_color_name, current_color_hex)
       VALUES ($1, $2, '2026-09-01', 100, 100, 'g', 'g', '原色', '#EEEEEE', '原色', '#EEEEEE')`,
      [BATCH_ID, MATERIAL_ID]
    );
  });

  afterAll(async () => {
    await db.close();
  });

  async function currentColor() {
    const r = await db.query<{ name: string | null; hex: string | null }>(
      `SELECT current_color_name AS name, current_color_hex AS hex FROM batches WHERE id = $1`,
      [BATCH_ID]
    );
    return r.rows[0]!;
  }

  async function timeline() {
    const r = await db.query<{ id: string; seq: number; after: string; voided: Date | null }>(
      `SELECT id, seq, after_color_name AS after, voided_at AS voided FROM color_changes
        WHERE batch_id = $1 ORDER BY occurred_at ASC, seq ASC`,
      [BATCH_ID]
    );
    return r.rows;
  }

  const change = (afterColorName: string, occurredAt: string, extra: Record<string, unknown> = {}) => ({
    changeType: "OTHER",
    afterColorName,
    afterColorHex: null,
    occurredAt,
    ...extra
  });

  it("倒序录入后仍确定唯一当前色：先录晚的再录早的", async () => {
    const batch = await lockActiveBatch(client, BATCH_ID);
    await insertColorChange(client, batch, change("深红", "2026-09-03T10:00:00Z"));
    const first = await recalculateCurrentColor(client, BATCH_ID);
    expect(first.changed).toBe(true);
    expect((await currentColor()).name).toBe("深红");
    await insertColorChange(client, batch, change("浅蓝", "2026-09-01T10:00:00Z"));
    const { changed } = await recalculateCurrentColor(client, BATCH_ID);
    expect(changed).toBe(false); // 倒序补录历史色，当前色不应变化
    expect((await currentColor()).name).toBe("深红");
  });

  it("批量补录：整批完全倒序粘贴，链按时间重排，before 自动链接", async () => {
    const batch = await lockActiveBatch(client, BATCH_ID);
    const result = await backfillColorChanges(
      client,
      batch,
      [
        change("靛蓝C", "2026-09-04T10:00:00Z", { key: "c" }),
        change("靛蓝B", "2026-09-02T10:00:00Z", { key: "b" }),
        change("靛蓝A", "2026-09-02T08:00:00Z", { key: "a" })
      ],
      { validateKeys: true }
    );
    expect(result.count).toBe(3);
    expect(result.currentColorChanged).toBe(true);
    expect((await currentColor()).name).toBe("靛蓝C");

    const rows = await timeline();
    const names = rows.map((r) => r.after);
    expect(names).toEqual(["浅蓝", "靛蓝A", "靛蓝B", "深红", "靛蓝C"]);
    // seq 在批次内连续唯一
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5]);

    // before 链接：靛蓝B 的 before 必须是同刻更早的 靛蓝A after
    const before = await db.query<{ name: string | null }>(
      `SELECT before_color_name AS name FROM color_changes WHERE batch_id=$1 AND after_color_name='靛蓝B'`,
      [BATCH_ID]
    );
    expect(before.rows[0]!.name).toBe("靛蓝A");
  });

  it("批量补录重复 key 被拒绝", async () => {
    const batch = await lockActiveBatch(client, BATCH_ID);
    await expect(
      backfillColorChanges(client, batch, [change("x1", "2026-09-10T00:00:00Z", { key: "k" }), change("x2", "2026-09-11T00:00:00Z", { key: "k" })], { validateKeys: true })
    ).rejects.toMatchObject({ code: "DUPLICATE_BATCH_KEY" });
  });

  it("删除（作废）误录不得破坏时间链，并重算出正确当前色", async () => {
    const latest = await db.query<{ id: string }>(
      `SELECT id FROM color_changes WHERE batch_id=$1 AND voided_at IS NULL ORDER BY occurred_at DESC, seq DESC LIMIT 1`,
      [BATCH_ID]
    );
    await db.query(
      `UPDATE color_changes SET voided_at=now(), voided_by=$2, void_reason='误录作废' WHERE id=$1`,
      [latest.rows[0]!.id, USER_ID]
    );
    const { changed } = await recalculateCurrentColor(client, BATCH_ID);
    expect(changed).toBe(true);
    expect((await currentColor()).name).toBe("深红");

    // 再作废中间一条，行仍全部保留
    const middle = await db.query<{ id: string }>(
      `SELECT id FROM color_changes WHERE batch_id=$1 AND after_color_name='靛蓝A'`,
      [BATCH_ID]
    );
    await db.query(
      `UPDATE color_changes SET voided_at=now(), voided_by=$2, void_reason='中间误录' WHERE id=$1`,
      [middle.rows[0]!.id, USER_ID]
    );
    await recalculateCurrentColor(client, BATCH_ID);
    expect((await currentColor()).name).toBe("深红");
    const count = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM color_changes WHERE batch_id=$1`, [BATCH_ID]);
    expect(count.rows[0]!.n).toBe(5); // 没有物理删除
  });

  it("归档批次禁止改色：锁批次即抛 BATCH_ARCHIVED", async () => {
    await db.query(`UPDATE batches SET status='ARCHIVED', remaining_quantity=0 WHERE id=$1`, [BATCH_ID]);
    await expect(lockActiveBatch(client, BATCH_ID)).rejects.toMatchObject({ code: "BATCH_ARCHIVED" });
  });

  it("颜色变化证据必须标记 BEFORE/AFTER（数据库约束）", async () => {
    // 用一条未归档批次上的记录
    await db.query(
      `INSERT INTO batches(id, material_id, received_at, initial_quantity, remaining_quantity, stock_unit, entry_unit)
       VALUES ('44444444-4444-4444-4444-444444444444', $1, '2026-09-01', 1, 1, 'g', 'g')`,
      [MATERIAL_ID]
    );
    const inserted = await db.query<{ id: string }>(
      `INSERT INTO color_changes(batch_id, change_type, after_color_name, occurred_at)
       VALUES ('44444444-4444-4444-4444-444444444444','OTHER','灰','2026-09-02T00:00:00Z') RETURNING id`
    );
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO attachments(owner_type, owner_id, original_name, storage_key, mime_type, byte_size, sha256)
         VALUES ('COLOR_CHANGE', $1, 'b.jpg', 'k', 'image/jpeg', 1, 'x')`,
        [inserted.rows[0]!.id]
      );
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    await expect(
      db.query(
        `INSERT INTO attachments(owner_type, owner_id, original_name, storage_key, mime_type, byte_size, sha256, phase)
         VALUES ('COLOR_CHANGE', $1, 'a.jpg', 'k2', 'image/jpeg', 1, 'x', 'BEFORE')`,
        [inserted.rows[0]!.id]
      )
    ).resolves.toBeTruthy();
  });

  it("AppError 携带稳定错误码", () => {
    expect(new AppError(409, "BATCH_ARCHIVED", "x").code).toBe("BATCH_ARCHIVED");
  });

  it("数据库触发器层面也拒绝向已归档批次插入颜色记录", async () => {
    let rejected = false;
    try {
      await db.query(
        `INSERT INTO color_changes(batch_id, change_type, after_color_name, occurred_at)
         VALUES ($1, 'OTHER', 'z', '2026-10-01T00:00:00Z')`,
        [BATCH_ID]
      );
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
  });
});
