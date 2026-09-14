// Stands in for the pedal's web server so the pedal's own control page runs
// unchanged in a browser tab.
//
// On the Pi, index.html talks to WebServer.cpp: fetch('/api/...') and an
// EventSource on /api/events. Here both are intercepted and answered from:
//   - worklet.js, which runs the real C++ DSP chain (pedal-engine.wasm), and
//   - a little state kept in this file for what lives on disk on the Pi
//     (notes, setlist, saved edits, saved loops), which lasts one visit.
//
// The input is a re-amp player: one of the loops I recorded on the pedal,
// fed into the input jack so every preset processes it.
(() => {
  const HERE = new URL('.', document.currentScript.src);
  const asset = (p) => new URL(p, HERE).href;
  const realFetch = window.fetch.bind(window);
  const RealEventSource = window.EventSource;

  // ------------------------------------------------------------- state --
  let ctx = null, node = null, info = null, last = null, scope = new ArrayBuffer(0);
  let resolveReady;
  const ready = new Promise((r) => { resolveReady = r; });
  const streams = new Set();
  let paramIndex = {};

  const notes = [];           // filled once the preset count is known
  const SEED_NOTES = { cocteau: 'could be louder tbh,... hard to hear' };  // my real note from presets.conf
  const overrides = new Map(); // preset -> [[knob, value], ...]  ("Save preset")
  let setlist = [], cursor = -1;
  let source = 'none', reampName = null;
  let loops = [];              // [{name, seconds, frames, rate, url?, samples?}]
  const log = [];
  let logId = 0;
  let snapshotWaiter = null;

  function note(m) {
    const t = new Date().toLocaleTimeString('en-GB', { hour12: false });
    log.push({ id: ++logId, t, m });
    if (log.length > 200) log.shift();
  }

  const post = (m, transfer) => {
    bench.mirror(m);
    if (node) node.port.postMessage(m, transfer || []);
  };
  const presetName = (i) => (info && info.presets[i] ? info.presets[i].name : '#' + i);
  const current = () => (last ? last.preset : 0);

  // -------------------------------------------------------- loops list --
  const loopsLoaded = realFetch(asset('loops/index.json'))
    .then((r) => r.json())
    .then((list) => { loops = list.map((l) => ({ ...l, url: asset('loops/' + encodeURIComponent(l.file)) })); })
    .catch(() => { loops = []; });

  async function samplesFor(loop) {
    if (loop.samples) return loop.samples;
    const bytes = await (await realFetch(loop.url)).arrayBuffer();
    const buf = await ctx.decodeAudioData(bytes);  // resampled to the context rate if it differs
    loop.samples = buf.getChannelData(0).slice();
    return loop.samples;
  }

  async function plugIn(name) {
    const loop = loops.find((l) => l.name === name);
    if (!loop) return 'no loop called ' + name;
    const samples = await samplesFor(loop);
    const copy = samples.slice();
    post({ cmd: 'reamp', samples: copy }, [copy.buffer]);
    source = 'reamp';
    reampName = name;
    note('loop plugged into the input (re-amp): ' + name);
    syncBar();
    return '';
  }

  function setSource(s) {
    source = s;
    post({ cmd: 'source', source: s === 'sim' ? 1 : s === 'reamp' ? 2 : 0 });
    syncBar();
  }

  // ------------------------------------------------------------ bench --
  // Browsers give the audio thread no high-resolution clock, so the engine's
  // own block timing (the Deadline panel) would read as noise. Instead a second
  // copy of the same engine runs here on the main thread, mirrors every preset
  // and knob change, and every half second times 40 blocks of the test signal.
  // Same WebAssembly, same CPU: a real measurement of what one block costs.
  const bench = {
    e: null, out: 0, last: 0, avg: 0, max: 0,
    async start(wasm) {
      let mem;
      const clock = (_id, _p, out) => { new BigUint64Array(mem.buffer, out, 1)[0] = BigInt(Math.round(performance.now() * 1e6)); return 0; };
      const { instance } = await WebAssembly.instantiate(wasm, {
        env: { emscripten_notify_memory_growth() {} },
        wasi_snapshot_preview1: { clock_time_get: clock },
      });
      const e = instance.exports;
      mem = e.memory;
      e._initialize && e._initialize();
      e.engine_create(ctx.sampleRate);
      e.engine_set_source(1);
      this.out = e.engine_alloc(128 * 4);
      this.e = e;
      setInterval(() => this.tick(), 500);
    },
    mirror(m) {
      const e = this.e;
      if (!e) return;
      if (m.cmd === 'select') e.engine_select(m.index);
      else if (m.cmd === 'knob') e.engine_knob_set(m.index, m.value);
      else if (m.cmd === 'knobs') m.values.forEach(([i, v]) => e.engine_knob_set(i, v));
      else if (m.cmd === 'freeze') e.engine_freeze_toggle();
      else if (m.cmd === 'resetPeaks') this.max = 0;
    },
    tick() {
      const t0 = performance.now();
      for (let i = 0; i < 40; i++) this.e.engine_render(this.out, 128);
      const us = (performance.now() - t0) * 1000 / 40;
      this.last = us;
      this.avg = this.avg ? this.avg * 0.8 + us * 0.2 : us;
      this.max = Math.max(this.max, us);
    },
  };
  let hiresClock = true;

  // ----------------------------------------------------------- engine --
  async function powerOn() {
    if (ctx) return ready;
    try {
      ctx = new AudioContext({ sampleRate: 48000, latencyHint: 'interactive' });
    } catch (e) {
      ctx = new AudioContext({ latencyHint: 'interactive' });  // browser refused 48 kHz
    }
    ctx.resume();
    await ctx.audioWorklet.addModule(asset('worklet.js'));
    const wasm = await (await realFetch(asset('pedal-engine.wasm'))).arrayBuffer();
    node = new AudioWorkletNode(ctx, 'pedal', {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: { wasm },
    });
    node.port.onmessage = (ev) => fromWorklet(ev.data);
    node.connect(ctx.destination);
    bench.start(wasm).catch(() => {});
    return ready;
  }

  function fromWorklet(m) {
    if (m.type === 'ready') {
      info = m.static;
      hiresClock = m.hiresClock;
      paramIndex = Object.fromEntries(info.params.map((p, i) => [p.id, i]));
      info.presets.forEach((p, i) => { notes[i] = SEED_NOTES[p.id] || ''; });
      note('pedal started (in your browser: ' + info.presets.length + ' presets, ' + info.params.length + ' knobs)');
    } else if (m.type === 'state') {
      last = m;
      resolveReady();  // ready means a state frame exists to answer with
      const frame = JSON.stringify(stateJson());
      for (const es of streams) es.onmessage && es.onmessage({ data: frame });
    } else if (m.type === 'scope') {
      scope = m.data.buffer;
    } else if (m.type === 'snapshot' && snapshotWaiter) {
      snapshotWaiter(m.samples);
      snapshotWaiter = null;
    }
  }

  // ------------------------------------------- what WebServer.cpp sends --
  function paramsJson() {
    return {
      presets: info.presets.map(({ id, name, blurb, gear }) => ({ id, name, blurb, gear })),
      device_in: 'Re-amp: my recorded loops',
      device_out: 'Your speakers (Web Audio)',
      sample_rate: ctx.sampleRate,
      buffer_frames: 128,
      scope_points: 512,
      params: info.params,
    };
  }

  function stateJson() {
    const s = last;
    const p = info.presets[s.preset] || { groups: [], short_name: '' };
    const params = {};
    info.params.forEach((k, i) => { params[k.id] = s.knobs[i]; });
    return {
      preset: s.preset,
      looper: s.looper,
      loop_frames: s.loop_frames,
      loop_position: s.loop_position,
      audio_running: true,
      audio_status: '',
      simulator: source === 'sim',
      lcd: ['LOOP: ' + s.looper, 'FX:   ' + p.short_name],
      preset_modified: overrides.has(s.preset),
      comp_reduction_db: s.comp_reduction_db,
      active_groups: p.groups,
      frozen: s.frozen,
      freeze_mode: s.freeze_mode,
      setlist: setlist.slice(),
      setlist_cursor: cursor,
      gpio: { looper_switch: false, utility_switch: false, leds: false, lcd: false },
      in: s.in, out: s.out,
      blocks: s.blocks, xruns: s.xruns, clips: s.clips,
      block_us: hiresClock || !bench.e ? s.block_us
        : { last: bench.last, avg: bench.avg, max: bench.max, budget: s.block_us.budget },
      params,
      log,
    };
  }

  function selectPreset(i, fromSetlist) {
    if (!info || i < 0 || i >= info.presets.length) return;
    post({ cmd: 'select', index: i });
    const saved = overrides.get(i);
    if (saved) post({ cmd: 'knobs', values: saved });
    if (!fromSetlist) {
      const at = setlist.indexOf(i);
      if (at >= 0) cursor = at;
    }
  }

  const ok = { ok: true };
  const fail = (error) => ({ __status: 400, ok: false, error });

  async function route(method, path, q) {
    const isPost = method === 'POST';
    if (path === '/api/params') { await ready; return paramsJson(); }
    if (path === '/api/state') { await ready; return stateJson(); }
    if (path === '/api/scope') { await ready; return scope.slice(0); }
    if (path === '/api/notes' && !isPost) { await ready; return { notes: notes.slice() }; }
    if (path === '/api/loops' && !isPost) {
      await loopsLoaded;
      return { loops: loops.map(({ name, seconds, frames, rate }) => ({ name, seconds, frames, rate })) };
    }
    await ready;
    const cur = current();

    if (isPost && path === '/api/preset') { selectPreset(Number(q.get('value'))); note('web: preset -> ' + presetName(Number(q.get('value')))); return ok; }
    if (isPost && path === '/api/param') {
      const i = paramIndex[q.get('id')];
      if (i === undefined) return { __status: 404, ok: false };
      post({ cmd: 'knob', index: i, value: Number(q.get('value')) });
      return ok;
    }
    if (isPost && path === '/api/looper') {
      if (q.get('action') === 'trigger') { post({ cmd: 'trigger' }); note('web: looper trigger'); }
      if (q.get('action') === 'clear') { post({ cmd: 'clear' }); note('web: loop cleared'); }
      return ok;
    }
    if (isPost && path === '/api/freeze') {
      if (q.get('action') === 'mode') {
        const on = q.get('value') === '1';
        post({ cmd: 'freezeMode', on });
        note(on ? 'web: footswitch -> FREEZE' : 'web: footswitch -> LOOPER');
      } else {
        post({ cmd: 'freeze' });
        note(last && last.frozen ? 'web: freeze released' : 'web: freeze captured');
      }
      return ok;
    }
    if (isPost && path === '/api/sim') {
      const on = q.get('on') === '1' || q.get('on') === 'true';
      setSource(on ? 'sim' : (reampName ? 'reamp' : 'none'));
      note(on ? 'web: simulator on' : 'web: simulator off');
      return ok;
    }
    if (isPost && path === '/api/reset') { post({ cmd: 'resetPeaks' }); note('web: counters reset'); return ok; }
    if (isPost && path === '/api/preset/save') {
      const groups = new Set(info.presets[cur].groups);
      overrides.set(cur, info.params.map((p, i) => [p, i]).filter(([p]) => groups.has(p.group)).map(([, i]) => [i, last.knobs[i]]));
      note('saved settings for ' + presetName(cur) + ' (kept for this visit)');
      return ok;
    }
    if (isPost && path === '/api/preset/reset') { overrides.delete(cur); selectPreset(cur); note(presetName(cur) + ' restored to defaults'); return ok; }
    if (isPost && path === '/api/preset/reset-all') { overrides.clear(); selectPreset(cur); note('every preset restored to defaults'); return ok; }
    if (isPost && path === '/api/preset/note') {
      const i = Number(q.get('index'));
      if (i >= 0 && i < notes.length) { notes[i] = q.get('value') || ''; note('web: note saved for ' + presetName(i)); }
      return ok;
    }
    if (isPost && path === '/api/setlist') {
      const v = q.get('value') || '';
      setlist = v ? v.split(',').map(Number).filter((n) => n >= 0 && n < info.presets.length) : [];
      cursor = -1;
      note('web: setlist set to ' + setlist.length + ' preset(s)');
      return ok;
    }
    if (isPost && path === '/api/setlist/advance') {
      if (!setlist.length) { note('web: setlist is empty'); return ok; }
      cursor = (cursor + 1) % setlist.length;
      selectPreset(setlist[cursor], true);
      note('web: preset -> ' + presetName(setlist[cursor]));
      return ok;
    }
    if (isPost && path === '/api/loops') {
      const action = q.get('action'), name = q.get('name') || '';
      if (action === 'load') { const err = await plugIn(name); return err ? fail(err) : ok; }
      if (action === 'delete') {
        loops = loops.filter((l) => l.name !== name);
        note('loop deleted: ' + name + ' (for this visit)');
        return ok;
      }
      if (action === 'save') {
        const clean = name.replace(/[^A-Za-z0-9 _-]/g, '').trim();
        if (!clean) return fail('that name has nothing usable in it');
        const samples = await new Promise((r) => { snapshotWaiter = r; post({ cmd: 'snapshot' }); });
        if (!samples) return fail('nothing to save -- record a loop, and stop recording before saving');
        loops = loops.filter((l) => l.name !== clean);
        loops.unshift({ name: clean, seconds: samples.length / ctx.sampleRate, frames: samples.length, rate: ctx.sampleRate, samples });
        note('loop saved: ' + clean + ' (kept for this visit)');
        return ok;
      }
      return fail('unknown action');
    }
    return { __status: 404, ok: false };
  }

  window.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const body = await route((init.method || 'GET').toUpperCase(), url.pathname, url.searchParams);
    if (body instanceof ArrayBuffer) {
      return new Response(body, { headers: { 'Content-Type': 'application/octet-stream' } });
    }
    const status = (body && body.__status) || 200;
    if (body) delete body.__status;
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
  };

  window.EventSource = function (url, opts) {
    if (!String(url).startsWith('/api/events')) return new RealEventSource(url, opts);
    const es = { url, readyState: 0, onopen: null, onmessage: null, onerror: null, close() { streams.delete(es); es.readyState = 2; } };
    ready.then(() => {
      es.readyState = 1;
      streams.add(es);
      es.onopen && es.onopen({});
    });
    return es;
  };

  // ----------------------------------------------------- demo chrome --
  const bar = document.createElement('div');
  bar.id = 'demo-bar';
  bar.innerHTML = `
    <a class="demo-back" href="/">← Portfolio</a>
    <span class="demo-tag">Demo</span>
    <span class="demo-say">The pedal's real C++ signal chain, compiled to WebAssembly, running in your browser.</span>
    <a class="demo-arch" href="architecture.html">Architecture</a>
    <span class="spacer"></span>
    <label class="demo-input">Input
      <select id="demo-source" aria-label="What is plugged into the input"></select>
    </label>`;
  document.body.prepend(bar);
  const sel = bar.querySelector('#demo-source');
  // Back to whichever portfolio sleeve sent you here, or the portfolio's front page.
  const backToPortfolio = (e) => {
    const r = (() => { try { return new URL(document.referrer) } catch { return null } })()
    if (r && r.origin === location.origin && !r.pathname.startsWith('/demos/')) { e.preventDefault(); history.back() }
  };

  function syncBar() {
    const opts = loops.map((l) => `<option value="loop:${encodeURIComponent(l.name)}">${l.name.replace(/</g, '&lt;')}</option>`);
    sel.innerHTML = opts.join('') + '<option value="sim">Built-in test signal</option><option value="none">Nothing (silence)</option>';
    sel.value = source === 'reamp' && reampName ? 'loop:' + encodeURIComponent(reampName) : source;
  }
  sel.addEventListener('change', async () => {
    const v = sel.value;
    if (v.startsWith('loop:')) await plugIn(decodeURIComponent(v.slice(5)));
    else { setSource(v); note(v === 'sim' ? 'web: simulator on' : 'input unplugged'); }
  });

  const gate = document.createElement('div');
  gate.id = 'demo-gate';
  gate.innerHTML = `
    <div class="gate-card" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <h2 id="gate-title">Plug in</h2>
      <p>This is the control page for my guitar pedal. Everything you hear runs through the pedal's own
         C++ signal chain, compiled to WebAssembly, right here in your browser.</p>
      <p>You don't have my guitar, so pick one of the loops I recorded on the pedal and it goes into the
         input. Then flip through the presets, move the knobs, or record over it with the looper.
         Headphones help.</p>
      <div class="gate-loops" id="gate-loops"><span class="muted">loading loops…</span></div>
      <button class="gate-sim" id="gate-sim">or start with the pedal's built-in test signal</button>
      <a class="demo-back gate-back" href="/">← back to the portfolio</a>
      <p class="gate-fine">Every loop here is clean guitar — the looper stores the input before the
         chain, so whatever you switch on is doing the work you hear rather than being baked into
         the recording. On the real pedal a loaded loop plays <i>after</i> the effects; here it is
         re-amped into the input, so every preset processes it.</p>
    </div>`;
  document.body.append(gate);
  document.querySelectorAll('.demo-back').forEach((a) => a.addEventListener('click', backToPortfolio));

  async function start(first) {
    gate.classList.add('busy');
    gate.querySelector('.gate-card').setAttribute('aria-busy', 'true');
    try {
      await powerOn();
      if (first === 'sim') { setSource('sim'); note('web: simulator on'); }
      else await plugIn(first);
    } catch (err) {
      // Anything that goes wrong here used to leave the card spinning with no
      // explanation, which reads as a freeze. Say what happened instead.
      gate.classList.remove('busy');
      gate.querySelector('.gate-card').setAttribute('aria-busy', 'false');
      const why = !window.isSecureContext
        ? 'This page is on plain http, and browsers only give AudioWorklet — the ' +
          'thing that runs the pedal — to pages served over https or from localhost. ' +
          'Open it over https and it will run.'
        : (err && err.message) || String(err);
      let box = gate.querySelector('#gate-error');
      if (!box) {
        box = document.createElement('p');
        box.id = 'gate-error';
        box.className = 'gate-error';
        gate.querySelector('.gate-card').appendChild(box);
      }
      box.textContent = "The pedal couldn't start. " + why;
      console.error('pedal demo: start failed', err);
      return;
    }
    gate.classList.add('gone');
    setTimeout(() => gate.remove(), 400);
  }

  loopsLoaded.then(() => {
    const box = gate.querySelector('#gate-loops');
    box.textContent = '';
    for (const l of loops) {
      const b = document.createElement('button');
      b.className = 'gate-loop';
      b.innerHTML = `<span class="nm"></span><span class="dur">${l.seconds.toFixed(1)} s</span>`;
      b.querySelector('.nm').textContent = l.name;
      b.onclick = () => start(l.name);
      box.appendChild(b);
    }
    syncBar();
  });
  gate.querySelector('#gate-sim').onclick = () => start('sim');
})();
