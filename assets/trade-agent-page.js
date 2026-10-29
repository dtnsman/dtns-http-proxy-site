/* trade-agent-page.js — trade-agent.html 页面级逻辑（内联脚本被 CSP 禁止，故外置）
 * 三块按原顺序合并：Token 状态/指标、回应记录、Agent API 隧道与测试 Prompt。
 * 不修改任何既有 .js（agent.js / trade-agent.js / sdk.js 均保持原样）。
 */

/* ===== block 0 ===== */
/* 调用测试：Token 必须由「回答问题」换取，页面不发放、也不允许手工填写。
 *  - /agent/status  公开，永远 200
 *  - 其余四个       未领取 Token 一律 401；领取后才以
 *                   Authorization: Bearer <已领取的 Token> 放行
 * Token 从问答流程的本地状态（dtns.trade-agent.v1）读取。
 */
(function () {
  'use strict';

  var STORE_KEY = 'dtns.trade-agent.v1';

  /* 刷新即作废：Token 只能靠回答问题换取，不允许沿用上一次的。
     这段在解析期执行，早于 trade-agent.js（defer）读取 localStorage，
     所以刷新后第 3 步会显示「—」，必须重新答题才能拿到新 Token。 */
  (function clearPersistedToken() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var saved = JSON.parse(raw);
      if (!saved || !saved.token) return;
      saved.token = null;
      saved.credits = 0;
      saved.calls = 0;
      saved.ledger = [];
      localStorage.setItem(STORE_KEY, JSON.stringify(saved));
    } catch (error) { /* 忽略损坏的本地状态 */ }
  })();

  function readTrade() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function earnedToken() {
    var saved = readTrade();
    return saved && typeof saved.token === 'string' ? saved.token : '';
  }

  function show(payload) {
    var pre = document.getElementById('tradeApiResult');
    if (pre) pre.textContent = JSON.stringify(payload, null, 2);
  }

  function refreshTokenState() {
    var token = earnedToken();
    var el = document.getElementById('agentTokenState');
    if (el) {
      el.textContent = token
        ? '已领取 · ' + token.slice(0, 6) + '…' + token.slice(-4) + '（第 3 步可复制完整值）'
        : '未领取 · 请先在下方回答问题';
    }

    var saved = readTrade() || {};
    var questions = Array.isArray(saved.questions) ? saved.questions.length : 0;
    setStat('statQuestions', questions);
    setStat('statPrice', saved.price);
    setStat('statGrant', saved.grant);
    setStat('statCalls', saved.calls);
  }

  function setStat(id, value) {
    var el = document.getElementById(id);
    if (el && value != null) el.textContent = String(value);
  }

  var CALLS = {
    status:    { method: 'GET',  path: '/status',    auth: false },
    questions: { method: 'GET',  path: '/questions', auth: false },
    page:      { method: 'GET',  path: '/page',      auth: true },
    highlight: { method: 'POST', path: '/highlight', auth: true, body: { selector: '#trade h2' } },
    scroll:    { method: 'POST', path: '/scroll',    auth: true, body: { selector: '#trade' } },
    click:     { method: 'POST', path: '/click',     auth: true, body: { selector: '#tabbtn-client' } }
  };

  function run(name) {
    refreshTokenState();
    var spec = CALLS[name];
    if (!spec) return;

    var base = String((document.getElementById('tradeApiBase') || {}).textContent || '').trim();
    if (!/^https?:\/\//i.test(base)) {
      show({ status: 0, ok: false, error: 'api_not_ready', hint: 'Agent API 还在注册，稍后再试。' });
      return;
    }

    var token = earnedToken();
    var headers = { Accept: 'application/json' };
    if (spec.auth && token) headers.Authorization = 'Bearer ' + token;

    var options = { method: spec.method, cache: 'no-store', headers: headers };
    if (spec.method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(spec.body || {});
    }

    show({
      status: '…',
      ok: null,
      pending: spec.method + ' ' + base + spec.path,
      sentAuthorization: !!headers.Authorization
    });

    fetch(base + spec.path, options).then(function (res) {
      return res.text().then(function (body) {
        var parsed;
        try { parsed = JSON.parse(body); } catch (error) { parsed = body; }
        show({
          status: res.status,
          ok: res.ok,
          sentAuthorization: !!headers.Authorization,
          response: parsed
        });
      });
    }).catch(function (error) {
      show({ status: 0, ok: false, error: String((error && error.message) || error) });
    });
  }

  function bind() {
    refreshTokenState();
    Array.prototype.forEach.call(document.querySelectorAll('[data-api-call]'), function (button) {
      button.addEventListener('click', function () {
        run(button.getAttribute('data-api-call'));
      });
    });
    // 问答流程里「发布 / 提交答案 / 重置」都会改动 Token；
    // 用 setTimeout 延后一拍，等 trade-agent.js 的处理器写完状态再同步文案
    function deferredRefresh() { setTimeout(refreshTokenState, 0); }
    document.addEventListener('click', deferredRefresh, true);
    document.addEventListener('submit', deferredRefresh, true);
    window.addEventListener('storage', function (event) {
      if (event.key === STORE_KEY) refreshTokenState();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();

/* ===== block 1 ===== */
/* 回应记录：让页面用户看到「谁回答了什么、答案是什么、领到哪个 Token」。
 * 答案本身不进入 trade-agent.js 的状态，所以在 submit 的捕获阶段先取走，
 * 等它校验完并发放 Token 之后再一起落盘（没发新 Token 就丢弃，避免记空档）。
 */
(function () {
  'use strict';

  var STATE_KEY = 'dtns.trade-agent.v1';
  var LOG_KEY = 'dtns.trade-agent.responses';

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (error) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (error) { /* 忽略 */ }
  }

  function currentToken() {
    var saved = readJson(STATE_KEY, null);
    return saved && typeof saved.token === 'string' ? saved.token : '';
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function collect() {
    var form = document.getElementById('tradeAnswerForm');
    if (!form) return [];
    var items = [];
    Array.prototype.forEach.call(form.querySelectorAll('input[id^="tradeAns"]'), function (input) {
      var label = form.querySelector('label[for="' + input.id + '"]');
      items.push({
        q: label ? label.textContent.trim() : input.id,
        a: String(input.value || '').trim()
      });
    });
    return items;
  }

  function render() {
    var list = document.getElementById('tradeResponses');
    if (!list) return;
    var logs = readJson(LOG_KEY, []);
    if (!Array.isArray(logs) || !logs.length) {
      list.innerHTML = '<li class="agent-empty">还没有人回答。</li>';
      return;
    }
    list.innerHTML = logs.slice().reverse().map(function (entry) {
      var rows = (entry.items || []).map(function (item) {
        return '<li><p class="trade-response-q">问：' + escapeHtml(item.q) + '</p>' +
               '<p class="trade-response-a">答：' + escapeHtml(item.a) + '</p></li>';
      }).join('');
      return '<li class="trade-response">' +
        '<div class="trade-response-head">' +
          '<span class="trade-ok">已发放</span>' +
          '<code>' + escapeHtml(entry.token) + '</code>' +
          '<span class="trade-time">' + escapeHtml(entry.at) + '</span>' +
        '</div>' +
        '<ul class="trade-response-qa">' + rows + '</ul>' +
      '</li>';
    }).join('');
  }

  function record() {
    var before = currentToken();
    var items = collect();
    if (!items.length) return;

    setTimeout(function () {
      var token = currentToken();
      if (!token || token === before) return;   // 未通过校验 / 没发新 Token
      var logs = readJson(LOG_KEY, []);
      if (!Array.isArray(logs)) logs = [];
      logs.push({
        token: token,
        at: new Date().toLocaleString('zh-CN', { hour12: false }),
        items: items
      });
      if (logs.length > 20) logs = logs.slice(-20);
      writeJson(LOG_KEY, logs);
      render();
    }, 0);
  }

  function bind() {
    render();
    var form = document.getElementById('tradeAnswerForm');
    if (form) form.addEventListener('submit', record, true);

    var reset = document.getElementById('tradeReset');
    if (reset) {
      reset.addEventListener('click', function () {
        setTimeout(function () { writeJson(LOG_KEY, []); render(); }, 0);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();

/* ===== block 2 ===== */
/* Agent 接入：用页面已加载的 sdk.js 另起一条隧道，给 AI Agent 一套可发现的接口。
 *   GET  /            接口清单（公开，便于自动发现）
 *   GET  /questions   读取页面用户发布的问题（公开）
 *   POST /answer      提交答案换取 Token（公开，这是唯一的赚取入口）
 *   GET  /status      运行状态（公开）
 *   GET  /page        ┐
 *   POST /highlight   │ 受保护：必须带 Authorization: Bearer <换来的 Token>
 *   POST /scroll      │ 每次调用按单价扣额度
 *   POST /click       ┘
 * 全部逻辑都在本页内联执行，不修改任何 .js 文件。
 */
(function () {
  'use strict';

  var STATE_KEY = 'dtns.trade-agent.v1';
  var READY_TIMEOUT = 15000;

  var ENDPOINTS = [
    { method: 'GET',  path: '/questions', auth: 'public', desc: '读取题目（含 id / text / 单价 / 额度）' },
    { method: 'POST', path: '/answer',    auth: 'public', desc: '提交答案换取 Token' },
    { method: 'GET',  path: '/status',    auth: 'public', desc: '运行状态与接口清单' },
    { method: 'GET',  path: '/',          auth: 'public', desc: '接口清单（自动发现入口）' },
    { method: 'GET',  path: '/page',      auth: 'token',  desc: '页面标题、滚动位置、章节' },
    { method: 'GET',  path: '/sections',  auth: 'token',  desc: '章节 id / 标题 / 位置' },
    { method: 'GET',  path: '/text',      auth: 'token',  desc: '读取元素文本（?selector=&limit=）' },
    { method: 'POST', path: '/highlight', auth: 'token',  desc: '高亮元素' },
    { method: 'POST', path: '/scroll',    auth: 'token',  desc: '滚动到元素或坐标' },
    { method: 'POST', path: '/click',     auth: 'token',  desc: '点击按钮 / 标签页' },
    { method: 'GET',  path: '/ping',      auth: 'token',  desc: '回显方法、查询与请求头' }
  ];

  function readState() {
    try {
      var raw = localStorage.getItem(STATE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  function currentToken() {
    var saved = readState();
    return saved && typeof saved.token === 'string' ? saved.token : '';
  }

  function bearer(req) {
    var headers = req.headers || {};
    var raw = headers.authorization || headers.Authorization || '';
    var match = /^Bearer\s+(.+)$/i.exec(String(raw));
    return match ? match[1].trim() : '';
  }

  function text(node) {
    var el = document.getElementById(node);
    return el ? String(el.textContent || '').trim() : '';
  }

  function num(node) {
    return Number(text(node)) || 0;
  }

  // 复用第 3 步的计费按钮，保证余额、账本、已调用次数只有一份
  function charge() {
    var price = num('tradePriceView') || 1;
    var credits = num('tradeCredits');
    if (credits < price) return { ok: false, credits: credits, price: price };

    var btn = document.getElementById('tradeCallApi');
    if (btn && !btn.disabled) btn.click();

    return { ok: true, charged: price, creditsLeft: num('tradeCredits') };
  }

  function endpointList() {
    return ENDPOINTS.map(function (item) {
      return { method: item.method, path: item.path, auth: item.auth, desc: item.desc };
    });
  }

  function describe() {
    return {
      ok: true,
      service: 'dtns-trade-agent-api',
      flow: [
        '1) GET /questions 读取题目',
        '2) POST /answer {"answers":["答案1","答案2"]} 换取 Token',
        '3) 带 Authorization: Bearer <Token> 调用 /page /highlight /scroll /click'
      ],
      endpoints: endpointList()
    };
  }

  function requireToken(req, res) {
    var token = bearer(req);
    var expected = currentToken();
    if (!expected) {
      res.status(401).json({
        ok: false,
        error: 'token_required',
        hint: '还没有人领取 Token。先 GET /questions 读题，再 POST /answer 提交答案换取 Token。'
      });
      return false;
    }
    if (token !== expected) {
      res.status(401).json({
        ok: false,
        error: 'unauthorized',
        hint: 'Token 不正确或已失效。用 POST /answer 重新领取，并带上 Authorization: Bearer <Token>。'
      });
      return false;
    }
    return true;
  }

  function issueToken(answers) {
    var saved = readState();
    if (!saved || !saved.published || !Array.isArray(saved.questions) || !saved.questions.length) {
      return { error: 'no_questions', status: 409 };
    }

    var questions = saved.questions;
    var list = [];
    if (Array.isArray(answers)) {
      list = answers.map(function (value) { return String(value == null ? '' : value); });
    } else if (answers && typeof answers === 'object') {
      list = questions.map(function (q) {
        var value = answers[String(q.id)];
        return value == null ? '' : String(value);
      });
    }

    if (list.length !== questions.length) {
      return { error: 'answer_count_mismatch', status: 400, expected: questions.length, got: list.length };
    }
    for (var i = 0; i < list.length; i++) {
      if (!list[i].trim()) return { error: 'empty_answer', status: 400, index: i + 1 };
    }

    var inputs = document.querySelectorAll('input[id^=tradeAns]');
    if (inputs.length !== questions.length) {
      return { error: 'form_not_ready', status: 409, hint: '页面还没渲染作答表单，稍后重试。' };
    }

    var before = currentToken();
    for (var j = 0; j < inputs.length; j++) inputs[j].value = list[j];
    document.getElementById('tradeAnswerForm')
      .dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));

    var after = currentToken();
    if (!after || after === before) {
      return { error: 'not_accepted', status: 400, hint: '提交未通过校验，请检查答案是否全部非空。' };
    }

    var fresh = readState() || {};
    return {
      token: after,
      credits: fresh.credits,
      price: fresh.price,
      answered: list.length
    };
  }

  function safeQuery(selector) {
    try {
      return document.querySelector(selector);
    } catch (error) {
      return null;
    }
  }

  function mount(app) {
    app.get('/', function (req, res) { res.json(describe()); });
    app.get('/help', function (req, res) { res.json(describe()); });

    app.get('/status', function (req, res) {
      var saved = readState() || {};
      res.json({
        ok: true,
        service: 'dtns-trade-agent-api',
        published: !!saved.published,
        questions: Array.isArray(saved.questions) ? saved.questions.length : 0,
        price: saved.price || 0,
        grant: saved.grant || 0,
        credits: num('tradeCredits'),
        calls: num('tradeCallsView'),
        tokenGranted: !!currentToken(),
        endpoints: endpointList()
      });
    });

    app.get('/questions', function (req, res) {
      var saved = readState() || {};
      if (!saved.published || !Array.isArray(saved.questions) || !saved.questions.length) {
        return res.status(409).json({
          ok: false,
          error: 'no_questions',
          hint: '页面用户还没有发布问题，请稍后再试。'
        });
      }
      res.json({
        ok: true,
        published: true,
        price: saved.price,
        grant: saved.grant,
        questions: saved.questions.map(function (q) {
          return { id: q.id, text: q.text };
        }),
        next: 'POST /answer {"answers":["答案1","答案2"]} —— 答案内容不限，全部非空即可'
      });
    });

    app.post('/answer', function (req, res) {
      var body = req.body || {};
      var issued = issueToken(body.answers);
      if (issued.error) {
        var payload = { ok: false, error: issued.error };
        if (issued.expected != null) payload.expected = issued.expected;
        if (issued.got != null) payload.got = issued.got;
        if (issued.index != null) payload.index = issued.index;
        if (issued.hint) payload.hint = issued.hint;
        return res.status(issued.status || 400).json(payload);
      }
      res.json({
        ok: true,
        token: issued.token,
        credits: issued.credits,
        price: issued.price,
        answered: issued.answered,
        next: 'Authorization: Bearer ' + issued.token
      });
    });

    app.get('/page', function (req, res) {
      if (!requireToken(req, res)) return;
      var bill = charge();
      if (!bill.ok) return res.status(402).json({ ok: false, error: 'payment_required', credits: bill.credits, price: bill.price });

      var headings = [];
      Array.prototype.forEach.call(document.querySelectorAll('h1, h2, h3'), function (node) {
        if (headings.length >= 12) return;
        headings.push({ level: Number(node.tagName.charAt(1)), text: String(node.textContent || '').replace(/\s+/g, ' ').trim() });
      });

      res.json({
        ok: true,
        title: document.title,
        url: location.href,
        scroll: { y: Math.round(window.scrollY || 0) },
        headings: headings,
        charged: bill.charged,
        creditsLeft: bill.creditsLeft
      });
    });

    app.get('/sections', function (req, res) {
      if (!requireToken(req, res)) return;
      var bill = charge();
      if (!bill.ok) return res.status(402).json({ ok: false, error: 'payment_required', credits: bill.credits, price: bill.price });

      var sections = [];
      Array.prototype.forEach.call(document.querySelectorAll('section[id]'), function (node) {
        var heading = node.querySelector('h1, h2, h3');
        sections.push({
          id: node.id,
          title: heading ? String(heading.textContent || '').replace(/\s+/g, ' ').trim() : '',
          top: Math.round(node.getBoundingClientRect().top + (window.scrollY || 0))
        });
      });

      res.json({ ok: true, sections: sections, charged: bill.charged, creditsLeft: bill.creditsLeft });
    });

    app.get('/text', function (req, res) {
      if (!requireToken(req, res)) return;
      var query = req.query || {};
      var selector = typeof query.selector === 'string' && query.selector ? query.selector : 'main';
      var limit = parseInt(query.limit, 10);
      if (!isFinite(limit) || limit <= 0) limit = 4000;
      limit = Math.min(limit, 20000);

      var target = safeQuery(selector);
      if (!target) return res.status(404).json({ ok: false, error: 'selector_not_found', selector: selector });

      var bill = charge();
      if (!bill.ok) return res.status(402).json({ ok: false, error: 'payment_required', credits: bill.credits, price: bill.price });

      var raw = String(target.innerText || target.textContent || '').replace(/\s+/g, ' ').trim();
      res.json({
        ok: true,
        selector: selector,
        length: raw.length,
        text: raw.slice(0, limit),
        truncated: raw.length > limit,
        charged: bill.charged,
        creditsLeft: bill.creditsLeft
      });
    });

    app.get('/ping', function (req, res) {
      if (!requireToken(req, res)) return;
      var bill = charge();
      if (!bill.ok) return res.status(402).json({ ok: false, error: 'payment_required', credits: bill.credits, price: bill.price });

      res.json({
        ok: true,
        method: req.method,
        path: req.path,
        query: req.query,
        headers: req.headers,
        charged: bill.charged,
        creditsLeft: bill.creditsLeft
      });
    });

    app.post('/highlight', function (req, res) {
      if (!requireToken(req, res)) return;
      var body = req.body || {};
      var selector = typeof body.selector === 'string' ? body.selector : '#trade h2';
      var target = safeQuery(selector);
      if (!target) return res.status(404).json({ ok: false, error: 'selector_not_found', selector: selector });

      var bill = charge();
      if (!bill.ok) return res.status(402).json({ ok: false, error: 'payment_required', credits: bill.credits, price: bill.price });

      target.classList.add('agent-highlight');
      if (target.scrollIntoView) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(function () { target.classList.remove('agent-highlight'); }, 1800);

      res.json({ ok: true, selector: selector, count: 1, charged: bill.charged, creditsLeft: bill.creditsLeft });
    });

    app.post('/scroll', function (req, res) {
      if (!requireToken(req, res)) return;
      var body = req.body || {};

      var bill = charge();
      if (!bill.ok) return res.status(402).json({ ok: false, error: 'payment_required', credits: bill.credits, price: bill.price });

      if (typeof body.y === 'number') {
        window.scrollTo({ top: body.y, behavior: 'smooth' });
      } else {
        var selector = typeof body.selector === 'string' ? body.selector : '#trade';
        var target = safeQuery(selector);
        if (!target) return res.status(404).json({ ok: false, error: 'selector_not_found', selector: selector });
        target.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }

      res.json({ ok: true, scrollY: Math.round(window.scrollY || 0), charged: bill.charged, creditsLeft: bill.creditsLeft });
    });

    app.post('/click', function (req, res) {
      if (!requireToken(req, res)) return;
      var body = req.body || {};
      var selector = typeof body.selector === 'string' ? body.selector : '#tabbtn-client';
      var target = safeQuery(selector);
      if (!target) return res.status(404).json({ ok: false, error: 'selector_not_found', selector: selector });
      if (!target.matches('button, summary, [role="tab"], .tab, [data-agent-click]')) {
        return res.status(403).json({ ok: false, error: 'unsafe_target', hint: '只允许点击 button / summary / tab。' });
      }

      var bill = charge();
      if (!bill.ok) return res.status(402).json({ ok: false, error: 'payment_required', credits: bill.credits, price: bill.price });

      target.click();
      res.json({ ok: true, selector: selector, charged: bill.charged, creditsLeft: bill.creditsLeft });
    });
  }

  function renderApiUi(base) {
    var baseEl = document.getElementById('tradeApiBase');
    if (baseEl) baseEl.textContent = base;

    var topEl = document.getElementById('tradeApiBaseTop');
    if (topEl) topEl.textContent = base;

    var stateEl = document.getElementById('tradeApiState');
    if (stateEl) stateEl.textContent = '在线 · 可被 Agent 调用';

    var mirrorEl = document.getElementById('tradeApiBaseMirror');
    if (mirrorEl) mirrorEl.textContent = base;

    var listEl = document.getElementById('tradeApiList');
    if (listEl) {
      listEl.innerHTML = ENDPOINTS.map(function (item) {
        return '<li><span class="m">' + item.method + '</span>' +
          '<span class="p">' + item.path + '</span>' +
          '<span class="a">' + (item.auth === 'public' ? '公开' : '需 Token') + '</span></li>';
      }).join('');
    }

    var curlEl = document.getElementById('tradeApiCurl');
    if (curlEl) {
      curlEl.textContent =
        'BASE=' + base + '\n\n' +
        '# 1) 读题\n' +
        'curl -s "$BASE/questions"\n\n' +
        '# 2) 答题换 Token（答案数量必须与题目一致，内容不限）\n' +
        'curl -s -X POST "$BASE/answer" \\\n' +
        '  -H "Content-Type: application/json" \\\n' +
        '  -d \'{"answers":["我是 AlphaBot","会遵守限流"]}\'\n\n' +
        '# 3) 带 Token 调用受保护接口（每次扣一次额度）\n' +
        'curl -s -H "Authorization: Bearer $TOKEN" "$BASE/page"';
    }

    var promptEl = document.getElementById('tradeAgentPrompt');
    if (promptEl) promptEl.textContent = buildPrompt(base);
  }

  function buildPrompt(base) {
    return [
      '你是 AI Agent。任务：使用「交易 Agent」页面提供的 HTTP API，完成一次受保护的页面操作。',
      '',
      'API Base：' + base,
      '',
      '步骤：',
      '1) 读题：GET ' + base + '/questions',
      '   返回 questions[]，每项含 id 与 text。先看清楚一共几道题。',
      '2) 逐题作答：答案需要完成相应的任务后再行作答，且严格作答，否则无法领取token。',
      '3) 换 Token：POST ' + base + '/answer',
      '   Content-Type: application/json',
      '   {"answers": ["第1题答案", "第2题答案"]}',
      '   answers 的顺序必须与 questions 的顺序一致；也可用 {"answers": {"1": "...", "2": "..."}}。',
      '   成功返回 { ok, token, credits, price, answered }，记下 token。',
      '4) 带 Token 调用受保护接口：请求头加 Authorization: Bearer <token>',
      '   GET  ' + base + '/page                               页面标题、滚动位置、章节',
      '   GET  ' + base + '/sections                           章节 id / 标题 / 位置',
      '   GET  ' + base + '/text?selector=%23trade&limit=500   读取某元素文本',
      '   POST ' + base + '/highlight  {"selector":"#trade h2"}',
      '   POST ' + base + '/scroll     {"selector":"#trade"} 或 {"y":1200}',
      '   POST ' + base + '/click      {"selector":"#tabbtn-client"}',
      '5) 计费与错误处理：',
      '   - 每次受保护调用扣 price 点额度，响应里带 charged 与 creditsLeft，请据此汇报剩余额度。',
      '   - 401：没带 Token 或 Token 失效 → 重新执行第 2、3 步领新 Token。',
      '   - 402：额度不足 → 同样重新答题换取额度，不要重试同一个 Token。',
      '   - 不确定有哪些接口时，先 GET ' + base + '/ 或 /status 拿接口清单。',
      '6) 结束时汇报：领取到的 Token（可只给前后各 6 位）、调用过哪些接口、每次的 charged/creditsLeft、最终状态。',
      '',
      '注意：页面必须保持打开，关闭后 API 立即离线；Token 只在页面存活期间有效。',
      '禁止猜测接口路径，所有可用接口以上面清单为准。'
    ].join('\n');
  }

  // agent.js 会反复重绘 Endpoints 卡片，这里在末尾补一条指路说明
  function boot() {
    var stateEl = document.getElementById('tradeApiState');
    try {
      if (!window.DTNSAgent || typeof window.DTNSAgent.app !== 'function') {
        if (stateEl) stateEl.textContent = 'sdk.js 未加载，Agent API 不可用';
        return;
      }

      var hex = '';
      var bytes = new Uint8Array(6);
      (window.crypto || window.msCrypto).getRandomValues(bytes);
      Array.prototype.forEach.call(bytes, function (b) { hex += b.toString(16).padStart(2, '0'); });

      var app = window.DTNSAgent.app({
        domain: 'trade-api-' + hex + '.html.dtns.top',
        description: 'trade-agent question/token API'
      });

      mount(app);

      var copyBtn = document.getElementById('tradeApiCopy');
      if (copyBtn) {
        copyBtn.addEventListener('click', function () {
          var value = text('tradeApiBase');
          if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(value);
        });
      }

      app.listen().then(function () {
        renderApiUi(app.apiBase);
      }).catch(function (error) {
        if (stateEl) stateEl.textContent = '启动失败：' + ((error && error.message) || error);
      });
    } catch (error) {
      if (stateEl) stateEl.textContent = '启动失败：' + ((error && error.message) || error);
    }
  }

  function waitForSdk(started) {
    if (window.DTNSAgent && typeof window.DTNSAgent.app === 'function') { boot(); return; }
    if (Date.now() - started > READY_TIMEOUT) {
      var stateEl = document.getElementById('tradeApiState');
      if (stateEl) stateEl.textContent = 'sdk.js 未加载，Agent API 不可用';
      return;
    }
    setTimeout(function () { waitForSdk(started); }, 120);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { waitForSdk(Date.now()); });
  } else {
    waitForSdk(Date.now());
  }
})();
