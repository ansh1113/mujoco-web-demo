// Tab shell: lazily builds each demo on first visit and only runs the visible one.
import { getMujoco } from './runtime.js';
import { fetchModel, initialPolicyUrl, describe, fraction } from './franka/fetch-model.js';

const DEMOS = {
  balance: () => import('./g1/app.js').then((m) => m.createBalanceDemo),
  pick: () => import('./franka/app.js').then((m) => m.createPickDemo),
};

const DEFAULT_DEMO = 'pick'; // first tab; also used for an empty or unknown #hash

// The pick tab is the default and its policy is the largest download (27 MB), so when the page opens
// on it, start that download before anything else, in parallel with MuJoCo's WASM.
const firstDemo = DEMOS[location.hash.slice(1)] ? location.hash.slice(1) : DEFAULT_DEMO;
if (firstDemo === 'pick') fetchModel(initialPolicyUrl());

const instances = {};
const pending = {};
let active = null;

function loadingUi(name) {
  const el = document.getElementById(`${name}-loading`);
  const bar = el.querySelector('.bar span');
  const text = el.querySelector('p');
  return {
    progress(frac, msg) {
      bar.style.width = `${Math.round(100 * frac)}%`;
      if (msg) text.textContent = msg;
    },
    done() { el.classList.add('done'); },
    error(err) {
      console.error(err);
      el.classList.add('error');
      el.querySelector('.bar').hidden = true;
      text.textContent = `Could not start this demo: ${err.message || err}`;
      const chip = document.getElementById(`${name}-status`);
      chip.dataset.state = 'bad';
      chip.textContent = 'Error';
    },
  };
}

async function ensure(name) {
  if (instances[name]) return instances[name];
  if (!pending[name]) {
    const ui = loadingUi(name);
    pending[name] = (async () => {
      try {
        ui.progress(0.05, 'Loading MuJoCo (WebAssembly)…');
        // The policy download dominates the pick tab's start-up: show its progress in the overlay.
        const off = name === 'pick'
          ? fetchModel(initialPolicyUrl()).onProgress((s) => ui.progress(Math.max(0.05, fraction(s)), describe(s)))
          : null;
        try {
          const [mj, create] = await Promise.all([getMujoco(), DEMOS[name]()]);
          const inst = await create({ mj, ui });
          instances[name] = inst;
          ui.done();
          return inst;
        } finally {
          off?.();
        }
      } catch (err) {
        ui.error(err);
        return null;
      }
    })();
  }
  return pending[name];
}

async function show(name) {
  if (!DEMOS[name]) name = DEFAULT_DEMO;
  for (const tab of document.querySelectorAll('.tab')) {
    const on = tab.dataset.demo === name;
    tab.setAttribute('aria-selected', String(on));
    tab.tabIndex = on ? 0 : -1;
    document.getElementById(tab.getAttribute('aria-controls')).hidden = !on;
  }
  if (active && active !== name) instances[active]?.stop();
  active = name;
  const inst = await ensure(name);
  if (inst && active === name) inst.start();
}

const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach((tab, i) => {
  tab.addEventListener('click', () => {
    if (location.hash !== `#${tab.dataset.demo}`) history.replaceState(null, '', `#${tab.dataset.demo}`);
    show(tab.dataset.demo);
  });
  tab.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    next.click();
  });
});
window.addEventListener('hashchange', () => show(location.hash.slice(1)));
document.addEventListener('visibilitychange', () => {
  if (!active || !instances[active]) return;
  if (document.hidden) instances[active].stop(); else instances[active].start();
});
window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
  for (const inst of Object.values(instances)) inst?.applyTheme?.();
});

show(location.hash.slice(1) || DEFAULT_DEMO);

// test hook (Playwright): expose demo instances
window.__demo = { instances, show };
