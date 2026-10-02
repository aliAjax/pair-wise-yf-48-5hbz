import { computed, ref } from "vue";
import { defineStore } from "pinia";
import type { ConfirmStatus, JudgeMember, ReviewEvent, SaveResult, Scheme, ScoreRecord, VerdictDetail, Viewer } from "../types";
import { activeJudges, allFulfilled, buildRanking, criteria, evaluateScheme, weightedTotal } from "../scoring";

const KEY = "pair-wise-yf-48/review";
const SCHEMA_VERSION = 2;
const seedSchemes: Scheme[] = [
  { id: "a", code: "S-01", title: "潮间带公共客厅", synopsis: "通过退台屋面把社区活动引向水岸，底层保留可被潮水短暂侵入的公共空间。", publicNo: "投递号 7182", status: "待评分" },
  { id: "b", code: "S-02", title: "风廊共生院", synopsis: "以双庭院组织低能耗社区中心，利用贯穿体量连接既有街巷。", publicNo: "投递号 6610", status: "待评分" },
  { id: "c", code: "S-03", title: "折线工坊", synopsis: "保留旧修理厂桁架，置入可拆装工坊和培训空间。", publicNo: "投递号 8024", status: "待评分" }
];
const defaultRoster: JudgeMember[] = [
  { name: "评委-林策", role: "active" },
  { name: "评委-周筑", role: "active" }
];

interface Persisted {
  version?: number;
  scores: ScoreRecord[];
  events: ReviewEvent[];
  published: boolean;
  schemeStatuses: Record<string, Scheme["status"]>;
  roster: JudgeMember[];
}

function defaultValues(): Record<string, number> {
  return Object.fromEntries(criteria.map((item) => [item.id, 60]));
}

/** 旧数据缺少判定/版本字段时按兼容方式补全，不阻断打开 */
function normalizeRecord(raw: any, index: number): ScoreRecord {
  return {
    id: raw.id ?? `legacy-${index}`,
    judge: raw.judge,
    schemeId: raw.schemeId,
    values: { ...defaultValues(), ...(raw.values ?? {}) },
    comment: raw.comment ?? "",
    submitted: Boolean(raw.submitted),
    conflict: Boolean(raw.conflict),
    updatedAt: raw.updatedAt ?? new Date().toISOString(),
    rev: Number(raw.rev ?? 1),
    verdict: raw.verdict === "suspended" ? "suspended" : "normal",
    confirmStatus: raw.confirmStatus === "pending" || raw.confirmStatus === "confirmed" ? raw.confirmStatus : "none"
  };
}

function loadInitial(): { data: Persisted; migrated: boolean } {
  const raw = localStorage.getItem(KEY);
  if (!raw) {
    return {
      data: { version: SCHEMA_VERSION, scores: [], events: [], published: false, schemeStatuses: {}, roster: defaultRoster.map((item) => ({ ...item })) },
      migrated: false
    };
  }
  try {
    const parsed = JSON.parse(raw);
    const migrated = parsed.version !== SCHEMA_VERSION;
    const scores: ScoreRecord[] = Array.isArray(parsed.scores) ? parsed.scores.map(normalizeRecord) : [];
    let roster: JudgeMember[] = Array.isArray(parsed.roster)
      ? parsed.roster.map((item: any) => ({ name: item.name, role: item.role, replaces: item.replaces, since: item.since }))
      : [];
    // v1 数据没有名册：用默认在岗评委兜底，再把评分里出现的未知评委补为在岗
    if (!roster.length) {
      roster = defaultRoster.map((item) => ({ ...item }));
      for (const score of scores) {
        if (!roster.some((member) => member.name === score.judge)) roster.push({ name: score.judge, role: "active" });
      }
    }
    return {
      data: {
        version: SCHEMA_VERSION,
        scores,
        events: Array.isArray(parsed.events) ? parsed.events : [],
        published: Boolean(parsed.published),
        schemeStatuses: parsed.schemeStatuses ?? {},
        roster
      },
      migrated
    };
  } catch {
    return {
      data: { version: SCHEMA_VERSION, scores: [], events: [], published: false, schemeStatuses: {}, roster: defaultRoster.map((item) => ({ ...item })) },
      migrated: false
    };
  }
}

function emptyScore(judge: Viewer, schemeId: string): ScoreRecord {
  return {
    id: crypto.randomUUID(),
    judge,
    schemeId,
    values: defaultValues(),
    comment: "",
    submitted: false,
    conflict: false,
    updatedAt: new Date().toISOString(),
    rev: 1,
    verdict: "normal",
    confirmStatus: "none"
  };
}

export const useReviewStore = defineStore("review", () => {
  const { data: initial, migrated } = loadInitial();

  const viewer = ref<Viewer>(initial.roster[0]?.name ?? "主办方");
  const schemes = ref<Scheme[]>(seedSchemes.map((scheme) => ({ ...scheme, status: initial.schemeStatuses[scheme.id] ?? scheme.status })));
  const scores = ref<ScoreRecord[]>(initial.scores);
  const events = ref<ReviewEvent[]>(initial.events);
  const published = ref<boolean>(initial.published);
  const roster = ref<JudgeMember[]>(initial.roster);
  if (migrated) {
    events.value.unshift({
      id: crypto.randomUUID(),
      time: new Date().toISOString(),
      actor: "系统",
      action: "兼容打开旧数据",
      detail: "旧版数据缺少异常判定/确认字段，已按默认值补全并重新计算判定与名次。"
    });
  }

  const judges = computed(() => activeJudges(roster.value));
  const isOrganizer = computed(() => viewer.value === "主办方");
  const viewerMember = computed(() => roster.value.find((member) => member.name === viewer.value));
  const isJudge = computed(() => Boolean(viewerMember.value) && viewerMember.value!.role !== "exited");
  const judge = computed(() => isJudge.value ? viewer.value : null);
  const visibleScores = computed(() => isOrganizer.value ? scores.value : scores.value.filter((score) => score.judge === judge.value));

  function log(action: string, detail: string) {
    events.value.unshift({ id: crypto.randomUUID(), time: new Date().toISOString(), actor: viewer.value, action, detail });
  }

  /** 对某方案评分重算异常判定（判定不入库，评分一改即整体重算，旧判定自动作废） */
  function verdictsFor(schemeId: string): VerdictDetail[] {
    return evaluateScheme(scores.value.filter((score) => score.schemeId === schemeId));
  }

  const verdictMap = computed(() => {
    const map = new Map<string, VerdictDetail>();
    for (const scheme of schemes.value) {
      for (const detail of verdictsFor(scheme.id)) map.set(detail.record.id, detail);
    }
    return map;
  });

  function verdictOf(record: ScoreRecord): VerdictDetail | undefined {
    return verdictMap.value.get(record.id);
  }

  /** 上一版持久化状态，保存失败时恢复名次和未完成项，不留半截改动 */
  function snapshot() {
    return {
      scores: scores.value.map((item) => ({ ...item, values: { ...item.values } })),
      schemes: schemes.value.map((item) => ({ ...item })),
      events: events.value.map((item) => ({ ...item })),
      published: published.value,
      roster: roster.value.map((item) => ({ ...item }))
    };
  }
  function restore(shot: ReturnType<typeof snapshot>) {
    scores.value = shot.scores;
    schemes.value = shot.schemes;
    events.value = shot.events;
    published.value = shot.published;
    roster.value = shot.roster;
  }

  /**
   * 事务化写入：先改状态、校验、持久化；任一步失败都回滚到上一版。
   * 用 localStorage 的 rev 做乐观并发：另一窗口已保存同条评分时判冲突，
   * 不覆盖对端，本次草稿留在本地由调用方提示。
   */
  function mutate<T>(fn: () => T): { ok: boolean; value?: T; reason?: "failed" } {
    const shot = snapshot();
    let value: T;
    try {
      value = fn();
      persist();
    } catch (error) {
      restore(shot);
      try { persist(); } catch { /* 回滚也写不回时放弃，内存中已是上一版 */ }
      console.error("保存失败，已恢复上一版名次与未完成项", error);
      return { ok: false, reason: "failed" };
    }
    return { ok: true, value };
  }

  function persist() {
    localStorage.setItem(KEY, JSON.stringify({
      version: SCHEMA_VERSION,
      scores: scores.value,
      events: events.value,
      published: published.value,
      schemeStatuses: Object.fromEntries(schemes.value.map((scheme) => [scheme.id, scheme.status])),
      roster: roster.value
    }));
  }

  /** 读取当前评委对某方案的评分（可能还不存在） */
  function record(schemeId: string): ScoreRecord | null {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    return scores.value.find((score) => score.judge === currentJudge && score.schemeId === schemeId) ?? null;
  }

  /** 取当前评委对某方案的评分，不存在则新建草稿记录 */
  function ensureRecord(schemeId: string): ScoreRecord | null {
    const currentJudge = judge.value;
    if (!currentJudge) return null;
    let item = record(schemeId);
    if (!item) {
      item = emptyScore(currentJudge, schemeId);
      scores.value.push(item);
    }
    return item;
  }

  /** 多窗口冲突检测：本地打开这条评分后，对端是否已更新过（按方案+评委匹配，兼容尚未落库的草稿） */
  function remoteConflict(schemeId: string, local?: ScoreRecord | null): ScoreRecord | undefined {
    const currentJudge = judge.value;
    if (!currentJudge) return undefined;
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return undefined;
      const remote = JSON.parse(raw).scores?.find(
        (score: ScoreRecord) => score.schemeId === schemeId &&
          score.judge === currentJudge &&
          (!local || score.id === local.id)
      ) as ScoreRecord | undefined;
      if (remote && (!local || remote.rev > local.rev)) return remote;
      // 本地还没有记录，但另一窗口已经为本评委保存过
      if (remote && !local) return remote;
      return undefined;
    } catch {
      return undefined;
    }
  }

  function markSchemeProgress(schemeId: string) {
    const scheme = schemes.value.find((entry) => entry.id === schemeId);
    if (!scheme) return;
    if (scheme.status === "待评分") scheme.status = "评分中";
    if (published.value) return;
    scheme.status = allFulfilled(roster.value, scores.value, schemeId) ? "已提交" : "评分中";
  }

  function saveDraft(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, baseRev?: number, force = false): SaveResult {
    if (!judge.value || published.value) return { ok: false, reason: "failed" };
    const existing = record(schemeId);
    if (existing?.submitted) return { ok: false, reason: "failed" };
    if (!force) {
      const remote = remoteConflict(schemeId, existing);
      if (remote || (existing && baseRev !== undefined && baseRev < existing.rev)) {
        return { ok: false, reason: "conflict", remote };
      }
    }
    const draftItem = existing ?? ensureRecord(schemeId)!;
    const result = mutate(() => {
      draftItem.values = { ...values };
      draftItem.comment = comment;
      draftItem.conflict = conflict;
      draftItem.rev += 1;
      draftItem.updatedAt = new Date().toISOString();
      markSchemeProgress(schemeId);
      log("保存评分草稿", `${schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId}${conflict ? "，声明利益冲突" : ""}；评分改动，旧判定与名次已作废重算`);
    });
    return result.ok ? { ok: true } : { ok: false, reason: "failed" };
  }

  function submit(schemeId: string, values: Record<string, number>, comment: string, conflict: boolean, baseRev?: number, force = false): SaveResult {
    if (!judge.value || published.value) return { ok: false, reason: "failed" };
    const existing = record(schemeId);
    if (!force) {
      const remote = remoteConflict(schemeId, existing);
      if (remote || (existing && baseRev !== undefined && baseRev < existing.rev)) {
        return { ok: false, reason: "conflict", remote };
      }
    }
    const item = existing ?? ensureRecord(schemeId)!;
    const result = mutate(() => {
      item.values = { ...values };
      item.comment = comment;
      item.conflict = conflict;
      item.submitted = true;
      item.confirmStatus = "none";
      item.rev += 1;
      item.updatedAt = new Date().toISOString();
      markSchemeProgress(schemeId);
      log("提交评分", `${schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId}；评分改动，旧判定与名次已作废重算`);
    });
    return result.ok ? { ok: true } : { ok: false, reason: "failed" };
  }

  function recalled(schemeId: string) {
    const item = record(schemeId);
    if (!item || published.value) return;
    const result = mutate(() => {
      item.submitted = false;
      markSchemeProgress(schemeId);
      log("退回评分修改", schemes.value.find((scheme) => scheme.id === schemeId)?.code ?? schemeId);
    });
    if (!result.ok) throw new Error("保存失败，已恢复上一版");
  }

  /** 替补确认退出评委留下的待确认评分：分值不动，转为有效并立即重算判定/名次 */
  function confirmPending(recordId: string) {
    const item = scores.value.find((score) => score.id === recordId);
    if (!item || item.confirmStatus !== "pending" || published.value) return;
    const result = mutate(() => {
      item.confirmStatus = "confirmed";
      item.rev += 1;
      item.updatedAt = new Date().toISOString();
      markSchemeProgress(item.schemeId);
      log("确认前任评委评分", `${schemes.value.find((scheme) => scheme.id === item.schemeId)?.code ?? item.schemeId}，原评委 ${item.judge}；确认后重新计算判定与名次`);
    });
    if (!result.ok) throw new Error("保存失败，已恢复上一版");
  }

  function allSubmittedFor(schemeId: string) {
    return allFulfilled(roster.value, scores.value, schemeId);
  }

  const ranking = computed(() => {
    if (!published.value) return [];
    return buildRanking(schemes.value, scores.value);
  });

  function publish() {
    if (!schemes.value.every((scheme) => allFulfilled(roster.value, scores.value, scheme.id))) return;
    const result = mutate(() => {
      published.value = true;
      schemes.value.forEach((scheme) => { scheme.status = "已锁定"; });
      log("锁定并发布结果", `${schemes.value.length} 个匿名方案，发布前已按最新评分重算判定与名次`);
    });
    if (!result.ok) throw new Error("保存失败，已恢复上一版");
  }

  /**
   * 评委更替：退出评委未提交的评分交给替补接手（草稿随替补继续填写）；
   * 已提交的评分原值保留，标记待确认，替补确认后才计入名次。
   */
  function replaceJudge(exitedName: string, substituteName: string): string | null {
    const exited = roster.value.find((member) => member.name === exitedName);
    const name = substituteName.trim();
    if (!exited || exited.role === "exited") return "该评委已退出";
    if (!name) return "请填写替补评委姓名";
    if (name === "主办方" || roster.value.some((member) => member.name === name)) return "该姓名已在评委名册中";
    if (published.value) return "结果已锁定，不能更替评委";

    const result = mutate(() => {
      const now = new Date().toISOString();
      exited.role = "exited";
      exited.replaces = name;
      roster.value.push({ name, role: "substitute", replaces: exitedName, since: now });

      for (const item of scores.value.filter((score) => score.judge === exitedName)) {
        if (item.submitted) {
          // 已提交：原值保留待确认，先挂在原评委名下，不直接计入名次
          item.confirmStatus = "pending" as ConfirmStatus;
          item.rev += 1;
          item.updatedAt = now;
        } else {
          // 未提交的草稿交给替补接手
          item.judge = name;
          item.id = crypto.randomUUID();
          item.rev += 1;
          item.updatedAt = now;
        }
        markSchemeProgress(item.schemeId);
      }
      log("评委更替", `${exitedName} 退出，${name} 接手：未提交草稿转交替补，已提交评分保留并标记待确认；旧判定与名次已作废重算`);
    });
    if (!result.ok) return "保存失败，已恢复上一版名次与未完成项";
    return null;
  }

  function setViewer(value: Viewer) { viewer.value = value; }

  /** 接收另一窗口写入的最新状态；返回冲突的本窗口草稿，由界面留住并提示 */
  function mergeRemote(next: Persisted): ScoreRecord[] {
    const localDraftIds = new Set(
      scores.value.filter((item) => !item.submitted).map((item) => item.id)
    );
    const stale = next.scores.filter((item) => localDraftIds.has(item.id));
    scores.value = next.scores;
    events.value = next.events;
    published.value = next.published;
    roster.value = next.roster;
    schemes.value = schemes.value.map((scheme) => ({ ...scheme, status: next.schemeStatuses[scheme.id] ?? scheme.status }));
    return stale;
  }

  function readRemote(): Persisted | null {
    try {
      const raw = localStorage.getItem(KEY);
      return raw ? JSON.parse(raw) as Persisted : null;
    } catch {
      return null;
    }
  }

  // 本窗口的写入不触发 storage 事件；只有其他窗口保存才会收到
  window.addEventListener("storage", (event) => {
    if (event.key !== KEY || !event.newValue) return;
    try {
      const next = JSON.parse(event.newValue) as Persisted;
      mergeRemote(next);
    } catch { /* 对端数据异常时忽略，保留本窗口状态 */ }
  });

  // 兼容迁移或名册初始化后先落一版，保证旧数据补全结果不丢
  try { persist(); } catch (error) { console.error("初始化保存失败", error); }

  return {
    viewer, schemes, criteria, judges, roster, scores, events, published, ranking,
    visibleScores, isOrganizer, isJudge, judge,
    setViewer, record, verdictOf, verdictsFor, weightedTotal,
    saveDraft, submit, recalled, confirmPending, publish, allSubmittedFor, replaceJudge,
    mergeRemote, readRemote
  };
});
