/**
 * The photo pressings — Plitvice, The Great Elm, Five Storeys, Strays and Out
 * of Focus — are one idea five times over: a photograph with a few shapes
 * traced onto it, one shape per project. Hover a shape and it names itself;
 * click and the name grows into the full credit with a way into the demo.
 *
 * Only the geometry and the paint change between them, so the behavior lives
 * here and each sleeve supplies its own regions and its own CSS.
 *
 * Geometry note: every coordinate a sleeve hands over is a percentage of the
 * photo, x across and y down, so the numbers can be read straight off the
 * picture. The SVG viewBox is `0 0 100 {100 * height / width}` — x is already
 * the percentage, and y gets scaled by the aspect ratio so a diagonal stays a
 * diagonal instead of shearing. `pct()` below does that conversion, which is
 * why label positions are given in plain photo percentages too.
 */
window.photoSleeve = function (cfg) {
  const stage = typeof cfg.mount === 'string' ? document.querySelector(cfg.mount) : cfg.mount;
  const aspect = cfg.photo[1] / cfg.photo[0];          // height / width
  const byId = Object.fromEntries(window.PORTFOLIO.projects.map((p) => [p.id, p]));
  const info = (id) => (id === 'about' ? cfg.about : byId[id]);
  const isAbout = (id) => id === 'about';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const INTRO_STEP = 1000;

  // y as the viewBox sees it
  const pct = (y) => +(y * aspect).toFixed(2);

  // ---------- the shapes ----------
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'hits');
  svg.setAttribute('viewBox', `0 0 100 ${pct(100)}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');   // the tracklist is the accessible copy

  const el = (name, attrs) => {
    const n = document.createElementNS('http://www.w3.org/2000/svg', name);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    return n;
  };

  cfg.regions.forEach((r) => {
    const g = el('g', { class: `hit hit-${r.id}`, 'data-id': r.id });
    // Two copies of the same shape: a fat invisible one that catches the
    // pointer, and a thin painted one that lights up. Splitting them means the
    // target can be forgiving without the highlight looking clumsy.
    // An area can be given as one ring of points or, when the thing it names is
    // really two things — a pair of towers standing together — as several. The
    // multi-part case becomes one <path> of closed subpaths so it still lights
    // and catches the pointer as a single region.
    // A region can be given as one run of points or, when the thing it names is
    // really several — two towers standing together, a limb that forks — as an
    // array of runs. Either way it becomes a single shape that lights and
    // catches the pointer as one region. Areas close their subpaths; lines
    // don't, because a branch has two ends and no inside.
    const multi = r.kind !== 'ellipse' && Array.isArray(r.points) && Array.isArray(r.points[0][0]);
    const ring = (pts) => pts.map(([x, y]) => `${x},${pct(y)}`).join(' ');
    const subpaths = (close) =>
      r.points.map((p) => `M${ring(p).replace(/ /g, 'L')}${close ? 'Z' : ''}`).join(' ');
    const shape = (cls) => (r.kind === 'ellipse'
      ? el('ellipse', { class: cls, cx: r.at[0], cy: pct(r.at[1]), rx: r.r[0], ry: pct(r.r[1]) })
      : multi
        ? el('path', { class: cls, d: subpaths(r.kind !== 'line') })
        : r.kind === 'line'
          ? el('polyline', { class: cls, points: ring(r.points) })
          : el('polygon', { class: cls, points: ring(r.points) }));
    g.appendChild(shape('grab'));
    g.appendChild(shape('lit'));
    svg.appendChild(g);
    r.g = g;
    // A sleeve can add its own artwork inside the region's group — Plitvice
    // hangs spray in the waterfalls this way. Nothing else uses it, so the
    // extra SVG stays out of the sleeves that don't want it.
    if (cfg.decorate) cfg.decorate({ region: r, group: g, svg, el, pct });
  });
  stage.appendChild(svg);

  // ---------- the names ----------
  const layer = document.createElement('div');
  layer.className = 'names';
  stage.appendChild(layer);

  const joinAnd = (a) => (a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`);

  cfg.regions.forEach((r) => {
    const d = info(r.id);
    const card = document.createElement('div');
    // A label near the left edge has to grow rightwards and vice versa, or the
    // opened card hangs off the photo.
    const side = r.side || (r.label[0] > 66 ? 'right' : r.label[0] < 34 ? 'left' : 'center');
    card.className = `name side-${side}`;
    // set as custom properties, not inline left/top, so a sleeve can re-anchor
    // the opened card from its stylesheet (see Strays, whose photo is full)
    card.style.setProperty('--x', `${r.label[0]}%`);
    card.style.setProperty('--y', `${r.label[1]}%`);
    // `.more` collapses with the 0fr..1fr grid trick, which only sizes its
    // first row — so everything that has to fold away goes in one `.inner`.
    card.innerHTML = isAbout(r.id)
      ? `<p class="no">${d.no || '—'}</p><p class="nm">${d.name}</p>` +
        `<div class="more"><div class="inner">${d.lines.map((t) => `<p class="blurb">${t}</p>`).join('')}` +
        `<div class="actions">${d.links.map(([t, u]) => `<a class="enter ghost" href="${u}" target="_blank" rel="noopener">${t} ↗</a>`).join('')}</div></div></div>`
      : `<p class="no">${d.track}</p><p class="nm">${d.name}</p>` +
        `<div class="more"><div class="inner"><p class="kit">${joinAnd(d.personnel.map(([t]) => t))}</p>` +
        `<p class="blurb">${d.blurb}</p>` +
        `<div class="actions"><a class="enter" href="${d.href}">Enter the demo →</a></div></div></div>`;
    layer.appendChild(card);
    r.card = card;
    const enter = card.querySelector('.enter:not(.ghost)');
    if (enter) enter.addEventListener('click', (e) => window.enterDemo(e, d.name, d.href));
  });

  // ---------- the tracklist: the same thing, for keyboards and thumbs ----------
  const list = document.createElement('ol');
  list.className = 'tracks';
  list.innerHTML = cfg.regions.map((r) => {
    const d = info(r.id);
    return `<li><button type="button" data-id="${r.id}">` +
      `<span class="no">${isAbout(r.id) ? (d.no || '—') : d.track}</span>` +
      `<span class="nm">${d.name}</span>` +
      `<span class="nick">${r.nick || ''}</span></button></li>`;
  }).join('');
  (typeof cfg.tracks === 'string' ? document.querySelector(cfg.tracks) : cfg.tracks).appendChild(list);
  const rowFor = (id) => list.querySelector(`button[data-id="${id}"]`);

  // ---------- state ----------
  let hot = null;    // named by hover or focus
  let open = null;   // clicked open

  function light(r, on) {
    if (r.g) r.g.classList.toggle('on', on);
    r.card.classList.toggle('on', on);
    rowFor(r.id).classList.toggle('on', on);
  }

  let introTimers = [];
  function stopIntro() {
    introTimers.forEach(clearTimeout);
    introTimers = [];
  }

  function name(r) {
    stopIntro();
    if (hot === r) return;
    hot = r;
    // Only ever one named at a time. Sweeping the whole list is cheap and it
    // can't leave a stale one lit the way tracking a single previous did.
    cfg.regions.forEach((o) => { if (o !== r && o !== open) light(o, false); });
    if (r) light(r, true);
    stage.classList.toggle('naming', !!r);
  }

  function show(r) {
    stopIntro();
    if (open && open !== r) {
      open.card.classList.remove('open');
      if (open !== hot) light(open, false);
    }
    open = r;
    if (r) {
      light(r, true);
      r.card.classList.add('open');
      // let the card take the pointer so its link is clickable
      r.card.classList.add('grabby');
    }
    stage.classList.toggle('reading', !!r);
  }

  function shut() {
    if (!open) return;
    open.card.classList.remove('open', 'grabby');
    if (open !== hot) light(open, false);
    open = null;
    stage.classList.remove('reading');
  }

  cfg.regions.forEach((r) => {
    const over = (e) => { if (!e.pointerType || e.pointerType === 'mouse') name(r); };
    const out = () => { if (hot === r) name(null); };

    r.g.addEventListener('pointerenter', over);
    r.g.addEventListener('pointerleave', out);
    r.g.addEventListener('click', () => (open === r ? shut() : show(r)));

    const row = rowFor(r.id);
    row.addEventListener('pointerenter', over);
    row.addEventListener('pointerleave', out);
    row.addEventListener('focus', () => name(r));
    row.addEventListener('blur', () => out());
    row.addEventListener('click', () => (open === r ? shut() : show(r)));

    // hovering the open card keeps it open
    r.card.addEventListener('pointerenter', () => { if (open === r) name(r); });
    r.card.addEventListener('pointerleave', out);
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') shut(); });
  document.addEventListener('pointerdown', (e) => {
    if (!open) return;
    if (!open.card.contains(e.target) && !open.g.contains(e.target) && !rowFor(open.id).contains(e.target)) shut();
  });

  // ---------- once, on arrival, each shape names itself ----------
  if (cfg.intro !== false && !reduced) {
    cfg.regions.forEach((r, i) => {
      // One beat for every theme. It was 420ms, which is shorter than the elm's
      // own 850ms draw-on, so that theme was cut off part-way through its
      // animation and read as rushed. A second is the floor, and the hold is
      // the whole beat bar a breath, so each region finishes what it starts.
      const at = (cfg.introDelay || 1200) + i * INTRO_STEP;
      introTimers.push(setTimeout(() => {
        if (!hot && !open) { light(r, true); stage.classList.add('naming'); }
      }, at));
      introTimers.push(setTimeout(() => {
        // unlight unconditionally unless it's the one being pointed at, so a
        // hover part-way through the cycle can't strand it
        if (r !== hot && r !== open) light(r, false);
        if (!hot && !open) stage.classList.remove('naming');
      }, at + INTRO_STEP - 140));
    });
  }

  return { regions: cfg.regions, show, shut };
};
