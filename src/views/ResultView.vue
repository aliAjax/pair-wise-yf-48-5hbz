<script setup lang="ts">
import { computed, ref } from "vue";
import { NAlert, NButton, NCard, NEmpty, NInput, NTable, NTag, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";
const store = useReviewStore();
const message = useMessage();

const columns = [
  { title: "名次", key: "rank", width: 70, render: (row: any) => row.rank ?? "—" },
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评委", key: "judgeCount" },
  { title: "挂起", key: "suspended", width: 70 },
  { title: "待确认", key: "pending", width: 80 },
  { title: "利益冲突", key: "conflicts", width: 90 },
  { title: "加权总分", key: "total" }
];

const pendingRecords = computed(() =>
  store.scores.filter((score) => score.confirmStatus === "pending")
);
const ranked = computed(() => store.ranking.filter((item) => item.qualified));
const unranked = computed(() => store.ranking.filter((item) => !item.qualified));

const replaceTarget = ref<string | null>(null);
const substituteName = ref("");

function startReplace(name: string) {
  replaceTarget.value = name;
  substituteName.value = "";
}
function confirmReplace() {
  if (!replaceTarget.value) return;
  const error = store.replaceJudge(replaceTarget.value, substituteName.value);
  if (error) { message.warning(error); return; }
  message.success(`${replaceTarget.value} 已退出，${substituteName.value.trim()} 接手其评分工作`);
  replaceTarget.value = null;
}
function confirmPending(id: string) {
  try {
    store.confirmPending(id);
    message.success("前任评委评分已确认，判定与名次已重算");
  } catch (error) {
    message.error("保存失败，已恢复上一版名次与未完成项");
  }
}

function publish() {
  const complete = store.schemes.every((scheme) => store.allSubmittedFor(scheme.id));
  if (!complete) { message.warning("仍有在岗评委未完成（含待确认评分），不能锁定结果"); return; }
  try {
    store.publish();
    message.success("评分结果已锁定发布");
  } catch (error) {
    message.error("保存失败，已恢复上一版名次与未完成项");
  }
}

function schemeAnomalies(schemeId: string) {
  return store.verdictsFor(schemeId).filter((detail) => detail.verdict === "suspended");
}
function submittedCount(schemeId: string) {
  return store.judges.filter((name) => store.scores.some((score) =>
    score.schemeId === schemeId && score.judge === name && score.submitted && !score.conflict && score.confirmStatus !== "pending"
  )).length;
}
function pendingCount(schemeId: string) {
  return store.scores.filter((score) => score.schemeId === schemeId && score.confirmStatus === "pending").length;
}
</script>
<template>
  <NAlert v-if="!store.published" type="warning" show-icon>结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度与异常判定，不显示具体分值。</NAlert>
  <div class="result-grid">
    <NCard title="提交进度">
      <article v-for="scheme in store.schemes" :key="scheme.id" class="progress-row">
        <div>
          <b>{{ scheme.code }} {{ scheme.title }}</b>
          <small>{{ submittedCount(scheme.id) }} / {{ store.judges.length }} 已完成</small>
          <small v-for="item in schemeAnomalies(scheme.id)" :key="item.record.id" class="flag">
            ⚠ {{ item.record.judge }} 偏离中位分 {{ item.deviation?.toFixed(1) }} 分，已挂起（不计名次）
          </small>
        </div>
        <NTag :type="store.allSubmittedFor(scheme.id) ? 'success' : 'warning'">{{ store.allSubmittedFor(scheme.id) ? "齐备" : "待完成" }}</NTag>
      </article>
    </NCard>
    <NCard title="评委名册与更替">
      <div class="roster">
        <div v-for="member in store.roster" :key="member.name" class="roster-row">
          <div>
            <b>{{ member.name }}</b>
            <small v-if="member.role === 'exited'">已退出</small>
            <small v-else-if="member.role === 'substitute'">替补 · 接手 {{ member.replaces }}</small>
            <small v-else>在岗评委</small>
          </div>
          <NButton v-if="member.role !== 'exited' && !store.published" size="small" quaternary @click="startReplace(member.name)">更替</NButton>
        </div>
      </div>
      <div v-if="replaceTarget" class="replace-box">
        <small>{{ replaceTarget }} 退出，指定替补评委接手</small>
        <NInput v-model:value="substituteName" placeholder="替补评委姓名" />
        <div class="replace-actions"><NButton size="small" @click="replaceTarget = null">取消</NButton><NButton size="small" type="primary" @click="confirmReplace">确认更替</NButton></div>
      </div>
    </NCard>
  </div>

  <NCard v-if="pendingRecords.length" title="待确认评分（退出评委已提交）" class="ranking">
    <div class="pending-list">
      <div v-for="item in pendingRecords" :key="item.id" class="pending-row">
        <div>
          <b>{{ store.schemes.find((scheme) => scheme.id === item.schemeId)?.code }}</b>
          <small>原评委 {{ item.judge }} · {{ new Date(item.updatedAt).toLocaleString() }}</small>
        </div>
        <div class="replace-actions">
          <NTag type="warning">待确认，暂不计名次</NTag>
          <NButton size="small" type="primary" :disabled="store.published" @click="confirmPending(item.id)">确认沿用</NButton>
        </div>
      </div>
    </div>
  </NCard>

  <div class="result-grid">
    <NCard title="评分纪律">
      <div class="discipline">
        <p>评委只能查看自己的评分，主办方在锁定前无法读取分值。</p>
        <p>同一方案偏离其他评委中位分超过 15 分的评分自动挂起，原值与意见保留但不计名次。</p>
        <p>评委退出时未提交草稿转替补接手；已提交评分保留并标记待确认。</p>
        <p>评分一改动，旧判定和名次立即作废重算；有效评分不足 2 条的方案单列，不硬凑名次。</p>
      </div>
      <NButton type="primary" block :disabled="store.published" @click="publish">锁定并发布结果</NButton>
    </NCard>
  </div>

  <NCard title="最终排名" class="ranking">
    <NEmpty v-if="!store.published" description="锁定后查看最终排名" />
    <template v-else>
      <NTable :columns="columns" :data="ranked" :bordered="false" />
      <div v-if="unranked.length" class="unranked">
        <h4>有效评分不足，单列不排名</h4>
        <NTable :columns="columns" :data="unranked" :bordered="false" />
      </div>
    </template>
  </NCard>
</template>
