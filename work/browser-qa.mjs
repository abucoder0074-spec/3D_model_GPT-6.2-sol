import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = await fs.mkdtemp(path.resolve('work/chrome-'));
const args = [
  '--headless=new', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0',
  '--user-data-dir=' + profile, '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', 'about:blank'
];
const proc = spawn(chrome, args, { windowsHide: true, stdio: 'ignore' });
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { [port] = (await fs.readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n'); }
    catch { await sleep(150); }
  }
  assert(port, 'Chrome did not provide a debugging port');
  const [target] = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve); ws.addEventListener('error', reject); });
  let id = 0;
  const calls = new Map(), errors = [];
  const network = new Set();
  ws.addEventListener('message', (event) => {
    const r = JSON.parse(event.data);
    if (r.id) {
      const { resolve, reject } = calls.get(r.id);
      calls.delete(r.id);
      if (r.error) reject(Error(JSON.stringify(r.error)));
      else resolve(r.result);
    }
    if (r.method === 'Runtime.exceptionThrown') errors.push(r.params.exceptionDetails.exception?.description ?? r.params.exceptionDetails.text);
    if (r.method === 'Runtime.consoleAPICalled' && r.params.type === 'error') {
      errors.push(r.params.args.map((a) => a.description ?? a.value).join(' '));
    }
    if (r.method === 'Log.entryAdded' && ['error', 'warning'].includes(r.params.entry.level)) {
      errors.push(r.params.entry.text);
    }
    if (r.method === 'Network.requestWillBeSent') network.add(r.params.request.url);
  });
  function send(method, params = {}) {
    const message = { id: ++id, method, params };
    return new Promise((resolve, reject) => {
      calls.set(id, { resolve, reject });
      ws.send(JSON.stringify(message));
    });
  }
  async function evaluate(expression) {
    const reply = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.exception?.description ?? reply.exceptionDetails.text);
    return reply.result.value;
  }
  const waitFor = async (expression) => {
    for (let i = 0; i < 100; i++) {
      const value = await evaluate(expression).catch(() => false);
      if (value) return value;
      await sleep(160);
    }
    throw new Error('Browser condition timed out: ' + expression + '\n' + errors.join('\n'));
  };
  const screenshot = async (name) => {
    const { data } = await send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    await fs.writeFile('work/' + name + '.png', Buffer.from(data, 'base64'));
  };
  const metrics = (width, height, deviceScaleFactor = 1, mobile = false) =>
    send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor, mobile });
  const click = async (x, y) => {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  };
  const run = process.argv[2] || 'visual';
  try {
    await Promise.all(['Runtime.enable', 'Log.enable', 'Page.enable', 'Network.enable'].map((name) => send(name)));
    await metrics(1440, 900, run === 'perf2' ? 2 : 1);
    let testFile = 'outputs/index.html';
    if (run === 'debug') {
      const source = await fs.readFile(testFile, 'utf8');
      testFile = 'work/instrumented.html';
      await fs.writeFile(testFile, source.replace('dock.inert = false;', `
        globalThis.inspectIsland = () => {
          const project = (point) => {
            point.project(camera);
            return [Math.round((point.x * .5 + .5) * width), Math.round((.5 - point.y * .5) * height)];
          };
          return {
            cabin: project(house.getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 1.05, 1))),
            trees: treePositions.map(([x,z,species], i) => ({ i, x: +x.toFixed(2), z: +z.toFixed(2), species,
              root: project(new THREE.Vector3(x,surfaceY(x,z),z)), mid: project(new THREE.Vector3(x,1.85,z)) })),
            sun: project(sunDir.clone().multiplyScalar(110).add(camera.position)),
            moon: project(moonDir.clone().multiplyScalar(110).add(camera.position))
          };
        };
        dock.inert = false;
      `));
    }
    const file = pathToFileURL(path.resolve(testFile)).href;
    await send('Page.navigate', { url: file });
    await waitFor('document.querySelector("#status")?.hidden');
    const gpu = await evaluate(`(() => {
      const gl = document.querySelector('canvas').getContext('webgl2');
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return info && gl.getParameter(info.UNMASKED_RENDERER_WEBGL);
    })()`);
    console.log({ file, gpu, requests: [...network] });
    await click(1150, 260); // Freeze camera autorotation for stable screenshots and picking.
    await waitFor('document.querySelector("#fps").textContent.includes(" FPS") && /^\\d/.test(document.querySelector("#fps").textContent)');
    const setHour = (value) => evaluate(`(() => {
      const time = document.querySelector('#time');
      time.value = ${value};
      time.dispatchEvent(new Event('input', { bubbles: true }));
      return document.querySelector('#timeReadout').textContent;
    })()`);
    const button = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    const pressed = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-pressed')`);
    if (run === 'visual') {
      await screenshot('clear-day');
      assert.equal(await setHour(0), '00:00');
      await sleep(450);
      await screenshot('clear-night');
      assert.equal(await setHour(16.25), '16:15');
      await button('[data-weather="rain"]');
      await sleep(1650);
      await screenshot('rain');
      await button('[data-weather="snow"]');
      await sleep(1650);
      await screenshot('snow');
      await button('[data-weather="clear"]');
      await metrics(390, 844, 2, true);
      await sleep(1900);
      await screenshot('mobile');
    } else if (run === 'interaction') {
      for (const [x, y, expected] of [[738, 301, 'Lookout cabin'], [892, 389, 'Spring pond'], [524, 270, 'Wind fir'], [637, 336, 'Golden alder']]) {
        await click(x, y);
        const actual = await evaluate('document.querySelector("#info").hidden ? null : document.querySelector("#infoName").textContent');
        console.log({ pick: [x, y], actual, expected });
        assert.equal(actual, expected);
        if (expected === 'Spring pond') await screenshot('pond-card');
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      }
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      assert(await evaluate('document.querySelector("#info").hidden'));
      assert.equal(await setHour(24), '24:00');
      await button('#play');
      assert.equal(await pressed('#play'), 'true');
      await waitFor('document.querySelector("#timeReadout").textContent.startsWith("00:")');
      await button('#play');
      assert.equal(await pressed('#play'), 'false');
      await setHour(16.25);
      for (const weather of ['rain', 'snow', 'clear', 'rain', 'snow', 'clear']) {
        const selector = '[data-weather="' + weather + '"]';
        await button(selector);
        assert.equal(await pressed(selector), 'true');
        await sleep(120);
      }
      await button('#shadows');
      assert.equal(await pressed('#shadows'), 'false');
      await button('[data-quality="low"]');
      assert.equal(await pressed('[data-quality="low"]'), 'true');
      const width = () => evaluate('document.querySelector("canvas").width');
      assert.equal(await width(), 1296);
      await button('#shadows');
      assert.equal(await pressed('#shadows'), 'true');
      await button('[data-quality="high"]');
      assert.equal(await width(), 1440);
      await metrics(350, 700, 3, true);
      await waitFor('document.querySelector("canvas").width === 700');
      assert(await evaluate(`(() => { const rect = document.querySelector('.dock').getBoundingClientRect();
        return rect.left >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight; })()`));
      console.log('Controls, keyboard dismissal, resize, and DPR cap checked.');
    } else if (run === 'debug') {
      const debug = await evaluate('inspectIsland()');
      console.log(debug.cabin, debug.sun, debug.moon);
      console.table(debug.trees);
    } else {
      const frames = () => evaluate(`new Promise((resolve) => {
        let start, last, n = 0;
        function tick(now) {
          if (start === undefined) start = now;
          if (last !== undefined) n++;
          last = now;
        if (now - start < 3000) requestAnimationFrame(tick);
        else resolve(Math.round(n * 1000 / (now - start)));
        }
        requestAnimationFrame(tick);
      })`);
      await button('#play');
      for (const preset of ['high', 'low']) {
        await button('[data-quality="' + preset + '"]');
        for (const mode of ['clear', 'rain', 'snow']) {
          await button('[data-weather="' + mode + '"]');
          await sleep(450);
          console.log({ preset, mode, fps: await frames() });
        }
      }
    }
    console.log('Browser diagnostics:', errors);
    assert.equal(errors.filter((e) => !/performance warning/i.test(e)).length, 0);
  } finally {
    await send('Browser.close').catch(() => {});
    ws.close();
  }
} finally {
  proc.kill();
}
