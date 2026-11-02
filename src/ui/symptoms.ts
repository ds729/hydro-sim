// 症状の説明（見た目・なぜ・対処）。診断モードの答え合わせ、図鑑、なぜ？ログで共用する。文言は symptoms.json に置く

import symptomsJson from '../data/symptoms.json';
import type { Cause, SupplyId } from '../sim';

export interface Symptom {
  /** 症状の名前（例：濃度障害） */
  name: string;
  /** 原因の短い名前（例：EC高）。診断の選択肢に使う */
  label: string;
  icon: string;
  /** 見た目の特徴 */
  look: string;
  /** 操作によらず自然に起きたときの原因（観察メモで、直近の操作が原因でないときに出す） */
  natural: string;
  /** 原因から見た目に至る理由 */
  why: string;
  /** 対処 */
  fix: string;
  /** 対処に使う資材（supplies.json のキー） */
  tools: SupplyId[];
}

/** キーは `${要因}.${low|high}` */
export const SYMPTOMS = symptomsJson as Record<string, Symptom>;

export const symptomOf = (c: Cause): Symptom => SYMPTOMS[`${c.factor}.${c.side}`];
