<script setup lang="ts">
import { onMounted, ref } from "vue";
import { ElMessage } from "element-plus";
import { request, ApiError } from "@/lib/api";

type Attachment = { id: string; originalName: string };
const props = defineProps<{ colorChangeId: string; phase: "BEFORE" | "AFTER"; readOnly: boolean }>();
const emit = defineEmits<{ changed: [] }>();
const attachments = ref<Attachment[]>([]);
const uploading = ref(false);
const loaded = ref(false);

async function fetchAttachments() {
  try {
    const response = await request<{ data: { attachments: Array<Attachment & { phase: string }> } }>(`/color-changes/${props.colorChangeId}`);
    attachments.value = response.data.attachments.filter((item) => item.phase === props.phase);
    loaded.value = true;
  } catch {
    // 时间线上证据加载失败不阻塞页面
  }
}

async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploading.value = true;
  try {
    const body = new FormData();
    body.append("ownerType", "COLOR_CHANGE");
    body.append("ownerId", props.colorChangeId);
    body.append("phase", props.phase);
    body.append("file", file);
    await request("/attachments", { method: "POST", body });
    ElMessage.success("证据照片已上传");
    await fetchAttachments();
    emit("changed");
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "证据上传失败");
  } finally {
    uploading.value = false;
    input.value = "";
  }
}

onMounted(fetchAttachments);
defineExpose({ reload: fetchAttachments });
</script>

<template>
  <div class="color-evidence">
    <div class="color-evidence-head">
      <span>{{ phase === "BEFORE" ? "变化前" : "变化后" }}证据（{{ attachments.length }}）</span>
      <label v-if="!readOnly" class="el-button el-button--small" :class="{ 'is-loading': uploading }">
        上传
        <input hidden type="file" accept="image/jpeg,image/png,image/webp" :disabled="uploading" @change="upload" />
      </label>
    </div>
    <el-popover v-if="loaded && attachments.length" placement="bottom-start" :width="320" trigger="click">
      <template #reference>
        <div class="color-evidence-thumbs">
          <img v-for="item in attachments.slice(0, 4)" :key="item.id" :src="`/api/v1/attachments/${item.id}`" :alt="item.originalName" />
          <span v-if="attachments.length > 4" class="color-evidence-more">+{{ attachments.length - 4 }}</span>
        </div>
      </template>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;max-height:320px;overflow:auto">
        <img v-for="item in attachments" :key="item.id" :src="`/api/v1/attachments/${item.id}`" :alt="item.originalName" style="width:100%;border-radius:6px" />
      </div>
    </el-popover>
    <span v-else-if="!attachments.length" class="color-evidence-empty">暂无</span>
  </div>
</template>

<style scoped>
.color-evidence { margin-top: 4px; }
.color-evidence-head { display: flex; align-items: center; gap: 8px; font-size: 12px; color: #8a6d4b; }
.color-evidence-thumbs { display: flex; align-items: center; gap: 4px; cursor: pointer; }
.color-evidence-thumbs img { width: 34px; height: 34px; object-fit: cover; border-radius: 5px; border: 1px solid #e4d8c6; }
.color-evidence-more { font-size: 12px; color: #8a6d4b; }
.color-evidence-empty { font-size: 12px; color: #b7a78e; }
</style>
