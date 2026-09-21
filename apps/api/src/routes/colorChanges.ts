import type { FastifyInstance } from "fastify";
import {
  colorChangeBatchSchema,
  colorChangeInputSchema,
  colorChangePatchSchema,
  colorChangeVoidSchema
} from "@handcraft/contracts";
import type { AuthenticatedRequest } from "../lib/auth.js";
import { pool, withTransaction } from "../lib/db.js";
import { AppError } from "../lib/errors.js";
import { pageMeta, parsePagination } from "../lib/pagination.js";
import { parseInput } from "../lib/validation.js";
import { writeAudit } from "../lib/audit.js";
import {
  assertMaterialActive,
  backfillColorChanges,
  insertColorChange,
  lockActiveBatch,
  recalculateCurrentColor
} from "../lib/colorTimeline.js";

type Query = Record<string, string | undefined>;

const COLOR_SELECT = `cc.id, cc.batch_id AS "batchId", b.batch_code AS "batchCode", m.name AS "materialName",
       cc.project_id AS "projectId", p.name AS "projectName", cc.consumption_id AS "consumptionId",
       cc.change_type AS "changeType", cc.before_color_name AS "beforeColorName", cc.before_color_hex AS "beforeColorHex",
       cc.after_color_name AS "afterColorName", cc.after_color_hex AS "afterColorHex",
       cc.affected_quantity::text AS "affectedQuantity", cc.stock_unit AS "stockUnit",
       cc.temperature_c::text AS "temperatureC", cc.humidity_percent::text AS "humidityPercent",
       cc.ph_value::text AS "phValue", cc.environment_notes AS "environmentNotes", cc.occurred_at AS "occurredAt",
       cc.notes, cc.seq, cc.voided_at AS "voidedAt", cc.void_reason AS "voidReason", cc.created_at AS "createdAt"`;

function buildListConditions(requestQuery: Query, values: unknown[]): string[] {
  const conditions = ["1 = 1"];
  for (const [key, column] of [["batchId", "cc.batch_id"], ["projectId", "cc.project_id"], ["consumptionId", "cc.consumption_id"]] as const) {
    if (requestQuery[key]) {
      values.push(requestQuery[key]);
      conditions.push(`${column} = $${values.length}::uuid`);
    }
  }
  if (requestQuery.type) {
    values.push(requestQuery.type);
    conditions.push(`cc.change_type = $${values.length}::color_change_type`);
  }
  if (requestQuery.includeVoided !== "true") {
    conditions.push("cc.voided_at IS NULL");
  }
  if (requestQuery.color?.trim()) {
    values.push(`%${requestQuery.color.trim()}%`);
    conditions.push(`(cc.before_color_name ILIKE $${values.length} OR cc.after_color_name ILIKE $${values.length} OR cc.before_color_hex ILIKE $${values.length} OR cc.after_color_hex ILIKE $${values.length})`);
  }
  return conditions;
}

export async function colorChangeRoutes(app: FastifyInstance): Promise<void> {
  app.get<{ Querystring: Query }>("/color-changes", async (request) => {
    const { page, pageSize, offset } = parsePagination(request.query);
    const values: unknown[] = [];
    const where = buildListConditions(request.query, values).join(" AND ");
    const base = `FROM color_changes cc JOIN batches b ON b.id = cc.batch_id JOIN materials m ON m.id = b.material_id
      LEFT JOIN projects p ON p.id = cc.project_id WHERE ${where}`;
    const total = await pool.query<{ count: string }>(`SELECT count(*)::text AS count ${base}`, values);
    values.push(pageSize, offset);
    const rows = await pool.query(
      `SELECT ${COLOR_SELECT} ${base} ORDER BY cc.occurred_at DESC, cc.seq DESC LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values
    );
    return { data: rows.rows, meta: pageMeta(page, pageSize, Number(total.rows[0]?.count ?? 0)) };
  });

  app.get<{ Params: { id: string } }>("/color-changes/:id", async (request) => {
    const result = await pool.query(
      `SELECT cc.*, b.batch_code AS "batchCode", m.name AS "materialName",
              vu.display_name AS "voidedByName"
         FROM color_changes cc
         JOIN batches b ON b.id = cc.batch_id
         JOIN materials m ON m.id = b.material_id
         LEFT JOIN users vu ON vu.id = cc.voided_by
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
    return { data: { ...result.rows[0], attachments: attachments.rows } };
  });

  app.post("/color-changes", async (request, reply) => {
    const input = parseInput(colorChangeInputSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const batch = await lockActiveBatch(client, input.batchId);
      await assertMaterialActive(client, batch.material_id);
      const row = await insertColorChange(client, batch, input);
      const { changed } = await recalculateCurrentColor(client, input.batchId);
      const payload = { ...row, isCurrent: changed, currentColorChanged: changed };
      await writeAudit(client, {
        actorUserId: user.id, action: "COLOR_CHANGE", entityType: "COLOR_CHANGE", entityId: row.id,
        afterData: payload, requestId: request.id
      });
      return payload;
    });
    return reply.status(201).send({ data: created });
  });

  // 批量补录：整批在同一事务内完成，按发生时间归并重排时间链，
  // 无论录入顺序（包括完全倒序）如何，最终当前色唯一且确定。
  app.post("/color-changes/batch", async (request, reply) => {
    const input = parseInput(colorChangeBatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    const created = await withTransaction(async (client) => {
      const batch = await lockActiveBatch(client, input.batchId);
      await assertMaterialActive(client, batch.material_id);

      const result = await backfillColorChanges(client, batch, input.changes, { validateKeys: true });
      const newRows = result.rows as Array<Record<string, unknown>>;
      const byInputIndex = new Map(newRows.map((row) => [Number(row.inputIndex), row]));
      const changes = input.changes.map((_, inputIndex) => byInputIndex.get(inputIndex));

      await writeAudit(client, {
        actorUserId: user.id, action: "COLOR_CHANGE_BATCH", entityType: "BATCH", entityId: input.batchId,
        afterData: { count: result.count, currentColorChanged: result.currentColorChanged, changeIds: newRows.map((r) => r.id) },
        requestId: request.id
      });
      return { count: result.count, currentColorChanged: result.currentColorChanged, changes };
    });
    return reply.status(201).send({ data: created });
  });

  app.patch<{ Params: { id: string } }>("/color-changes/:id", async (request) => {
    const patch = parseInput(colorChangePatchSchema, request.body);
    const user = (request as AuthenticatedRequest).authUser;
    return withTransaction(async (client) => {
      const before = await client.query(
        `SELECT cc.*, b.status AS batch_status FROM color_changes cc
           JOIN batches b ON b.id = cc.batch_id WHERE cc.id = $1 FOR UPDATE OF cc`,
        [request.params.id]
      );
      if (!before.rows[0]) throw new AppError(404, "NOT_FOUND", "颜色变化记录不存在");
      if (before.rows[0].batch_status === "ARCHIVED") throw new AppError(409, "BATCH_ARCHIVED", "批次已归档，颜色记录为只读");
      if (before.rows[0].voided_at) throw new AppError(409, "COLOR_CHANGE_VOIDED", "已作废记录不能修改");
      const notes = "notes" in patch ? patch.notes : null;
      const environmentNotes = "environmentNotes" in patch ? patch.environmentNotes : null;
      const result = await client.query(
        `UPDATE color_changes SET
          notes = CASE WHEN $1::boolean THEN $2 ELSE notes END,
          environment_notes = CASE WHEN $3::boolean THEN $4 ELSE environment_notes END
         WHERE id = $5 RETURNING *`,
        ["notes" in patch, notes || null, "environmentNotes" in patch, environmentNotes || null, request.params.id]
      );
      await writeAudit(client, { actorUserId: user.id, action: "UPDATE", entityType: "COLOR_CHANGE", entityId: request.params.id, beforeData: before.rows[0], afterData: result.rows[0], requestId: request.id });
      return { data: result.rows[0] };
    });
  });

  // 作废误录：不物理删除，行、附件与审计全部保留，时间链不被破坏。
  // 作废任意一条（含中间插入的历史记录）后，当前色按 (occurred_at, seq) 重新计算。
  async function voidColorChange(params: { id: string; reason: string; requestId: string; userId: string; idempotent?: boolean }) {
    return withTransaction(async (client) => {
      const lookup = await client.query<{ batch_id: string }>(
        "SELECT batch_id FROM color_changes WHERE id = $1",
        [params.id]
      );
      if (!lookup.rows[0]) throw new AppError(404, "NOT_FOUND", "颜色变化记录不存在");
      await lockActiveBatch(client, lookup.rows[0].batch_id);
      const current = await client.query("SELECT * FROM color_changes WHERE id = $1 FOR UPDATE", [params.id]);
      if (!current.rows[0]) throw new AppError(404, "NOT_FOUND", "颜色变化记录不存在");
      if (current.rows[0].voided_at) {
        if (params.idempotent) return { ...current.rows[0], currentColorChanged: false, alreadyVoided: true };
        throw new AppError(409, "COLOR_CHANGE_VOIDED", "该记录已经作废");
      }

      const result = await client.query(
        `UPDATE color_changes
            SET voided_at = now(), voided_by = $2, void_reason = $3
          WHERE id = $1
         RETURNING *`,
        [params.id, params.userId, params.reason]
      );
      const { changed } = await recalculateCurrentColor(client, current.rows[0].batch_id);
      await writeAudit(client, {
        actorUserId: params.userId, action: "VOID", entityType: "COLOR_CHANGE", entityId: params.id,
        beforeData: current.rows[0], afterData: { ...result.rows[0], currentColorChanged: changed },
        requestId: params.requestId
      });
      return { ...result.rows[0], currentColorChanged: changed, alreadyVoided: false };
    });
  }

  app.post<{ Params: { id: string } }>("/color-changes/:id/void", async (request, reply) => {
    const body = parseInput(colorChangeVoidSchema, request.body ?? {});
    const user = (request as AuthenticatedRequest).authUser;
    const data = await voidColorChange({ id: request.params.id, reason: body.reason, requestId: request.id, userId: user.id });
    return reply.status(200).send({ data });
  });

  // DELETE 保留为幂等作废入口：不接收正文时以“误录”为原因，绝不物理删除。
  app.delete<{ Params: { id: string } }>("/color-changes/:id", async (request, reply) => {
    const user = (request as AuthenticatedRequest).authUser;
    await voidColorChange({ id: request.params.id, reason: "误录作废", requestId: request.id, userId: user.id, idempotent: true });
    return reply.status(204).send();
  });
}
