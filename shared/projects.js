// The record: same four tracks in every pressing. Only the sleeve changes.
window.PORTFOLIO = {
  artist: 'Matt Aguilar',
  projects: [
    {
      id: 'taste',
      track: 'A1',
      name: 'Taste',
      titleLines: ['Taste'],
      blurb: 'A taste graph and AI agent built on seven years of my real listening and reading history.',
      personnel: [['Python', 'vocals'], ['DuckDB', 'bass'], ['MCP', 'drums'], ['FastAPI', 'guitar'], ['React', 'keys']],
      href: '../demos/taste/',
    },
    {
      id: 'pedal',
      track: 'A2',
      name: 'Guitar Pedal',
      titleLines: ['Guitar', 'Pedal'],
      blurb: 'A real-time C++20 multi-effects pedal and looper on a Raspberry Pi 5, with a footswitch and web controls.',
      personnel: [['C++20', 'guitar'], ['RtAudio', 'amp'], ['libgpiod', 'stomp'], ['CMake', 'roadie'], ['Pi 5', 'stage']],
      href: '../demos/pedal/',
    },
    {
      id: 'jobs',
      track: 'B1',
      name: 'Job Application Tracker',
      titleLines: ['Job', 'Tracker'],
      blurb: 'Scrapes job boards, filters out the noise, and scores every posting 1–10 against what I actually want.',
      personnel: [['Python', 'vocals'], ['FastAPI', 'drums'], ['SQLite', 'bass'], ['React', 'keys'], ['Tailwind', 'wardrobe']],
      href: '../demos/job-tracker/',
    },
    {
      id: 'streeteasy',
      track: 'B2',
      name: 'StreetEasy Scanner',
      titleLines: ['Street', 'Easy', 'Scanner'],
      blurb: 'Watches StreetEasy around the clock and emails me new apartments, commute times, and where to eat nearby.',
      personnel: [['Python', 'vocals'], ['curl_cffi', 'guitar'], ['Maps API', 'navigator'], ['SMTP', 'press'], ['systemd', 'roadie']],
      href: '../demos/streeteasy/',
    },
  ],
};

// ENTER on any sleeve. A demo that exists is a plain link; one that doesn't
// yet (href still '#...') says so instead of silently jumping nowhere.
window.enterDemo = function (e, name, href) {
  if (href && !href.startsWith('#')) return;
  e.preventDefault();
  window.demoToast(name);
};

window.demoToast = function (name) {
  let t = document.querySelector('.toast');
  if (!t) {
    t = document.createElement('div');
    t.className = 'toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = `${name}: the demo isn't pressed yet. Prototype!`;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 2400);
};
