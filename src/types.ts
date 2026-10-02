export type Viewer = string;

export type JudgeRole = "active" | "exited" | "substitute";
export type SchemeStatus = "待评分" | "评分中" | "已提交" | "已锁定";

/** 异常判定结果：偏离其他评委有效中位分过多的评分被挂起 */
export type Verdict = "normal" | "suspended";
/** 退出评委已提交评分的确认状态：待替补确认，确认后转为有效 */
export type ConfirmStatus = "none" | "pending" | "confirmed";

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

export interface JudgeMember {
  name: string;
  role: JudgeRole;
  /** 替补接手的退出评委；退出评委被接手时指向替补 */
  replaces?: string;
  since?: string;
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
  /** 每次保存自增，用于多窗口乐观并发控制 */
  rev: number;
  /** 异常判定（默认 normal，旧数据缺字段时按兼容方式补全） */
  verdict: Verdict;
  /** 退出评委已提交评分的确认状态 */
  confirmStatus: ConfirmStatus;
}

/** 某方案下单个评分的判定明细 */
export interface VerdictDetail {
  record: ScoreRecord;
  verdict: Verdict;
  /** 本评分加权总分 */
  total: number;
  /** 其他评委有效评分的中位分 */
  peerMedian: number | null;
  /** 与中位分的偏离绝对值 */
  deviation: number | null;
}

export interface SaveResult {
  ok: boolean;
  /** conflict：另一窗口已更新同一条评分，草稿保留在本地 */
  reason?: "conflict" | "failed";
  /** 冲突时携带对端最新的评分 */
  remote?: ScoreRecord;
}

export interface ReviewEvent {
  id: string;
  time: string;
  actor: Viewer;
  action: string;
  detail: string;
}
