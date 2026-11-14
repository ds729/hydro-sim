import { describe, expect, it } from 'vitest';
import { soundsOf } from './sound';

describe('効果音の選び方', () => {
  it('記録の種類から音を選び、同じ音は1回にまとめ、自動の操作は鳴らさない', () => {
    const ev = [
      { kind: 'command', command: { type: 'dose' } }, { kind: 'command', command: { type: 'dose' } },
      { kind: 'command', command: { type: 'dose' }, auto: true },
      { kind: 'outage' }, { kind: 'harvest' }, { kind: 'morning' },
    ];
    expect(soundsOf(ev).sort()).toEqual(['alarm', 'harvest', 'pour', 'powerDown']);
    expect(soundsOf([{ kind: 'command', command: { type: 'dose' }, auto: true }])).toEqual([]);
    expect(soundsOf([{ kind: 'command', command: { type: 'fixPump' } }, { kind: 'powerBack' }])).toEqual(['pump', 'powerUp']);
  });
});
