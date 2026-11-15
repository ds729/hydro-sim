import { describe, expect, test } from 'vitest';
import { applyCommand, judgeScenario, startScenario, tick } from '../sim';
import { TOOLS } from './tools';
import { guideIssue, type Issue } from './guide';

describe('初回の案内（Phase 6）', () => {
  test('案内が示すボタンだけを押せば、はじめての収穫を S で達成できる。案内は肥料から始まり pH にも触れる', () => {
    const run = startScenario('first');
    if (run.mode !== 'grow') throw new Error();
    const s = run.sim, shown: string[] = [];
    let active: Issue | null = null;
    while (!s.result) {
      active = guideIssue(s, active);
      if (active) {
        const k = `${active.factor}.${active.side}`;
        if (shown.at(-1) !== k) shown.push(k);
        // 人の操作：案内が出ている間、1時間に1回だけ示されたボタンを押す
        const tool = TOOLS.find(t => t.key === active!.key);
        if (tool) applyCommand(s, tool.command);
      }
      tick(s);
    }
    expect(shown[0]).toBe('ec.low');
    expect(shown).toContain('ph.high');
    expect(s.result!.grade).toBe('S');
    expect(judgeScenario(run).status).toBe('cleared');
  });

  test('出した案内は、帯の内側まで戻るまで出し続ける（端で出たり消えたりしない）', () => {
    const run = startScenario('first');
    if (run.mode !== 'grow') throw new Error();
    const s = run.sim, a = guideIssue(s, null)!;
    expect(a).toMatchObject({ factor: 'ec', side: 'low', key: '1' });
    // EC 0.6 → 0.9（帯の下端 0.8 の内側 1 割 0.92 にも届かない）→ まだ出す
    applyCommand(s, TOOLS[0].command);
    applyCommand(s, TOOLS[0].command);
    expect(guideIssue(s, a)).toBe(a);
    applyCommand(s, TOOLS[0].command);
    expect(guideIssue(s, a)).toBeNull();
  });
});
