/* trade-agent.js — 问题设置 → API 方作答 → 发放 Token/额度 → 计费调用
 *
 * 规则（与页面说明一致）：
 *  - 页面用户（OWNER）只设置问题、单次单价、通过问答发放的额度，不设置标准答案。
 *  - API 调用方（CLIENT）只要提交了全部问题的答案（非空），即视为通过，
 *    发放 Token 与额度；答案内容由大语言模型或人工填写，不做正确性校验。
 *  - 除 status 这个普通接口外，页面上的所有 API 调用都必须携带有效 Token：
 *    无 Token → 401；Token 无效/过期 → 401；额度不足 → 402；成功 → 200 并扣费。
 */
(function () {
  'use strict';

  const STORE_KEY = 'dtns.trade-agent.v1';
  const $ = (id) => document.getElementById(id);

  const state = {
    questions: [],   // [{ id, text }]
    price: 1,        // 每次调用消耗的额度
    grant: 20,       // 作答通过后发放的额度
    token: null,
    credits: 0,
    calls: 0,
    published: false,
    ledger: []       // 最近的调用记录
  };

  // 普通状态接口：唯一不需要 Token 的页面 API
  const PUBLIC_PATHS = ['/api/status'];

  function load() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (saved && typeof saved === 'object') Object.assign(state, saved);
      if (!Array.isArray(state.questions)) state.questions = [];
      if (!Array.isArray(state.ledger)) state.ledger = [];
      // 兼容旧数据：去掉历史遗留的 answer 字段
      state.questions = state.questions.map((q, i) => ({
        id: q && q.id != null ? q.id : i + 1,
        text: String((q && q.text) || '')
      }));
    } catch (_) { /* 忽略损坏的本地状态 */ }
  }

  function save() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (_) { /* 配额已满 */ }
  }

  function randomToken() {
    const bytes = new Uint8Array(24);
    (window.crypto || window.msCrypto).getRandomValues(bytes);
    return 'tk_' + Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  function normalise(text) {
    return String(text == null ? '' : text).trim().replace(/\s+/g, ' ');
  }

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }

  function log(message) {
    const el = $('tradeResult');
    if (!el) return;
    el.textContent = typeof message === 'string' ? message : JSON.stringify(message, null, 2);
  }

  // 表单校验失败时给出醒目、可见的反馈（日志区在页面下方，用户常常看不到）
  function notifySetupError(message) {
    log(message);
    const el = $('tradeResult');
    if (el) {
      el.classList.add('trade-error');
      try { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch (_) { }
      clearTimeout(notifySetupError._t);
      notifySetupError._t = setTimeout(() => el.classList.remove('trade-error'), 4000);
    }
  }

  /* ---------------- 渲染 ---------------- */

  function renderOwner() {
    const box = $('tradeOwnerState');
    if (!box) return;
    if (!state.published) {
      box.innerHTML = '<p class="agent-empty">尚未发布问题。</p>';
      return;
    }
    box.innerHTML =
      '<p class="agent-hint">已发布 <b>' + state.questions.length + '</b> 个问题 · ' +
      '单价 <b>' + state.price + '</b> · 作答通过发放额度 <b>' + state.grant + '</b></p>' +
      '<p class="agent-hint">问题不设标准答案：调用方提交任意非空答案即视为通过并发放 Token。</p>';
  }

  function renderAnswerForm() {
    const form = $('tradeAnswerForm');
    const hint = $('tradeAnswerHint');
    if (!form) return;

    if (!state.published) {
      form.innerHTML = '';
      if (hint) hint.textContent = '等待页面用户发布问题…';
      return;
    }

    form.innerHTML = state.questions
      .map((q, i) =>
        '<div class="trade-field">' +
          '<label for="tradeAns' + i + '">' + escapeHtml(q.text) + '</label>' +
          '<input id="tradeAns' + i + '" name="ans' + i + '" type="text" autocomplete="off" ' +
            'spellcheck="false" placeholder="你的回答">' +
        '</div>'
      )
      .join('') +
      '<button class="btn btn-primary agent-btn" type="submit">提交回答并领取 Token</button>';

    if (hint) {
      hint.textContent = state.token
        ? '已持有 Token。额度用尽后可重新作答领取新的额度。'
        : '提交全部问题的答案（内容不限，非空即可）就会发放 Token 与计费额度。';
    }
  }

  function renderWallet() {
    const tokenEl = $('tradeToken');
    if (tokenEl) tokenEl.textContent = state.token || '—';

    const creditsEl = $('tradeCredits');
    if (creditsEl) creditsEl.textContent = String(state.credits);

    const priceEl = $('tradePriceView');
    if (priceEl) priceEl.textContent = String(state.price);

    const callsEl = $('tradeCallsView');
    if (callsEl) callsEl.textContent = String(state.calls);

    const callBtn = $('tradeCallApi');
    if (callBtn) callBtn.disabled = !(state.token && state.credits >= state.price);

    const copyBtn = $('tradeCopyToken');
    if (copyBtn) copyBtn.disabled = !state.token;

    const ledgerEl = $('tradeLedger');
    if (ledgerEl) {
      ledgerEl.innerHTML = state.ledger.length
        ? state.ledger.slice().reverse().map((row) =>
            '<li><span class="trade-ok">' + row.status + '</span> ' +
            '<code>' + escapeHtml(row.path) + '</code> ' +
            '扣费 ' + row.cost + ' · 余额 ' + row.left +
            '<span class="trade-time">' + escapeHtml(row.time) + '</span></li>'
          ).join('')
        : '<li class="agent-empty">还没有调用记录。</li>';
    }
  }

  function renderAll() {
    renderOwner();
    renderAnswerForm();
    renderWallet();
  }

  /* ---------------- OWNER：设置问题 ---------------- */

  function bindSetupForm() {
    const form = $('tradeSetupForm');
    if (!form) return;

    if (state.published) {
      const qEl = $('tradeQuestions');
      const pEl = $('tradePrice');
      const gEl = $('tradeGrant');
      if (qEl) qEl.value = state.questions.map((q) => q.text).join('\n');
      if (pEl) pEl.value = state.price;
      if (gEl) gEl.value = state.grant;
    }

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();

      // 每行一个问题，不再需要 "|| 正确答案"
      const lines = String(($('tradeQuestions') || {}).value || '')
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean);

      if (lines.length === 0) {
        notifySetupError('请至少设置一个问题。每行一个，不需要填写标准答案。');
        return;
      }

      const questions = [];
      for (let i = 0; i < lines.length; i++) {
        // 兼容老格式：如果仍写了 "问题 || 答案"，只取问题部分
        const text = lines[i].split('||')[0].trim();
        if (!text) continue;
        questions.push({ id: i + 1, text: text });
      }

      if (questions.length === 0) {
        notifySetupError('问题内容不能为空。');
        return;
      }

      const price = Math.max(1, parseInt(($('tradePrice') || {}).value, 10) || 1);
      const grant = Math.max(price, parseInt(($('tradeGrant') || {}).value, 10) || price);

      state.questions = questions;
      state.price = price;
      state.grant = grant;
      state.published = true;
      // 重新发布会让旧 Token 与额度失效，必须重新作答
      state.token = null;
      state.credits = 0;
      state.calls = 0;
      state.ledger = [];
      save();
      renderAll();
      log('已发布 ' + questions.length + ' 个问题：单价 ' + price +
          '，作答通过发放额度 ' + grant + '。API 调用方现在可以作答领取 Token。');
    });
  }

  /* ---------------- CLIENT：作答领 Token ---------------- */

  function bindAnswerForm() {
    const form = $('tradeAnswerForm');
    if (!form) return;

    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      if (!state.published) return;

      // 只要求提交了答案，不校验内容是否正确
      const missing = [];
      state.questions.forEach((q, i) => {
        const input = $('tradeAns' + i);
        const given = input ? input.value : '';
        if (!normalise(given)) missing.push(i + 1);
      });

      if (missing.length) {
        log('还有问题未作答：第 ' + missing.join('、') + ' 题。请填写答案（内容不限）后再提交。');
        return;
      }

      state.token = randomToken();
      state.credits = state.grant;
      save();
      renderAll();

      const ansForm = $('tradeAnswerForm');
      if (ansForm) ansForm.reset();
      renderAnswerForm();
      renderWallet();
      log('回答已提交。已发放 Token：' + state.token + '\n额度：' + state.credits +
          '，单价：' + state.price + '。现在可以持 Token 调用 API。');
    });
  }

  /* ---------------- 计费调用 ---------------- */

  function bindCallApi() {
    const btn = $('tradeCallApi');
    if (!btn) return;

    btn.addEventListener('click', () => {
      // 不持 Token → 401
      if (!state.token) {
        log('HTTP 401 Unauthorized\n缺少 Token，请先回答页面用户发布的问题领取 Token。');
        return;
      }

      // 持 Token 但额度不足 → 402
      if (state.credits < state.price) {
        log('HTTP 402 Payment Required\n额度不足：剩余 ' + state.credits +
            '，单价 ' + state.price + '。请重新作答领取额度。');
        return;
      }

      // 有 Token 且额度充足 → 200 并扣费
      state.credits -= state.price;
      state.calls += 1;

      const now = new Date();
      const time = now.toTimeString().slice(0, 8);
      state.ledger.push({
        path: '/api/v1/echo',
        status: '200',
        cost: state.price,
        left: state.credits,
        time: time
      });
      if (state.ledger.length > 20) state.ledger = state.ledger.slice(-20);

      save();
      renderWallet();

      log('HTTP 200 OK\n{\n  "ok": true,\n  "token": "' + state.token + '",\n' +
          '  "charged": ' + state.price + ',\n  "creditsLeft": ' + state.credits + ',\n' +
          '  "calls": ' + state.calls + '\n}');
    });
  }

  function bindStatusApi() {
    const btn = $('tradeStatusApi');
    if (!btn) return;
    btn.addEventListener('click', () => {
      // 普通状态接口：唯一不需要 Token 的页面 API
      log('HTTP 200 OK\n{\n  "ok": true,\n  "service": "trade-agent",\n' +
          '  "published": ' + (state.published ? 'true' : 'false') + ',\n' +
          '  "questions": ' + state.questions.length + ',\n' +
          '  "price": ' + state.price + ',\n' +
          '  "publicPath": "' + PUBLIC_PATHS[0] + '"\n}');
    });
  }

  /* ---------------- 其余调用测试：一律强制 Token ---------------- */

  // 统一校验：无 Token → 401；额度不足 → 402；通过返回 true
  function requireTokenOrReport() {
    if (!state.token) {
      log('HTTP 401 Unauthorized\n缺少 Token，请先回答页面用户发布的问题领取 Token。');
      return false;
    }
    if (state.credits < state.price) {
      log('HTTP 402 Payment Required\n额度不足：剩余 ' + state.credits +
          '，单价 ' + state.price + '。请重新作答领取额度。');
      return false;
    }
    return true;
  }

  function chargeCall(path, payloadText) {
    state.credits -= state.price;
    state.calls += 1;
    const time = new Date().toTimeString().slice(0, 8);
    state.ledger.push({ path: path, status: '200', cost: state.price, left: state.credits, time: time });
    if (state.ledger.length > 20) state.ledger = state.ledger.slice(-20);
    save();
    renderWallet();
    log('HTTP 200 OK\n' + payloadText());
  }

  const TOKEN_TEST_ACTIONS = {
    page: function () {
      if (!requireTokenOrReport()) return;
      chargeCall('/api/v1/page', function () { return '{\n  "ok": true,\n  "page": "' + (document.title || 'trade-agent') + '",\n' +
        '  "url": "' + location.pathname + '",\n  "charged": ' + state.price + ',\n' +
        '  "creditsLeft": ' + state.credits + '\n}'; });
    },
    highlight: function () {
      if (!requireTokenOrReport()) return;
      chargeCall('/api/v1/highlight', () => '{\n  "ok": true,\n  "highlighted": ["#tradeOwnerState", "#tradeAnswerForm"],\n' +
        '  "charged": ' + state.price + ',\n  "creditsLeft": ' + state.credits + '\n}');
    },
    scroll: function () {
      if (!requireTokenOrReport()) return;
      chargeCall('/api/v1/scroll', () => '{\n  "ok": true,\n  "scrolledTo": "#tradeResult",\n' +
        '  "charged": ' + state.price + ',\n  "creditsLeft": ' + state.credits + '\n}');
    },
    click: function () {
      if (!requireTokenOrReport()) return;
      chargeCall('/api/v1/click', () => '{\n  "ok": true,\n  "clicked": "tab",\n' +
        '  "charged": ' + state.price + ',\n  "creditsLeft": ' + state.credits + '\n}');
    }
  };

  function bindTokenTests() {
    const buttons = document.querySelectorAll('[data-trade-test]');
    Array.prototype.forEach.call(buttons, function (button) {
      button.addEventListener('click', function () {
        const action = button.getAttribute('data-trade-test');
        const fn = TOKEN_TEST_ACTIONS[action];
        if (fn) fn();
      });
    });
  }

  function bindCopyToken() {
    const btn = $('tradeCopyToken');
    if (!btn) return;
    btn.addEventListener('click', () => {
      if (!state.token) return;
      const done = () => log('Token 已复制到剪贴板。');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(state.token).then(done, () => {
          log('复制失败，请手动选中 Token 复制。');
        });
      } else {
        log('当前浏览器不支持自动复制，请手动选中 Token 复制。');
      }
    });
  }

  function bindReset() {
    const btn = $('tradeReset');
    if (!btn) return;
    btn.addEventListener('click', () => {
      state.questions = [];
      state.price = 1;
      state.grant = 20;
      state.token = null;
      state.credits = 0;
      state.calls = 0;
      state.published = false;
      state.ledger = [];
      save();
      const qEl = $('tradeQuestions');
      if (qEl) qEl.value = '';
      renderAll();
      log('已重置：问题、Token 与额度全部清空。');
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    load();
    bindSetupForm();
    bindAnswerForm();
    bindCallApi();
    bindStatusApi();
    bindCopyToken();
    bindTokenTests();
    bindReset();
    renderAll();
  });
})();
