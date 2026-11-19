// Policy downloads with byte-level progress, shared between the early start in js/main.js and the
// pick-and-place tab, so the 27 MB default model is fetched once and as early as possible.
import { POLICY_SLOT } from './policy-slot.js';

const jobs = new Map();

/** The policy the pick tab starts with: ?policy=… if given, else the slot default. */
export function initialPolicyUrl() {
  return new URLSearchParams(location.search).get('policy') || POLICY_SLOT.url;
}

const MB = (n) => (n / 1e6).toFixed(n >= 1e7 ? 0 : 1);

/** Human-readable progress line, e.g. "Loading policy (27 MB)… 12 / 27 MB". */
export function describe(s) {
  if (s.error) return 'Policy download failed';
  if (s.done) return 'Starting the policy…';
  if (!s.total) return `Loading policy… ${MB(s.loaded)} MB`;
  return `Loading policy (${Math.round(s.total / 1e6)} MB)… ${MB(s.loaded)} / ${MB(s.total)} MB`;
}

/** Fraction downloaded (0 when the size is unknown). */
export function fraction(s) {
  return s.done ? 1 : s.total ? Math.min(1, s.loaded / s.total) : 0;
}

function start(url) {
  const listeners = new Set();
  const state = { url, loaded: 0, total: null, done: false, error: null };
  const emit = () => { for (const fn of listeners) fn(state); };

  // Metadata (tiny) gives the true size; diffusion-pick exports record size_mb. Content-Length is
  // only trusted when the response isn't compressed (it would then be the compressed size).
  const meta = fetch(url.replace(/\.onnx(\?.*)?$/, '.json'))
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
    .then((m) => {
      if (m?.size_mb && !state.done) { state.total = Math.round(m.size_mb * 1e6); emit(); }
      return m;
    });

  const bytes = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`could not fetch ${url} (${res.status})`);
    const len = Number(res.headers.get('content-length'));
    if (!state.total && len && !res.headers.get('content-encoding')) state.total = len;
    if (!res.body) {
      const buf = new Uint8Array(await res.arrayBuffer());
      state.loaded = buf.length;
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      state.loaded += value.length;
      emit();
    }
    const out = new Uint8Array(state.loaded);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
  })();

  const promise = Promise.all([bytes, meta]).then(
    ([b, m]) => { state.done = true; state.total = state.total ?? b.length; emit(); return { bytes: b, meta: m }; },
    (err) => { state.error = err; emit(); throw err; },
  );
  promise.catch(() => {}); // an unconsumed early download must not raise an unhandled rejection
  return {
    promise,
    state,
    /** Subscribe to progress; called immediately with the current state. Returns an unsubscribe fn. */
    onProgress(fn) { listeners.add(fn); fn(state); return () => listeners.delete(fn); },
  };
}

/** Start (or join) the download of `url`. */
export function fetchModel(url) {
  let job = jobs.get(url);
  if (!job) { job = start(url); jobs.set(url, job); }
  return job;
}

/** Like fetchModel, but the caller takes ownership: the cache entry is dropped so the bytes can be freed. */
export function takeModel(url) {
  const job = fetchModel(url);
  jobs.delete(url);
  return job;
}
