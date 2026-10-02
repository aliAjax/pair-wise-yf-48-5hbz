<script setup lang="ts">
import { computed, reactive, ref, watch } from "vue";
import { NAlert, NButton, NCard, NInput, NProgress, NRate, NSwitch, NTag, useMessage } from "naive-ui";
import { toTypedSchema } from "@vee-validate/zod";
import { useForm } from "vee-validate";
import { z } from "zod";
import { useReviewStore } from "../stores/review";
import { weightedTotal } from "../scoring";

const store = useReviewStore();
const message = useMessage();
const selectedId = defineModel<string>("selectedId", { default: "a" });
const selected = computed(() => store.schemes.find((item) => item.id === selectedId.value) ?? store.schemes[0]);
const currentScore = computed(() => store.record(selected.value.id));
const verdict = computed(() => (currentScore.value ? store.verdictOf(currentScore.value) : undefined));
/** 替补可见的前任评委待确认评分（原值与意见保留） */
const pendingPredecessor = computed(() => store.scores.find((score) =>
  score.schemeId === selected.value.id &&
  score.confirmStatus === "pending" &&
  store.roster.some((member) => member.name === store.viewer && member.replaces === score.judge)
));
const form = reactive({ values: Object.fromEntries(store.criteria.map((item) => [item.id, 60])) as Record<string, number>, comment: "", conflict: false });
const schema = toTypedSchema(z.object({ comment: z.string().min(4, "请至少填写4个字的评审意见") }));
const { errors, validate } = useForm({ validationSchema: schema });

// 多窗口并发：记住打开时所依据的版本号；对端 rev 更新后保存会被判为冲突
let baseRev = 0;
const conflictRemote = ref<(typeof store.scores)[number] | null>(null);
const saveFailed = ref(false);

function fillForm() {
  const record = store.record(selected.value.id);
  form.values = { ...(record?.values ?? Object.fromEntries(store.criteria.map((item) => [item.id, 60]))) };
  form.comment = record?.comment ?? "";
  form.conflict = record?.conflict ?? false;
  baseRev = record?.rev ?? 0;
  conflictRemote.value = null;
  saveFailed.value = false;
}

watch(selectedId, fillForm, { immediate: true });

const weighted = computed(() => weightedTotal(form.values));
const disabled = computed(() => store.isOrganizer || !store.isJudge || currentScore.value?.submitted || store.published);

function draft(force = false) {
  const result = store.saveDraft(selected.value.id, form.values, form.comment, form.conflict, baseRev, force);
  if (result.ok) {
    message.success("评分草稿已保存");
    baseRev = store.record(selected.value.id)?.rev ?? baseRev;
    conflictRemote.value = null;
    saveFailed.value = false;
  } else if (result.reason === "conflict") {
    conflictRemote.value = result.remote ?? null;
    message.warning("该评分已被另一窗口更新，你的草稿已保留，未覆盖对方");
  } else {
    saveFailed.value = true;
    message.error("保存失败，已恢复上一版名次与未完成项");
  }
}

async function submit(force = false) {
  const result = await validate({ values: form } as any);
  if (!result.valid) return;
  const saved = store.submit(selected.value.id, form.values, form.comment, form.conflict, baseRev, force);
  if (saved.ok) {
    message.success("匿名评分已提交");
    baseRev = store.record(selected.value.id)?.rev ?? baseRev;
    conflictRemote.value = null;
    saveFailed.value = false;
  } else if (saved.reason === "conflict") {
    conflictRemote.value = saved.remote ?? null;
    message.warning("该评分已被另一窗口更新，你的草稿已保留，未覆盖对方");
  } else {
    saveFailed.value = true;
    message.error("保存失败，已恢复上一版名次与未完成项");
  }
}

function takeRemote() {
  const remote = conflictRemote.value;
  if (remote) {
    form.values = { ...remote.values };
    form.comment = remote.comment;
    form.conflict = remote.conflict;
    baseRev = remote.rev;
  } else {
    fillForm();
  }
  conflictRemote.value = null;
}
</script>

<template>
  <NAlert v-if="store.isOrganizer" type="info" show-icon>主办方在结果锁定前不能查看任何评委的评分值。</NAlert>
  <NAlert v-else-if="!store.isJudge" type="warning" show-icon style="margin-bottom:14px">该评委已退出评审，其名下评分仅作只读留档，新评分由替补评委完成。</NAlert>
  <div class="workspace">
    <NCard title="匿名方案" class="scheme-panel"><button v-for="item in store.schemes" :key="item.id" class="scheme" :class="{ active: selectedId === item.id }" @click="selectedId = item.id"><span>{{ item.code }}</span><b>{{ item.title }}</b><small>{{ item.publicNo }} · {{ item.status }}</small></button></NCard>
    <NCard class="score-panel">
      <template #header><div class="card-title"><div><small>{{ selected.code }} · {{ selected.publicNo }}</small><h2>{{ selected.title }}</h2></div><NTag :type="selected.status === '已锁定' ? 'success' : 'warning'">{{ selected.status }}</NTag></div></template>

      <NAlert v-if="verdict?.verdict === 'suspended'" type="error" show-icon style="margin-bottom:12px">
        本评分与其他评委中位分（{{ verdict.peerMedian?.toFixed(1) }}）相差 {{ verdict.deviation?.toFixed(1) }} 分，超过 15 分阈值，已挂起：原值和意见保留，但暂不计入名次，待评审复核。
      </NAlert>
      <NAlert v-if="pendingPredecessor" type="warning" show-icon style="margin-bottom:12px">
        前任评委 {{ pendingPredecessor.judge }} 退出前已提交本方案评分（加权 {{ store.weightedTotal(pendingPredecessor.values).toFixed(1) }} 分），现标记为待确认。你可在结果页确认沿用，或自行评分替代。
      </NAlert>
      <NAlert v-if="conflictRemote" type="warning" show-icon style="margin-bottom:12px">
        另一窗口已更新并保存了这条评分（当前版本 {{ conflictRemote.rev }}，更新于 {{ new Date(conflictRemote.updatedAt).toLocaleTimeString() }}）。你正在编辑的草稿已保留，未覆盖对方。
        <div class="conflict-actions"><NButton size="small" @click="takeRemote">读取对方最新版</NButton><NButton size="small" type="primary" ghost @click="draft(true)">保留我的草稿并覆盖保存</NButton></div>
      </NAlert>
      <NAlert v-if="saveFailed" type="error" show-icon style="margin-bottom:12px">刚才的保存失败，系统已回滚到上一版名次和未完成项，请重试。</NAlert>

      <p class="synopsis">{{ selected.synopsis }}</p>
      <div class="criteria">
        <article v-for="item in store.criteria" :key="item.id"><div><b>{{ item.name }}</b><span>权重 {{ item.weight }}%</span><p>{{ item.description }}</p></div><NRate v-model:value="form.values[item.id]" :count="5" :disabled="disabled" /><small>{{ form.values[item.id] }} / {{ item.max }}</small></article>
      </div>
      <div class="weighted"><span>加权得分</span><NProgress type="line" :percentage="weighted" :height="18" /><b>{{ weighted.toFixed(1) }}</b></div>
      <label class="conflict-switch"><NSwitch v-model:value="form.conflict" :disabled="disabled" /><span><b>声明利益冲突</b><small>声明后本评分不计入最终排名</small></span></label>
      <label class="field"><span>评审意见（评委间不可见）</span><NInput v-model:value="form.comment" type="textarea" :disabled="disabled" placeholder="填写对方案的具体意见" /><small>{{ errors.comment }}</small></label>
      <div class="actions"><NButton :disabled="disabled" @click="draft()">保存草稿</NButton><NButton type="primary" :disabled="disabled" @click="submit(false)">提交本方案评分</NButton><NButton v-if="currentScore?.submitted && !store.published" quaternary @click="store.recalled(selected.id)">退回修改</NButton></div>
    </NCard>
  </div>
</template>
