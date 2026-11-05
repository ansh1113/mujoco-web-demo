// Headless-Chromium driver for tools/lab:
//
//   node tools/lab/run.cjs render --states states.json --out frames.u8
//       Re-render recorded simulator states (from diffusion-pick's scripts/export_states.py, converted
//       by tools/replay_to_zarr.py) through the site's three.js renderer. Writes, per frame, front then
//       wrist as uint8 CHW 3x64x64.
//
//   node tools/lab/run.cjs eval --policy models/dp_browser.onnx --seeds 1000:1050 [--out results.json]
//       Closed-loop evaluation in the JS env with browser-rendered observations.
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const { serve, CHROMIUM_ARGS } = require('../static-server.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const arg = (name, def) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : def; };

async function main() {
  const cmd = process.argv[2];
  const server = await serve(ROOT);
  const browser = await chromium.launch({ args: CHROMIUM_ARGS });
  const page = await browser.newPage();
  const problems = [];
  page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) problems.push(m.text()); });
  page.on('pageerror', (e) => problems.push(e.message));
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/tools/lab/index.html`);
    await page.waitForFunction(() => window.labReady, null, { timeout: 60000 });
    await page.evaluate(() => window.lab.init());
    const t0 = Date.now();
    if (cmd === 'render') {
      const eps = JSON.parse(fs.readFileSync(arg('states'), 'utf8')).episodes;
      const fd = fs.openSync(arg('out'), 'w');
      let frames = 0;
      for (let i = 0; i < eps.length; i++) {
        const b = await page.evaluate(([bowl, q]) => window.lab.renderStates(bowl, new Float64Array(q)), [eps[i].bowl, eps[i].qpos]);
        const buf = Buffer.from(b, 'base64');
        fs.writeSync(fd, buf);
        frames += buf.length / (2 * 3 * 64 * 64);
        if ((i + 1) % 20 === 0) console.log(`${i + 1}/${eps.length} episodes, ${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
      }
      fs.closeSync(fd);
      console.log(`rendered ${frames} frames -> ${arg('out')}`);
    } else if (cmd === 'eval') {
      const policy = arg('policy');
      const [a, b] = arg('seeds', '1000:1050').split(':').map(Number);
      const info = await page.evaluate((u) => window.lab.loadPolicy(u), policy);
      console.log(`policy ${policy}: inputs ${info.inputs.join(', ')}`);
      const results = [];
      for (let s = a; s < b; s++) {
        const r = await page.evaluate((seed) => window.lab.evalEpisode(seed), s);
        results.push(r);
        const ok = results.filter((x) => x.success).length;
        console.log(`seed ${s}: ${r.success ? 'success' : 'fail'} (${r.steps} steps, ${r.inferMs.toFixed(0)} ms/inference)  running ${ok}/${results.length}`);
      }
      const ok = results.filter((x) => x.success).length;
      const summary = { policy, seeds: [a, b], n: results.length, successes: ok, success_rate: ok / results.length,
        mean_inference_ms: results.reduce((s, r) => s + r.inferMs, 0) / results.length,
        renderer: 'headless Chromium + SwiftShader WebGL2', results };
      if (arg('out')) fs.writeFileSync(arg('out'), JSON.stringify(summary, null, 1));
      console.log(JSON.stringify({ policy, n: summary.n, successes: ok, success_rate: summary.success_rate }));
    } else {
      throw new Error('usage: run.cjs render|eval ...');
    }
    console.log(`(${((Date.now() - t0) / 60000).toFixed(1)} min)`);
    if (problems.length) { console.error('console problems:\n' + problems.join('\n')); process.exitCode = 1; }
  } finally {
    await browser.close();
    server.close();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
