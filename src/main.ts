// 画面の組み立てとメインループ。sim は固定タイムステップ（1 tick ＝ 1時間）で進め、描画は毎フレーム

import './ui/style.css';
import { applyCommand, BUSINESS, createFarm, createSim, CROPS, cropSpec, farmTick, startOutage, stopPump, tick, type Command, type FarmCommand, type SimState } from './sim';
import { PRESETS, type PresetName } from './render/camera';
import { modelStatus } from './render/models';
import { View, type Quality } from './render/view';
import { Hud } from './ui/hud';
import { shortName, showResult } from './ui/result';
import { mountQuality } from './ui/quality';
import { mountTools } from './ui/tools';
import { QuizPanel } from './ui/quiz';
import { FarmPanel } from './ui/farm';
import { markSeen, openZukan } from './ui/zukan';
import { alarmed, alarmHtml } from './ui/alarm';
import { Sound, soundsOf } from './ui/sound';

const $ = (id: string) => document.getElementById(id)!;
const app = $('app'), menu = $('mb');
/** スマホ用レイアウト（style.css の @media と同じ条件） */
const MOBILE = matchMedia('(max-width:720px),(max-height:500px)');
/** 横向きスマホ：HUD は左の縦長、道具バーは右の縦並び（style.css と同じ条件） */
const LAND = matchMedia('(max-height:500px) and (min-aspect-ratio:4/3)');

/** 栽培モードで停電・ポンプの停止を起こすか（☰ の「イベント」。既定はなし。このブラウザに保存） */
const EVENTS_KEY = 'hydro-sim.events';
let growEvents = false;
try { growEvents = localStorage.getItem(EVENTS_KEY) === '1'; } catch { /* 保存できない環境では既定のまま */ }
/** イベントの乱数のシード（画面では毎回変える。同じ日に同じことが起きないように） */
const newSeed = () => (Math.random() * 2 ** 32) >>> 0;

let s: SimState = createSim({ events: growEvents, seed: newSeed() });
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

type Mode = 'grow' | 'quiz' | 'farm';
let mode: Mode = 'grow';

/** 症状診断モード。診断中は栽培を止め、栽培の状態はそのまま残す */
const quiz = new QuizPanel(() => setMode('grow'));
/** 経営モード。栽培モードとは別の状態（FarmState）で、モードを切り替えても続きから。月を締めたら時間を止める */
const farm = new FarmPanel(createFarm({ events: true, seed: newSeed() }), () => setSpeed(0));

/** 道具バーの操作。経営モードでは選んでいる棚に効かせる */
function send(c: Command) {
  if (mode === 'farm') { if (farm.send({ ...c, target: farm.rackId() })) dirty = true; }
  else if (mode === 'grow' && applyCommand(s, c)) dirty = true;
}

/** モードを切り替える（栽培・症状診断・経営）。seed は診断の問題の乱数 */
function setMode(m: Mode, seed = Date.now()) {
  if (m === 'quiz') quiz.start(seed); else quiz.stop();
  if (m !== 'farm') farm.closeBook();
  mode = m;
  app.classList.toggle('qm', m === 'quiz');
  app.classList.toggle('fm', m === 'farm');
  for (const [k, b] of modeBtns) b.classList.toggle('on', k === m);
  setToolScale(m === 'farm' ? BUSINESS.slotsPerRack : 1);
  view.rig.goTo(m === 'quiz' ? '寄り' : '全景');
  dirty = true;
}
const modeBtns = ([['grow', '栽培'], ['quiz', '症状診断'], ['farm', '経営']] as const).map(([k, label]) => {
  const b = document.createElement('button');
  b.textContent = label;
  if (k === 'grow') b.className = 'on';
  b.onclick = () => {
    if (k === mode) return;
    setMode(k);
    // スマホは ☰ を閉じて 3D を見せる
    if (app.classList.contains('so')) menu.click();
  };
  $('md').appendChild(b);
  return [k, b] as const;
});

/** 始め直す。作物を省くと今の作物のまま */
function restart(crop = s.crop.id) {
  s = createSim({ crop, events: growEvents, seed: newSeed() });
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

// イベント（栽培モードの ☰）：あり にすると停電・ポンプの停止が起きる。なし に戻しても、起きている停電・止まったポンプはそのまま
const evBtns = ([[false, 'なし'], [true, 'あり']] as const).map(([v, label]) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = v ? '停電とポンプの停止が起きる（平均 10日・12日に1回）。警報が出たら ×1 に落とす' : 'EC・pH・液量の管理に絞る';
  b.onclick = () => {
    growEvents = s.facility.events = v;
    for (const [k, x] of evBtns) x.classList.toggle('on', k === v);
    try { localStorage.setItem(EVENTS_KEY, v ? '1' : '0'); } catch { /* 保存できなくても今回は効く */ }
  };
  b.classList.toggle('on', v === growEvents);
  $('ev').appendChild(b);
  return [v, b] as const;
});

// 効果音（☰ の「音」。既定はなし）。記録の新しい分から鳴らす
const sound = new Sound();
const sndBtns = ([[false, 'なし'], [true, 'あり']] as const).map(([v, label]) => {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = v ? '操作・警報・収穫の音を鳴らす（Web Audio で作る音）' : '音を鳴らさない';
  b.onclick = () => { sound.set(v); for (const [k, x] of sndBtns) x.classList.toggle('on', k === v); };
  b.classList.toggle('on', v === sound.enabled);
  $('snd').appendChild(b);
  return [v, b] as const;
});
let heard: { log: readonly unknown[]; n: number } = { log: [], n: 0 };
/** 記録の新しい分の音を鳴らす。警報の音は、まだ続いているときだけ（予備ポンプがすぐ切り替えたときは鳴らさない） */
function hear(log: readonly { kind: string }[], fs: { outage: number; pumpDown: string[] }) {
  if (log !== heard.log) { heard = { log, n: log.length }; return; }
  const names = soundsOf(log.slice(heard.n) as Parameters<typeof soundsOf>[0]);
  heard.n = log.length;
  for (const n of names) if (n !== 'alarm' || fs.outage > 0 || fs.pumpDown.length) sound.play(n);
}

// 警報（HUD の上）：停電・ポンプの停止と、ポンプを直すボタン。中身が変わったときだけ書き換える（押している最中のボタンを作り直さない）
const al = $('al');
function updateAlarm() {
  let html = '';
  if (mode === 'grow') html = alarmHtml(s.facility, [[s.setup.bed, '栽培槽']]);
  else if (mode === 'farm') {
    const f = farm.state;
    html = alarmHtml(f.facility, f.racks.map((r, i) => [r.id, f.racks.length > 1 ? `棚${i + 1}` : '棚']), { ups: f.equipment.ups > 0, labor: true });
  }
  if (al.dataset.h !== html) { al.dataset.h = html; al.innerHTML = html; alarmAt = performance.now(); }
  // 警報が続いている間は 8秒ごとに小さく鳴らす
  if (html && performance.now() - alarmAt > 8000) { alarmAt = performance.now(); sound.play('alarmRepeat'); }
}
let alarmAt = 0;
al.addEventListener('click', e => {
  const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-fix]');
  if (!b) return;
  const cmd = { type: 'fixPump', target: b.dataset.fix! } as const;
  if (mode === 'farm') farm.send(cmd); else if (mode === 'grow') applyCommand(s, cmd);
  dirty = true;
});
/** 警報が出たら（停電・ポンプの停止が起きて、まだ続いていたら）時間を ×1 に落とす。速いままだと 1日が数秒で過ぎ、気づく前に根が傷む */
function slowOnAlarm(log: readonly { kind: string }[], from: number, fs: { outage: number; pumpDown: string[] }) {
  if (speed > 1 && alarmed(log, from) && (fs.outage > 0 || fs.pumpDown.length)) setSpeed(1);
}

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
const speedBtns = ([['⏸', 0], ['×1', 1], ['×4', 4], ['×16', 16]] as const).map(([label, v]) => {
  const b = document.createElement('button');
  b.textContent = label;
  if (v === speed) b.className = 'on';
  b.onclick = () => setSpeed(v);
  sp.appendChild(b);
  return [v, b] as const;
});
function setSpeed(v: number) {
  speed = v;
  for (const [k, b] of speedBtns) b.classList.toggle('on', k === v);
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
const setToolScale = mountTools($('bar'), send);
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
  if (mode === 'grow' && !s.result && speed) {
    acc += dt * speed;
    const n = s.log.length;
    while (acc >= 1 && !s.result) { acc--; tick(s); dirty = true; }
    slowOnAlarm(s.log, n, s.facility);
  } else if (mode === 'farm' && speed) {
    acc += dt * speed;
    // 月を締めると setSpeed(0) で止まるので、そこで抜ける
    const f = farm.state, n = f.log.length;
    while (acc >= 1 && speed) { acc--; farmTick(f); farm.update(); dirty = true; }
    slowOnAlarm(f.log, n, f.facility);
  }
  if (mode === 'grow') hear(s.log, s.facility); else if (mode === 'farm') hear(farm.state.log, farm.state.facility);
  sinceHud += dt;
  if (mode === 'grow') {
    if (dirty || sinceHud > 0.1) { hud.update(s); updateAlarm(); dirty = false; sinceHud = 0; }
    if (s.result && !resultShown) { resultShown = true; showResult(s.result, s.crop.id, restart); if (s.result.outcome === 'harvest') sound.play('harvest'); }
  } else if (dirty || sinceHud > 0.1) { if (mode === 'farm') farm.update(); updateAlarm(); dirty = false; sinceHud = 0; }
  // 部屋の時計：進めている途中の端数（acc）も足して、朝夕の光を滑らかに変える。症状診断は昼の光で見せる
  if (mode === 'farm') view.frameFarm(farm.state, farm.rack, farm.slot, farm.sim ?? s, now / 1000, farm.blind, farm.state.hour + (speed ? acc : 0));
  else if (quiz.sim) view.frame(quiz.sim, now / 1000, quiz.blind, 12);
  else view.frame(s, now / 1000, false, s.hour + (speed && !s.result ? acc : 0));
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
    setSpeed,
    camera(name: PresetName, instant = true) { view.rig.goTo(name, instant); },
    toggleMenu() { menu.click(); },
    renderInfo() { return { ...view.renderer.info.render }; },
    /** 症状診断モード：mode('quiz', seed) で始める。quiz.answer({factor:'ec',side:'high'})・quiz.next() で進める */
    mode: setMode,
    /** 経営モード：mode('farm') で切り替え、farm.state で状態、farm.send({type:'sow',rack:'rack1',slot:0,crop:'radish'}) で操作 */
    farm,
    /** 経営モードを n 時間進める（速度とは無関係に即時） */
    farmTick(n = 1) { for (let i = 0; i < n; i++) farmTick(farm.state); farm.update(); },
    /** 経営モードを始め直す（既定は画面と同じくイベントあり。docs/scripts/farm-month.js は {events:false} で回す） */
    farmReset(opts: { events?: boolean; seed?: number } = {}) { farm.reset(createFarm({ events: true, seed: newSeed(), ...opts })); farm.update(); },
    farmSend(c: FarmCommand) { const ok = farm.send(c); farm.update(); return ok; },
    /**
     * 設備のイベントを今のモードで起こす（確認用。停電は hours 時間、ポンプは栽培槽か選んでいる棚）。
     * 抽選（栽培は ☰ のイベント あり、経営は常に）を待たずに起こす
     */
    event(kind: 'outage' | 'pumpStop', hours = 4) {
      if (mode === 'farm') {
        const f = farm.state, e = kind === 'outage' ? startOutage(f.facility, hours) : stopPump(f.facility, farm.rackId());
        f.log.push({ hour: f.hour, ...e });
        farm.update();
      } else {
        const e = kind === 'outage' ? startOutage(s.facility, hours) : stopPump(s.facility, s.setup.bed);
        s.log.push({ hour: s.hour, ...e });
      }
      dirty = true;
    },
    /** 図鑑を開く（'crops' / 'symptoms'） */
    zukan: openZukan,
    quiz,
    /** 効果音（sound.set(true) でオン。確認用） */
    sound,
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
