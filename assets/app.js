(function () {
  'use strict';

  var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ---------- nav ---------- */

  var nav = document.getElementById('nav');
  var navToggle = document.getElementById('navToggle');
  var navLinks = document.getElementById('navLinks');

  function closeNav() {
    nav.classList.remove('open');
    if (navToggle) navToggle.setAttribute('aria-expanded', 'false');
  }

  if (navToggle) {
    navToggle.addEventListener('click', function () {
      var open = nav.classList.toggle('open');
      navToggle.setAttribute('aria-expanded', String(open));
    });
  }

  if (navLinks) {
    navLinks.addEventListener('click', function (event) {
      if (event.target.closest('a')) closeNav();
    });
  }

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') closeNav();
  });

  var sections = Array.prototype.slice.call(document.querySelectorAll('main section[id]'));
  var spyLinks = {};
  if (navLinks) {
    Array.prototype.forEach.call(navLinks.querySelectorAll('a[href^="#"]:not(.nav-cta)'), function (link) {
      var id = link.getAttribute('href').slice(1);
      if (id) spyLinks[id] = link;
    });
  }

  var ticking = false;

  function onScroll() {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      ticking = false;
      if (nav) nav.classList.toggle('scrolled', window.scrollY > 8);

      var probe = window.scrollY + 150;
      var current = '';
      for (var i = 0; i < sections.length; i++) {
        var section = sections[i];
        var top = section.getBoundingClientRect().top + window.scrollY;
        if (top <= probe) current = section.id;
      }

      Object.keys(spyLinks).forEach(function (id) {
        spyLinks[id].classList.toggle('active', id === current);
      });
    });
  }

  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();

  /* ---------- reveal on scroll ---------- */

  var revealEls = Array.prototype.slice.call(document.querySelectorAll('.reveal'));

  if (!('IntersectionObserver' in window) || reduceMotion) {
    revealEls.forEach(function (el) { el.classList.add('in'); });
  } else {
    var revealObserver = new IntersectionObserver(function (entries, observer) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -36px 0px' });

    revealEls.forEach(function (el) { revealObserver.observe(el); });
  }

  /* ---------- tabs ---------- */

  var tabs = Array.prototype.slice.call(document.querySelectorAll('[role="tab"]'));

  function activateTab(tab, focus) {
    tabs.forEach(function (item) {
      var selected = item === tab;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;

      var panel = document.getElementById(item.getAttribute('aria-controls'));
      if (panel) {
        panel.hidden = !selected;
        if (selected) panel.classList.add('in');
      }
    });
    if (focus) tab.focus();
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () { activateTab(tab, false); });
    tab.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      var next = (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      activateTab(tabs[next], true);
    });
  });

  /* ---------- copy buttons ---------- */

  function legacyCopy(text) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (error) { /* ignore */ }
    document.body.removeChild(area);
  }

  Array.prototype.forEach.call(document.querySelectorAll('.copy'), function (button) {
    button.addEventListener('click', function () {
      var source = document.getElementById(button.getAttribute('data-copy'));
      if (!source) return;
      var text = source.textContent.replace(/\n$/, '');
      var done = function () {
        button.textContent = '已复制';
        button.classList.add('copied');
        window.setTimeout(function () {
          button.textContent = '复制';
          button.classList.remove('copied');
        }, 1600);
      };

      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {
          legacyCopy(text);
          done();
        });
      } else {
        legacyCopy(text);
        done();
      }
    });
  });

  /* ---------- hero terminal ---------- */

  var termBody = document.getElementById('termBody');

  var defaultScenarios = [
    [
      { c: 'tl-cmd', t: 'curl -sI http://devmymc.html.dtns.top' },
      { c: 'tl-info', t: 'ingress  →  :18386   route by Host' },
      { c: 'tl-info', t: 'tunnel   →  client ibsvr-dsh-1' },
      { c: 'tl-dim', t: 'local    →  127.0.0.1:3015' },
      { c: 'tl-ok', t: 'response ←  200 OK · text/html · 18 ms' }
    ],
    [
      { c: 'tl-cmd', t: 'GET /terminal  Upgrade: websocket' },
      { c: 'tl-info', t: 'tunnel   →  101 Switching Protocols' },
      { c: 'tl-dim', t: 'frames   ⇄  text / binary  双向透传' },
      { c: 'tl-ok', t: 'close    ←  1000 normal closure' }
    ],
    [
      { c: 'tl-cmd', t: 'GET /api/events  Accept: text/event-stream' },
      { c: 'tl-info', t: 'stream   →  open · chunk 256 KB · window 1 MB' },
      { c: 'tl-dim', t: 'event: tick   data: {"uptime": 1284}' },
      { c: 'tl-ok', t: 'stream   ←  still open · backpressure 0%' }
    ]
  ];

  var agentScenarios = [
    [
      { c: 'tl-cmd', t: 'curl -H "Authorization: Bearer ••••" $API/agent/status' },
      { c: 'tl-info', t: 'browser  ⇄  wss://res2.dtns.top/tunnel' },
      { c: 'tl-dim', t: 'frame    →  http_request  GET /agent/status' },
      { c: 'tl-ok', t: 'response ←  200 OK · application/json · 9 ms' }
    ],
    [
      { c: 'tl-cmd', t: 'POST /agent/highlight  target #agent h2' },
      { c: 'tl-info', t: 'tunnel   →  DTNS v2 · http_request 284 B' },
      { c: 'tl-dim', t: 'page     →  classList.add("agent-highlight")' },
      { c: 'tl-ok', t: 'response ←  200 OK · {"ok":true,"count":1}' }
    ],
    [
      { c: 'tl-cmd', t: 'GET /agent/page' },
      { c: 'tl-info', t: 'frame    →  http_request 341 B' },
      { c: 'tl-dim', t: 'dom      →  headings · sections · scroll' },
      { c: 'tl-ok', t: 'response ←  200 OK · json · 12 ms' }
    ]
  ];

  var scenarios = (document.body && document.body.dataset.page === 'agent')
    ? agentScenarios
    : defaultScenarios;

  function removeCaret() {
    var caret = termBody.querySelector('.caret-row');
    if (caret) termBody.removeChild(caret);
  }

  function addCaret() {
    var row = document.createElement('span');
    row.className = 'term-line caret-row';
    var caret = document.createElement('span');
    caret.className = 'caret';
    row.appendChild(caret);
    termBody.appendChild(row);
  }

  function addLine(line) {
    var row = document.createElement('span');
    row.className = 'term-line ' + line.c;
    row.textContent = line.t;
    termBody.appendChild(row);
  }

  if (termBody) {
    if (reduceMotion) {
      scenarios[0].forEach(addLine);
      addCaret();
    } else {
      var scenarioIndex = 0;
      var lineIndex = 0;
      var termTimer = null;

      var run = function () {
        removeCaret();
        var lines = scenarios[scenarioIndex];

        if (lineIndex === 0) termBody.textContent = '';
        if (lineIndex < lines.length) {
          addLine(lines[lineIndex]);
          lineIndex++;
          termTimer = window.setTimeout(run, 430);
        } else {
          addCaret();
          termTimer = window.setTimeout(function () {
            scenarioIndex = (scenarioIndex + 1) % scenarios.length;
            lineIndex = 0;
            run();
          }, 3400);
        }
      };

      run();

      document.addEventListener('visibilitychange', function () {
        if (document.hidden) {
          window.clearTimeout(termTimer);
          termTimer = null;
        } else if (!termTimer) {
          run();
        }
      });
    }
  }

  /* ---------- live data ---------- */

  function formatUptime(seconds) {
    if (!seconds || seconds < 1) return '不到 1 分钟';
    if (seconds < 60) return Math.floor(seconds) + ' 秒';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' 分钟';
    if (seconds < 86400) return (seconds / 3600).toFixed(1) + ' 小时';
    return Math.floor(seconds / 86400) + ' 天';
  }

  function loadTunnels() {
    var count = document.getElementById('tunnelCount');
    var countBig = document.getElementById('tunnelCountBig');
    var updated = document.getElementById('tunnelUpdated');
    if (!count && !countBig && !updated) return;

    fetch('/api/tunnels', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        if (!data || typeof data.count !== 'number') throw new Error('bad payload');
        if (count) count.textContent = String(data.count);
        if (countBig) countBig.textContent = String(data.count);

        if (updated) {
          updated.textContent = '更新于 ' + new Date().toLocaleTimeString('zh-CN', {
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          });
        }
      })
      .catch(function () {
        if (updated) updated.textContent = '实时数据不可用';
      });
  }

  function loadStatus() {
    var meta = document.getElementById('siteMeta');
    if (!meta) return;

    fetch('/api/status', { cache: 'no-store', headers: { Accept: 'application/json' } })
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        return response.json();
      })
      .then(function (data) {
        meta.textContent = 'Node ' + data.node + ' · 已运行 ' + formatUptime(data.uptimeSeconds) + ' · 零依赖';
      })
      .catch(function () { /* keep static fallback */ });
  }

  var year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  loadTunnels();
  loadStatus();
})();
