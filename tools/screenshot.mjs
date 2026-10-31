// headless Chrome + CDP でカメラ・画面幅ごとのスクリーンショットを撮る
// node tools/screenshot.mjs <出力先> [サイズ JSON] [カメラ JSON] [撮影前に評価する JS]
// 例: node tools/screenshot.mjs out '[[1280,800,1,false],[390,844,2,true]]' '["全景","寄り"]'
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const OUT = process.argv[2]; mkdirSync(OUT, { recursive: true });
const URL_ = process.env.URL || 'http://127.0.0.1:8123/index.html';
const PORT = 9333;
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', `--remote-debugging-port=${PORT}`, '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
  `--user-data-dir=${mkdtempSync(join(tmpdir(), 'cdp-'))}`, '--no-first-run', 'about:blank'], { stdio: 'ignore' });
const sleep = ms => new Promise(r => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50; i++) {
  try { const l = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json(); const p = l.find(t => t.type === 'page'); if (p) { ws = new WebSocket(p.webSocketDebuggerUrl); break; } } catch {}
  await sleep(200);
}
await new Promise(r => ws.onopen = r);
let id = 0; const pend = {}; const logs = [];
ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend[m.id]) { pend[m.id](m); delete pend[m.id]; }
  if (m.method === 'Runtime.consoleAPICalled') logs.push(m.params.type + ': ' + m.params.args.map(a => a.value ?? a.description).join(' '));
  if (m.method === 'Runtime.exceptionThrown') logs.push('EXC: ' + JSON.stringify(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text)); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
await send('Runtime.enable'); await send('Page.enable');

const sizes = JSON.parse(process.argv[3] || '[[1280,800,1,false],[390,844,3,true]]');
const cams = JSON.parse(process.argv[4] || '["全景","断面","寄り","モニタ"]');
const setup = process.argv[5] || '';
for (const [w, h, dpr, mobile] of sizes) {
  await send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: dpr, mobile });
  await send('Page.navigate', { url: URL_ }); await sleep(2500);
  if (setup) logs.push('setup: ' + JSON.stringify(await ev(setup)));
  for (const c of cams) {
    await ev(`camTo('${c}');cu=[...go];1`); await sleep(700);
    const s = await send('Page.captureScreenshot', { format: 'png' });
    writeFileSync(join(OUT, `${w}x${h}_${c}.png`), Buffer.from(s.result.data, 'base64'));
  }
  logs.push(`${w}x${h}: ` + JSON.stringify(await ev(`(()=>{const r=id=>{const b=document.getElementById(id).getBoundingClientRect();return [b.left|0,b.top|0,b.right|0,b.bottom|0]};return {hud:r('hud'),side:r('side'),bar:r('bar'),sw:document.documentElement.scrollWidth}})()`)));
}
console.log(logs.join('\n'));
ws.close(); chrome.kill();
process.exit(0);
