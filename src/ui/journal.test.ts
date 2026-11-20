import { describe, expect, test } from 'vitest';
import { bangBangRules, createSim, CROPS, tick } from '../sim';
import { journalHtml, JOURNAL_SIZE } from './journal';

describe('栽培日誌の自動の操作', () => {
  test('続けて起きた自動の操作は1件にまとめ、手の操作・定点記録は押し出さない', () => {
    const s = createSim({ crop: 'radish', rules: bangBangRules('radish') });
    for (let h = 0; h < 50; h++) tick(s);
    const html = journalHtml(s.log, CROPS.radish);
    const n = (html.match(/class="jn /g) ?? []).length;
    expect(n).toBeLessThanOrEqual(JOURNAL_SIZE);
    expect(html).toMatch(/⚙ 自動の操作 ×\d+（行[\d・]+）/);
    // 2日目・3日目の朝の記録がまとめの間に残る
    expect((html.match(/朝の記録/g) ?? []).length).toBe(2);
  });

  test('1回だけの自動の操作は行と分まで出す', () => {
    const s = createSim({ crop: 'radish' });
    s.log.push({ hour: 3, kind: 'command', command: { type: 'dose', target: 'bed', supply: 'fertilizer', amount: 10 }, auto: true, rule: 0, minute: 3 * 60 + 25 });
    expect(journalHtml(s.log, CROPS.radish)).toContain('Day 1 03:25</small>⚙ 自動（行1）：肥料を10mL追加');
  });
});
