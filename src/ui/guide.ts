// 初回の案内（課題「はじめての収穫」）：吹き出しで次の操作を示し、押すボタンとゲージを光らせる。
// どの操作を案内するかは sim の値と作物の適正帯から決める（guideIssue。純粋な関数なので Vitest で検査する）

import { cropSpec, diagnose, type Factor, type SimState } from '../sim';

/** 案内する困りごと（要因と向き）と、押すボタン（道具バーのキー。null は「待つ」） */
export interface Issue { factor: Factor; side: 'low' | 'high'; key: string | null }

/** 帯の端からこの割合の内側に来たら案内を出し、RESOLVE の内側まで戻ったら解決とみなす（出たり消えたりしないように差をつける） */
const TRIGGER = 0.1, RESOLVE = 0.2;
/** 調べる順（同時に起きたら先のものから） */
const ORDER: [Factor, 'low' | 'high', string | null][] = [
  ['ec', 'low', '1'], ['ph', 'high', '3'], ['water', 'low', '2'], ['ec', 'high', '2'], ['ph', 'low', '4'], ['water', 'high', null],
];

/** 帯の端からの位置（0＝適正帯の下端、1＝上端） */
function pos(s: SimState, k: Factor): number {
  const b = cropSpec(s).bands[k], v = diagnose(s).values[k];
  return (v - b[1]) / (b[2] - b[1]);
}

const outside = (p: number, side: 'low' | 'high', m: number) => (side === 'low' ? p < m : p > 1 - m);

/**
 * 今案内すること。active は今出している困りごと（解決するまで出し続ける）。
 * 返すのは出し続ける・新しく出す困りごと（なければ null）
 */
export function guideIssue(s: SimState, active: Issue | null): Issue | null {
  if (active && outside(pos(s, active.factor), active.side, RESOLVE)) return active;
  for (const [factor, side, key] of ORDER) if (outside(pos(s, factor), side, TRIGGER)) return { factor, side, key };
  return null;
}

/** 困りごとごとの吹き出しの文 */
const TEXT: Record<string, [string, string]> = {
  'ec.low': ['EC が低い＝肥料が足りない', 'このままだと葉が黄緑になります。<b>🧪 肥料</b>を押して、EC の印を緑の帯に入れよう（3回くらい）。'],
  'ec.high': ['EC が高い＝養液が濃い', '水が吸われて肥料が濃くなりました。<b>💧 水</b>で薄めよう。'],
  'ph.high': ['pH が上がってきた', '根が育つと pH は上がっていきます。6.5 を超えると養分が吸いにくくなるので、<b>🔽 pHダウン</b>を1回。'],
  'ph.low': ['pH が下がりすぎ', '<b>🔼 pHアップ</b>で 5.5〜6.5 に戻そう。'],
  'water.low': ['液量が減ってきた', '苗が水を吸って減りました。<b>💧 水</b>を足そう。'],
  'water.high': ['液量が多い', '水の入れすぎ。苗が吸って減るまで待とう（足さない）。'],
};

export interface GuideHooks {
  speed(): number;
  setSpeed(v: number): void;
  /** 案内を終える（案内なしで遊ぶ・収穫した） */
  onEnd(): void;
}

const $ = (id: string) => document.getElementById(id)!;

/** 吹き出し（#gd）と光らせる部品を受け持つ。update は HUD の更新と同じ間隔で呼ぶ */
export class Guide {
  private stage: 'intro' | 'run' | 'end' = 'intro';
  private active: Issue | null = null;
  /** 一度止めた困りごと（2回目からは止めない） */
  private paused = new Set<string>();
  /** 止める前の速さ（解決したら戻す） */
  private resume = 0;
  private praiseUntil = 0;
  private ripeShown = false;
  private html = '';

  constructor(private hooks: GuideHooks) {
    $('gd').addEventListener('click', e => {
      const a = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-ga]')?.dataset.ga;
      if (a === 'start') { this.stage = 'run'; hooks.setSpeed(4); }
      else if (a === 'skip') this.end();
    });
  }

  get running(): boolean { return this.stage !== 'end'; }

  /** 始める（時間を止めて、ゲージの見方から） */
  start(): void {
    this.stage = 'intro';
    this.active = null;
    this.paused.clear();
    this.ripeShown = false;
    this.hooks.setSpeed(0);
  }

  /** 案内を消す（課題をやめたときなど。onEnd は呼ばない） */
  stop(): void {
    this.stage = 'end';
    this.show('', []);
  }

  private end() {
    this.stop();
    this.hooks.onEnd();
  }

  update(s: SimState): void {
    if (this.stage === 'end') return;
    if (s.result) { this.end(); return; }
    if (this.stage === 'intro') {
      this.show('<b>ようこそ！ラディッシュを1トレイ、8日で育てます</b><p>光っているゲージが養液の EC（肥料の濃さ）・pH・液量。黒い印が今の値で、<b>緑の帯が適正</b>。外れたら道具バーのボタンで戻します。困ったときはこの吹き出しが教えます。</p>'
        + '<div class="g"><button data-ga="start" class="on">はじめる</button><button data-ga="skip">案内なしで</button></div>', ['#gs']);
      return;
    }
    const prev = this.active;
    this.active = guideIssue(s, prev);
    const now = performance.now();
    if (prev && !this.active) {
      // 解決した：ほめて、止めていたら元の速さに戻す
      this.praiseUntil = now + 3500;
      if (this.hooks.speed() === 0 && this.resume) this.hooks.setSpeed(this.resume);
      this.resume = 0;
    }
    const a = this.active;
    if (a) {
      const k = `${a.factor}.${a.side}`, [title, body] = TEXT[k];
      if (!this.paused.has(k)) {
        this.paused.add(k);
        this.resume = this.hooks.speed() || 4;
        this.hooks.setSpeed(0);
      }
      const hint = this.hooks.speed() === 0 ? '<small>直したら時間が進みます。</small>' : '';
      this.show(`<b>${title}</b><p>${body}</p>${hint}`, [`#t${a.factor}`, ...(a.key ? [`#bar .tl[data-k="${a.key}"]`] : [])]);
    } else if (now < this.praiseUntil) {
      this.show('<b>👍 戻りました</b><p>緑の帯に入っていれば品質は落ちません。また外れそうになったら知らせます。</p>', []);
    } else if (s.crop.growth >= 0.85 && !this.ripeShown) {
      this.ripeShown = true;
      this.praiseUntil = 0;
      this.show('<b>もうすぐ収穫</b><p>生育が 100% になると収穫します。最後まで帯に保とう。</p>', ['#gh']);
    } else if (!this.ripeShown || s.crop.growth < 0.85) {
      this.show('', []);
    }
  }

  /** 吹き出しの中身と光らせる部品を変える（同じなら触らない） */
  private show(html: string, targets: string[]) {
    const key = html + targets.join();
    if (key === this.html) return;
    this.html = key;
    const gd = $('gd');
    gd.innerHTML = html;
    gd.style.display = html ? 'block' : 'none';
    for (const el of document.querySelectorAll('.hl')) el.classList.remove('hl');
    for (const t of targets) document.querySelector(t)?.classList.add('hl');
  }
}
