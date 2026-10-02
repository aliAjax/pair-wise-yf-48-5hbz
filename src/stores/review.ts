import { computed, ref, watch, nextTick } from "vue";
import { defineStore } from "pinia";
import type { Criterion, ReviewEvent, Scheme, SchemeStatus, ScoreRecord, Viewer, AnomalyJudgment } from "../types";

const KEY = "pair-wise-yf-48/review";
const judges: Viewer[] = ["评委-林策", "评委-周筑"];
const substitute: Viewer = "评委-替补";
/** 偏离其他评委中位分超过该分值即挂起（0-100 加权分） */
const ANOMALY_THRESHOLD = 20;
/** 有效评分少于该份数不单列名次，单独列出 */
const MIN_VALID_FOR_RANKING = 2;

const seedSchemes: Scheme[] = [
  { id: "a", code: "S-01", title: "潮间带公共客厅", synopsis: "通过退台屋面把社区活动引向水岸，底层保留可被潮水短暂侵入的公共空间。", publicNo: "投递号 7182", status: "待评分" },
  { id: "b", code: "S-02", title: "风廊共生院", synopsis: "以双庭院组织低能耗社区中心，利用贯穿体量连接既有街巷。", publicNo: "投递号 6610", status: "待评分" },
  { id: "c", code: "S-03", title: "折线工坊", synopsis: "保留旧修理厂桁架，置入可拆装工坊和培训空间。", publicNo: "投递号 8024", status: "待评分" }
];
const criteria: Criterion[] = [
  { id: "site", name: "场地回应", description: "与气候、地貌和周边公共空间的关系", weight: 30, max: 100 },
  { id: "program", name: "功能组织", description: "空间组织、流线和公共性", weight: 25, max: 100 },
  { id: "structure", name: "结构与建造", description: "结构逻辑、材料和建造可行性", weight: 25, max: 100 },
  { id: "sustain", name: "环境策略", description: "节能、碳排和长期维护", weight: 20, max: 100 }
];

function emptyScore(judge: Viewer, schemeId: string): ScoreRecord {
  return { id: `${judge}-${schemeId}`, judge, schemeId, values: Object.fromEntries(criteria.map((item) => [item.id, 60])), comment: "", submitted: false, conflict: false, updatedAt: new Date().toISOString() };
}

/** 兼容补齐：旧数据缺少判定字段时按默认值打开 */
function compatScore(s: Partial<ScoreRecord>): ScoreRecord {
  return {
    id: s.id ?? "",
    judge: s.judge ?? "评委-林策",
    schemeId: s.schemeId ?? "",
    values: s.values ?? Object.fromEntries(criteria.map((item) => [item.id, 60])),
    comment: s.comment ?? "",
    submitted: s.submitted ?? false,
    conflict: s.conflict ?? false,
    updatedAt: s.updatedAt ?? new Date(0).toISOString(),
    suspended: s.suspended ?? false,
    suspensionReason: s.suspensionReason ?? "",
    pendingConfirmation: s.pendingConfirmation ?? false,
    transferredFrom: s.transferredFrom
  };
}

function weightedTotal(score: ScoreRecord): number {
  return criteria.reduce((sum, item) => sum + (score.values[item.id] ?? 0) * item.weight / 100, 0);
}

function median(arr: number[]): number {
  if (!arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export interface SaveResult {
  ok: boolean;
  /** 并发冲突：该评分已被其他窗口更新 */
  conflict?: boolean;
  /** 保存失败后已回滚到上一版 */
  rolledBack?: boolean;
  error?: string;
  current?: ScoreRecord;
  updatedAt?: string;
}

export const useReviewStore = defineStore("review", () => {
  const saved = localStorage.getItem(KEY);
  let initialScores: ScoreRecord[] = [];
  let initialEvents: ReviewEvent[] = [];
  let initialPublished = false;
  let initialSchemeStatuses: Record<string, SchemeStatus> = {};
  let initialJudgments: AnomalyJudgment[] = [];
  let initialWithdrawn: Viewer[] = [];
  if (saved) {
    const parsed = JSON.parse(saved);
    initialScores = (parsed.scores ?? []).map(compatScore);
    initialEvents = parsed.events ?? [];
    initialPublished = parsed.published ?? false;
    initialSchemeStatuses = parsed.schemeStatuses ?? {};
    initialJudgments = parsed.judgments ?? [];
    initialWithdrawn = parsed.withdrawn ?? [];
  }

  const viewer = ref<Viewer>("评委-林策");
  const schemes = ref<Scheme[]>(seedSchemes.map((scheme) => ({ ...scheme, status: initialSchemeStatuses?.[scheme.id] ?? scheme.status })));
  const scores = ref<ScoreRecord[]>(initialScores);
  const events = ref<ReviewEvent[]>(initialEvents);
  const published = ref<boolean>(initialPublished);
  const judgments = ref<AnomalyJudgment[]>(initialJudgments);
  const withdrawn = ref<Viewer[]>(initialWithdrawn);
  /** 演练开关：置为 true 后下一次保存会失败，用于验证回滚 */
  const forceSaveFailure = ref<boolean>(false);

  const isOrganizer = computed(() => viewer.value === "主办方");
  const judge = computed(() => viewer.value.startsWith("评委-") ? viewer.value : null);
  const isWithdrawn = computed(() => (judge.value ? withdrawn.value.includes(judge.value) : false));
  const visibleScores = computed(() => isOrganizer.value ? scores.value : scores.value.filter((score) => score.judge === judge.value));

  function log(action: string, detail: string) {
    events.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor: viewer.value, action, detail });
  }

  function record(schemeId: string) {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    let item = scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (!item) {
      item = emptyScore(currentJudge, schemeId);
      scores.value.push(item);
    }
    return item;
  }

  /** 当前方案实际应评分的评委：未退出评委 + 替补（接替退出评委） */
  function expectedJudgesFor(schemeId: string): Viewer[] {
    const active = judges.filter((name) => !withdrawn.value.includes(name));
    if (withdrawn.value.length > 0) return [...active, substitute];
    return active;
  }

  function allSubmittedFor(schemeId: string) {
    return expectedJudgesFor(schemeId).every((name) => scores.value.some((score) => score.judge === name && score.schemeId === schemeId && score.submitted));
  }

  /** 评分一改动，旧判定先作废 */
  function invalidateJudgments() {
    judgments.value.forEach((item) => { item.stale = true; });
  }

  /** 重算异常判定：同一方案里偏离其他评委中位分过多的评分挂起 */
  function recomputeJudgments() {
    const result: AnomalyJudgment[] = [];
    for (const scheme of schemes.value) {
      const schemeScores = scores.value.filter((score) => score.schemeId === scheme.id && score.submitted && !score.conflict && !score.pendingConfirmation);
      for (const score of schemeScores) {
        const others = schemeScores.filter((other) => other.id !== score.id);
        const total = weightedTotal(score);
        let med: number | null = null;
        let deviation: number | null = null;
        let suspended = false;
        let reason = "";
        if (others.length > 0) {
          med = median(others.map(weightedTotal));
          deviation = total - med;
          suspended = Math.abs(deviation) > ANOMALY_THRESHOLD;
          if (suspended) reason = `偏离其他评委中位分 ${med.toFixed(1)} 达 ${Math.abs(deviation).toFixed(1)} 分`;
        }
        result.push({ scoreId: score.id, schemeId: scheme.id, judge: score.judge, suspended, reason, median: med, deviation });
        score.suspended = suspended;
        score.suspensionReason = reason;
      }
    }
    judgments.value = result;
  }

  // 兼容打开：旧数据缺少判定字段（judgments 为空但有评分）时重算补齐
  if (saved && initialJudgments.length === 0 && initialScores.length > 0) {
    recomputeJudgments();
  }

  function snapshot(): string {
    return JSON.stringify({ scores: scores.value, schemes: schemes.value, events: events.value });
  }

  /** 保存失败后恢复上一版名次和未完成项 */
  function rollback(snap: string) {
    const parsed = JSON.parse(snap);
    scores.value = parsed.scores;
    schemes.value = parsed.schemes;
    events.value = parsed.events;
    recomputeJudgments();
  }

  function simulateSave(): Promise<boolean> {
    return new Promise((resolve) => {
      setTimeout(() => {
        if (forceSaveFailure.value) {
          forceSaveFailure.value = false;
          resolve(false);
        } else {
          resolve(true);
        }
      }, 400);
    });
  }

  /** 直接读 localStorage 最新值，防止跨标签页时 storage 事件尚未触发 */
  function latestFromStorage(judgeName: Viewer, schemeId: string): ScoreRecord | null {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return (parsed.scores ?? []).find((s: ScoreRecord) => s.judge === judgeName && s.schemeId === schemeId) ?? null;
  }

  function checkConflict(currentJudge: Viewer, schemeId: string, expectedUpdatedAt: string): SaveResult | null {
    const latest = latestFromStorage(currentJudge, schemeId);
    if (latest && latest.updatedAt !== expectedUpdatedAt) {
      return { ok: false, conflict: true, current: compatScore(latest) };
    }
    const item = scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (item && item.updatedAt !== expectedUpdatedAt) {
      return { ok: false, conflict: true, current: item };
    }
    return null;
  }

  async function saveDraft(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, expectedUpdatedAt: string): Promise<SaveResult> {
    const currentJudge = judge.value;
    if (!currentJudge) return { ok: false, error: "无法获取评委身份" };
    if (withdrawn.value.includes(currentJudge)) return { ok: false, error: "您已退出评审，不能继续评分" };
    const conflictResult = checkConflict(currentJudge, schemeId, expectedUpdatedAt);
    if (conflictResult) return conflictResult;
    const snap = snapshot();
    let item = scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (!item) {
      item = emptyScore(currentJudge, schemeId);
      scores.value.push(item);
    }
    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme && scheme.status === "待评分") scheme.status = "评分中";
    invalidateJudgments();
    log("保存评分草稿", `${scheme?.code ?? schemeId}${conflict ? "，声明利益冲突" : ""}`);
    const ok = await simulateSave();
    if (!ok) {
      rollback(snap);
      return { ok: false, rolledBack: true, error: "保存失败，已恢复上一版名次和未完成项" };
    }
    recomputeJudgments();
    return { ok: true, updatedAt: item.updatedAt };
  }

  async function submit(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, expectedUpdatedAt: string): Promise<SaveResult> {
    const currentJudge = judge.value;
    if (!currentJudge) return { ok: false, error: "无法获取评委身份" };
    if (withdrawn.value.includes(currentJudge)) return { ok: false, error: "您已退出评审，不能继续评分" };
    const conflictResult = checkConflict(currentJudge, schemeId, expectedUpdatedAt);
    if (conflictResult) return conflictResult;
    const snap = snapshot();
    let item = scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId);
    if (!item) {
      item = emptyScore(currentJudge, schemeId);
      scores.value.push(item);
    }
    item.values = { ...values };
    item.comment = comment;
    item.conflict = conflict;
    item.submitted = true;
    item.updatedAt = new Date().toISOString();
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (scheme) scheme.status = allSubmittedFor(schemeId) ? "已提交" : "评分中";
    invalidateJudgments();
    log("提交评分", scheme?.code ?? schemeId);
    const ok = await simulateSave();
    if (!ok) {
      rollback(snap);
      return { ok: false, rolledBack: true, error: "保存失败，已恢复上一版名次和未完成项" };
    }
    recomputeJudgments();
    return { ok: true, updatedAt: item.updatedAt };
  }

  function recalled(schemeId: string) {
    const item = record(schemeId);
    if (!item || published.value) return;
    item.submitted = false;
    invalidateJudgments();
    recomputeJudgments();
    log("退回评分修改", schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId);
  }

  /** 评委更替：退出评委已提交的评分保留但标待确认，未提交的草稿交给替补接手 */
  function withdrawJudge(judgeName: Viewer) {
    if (withdrawn.value.includes(judgeName)) return;
    if (judgeName === "主办方" || judgeName === substitute) return;
    withdrawn.value.push(judgeName);
    for (const scheme of schemes.value) {
      const submitted = scores.value.find((score) => score.judge === judgeName && score.schemeId === scheme.id && score.submitted);
      if (submitted) {
        submitted.pendingConfirmation = true;
        submitted.updatedAt = new Date().toISOString();
        log("评委更替", `${judgeName} 已提交的 ${scheme.code} 评分保留，标记待确认`);
      }
      const draft = scores.value.find((score) => score.judge === judgeName && score.schemeId === scheme.id && !score.submitted);
      if (draft) {
        const duplicate = scores.value.some((score) => score.judge === substitute && score.schemeId === scheme.id);
        if (!duplicate) {
          draft.judge = substitute;
          draft.transferredFrom = judgeName;
          draft.updatedAt = new Date().toISOString();
          log("评委更替", `${judgeName} 退出，${scheme.code} 未提交评分转交替补接手`);
        } else {
          log("评委更替", `${judgeName} 退出，${scheme.code} 已有替补评分，草稿未转移`);
        }
      }
    }
    invalidateJudgments();
    recomputeJudgments();
  }

  const ranking = computed(() => {
    const ranked: Array<Scheme & { total: number; validCount: number; conflicts: number; suspended: number; pending: number }> = [];
    const pendingList: typeof ranked = [];
    for (const scheme of schemes.value) {
      const valid = scores.value.filter((score) => score.schemeId === scheme.id && score.submitted && !score.conflict && !score.suspended && !score.pendingConfirmation);
      const total = valid.length ? valid.reduce((sum, score) => sum + weightedTotal(score), 0) / valid.length : 0;
      const item = {
        ...scheme,
        total: Number(total.toFixed(2)),
        validCount: valid.length,
        conflicts: scores.value.filter((score) => score.schemeId === scheme.id && score.conflict).length,
        suspended: scores.value.filter((score) => score.schemeId === scheme.id && score.suspended).length,
        pending: scores.value.filter((score) => score.schemeId === scheme.id && score.pendingConfirmation).length
      };
      if (valid.length >= MIN_VALID_FOR_RANKING) ranked.push(item);
      else pendingList.push(item);
    }
    ranked.sort((a, b) => b.total - a.total);
    return { ranked, pending: pendingList };
  });

  function publish() {
    if (!schemes.value.every((scheme) => allSubmittedFor(scheme.id))) return;
    published.value = true;
    schemes.value.forEach((scheme) => { scheme.status = "已锁定"; });
    log("锁定并发布结果", `${schemes.value.length} 个匿名方案`);
  }

  function setViewer(value: Viewer) { viewer.value = value; }

  // 跨标签页同步：其他窗口保存后，本窗口重载最新状态（保留当前身份）
  let reloading = false;
  async function reloadFromStorage() {
    const raw = localStorage.getItem(KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    reloading = true;
    scores.value = (parsed.scores ?? []).map(compatScore);
    events.value = parsed.events ?? [];
    published.value = parsed.published ?? false;
    schemes.value = schemes.value.map((scheme) => ({ ...scheme, status: parsed.schemeStatuses?.[scheme.id] ?? scheme.status }));
    judgments.value = parsed.judgments ?? [];
    withdrawn.value = parsed.withdrawn ?? [];
    await nextTick();
    reloading = false;
  }
  if (typeof window !== "undefined") {
    window.addEventListener("storage", (event) => {
      if (event.key === KEY) reloadFromStorage();
    });
  }

  watch([scores, events, published, schemes, judgments, withdrawn], () => {
    if (reloading) return;
    localStorage.setItem(KEY, JSON.stringify({
      scores: scores.value,
      events: events.value,
      published: published.value,
      schemeStatuses: Object.fromEntries(schemes.value.map((scheme) => [scheme.id, scheme.status])),
      judgments: judgments.value,
      withdrawn: withdrawn.value
    }));
  }, { deep: true });

  return {
    viewer, schemes, criteria, judges, substitute, scores, events, published, judgments, withdrawn, forceSaveFailure,
    ranking, visibleScores, isOrganizer, judge, isWithdrawn,
    setViewer, record, saveDraft, submit, recalled, withdrawJudge, publish, allSubmittedFor, expectedJudgesFor, recomputeJudgments
  };
});
