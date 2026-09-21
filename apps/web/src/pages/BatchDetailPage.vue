<script setup lang="ts">
import { onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { movementLabels, statusLabels, type Project } from "@/types";
import { createIdempotencyKey } from "@/lib/idempotency";
import { localDateTimeValue } from "@/lib/dates";
import AttachmentPanel from "@/components/AttachmentPanel.vue";

type ColorAttachment = { id: string; originalName: string; mimeType: string; byteSize: string; phase?: string; createdAt: string };
type ColorChangeRow = {
  id: string;
  changeType: string;
  beforeColorName: string | null;
  beforeColorHex: string | null;
  afterColorName: string;
  afterColorHex: string | null;
  occurredAt: string;
  notes: string | null;
  isCurrent: boolean;
  attachments: ColorAttachment[];
};

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const batch = ref<any>(null);
const projects = ref<Project[]>([]);
const adjustmentVisible = ref(false);
const colorVisible = ref(false);
const bulkVisible = ref(false);
const evidenceVisible = ref(false);
const adjustment = reactive({ direction: "OUT", quantity: "", unit: "", reason: "" });
const colorForm = reactive({ projectId: "", changeType: "OTHER", afterColorName: "", afterColorHex: "", affectedQuantity: "", unit: "", occurredAt: localDateTimeValue(), environmentNotes: "", notes: "" });
const bulkEntries = ref<Array<Record<string, string>>>([]);
const evidenceTarget = ref<{ id: string; phase: "BEFORE" | "AFTER"; attachments: ColorAttachment[] } | null>(null);

function emptyBulkEntry(): Record<string, string> {
  return {
    changeType: "OTHER",
    afterColorName: "",
    afterColorHex: "",
    affectedQuantity: "",
    occurredAt: localDateTimeValue(),
    environmentNotes: "",
    notes: ""
  };
}

async function load() {
  loading.value = true;
  try {
    const [response, projectResponse] = await Promise.all([
      request<{ data: any }>(`/batches/${route.params.id}`),
      request<{ data: Project[] }>("/projects?pageSize=100")
    ]);
    batch.value = response.data;
    projects.value = projectResponse.data.filter((project) => ["PLANNED", "IN_PROGRESS", "COMPLETED"].includes(project.status));
    adjustment.unit = response.data.stockUnit;
    colorForm.unit = response.data.stockUnit;
    if (evidenceTarget.value) {
      const stillThere = (response.data.colorChanges as ColorChangeRow[]).find((item) => item.id === evidenceTarget.value?.id);
      if (stillThere) evidenceTarget.value = { ...evidenceTarget.value, attachments: stillThere.attachments };
    }
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "批次加载失败");
  } finally {
    loading.value = false;
  }
}

function openAdjustmentDialog() {
  Object.assign(adjustment, { direction: "OUT", quantity: "", unit: batch.value?.stockUnit || "", reason: "" });
  adjustmentVisible.value = true;
}

async function submitAdjustment() {
  if (!adjustment.quantity || adjustment.reason.trim().length < 3) {
    ElMessage.error("请填写调整数量和至少 3 个字的调整原因");
    return;
  }
  saving.value = true;
  try {
    await request(`/batches/${batch.value.id}/adjustments`, {
      method: "POST",
      headers: { "Idempotency-Key": createIdempotencyKey() },
      body: { ...adjustment, version: batch.value.version }
    });
    ElMessage.success("库存调整已入账");
    adjustmentVisible.value = false;
    Object.assign(adjustment, { direction: "OUT", quantity: "", reason: "" });
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "库存调整失败");
  } finally {
    saving.value = false;
  }
}

function openColorDialog() {
  Object.assign(colorForm, {
    projectId: "",
    changeType: "OTHER",
    afterColorName: "",
    afterColorHex: "",
    affectedQuantity: "",
    unit: batch.value?.stockUnit || "",
    occurredAt: localDateTimeValue(),
    environmentNotes: "",
    notes: ""
  });
  colorVisible.value = true;
}

async function submitColor() {
  if (!colorForm.afterColorName.trim()) {
    ElMessage.error("请填写变化后的颜色名称");
    return;
  }
  if (!colorForm.occurredAt) {
    ElMessage.error("请选择颜色变化发生时间");
    return;
  }
  saving.value = true;
  try {
    const response = await request<{ data: { isCurrent: boolean } }>("/color-changes", {
      method: "POST",
      body: {
        batchId: batch.value.id,
        projectId: colorForm.projectId || null,
        changeType: colorForm.changeType,
        afterColorName: colorForm.afterColorName,
        afterColorHex: colorForm.afterColorHex || null,
        affectedQuantity: colorForm.affectedQuantity || null,
        unit: colorForm.affectedQuantity ? colorForm.unit : null,
        environmentNotes: colorForm.environmentNotes || null,
        occurredAt: new Date(colorForm.occurredAt).toISOString(),
        notes: colorForm.notes || null
      }
    });
    ElMessage.success(response.data.isCurrent ? "颜色变化已记录，当前颜色已更新" : "历史颜色已记录，当前颜色未改变");
    colorVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "颜色记录失败");
  } finally {
    saving.value = false;
  }
}

function openBulkDialog() {
  bulkEntries.value = [emptyBulkEntry(), emptyBulkEntry(), emptyBulkEntry()];
  bulkVisible.value = true;
}

function addBulkRow() {
  if (bulkEntries.value.length >= 100) {
    ElMessage.warning("单次最多补录 100 条");
    return;
  }
  bulkEntries.value.push(emptyBulkEntry());
}

function removeBulkRow(index: number) {
  bulkEntries.value.splice(index, 1);
}

async function submitBulk() {
  const entries = [];
  for (const entry of bulkEntries.value) {
    if (!entry.afterColorName?.trim() || !entry.occurredAt) continue;
    entries.push({
      changeType: entry.changeType,
      afterColorName: entry.afterColorName.trim(),
      afterColorHex: entry.afterColorHex || null,
      affectedQuantity: entry.affectedQuantity || null,
      unit: entry.affectedQuantity ? batch.value.stockUnit : null,
      environmentNotes: entry.environmentNotes || null,
      occurredAt: new Date(entry.occurredAt).toISOString(),
      notes: entry.notes || null
    });
  }
  if (!entries.length) {
    ElMessage.error("至少填写一条带颜色名称和发生时间的记录");
    return;
  }
  // 提交内容中只要存在早于当前的记录，就按“历史补录”口径提示。
  const outOfOrder = entries.some((entry) => Date.parse(entry.occurredAt) < Date.now() - 60_000);
  saving.value = true;
  try {
    await request<{ data: { headColorChangeId: string | null } }>("/color-changes/bulk", {
      method: "POST",
      body: { batchId: batch.value.id, entries }
    });
    bulkVisible.value = false;
    ElMessage.success(
      outOfOrder
        ? `已补录 ${entries.length} 条历史颜色，系统已按发生时间重排，当前色唯一`
        : `已补录 ${entries.length} 条颜色变化，当前颜色已更新`
    );
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "批量补录失败");
  } finally {
    saving.value = false;
  }
}

function openEvidence(item: ColorChangeRow, phase: "BEFORE" | "AFTER") {
  evidenceTarget.value = { id: item.id, phase, attachments: item.attachments.filter((attachment) => attachment.phase === phase) };
  evidenceVisible.value = true;
}

async function deleteColorChange(item: ColorChangeRow) {
  try {
    await ElMessageBox.confirm(
      "删除采用软删除并保留审计痕迹，时间链会自动重排、当前色会重新计算。有对比照片时需先删照片。",
      `删除误录：${item.afterColorName}`,
      { type: "warning", confirmButtonText: "确认删除误录", cancelButtonText: "取消" }
    );
  } catch {
    return;
  }
  try {
    await request(`/color-changes/${item.id}`, { method: "DELETE" });
    ElMessage.success("误录已删除，颜色时间链已修复");
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "删除失败");
  }
}

async function archive() {
  try {
    await ElMessageBox.confirm("只有余额为 0 的批次可以归档，历史流水会保留。", "归档批次", { type: "warning" });
    await request(`/batches/${batch.value.id}/archive`, { method: "POST" });
    ElMessage.success("批次已归档");
    await router.push("/batches");
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof ApiError ? error.message : "归档失败");
  }
}

onMounted(load);
</script>

<template>
  <div v-loading="loading">
    <template v-if="batch">
      <header class="page-header">
        <div><h1>{{ batch.materialName }}</h1><p>{{ batch.batchCode || "无批次号" }} · {{ batch.sourceName || batch.sourceNote || "来源不明" }}</p></div>
        <div>
          <el-button v-if="batch.status === 'ACTIVE'" @click="router.push({ path: '/consumptions', query: { batchId: batch.id, create: '1' } })">记录消耗</el-button>
          <el-button v-if="batch.status !== 'ARCHIVED'" @click="openAdjustmentDialog()">库存调整</el-button>
          <el-button v-if="batch.status !== 'ARCHIVED'" type="primary" @click="openColorDialog()">记录颜色变化</el-button>
          <el-button v-if="batch.status !== 'ARCHIVED'" plain @click="openBulkDialog">批量补录历史色</el-button>
          <el-button v-if="batch.status === 'DEPLETED'" type="danger" plain @click="archive">归档</el-button>
        </div>
      </header>
      <section class="stat-grid">
        <article class="stat-card"><small>剩余数量</small><strong>{{ batch.remainingQuantity }} {{ batch.stockUnit }}</strong></article>
        <article class="stat-card"><small>初始数量</small><strong>{{ batch.initialQuantity }} {{ batch.stockUnit }}</strong></article>
        <article class="stat-card"><small>当前颜色</small><strong><span v-if="batch.currentColorHex" class="color-dot" :style="{ background: batch.currentColorHex }" />{{ batch.currentColorName || "未记录" }}</strong></article>
        <article class="stat-card"><small>批次状态</small><strong>{{ statusLabels[batch.status] || batch.status }}</strong></article>
      </section>
      <section class="panel" style="margin-top:16px">
        <h2>批次信息</h2>
        <el-descriptions :column="3" border>
          <el-descriptions-item label="材料"><router-link :to="`/materials/${batch.materialId}`">{{ batch.materialName }}</router-link></el-descriptions-item>
          <el-descriptions-item label="入库日期">{{ batch.receivedAt }}</el-descriptions-item>
          <el-descriptions-item label="有效期">{{ batch.expiryAt || "无" }}</el-descriptions-item>
          <el-descriptions-item label="存放位置">{{ batch.locationName || "未指定" }}</el-descriptions-item>
          <el-descriptions-item label="成本">{{ batch.totalCost ? `${batch.totalCost} ${batch.currency || ""}` : "未记录" }}</el-descriptions-item>
          <el-descriptions-item label="输入单位">{{ batch.entryUnit }}</el-descriptions-item>
          <el-descriptions-item label="备注" :span="3">{{ batch.notes || "无" }}</el-descriptions-item>
        </el-descriptions>
      </section>

      <AttachmentPanel owner-type="BATCH" :owner-id="batch.id" :attachments="batch.attachments" @changed="load" />

      <div class="two-column">
        <section class="panel">
          <h2>库存流水</h2>
          <el-table :data="batch.movements" size="small">
            <el-table-column label="时间" width="170"><template #default="{ row }">{{ new Date(row.createdAt).toLocaleString() }}</template></el-table-column>
            <el-table-column label="类型" width="100"><template #default="{ row }">{{ movementLabels[row.type] || row.type }}</template></el-table-column>
            <el-table-column label="变化" width="120"><template #default="{ row }"><span class="amount">{{ row.signedQuantity }} {{ row.stockUnit }}</span></template></el-table-column>
            <el-table-column label="结余" width="120"><template #default="{ row }">{{ row.beforeQuantity }} → {{ row.afterQuantity }}</template></el-table-column>
            <el-table-column label="原因" prop="reason" min-width="120" />
          </el-table>
        </section>
        <section class="panel">
          <h2>颜色时间线</h2>
          <el-alert v-if="batch.status === 'ARCHIVED'" title="批次已归档，颜色记录只读：禁止改色、补录、删除或上传证据。" type="warning" show-icon :closable="false" style="margin-bottom:12px" />
          <el-timeline v-if="batch.colorChanges.length">
            <el-timeline-item v-for="item in batch.colorChanges" :key="item.id" :timestamp="new Date(item.occurredAt).toLocaleString()">
              <div style="display:flex;justify-content:space-between;gap:12px;align-items:flex-start">
                <div>
                  <strong>
                    <span v-if="item.beforeColorHex" class="color-dot" :style="{ background: item.beforeColorHex }" />
                    {{ item.beforeColorName || "未记录" }} →
                    <span v-if="item.afterColorHex" class="color-dot" :style="{ background: item.afterColorHex }" />
                    {{ item.afterColorName }}
                  </strong>
                  <el-tag v-if="item.isCurrent" size="small" type="success" effect="plain" style="margin-left:8px">当前色</el-tag>
                  <div style="color:#6b5a4a">{{ item.notes || "无备注" }}</div>
                </div>
                <div v-if="batch.status !== 'ARCHIVED'" style="flex-shrink:0;white-space:nowrap">
                  <el-button link type="primary" size="small" @click="openEvidence(item, 'BEFORE')">
                    变化前{{ item.attachments.filter((a: ColorAttachment) => a.phase === 'BEFORE').length ? ` (${item.attachments.filter((a: ColorAttachment) => a.phase === 'BEFORE').length})` : "" }}
                  </el-button>
                  <el-button link type="primary" size="small" @click="openEvidence(item, 'AFTER')">
                    变化后{{ item.attachments.filter((a: ColorAttachment) => a.phase === 'AFTER').length ? ` (${item.attachments.filter((a: ColorAttachment) => a.phase === 'AFTER').length})` : "" }}
                  </el-button>
                  <el-button link type="danger" size="small" @click="deleteColorChange(item)">删除误录</el-button>
                </div>
              </div>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-else description="还没有颜色变化记录" />
        </section>
      </div>
    </template>

    <el-dialog v-model="adjustmentVisible" title="库存调整" width="520px">
      <el-form label-position="top">
        <el-form-item label="方向"><el-radio-group v-model="adjustment.direction"><el-radio value="IN">盘增</el-radio><el-radio value="OUT">盘减</el-radio></el-radio-group></el-form-item>
        <el-form-item label="数量"><el-input v-model="adjustment.quantity" /></el-form-item>
        <el-form-item label="单位"><el-select v-model="adjustment.unit" style="width:100%"><el-option v-for="unit in ['g','kg','ml','l','mm','cm','m','m2','pcs']" :key="unit" :value="unit" :label="unit" /></el-select></el-form-item>
        <el-form-item label="原因" required><el-input v-model="adjustment.reason" type="textarea" placeholder="例如：月末盘点发现密封袋破损" /></el-form-item>
      </el-form>
      <template #footer><el-button @click="adjustmentVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="submitAdjustment">确认调整</el-button></template>
    </el-dialog>

    <el-dialog v-model="colorVisible" title="记录颜色变化" width="600px">
      <el-alert title="颜色变化只记录外观演变，不会自动改变库存数量。" type="info" show-icon :closable="false" style="margin-bottom:16px" />
      <el-form label-position="top">
        <div class="form-grid">
          <el-form-item label="关联项目（可选）"><el-select v-model="colorForm.projectId" clearable filterable style="width:100%"><el-option v-for="project in projects" :key="project.id" :value="project.id" :label="project.name" /></el-select></el-form-item>
          <el-form-item label="发生时间"><el-date-picker v-model="colorForm.occurredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" style="width:100%" /></el-form-item>
          <el-form-item label="变化类型"><el-select v-model="colorForm.changeType" style="width:100%"><el-option value="OXIDATION" label="氧化" /><el-option value="DYE_BATH" label="染色" /><el-option value="FINISHING" label="表面处理" /><el-option value="GLAZE" label="施釉" /><el-option value="PATINA" label="做旧/锈化" /><el-option value="WEATHERING" label="自然风化" /><el-option value="MIXING" label="混合" /><el-option value="OTHER" label="其他" /></el-select></el-form-item>
          <el-form-item label="影响数量（可选）"><el-input v-model="colorForm.affectedQuantity" /></el-form-item>
          <el-form-item label="变化后颜色名称" required><el-input v-model="colorForm.afterColorName" /></el-form-item>
          <el-form-item label="变化后颜色值"><div style="display:flex;gap:10px;width:100%"><el-color-picker v-model="colorForm.afterColorHex" /><el-input v-model="colorForm.afterColorHex" /></div></el-form-item>
          <el-form-item label="环境说明" class="full"><el-input v-model="colorForm.environmentNotes" placeholder="温度、湿度、pH 或工艺条件" /></el-form-item>
          <el-form-item label="备注" class="full"><el-input v-model="colorForm.notes" type="textarea" :rows="3" /></el-form-item>
        </div>
      </el-form>
      <template #footer><el-button @click="colorVisible = false">取消</el-button><el-button type="primary" :loading="saving" @click="submitColor">保存记录</el-button></template>
    </el-dialog>

    <el-dialog v-model="bulkVisible" title="批量补录历史颜色" width="860px">
      <el-alert type="info" show-icon :closable="false" style="margin-bottom:12px"
        title="按实际发生时间逐条补录即可，无需按顺序填写。提交顺序即使是倒序，系统也会按发生时间重排时间链，并唯一确定当前色。" />
      <el-table :data="bulkEntries" size="small" border>
        <el-table-column label="#" type="index" width="44" />
        <el-table-column label="发生时间" width="200">
          <template #default="{ row }"><el-date-picker v-model="row.occurredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" size="small" style="width:100%" /></template>
        </el-table-column>
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-select v-model="row.changeType" size="small">
              <el-option value="OXIDATION" label="氧化" /><el-option value="DYE_BATH" label="染色" /><el-option value="FINISHING" label="表面处理" />
              <el-option value="GLAZE" label="施釉" /><el-option value="PATINA" label="锈化" /><el-option value="WEATHERING" label="风化" />
              <el-option value="MIXING" label="混合" /><el-option value="OTHER" label="其他" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="颜色名称" min-width="120">
          <template #default="{ row }"><el-input v-model="row.afterColorName" size="small" placeholder="如：深红棕" /></template>
        </el-table-column>
        <el-table-column label="色值" width="130">
          <template #default="{ row }"><el-input v-model="row.afterColorHex" size="small" placeholder="#RRGGBB" /></template>
        </el-table-column>
        <el-table-column label="影响数量" width="100">
          <template #default="{ row }"><el-input v-model="row.affectedQuantity" size="small" :placeholder="batch.stockUnit" /></template>
        </el-table-column>
        <el-table-column label="备注" min-width="120">
          <template #default="{ row }"><el-input v-model="row.notes" size="small" /></template>
        </el-table-column>
        <el-table-column label="" width="50">
          <template #default="{ $index }"><el-button link type="danger" size="small" @click="removeBulkRow($index)">移除</el-button></template>
        </el-table-column>
      </el-table>
      <el-button size="small" plain style="margin-top:10px" @click="addBulkRow">+ 增加一条</el-button>
      <template #footer>
        <el-button @click="bulkVisible = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="submitBulk">补录并重排时间链</el-button>
      </template>
    </el-dialog>

    <el-dialog v-model="evidenceVisible" :title="evidenceTarget ? `${evidenceTarget.phase === 'BEFORE' ? '变化前' : '变化后'}证据照片` : '证据照片'" width="720px">
      <el-alert v-if="evidenceTarget?.phase === 'BEFORE'" type="info" show-icon :closable="false" style="margin-bottom:12px"
        title="变化前照片用于固定上一色；变化后照片固定本记录结果色。" />
      <AttachmentPanel
        v-if="evidenceTarget"
        owner-type="COLOR_CHANGE"
        :owner-id="evidenceTarget.id"
        :phase="evidenceTarget.phase"
        :attachments="evidenceTarget.attachments"
        :title="`${evidenceTarget.phase === 'BEFORE' ? '变化前' : '变化后'}照片`"
        @changed="load"
      />
      <template #footer><el-button type="primary" @click="evidenceVisible = false">完成</el-button></template>
    </el-dialog>
  </div>
</template>
