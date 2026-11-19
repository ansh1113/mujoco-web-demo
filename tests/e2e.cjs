// End-to-end test in headless Chromium (Playwright). Serves the site statically, drives both tabs,
// fails on any console error/warning, page error or failed request, and writes the README screenshots.
//
//   node tests/e2e.cjs                      # uses ../diffusion-pick/exports/dp_reduced.onnx if present
//   DPICK_ONNX=/path/to/dp_reduced.onnx node tests/e2e.cjs
//   SCREENSHOTS=0 node tests/e2e.cjs        # don't rewrite docs/screenshots
const fs = require('node:fs');
const path = require('node:path');
const { chromium, devices } = require('playwright');

const ROOT = path.resolve(__dirname, '..');
const SHOTS = path.join(ROOT, 'docs', 'screenshots');
const DP_ONNX = process.env.DPICK_ONNX || path.resolve(ROOT, '..', 'diffusion-pick', 'exports', 'dp_reduced.onnx');
const WRITE_SHOTS = process.env.SCREENSHOTS !== '0';
const { serve, CHROMIUM_ARGS } = require('../tools/static-server.cjs');

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

/** Runs in the page before its scripts: records every text the pick tab's loading overlay shows. */
function recordOverlay() {
  window.__overlayTexts = [];
  document.addEventListener('DOMContentLoaded', () => {
    const p = document.querySelector('#pick-loading p');
    const log = () => window.__overlayTexts.push(p.textContent);
    log();
    new MutationObserver(log).observe(p, { childList: true, characterData: true, subtree: true });
  });
}

async function main() {
  const server = await serve(ROOT);
  const base = `http://127.0.0.1:${server.address().port}/`;
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
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
    const requests = [];
    const tNav = Date.now();
    page.on('request', (r) => requests.push({ url: r.url(), t: Date.now() - tNav }));
    await page.addInitScript(recordOverlay);
    await page.goto(base);

    console.log('Tab 1 · Franka pick-and-place (default)');
    await page.waitForFunction(() => window.__demo?.instances?.pick?.debug.policy, null, { timeout: 120000 });
    const tabs = await page.evaluate(() => ({
      order: [...document.querySelectorAll('.tab')].map((t) => t.dataset.demo),
      selected: document.querySelector('.tab[aria-selected="true"]').dataset.demo,
      hash: location.hash, balanceLoaded: !!window.__demo.instances.balance }));
    check(tabs.order.join(',') === 'pick,balance', `pick-and-place is the first tab (order: ${tabs.order.join(', ')})`);
    check(tabs.selected === 'pick' && tabs.hash === '' && await page.isHidden('#panel-balance'),
      'with no #hash the page opens on pick-and-place');
    check(!tabs.balanceLoaded, 'the balance tab is not loaded until it is opened');
    const overlay = await page.evaluate(() => [...new Set(window.__overlayTexts)]);
    check(overlay.some((t) => /^Loading policy \(27 MB\)… [\d.]+ \/ 27 MB$/.test(t)),
      `loading overlay shows the policy download ("${overlay.find((t) => t.startsWith('Loading policy (27 MB)')) || overlay[0]}")`);
    const dpReqs = requests.filter((r) => r.url.endsWith('/models/dp_v2.onnx'));
    const mjReq = requests.find((r) => r.url.endsWith('/mujoco.wasm'));
    check(dpReqs.length === 1, `dp_v2.onnx is downloaded exactly once (${dpReqs.length} request(s))`);
    check(dpReqs.length && mjReq && dpReqs[0].t <= mjReq.t + 250,
      `dp_v2.onnx download starts with MuJoCo's WASM, not after it (${dpReqs[0]?.t - mjReq?.t} ms apart)`);
    const io = await page.textContent('#pick-io');
    check(io.includes('front_rgb') && io.includes('wrist_rgb') && io.includes('actions[1,16,5]'),
      `default policy is the image-based Diffusion Policy: ${io}`);
    const slot = await page.evaluate(async () => (await import('/js/franka/policy-slot.js')).POLICY_SLOT.url);
    check(await page.inputValue('#pick-select') === slot, `policy picker shows the default slot (${slot})`);
    // wait for a carry, take the screenshot, then wait for the first success
    await page.waitForFunction(() => window.__demo.instances.pick.debug.env.cubePos()[2] > 0.09,
      null, { timeout: 240000, polling: 50 });
    await page.waitForTimeout(300);
    await shot(page, 'pick.jpg');
    await page.waitForFunction(() => window.__demo.instances.pick.debug.score.ok >= 1, null, { timeout: 240000 });
    const sc = await page.evaluate(() => window.__demo.instances.pick.debug.score);
    check(sc.ok >= 1, `Diffusion Policy puts the red cube in the bowl from pixels (score ${sc.ok}/${sc.n})`);
    const thumbs = await page.evaluate(() => ['pick-front', 'pick-wrist'].map((id) => {
      const c = document.getElementById(id).getContext('2d').getImageData(0, 0, 64, 64).data;
      let s = 0; for (let i = 0; i < c.length; i += 4) s += c[i] + c[i + 1] + c[i + 2];
      return s / (64 * 64 * 3);
    }));
    check(thumbs.every((m) => m > 10), `64x64 policy camera views are rendered (mean intensity ${thumbs.map((m) => m.toFixed(0)).join(', ')})`);

    console.log('Policy picker · placeholder');
    await page.selectOption('#pick-select', 'models/placeholder_pick.onnx');
    await page.waitForFunction(() => window.__demo.instances.pick.debug.policy?.inputs.includes('object_state'), null, { timeout: 60000 });
    await page.waitForFunction(() => window.__demo.instances.pick.debug.score.ok >= 1, null, { timeout: 120000 });
    check(true, 'switching to the placeholder works and it completes an episode');

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

    console.log('Tab 2 · G1 balance');
    await page.click('#tab-balance');
    await page.waitForFunction(() => window.__demo?.instances?.balance, null, { timeout: 60000 });
    check(await page.isHidden('#panel-pick') && await page.evaluate(() => location.hash === '#balance'),
      'tab switch hides pick-and-place and sets #balance');
    check(await page.evaluate(() => !window.__demo.instances.pick.debug.loop.running), 'the hidden tab\'s loop stops');
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

    await ctx.close();

    // ─────────────────────────── direct links ───────────────────────────
    console.log('Direct links');
    const lctx = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const lp = await lctx.newPage();
    watch(lp, 'links', problems);
    const lreqs = [];
    lp.on('request', (r) => lreqs.push(r.url()));
    await lp.goto(`${base}#balance`);
    await lp.waitForFunction(() => window.__demo?.instances?.balance?.debug.data.time > 1, null, { timeout: 60000 });
    check(await lp.evaluate(() => document.querySelector('.tab[aria-selected="true"]').dataset.demo === 'balance'
      && !window.__demo.instances.pick), '#balance opens the humanoid tab directly');
    check(!lreqs.some((u) => u.endsWith('.onnx')), '#balance does not download any policy');
    await lp.close();
    const lp2 = await lctx.newPage(); // fresh page: a same-page hash change would start (then abort) loads
    watch(lp2, 'links', problems);
    await lp2.goto(`${base}#no-such-tab`);
    await lp2.waitForFunction(() => window.__demo?.instances?.pick?.debug.policy, null, { timeout: 120000 });
    check(await lp2.evaluate(() => document.querySelector('.tab[aria-selected="true"]').dataset.demo) === 'pick',
      'an unknown #hash falls back to pick-and-place');
    await lctx.close();

    // ───────────────────────────── mobile ─────────────────────────────
    console.log('Mobile (iPhone 13 viewport)');
    const mctx = await browser.newContext({ ...devices['iPhone 13'] });
    const m = await mctx.newPage();
    watch(m, 'mobile', problems);
    await m.goto(base);
    await m.waitForFunction(() => window.__demo?.instances?.pick?.debug.policy, null, { timeout: 120000 });
    await m.waitForFunction(() => window.__demo.instances.pick.debug.env.cubePos()[2] > 0.08, null, { timeout: 240000, polling: 50 });
    const overflow = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow <= 0, `no horizontal scroll on pick-and-place (overflow ${overflow}px)`);
    await shot(m, 'mobile-pick.jpg');
    await m.tap('#tab-balance');
    await m.waitForFunction(() => window.__demo?.instances?.balance, null, { timeout: 60000 });
    await waitSim(m, 'balance', 1.0);
    const overflow2 = await m.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    check(overflow2 <= 0, `no horizontal scroll on balance (overflow ${overflow2}px)`);
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
