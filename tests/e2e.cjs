// End-to-end test in headless Chromium (Playwright). Serves the site statically, drives both tabs,
// fails on any console error/warning, page error or failed request, and writes the README screenshots.
//
//   node tests/e2e.cjs                      # uses ../diffusion-pick/exports/dp_reduced.onnx if present
//   DPICK_ONNX=/path/to/dp_reduced.onnx node tests/e2e.cjs
//   SCREENSHOTS=0 node tests/e2e.cjs        # don't rewrite docs/screenshots
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const DP_ONNX = process.env.DPICK_ONNX || path.resolve(ROOT, '..', 'diffusion-pick', 'exports', 'dp_reduced.onnx');
const WRITE_SHOTS = process.env.SCREENSHOTS !== '0';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.wasm': 'application/wasm', '.onnx': 'application/octet-stream',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

function serve() {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    let file = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
    fs.readFile(file, (err, buf) => {
      if (err) { res.writeHead(404).end('not found'); return; }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' }).end(buf);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? '  ok  ' : ' FAIL '} ${msg}`);
  if (!cond) failures += 1;
}

function watch(page, label, problems) {
  page.on('console', (m) => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${label} console.${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`${label} pageerror: ${e.message}`));
  page.on('requestfailed', (r) => problems.push(`${label} requestfailed: ${r.url()} ${r.failure()?.errorText}`));
  page.on('response', (r) => { if (r.status() >= 400) problems.push(`${label} HTTP ${r.status()}: ${r.url()}`); });
}

const simTime = (page, demo) => page.evaluate((d) => window.__demo.instances[d]?.debug.data.time ?? -1, demo);

async function waitSim(page, demo, seconds, timeout = 60000) {
  const t0 = await simTime(page, demo);
  await page.waitForFunction(([d, t]) => window.__demo.instances[d].debug.data.time >= t, [demo, t0 + seconds],
    { timeout, polling: 100 });
}

/** Screen position of a body's origin in the given demo's viewer. */
function bodyScreen(page, demo, body) {
  return page.evaluate(([d, b]) => {
    const { model, data, viewer } = window.__demo.instances[d].debug;
    const id = model.body(b).id;
    const r = viewer.renderer.domElement.getBoundingClientRect();
    const v = { x: data.xpos[3 * id], y: data.xpos[3 * id + 1], z: data.xpos[3 * id + 2] };
    const p = viewer.camera.position.clone().set(v.x, v.y, v.z).project(viewer.camera);
    return { x: r.left + (p.x + 1) / 2 * r.width, y: r.top + (1 - p.y) / 2 * r.height };
  }, [demo, body]);
}

async function main() {
  const server = await serve();
  const base = `http://127.0.0.1:${server.address().port}/`;
  // SwiftShader gives headless Chromium a software WebGL2 implementation.
  const browser = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const problems = [];
  if (WRITE_SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
  const shot = async (page, name) => {
    if (!WRITE_SHOTS) return;
    await page.screenshot({ path: path.join(SHOTS, name), type: 'jpeg', quality: 88 });
  };

  try {
    // ───────────────────────────── desktop ─────────────────────────────
    const ctx = await browser.newContext({ viewport: { width: 1360, height: 860 }, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    watch(page, 'desktop', problems);
    await page.goto(base);

    console.log('Tab 1 · G1 balance');
    await page.waitForFunction(() => window.__demo?.instances?.balance, null, { timeout: 60000 });
    await waitSim(page, 'balance', 1.0);
    check(await page.evaluate(() => window.__demo.instances.balance.debug.data.qpos[2] > 0.7), 'G1 stands after load');
    const status = await page.textContent('#balance-status');
    check(status === 'Balancing', `status chip reads "Balancing" (got "${status}")`);

    // scripted push, controller on: 130 N for 0.1 s from behind
    await page.evaluate(() => window.__demo.instances.balance.debug.push([130, 0, 0]));
    await waitSim(page, 'balance', 3.0);
    check(await page.evaluate(() => window.__demo.instances.balance.debug.data.qpos[2] > 0.7),
      'controller on: survives a 130 N x 0.1 s push');

    // same push with the controller off (UI toggle) -> falls
    await page.click('label.switch');
    await waitSim(page, 'balance', 1.0);
    await page.evaluate(() => window.__demo.instances.balance.debug.push([130, 0, 0]));
    // (the page auto-resets 1.8 s after a fall, so watch for the fall rather than checking at the end)
    const fell = await page.waitForFunction(() => window.__demo.instances.balance.debug.data.qpos[2] < 0.45,
      null, { timeout: 15000, polling: 20 }).then(() => true, () => false);
    check(fell, 'controller off: the same push knocks it over');
    await page.click('label.switch');
    await page.waitForFunction(() => window.__demo.instances.balance.debug.ctl.enabled);
    await waitSim(page, 'balance', 1.5);

    // real pointer drag on the torso
    const torso = await bodyScreen(page, 'balance', 'torso_link');
    const x0 = await page.evaluate(() => window.__demo.instances.balance.debug.data.qpos[0]);
    await page.mouse.move(torso.x, torso.y);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++) await page.mouse.move(torso.x - 5 * i, torso.y + 2 * i);
    await waitSim(page, 'balance', 0.15);
    const drag = await page.evaluate(() => {
      const { perturb } = window.__demo.instances.balance.debug;
      return { active: perturb.active, f: perturb.force.length(), chip: document.getElementById('balance-force').textContent };
    });
    check(drag.active && drag.f > 5, `pointer drag grabs the robot and pulls (|F| = ${drag.f.toFixed(0)} N, chip "${drag.chip}")`);
    await shot(page, 'balance.jpg');
    await page.mouse.up();
    await waitSim(page, 'balance', 2.5);
    const after = await page.evaluate(() => {
      const { data, perturb } = window.__demo.instances.balance.debug;
      return { z: data.qpos[2], x: data.qpos[0], active: perturb.active };
    });
    check(!after.active, 'releasing the pointer releases the body');
    check(after.z > 0.7, `still standing after the drag (pelvis z = ${after.z.toFixed(2)})`);
    console.log(`       (pelvis moved ${(100 * Math.abs(after.x - x0)).toFixed(1)} cm)`);

    console.log('Tab 2 · Franka pick-and-place');
    await page.click('#tab-pick');
    await page.waitForFunction(() => window.__demo.instances.pick?.debug.policy, null, { timeout: 60000 });
    check(await page.isHidden('#panel-balance'), 'tab switch hides tab 1');
    check(await page.evaluate(() => !window.__demo.instances.balance.debug.loop.running), 'tab 1 loop stops when hidden');
    const io = await page.textContent('#pick-io');
    check(io.includes('object_state') && io.includes('actions[1,16,5]'), `placeholder I/O shown: ${io}`);
    // wait for a carry, take the screenshot, then wait for the first success
    await page.waitForFunction(() => {
      const { env } = window.__demo.instances.pick.debug;
      return env.cubePos()[2] > 0.09;
    }, null, { timeout: 90000, polling: 50 });
    await page.waitForTimeout(300);
    await shot(page, 'pick.jpg');
    await page.waitForFunction(() => window.__demo.instances.pick.debug.score.ok >= 1, null, { timeout: 90000 });
    const sc = await page.evaluate(() => window.__demo.instances.pick.debug.score);
    check(sc.ok >= 1, `placeholder policy puts the red cube in the bowl (score ${sc.ok}/${sc.n})`);
    const thumbs = await page.evaluate(() => ['pick-front', 'pick-wrist'].map((id) => {
      const c = document.getElementById(id).getContext('2d').getImageData(0, 0, 64, 64).data;
      let s = 0; for (let i = 0; i < c.length; i += 4) s += c[i] + c[i + 1] + c[i + 2];
      return s / (64 * 64 * 3);
    }));
    check(thumbs.every((m) => m > 10), `64x64 policy camera views are rendered (mean intensity ${thumbs.map((m) => m.toFixed(0)).join(', ')})`);

    if (fs.existsSync(DP_ONNX)) {
      console.log(`Policy slot · ${path.basename(DP_ONNX)} (diffusion-pick export)`);
      await page.setInputFiles('#pick-file', DP_ONNX);
      await page.waitForFunction(() => window.__demo.instances.pick.debug.policy?.label.endsWith('.onnx'), null, { timeout: 60000 });
      const t0 = await page.evaluate(() => window.__demo.instances.pick.debug.env.t);
      await page.waitForFunction((t) => window.__demo.instances.pick.debug.env.t >= t + 20, t0, { timeout: 120000 });
      const r = await page.evaluate(() => {
        const { policy, error } = window.__demo.instances.pick.debug;
        return { inputs: policy.inputs, ms: policy.lastMs, error: error && error.message, meta: policy.meta };
      });
      check(!r.error, `dp_reduced.onnx runs in the slot without errors (inputs: ${r.inputs.join(', ')})`);
      check(r.inputs.includes('front_rgb') && r.meta.obs_horizon === 2 && r.meta.pred_horizon === 16,
        `metadata inferred from the graph (To=${r.meta.obs_horizon}, Tp=${r.meta.pred_horizon}, img=${r.meta.img_size})`);
      console.log(`       (WASM inference ${r.ms.toFixed(0)} ms per chunk in headless SwiftShader Chromium)`);
    } else {
      console.log(`  skip  dp_reduced.onnx not found at ${DP_ONNX}`);
    }
    await ctx.close();

    // ───────────────────────────── mobile ─────────────────────────────
    console.log('Mobile (iPhone 13 viewport)');
    const mctx = await browser.newContext({ ...devices['iPhone 13'] });
    const m = await mctx.newPage();
    watch(m, 'mobile', problems);
    await m.goto(base);
    await m.waitForFunction(() => window.__demo?.instances?.balance, null, { timeout: 60000 });
    await waitSim(m, 'balance', 1.0);
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `no horizontal scroll (overflow ${overflow}px)`);
    // touch drag on the torso
    const tp = await bodyScreen(m, 'balance', 'torso_link');
    const cdp = await mctx.newCDPSession(m);
    const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
    await touch('touchStart', tp.x, tp.y);
    for (let i = 1; i <= 6; i++) await touch('touchMove', tp.x + 2 * i, tp.y);
    await waitSim(m, 'balance', 0.3);
    check(await m.evaluate(() => window.__demo.instances.balance.debug.perturb.active), 'touch drag grabs the robot');
    await touch('touchEnd', 0, 0);
    await waitSim(m, 'balance', 1.5);
    check(await m.evaluate(() => { const { ctl, data } = window.__demo.instances.balance.debug; return !ctl.fallen(data); }),
      'still standing after the touch drag');
    await shot(m, 'mobile-balance.jpg');
    await m.tap('#tab-pick');
    await m.waitForFunction(() => window.__demo.instances.pick?.debug.policy, null, { timeout: 60000 });
    await m.waitForFunction(() => window.__demo.instances.pick.debug.env.cubePos()[2] > 0.08, null, { timeout: 90000, polling: 50 });
    const overflow2 = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow2 <= 0, `no horizontal scroll on tab 2 (overflow ${overflow2}px)`);
    await shot(m, 'mobile-pick.jpg');
    await mctx.close();
  } finally {
    await browser.close();
    server.close();
  }

  console.log('Console / network');
  check(problems.length === 0, `no console errors or warnings, page errors or failed requests (${problems.length})`);
  for (const p of problems) console.log(`       ${p}`);
  console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
