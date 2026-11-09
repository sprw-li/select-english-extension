/*
 * SelectEnglish for Browser — content script
 * 划词 → 小圆钮 → 牛皮纸小窗（生词 / 整句解释 / 固定表达）
 *
 * 安全要点：
 *  - UI 全部放在 closed Shadow DOM 里，页面脚本无法读取或改写。
 *  - 模型输出只通过 textContent 写入，绝不使用 innerHTML。
 *  - 本文件永远不读取 API Key（Key 只存在于 background service worker）。
 */
(function () {
  'use strict';
  if (window.__SE_CONTENT__) return;
  window.__SE_CONTENT__ = true;

  var L = window.SELib;
  if (!L) return;

  var DEFAULTS = { enabled: true, trigger: 'button' };
  var MAX_SELECTION = 1200;
  var CACHE_MAX = 40;
  var CACHE_TTL = 10 * 60 * 1000;

  var settings = Object.assign({}, DEFAULTS);
  var host = null;
  var root = null;
  var bubble = null;
  var panel = null;

  var selection = null;   // { text, rect }
  var liveRange = null;   // 面板/圆钮跟随用的 Range
  var seq = 0;            // 请求序号，过期结果直接丢弃
  var panelOpen = false;
  var lastPayload = null; // { text, context } 供重试
  var lastAnalysis = null;
  var savedId = null;     // 当前结果对应的收藏 id
  var rafId = 0;
  var autoTimer = 0;
  var mouseIsDown = false;
  var cache = new Map();  // 选区 key -> { analysis, at }（同一选区复用最近结果）
  var rememberedPos = null; // {left, top} 本会话内记住小窗被拖到哪儿
  var dragState = null;

  /* ---------------------------------------------------------------- 基础 */

  function send(message) {
    return new Promise(function (resolve, reject) {
      try {
        chrome.runtime.sendMessage(message, function (response) {
          var err = chrome.runtime.lastError;
          if (err) reject(new Error(err.message || '扩展已重新加载，请刷新页面'));
          else resolve(response);
        });
      } catch (e) {
        reject(new Error('扩展已重新加载，请刷新页面'));
      }
    });
  }

  function ensureHost() {
    if (host && host.isConnected) return;
    // 宿主被页面脚本连根拔掉（SPA 重建 DOM）时，旧 Shadow DOM 里的引用全部作废
    host = null;
    root = null;
    bubble = null;
    panel = null;
    panelOpen = false;

    host = document.createElement('div');
    host.id = 'select-english-host';
    host.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;z-index:2147483647;';
    root = host.attachShadow({ mode: 'closed' });

    if (typeof CSSStyleSheet === 'function') {
      try {
        var sheet = new CSSStyleSheet();
        sheet.replaceSync(window.SE_STYLES || '');
        root.adoptedStyleSheets = [sheet];
      } catch (e) {
        appendStyleElement();
      }
    } else {
      appendStyleElement();
    }
    root.addEventListener('mousedown', function (e) {
      // 拖动要在 stopPropagation 之前处理（捕获阶段在根上拦事件，内部监听器收不到）
      onPanelMouseDown(e);
      // 按钮类元素吃掉默认行为，避免页面选区被清掉；面板里的文字仍可正常划选
      var target = e.target;
      if (target && target.closest && target.closest('button, a, input')) e.preventDefault();
      e.stopPropagation();
    }, true);

    // 挂在 documentElement 上：body 上有 transform/filter 时 fixed 定位仍相对视口
    (document.documentElement || document.body).appendChild(host);
  }

  function appendStyleElement() {
    var style = document.createElement('style');
    style.textContent = window.SE_STYLES || '';
    root.appendChild(style);
  }

  function isInsideUI(node) {
    if (!host || !node) return false;
    if (node === host) return true;
    return !!(node.getRootNode && node.getRootNode() === root);
  }

  function place(el, rect) {
    var w = el.__seW;
    var h = el.__seH;
    if (!w || !h) {
      el.style.visibility = 'hidden';
      w = el.offsetWidth;
      h = el.offsetHeight;
      el.__seW = w;
      el.__seH = h;
    }
    var vw = window.innerWidth;
    var vh = window.innerHeight;
    var left = rect.left + rect.width / 2 - w / 2;
    left = Math.max(8, Math.min(left, vw - w - 8));
    var top = rect.bottom + 10;
    if (top + h > vh - 8) {
      var above = rect.top - h - 10;
      top = above > 8 ? above : Math.max(8, vh - h - 8);
    }
    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
    el.style.visibility = 'visible';
  }

  /* ------------------------------------------------------------ 选区读取 */

  function readSelection() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
    var range = sel.getRangeAt(0);
    if (isInsideUI(range.startContainer)) return null;
    if (isEditable(range.commonAncestorContainer)) return null;
    var text = sel.toString().replace(/\s+/g, ' ').trim();
    if (!text) return null;
    var rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return null;
    return { text: text.slice(0, MAX_SELECTION), rect: rect, range: range };
  }

  function isEditable(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el && el !== document.body) {
      var tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || el.isContentEditable) return true;
      el = el.parentElement;
    }
    return false;
  }

  function blockOf(node) {
    var el = node && (node.nodeType === 1 ? node : node.parentElement);
    var guard = 0;
    while (el && guard++ < 14) {
      var display = '';
      try { display = getComputedStyle(el).display; } catch (e) { display = ''; }
      if (/^(block|list-item|table-cell|flex|grid|flow-root)$/.test(display)) return el;
      el = el.parentElement;
    }
    return document.body;
  }

  /** 取选区所在句子的上下文，用来让「整句解释」有语境。 */
  function contextFor(range, text) {
    try {
      var el = blockOf(range.commonAncestorContainer);
      var raw = ((el && (el.innerText || el.textContent)) || '').replace(/\s+/g, ' ').trim();
      if (!raw) return '';
      if (raw.length > 1600) raw = raw.slice(0, 1600);
      var needle = text.replace(/\s+/g, ' ');
      var idx = raw.indexOf(needle);
      if (idx < 0) return raw.slice(0, 600);
      var start = Math.max(
        raw.lastIndexOf('. ', idx),
        raw.lastIndexOf('? ', idx),
        raw.lastIndexOf('! ', idx),
        raw.lastIndexOf('; ', idx)
      );
      start = start < 0 ? 0 : start + 2;
      var tail = raw.slice(idx + needle.length);
      var m = tail.match(/[.!?;](\s|$)/);
      var end = m ? idx + needle.length + m.index + 1 : raw.length;
      return raw.slice(start, Math.min(end, start + 900)).trim();
    } catch (e) {
      return '';
    }
  }

  /* -------------------------------------------------------------- 小圆钮 */

  function showBubble(rect) {
    ensureHost();
    if (!bubble) {
      bubble = document.createElement('div');
      bubble.className = 'se-ui se-bubble';
      bubble.textContent = '译';
      bubble.title = '查询选中的英文（Alt+Shift+E）';
      bubble.addEventListener('click', function () {
        if (!selection) return;
        hideBubble();
        analyze(selection.text, selection.context);
      });
      root.appendChild(bubble);
    }
    bubble.style.display = 'flex';
    place(bubble, rect);
  }

  function hideBubble() {
    if (bubble) bubble.style.display = 'none';
  }

  /* ---------------------------------------------------------------- 面板 */

  function closePanel() {
    seq++;
    panelOpen = false;
    liveRange = null;
    stopSpeaking();
    hideBubble();
    if (panel) {
      panel.remove();
      panel = null;
    }
  }

  function newPanel() {
    ensureHost();
    if (panel) panel.remove();
    panel = document.createElement('div');
    panel.className = 'se-ui se-panel';
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', 'SelectEnglish 查询结果');
    panel.addEventListener('click', onPanelClick);
    root.appendChild(panel);
    panelOpen = true;
    return panel;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function buildHead(quote, source) {
    var head = el('div', 'se-head');
    var q = el('div', 'se-quote');
    q.appendChild(el('span', 'se-qtext', '“' + quote + '”'));
    if (source) q.appendChild(el('span', 'se-src', source));
    head.appendChild(q);

    var tools = el('div', 'se-tools');
    tools.appendChild(iconButton('speak', '🔊', '朗读选中内容'));
    tools.appendChild(iconButton('save', '☆', '收藏'));
    tools.appendChild(iconButton('copy', '⧉', '复制'));
    tools.appendChild(iconButton('close', '✕', '关闭（Esc）'));
    head.appendChild(tools);
    return head;
  }

  function iconButton(action, glyph, title) {
    var b = el('button', 'se-icon', glyph);
    b.type = 'button';
    b.setAttribute('data-action', action);
    b.title = title;
    return b;
  }

  function buildFoot(metaText) {
    var foot = el('div', 'se-foot');
    foot.appendChild(el('span', 'se-meta', metaText || ''));
    var btn = el('button', 'se-btn', '设置');
    btn.type = 'button';
    btn.setAttribute('data-action', 'settings');
    foot.appendChild(btn);
    return foot;
  }

  function renderLoading(payload) {
    lastPayload = payload;
    lastAnalysis = null;
    savedId = null;
    var p = newPanel();
    p.appendChild(buildHead(payload.text, document.title));
    var body = el('div', 'se-body');
    var status = el('div', 'se-status');
    var dots = el('span', 'se-dots');
    dots.appendChild(el('i')); dots.appendChild(el('i')); dots.appendChild(el('i'));
    status.appendChild(el('span', null, '正在按「生词 → 整句解释 → 固定表达」分析…'));
    status.appendChild(dots);
    body.appendChild(status);
    p.appendChild(body);
    p.appendChild(buildFoot(''));
    positionPanel(p);
  }

  function renderError(payload, message) {
    lastPayload = payload;
    lastAnalysis = null;
    savedId = null;
    var p = newPanel();
    p.appendChild(buildHead(payload.text, document.title));
    var body = el('div', 'se-body');
    body.appendChild(el('div', 'se-error', message || '请求失败'));
    var actions = el('div', 'se-actions');
    var retry = el('button', 'se-btn', '重试');
    retry.type = 'button';
    retry.setAttribute('data-action', 'retry');
    var opts = el('button', 'se-btn', '打开设置');
    opts.type = 'button';
    opts.setAttribute('data-action', 'settings');
    actions.appendChild(retry);
    actions.appendChild(opts);
    body.appendChild(actions);
    p.appendChild(body);
    p.appendChild(buildFoot(''));
    positionPanel(p);
  }

  function section(label) {
    var sec = el('div', 'se-sec');
    sec.appendChild(el('div', 'se-label', label));
    return sec;
  }

  function renderResult(payload, analysis, meta) {
    lastPayload = payload;
    lastAnalysis = analysis;
    savedId = null;
    var p = newPanel();
    p.appendChild(buildHead(payload.text, document.title));

    var body = el('div', 'se-body');

    var words = section('生词');
    if (analysis.words && analysis.words.length) {
      analysis.words.forEach(function (w) {
        var row = el('div', 'se-word');
        row.appendChild(el('b', null, w.word));
        if (w.pos) row.appendChild(el('span', 'se-pos', w.pos));
        if (w.meaning) row.appendChild(el('span', 'se-meaning', '：' + w.meaning));
        var say = el('span', 'se-say', '🔊');
        say.setAttribute('data-action', 'say-word');
        say.setAttribute('data-word', w.word);
        say.title = '朗读 ' + w.word;
        row.appendChild(say);
        words.appendChild(row);
      });
    } else {
      words.appendChild(el('div', 'se-empty', '本次没有需要单独记的生词。'));
    }
    body.appendChild(words);

    var sentence = section('整句解释');
    var s = analysis.sentence;
    if (s && (s.translation || s.explanation)) {
      sentence.className += ' se-sentence';
      if (s.translation) sentence.appendChild(el('div', 'se-tr', s.translation));
      if (s.explanation) sentence.appendChild(el('div', 'se-ex', s.explanation));
    } else {
      sentence.appendChild(el('div', 'se-empty', '暂无整句解释。'));
    }
    body.appendChild(sentence);

    var phrases = section('固定表达');
    if (analysis.phrases && analysis.phrases.length) {
      analysis.phrases.forEach(function (ph) {
        var row = el('div', 'se-phrase');
        row.appendChild(el('b', null, ph.phrase));
        if (ph.meaning) row.appendChild(document.createTextNode('：' + ph.meaning));
        if (ph.example) row.appendChild(el('div', 'se-ex', '例：' + ph.example));
        phrases.appendChild(row);
      });
    } else {
      phrases.appendChild(el('div', 'se-empty', '本次没有发现固定表达。'));
    }
    body.appendChild(phrases);

    if (analysis.raw) {
      var rawSec = section('解析失败');
      rawSec.appendChild(el('div', 'se-empty', '模型返回的内容格式异常，没能整理成上面的结构。原始内容折叠在下面，可点「重试」。'));
      var wrap = el('details', 'se-rawwrap');
      var summary = el('summary', null, '查看模型原始输出');
      wrap.appendChild(summary);
      wrap.appendChild(el('div', 'se-raw', analysis.raw));
      rawSec.appendChild(wrap);
      body.appendChild(rawSec);
    }

    p.appendChild(body);

    var bits = [];
    if (meta && meta.model) bits.push(meta.model);
    if (meta && typeof meta.ms === 'number') bits.push((meta.ms / 1000).toFixed(1) + 's');
    if (meta && meta.cached) bits.push('缓存');
    p.appendChild(buildFoot(bits.join(' · ')));
    positionPanel(p);
  }

  /* ------------------------------------------------------------ 交互动作 */

  function onPanelClick(e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    var btn = null;
    for (var i = 0; i < path.length; i++) {
      if (path[i] && path[i].getAttribute && path[i].getAttribute('data-action')) {
        btn = path[i];
        break;
      }
    }
    if (!btn) return;
    var action = btn.getAttribute('data-action');

    if (action === 'close') { closePanel(); return; }
    if (action === 'settings') { send({ type: 'se-open-options' }).catch(function () {}); return; }
    if (action === 'retry') { if (lastPayload) analyze(lastPayload.text, lastPayload.context); return; }
    if (action === 'copy') { copyResult(btn); return; }
    if (action === 'save') { toggleSave(btn); return; }
    if (action === 'speak') { speak(lastPayload ? lastPayload.text : '', 0.92); return; }
    if (action === 'say-word') { speak(btn.getAttribute('data-word') || '', 0.95); return; }
  }

  /* ---------------------------------------------------------------- 朗读 */

  function speak(text, rate) {
    text = String(text || '').trim();
    if (!text) return;
    try {
      if (!('speechSynthesis' in window) || typeof window.SpeechSynthesisUtterance !== 'function') return;
      window.speechSynthesis.cancel();
      var u = new window.SpeechSynthesisUtterance(text);
      u.lang = 'en-US';
      u.rate = rate || 0.95;
      var voices = window.speechSynthesis.getVoices ? window.speechSynthesis.getVoices() : [];
      var voice = L.pickVoice(voices);
      if (voice) u.voice = voice;
      window.speechSynthesis.speak(u);
    } catch (e) { /* 朗读不可用时静默 */ }
  }

  function stopSpeaking() {
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch (e) { /* 忽略 */ }
  }

  function copyResult(btn) {
    if (!lastAnalysis) return;
    var text = toClipboardText();
    var done = function () {
      btn.textContent = '✓';
      setTimeout(function () { btn.textContent = '⧉'; }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;left:-9999px;top:0;';
      (document.body || document.documentElement).appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
      done();
    } catch (e) { /* 忽略 */ }
  }

  function toClipboardText() {
    var lines = [];
    var payload = lastPayload || { text: '', context: '' };
    lines.push('原文：' + payload.text);
    if (lastAnalysis) {
      var plain = L.toPlainText(lastAnalysis);
      if (plain) lines.push('', plain);
    }
    lines.push('', '—— 由 SelectEnglish 划词助手整理');
    return lines.join('\n');
  }

  function trimFavorites(list) {
    var out = list.slice(0, 300);
    while (out.length > 1 && JSON.stringify(out).length > 4 * 1024 * 1024) out.pop();
    return out;
  }

  function toggleSave(btn) {
    if (!lastAnalysis || !lastPayload) return;
    var payload = { text: lastPayload.text, context: lastPayload.context };
    var analysis = lastAnalysis;

    var fail = function () {
      btn.textContent = '!';
      btn.title = '收藏失败：存储空间不足，或扩展已重新加载（刷新页面即可）';
      setTimeout(function () { btn.textContent = savedId ? '★' : '☆'; }, 1500);
    };

    var store = function (favorites) {
      return chrome.storage.local.set({ favorites: favorites });
    };

    try {
      chrome.storage.local.get({ favorites: [] }, function (data) {
        if (chrome.runtime.lastError) { fail(); return; }
        var favorites = Array.isArray(data.favorites) ? data.favorites : [];
        if (savedId) {
          favorites = favorites.filter(function (f) { return f.id !== savedId; });
          savedId = null;
          btn.textContent = '☆';
          btn.removeAttribute('data-on');
          store(trimFavorites(favorites));
          return;
        }
        var item = {
          id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
          text: payload.text,
          context: payload.context,
          title: document.title,
          url: location.href,
          analysis: analysis,
          createdAt: new Date().toISOString()
        };
        favorites.unshift(item);
        store(trimFavorites(favorites)).then(function () {
          savedId = item.id;
          btn.textContent = '★';
          btn.setAttribute('data-on', '1');
        }, fail);
      });
    } catch (e) {
      fail();
    }
  }

  function analyze(text, context) {
    if (!text) return;
    var mySeq = ++seq;   // 先占号：缓存命中也要作废在途的旧请求
    var cacheKey = text + '|' + (context || '').slice(0, 80);
    var hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < CACHE_TTL) {
      renderResult({ text: text, context: context || '' }, hit.analysis, { cached: true });
      keepAnchored();
      return;
    }
    if (hit) cache.delete(cacheKey);

    renderLoading({ text: text, context: context || '' });
    keepAnchored();

    send({
      type: 'se-analyze',
      text: text,
      context: context || '',
      pageTitle: document.title,
      pageUrl: location.href
    }).then(function (response) {
      if (mySeq !== seq) return;
      if (response && response.ok) {
        cache.set(cacheKey, { analysis: response.analysis, at: Date.now() });
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        renderResult({ text: text, context: context || '' }, response.analysis, response.meta || {});
      } else {
        var msg = (response && response.error) || '请求失败';
        if (/未配置 API Key|鉴权失败/.test(msg)) msg += '\n请在扩展设置页填写 API Key。';
        renderError({ text: text, context: context || '' }, msg);
      }
      keepAnchored();
    }).catch(function (err) {
      if (mySeq !== seq) return;
      renderError({ text: text, context: context || '' }, String((err && err.message) || err));
      keepAnchored();
    });
  }

  /* ------------------------------------------------------------ 拖动定位 */

  function positionPanel(p) {
    if (rememberedPos &&
        rememberedPos.left < window.innerWidth - 40 &&
        rememberedPos.top < window.innerHeight - 40 &&
        rememberedPos.left > -40 && rememberedPos.top > -40) {
      p.style.left = rememberedPos.left + 'px';
      p.style.top = rememberedPos.top + 'px';
      return;
    }
    place(p, selection ? selection.rect : { left: 20, top: 20, bottom: 20, width: 0, height: 0, right: 20 });
  }

  function onPanelMouseDown(e) {
    if (!panel) return;
    var path = e.composedPath ? e.composedPath() : [e.target];
    var inGrip = false;
    var inControl = false;
    for (var i = 0; i < path.length; i++) {
      var n = path[i];
      if (!n) continue;
      if (n.classList && (n.classList.contains('se-head') || n.classList.contains('se-foot'))) inGrip = true;
      if (n.closest && n.closest('[data-action], a, input, .se-say')) inControl = true;
    }
    if (!inGrip || inControl) return;
    e.preventDefault();
    var rect = panel.getBoundingClientRect();
    dragState = { dx: e.clientX - rect.left, dy: e.clientY - rect.top };
    panel.classList.add('se-dragging');
    window.addEventListener('mousemove', onDragMove, true);
    window.addEventListener('mouseup', onDragEnd, true);
  }

  function onDragMove(e) {
    if (!dragState || !panel) return;
    e.preventDefault();
    var w = panel.offsetWidth || 300;
    var h = panel.offsetHeight || 120;
    var left = Math.max(4, Math.min(e.clientX - dragState.dx, window.innerWidth - w - 4));
    var top = Math.max(4, Math.min(e.clientY - dragState.dy, window.innerHeight - h - 4));
    left = Math.round(left);
    top = Math.round(top);
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    rememberedPos = { left: left, top: top };
  }

  function onDragEnd() {
    dragState = null;
    if (panel) panel.classList.remove('se-dragging');
    window.removeEventListener('mousemove', onDragMove, true);
    window.removeEventListener('mouseup', onDragEnd, true);
  }

  /* ------------------------------------------------------------ 跟随定位 */

  function keepAnchored() {
    if (!panelOpen || !panel) return;
    if (rememberedPos) { positionPanel(panel); return; }
    var rect = liveRect();
    if (rect) place(panel, rect);
  }

  function liveRect() {
    if (liveRange && liveRange.startContainer && liveRange.startContainer.isConnected) {
      try {
        var r = liveRange.getBoundingClientRect();
        if (r && (r.width || r.height)) return r;
      } catch (e) { /* 忽略 */ }
    }
    return selection ? selection.rect : null;
  }

  function onViewportChange() {
    if (rafId) return;
    rafId = window.requestAnimationFrame(function () {
      rafId = 0;
      if (!selection) return;
      var rect = liveRect();
      if (!rect) { closePanel(); return; }
      if (rect.bottom < 0 || rect.top > window.innerHeight) {
        closePanel();
        return;
      }
      if (panelOpen) place(panel, rect);
      if (bubble && bubble.style.display !== 'none') place(bubble, rect);
    });
  }

  /* -------------------------------------------------------------- 事件绑定 */

  function onMouseUp(e) {
    mouseIsDown = false;
    if (!settings.enabled) return;
    if (e.button !== 0) return;
    setTimeout(function () {
      var found = readSelection();
      if (!found) {
        if (!panelOpen) hideBubble();
        return;
      }
      selection = { text: found.text, rect: found.rect };
      liveRange = found.range;
      selection.context = contextFor(found.range, found.text);

      if (settings.trigger === 'auto') {
        clearTimeout(autoTimer);
        autoTimer = setTimeout(function () {
          hideBubble();
          if (selection) analyze(selection.text, selection.context);
        }, 220);
      } else if (!panelOpen) {
        // 面板已经开着时不再弹小圆钮（否则点完圆钮它会立刻又冒出来）
        showBubble(found.rect);
      } else {
        hideBubble();
      }
    }, 0);
  }

  function onMouseDown(e) {
    var path = e.composedPath ? e.composedPath() : [e.target];
    if (host && path.indexOf(host) >= 0) return;
    mouseIsDown = e.button === 0;
    if (panelOpen) closePanel();
    hideBubble();
    selection = null;
    liveRange = null;
  }

  function onKeyDown(e) {
    if (e.key === 'Escape') {
      if (panelOpen) { closePanel(); }
      hideBubble();
    }
  }

  function onSelectionChange() {
    var sel = window.getSelection();
    if (!sel || sel.isCollapsed) {
      if (!panelOpen) hideBubble();
      return;
    }
    // 键盘（Shift+方向键等）做出新选区时没有 mousedown：
    // 旧面板若还展示着上一条结果，立刻关掉并给新选区出圆钮，避免「新查询显示旧内容」
    if (!settings.enabled || !panelOpen || mouseIsDown) return;
    var found = readSelection();
    if (!found) return;
    if (lastPayload && found.text === lastPayload.text) return;
    selection = { text: found.text, rect: found.rect };
    liveRange = found.range;
    selection.context = contextFor(found.range, found.text);
    closePanel();
    if (settings.trigger === 'auto') {
      clearTimeout(autoTimer);
      autoTimer = setTimeout(function () {
        hideBubble();
        if (selection) analyze(selection.text, selection.context);
      }, 220);
    } else {
      showBubble(found.rect);
    }
  }

  /* ---------------------------------------------------------------- 启动 */

  function applySettings(next) {
    if (!next) return;
    var wasEnabled = settings.enabled;
    settings = Object.assign({}, DEFAULTS, next);
    if (wasEnabled && !settings.enabled) {
      closePanel();
      hideBubble();
    }
  }

  function loadSettings() {
    try {
      chrome.storage.local.get({ settings: {} }, function (data) {
        if (chrome.runtime.lastError) return;
        applySettings(data && data.settings);
      });
    } catch (e) { /* 扩展已重新加载，刷新页面即可 */ }
  }

  loadSettings();

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.settings) return;
      applySettings(changes.settings.newValue);
      cache.clear();   // 换了模型/接口后，别再拿旧结果糊弄人
    });
  } catch (e) { /* 忽略 */ }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== 'se-trigger') return;
    if (!settings.enabled) {
      sendResponse({ ok: false, error: '划词查询已停用（可在扩展设置里打开）' });
      return true;
    }
    var found = readSelection();
    if (!found) {
      sendResponse({ ok: false, error: '请先选中一段英文' });
      return true;
    }
    selection = { text: found.text, rect: found.rect };
    liveRange = found.range;
    selection.context = contextFor(found.range, found.text);
    hideBubble();
    analyze(found.text, selection.context);
    sendResponse({ ok: true });
    return true;
  });

  document.addEventListener('mouseup', onMouseUp, true);
  document.addEventListener('mousedown', onMouseDown, true);
  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('selectionchange', onSelectionChange, true);
  window.addEventListener('keydown', onKeyDown, true);   // 页面在 capture 里 stopPropagation 也能关掉
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange, true);
})();
