// The theme switcher: a tiny copy of every cover, so it's obvious the page comes
// in other looks. Pages mark themselves with <body data-pressing>.
// "Sleeve" survives in the internals — filename, classes, the data attribute —
// because only two of these are album sleeves any more, but renaming the wiring
// would be churn for nothing. What the visitor reads says theme.
(function () {
  const IR_LINES = ['#f39a1e', '#3f7fd0', '#f39a1e', '#e0322b', '#3cb44b', '#f7c600', '#29b6d9'];
  // In Matt's own order of preference, 13 Sep 2026 — the switcher leads with
  // the one he likes best. A commented-out entry is benched: still in the
  // repo, out of the switcher, and dropped from the public build by
  // hub/publish.toml. Uncomment it there and here to bring it back.
  const sleeves = [
    { id: 'plitvice', name: 'Plitvice', art: () => '<img src="../plitvice/thumb.jpg" alt="">' },
    { id: 'in-rainbows', name: 'In Rainbows', art: () => IR_LINES.map((c) => `<i style="--c:${c}"></i>`).join('') },
    { id: 'out-of-focus', name: 'Out of Focus', art: () => '<img src="../out-of-focus/thumb.jpg" alt="">' },
    { id: 'strays', name: 'Strays', art: () => '<img src="../strays/thumb.jpg" alt="">' },
    { id: 'five-storeys', name: 'Five Storeys', art: () => '<img src="../five-storeys/thumb.jpg" alt="">' },
    { id: 'great-elm', name: 'The Great Elm', art: () => '<img src="../great-elm/thumb.jpg" alt="">' },
  ];
  const current = document.body.dataset.pressing;

  const nav = document.createElement('nav');
  nav.className = 'sleeves';
  nav.setAttribute('aria-label', 'Switch theme');
  nav.innerHTML =
    `<span class="label" aria-hidden="true">Switch theme</span>` +
    sleeves
      .map((s) => {
        const on = s.id === current;
        return (
          `<a class="sleeve${on ? ' current' : ''}" href="../${s.id}/"${on ? ' aria-current="page"' : ''}>` +
          `<span class="art art-${s.id}" aria-hidden="true">${s.art()}</span>` +
          `<span class="name">${s.name}${on ? ' · on now' : ''}</span></a>`
        );
      })
      .join('');
  document.body.appendChild(nav);

  // Once per visit, the other themes wiggle so nobody misses them.
  let seen = false;
  try { seen = sessionStorage.getItem('sleeves-nudged') === '1'; } catch (e) {}
  if (seen || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  setTimeout(() => {
    nav.classList.add('nudge');
    setTimeout(() => nav.classList.remove('nudge'), 3200);
    try { sessionStorage.setItem('sleeves-nudged', '1'); } catch (e) {}
  }, 1800);
})();
