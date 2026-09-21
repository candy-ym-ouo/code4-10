import type { FastifyInstance } from "fastify";
import { colorChangeBulkSchema, colorChangeInputSchema, colorChangePatchSchema } from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import {
  convertAffectedQuantity,
  getBatchHeadColorChangeId,
  insertColorChanges,
  lockActiveBatch,
  repairColorChain,
  resolveColorRelations,
  type ColorChainClient,
  type ColorChangeInputEntry
} from "../lib/colorChain.js";

type Query = Record<string, string | undefined>;

const LIST_COLUMNS = `cc.id, cc.batch_id AS "batchId", b.batch_code AS "batchCode", m.name AS "materialName",
  cc.project_id AS "projectId", p.name AS "projectName", cc.consumption_id AS "consumptionId",
  cc.change_type AS "changeType", cc.before_color_name AS "beforeColorName", cc.before_color_hex AS "beforeColorHex",
  cc.before_color_explicit AS "beforeColorExplicit",
  cc.after_color_name AS "afterColorName", cc.after_color_hex AS "afterColorHex",
  cc.affected_quantity::text AS "affectedQuantity", cc.stock_unit AS "stockUnit",
  cc.temperature_c::text AS "temperatureC", cc.humidity_percent::text AS "humidityPercent",
  cc.ph_value::text AS "phValue", cc.environment_notes AS "environmentNotes", cc.occurred_at AS "occurredAt",
  cc.seq, cc.notes, cc.created_at AS "createdAt",
  cc.id = (
    SELECT c2.id FROM color_changes c2
     WHERE c2.batch_id = cc.batch_id AND c2.deleted_at IS NULL
     ORDER BY c2.seq DESC LIMIT 1
  ) AS "isCurrent"`;

function normalizeEntry(input: ColorChangeInputEntry): ColorChangeInputEntry {
  return {
    ...input,
    beforeColorHex: input.beforeColorHex || null,
    afterColorHex: input.afterColorHex || null,
    projectId: input.projectId || null,
    consumptionId: input.consumptionId || null
  };
}

async function loadCreatedColorChange(client: ColorChainClient, id: string) {
  const result = await client.query(
    `SELECT cc.id, cc.batch_id AS "batchId", cc.project_id AS "projectId", cc.consumption_id AS "consumptionId",
            cc.change_type AS "changeType", cc.before_color_name AS "beforeColorName",
            cc.before_color_hex AS "beforeColorHex", cc.before_color_explicit AS "beforeColorExplicit",
            cc.after_color_name AS "afterColorName", cc.after_color_hex AS "afterColorHex",
            cc.affected_quantity::text AS "affectedQuantity", cc.stock_unit AS "stockUnit",
            cc.occurred_at AS "occurredAt", cc.seq, cc.notes, cc.created_at AS "createdAt"
       FROM color_changes cc WHERE cc.id = $1`,
    [id]
  );
  return result.rows[0];
}

export async function colorChangeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/color-changes", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const conditions = ["cc.deleted_at IS NULL"];
    for (const [key, column] of [["batchId", "cc.batch_id"], ["projectId", "cc.project_id"], ["consumptionId", "cc.consumption_id"]] as const) {
      if (request.query[key]) {
        values.push(request.query[key]);
        conditions.push(`${column} = $${values.length}::uuid`);
      }
    }
    if (request.query.type) {
      values.push(request.query.type);
      conditions.push(`cc.change_type = $${values.length}::color_change_type`);
    }
    if (request.query.color?.trim()) {
      values.push(`%${request.query.color.trim()}%`);
      conditions.push(`(cc.before_color_name ILIKE $${values.length} OR cc.after_color_name ILIKE $${values.length} OR cc.before_color_hex ILIKE $${values.length} OR cc.after_color_hex ILIKE $${values.length})`);
    }
    const where = conditions.join(" AND ");
    const base = `FROM color_changes cc JOIN batches b ON b.id = cc.batch_id JOIN materials m ON m.id = b.material_id
      LEFT JOIN projects p ON p.id = cc.project_id WHERE ${where}`;
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count ${base}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT ${LIST_COLUMNS}
         ${base} ORDER BY cc.occurred_at DESC, cc.seq DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/color-changes/:id", async (request) => {
    const result = await pool.query(
      `SELECT cc.id, cc.batch_id AS "batchId", b.batch_code AS "batchCode", m.name AS "materialName",
              cc.project_id AS "projectId", cc.consumption_id AS "consumptionId",
              cc.change_type AS "changeType", cc.before_color_name AS "beforeColorName",
              cc.before_color_hex AS "beforeColorHex", cc.before_color_explicit AS "beforeColorExplicit",
              cc.after_color_name AS "afterColorName", cc.after_color_hex AS "afterColorHex",
              cc.affected_quantity::text AS "affectedQuantity", cc.stock_unit AS "stockUnit",
              cc.temperature_c::text AS "temperatureC", cc.humidity_percent::text AS "humidityPercent",
              cc.ph_value::text AS "phValue", cc.environment_notes AS "environmentNotes",
              cc.occurred_at AS "occurredAt", cc.seq, cc.notes, cc.created_at AS "createdAt",
              cc.deleted_at AS "deletedAt"
         FROM color_changes cc JOIN batches b ON b.id = cc.batch_id JOIN materials m ON m.id = b.material_id
        WHERE cc.id = $1`,
      [request.params.id]
    );
    if (!result.rows[0]) throw new AppError(404, "NOT_FOUND", "颜色变化记录不存在");
    const attachments = await pool.query(
      `SELECT id, original_name AS "originalName", mime_type AS "mimeType", byte_size::text AS "byteSize",
              phase, created_at AS "createdAt"
         FROM attachments WHERE owner_type = 'COLOR_CHANGE' AND owner_id = $1 ORDER BY phase, created_at DESC`,
      [request.params.id]
    );
    const headId = result.rows[0].deletedAt
      ? null
      : await getBatchHeadColorChangeId(pool, result.rows[0].batchId as string);
    return { data: { ...result.rows[0], isCurrent: result.rows[0].id === headId, attachments: attachments.rows } };
  });

  app.post("/color-changes", async (request, reply) => {
    const input = parseInput(colorChangeInputSchema, request.body) as ColorChangeInputEntry & { batchId: string };
    const normalized = normalizeEntry(input);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const batch = await lockActiveBatch(client, input.batchId);
      const { projectId, consumptionId } = await resolveColorRelations(client, batch, normalized);
      const affectedQuantity = convertAffectedQuantity(normalized, batch.stockUnit);
      const [id] = await insertColorChanges(client, batch, [{ input: normalized, projectId, consumptionId, affectedQuantity }]);
      const headId = await getBatchHeadColorChangeId(client, batch.id);
      const data = await loadCreatedColorChange(client, id!);
      await writeAudit(client, {
        actorUserId: user.id, action: "COLOR_CHANGE", entityType: "COLOR_CHANGE", entityId: id,
        afterData: { ...data, isCurrent: id === headId }, requestId: request.id
      });
      return { ...data, isCurrent: id === headId };
    });
    return reply.status(201).send({ data: created });
  });

  // 批量补录：同一批次多条历史颜色变化在一个事务内按发生时间整体归位，
  // 正序或倒序提交都不影响链尾，当前色始终唯一。
  app.post("/color-changes/bulk", async (request, reply) => {
    const input = parseInput(colorChangeBulkSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const batch = await lockActiveBatch(client, input.batchId);
      const prepared: Array<{ input: ColorChangeInputEntry; projectId: string | null; consumptionId: string | null; affectedQuantity: string | null }> = [];
      for (const rawEntry of input.entries as ColorChangeInputEntry[]) {
        const entry = normalizeEntry(rawEntry as ColorChangeInputEntry);
        const relations = await resolveColorRelations(client, batch, entry);
        prepared.push({ input: entry, ...relations, affectedQuantity: convertAffectedQuantity(entry, batch.stockUnit) });
      }
      const ids = await insertColorChanges(client, batch, prepared);
      const headId = await getBatchHeadColorChangeId(client, batch.id);
      const data = [];
      for (const id of ids) {
        const row = await loadCreatedColorChange(client, id);
        data.push({ ...row, isCurrent: id === headId });
      }
      await writeAudit(client, {
        actorUserId: user.id, action: "COLOR_CHANGE_BULK", entityType: "BATCH", entityId: batch.id,
        afterData: { count: ids.length, ids, headColorChangeId: headId }, requestId: request.id
      });
      return { batchId: batch.id, headColorChangeId: headId, data };
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/color-changes/:id", async (request) => {
    const patch = parseInput(colorChangePatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query("SELECT * FROM color_changes WHERE id = $1 FOR UPDATE", [request.params.id]);
      if (!before.rows[0]) throw new AppError(404, "NOT_FOUND", "颜色变化记录不存在");
      if (before.rows[0].deleted_at) throw new AppError(409, "COLOR_CHANGE_DELETED", "已删除的误录记录不能修改");
      await lockActiveBatch(client, before.rows[0].batch_id);
      const result = await client.query(
        `UPDATE color_changes SET
          notes = CASE WHEN $1::boolean THEN $2 ELSE notes END,
          environment_notes = CASE WHEN $3::boolean THEN $4 ELSE environment_notes END
         WHERE id = $5 RETURNING *`,
        ["notes" in patch, ("notes" in patch ? patch.notes : null) || null,
         "environmentNotes" in patch, ("environmentNotes" in patch ? patch.environmentNotes : null) || null,
         request.params.id]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "COLOR_CHANGE", entityId: request.params.id, beforeData: before.rows[0], afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  // 删除误录采用软删除：行保留（时间链不被物理破坏、审计与导出仍可追溯），
  // 随后重排链上推断颜色并重算当前色，前后衔接自动修复。
  app.delete<{ Params: { id: string } }>("/color-changes/:id", async (request, reply) => {
    const user = (request as AuthenticatedRequest).authUser;
    await withTransaction(async (client) => {
      const current = await client.query("SELECT * FROM color_changes WHERE id = $1 FOR UPDATE", [request.params.id]);
      const row = current.rows[0];
      if (!row) throw new AppError(404, "NOT_FOUND", "颜色变化记录不存在");
      if (row.deleted_at) throw new AppError(409, "COLOR_CHANGE_DELETED", "该误录记录已删除");
      await lockActiveBatch(client, row.batch_id);
      const used = await client.query("SELECT 1 FROM attachments WHERE owner_type = 'COLOR_CHANGE' AND owner_id = $1 LIMIT 1", [request.params.id]);
      if (used.rowCount) throw new AppError(409, "COLOR_CHANGE_HAS_ATTACHMENTS", "请先删除该记录的前后对比照片");
      await client.query(
        "UPDATE color_changes SET deleted_at = now() WHERE id = $1",
        [request.params.id]
      );
      await repairColorChain(client, row.batch_id);
      await writeAudit(client, {
        actorUserId: user.id, action: "DELETE", entityType: "COLOR_CHANGE", entityId: request.params.id,
        beforeData: { id: row.id, batchId: row.batch_id, seq: row.seq, afterColorName: row.after_color_name, occurredAt: row.occurred_at },
        requestId: request.id
      });
    });
    return reply.status(204).send();
  });
}
