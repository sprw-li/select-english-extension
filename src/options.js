/*
 * SelectEnglish for Browser — 设置页 / 收藏页
 */
'use strict';

var DEFAULTS = {
  enabled: true,
  trigger: 'button',
  recordHistory: true,
  demoMode: false,
  apiBase: 'https://api.deepseek.com/v1',
  model: 'deepseek-chat',
  temperature: 0.3,
  jsonMode: true
};

var $ = function (id) { return document.getElementById(id); };

var booted = false;   // 设置读完之前，任何保存动作都可能把已存的 Key 覆盖成空

function setStatus(text, kind) {
  var el = $('status');
  el.textContent = text || '';
  el.className = 'status' + (kind ? ' ' + kind : '');
}

function requireBooted() {
  if (booted) return true;
  setStatus('正在读取已保存的设置，请稍候再操作…', 'err');
  return false;
}

function send(message) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(message, function (response) {
      var err = chrome.runtime.lastError;
      if (err) reject(new Error(err.message || '后台未响应'));
      else resolve(response);
    });
  });
}

/* --------------------------------------------------------------- 设置页 */

async function loadSettings() {
  var data = await chrome.storage.local.get({ settings: {}, credentials: {} });
  var s = Object.assign({}, DEFAULTS, data.settings || {});
  $('enabled').checked = s.enabled !== false;
  $('trigger').value = s.trigger === 'auto' ? 'auto' : 'button';
  $('recordHistory').checked = s.recordHistory !== false;
  $('demoMode').checked = s.demoMode === true;
  $('apiBase').value = s.apiBase || DEFAULTS.apiBase;
  $('model').value = s.model || DEFAULTS.model;
  $('temperature').value = s.temperature;
  $('jsonMode').checked = s.jsonMode !== false;
  $('apiKey').value = (data.credentials && data.credentials.apiKey) || '';
}

function collectSettings() {
  var raw = $('temperature').value.trim();
  var temperature = raw === '' ? DEFAULTS.temperature : Number(raw);
  if (!isFinite(temperature)) temperature = DEFAULTS.temperature;
  temperature = Math.min(2, Math.max(0, temperature));
  return {
    enabled: $('enabled').checked,
    trigger: $('trigger').value,
    recordHistory: $('recordHistory').checked,
    demoMode: $('demoMode').checked,
    apiBase: $('apiBase').value.trim() || DEFAULTS.apiBase,
    model: $('model').value.trim() || DEFAULTS.model,
    temperature: temperature,
    jsonMode: $('jsonMode').checked
  };
}

async function saveSettings() {
  var settings = collectSettings();
  var apiKey = $('apiKey').value.trim();
  await chrome.storage.local.set({ settings: settings, credentials: { apiKey: apiKey } });
  return settings;
}

/* --------------------------------------------------------------- 收藏页 */

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function section(label) {
  var sec = el('div', 'sec');
  sec.appendChild(el('div', 'lab', label));
  return sec;
}

function renderEntry(item, collection) {
  var box = el('div', 'fav');
  var a = item.analysis || {};

  box.appendChild(el('div', 'q', '“' + (item.text || '') + '”'));

  var body = el('div', 'body');

  var words = section('生词');
  if (a.words && a.words.length) {
    a.words.forEach(function (w) {
      var row = el('div');
      row.appendChild(el('b', null, w.word));
      if (w.pos) row.appendChild(el('span', 'pos', w.pos));
      if (w.meaning) row.appendChild(document.createTextNode(w.meaning));
      words.appendChild(row);
    });
  } else {
    words.appendChild(el('div', 'empty', '无'));
  }
  body.appendChild(words);

  var sent = section('整句解释');
  if (a.sentence && (a.sentence.translation || a.sentence.explanation)) {
    if (a.sentence.translation) sent.appendChild(el('div', null, a.sentence.translation));
    if (a.sentence.explanation) sent.appendChild(el('div', 'ex', a.sentence.explanation));
  } else {
    sent.appendChild(el('div', 'empty', '无'));
  }
  body.appendChild(sent);

  var ph = section('固定表达');
  if (a.phrases && a.phrases.length) {
    a.phrases.forEach(function (p) {
      var row = el('div');
      row.appendChild(el('b', null, p.phrase));
      if (p.meaning) row.appendChild(document.createTextNode('：' + p.meaning));
      if (p.example) row.appendChild(el('div', 'ex', '例：' + p.example));
      ph.appendChild(row);
    });
  } else {
    ph.appendChild(el('div', 'empty', '无'));
  }
  body.appendChild(ph);
  box.appendChild(body);

  var meta = el('div', 'meta');
  var when = item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN') : '';
  meta.appendChild(el('span', null, when));
  if (item.url) {
    var link = document.createElement('a');
    link.href = item.url;
    link.target = '_blank';
    link.rel = 'noreferrer';
    link.textContent = item.title || item.url;
    meta.appendChild(link);
  }
  var del = el('button', 'del', '删除');
  del.type = 'button';
  del.addEventListener('click', function () {
    removeEntry(collection, item.id);
  });
  meta.appendChild(del);
  box.appendChild(meta);

  return box;
}

async function readCollection(name) {
  var defaults = {};
  defaults[name] = [];
  var data = await chrome.storage.local.get(defaults);
  return Array.isArray(data[name]) ? data[name] : [];
}

function renderList(name, listId, countId, emptyText, countText) {
  return readCollection(name).then(function (list) {
    var box = $(listId);
    box.textContent = '';
    $(countId).textContent = '共 ' + list.length + ' 条' + countText;
    if (!list.length) {
      box.appendChild(el('div', 'empty', emptyText));
      return;
    }
    list.forEach(function (item) { box.appendChild(renderEntry(item, name)); });
  });
}

function renderFavorites() {
  return renderList('favorites', 'favList', 'favCount',
    '还没有收藏。选中英文查询后，点小窗右上角的 ☆ 保存。', '收藏（存在本机）');
}

function renderHistory() {
  return renderList('history', 'hisList', 'hisCount',
    '还没有查询历史。在设置里打开「记录查询历史」后，每次查询都会自动留在这里。', '历史（存在本机，最多 300 条）');
}

async function removeEntry(collection, id) {
  var list = await readCollection(collection);
  list = list.filter(function (f) { return f.id !== id; });
  var update = {};
  update[collection] = list;
  await chrome.storage.local.set(update);
  if (collection === 'favorites') renderFavorites();
  else renderHistory();
}

async function clearCollection(collection, label) {
  if (!confirm('确定清空全部' + label + '？此操作不可撤销。')) return;
  var update = {};
  update[collection] = [];
  await chrome.storage.local.set(update);
  if (collection === 'favorites') renderFavorites();
  else renderHistory();
}

function download(filename, content, mime) {
  var blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
  var url = URL.createObjectURL(blob);
  var a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

async function exportCollection(collection, format) {
  var list = await readCollection(collection);
  var base = 'selectenglish-' + collection + '-' + today();
  if (format === 'json') {
    download(base + '.json', JSON.stringify(list, null, 2), 'application/json');
  } else if (format === 'anki') {
    // Anki 导入：文件类型选 CSV，勾选「允许在字段中使用 HTML」
    download(base + '-anki.csv', '\uFEFF' + window.SELib.toAnkiCsv(list), 'text/csv;charset=utf-8');
  } else if (format === 'md') {
    download(base + '.md', window.SELib.toMarkdown(list), 'text/markdown;charset=utf-8');
  }
}

/* ----------------------------------------------------------------- 标签 */

function switchTab(name) {
  ['settings', 'favorites', 'history', 'about'].forEach(function (key) {
    $('pane-' + key).hidden = key !== name;
  });
  Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
    tab.setAttribute('aria-selected', String(tab.getAttribute('data-tab') === name));
  });
  if (name === 'favorites') renderFavorites();
  if (name === 'history') renderHistory();
}

/* ----------------------------------------------------------------- 绑定 */

$('save').addEventListener('click', async function () {
  if (!requireBooted()) return;
  setStatus('保存中…');
  try {
    await saveSettings();
    setStatus('已保存，立即生效（已打开的页面无需刷新）。', 'ok');
  } catch (e) {
    setStatus('保存失败：' + e.message, 'err');
  }
});

$('test').addEventListener('click', async function () {
  if (!requireBooted()) return;
  setStatus('测试中…');
  try {
    await saveSettings();
    var res = await send({ type: 'se-test' });
    if (res && res.ok) setStatus('连接成功（' + res.model + '，' + res.ms + 'ms）\n示例输出：' + res.sample, 'ok');
    else setStatus('连接失败：' + ((res && res.error) || '未知错误'), 'err');
  } catch (e) {
    setStatus('连接失败：' + e.message, 'err');
  }
});

$('reset').addEventListener('click', async function () {
  if (!requireBooted()) return;
  $('enabled').checked = DEFAULTS.enabled;
  $('trigger').value = DEFAULTS.trigger;
  $('recordHistory').checked = DEFAULTS.recordHistory;
  $('demoMode').checked = DEFAULTS.demoMode;
  $('apiBase').value = DEFAULTS.apiBase;
  $('model').value = DEFAULTS.model;
  $('temperature').value = DEFAULTS.temperature;
  $('jsonMode').checked = DEFAULTS.jsonMode;
  try {
    await saveSettings();
    setStatus('已恢复默认（API Key 保留）。', 'ok');
  } catch (e) {
    setStatus('恢复默认失败：' + e.message, 'err');
  }
});

$('export').addEventListener('click', function () { exportCollection('favorites', 'json'); });
$('exportAnki').addEventListener('click', function () { exportCollection('favorites', 'anki'); });
$('exportMd').addEventListener('click', function () { exportCollection('favorites', 'md'); });
$('clear').addEventListener('click', function () { clearCollection('favorites', '收藏'); });
$('exportHisAnki').addEventListener('click', function () { exportCollection('history', 'anki'); });
$('exportHisMd').addEventListener('click', function () { exportCollection('history', 'md'); });
$('clearHis').addEventListener('click', function () { clearCollection('history', '历史'); });

Array.prototype.forEach.call(document.querySelectorAll('.tab'), function (tab) {
  tab.addEventListener('click', function () { switchTab(tab.getAttribute('data-tab')); });
});

loadSettings()
  .then(function () { switchTab('settings'); })
  .catch(function (e) { setStatus('读取设置失败：' + (e && e.message || e), 'err'); })
  .finally(function () {
    booted = true;
    ['save', 'test', 'reset'].forEach(function (id) { $(id).disabled = false; });
  });
