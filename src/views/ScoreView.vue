<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NRate, NSwitch, NTag, useMessage } from "naive-ui";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useReviewStore } from "../stores/review";
import type { ScoreRecord } from "../types";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.schemes.find((item) => item.id === selectedId.value) ?? store.schemes[0]);
const currentScore = computed(() => store.record(selected.value.id));
const form = reactive({ values: Object.fromEntries(store.criteria.map((item) => [item.id, 60])) as Record<string, number>, comment: "", conflict: false });
const schema = toTypedSchema(z.object({ comment: z.string().min(4, "请至少填写4个字的评审意见") }));
const { errors, validate } = useForm({ validationSchema: schema });

/** 打开表单时已载入的评分版本（并发保存令牌） */
const loadedUpdatedAt = ref<string>("");
/** 并发冲突时对方保存的最新版本 */
const conflictLatest = ref<ScoreRecord | null>(null);

function loadForm() {
  const record = store.record(selected.value.id);
  form.values = { ...(record?.values ?? Object.fromEntries(store.criteria.map((item) => [item.id, 60]))) };
  form.comment = record?.comment ?? "";
  form.conflict = record?.conflict ?? false;
  loadedUpdatedAt.value = record?.updatedAt ?? "";
  conflictLatest.value = null;
}

watch(selectedId, loadForm, { immediate: true });

const weighted = computed(() => store.criteria.reduce((sum, item) => sum + form.values[item.id] * item.weight / 100, 0));
const disabled = computed(() => store.isOrganizer || store.isWithdrawn || currentScore.value?.submitted || store.published);

async function draft() {
  const result = await store.saveDraft(selected.value.id, form.values, form.comment, form.conflict, loadedUpdatedAt.value);
  if (result.conflict) {
    conflictLatest.value = result.current ?? null;
    message.warning("该评分已被其他窗口更新，您的草稿已保留，请确认后重新保存");
    return;
  }
  if (result.rolledBack) {
    message.error(result.error ?? "保存失败，已恢复上一版");
    return;
  }
  if (!result.ok) {
    message.error(result.error ?? "保存失败");
    return;
  }
  loadedUpdatedAt.value = result.updatedAt ?? loadedUpdatedAt.value;
  message.success("评分草稿已保存到本地");
}

async function submit() {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  const saveResult = await store.submit(selected.value.id, form.values, form.comment, form.conflict, loadedUpdatedAt.value);
  if (saveResult.conflict) {
    conflictLatest.value = saveResult.current ?? null;
    message.warning("该评分已被其他窗口更新，您的草稿已保留，请确认后重新提交");
    return;
  }
  if (saveResult.rolledBack) {
    message.error(saveResult.error ?? "保存失败，已恢复上一版");
    return;
  }
  if (!saveResult.ok) {
    message.error(saveResult.error ?? "保存失败");
    return;
  }
  loadedUpdatedAt.value = saveResult.updatedAt ?? loadedUpdatedAt.value;
  message.success("匿名评分已提交");
}

function reloadLatest() {
  if (!conflictLatest.value) return;
  form.values = { ...conflictLatest.value.values };
  form.comment = conflictLatest.value.comment;
  form.conflict = conflictLatest.value.conflict;
  loadedUpdatedAt.value = conflictLatest.value.updatedAt;
  conflictLatest.value = null;
  message.info("已载入其他窗口保存的最新版本");
}
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>主办方在结果锁定前不能查看任何评委的评分值。</NAlert>
  <NAlert v-if="store.isWithdrawn" type="error" show-icon>您已退出本次评审，不能继续评分。未提交的草稿已转交替补接手。</NAlert>
  <NAlert v-if="conflictLatest" type="warning" show-icon class="conflict-alert">
    该评分已在其他窗口更新（更新时间 {{ new Date(conflictLatest.updatedAt).toLocaleString() }}）。您当前表单里的草稿已保留，可继续编辑后保存，或载入最新版本。
    <NButton size="small" style="margin-left:10px" @click="reloadLatest">载入最新版本</NButton>
  </NAlert>

  <div class="workspace">
    <NCard title="匿名方案" class="scheme-panel"><button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id"><span>{{ item.code }}</span><b>{{ item.title }}</b><small>{{ item.publicNo }} · {{ item.status }}</small></button></NCard>
    <NCard class="score-panel">
      <template #header><div class="card-title"><div><small>{{ selected.code }} · {{ selected.publicNo }}</small><h2>{{ selected.title }}</h2></div><NTag :type="selected.status === '已锁定' ? 'success' : 'warning'">{{ selected.status }}</NTag></div></template>
      <p class="synopsis">{{ selected.synopsis }}</p>

      <div v-if="currentScore?.suspended" class="status-banner suspended">
        <b>该评分已被挂起</b>
        <span>{{ currentScore.suspensionReason }}。原值和意见保留，但不计入名次。</span>
      </div>
      <div v-if="currentScore?.pendingConfirmation" class="status-banner pending">
        <b>待确认</b>
        <span>本评分来自退出评委{{ currentScore.transferredFrom ? `（${currentScore.transferredFrom}）` : "" }}，已提交但需替补确认。</span>
      </div>

      <div class="criteria">
        <article v-for="item in store.criteria" :key="item.id"><div><b>{{ item.name }}</b><span>权重 {{ item.weight }}%</span><p>{{ item.description }}</p></div><NRate v-model:value="form.values[item.id]" :count="5" :disabled="disabled" /><small>{{ form.values[item.id] }} / {{ item.max }}</small></article>
      </div>
      <div class="weighted"><span>加权得分</span><NProgress type="line" :percentage="weighted" :height="18" /><b>{{ weighted.toFixed(1) }}</b></div>
      <label class="conflict-switch"><NSwitch v-model:value="form.conflict" :disabled="disabled" /><span><b>声明利益冲突</b><small>声明后本评分不计入最终排名</small></span></label>
      <label class="field"><span>评审意见（评委间不可见）</span><NInput v-model:value="form.comment" type="textarea" :disabled="disabled" placeholder="填写对方案的具体意见" /><small>{{ errors.comment }}</small></label>
      <div class="actions">
        <NButton :disabled="disabled" @click="draft">保存草稿</NButton>
        <NButton type="primary" :disabled="disabled" @click="submit">提交本方案评分</NButton>
        <NButton v-if="currentScore?.submitted && !store.published" quaternary @click="store.recalled(selected.id)">退回修改</NButton>
      </div>
    </NCard>
  </div>
</template>

<style scoped>
.conflict-alert { margin-bottom: 14px; }
.status-banner { display: flex; flex-direction: column; gap: 4px; padding: 12px 14px; border-radius: 10px; margin-bottom: 14px; font-size: 13px; line-height: 1.6; }
.status-banner.suspended { background: #fdecec; border: 1px solid #f0c4c4; color: #a02828; }
.status-banner.pending { background: #fff6e6; border: 1px solid #ecd9a8; color: #8a6d1a; }
</style>
