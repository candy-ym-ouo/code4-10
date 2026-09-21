import { convertQuantity } from "@handcraft/contracts";
import type { DbClient } from "./db.js";
import { AppError } from "./errors.js";

export type ColorChangeInput = {
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

export type BatchColorChangeInput = ColorChangeInput & { key?: string | null };

export type BatchRow = {
  id: string;
  material_id: string;
  stock_unit: string;
  initial_color_name: string | null;
  initial_color_hex: string | null;
  current_color_name: string | null;
  current_color_hex: string | null;
  status: string;
};

export async function lockActiveBatch(client: DbClient, batchId: string): Promise<BatchRow> {
  const result = await client.query<BatchRow>(
    `SELECT b.id, b.material_id, b.stock_unit, b.initial_color_name, b.initial_color_hex,
            b.current_color_name, b.current_color_hex, b.status
       FROM batches b WHERE b.id = $1 FOR UPDATE OF b`,
    [batchId]
  );
  const batch = result.rows[0];
  if (!batch) throw new AppError(422, "INVALID_BATCH", "批次不存在");
  if (batch.status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "已归档批次的颜色时间线为只读，不能改色");
  return batch;
}

export async function assertMaterialActive(client: DbClient, materialId: string): Promise<void> {
  const material = await client.query(
    "SELECT 1 FROM materials WHERE id = $1 AND archived_at IS NULL FOR SHARE",
    [materialId]
  );
  if (!material.rowCount) throw new AppError(409, "MATERIAL_ARCHIVED", "材料已归档，不能记录颜色变化");
}

async function resolveProjectId(client: DbClient, input: ColorChangeInput, batchId: string): Promise<string | null> {
  let projectId = input.projectId || null;
  if (input.consumptionId) {
    const consumption = await client.query<{ id: string; project_id: string; batch_id: string }>(
      "SELECT id, project_id, batch_id FROM consumptions WHERE id = $1",
      [input.consumptionId]
    );
    const row = consumption.rows[0];
    if (!row || row.batch_id !== batchId) throw new AppError(422, "INVALID_CONSUMPTION", "消耗记录与批次不匹配");
    if (input.projectId && input.projectId !== row.project_id) {
      throw new AppError(422, "INVALID_CONSUMPTION", "消耗记录与项目不匹配");
    }
    projectId = input.projectId || row.project_id;
  }
  if (projectId) {
    const project = await client.query<{ id: string; status: string }>(
      "SELECT id, status FROM projects WHERE id = $1 FOR SHARE",
      [projectId]
    );
    if (!project.rows[0]) throw new AppError(422, "INVALID_PROJECT", "项目不存在");
    if (project.rows[0].status === "ARCHIVED") throw new AppError(409, "PROJECT_ARCHIVED", "已归档项目不能新增颜色变化");
  }
  return projectId;
}

export async function insertColorChange(
  client: DbClient,
  batch: BatchRow,
  input: ColorChangeInput,
  options: {
    /** 插入位置前一条有效变化（同一 occurred_at 时以 seq 判定），用于补录时链接前后色 */
    predecessor?: { after_color_name: string | null; after_color_hex: string | null } | null;
  } = {}
) {
  const projectId = await resolveProjectId(client, input, batch.id);

  let affectedQuantity: string | null = null;
  if (input.affectedQuantity !== undefined && input.affectedQuantity !== null) {
    if (!input.unit) throw new AppError(422, "UNIT_REQUIRED", "记录影响数量时必须提供单位");
    try {
      affectedQuantity = convertQuantity(input.affectedQuantity, input.unit as never, batch.stock_unit as never);
    } catch {
      throw new AppError(422, "UNIT_INCOMPATIBLE", "影响数量单位与批次库存单位不兼容");
    }
  }

  const prev = options.predecessor !== undefined
    ? options.predecessor
    : await client.query<{ after_color_name: string | null; after_color_hex: string | null }>(
        `SELECT after_color_name, after_color_hex
           FROM color_changes
          WHERE batch_id = $1 AND occurred_at <= $2::timestamptz AND voided_at IS NULL
          ORDER BY occurred_at DESC, seq DESC
          LIMIT 1`,
        [batch.id, input.occurredAt]
      ).then((r) => r.rows[0] ?? null);

  const beforeColorName = input.beforeColorName || prev?.after_color_name || batch.initial_color_name || null;
  const beforeColorHex = input.beforeColorHex || prev?.after_color_hex || batch.initial_color_hex || null;

  // seq 由 color_changes_assign_seq 触发器按批次序列分配；
  // 批量补录时先整体后移既有 seq，插入后由 renumberColorChain 重排。
  const result = await client.query(
    `INSERT INTO color_changes(batch_id, project_id, consumption_id, change_type,
       before_color_name, before_color_hex, after_color_name, after_color_hex,
       affected_quantity, stock_unit, temperature_c, humidity_percent, ph_value,
       environment_notes, occurred_at, notes)
     VALUES ($1::uuid, $2, $3, $4::color_change_type, $5::varchar, $6::char(7), $7::varchar, $8::char(7),
             $9, $10::stock_unit, $11, $12, $13, $14, $15::timestamptz, $16)
     RETURNING id, batch_id AS "batchId", project_id AS "projectId", consumption_id AS "consumptionId",
               change_type AS "changeType", before_color_name AS "beforeColorName",
               before_color_hex AS "beforeColorHex", after_color_name AS "afterColorName",
               after_color_hex AS "afterColorHex", affected_quantity::text AS "affectedQuantity",
               stock_unit AS "stockUnit", occurred_at AS "occurredAt", notes, seq,
               created_at AS "createdAt"`,
    [batch.id, projectId, input.consumptionId || null, input.changeType,
      beforeColorName, beforeColorHex, input.afterColorName, input.afterColorHex || null,
      affectedQuantity, affectedQuantity ? batch.stock_unit : null,
      input.temperatureC ?? null, input.humidityPercent ?? null, input.phValue ?? null,
      input.environmentNotes || null, input.occurredAt, input.notes || null]
  );
  return result.rows[0];
}

/**
 * 批量补录颜色变化：
 * 把新条目（按输入数组顺序，不要求有序）与批次既有有效记录按发生时间归并，
 * 同刻新条目稳定排在旧条目之后；逐条用“链尾 after”链接新条目的 before，
 * 并修正被插队的旧记录 before；插入后统一重排 seq 并重算当前色。
 * 因此倒序录入也会得到唯一、确定的当前色。
 */
export async function backfillColorChanges(
  client: DbClient,
  batch: BatchRow,
  changes: BatchColorChangeInput[],
  options: { validateKeys?: boolean } = {}
): Promise<{ count: number; currentColorChanged: boolean; rows: unknown[] }> {
  if (options.validateKeys) {
    const seen = new Set<string>();
    for (const change of changes) {
      if (change.key) {
        if (seen.has(change.key)) throw new AppError(422, "DUPLICATE_BATCH_KEY", `批次内存在重复的条目标识 ${change.key}`);
        seen.add(change.key);
      }
    }
  }

  const existing = await client.query<{
    id: string;
    occurred_at: Date;
    seq: number;
    before_color_name: string | null;
    before_color_hex: string | null;
    after_color_name: string | null;
    after_color_hex: string | null;
  }>(
    `SELECT id, occurred_at, seq, before_color_name, before_color_hex, after_color_name, after_color_hex
       FROM color_changes
      WHERE batch_id = $1 AND voided_at IS NULL
      ORDER BY occurred_at ASC, seq ASC`,
    [batch.id]
  );

  // 给新条目预留临时 seq：既有行（含作废）整体后移 N，保证合并期间 seq 唯一；
  // 合并完成后由 renumberColorChain 压缩为按时间连续的 1..M。
  const newCount = changes.length;
  const maxExistingSeq = await client.query<{ max: number | null }>(
    `SELECT max(seq) AS max FROM color_changes WHERE batch_id = $1::uuid`,
    [batch.id]
  );
  const base = Number(maxExistingSeq.rows[0]?.max ?? 0);
  if (base > 0) {
    await client.query(`UPDATE color_changes SET seq = seq + $2 WHERE batch_id = $1`, [batch.id, newCount]);
    // 把批次序列推到移位后的区间末尾，使触发器为新行分配 base+N+1 起的临时 seq，避免与既有行冲突
    await client.query(`SELECT setval($1, $2, true)`, [`"color_changes_batch_${batch.id}"`, base + newCount]);
  }
  type MergeItem =
    | { kind: "existing"; occurredAt: number; row: (typeof existing.rows)[number] }
    | { kind: "new"; occurredAt: number; inputIndex: number; change: BatchColorChangeInput };

  const merge: MergeItem[] = [
    ...existing.rows.map((row) => ({
      kind: "existing" as const,
      occurredAt: new Date(row.occurred_at).getTime(),
      row: { ...row, seq: row.seq + newCount }
    })),
    ...changes.map((change, inputIndex) => ({ kind: "new" as const, occurredAt: new Date(change.occurredAt).getTime(), inputIndex, change }))
  ].sort((a, b) => a.occurredAt - b.occurredAt || (a.kind === b.kind ? 0 : a.kind === "new" ? 1 : -1));

  const rows: unknown[] = [];
  let chainTail: { afterColorName: string | null; afterColorHex: string | null } | null = null;
  for (const item of merge) {
    if (item.kind === "existing") {
      if (chainTail && (item.row.before_color_name ?? null) !== (chainTail.afterColorName ?? null)) {
        await client.query(
          `UPDATE color_changes SET before_color_name = $2, before_color_hex = $3
            WHERE id = $1 AND (before_color_name IS DISTINCT FROM $2 OR before_color_hex IS DISTINCT FROM $3)`,
          [item.row.id, chainTail.afterColorName, chainTail.afterColorHex]
        );
      }
      chainTail = { afterColorName: item.row.after_color_name, afterColorHex: item.row.after_color_hex };
    } else {
      const predecessor = chainTail
        ? { after_color_name: chainTail.afterColorName, after_color_hex: chainTail.afterColorHex }
        : null;
      // 不传 seq，由触发器用批次序列分配临时值（序列因此正确前进），最终 renumber 统一重排
      const row = await insertColorChange(client, batch, item.change, { predecessor });
      rows.push({ ...row, key: item.change.key ?? null, inputIndex: item.inputIndex });
      chainTail = {
        afterColorName: (row as { afterColorName: string | null }).afterColorName,
        afterColorHex: (row as { afterColorHex: string | null }).afterColorHex
      };
    }
  }

  await renumberColorChain(client, batch.id);
  const { changed } = await recalculateCurrentColor(client, batch.id);
  return { count: changes.length, currentColorChanged: changed, rows };
}

/**
 * 把批次全部颜色记录（含作废）按 (occurred_at, 旧 seq) 压缩重排为 1..N 连续序号，
 * 并把批次序列推进到最大值。作废行仍参与排序，只是不影响“当前色”。
 * 必须在任何会改变顺序的批量插入后调用。
 */
export async function renumberColorChain(client: DbClient, batchId: string): Promise<void> {
  await client.query(
    `WITH ordered AS (
       SELECT id, row_number() OVER (ORDER BY occurred_at ASC, seq ASC, created_at ASC) AS new_seq
       FROM color_changes WHERE batch_id = $1
     )
     UPDATE color_changes cc SET seq = ordered.new_seq
       FROM ordered WHERE cc.id = ordered.id`,
    [batchId]
  );
  const maxSeq = await client.query<{ max: number | null }>(
    "SELECT max(seq) AS max FROM color_changes WHERE batch_id = $1",
    [batchId]
  );
  const max = maxSeq.rows[0]?.max;
  // 序列名含 UUID 连字符，必须作为带引号的标识符传入
  const sequenceName = `"color_changes_batch_${batchId}"`;
  if (max) {
    await client.query(`SELECT setval($1, $2, true)`, [sequenceName, max]);
  } else {
    await client.query(`SELECT setval($1, 1, false)`, [sequenceName]);
  }
}

/**
 * 以 (occurred_at, seq) 为唯一有序键重新计算批次当前色快照。
 * seq 是批次内单调序号，因此同一时间戳也有确定的先后，当前色唯一。
 * 作废记录不参与当前色，但仍保留在时间链中。
 */
export async function recalculateCurrentColor(client: DbClient, batchId: string): Promise<{ changed: boolean }> {
  const latest = await client.query<{ after_color_name: string | null; after_color_hex: string | null; occurred_at: Date }>(
    `SELECT after_color_name, after_color_hex, occurred_at
       FROM color_changes
      WHERE batch_id = $1 AND voided_at IS NULL
      ORDER BY occurred_at DESC, seq DESC
      LIMIT 1`,
    [batchId]
  );
  const fallback = await client.query<{
    initial_color_name: string | null;
    initial_color_hex: string | null;
    created_at: Date;
  }>(
    `SELECT initial_color_name, initial_color_hex, created_at FROM batches WHERE id = $1`,
    [batchId]
  );
  const row = latest.rows[0];
  const colorName = row?.after_color_name ?? fallback.rows[0]?.initial_color_name ?? null;
  const colorHex = row?.after_color_hex ?? fallback.rows[0]?.initial_color_hex ?? null;
  const updatedAt = row?.occurred_at ?? fallback.rows[0]?.created_at ?? new Date();

  const previous = await client.query<{ name: string | null; hex: string | null }>(
    `SELECT current_color_name AS name, current_color_hex AS hex FROM batches WHERE id = $1`,
    [batchId]
  );
  await client.query(
    `UPDATE batches
        SET current_color_name = $1::varchar, current_color_hex = $2::char(7),
            color_updated_at = $3::timestamptz,
            version = CASE
              WHEN current_color_name IS DISTINCT FROM $1::varchar OR current_color_hex IS DISTINCT FROM $2::char(7)
              THEN version + 1 ELSE version END
      WHERE id = $4::uuid`,
    [colorName, colorHex, updatedAt, batchId]
  );
  const changed =
    (previous.rows[0]?.name ?? null) !== (colorName ?? null) ||
    (previous.rows[0]?.hex ?? null) !== (colorHex ?? null);
  return { changed };
}
