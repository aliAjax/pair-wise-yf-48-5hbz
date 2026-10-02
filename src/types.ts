export type Viewer = "评委-林策" | "评委-周筑" | "评委-替补" | "主办方";
export type SchemeStatus = "待评分" | "评分中" | "已提交" | "已锁定";

export interface Scheme {
  id: string;
  code: string;
  title: string;
  synopsis: string;
  publicNo: string;
  status: SchemeStatus;
}

export interface Criterion {
  id: string;
  name: string;
  description: string;
  weight: number;
  max: number;
}

/**
 * 异常判定结果：同一方案里偏离其他评委中位分过多的评分先挂起，
 * 原值和意见保留但不计入名次。
 */
export interface AnomalyJudgment {
  scoreId: string;
  schemeId: string;
  judge: Viewer;
  suspended: boolean;
  reason: string;
  median: number | null;
  deviation: number | null;
  /** 评分改动后置为过期，需要重算 */
  stale?: boolean;
}

export interface ScoreRecord {
  id: string;
  judge: Viewer;
  schemeId: string;
  values: Record<string, number>;
  comment: string;
  submitted: boolean;
  conflict: boolean;
  updatedAt: string;
  // —— 判定与更替字段（旧数据缺失时按兼容方式补齐）——
  /** 异常分挂起：偏离其他评委中位分过多，不计入名次 */
  suspended?: boolean;
  suspensionReason?: string;
  /** 退出评委已提交的评分保留但标为待确认 */
  pendingConfirmation?: boolean;
  /** 由哪位退出评委转交而来 */
  transferredFrom?: Viewer;
}

export interface ReviewEvent {
  id: string;
  time: string;
  actor: Viewer;
  action: string;
  detail: string;
}
