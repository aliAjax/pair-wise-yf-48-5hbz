<script setup lang="ts">
import { computed } from "vue";
import { RouterLink, RouterView } from "vue-router";
import { useI18n } from "vue-i18n";
import { NMessageProvider, NSelect } from "naive-ui";
import { useReviewStore } from "./stores/review";
import type { Viewer } from "./types";
const store = useReviewStore();
const { t } = useI18n();
const choices = computed(() => [
  ...store.roster.map((member) => ({
    label: member.role === "exited" ? `${member.name}（已退出）` : member.role === "substitute" ? `${member.name}（替补）` : member.name,
    value: member.name
  })),
  { label: "主办方", value: "主办方" }
]);
</script>
<template>
  <div class="shell">
    <aside class="sidebar"><div class="brand"><b>ANON</b><span>建筑评审</span></div><nav><RouterLink to="/">{{ t("scoring") }}</RouterLink><RouterLink to="/results">{{ t("results") }}</RouterLink></nav><div class="identity"><small>当前身份</small><NSelect :value="store.viewer" :options="choices" @update:value="(value: Viewer) => store.setViewer(value)" /></div></aside>
    <main><header><div><small>城市公共空间设计竞赛 · 第二轮</small><h1>建筑设计竞赛匿名评审</h1><p>评分期间作者信息不可见，评委只能查看和维护自己的评分。</p></div><div class="badge">{{ store.isOrganizer ? "主办方视图" : "评委独立视图" }}</div></header><NMessageProvider><RouterView /></NMessageProvider></main>
  </div>
</template>
