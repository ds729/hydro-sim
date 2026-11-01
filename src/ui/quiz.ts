// 症状診断モードの画面：問題文と答え合わせは HUD の位置（#qz）、選択肢は道具バーの位置（#qb）に出す

import {
  answerQuiz, causeKey, createQuiz, CROPS, diagnose, nextQuestion, QUIZ_CAUSES, questionSim, quizScore,
  type Cause, type Factor, type Quiz, type SimState,
} from '../sim';
import { shortName } from './result';
import { symptomOf } from './symptoms';

const $ = (id: string) => document.getElementById(id)!;

/** 答え合わせで出すセンサの値 [要因, 表示名, 単位, 小数桁] */
const READINGS: [Factor, string, string, number][] = [['ec', 'EC', '', 2], ['ph', 'pH', '', 2], ['water', '液量', 'L', 2]];

export class QuizPanel {
  private quiz: Quiz | null = null;
  private current: SimState | null = null;
  private buttons = new Map<string, HTMLButtonElement>();

  constructor(private onExit: () => void) {
    for (const c of QUIZ_CAUSES) {
      const b = document.createElement('button'), sy = symptomOf(c);
      b.className = 'tl';
      b.innerHTML = `<b>${sy.icon}</b><span>${sy.label}</span><em>${sy.name}</em>`;
      b.onclick = () => this.answer(c);
      $('qb').appendChild(b);
      this.buttons.set(causeKey(c), b);
    }
  }

  get active(): boolean { return this.quiz !== null; }
  /** 描画する栽培槽（今の問題） */
  get sim(): SimState | null { return this.current; }
  /** 答える前はセンサの表示を伏せる */
  get blind(): boolean { return !!this.quiz && this.quiz.index < this.quiz.questions.length && !this.quiz.answers[this.quiz.index]; }
  get state(): Quiz | null { return this.quiz; }

  /** 1周を始める */
  start(seed: number): void {
    this.quiz = createQuiz(seed);
    this.show();
  }

  stop(): void {
    this.quiz = this.current = null;
  }

  /** 選択肢で答える（確認用の口からも使う） */
  answer(c: Cause): void {
    const z = this.quiz;
    if (!z || answerQuiz(z, c) === null) return;
    this.reveal();
  }

  next(): void {
    if (!this.quiz) return;
    if (nextQuestion(this.quiz)) this.show(); else this.summary();
  }

  private show() {
    const z = this.quiz!, q = z.questions[z.index];
    this.current = questionSim(q);
    $('qh').textContent = `症状診断 ${z.index + 1} / ${z.questions.length}`;
    $('qz').innerHTML = `<p class="qq"><b>${shortName(CROPS[q.crop].name)}</b>（生育 ${Math.round(q.growth * 100)}%）が弱っています。原因は？</p>`
      + '<small>葉の色・大きさ・しおれ、根の色を見て、原因のボタンで答えよう（カメラの「寄り」が見やすい）。センサの値は答えたあとに出ます。</small>';
    for (const b of this.buttons.values()) {
      b.disabled = false;
      b.classList.remove('ok', 'ng');
    }
  }

  private reveal() {
    const z = this.quiz!, q = z.questions[z.index], a = z.answers[z.index]!, sy = symptomOf(q.cause);
    const right = causeKey(a) === causeKey(q.cause), { values } = diagnose(this.current!), bands = CROPS[q.crop].bands;
    for (const [k, b] of this.buttons) {
      b.disabled = true;
      b.classList.toggle('ok', k === causeKey(q.cause));
      b.classList.toggle('ng', !right && k === causeKey(a));
    }
    const readings = READINGS.map(([k, label, unit, d]) => {
      const t = `${label} ${values[k].toFixed(d)}${unit}`, b = bands[k];
      return k === q.cause.factor ? `<b class="qo">${t}（適正 ${b[1]}〜${b[2]}${unit}）</b>` : t;
    }).join('・');
    const last = z.index === z.questions.length - 1;
    $('qz').innerHTML = `<div class="qr ${right ? 'ok' : 'ng'}">${right ? '⭕ 正解！' : `❌ 残念（あなたの答え：${symptomOf(a).label}）`}</div>`
      + `<p class="qq"><b>答え：${sy.icon} ${sy.label}＝${sy.name}</b></p>`
      + `<p>👀 ${sy.look}</p><p>❓ ${sy.why}</p><p>🛠 ${sy.fix}</p>`
      + `<p class="qs">センサ：${readings}</p>`
      + `<button id="qn" style="width:100%">${last ? '結果を見る' : '次の問題 →'}</button>`;
    $('qn').onclick = () => this.next();
  }

  private summary() {
    // 描画は最後の問題の栽培槽のまま（答え合わせ後なのでセンサも見える）
    const z = this.quiz!, n = z.questions.length, sc = quizScore(z);
    $('qh').textContent = '症状診断 結果';
    const rows = z.questions.map((q, i) => {
      const a = z.answers[i]!, ok = causeKey(a) === causeKey(q.cause), sy = symptomOf(q.cause);
      return `<li>${ok ? '⭕' : '❌'} ${shortName(CROPS[q.crop].name)}：${sy.label}（${sy.name}）${ok ? '' : `<small>あなた：${symptomOf(a).label}</small>`}</li>`;
    }).join('');
    $('qz').innerHTML = `<p class="qq"><b>${n} 問中 ${sc} 問正解</b>${sc === n ? '　全問正解！' : ''}</p><ul class="ql">${rows}</ul>`
      + '<div class="g"><button id="qg">もう一周</button><button id="qx">栽培に戻る</button></div>';
    $('qg').onclick = () => this.start(Date.now());
    $('qx').onclick = () => this.onExit();
    for (const b of this.buttons.values()) {
      b.disabled = true;
      b.classList.remove('ok', 'ng');
    }
  }
}
