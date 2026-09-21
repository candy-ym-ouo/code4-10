import { convertQuantity, planColorChainSeq } from "@handcraft/contracts";
import type { PoolClient } from "pg";
import { AppError } from "./errors.js";

// 只取查询能力：Pool 与 PoolClient 都具备兼容的 query 重载，
// 避免在业务辅助函数里耦合连接生命周期方法。
export type ColorChainClient = Pick<PoolClient, "query">;

export type ColorChangeInputEntry = {
  projectId?: string | null;
  consumptionId?: string | null;
  changeType: string;
  beforeColorName?: string | null;
  beforeColorHex?: string | null;
  afterColorName: string;
  afterColorHex?: string | null;
  affectedQuantity?: string | null;
  unit?: string | null;
  temperatureC?: number | null;
  humidityPercent?: number | null;
  phValue?: number | null;
  environmentNotes?: string | null;
  occurredAt: string;
  notes?: string | null;
};

export type ResolvedBatch = {
  id: string;
  materialId: string;
  stockUnit: string;
};

// 归档批次禁止任何改色操作：新增（含批量补录）、改备注、删除均不允许。
export async function lockActiveBatch(client: ColorChainClient, batchId: string): Promise<ResolvedBatch> {
  const result = await client.query<ResolvedBatch & { status: string }>(
    "SELECT id, material_id AS \"materialId\", stock_unit AS \"stockUnit\", status FROM batches WHERE id = $1 FOR UPDATE OF batches",
    [batchId]
  );
  const batch = result.rows[0];
  if (!batch) throw new AppError(422, "INVALID_BATCH", "批次不存在");
  if (batch.status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次的颜色记录不可变更");
  const material = await client.query("SELECT 1 FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE", [batch.materialId]);
  if (!material.rowCount) throw new AppError(409, "MATERIAL_ARCHIVED", "材料已归档，不能记录颜色变化");
  return { id: batch.id, materialId: batch.materialId, stockUnit: batch.stockUnit };
}

export async function resolveColorRelations(
  client: ColorChainClient,
  batch: ResolvedBatch,
  entry: { projectId?: string | null; consumptionId?: string | null }
): Promise<{ projectId: string | null; consumptionId: string | null }> {
  let projectId = entry.projectId || null;
  const consumptionId: string | null = entry.consumptionId || null;
  if (consumptionId) {
    const consumption = await client.query<{ project_id: string; batch_id: string }>(
      "SELECT project_id, batch_id FROM consumptions WHERE id = $1",
      [consumptionId]
    );
    const row = consumption.rows[0];
    if (!row || row.batch_id !== batch.id) throw new AppError(422, "INVALID_CONSUMPTION", "消耗记录与批次不匹配");
    if (entry.projectId && entry.projectId !== row.project_id) {
      throw new AppError(422, "INVALID_CONSUMPTION", "消耗记录与项目不匹配");
    }
    projectId = entry.projectId || row.project_id;
  }
  if (projectId) {
    const project = await client.query<{ status: string }>("SELECT status FROM projects WHERE id = $1 FOR SHARE", [projectId]);
    if (!project.rows[0]) throw new AppError(422, "INVALID_PROJECT", "项目不存在");
    if (project.rows[0].status === "ARCHIVED") throw new AppError(409, "PROJECT_ARCHIVED", "已归档项目不能新增颜色变化");
  }
  return { projectId, consumptionId };
}

export function convertAffectedQuantity(entry: { affectedQuantity?: string | null; unit?: string | null }, stockUnit: string): string | null {
  if (entry.affectedQuantity === undefined || entry.affectedQuantity === null) return null;
  if (!entry.unit) throw new AppError(422, "UNIT_REQUIRED", "记录影响数量时必须提供单位");
  try {
    return convertQuantity(entry.affectedQuantity, entry.unit as never, stockUnit as never);
  } catch {
    throw new AppError(422, "UNIT_INCOMPATIBLE", "影响数量单位与批次库存单位不兼容");
  }
}

type PreparedEntry = {
  input: ColorChangeInputEntry;
  projectId: string | null;
  consumptionId: string | null;
  affectedQuantity: string | null;
};

/**
 * 在已锁定的批次上插入一条或同一事务内多条颜色变化。
 * 先按 occurred_at 计算整条链的新序位（倒序补录同样归位），
 * 再统一重排未删除记录的 seq：先把旧记录挪到负序位让出空间，再落最终序位，
 * 以满足部分唯一索引 (batch_id, seq) WHERE deleted_at IS NULL。
 */
export async function insertColorChanges(client: ColorChainClient, batch: ResolvedBatch, entries: PreparedEntry[]): Promise<string[]> {
  const live = await client.query<{ id: string; occurred_at: Date; created_at: Date }>(
    "SELECT id, occurred_at, created_at FROM color_changes WHERE batch_id = $1 AND deleted_at IS NULL FOR UPDATE",
    [batch.id]
  );
  const plan = planColorChainSeq(
    live.rows.map((row) => ({ key: row.id, occurredAt: row.occurred_at.toISOString(), createdAt: row.created_at.toISOString() })),
    entries.map((entry, index) => ({ index, occurredAt: entry.input.occurredAt }))
  );
  const finalSeqByKey = new Map<string, number>();
  plan.forEach((key, index) => finalSeqByKey.set(key, index + 1));

  if (live.rows.length) {
    const cases = live.rows.map((_, index) => `WHEN $${index + 2}::uuid THEN $${live.rows.length + index + 2}::int`).join(" ");
    await client.query(
      `UPDATE color_changes SET seq = CASE id ${cases} ELSE seq END
        WHERE batch_id = $1 AND deleted_at IS NULL`,
      [batch.id, ...live.rows.map((row) => row.id), ...live.rows.map((row) => -Number(finalSeqByKey.get(row.id)))]
    );
  }

  const insertedIds: string[] = [];
  for (const [index, { input, projectId, consumptionId, affectedQuantity }] of entries.entries()) {
    const tempSeq = plan.length + entries.length + index + 1;
    const explicit = Boolean(input.beforeColorName || input.beforeColorHex);
    const result = await client.query<{ id: string }>(
      `INSERT INTO color_changes(batch_id, project_id, consumption_id, change_type,
         before_color_name, before_color_hex, before_color_explicit, after_color_name, after_color_hex,
         affected_quantity, stock_unit, temperature_c, humidity_percent, ph_value,
         environment_notes, occurred_at, notes, seq)
       VALUES ($1, $2, $3, $4::color_change_type, $5, $6, $7, $8, $9, $10, $11::stock_unit,
               $12, $13, $14, $15, $16::timestamptz, $17, $18)
       RETURNING id`,
      [batch.id, projectId, consumptionId, input.changeType,
       input.beforeColorName || null, input.beforeColorHex || null, explicit,
       input.afterColorName, input.afterColorHex || null,
       affectedQuantity, affectedQuantity ? batch.stockUnit : null,
       input.temperatureC ?? null, input.humidityPercent ?? null, input.phValue ?? null,
       input.environmentNotes || null, input.occurredAt, input.notes || null, tempSeq]
    );
    insertedIds.push(result.rows[0]!.id);
    finalSeqByKey.set(result.rows[0]!.id, Number(finalSeqByKey.get(`new:${index}`)));
  }

  if (live.rows.length) {
    for (const row of live.rows) {
      await client.query("UPDATE color_changes SET seq = $2 WHERE id = $1", [row.id, finalSeqByKey.get(row.id)]);
    }
  }
  for (const id of insertedIds) {
    await client.query("UPDATE color_changes SET seq = $2 WHERE id = $1", [id, finalSeqByKey.get(id)]);
  }

  await repairColorChain(client, batch.id);
  return insertedIds;
}

/**
 * 依据链序重算每条记录的“变化前颜色”：仅修正服务器推断（before_color_explicit=false）的记录，
 * 用户显式记录的证据不被覆盖；并把批次当前色快照刷新为链尾记录，无记录时回到批次初始色。
 * 软删除产生的序位空洞先压实为连续 1..N（先整体转负序位再翻正，避开部分唯一索引冲突），
 * 保证“删除误录”不会破坏时间链的连续性。
 */
export async function repairColorChain(client: ColorChainClient, batchId: string): Promise<void> {
  await client.query(
    `UPDATE color_changes SET seq = -ordered.rn
       FROM (
         SELECT id, row_number() OVER (PARTITION BY batch_id ORDER BY seq) AS rn
           FROM color_changes WHERE batch_id = $1 AND deleted_at IS NULL
       ) ordered
      WHERE color_changes.id = ordered.id`,
    [batchId]
  );
  await client.query(
    `UPDATE color_changes SET seq = -seq WHERE batch_id = $1 AND deleted_at IS NULL AND seq < 0`,
    [batchId]
  );
  await client.query(
    `UPDATE color_changes cc
        SET before_color_name = prev.after_color_name,
            before_color_hex = prev.after_color_hex
       FROM (
         SELECT cur.id,
                lag(cur.after_color_name) OVER w AS after_color_name,
                lag(cur.after_color_hex) OVER w AS after_color_hex
           FROM color_changes cur
          WHERE cur.batch_id = $1 AND cur.deleted_at IS NULL
         WINDOW w AS (PARTITION BY cur.batch_id ORDER BY cur.seq)
       ) prev
      WHERE cc.id = prev.id
        AND cc.before_color_explicit = false
        AND (prev.after_color_name IS NOT NULL OR prev.after_color_hex IS NOT NULL)
        AND (cc.before_color_name IS DISTINCT FROM prev.after_color_name
             OR cc.before_color_hex IS DISTINCT FROM prev.after_color_hex)`,
    [batchId]
  );
  await client.query(
    `UPDATE color_changes cc
        SET before_color_name = b.initial_color_name,
            before_color_hex = b.initial_color_hex
       FROM batches b
      WHERE cc.batch_id = b.id
        AND cc.batch_id = $1
        AND cc.deleted_at IS NULL
        AND cc.before_color_explicit = false
        AND cc.seq = (SELECT min(seq) FROM color_changes WHERE batch_id = cc.batch_id AND deleted_at IS NULL)
        AND (cc.before_color_name IS DISTINCT FROM b.initial_color_name
             OR cc.before_color_hex IS DISTINCT FROM b.initial_color_hex)`,
    [batchId]
  );
  await refreshBatchCurrentColor(client, batchId);
}

export async function refreshBatchCurrentColor(client: ColorChainClient, batchId: string): Promise<void> {
  const head = await client.query<{ after_color_name: string | null; after_color_hex: string | null; occurred_at: Date }>(
    `SELECT after_color_name, after_color_hex, occurred_at
       FROM color_changes
      WHERE batch_id = $1 AND deleted_at IS NULL
      ORDER BY seq DESC LIMIT 1`,
    [batchId]
  );
  if (head.rows[0]) {
    await client.query(
      `UPDATE batches SET current_color_name = $1, current_color_hex = $2,
         color_updated_at = $3::timestamptz, version = version + 1 WHERE id = $4`,
      [head.rows[0].after_color_name, head.rows[0].after_color_hex, head.rows[0].occurred_at, batchId]
    );
  } else {
    await client.query(
      `UPDATE batches b SET current_color_name = b.initial_color_name,
         current_color_hex = b.initial_color_hex,
         color_updated_at = CASE WHEN b.initial_color_name IS NULL AND b.initial_color_hex IS NULL THEN NULL ELSE b.created_at END,
         version = version + 1
       WHERE b.id = $1`,
      [batchId]
    );
  }
}

export async function getBatchHeadColorChangeId(client: ColorChainClient, batchId: string): Promise<string | null> {
  const head = await client.query<{ id: string }>(
    "SELECT id FROM color_changes WHERE batch_id = $1 AND deleted_at IS NULL ORDER BY seq DESC LIMIT 1",
    [batchId]
  );
  return head.rows[0]?.id ?? null;
}
