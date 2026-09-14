// The pedal's audio thread, in the browser. Hosts pedal-engine.wasm (the real
// C++ chain) and plays the role RtAudio's callback plays on the Pi: 128 frames
// in, 128 frames out, every few milliseconds, no allocation.
//
// Talks to shim.js over the port: commands in; state frames (25 Hz) and scope
// windows (15 Hz) out, the same rates the Pi's web server uses.

const LOOPER_STATES = ['EMPTY', 'REC', 'PLAY', 'OVERDUB'];
const SCOPE_STRIDE = 4;  // WebServer.cpp's kScopeStride

// steady_clock in the C++ reads this. Worklet scopes don't always have
// performance.now(); Date.now() keeps the clock monotonic-ish, just coarse.
const now = () => (globalThis.performance && performance.now ? performance.now() : Date.now());

class PedalProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const { wasm } = options.processorOptions;
    const mod = new WebAssembly.Module(wasm);
    this.hiresClock = !!(globalThis.performance && performance.now);
    const self = this;
    const env = {
      emscripten_notify_memory_growth() {},
    };
    const wasi = {
      clock_time_get(_id, _precision, out) {
        new BigUint64Array(self.memory.buffer, out, 1)[0] = BigInt(Math.round(now() * 1e6));
        return 0;
      },
    };
    const inst = new WebAssembly.Instance(mod, { env, wasi_snapshot_preview1: wasi });
    this.e = inst.exports;
    this.memory = this.e.memory;
    this.e._initialize?.();
    this.e.engine_create(sampleRate);

    this.outPtr = this.e.engine_alloc(128 * 4);
    this.telPtr = this.e.engine_alloc(11 * 4);
    this.knobCount = this.e.engine_knob_count();
    this.knobPtr = this.e.engine_alloc(this.knobCount * 4);
    this.scopeN = this.e.engine_scope_samples();
    this.scopeIn = this.e.engine_alloc(this.scopeN * 4);
    this.scopeOut = this.e.engine_alloc(this.scopeN * 4);

    this.framesSinceState = 0;
    this.framesSinceScope = 0;
    this.stateEvery = Math.round(sampleRate / 25);
    this.scopeEvery = Math.round(sampleRate / 15);

    this.port.onmessage = (ev) => this.command(ev.data);
    const staticJson = this.readString(this.e.engine_static_json(), this.e.engine_static_json_len());
    this.port.postMessage({ type: 'ready', static: JSON.parse(staticJson), hiresClock: this.hiresClock });
  }

  f32(ptr, n) { return new Float32Array(this.memory.buffer, ptr, n); }  // fresh view: memory can grow

  readString(ptr, len) {
    const bytes = new Uint8Array(this.memory.buffer, ptr, len);
    let s = '';
    for (let i = 0; i < len; i += 8192) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    return decodeURIComponent(escape(s));  // UTF-8 (preset names have "·" and "—")
  }

  command(m) {
    const e = this.e;
    switch (m.cmd) {
      case 'select': e.engine_select(m.index); break;
      case 'knob': e.engine_knob_set(m.index, m.value); break;
      case 'knobs': m.values.forEach(([i, v]) => e.engine_knob_set(i, v)); break;
      case 'trigger': e.engine_looper_trigger(); break;
      case 'clear': e.engine_looper_clear(); break;
      case 'freeze': e.engine_freeze_toggle(); break;
      case 'freezeMode': e.engine_set_freeze_mode(m.on ? 1 : 0); break;
      case 'source': e.engine_set_source(m.source); break;
      case 'pause': e.engine_input_pause(m.on ? 1 : 0); break;
      case 'seek': e.engine_input_seek(m.frame | 0); break;
      case 'reamp': {
        const ptr = e.engine_reamp_buffer(m.samples.length);
        this.f32(ptr, m.samples.length).set(m.samples);
        e.engine_set_source(2);
        break;
      }
      case 'resetPeaks': e.engine_reset_peaks(); break;
      case 'snapshot': {
        const n = e.engine_looper_snapshot();
        const samples = n > 0 ? this.f32(e.engine_looper_snapshot_data(), n).slice() : null;
        this.port.postMessage({ type: 'snapshot', id: m.id, samples }, samples ? [samples.buffer] : []);
        break;
      }
    }
  }

  sendState() {
    const e = this.e;
    e.engine_telemetry(this.telPtr);
    e.engine_knob_values(this.knobPtr);
    const t = this.f32(this.telPtr, 11);
    this.port.postMessage({
      type: 'state',
      preset: e.engine_current(),
      // The Looper panel shows the input loop, not the pedal's own looper:
      // in the demo the loop you picked IS the input, and recording is off.
      looper: e.engine_input_length() > 0 ? 'PLAY' : 'EMPTY',
      loop_frames: e.engine_input_length(),
      loop_position: e.engine_input_position(),
      loop_paused: !!e.engine_input_paused(),
      frozen: !!e.engine_frozen(),
      freeze_mode: !!e.engine_freeze_mode(),
      comp_reduction_db: e.engine_comp_reduction_db(),
      in: { peak: t[0], rms: t[1] },
      out: { peak: t[2], rms: t[3] },
      blocks: t[4], xruns: t[5], clips: t[6],
      block_us: { last: t[7], avg: t[8], max: t[9], budget: t[10] },
      knobs: this.f32(this.knobPtr, this.knobCount).slice(),
    });
  }

  sendScope() {
    if (!this.e.engine_scope(this.scopeIn, this.scopeOut)) return;
    const points = this.scopeN / SCOPE_STRIDE;
    const packed = new Float32Array(points * 2);
    const a = this.f32(this.scopeIn, this.scopeN), b = this.f32(this.scopeOut, this.scopeN);
    for (let i = 0; i < points; i++) {
      packed[i] = a[i * SCOPE_STRIDE];
      packed[points + i] = b[i * SCOPE_STRIDE];
    }
    this.port.postMessage({ type: 'scope', data: packed }, [packed.buffer]);
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const n = out[0].length;
    this.e.engine_render(this.outPtr, n);
    const block = this.f32(this.outPtr, n);
    for (const ch of out) ch.set(block);  // mono pedal, fanned out like run_block does

    this.framesSinceState += n;
    this.framesSinceScope += n;
    if (this.framesSinceState >= this.stateEvery) { this.framesSinceState = 0; this.sendState(); }
    if (this.framesSinceScope >= this.scopeEvery) { this.framesSinceScope = 0; this.sendScope(); }
    return true;
  }
}

registerProcessor('pedal', PedalProcessor);
