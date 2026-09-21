<script setup lang="ts">
import { computed, onMounted, reactive, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";
import { movementLabels, statusLabels, type Project } from "@/types";
import { createIdempotencyKey } from "@/lib/idempotency";
import { localDateTimeValue } from "@/lib/dates";
import AttachmentPanel from "@/components/AttachmentPanel.vue";
import ColorEvidence from "@/components/ColorEvidence.vue";

const route = useRoute();
const router = useRouter();
const loading = ref(true);
const saving = ref(false);
const batch = ref<any>(null);
const projects = ref<Project[]>([]);
const adjustmentVisible = ref(false);
const colorVisible = ref(false);
const batchColorVisible = ref(false);
const batchSaving = ref(false);
const adjustment = reactive({ direction: "OUT", quantity: "", unit: "", reason: "" });
const colorForm = reactive({ projectId: "", changeType: "OTHER", afterColorName: "", afterColorHex: "", affectedQuantity: "", unit: "", occurredAt: localDateTimeValue(), environmentNotes: "", notes: "" });

type BackfillRow = {
  key: string;
  occurredAt: string;
  changeType: string;
  afterColorName: string;
  afterColorHex: string;
  notes: string;
};
function emptyBackfillRow(occurredAt = localDateTimeValue()): BackfillRow {
  return { key: Math.random().toString(36).slice(2, 10), occurredAt, changeType: "OTHER", afterColorName: "", afterColorHex: "", notes: "" };
}
const backfillRows = ref<BackfillRow[]>([emptyBackfillRow()]);

const activeColorChanges = computed(() => (batch.value?.colorChanges ?? []).filter((item: any) => !item.voidedAt));
const voidedColorChanges = computed(() => (batch.value?.colorChanges ?? []).filter((item: any) => item.voidedAt));

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
    const response = await request<{ data: { currentColorChanged: boolean } }>("/color-changes", {
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
    ElMessage.success(response.data.currentColorChanged ? "颜色变化已记录，当前颜色已更新" : "历史颜色已补录，当前颜色未改变");
    colorVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "颜色记录失败");
  } finally {
    saving.value = false;
  }
}

function openBatchColorDialog() {
  backfillRows.value = [emptyBackfillRow()];
  batchColorVisible.value = true;
}

function addBackfillRow() {
  const last = backfillRows.value[backfillRows.value.length - 1];
  backfillRows.value.push(emptyBackfillRow(last?.occurredAt || localDateTimeValue()));
}

function removeBackfillRow(index: number) {
  if (backfillRows.value.length === 1) {
    ElMessage.warning("批量补录至少保留一条");
    return;
  }
  backfillRows.value.splice(index, 1);
}

// 录入顺序不影响结果：服务端按发生时间归并重排时间链，即使整批倒序粘贴也会得到唯一当前色
async function submitBatchColors() {
  const rows = backfillRows.value;
  for (const [index, row] of rows.entries()) {
    if (!row.occurredAt) {
      ElMessage.error(`第 ${index + 1} 行缺少发生时间`);
      return;
    }
    if (!row.afterColorName.trim()) {
      ElMessage.error(`第 ${index + 1} 行缺少变化后颜色名称`);
      return;
    }
  }
  batchSaving.value = true;
  try {
    const response = await request<{ data: { count: number; currentColorChanged: boolean } }>("/color-changes/batch", {
      method: "POST",
      body: {
        batchId: batch.value.id,
        changes: rows.map((row) => ({
          key: row.key,
          changeType: row.changeType,
          afterColorName: row.afterColorName,
          afterColorHex: row.afterColorHex || null,
          occurredAt: new Date(row.occurredAt).toISOString(),
          notes: row.notes || null
        }))
      }
    });
    ElMessage.success(`已补录 ${response.data.count} 条颜色变化，${response.data.currentColorChanged ? "当前颜色已重算" : "当前颜色未变"}`);
    batchColorVisible.value = false;
    await load();
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "批量补录失败");
  } finally {
    batchSaving.value = false;
  }
}

// 作废不是删除：记录、证据和时间链全部保留，只把该条标记为误录并重算当前色
async function voidColorChange(item: any) {
  try {
    const { value } = await ElMessageBox.prompt("作废后该记录与照片仍会保留在时间线中，请输入作废原因（至少 3 个字）", "作废误录颜色变化", {
      confirmButtonText: "确认作废",
      cancelButtonText: "取消",
      inputPattern: /^.{3,300}$/,
      inputErrorMessage: "原因长度需为 3 到 300 个字",
      type: "warning"
    });
    await request(`/color-changes/${item.id}/void`, { method: "POST", body: { reason: value } });
    ElMessage.success("记录已作废，当前色已重算");
    await load();
  } catch (error: any) {
    if (error === "cancel" || error === "close") return;
    ElMessage.error(error instanceof ApiError ? error.message : "作废失败");
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
          <el-button v-if="batch.status !== 'ARCHIVED'" @click="openBatchColorDialog">批量补录颜色</el-button>
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
          <div style="display:flex;justify-content:space-between;align-items:center">
            <h2 style="margin:0">颜色时间线</h2>
            <el-button v-if="batch.status !== 'ARCHIVED'" link type="primary" size="small" @click="openBatchColorDialog">批量补录</el-button>
          </div>
          <el-alert
            v-if="batch.status === 'ARCHIVED'"
            title="批次已归档：颜色时间线与前后证据均为只读，不能补录、改色或作废。"
            type="warning" :closable="false" style="margin:12px 0" />
          <el-timeline v-if="activeColorChanges.length">
            <el-timeline-item v-for="item in activeColorChanges" :key="item.id" :timestamp="new Date(item.occurredAt).toLocaleString()">
              <strong>{{ item.beforeColorName || "未记录" }} → {{ item.afterColorName }}</strong>
              <div><span v-if="item.afterColorHex" class="color-dot" :style="{ background: item.afterColorHex }" />{{ item.notes || "无备注" }}</div>
              <div style="display:flex;gap:16px;margin-top:6px;flex-wrap:wrap">
                <ColorEvidence :color-change-id="item.id" phase="BEFORE" :read-only="batch.status === 'ARCHIVED'" />
                <ColorEvidence :color-change-id="item.id" phase="AFTER" :read-only="batch.status === 'ARCHIVED'" />
              </div>
              <el-button v-if="batch.status !== 'ARCHIVED'" link type="danger" size="small" @click="voidColorChange(item)">作废误录</el-button>
            </el-timeline-item>
          </el-timeline>
          <el-empty v-else description="还没有颜色变化记录" :image-size="70" />
          <template v-if="voidedColorChanges.length">
            <h3 style="margin:16px 0 8px;font-size:13px;color:#9a8570">已作废记录（时间链保留）</h3>
            <el-timeline>
              <el-timeline-item v-for="item in voidedColorChanges" :key="item.id" :timestamp="new Date(item.occurredAt).toLocaleString()" type="info">
                <span style="text-decoration:line-through;color:#9a8570">{{ item.beforeColorName || "未记录" }} → {{ item.afterColorName }}</span>
                <div style="font-size:12px;color:#9a8570">作废原因：{{ item.voidReason }}</div>
              </el-timeline-item>
            </el-timeline>
          </template>
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

    <el-dialog v-model="batchColorVisible" title="批量补录颜色变化" width="860px">
      <el-alert type="info" :closable="false" style="margin-bottom:12px"
        title="按实际发生时间补录即可，与粘贴顺序无关：服务端会归并重排时间链，即使整批倒序录入，当前颜色仍唯一确定。补录完成后照片证据可在时间线各条目上分别上传（变化前/变化后）。" />
      <el-table :data="backfillRows" size="small">
        <el-table-column label="发生时间" width="210">
          <template #default="{ row }"><el-date-picker v-model="row.occurredAt" type="datetime" value-format="YYYY-MM-DDTHH:mm:ss" size="small" style="width:100%" /></template>
        </el-table-column>
        <el-table-column label="类型" width="120">
          <template #default="{ row }">
            <el-select v-model="row.changeType" size="small">
              <el-option value="OXIDATION" label="氧化" /><el-option value="DYE_BATH" label="染色" />
              <el-option value="FINISHING" label="表面处理" /><el-option value="GLAZE" label="施釉" />
              <el-option value="PATINA" label="锈化" /><el-option value="WEATHERING" label="风化" />
              <el-option value="MIXING" label="混合" /><el-option value="OTHER" label="其他" />
            </el-select>
          </template>
        </el-table-column>
        <el-table-column label="变化后颜色名称" min-width="140">
          <template #default="{ row }"><el-input v-model="row.afterColorName" size="small" placeholder="如：靛蓝" /></template>
        </el-table-column>
        <el-table-column label="色值" width="130">
          <template #default="{ row }"><el-input v-model="row.afterColorHex" size="small" placeholder="#1E3A8A" /></template>
        </el-table-column>
        <el-table-column label="备注" min-width="120">
          <template #default="{ row }"><el-input v-model="row.notes" size="small" /></template>
        </el-table-column>
        <el-table-column label="" width="48">
          <template #default="{ $index }"><el-button link type="danger" size="small" @click="removeBackfillRow($index)">删</el-button></template>
        </el-table-column>
      </el-table>
      <el-button size="small" style="margin-top:10px" @click="addBackfillRow">+ 增加一行</el-button>
      <template #footer>
        <el-button @click="batchColorVisible = false">取消</el-button>
        <el-button type="primary" :loading="batchSaving" @click="submitBatchColors">整批提交（{{ backfillRows.length }} 条）</el-button>
      </template>
    </el-dialog>
  </div>
</template>
