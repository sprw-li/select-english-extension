/*
 * SelectEnglish for Browser — background service worker
 * 唯一持有 API Key 的地方：content script 只发送选中文本，拿回结构化结果。
 */
'use strict';

importScripts('lib.js');

var L = self.SELib;

var DEFAULT_SETTINGS = {
  enabled: true,
  trigger: 'button',              // 'button' | 'auto'
  demoMode: false,                // true = 不联网，返回内置示例
  recordHistory: false,           // 默认不记录查询历史（只有主动「收藏」才留内容）
  apiBase: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.3,
  jsonMode: true
};

var CACHE_TTL = 10 * 60 * 1000;
var CACHE_MAX = 60;
var HISTORY_MAX = 300;
var REQUEST_TIMEOUT = 25000;   // 留出余量，避免 MV3 worker 被回收
var cache = new Map();

// 把本地存储设为「只有扩展页面/后台可读」：注入网页的 content script 从此读不到
// storage.local（收藏、历史、Key 全部经由后台消息中转）。Chromium 102+ 支持。
try {
  if (chrome.storage.local.setAccessLevel) {
    chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(function () {});
  }
} catch (e) { /* 旧版本忽略 */ }

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.settings || changes.credentials) {
    cache.clear();   // 改过接口/模型/Key 之后立刻作废旧结果
  }
  if (changes.settings) broadcastSettings(changes.settings.newValue);
});

/** 把（不含密钥的）设置变化推给所有已打开的页面，content script 不再监听 storage */
function broadcastSettings(settings) {
  try {
    chrome.tabs.query({}, function (tabs) {
      var msg = {
        type: 'se-settings-changed',
        settings: {
          enabled: (settings || {}).enabled !== false,
          trigger: (settings || {}).trigger === 'auto' ? 'auto' : 'button'
        }
      };
      (tabs || []).forEach(function (tab) {
        if (!tab || !tab.id) return;
        chrome.tabs.sendMessage(tab.id, msg, function () {
          void chrome.runtime.lastError; // 页面没注入 content script 时忽略
        });
      });
    });
  } catch (e) { /* 忽略 */ }
}

/* ------------------------------------------------------------- 配置读取 */

async function readConfig() {
  var data = await chrome.storage.local.get({ settings: {}, credentials: {} });
  var settings = Object.assign({}, DEFAULT_SETTINGS, data.settings || {});
  var apiKey = (data.credentials && data.credentials.apiKey) || '';
  return { settings: settings, apiKey: String(apiKey).trim() };
}

function joinEndpoint(base) {
  var b = String(base || '').trim();
  if (!b) throw new Error('未配置接口地址');
  if (!/^https?:\/\//i.test(b)) throw new Error('接口地址必须以 http:// 或 https:// 开头');
  b = b.replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(b)) return b;
  if (/\/v\d+$/.test(b)) return b + '/chat/completions';
  return b + '/v1/chat/completions';
}

/** 只有服务端明确说「不支持 response_format 之类」时才降级重试，避免填错地址也白请求一次 */
function looksLikeFormatRejection(status, detail) {
  if (status >= 500) return false;
  return /response_format|json_object|unknown.?field|unsupported.?parameter/i.test(detail || '');
}

/* --------------------------------------------------------------- 请求层 */

function doFetch(url, apiKey, body) {
  var controller = new AbortController();
  var timer = setTimeout(function () { controller.abort(); }, REQUEST_TIMEOUT);
  return fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey
    },
    body: JSON.stringify(body),
    signal: controller.signal
  }).then(function (res) {
    clearTimeout(timer);
    return res;
  }, function (err) {
    clearTimeout(timer);
    if (err && err.name === 'AbortError') throw new Error('请求超时（' + (REQUEST_TIMEOUT / 1000) + ' 秒），请检查网络或接口地址');
    throw new Error('网络请求失败：' + ((err && err.message) || '未知错误'));
  });
}

function contentOf(data) {
  var choice = data && data.choices && data.choices[0];
  var content = choice && choice.message && choice.message.content;
  if (Array.isArray(content)) {
    content = content.map(function (part) {
      if (typeof part === 'string') return part;
      return (part && (part.text || part.content)) || '';
    }).join('');
  }
  if (typeof content !== 'string' || !content.trim()) {
    var reason = choice && choice.finish_reason;
    throw new Error('接口没有返回内容' + (reason ? '（finish_reason: ' + reason + '）' : ''));
  }
  return content;
}

async function callChat(cfg, messages) {
  var url = joinEndpoint(cfg.settings.apiBase);
  var model = String(cfg.settings.model || '').trim();
  if (!model) throw new Error('未配置模型名');
  var body = {
    model: model,
    messages: messages,
    stream: false
  };
  var temperature = Number(cfg.settings.temperature);
  if (isFinite(temperature)) body.temperature = temperature;
  if (cfg.settings.jsonMode) body.response_format = { type: 'json_object' };

  var res = await doFetch(url, cfg.apiKey, body);
  if (!res.ok) {
    var detail = await readDetail(res);
    if (body.response_format && looksLikeFormatRejection(res.status, detail)) {
      // 部分 OpenAI 兼容服务不支持 response_format，自动降级重试一次
      delete body.response_format;
      res = await doFetch(url, cfg.apiKey, body);
      if (!res.ok) throw httpError(res.status, await readDetail(res));
    } else {
      throw httpError(res.status, detail);
    }
  }
  var data;
  try {
    data = await res.json();
  } catch (e) {
    throw new Error('接口返回的不是合法 JSON');
  }
  return contentOf(data);
}

async function readDetail(res) {
  try {
    return (await res.text()).slice(0, 300);
  } catch (e) {
    return '';
  }
}

function httpError(status, detail) {
  // 服务端原文只进控制台，不显示在网页小窗里（可能含内部信息/HTML）
  if (detail) {
    try { console.warn('[SelectEnglish] HTTP ' + status + ':', detail); } catch (e) { /* 忽略 */ }
  }
  if (status === 401 || status === 403) {
    return new Error('鉴权失败（HTTP ' + status + '），请检查 API Key 是否正确');
  }
  return new Error('接口返回 HTTP ' + status + '，请检查接口地址与模型名');
}

/* --------------------------------------------------------------- 业务层 */

function cacheKey(cfg, text, context) {
  return [
    cfg.settings.apiBase,
    cfg.settings.model,
    cfg.settings.temperature,
    cfg.settings.jsonMode ? 'json' : 'text',
    text,
    (context || '').slice(0, 120)
  ].join('|');
}

function rememberCache(key, analysis) {
  cache.set(key, { analysis: analysis, at: Date.now() });
  while (cache.size > CACHE_MAX) {
    cache.delete(cache.keys().next().value);
  }
}

async function handleAnalyze(msg) {
  var text = L.truncate(msg && msg.text, L.MAX_TEXT).trim();
  if (!text) throw new Error('选中内容为空');
  var context = L.truncate(msg && msg.context, L.MAX_CONTEXT).trim();

  var cfg = await readConfig();

  // 演示模式：完全不联网，返回内置示例（没配 Key 的人先看效果）
  if (cfg.settings.demoMode) {
    var demo = L.demoAnalysis(text);
    await recordHistory(cfg, {
      text: text,
      context: context,
      pageTitle: (msg && msg.pageTitle) || '',
      pageUrl: (msg && msg.pageUrl) || ''
    }, demo);
    return { ok: true, analysis: demo, meta: { model: '演示模式', ms: 0, demo: true } };
  }

  if (!cfg.apiKey) throw new Error('未配置 API Key');

  var key = cacheKey(cfg, text, context);
  var hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return { ok: true, analysis: hit.analysis, meta: { model: cfg.settings.model, ms: 0, cached: true } };
  }

  var messages = L.buildMessages({ text: text, context: context, pageTitle: msg && msg.pageTitle });
  var started = Date.now();
  var content = await callChat(cfg, messages);
  var ms = Date.now() - started;

  var parsed = L.extractJson(content);
  var analysis = parsed ? L.normalizeAnalysis(parsed, text) : null;
  var fallback = false;
  if (!analysis || L.isEmptyAnalysis(analysis)) {
    analysis = L.normalizeAnalysis(null, text);
    analysis.raw = String(content).slice(0, 4000);
    fallback = true;
  }

  rememberCache(key, analysis);
  await recordHistory(cfg, {
    text: text,
    context: context,
    pageTitle: (msg && msg.pageTitle) || '',
    pageUrl: (msg && msg.pageUrl) || ''
  }, analysis);
  return { ok: true, analysis: analysis, meta: { model: cfg.settings.model, ms: ms, fallback: fallback } };
}

/* 查询历史：本机留存，可关可清，失败不影响主流程 */
async function recordHistory(cfg, info, analysis) {
  if (cfg.settings.recordHistory === false) return;
  try {
    var data = await chrome.storage.local.get({ history: [] });
    var history = Array.isArray(data.history) ? data.history : [];
    var key = info.text + '|' + (info.context || '').slice(0, 80);
    history = history.filter(function (h) {
      return (h.text + '|' + (h.context || '').slice(0, 80)) !== key;
    });
    history.unshift({
      id: 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
      text: info.text,
      context: info.context || '',
      title: info.pageTitle || '',
      url: info.pageUrl || '',
      analysis: analysis,
      createdAt: new Date().toISOString()
    });
    if (history.length > HISTORY_MAX) history.length = HISTORY_MAX;
    await chrome.storage.local.set({ history: history });
  } catch (e) { /* 忽略 */ }
}

/* 收藏：content script 没有 storage 权限，统一由后台读写 */
function trimFavorites(list) {
  var out = list.slice(0, 300);
  while (out.length > 1 && JSON.stringify(out).length > 4 * 1024 * 1024) out.pop();
  return out;
}

async function handleFavoriteToggle(msg) {
  var data = await chrome.storage.local.get({ favorites: [] });
  var favorites = Array.isArray(data.favorites) ? data.favorites : [];
  var savedId = msg && msg.savedId;

  if (savedId) {
    favorites = favorites.filter(function (f) { return f.id !== savedId; });
    await chrome.storage.local.set({ favorites: trimFavorites(favorites) });
    return { ok: true, savedId: null };
  }

  var payload = (msg && msg.payload) || {};
  if (!payload.text) throw new Error('收藏内容为空');
  var item = {
    id: 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    text: String(payload.text).slice(0, 2000),
    context: String(payload.context || '').slice(0, 4000),
    title: String(payload.title || '').slice(0, 300),
    url: String(payload.url || '').slice(0, 2000),
    analysis: payload.analysis || {},
    createdAt: new Date().toISOString()
  };
  favorites.unshift(item);
  await chrome.storage.local.set({ favorites: trimFavorites(favorites) });
  return { ok: true, savedId: item.id };
}

async function handleTest() {
  var cfg = await readConfig();
  if (cfg.settings.demoMode) {
    return { ok: true, ms: 0, sample: '演示模式：不联网，不会调用任何接口。', model: '演示模式' };
  }
  if (!cfg.apiKey) throw new Error('未配置 API Key');
  var started = Date.now();
  var content = await callChat(cfg, L.buildMessages({
    text: 'persevered',
    context: 'Despite the setback, she persevered and eventually turned the tide in her favor.',
    pageTitle: '连接测试'
  }));
  return {
    ok: true,
    ms: Date.now() - started,
    sample: String(content).slice(0, 400),
    model: cfg.settings.model
  };
}

/* ------------------------------------------------------------- 消息路由 */

chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'se-analyze') {
    handleAnalyze(msg).then(sendResponse, function (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
    return true;
  }

  if (msg.type === 'se-test') {
    handleTest().then(sendResponse, function (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
    return true;
  }

  if (msg.type === 'se-get-settings') {
    // 只返回 UI 需要的开关，绝不把 API Key / 接口配置交给 content script
    readConfig().then(function (cfg) {
      sendResponse({
        ok: true,
        settings: { enabled: cfg.settings.enabled !== false, trigger: cfg.settings.trigger === 'auto' ? 'auto' : 'button' },
        hasKey: !!cfg.apiKey
      });
    }, function (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
    return true;
  }

  if (msg.type === 'se-ui-settings') {
    readConfig().then(function (cfg) {
      sendResponse({
        ok: true,
        settings: { enabled: cfg.settings.enabled !== false, trigger: cfg.settings.trigger === 'auto' ? 'auto' : 'button' }
      });
    }, function (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
    return true;
  }

  if (msg.type === 'se-favorite-toggle') {
    handleFavoriteToggle(msg).then(sendResponse, function (err) {
      sendResponse({ ok: false, error: String((err && err.message) || err) });
    });
    return true;
  }

  if (msg.type === 'se-open-options') {
    chrome.runtime.openOptionsPage();
    sendResponse({ ok: true });
    return true;
  }
});

chrome.action.onClicked.addListener(function () {
  chrome.runtime.openOptionsPage();
});

chrome.runtime.onInstalled.addListener(function (details) {
  if (chrome.contextMenus) {
    chrome.contextMenus.removeAll(function () {
      chrome.contextMenus.create({
        id: 'se-lookup',
        title: '查询选中的英文',
        contexts: ['selection']
      });
    });
  }
  if (details && details.reason === 'install') {
    chrome.runtime.openOptionsPage();
  }
});

if (chrome.contextMenus && chrome.contextMenus.onClicked) {
  chrome.contextMenus.onClicked.addListener(function (info, tab) {
    if (!info || info.menuItemId !== 'se-lookup' || !tab || !tab.id) return;
    chrome.tabs.sendMessage(tab.id, { type: 'se-trigger' }, function () {
      void chrome.runtime.lastError; // 页面未注入 content script 时静默失败
    });
  });
}

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(function (command) {
    if (command !== 'translate-selection') return;
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      var tab = tabs && tabs[0];
      if (!tab || !tab.id) return;
      chrome.tabs.sendMessage(tab.id, { type: 'se-trigger' }, function () {
        void chrome.runtime.lastError; // 页面未注入 content script 时静默失败
      });
    });
  });
}
