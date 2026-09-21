<script setup lang="ts">
import { ref } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import { request, ApiError } from "@/lib/api";

type Attachment = { id: string; originalName: string; mimeType: string; byteSize: string; phase?: string | null; createdAt: string };
const props = defineProps<{
  ownerType: "BATCH" | "PROJECT" | "COLOR_CHANGE" | "CONSUMPTION";
  ownerId: string;
  attachments: Attachment[];
  /** COLOR_CHANGE 证据必须标记变化前/变化后；其余归属不传 */
  phase?: "BEFORE" | "AFTER";
  title?: string;
  compact?: boolean;
}>();
const emit = defineEmits<{ changed: [] }>();
const uploading = ref(false);

async function upload(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  uploading.value = true;
  try {
    const body = new FormData();
    body.append("ownerType", props.ownerType);
    body.append("ownerId", props.ownerId);
    if (props.phase) body.append("phase", props.phase);
    body.append("file", file);
    await request("/attachments", { method: "POST", body });
    ElMessage.success("图片已上传");
    emit("changed");
  } catch (error) {
    ElMessage.error(error instanceof ApiError ? error.message : "上传失败");
  } finally {
    uploading.value = false;
    input.value = "";
  }
}

async function remove(id: string) {
  try {
    await ElMessageBox.confirm("确认永久删除这张图片？", "删除附件", { type: "warning" });
    await request(`/attachments/${id}`, { method: "DELETE" });
    ElMessage.success("附件已删除");
    emit("changed");
  } catch (error: any) {
    if (error !== "cancel" && error !== "close") ElMessage.error(error instanceof ApiError ? error.message : "删除失败");
  }
}
</script>

<template>
  <section :class="compact ? 'evidence-panel' : 'panel'">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px">
      <h2 :style="compact ? 'margin:0;font-size:14px' : 'margin:0'">{{ title || "图片附件" }}{{ phase === "BEFORE" ? "（变化前证据）" : phase === "AFTER" ? "（变化后证据）" : "" }}</h2>
      <label class="el-button el-button--primary el-button--small" :class="{ 'is-loading': uploading }">
        上传图片
        <input hidden type="file" accept="image/jpeg,image/png,image/webp" :disabled="uploading" @change="upload" />
      </label>
    </div>
    <div v-if="attachments.length" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px">
      <figure v-for="item in attachments" :key="item.id" style="margin:0;background:#f5f1ec;border-radius:10px;overflow:hidden">
        <img :src="`/api/v1/attachments/${item.id}`" :alt="item.originalName" style="width:100%;height:110px;object-fit:cover;display:block" />
        <figcaption style="padding:8px;font-size:12px">
          <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">{{ item.originalName }}</div>
          <el-button link type="danger" size="small" @click="remove(item.id)">删除</el-button>
        </figcaption>
      </figure>
    </div>
    <el-empty v-else :description="phase ? '还没有证据照片' : '还没有图片附件'" :image-size="compact ? 40 : 70" />
  </section>
</template>
