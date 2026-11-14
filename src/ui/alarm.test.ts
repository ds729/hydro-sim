import { describe, expect, it } from 'vitest';
import { createFacility, startOutage, stopPump } from '../sim';
import { alarmed, alarmHtml } from './alarm';

describe('警報', () => {
  it('何も起きていなければ空、停電とポンプの停止は出して、止まったポンプにだけ直すボタン', () => {
    const fs = createFacility(true), pumps: [string, string][] = [['rack1', '棚1'], ['rack2', '棚2']];
    expect(alarmHtml(fs, pumps)).toBe('');
    startOutage(fs, 3);
    stopPump(fs, 'rack2');
    const html = alarmHtml(fs, pumps, { ups: true });
    expect(html).toContain('停電中');
    expect(html).toContain('非常用電源');
    expect(html).toContain('data-fix="rack2"');
    expect(html).not.toContain('data-fix="rack1"');
  });

  it('記録の新しい分に停電・ポンプの停止があれば警報', () => {
    const log = [{ kind: 'pumpStop' }, { kind: 'morning' }];
    expect(alarmed(log, 0)).toBe(true);
    expect(alarmed(log, 1)).toBe(false);
  });
});
