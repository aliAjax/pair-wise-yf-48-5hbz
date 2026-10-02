import type { Criterion, JudgeMember, ScoreRecord, VerdictDetail } from "./types";

/** 偏离其他评委中位分的挂起阈值（加权总分制下的分差） */
export const OUTLIER_THRESHOLD = 15;
/** 判定异常所需的其他有效评委最少人数（1 人即可作为参照；此时双方都可被挂起，方案因有效分不足单列） */
export const OUTLIER_MIN_PEERS = 1;
/** 进入名次所需的最少有效评分，不够则单列不硬凑 */
export const MIN_VALID_SCORES = 2;

export const criteria: Criterion[] = [
  { id: "site", name: "场地回应", description: "与气候、地貌和周边公共空间的关系", weight: 30, max: 100 },
  { id: "program", name: "功能组织", description: "空间组织、流线和公共性", weight: 25, max: 100 },
  { id: "structure", name: "结构与建造", description: "结构逻辑、材料和建造可行性", weight: 25, max: 100 },
  { id: "sustain", name: "环境策略", description: "节能、碳排和长期维护", weight: 20, max: 100 }
];

/** 一条评分按维度权重折算的加权总分（0–100） */
export function weightedTotal(values: Record<string, number>): number {
  return criteria.reduce((sum, criterion) => sum + (values[criterion.id] ?? 0) * criterion.weight / 100, 0);
}

/** 有效评分：已提交、无利益冲突；退出评委的评分经替补确认后有效，待确认则暂不计入 */
export function isEligible(record: ScoreRecord): boolean {
  return record.submitted && !record.conflict && record.confirmStatus !== "pending";
}

export function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function activeJudges(roster: JudgeMember[]): string[] {
  return roster.filter((member) => member.role === "active" || member.role === "substitute").map((member) => member.name);
}

/**
 * 对同一方案的评分做异常判定：以全部有效评分的中位分为共识基准，
 * 偏离超过阈值的评分挂起（原值与意见保留，不计名次）；挂起后剔除该分再算中位、
 * 迭代到稳定，避免一个极端分在小样本里把临界分连带挂起。
 */
export function evaluateScheme(records: ScoreRecord[]): VerdictDetail[] {
  const details: VerdictDetail[] = records.map((record) => ({
    record,
    verdict: "normal" as const,
    total: Number(weightedTotal(record.values).toFixed(2)),
    peerMedian: null,
    deviation: null
  }));

  const eligibleIdx = details.map((detail, index) => isEligible(detail.record) ? index : -1).filter((index) => index >= 0);
  const active = new Set(eligibleIdx);
  for (let guard = 0; guard < eligibleIdx.length; guard++) {
    if (active.size < OUTLIER_MIN_PEERS + 1) break;
    const center = median([...active].map((index) => details[index].total));
    const outliers = [...active].filter((index) => Math.abs(details[index].total - center) > OUTLIER_THRESHOLD);
    if (!outliers.length) break;
    outliers.forEach((index) => active.delete(index));
  }

  for (let i = 0; i < details.length; i++) {
    if (!isEligible(details[i].record)) continue;
    // 展示用：其余“最终有效”评分的中位分；若自身也被挂起导致有效池为空，退化为其余有效评分
    const peerPool = (source: number[]) => source.filter((index) => index !== i);
    let peers = peerPool([...active]);
    if (!peers.length) peers = peerPool(eligibleIdx);
    if (peers.length < OUTLIER_MIN_PEERS) continue;
    const peerMedian = Number(median(peers.map((index) => details[index].total)).toFixed(2));
    details[i].peerMedian = peerMedian;
    details[i].deviation = Number(Math.abs(details[i].total - peerMedian).toFixed(2));
    if (!active.has(i)) details[i].verdict = "suspended";
  }
  return details;
}

export interface RankedScheme {
  id: string;
  code: string;
  title: string;
  total: number;
  judgeCount: number;
  conflicts: number;
  pending: number;
  suspended: number;
  rank: number | null;
  qualified: boolean;
}

/**
 * 重算名次：只统计未被挂起的有效评分；有效评分不足 MIN_VALID_SCORES 的方案单列，不硬凑名次。
 * 并列采用竞赛排名（1,1,3）。评分一旦改动即应整体重算，旧判定和旧名次不再沿用。
 */
export function buildRanking(
  schemes: { id: string; code: string; title: string }[],
  scores: ScoreRecord[]
): RankedScheme[] {
  const rows = schemes.map((scheme) => {
    const schemeScores = scores.filter((score) => score.schemeId === scheme.id);
    const verdicts = new Map(evaluateScheme(schemeScores).map((detail) => [detail.record.id, detail]));
    const valid = schemeScores.filter((record) => isEligible(record) && verdicts.get(record.id)?.verdict !== "suspended");
    const total = valid.length ? valid.reduce((sum, record) => sum + weightedTotal(record.values), 0) / valid.length : 0;
    return {
      ...scheme,
      total: Number(total.toFixed(2)),
      judgeCount: valid.length,
      conflicts: schemeScores.filter((record) => record.conflict).length,
      pending: schemeScores.filter((record) => record.confirmStatus === "pending").length,
      suspended: schemeScores.filter((record) => verdicts.get(record.id)?.verdict === "suspended").length,
      rank: null as number | null,
      qualified: valid.length >= MIN_VALID_SCORES
    };
  });

  const ranked = rows.filter((row) => row.qualified).sort((a, b) => b.total - a.total);
  // 标准竞赛排名：并列同名次，下一名次按实际位置计（1,1,3）
  ranked.forEach((row, index) => {
    row.rank = index > 0 && ranked[index - 1].total === row.total ? ranked[index - 1].rank : index + 1;
  });
  const unranked = rows.filter((row) => !row.qualified).sort((a, b) => b.total - a.total);
  return [...ranked, ...unranked];
}

/** 评委对某方案的提交义务是否完成：在岗评委有有效提交；替补接手时确认旧评分也算完成 */
export function judgeFulfilled(roster: JudgeMember[], scores: ScoreRecord[], judge: string, schemeId: string): boolean {
  const member = roster.find((entry) => entry.name === judge);
  if (!member || member.role === "exited") return true;
  const own = scores.some((score) =>
    score.schemeId === schemeId &&
    score.judge === judge &&
    score.submitted &&
    !score.conflict &&
    score.confirmStatus !== "pending"
  );
  if (own) return true;
  // 替补确认前任评委的待确认评分，视为替补完成本方案义务
  const predecessor = member.role === "substitute" ? member.replaces : undefined;
  return Boolean(predecessor && scores.some((score) =>
    score.schemeId === schemeId &&
    score.judge === predecessor &&
    score.submitted &&
    !score.conflict &&
    score.confirmStatus === "confirmed"
  ));
}

/** 某方案在岗评委是否全部完成 */
export function allFulfilled(roster: JudgeMember[], scores: ScoreRecord[], schemeId: string): boolean {
  return activeJudges(roster).every((name) => judgeFulfilled(roster, scores, name, schemeId));
}
