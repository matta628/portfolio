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
// fed into the input jack so every preset processes it. The page's Looper
// panel is that player's transport (pause, scrub) and its Saved loops list
// and the Input menu in the demo bar are two views of the same choice. The
// pedal's own recording, saving and dry/wet switch are off here: overdubbing a
// loop onto itself sounds like nothing anyone would want, and the built-in
// test signal is not worth a visitor's time.
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

  function unplug() {
    reampName = null;
    setSource('none');
    note('input unplugged');
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
      device_in: 'A loop I recorded on the pedal (stands in for the M-Track Duo)',
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
      loop_paused: !!s.loop_paused,
      clean_loop: false,
      audio_running: true,
      audio_status: '',
      simulator: false,
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
      const a = q.get('action');
      if (a === 'trigger') note('web: looper trigger — recording is off in this demo; the loop is the input');
      else if (a === 'clear') unplug();
      else if (a === 'pause') {
        const on = q.get('value') === '1';
        post({ cmd: 'pause', on });
        note(on ? 'web: input paused' : 'web: input resumed');
      } else if (a === 'seek') post({ cmd: 'seek', frame: Number(q.get('frame')) || 0 });
      else if (a === 'clean') note('web: dry/wet is fixed in this demo; every loop is a dry take');
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
    if (isPost && path === '/api/sim') { note('web: the test signal is off in this demo'); return ok; }
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
      return fail('Not in this demo: the saved loops are the ones I recorded on the pedal. Pick one and it plays into the input.');
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
    sel.innerHTML = opts.join('') + '<option value="none">Nothing (silence)</option>';
    sel.value = source === 'reamp' && reampName ? 'loop:' + encodeURIComponent(reampName) : 'none';
    syncList();
  }
  sel.addEventListener('change', async () => {
    const v = sel.value;
    if (v.startsWith('loop:')) await plugIn(decodeURIComponent(v.slice(5)));
    else unplug();
  });

  // The page's Saved loops list is rebuilt from scratch after every action, so
  // it is re-marked whenever it changes: the playing loop is highlighted, and
  // the buttons that would write to the pedal's disk are greyed.
  function syncList() {
    document.querySelectorAll('#loops-list .loop-row').forEach((row) => {
      const name = row.querySelector('.nm') && row.querySelector('.nm').textContent;
      row.classList.toggle('playing', source === 'reamp' && name === reampName);
      row.querySelectorAll('button').forEach((b) => {
        if (b.textContent === 'load') b.classList.add('load-btn');
        else { b.disabled = true; b.classList.add('demo-off'); }
      });
    });
  }
  const list = document.getElementById('loops-list');
  if (list) new MutationObserver(syncList).observe(list, { childList: true });

  // The pedal's own controls that have no meaning here stay on the page, greyed,
  // so the panel still reads as the real one.
  for (const id of ['btn-trigger', 'btn-loop-save', 'btn-clean-loop']) {
    const b = document.getElementById(id);
    if (b) { b.disabled = true; b.classList.add('demo-off'); }
  }
  const paneHint = document.querySelector('#pane-looper .hint');
  if (paneHint) paneHint.innerHTML =
    'In this demo the loop you picked <b>is</b> the input: it plays into the pedal, so every preset ' +
    'processes it. Pause it, click the bar to scrub, or switch loops from the <b>Input</b> menu at the top ' +
    'or the <b>Saved loops</b> list. Recording, saving and the dry/wet switch belong to the real pedal and are off here.';
  const loopsEmpty = document.getElementById('loops-empty');
  if (loopsEmpty) loopsEmpty.textContent = 'Loading the loops I recorded on the pedal…';

  const gate = document.createElement('div');
  gate.id = 'demo-gate';
  gate.innerHTML = `
    <div class="gate-card" role="dialog" aria-modal="true" aria-labelledby="gate-title">
      <h2 id="gate-title">Plug in</h2>
      <p>This is the control page for my guitar pedal. On my desk it is a Raspberry Pi 5 with an
         M-Audio M-Track Duo plugged into it: the guitar goes into the Duo, the Pi runs the pedal's
         C++ signal chain, and the sound comes back out of the Duo's headphone jack. The footswitch and
         its LED are wired straight to the Pi's GPIO pins — I bought the switch and wired it up myself.</p>
      <svg class="gate-rig" viewBox="0 0 460 150" role="img" aria-label="Guitar into the M-Track Duo, USB to the Raspberry Pi and back, headphones out of the Duo; footswitch and LED on the Pi's GPIO pins">
        <defs><marker id="rig-ah" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="5" markerHeight="5" orient="auto"><path d="M0 0L8 4L0 8Z" fill="var(--accent-line)"/></marker></defs>
        <g fill="var(--panel-2)" stroke="var(--line-2)">
          <rect x="6" y="44" width="72" height="40" rx="6"/>
          <rect x="120" y="30" width="122" height="68" rx="6"/>
          <rect x="296" y="18" width="158" height="92" rx="6"/>
          <rect x="120" y="116" width="122" height="26" rx="6"/>
          <rect x="296" y="124" width="70" height="20" rx="5"/>
          <rect x="384" y="124" width="70" height="20" rx="5"/>
        </g>
        <g font-family="var(--ui)" font-size="10.5" fill="var(--text)" text-anchor="middle">
          <text x="42" y="68">guitar</text>
          <text x="181" y="52" font-weight="600">M-Audio M-Track Duo</text>
          <text x="181" y="68" fill="var(--dim)" font-size="9.5">USB audio, in and out</text>
          <text x="181" y="84" fill="var(--dim)" font-size="9.5">headphones on the front</text>
          <text x="375" y="42" font-weight="600">Raspberry Pi 5</text>
          <text x="375" y="58" fill="var(--dim)" font-size="9.5">guitar_pedal — the C++ chain</text>
          <text x="375" y="74" fill="var(--dim)" font-size="9.5">256 frames every 5.3 ms</text>
          <text x="375" y="98" fill="var(--faint)" font-family="var(--mono)" font-size="8.5">GPIO17 · GPIO22</text>
          <text x="181" y="133">headphones</text>
          <text x="331" y="138" font-size="9.5">footswitch</text>
          <text x="419" y="138" font-size="9.5">LED</text>
        </g>
        <g fill="none" stroke="var(--accent-line)" stroke-width="1.4" marker-end="url(#rig-ah)">
          <path d="M78 64 L116 64"/>
          <path d="M242 54 L292 54"/>
          <path d="M296 76 L246 76"/>
          <path d="M181 98 L181 112"/>
          <path d="M331 124 L331 114"/>
          <path d="M419 114 L419 120"/>
        </g>
        <g font-family="var(--mono)" font-size="8.5" fill="var(--faint)" text-anchor="middle">
          <text x="269" y="48">USB</text>
          <text x="269" y="88">USB</text>
        </g>
      </svg>
      <p>Here, everything that makes sound is that same C++, compiled to WebAssembly and running in
         your browser. You don't have my guitar, so pick one of the loops I recorded on the pedal: it
         plays into the input, and every preset processes it. Pause it or scrub through it in the
         Looper panel; switch loops from the <b>Input</b> menu at the top or the <b>Saved loops</b>
         list. Headphones help.</p>
      <div class="gate-loops" id="gate-loops"><span class="muted">loading loops…</span></div>
      <a class="demo-back gate-back" href="/">← back to the portfolio</a>
      <p class="gate-fine">Every loop here is clean guitar: the pedal recorded the untouched input, so
         whatever you switch on is doing the work you hear rather than being baked into the recording.</p>
    </div>`;
  document.body.append(gate);
  document.querySelectorAll('.demo-back').forEach((a) => a.addEventListener('click', backToPortfolio));

  async function start(first) {
    gate.classList.add('busy');
    gate.querySelector('.gate-card').setAttribute('aria-busy', 'true');
    try {
      await powerOn();
      await plugIn(first);
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
})();
