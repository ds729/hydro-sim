// 画面の組み立てとメインループ。sim は固定タイムステップ（1 tick ＝ 1時間）で進め、描画は毎フレーム

import './ui/style.css';
import { applyCommand, createSim, CROPS, cropSpec, tick, type Command, type SimState } from './sim';
import { PRESETS, type PresetName } from './render/camera';
import { modelStatus } from './render/models';
import { View, type Quality } from './render/view';
import { Hud } from './ui/hud';
import { shortName, showResult } from './ui/result';
import { mountQuality } from './ui/quality';
import { mountTools } from './ui/tools';
import { QuizPanel } from './ui/quiz';
import { markSeen, openZukan } from './ui/zukan';

const $ = (id: string) => document.getElementById(id)!;
const app = $('app'), menu = $('mb');
/** スマホ用レイアウト（style.css の @media と同じ条件） */
const MOBILE = matchMedia('(max-width:720px),(max-height:500px)');
/** 横向きスマホ：HUD は左の縦長、道具バーは右の縦並び（style.css と同じ条件） */
const LAND = matchMedia('(max-height:500px) and (min-aspect-ratio:4/3)');

let s: SimState = createSim();
/** 1秒あたりに進める時間（h） */
let speed = 4;
/** HUD を描き直す必要があるか */
let dirty = true;
let resultShown = false;

const view = new View($('cv') as HTMLCanvasElement);
const hud = new Hud(cropSpec(s), e => {
  markSeen('symptoms', `${e.factor}.${e.side}`);
  if (!app.classList.contains('so')) menu.classList.add('nw');
});
markSeen('crops', s.crop.id);
$('zo').onclick = () => openZukan();

/** 症状診断モード。診断中は栽培を止め、栽培の状態はそのまま残す */
const quiz = new QuizPanel(() => setMode('grow'));

function send(c: Command) {
  if (!quiz.active && applyCommand(s, c)) dirty = true;
}

/** モードを切り替える（栽培 ⇔ 症状診断）。seed は診断の問題の乱数 */
function setMode(m: 'grow' | 'quiz', seed = Date.now()) {
  if (m === 'quiz') quiz.start(seed); else quiz.stop();
  app.classList.toggle('qm', m === 'quiz');
  for (const [k, b] of modeBtns) b.classList.toggle('on', k === m);
  view.rig.goTo(m === 'quiz' ? '寄り' : '全景');
  dirty = true;
}
const modeBtns = ([['grow', '栽培'], ['quiz', '症状診断']] as const).map(([k, label]) => {
  const b = document.createElement('button');
  b.textContent = label;
  if (k === 'grow') b.className = 'on';
  b.onclick = () => {
    if (k === (quiz.active ? 'quiz' : 'grow')) return;
    setMode(k);
    // スマホは ☰ を閉じて 3D を見せる
    if (app.classList.contains('so')) menu.click();
  };
  $('md').appendChild(b);
  return [k, b] as const;
});

/** 始め直す。作物を省くと今の作物のまま */
function restart(crop = s.crop.id) {
  s = createSim({ crop });
  markSeen('crops', crop);
  hud.setCrop(cropSpec(s));
  markCrop();
  resultShown = false;
  dirty = true;
}

// 作物の選択（☰ の中）。育てている途中で変えるときは確かめる
const cropBtns = Object.entries(CROPS).map(([id, c]) => {
  const b = document.createElement('button');
  b.textContent = shortName(c.name);
  b.title = c.note;
  b.onclick = () => {
    if (id === s.crop.id) return;
    if (s.hour > 0 && !s.result && !confirm(`${shortName(c.name)}に変えて、最初から育て直しますか？`)) return;
    restart(id);
  };
  $('cr').appendChild(b);
  return [id, b] as const;
});
function markCrop() {
  for (const [id, b] of cropBtns) b.classList.toggle('on', id === s.crop.id);
}
markCrop();

// 画面サイズ・パネル位置から、3D がパネルに隠れない領域を決めてカメラを合わせ直す
function layout() {
  const w = app.clientWidth, h = app.clientHeight, hb = $('hud').getBoundingClientRect(), bb = $('bar').getBoundingClientRect();
  const sd = $('side').style;
  if (LAND.matches) {
    // ☰ の中身は HUD と道具バーの間に開く
    Object.assign(sd, { left: hb.right + 8 + 'px', right: w - bb.left + 8 + 'px', top: '8px', maxHeight: h - 16 + 'px' });
    view.resize(w, h, [[hb.right + 8, 8, bb.left - 8, h - 8]]);
  } else if (MOBILE.matches) {
    Object.assign(sd, { left: '', right: '', top: hb.bottom + 8 + 'px', maxHeight: bb.top - hb.bottom - 16 + 'px' });
    view.resize(w, h, [[10, hb.bottom + 8, w - 10, bb.top - 8]]);
  } else {
    Object.assign(sd, { left: '', right: '', top: '', maxHeight: '' });
    // PC：左右のパネルの間（縦長）と、パネルの下（横長）の2候補。縦長の画面（タブレット縦など）では下が広くなる
    const sb = $('side').getBoundingClientRect();
    view.resize(w, h, [[hb.right + 10, 10, sb.left - 10, bb.top - 8], [10, Math.max(hb.bottom, sb.bottom) + 8, w - 10, bb.top - 8]]);
  }
}

// 時間・カメラ・メニュー
const sp = $('sp');
for (const [label, v] of [['⏸', 0], ['×1', 1], ['×4', 4], ['×16', 16]] as const) {
  const b = document.createElement('button');
  b.textContent = label;
  if (v === speed) b.className = 'on';
  b.onclick = () => {
    speed = v;
    for (const c of sp.children) c.classList.toggle('on', c === b);
  };
  sp.appendChild(b);
}
for (const k of Object.keys(PRESETS) as PresetName[]) {
  const b = document.createElement('button');
  b.textContent = k;
  b.onclick = () => view.rig.goTo(k);
  $('cm').appendChild(b);
}
menu.onclick = () => {
  const open = app.classList.toggle('so');
  menu.setAttribute('aria-expanded', String(open));
  menu.classList.remove('nw');
};
mountTools($('bar'), send);
mountQuality($('qa'), q => view.setQuality(q));

hud.update(s);
layout();
view.rig.goTo('全景', true);
addEventListener('resize', layout);
document.fonts?.ready.then(layout);
// 日誌が伸びる・☰ を開くなどでパネルの大きさが変わったときも合わせ直す
const ro = new ResizeObserver(() => layout());
for (const id of ['hud', 'side', 'bar']) ro.observe($(id));

let last = performance.now(), acc = 0, sinceHud = 0;
/** fps の表示（画質の見出しの右）。1秒ごとに直近1秒の平均を出す。実機で画質を選ぶ目安 */
const fpsEl = $('fps');
let frames = 0, fpsAt = last, fps = 0;
function loop(now: number) {
  const dt = Math.min(0.25, (now - last) / 1000);
  last = now;
  if (!quiz.active && !s.result && speed) {
    acc += dt * speed;
    while (acc >= 1 && !s.result) { acc--; tick(s); dirty = true; }
  }
  sinceHud += dt;
  if (!quiz.active) {
    if (dirty || sinceHud > 0.1) { hud.update(s); dirty = false; sinceHud = 0; }
    if (s.result && !resultShown) { resultShown = true; showResult(s.result, s.crop.id, restart); }
  }
  view.frame(quiz.sim ?? s, now / 1000, quiz.blind);
  frames++;
  if (now - fpsAt >= 1000) {
    fps = (frames * 1000) / (now - fpsAt);
    fpsEl.textContent = `${Math.round(fps)} fps`;
    frames = 0;
    fpsAt = now;
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// 確認用の口（tools/screenshot.mjs やブラウザのコンソールから使う）
Object.assign(window, {
  hydro: {
    get state() { return s; },
    /** n 時間進める（速度とは無関係に即時） */
    tick(n = 1) { for (let i = 0; i < n && !s.result; i++) tick(s); dirty = true; },
    send,
    /** 始め直す（作物 id を渡すとその作物で。確認なし） */
    restart,
    setSpeed(v: number) { speed = v; },
    camera(name: PresetName, instant = true) { view.rig.goTo(name, instant); },
    toggleMenu() { menu.click(); },
    renderInfo() { return { ...view.renderer.info.render }; },
    /** 症状診断モード：mode('quiz', seed) で始める。quiz.answer({factor:'ec',side:'high'})・quiz.next() で進める */
    mode: setMode,
    /** 図鑑を開く（'crops' / 'symptoms'） */
    zukan: openZukan,
    quiz,
    /** 直近1秒の平均 fps */
    get fps() { return fps; },
    /** 画質を変える（例 hydro.quality({shadows:false,dpr:1})）。ボタンの表示と保存値は変えない */
    quality(q: Quality) { view.setQuality(q); },
    /** 描画の調整用（露出・ライトの強度などをコンソールから試す） */
    view,
    /** .glb の読み込み状態（'ok' / 'error: <URL>'） */
    models: modelStatus,
  },
});
