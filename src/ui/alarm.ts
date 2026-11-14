// 警報（HUD の上）：停電・ポンプの停止を出し、止まったポンプを直すボタンを置く。栽培モードと経営モードで共用する。
// 文言はここで作る（sim は設備の状態を持つだけ）

import { BUSINESS, type FacilityState } from '../sim';

/** 停電・ポンプの停止の警報。pumps は [区画の id, 表示名]。ups は非常用電源（停電中もポンプが回る）。何も起きていなければ空 */
export function alarmHtml(fs: FacilityState, pumps: readonly [string, string][], opts: { ups?: boolean; labor?: boolean } = {}): string {
  const rows: string[] = [];
  if (fs.outage > 0) {
    rows.push(`<div class="alr"><b>⚡ 停電中</b><span>あと約 ${fs.outage}時間</span></div>`
      + `<small>照明とポンプが止まっている。${opts.ups ? '非常用電源でポンプは動いている。' : '電気が戻るのを待つ。'}照明が点く時間帯は育たない。</small>`);
  }
  for (const [id, name] of pumps) {
    if (!fs.pumpDown.includes(id)) continue;
    rows.push(`<div class="alr"><b>🛑 ${name}のポンプ停止</b><button data-fix="${id}">🔧 直す${opts.labor ? `<small>${BUSINESS.laborMin.fixPump}分</small>` : ''}</button></div>`
      + '<small>吸い込み口の詰まり。養液が循環せず、酸素が減っていく。1日放っておくと根が酸欠になる。</small>');
  }
  return rows.join('');
}

/** 記録の from 番目以降に、警報を出すイベント（停電・ポンプの停止）があるか。あれば時間の速さを落とす */
export const alarmed = (log: readonly { kind: string }[], from: number) => log.slice(from).some(e => e.kind === 'outage' || e.kind === 'pumpStop');
