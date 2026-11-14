// 効果音（Phase 5）：Web Audio でその場で作る（音のファイルは使わない）。既定はオフで、☰ の「音」で切り替える（このブラウザに保存）。
// AudioContext はブラウザの決まりで、利用者の操作（クリック・タップ）の中でしか鳴らし始められないので、最初の操作で作る

const KEY = 'hydro-sim.sound';

export type SoundName =
  /** 資材を入れる（水音＋ぽちゃん）。全交換は長い水音 */
  | 'pour' | 'refill'
  /** 警報（停電・ポンプの停止）。続いている間は間をあけて小さく繰り返す */
  | 'alarm' | 'alarmRepeat'
  /** 停電・電気が戻る・ポンプを直した */
  | 'powerDown' | 'powerUp' | 'pump'
  /** 収穫・測る */
  | 'harvest' | 'measure';

/** 同じ音を続けて鳴らさない間隔（秒）。×16 で記録が一度にたくさん入っても音が重ならないように */
const GAP = 0.15;

export class Sound {
  enabled = false;
  private ctx: AudioContext | null = null;
  private out!: GainNode;
  private noise!: AudioBuffer;
  private last: Partial<Record<SoundName, number>> = {};

  constructor() {
    try { this.enabled = localStorage.getItem(KEY) === '1'; } catch { /* 保存できない環境では既定のまま */ }
    // 保存値がオンなら、最初の操作で AudioContext を作る
    addEventListener('pointerdown', () => { if (this.enabled) this.unlock(); }, { once: true });
  }

  /** オン・オフを切り替える（ボタンのクリックの中で呼ぶ＝その場で鳴らし始められる） */
  set(on: boolean): void {
    this.enabled = on;
    try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* 保存できなくても今回は効く */ }
    if (on) { this.unlock(); this.play('measure'); }
  }

  private unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AC) return;
      const c = (this.ctx = new AC());
      this.out = c.createGain();
      this.out.gain.value = 0.3;
      this.out.connect(c.destination);
      // 水音用の白色雑音（1秒分を使い回す）
      const n = (this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate)), d = n.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume();
  }

  play(name: SoundName): void {
    const c = this.ctx;
    if (!this.enabled || !c || c.state !== 'running') return;
    const now = c.currentTime;
    if (now - (this.last[name] ?? -9) < GAP) return;
    this.last[name] = now;
    switch (name) {
      case 'pour': this.water(now, 0.25, 1800); this.tone(now + 0.12, 'sine', 700, 220, 0.12, 0.5); break;
      case 'refill': this.water(now, 1.0, 1200); break;
      case 'alarm': for (let i = 0; i < 3; i++) { this.tone(now + i * 0.32, 'square', 880, 880, 0.14, 0.22); this.tone(now + i * 0.32 + 0.16, 'square', 660, 660, 0.14, 0.22); } break;
      case 'alarmRepeat': this.tone(now, 'square', 880, 880, 0.12, 0.1); this.tone(now + 0.16, 'square', 660, 660, 0.12, 0.1); break;
      case 'powerDown': this.tone(now, 'sawtooth', 220, 40, 0.7, 0.25, 900); break;
      case 'powerUp': this.tone(now, 'sawtooth', 50, 160, 0.6, 0.18, 900); break;
      case 'pump': this.tone(now, 'sawtooth', 70, 140, 0.5, 0.2, 600); this.tone(now + 0.5, 'sine', 990, 1320, 0.12, 0.25); break;
      case 'harvest': [784, 988, 1175].forEach((f, i) => this.tone(now + i * 0.09, 'triangle', f, f, 0.25, 0.3)); break;
      case 'measure': this.tone(now, 'sine', 1320, 1320, 0.07, 0.25); break;
    }
  }

  /** 音程が from から to へ動く短い音。lowpass は高い音を削る（モーター音など） */
  private tone(at: number, type: OscillatorType, from: number, to: number, dur: number, vol: number, lowpass?: number) {
    const c = this.ctx!, o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(from, at);
    o.frequency.exponentialRampToValueAtTime(to, at + dur);
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(vol, at + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    let node: AudioNode = o;
    if (lowpass) { const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lowpass; o.connect(f); node = f; }
    node.connect(g).connect(this.out);
    o.start(at);
    o.stop(at + dur + 0.02);
  }

  /** 水音：帯域を絞った雑音。freq は帯域の中心 */
  private water(at: number, dur: number, freq: number) {
    const c = this.ctx!, s = c.createBufferSource(), f = c.createBiquadFilter(), g = c.createGain();
    s.buffer = this.noise;
    s.loop = true;
    f.type = 'bandpass';
    f.frequency.setValueAtTime(freq, at);
    f.frequency.linearRampToValueAtTime(freq * 0.6, at + dur);
    f.Q.value = 1.2;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(0.35, at + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
    s.connect(f).connect(g).connect(this.out);
    s.start(at);
    s.stop(at + dur + 0.02);
  }
}

/**
 * 記録の新しい分から鳴らす音を選ぶ（栽培・経営で共通の形だけを見る）。自動の操作（auto）は鳴らさない（頻繁なので）
 */
export function soundsOf(events: readonly { kind: string; command?: { type: string }; auto?: boolean }[]): SoundName[] {
  const out = new Set<SoundName>();
  for (const e of events) {
    if (e.kind === 'outage') { out.add('powerDown'); out.add('alarm'); }
    else if (e.kind === 'pumpStop') out.add('alarm');
    else if (e.kind === 'powerBack') out.add('powerUp');
    else if (e.kind === 'harvest') out.add('harvest');
    else if (e.kind === 'command' && !e.auto && e.command) {
      const t = e.command.type;
      if (t === 'dose') out.add('pour');
      else if (t === 'replaceSolution') out.add('refill');
      else if (t === 'fixPump') out.add('pump');
      else if (t === 'measure') out.add('measure');
    }
  }
  return [...out];
}
