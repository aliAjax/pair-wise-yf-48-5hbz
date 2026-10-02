<script setup lang="ts">
import { computed } from "vue";
import { NAlert, NButton, NCard, NEmpty, NTable, NTag, NSwitch, NDivider, useMessage } from "naive-ui";
import { useReviewStore } from "../stores/review";
import type { Viewer } from "../types";

const store = useReviewStore();
const message = useMessage();

const rankedColumns = [
  { title: "名次", key: "rank", width: 70 },
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评委", key: "validCount" },
  { title: "利益冲突", key: "conflicts" },
  { title: "异常挂起", key: "suspended" },
  { title: "待确认", key: "pending" },
  { title: "加权总分", key: "total" }
];

const pendingColumns = [
  { title: "匿名编号", key: "code" },
  { title: "方案", key: "title" },
  { title: "有效评分", key: "validCount" },
  { title: "说明", key: "reason" }
];

const judgeRows = computed(() =>
  store.judges.map((name) => ({
    name,
    withdrawn: store.withdrawn.includes(name)
  }))
);

const judgmentColumns = [
  { title: "评委", key: "judge" },
  { title: "方案", key: "scheme" },
  { title: "状态", key: "state" },
  { title: "偏离", key: "deviation" },
  { title: "原因", key: "reason" }
];

const judgmentRows = computed(() =>
  store.judgments.map((item) => ({
    key: item.scoreId,
    judge: item.judge,
    scheme: store.schemes.find((scheme) => scheme.id === item.schemeId)?.code ?? item.schemeId,
    state: item.suspended ? "挂起" : "正常",
    deviation: item.deviation == null ? "—" : `${item.deviation > 0 ? "+" : ""}${item.deviation.toFixed(1)}`,
    reason: item.reason || "—"
  }))
);

const pendingRows = computed(() =>
  store.ranking.pending.map((item) => ({
    key: item.id,
    code: item.code,
    title: item.title,
    validCount: item.validCount,
    reason: item.pending > 0 ? "退出评委评分待确认" : item.suspended > 0 ? "异常分挂起" : "有效评分不足 2 份"
  }))
);

const rankedRows = computed(() =>
  store.ranking.ranked.map((item, index) => ({ ...item, rank: index + 1 }))
);

function publish() {
  const complete = store.schemes.every((scheme) => store.allSubmittedFor(scheme.id));
  if (!complete) {
    const missing = store.schemes
      .filter((scheme) => !store.allSubmittedFor(scheme.id))
      .map((scheme) => scheme.code)
      .join("、");
    message.warning(`仍有评委未提交（${missing}），不能锁定结果`);
    return;
  }
  store.publish();
  message.success("评分结果已锁定发布");
}

function withdraw(judgeName: Viewer) {
  store.withdrawJudge(judgeName);
  message.info(`${judgeName} 已退出：已提交评分保留待确认，未提交草稿转交替补接手`);
}

function armSaveFailure() {
  store.forceSaveFailure = true;
  message.warning("已武装：下一次保存将失败并回滚到上一版");
}
</script>

<template>
  <NAlert v-if="!store.published" type="warning" show-icon>结果尚未锁定。为避免影响独立判断，主办方当前只能看到提交进度与系统判定，无法读取原始分值。</NAlert>

  <div class="result-grid">
    <NCard title="提交进度">
      <article v-for="scheme in store.schemes" :key="scheme.id" class="progress-row">
        <div>
          <b>{{ scheme.code }} {{ scheme.title }}</b>
          <small>
            应评 {{ store.expectedJudgesFor(scheme.id).length }} 人 ·
            已提交 {{ store.scores.filter((score) => score.schemeId === scheme.id && score.submitted).length }} 份
          </small>
        </div>
        <NTag :type="store.allSubmittedFor(scheme.id) ? 'success' : 'warning'">
          {{ store.allSubmittedFor(scheme.id) ? "齐备" : "待提交" }}
        </NTag>
      </article>
    </NCard>

    <NCard title="评委更替">
      <div class="judge-rows">
        <article v-for="row in judgeRows" :key="row.name" class="judge-row">
          <div>
            <b>{{ row.name }}</b>
            <NTag :type="row.withdrawn ? 'default' : 'success'" size="small">
              {{ row.withdrawn ? "已退出" : "评审中" }}
            </NTag>
          </div>
          <NButton v-if="!row.withdrawn" size="small" @click="withdraw(row.name)">退出评委</NButton>
        </article>
      </div>
      <NDivider style="margin:12px 0" />
      <p class="judge-note">
        退出评委<b>已提交</b>的评分保留但标为「待确认」；<b>未提交</b>的草稿转交替补
        <NTag size="small" type="info">{{ store.substitute }}</NTag>
        接手，原值和意见保留。
      </p>
    </NCard>
  </div>

  <NCard title="异常判定" class="judgment-card">
    <NEmpty v-if="store.judgments.length === 0" description="暂无评分，提交后自动判定" />
    <NTable v-else :columns="judgmentColumns" :data="judgmentRows" :bordered="false" />
  </NCard>

  <NCard title="评审纪律" class="discipline-card">
    <div class="discipline">
      <p>评委只能查看自己的评分，主办方在锁定前无法读取原始分值。</p>
      <p>偏离其他评委中位分过多的评分先挂起，原值和意见保留但不计入名次。</p>
      <p>存在利益冲突的评分保留审计记录，但不参与最终排名。</p>
      <p>评分一改动，旧判定和名次作废重算；有效评分不够则单列，不硬凑名次。</p>
      <p>结果锁定后不可修改；保存失败会恢复上一版名次和未完成项。</p>
    </div>
    <div class="drill">
      <span>保存失败演练</span>
      <NButton size="small" :disabled="store.forceSaveFailure" @click="armSaveFailure">
        {{ store.forceSaveFailure ? "已武装，等待保存…" : "武装下一次失败" }}
      </NButton>
    </div>
    <NButton type="primary" block :disabled="store.published" @click="publish">锁定并发布结果</NButton>
  </NCard>

  <NCard title="最终排名" class="ranking">
    <NEmpty v-if="!store.published" description="锁定后查看最终排名" />
    <template v-else>
      <NTable :columns="rankedColumns" :data="rankedRows" :bordered="false" />
      <NEmpty v-if="store.ranking.ranked.length === 0" description="暂无有效评分可排名" />
      <NDivider style="margin:18px 0" />
      <h3 class="pending-title">有效评分不足，单列不排名</h3>
      <NEmpty v-if="store.ranking.pending.length === 0" description="所有方案均有足够有效评分" />
      <NTable v-else :columns="pendingColumns" :data="pendingRows" :bordered="false" />
    </template>
  </NCard>
</template>

<style scoped>
.judge-rows { display: grid; gap: 8px; }
.judge-row { display: flex; align-items: center; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid var(--line); }
.judge-row > div { display: flex; align-items: center; gap: 10px; }
.judge-note { color: #6d7483; line-height: 1.7; margin: 0; }
.judgment-card { margin-bottom: 18px; }
.discipline-card { margin-bottom: 18px; }
.drill { display: flex; align-items: center; justify-content: space-between; padding: 12px 0; margin: 12px 0; border-top: 1px dashed var(--line); color: #596171; }
.pending-title { margin: 0 0 10px; font-size: 15px; color: #88755a; }
</style>
