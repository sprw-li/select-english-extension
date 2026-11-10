/*
 * SelectEnglish — 工具栏弹窗
 * 快速查看状态、开关功能、给当前网站一键停用。
 */
'use strict';

var DEFAULTS = {
  enabled: true,
  trigger: 'button',
  demoMode: false,
  recordHistory: false,
  disabledSites: []
};

var state = {
  settings: Object.assign({}, DEFAULTS),
  hasKey: false,
  host: '',
  favorites: 0,
  history: 0
};

function $(id) { return document.getElementById(id); }

function hostnameOf(url) {
  try {
    var u = new URL(String(url || ''));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname || '';
  } catch (e) {
    return '';
  }
}

function queryTab() {
  return new Promise(function (resolve) {
    try {
      chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        resolve((tabs && tabs[0]) || null);
      });
    } catch (e) {
      resolve(null);
    }
  });
}

async function load() {
  var data = await chrome.storage.local.get({ settings: {}, credentials: {}, favorites: [], history: [] });
  var settings = Object.assign({}, DEFAULTS, data.settings || {});
  if (!Array.isArray(settings.disabledSites)) settings.disabledSites = [];
  var tab = await queryTab();
  state = {
    settings: settings,
    hasKey: !!(data.credentials && data.credentials.apiKey),
    host: hostnameOf(tab && tab.url),
    favorites: (data.favorites || []).length,
    history: (data.history || []).length
  };
  render();
}

function render() {
  var s = state.settings;

  var manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : { version: '' };
  $('version').textContent = 'v' + (manifest.version || '');

  var dot = $('dot');
  var text = $('statusText');
  if (!s.enabled) {
    dot.className = 'dot off';
    text.textContent = '划词已停用';
  } else if (s.demoMode) {
    dot.className = 'dot warn';
    text.textContent = '演示模式：不联网，返回内置示例';
  } else if (state.hasKey) {
    dot.className = 'dot ok';
    text.textContent = '已配置 API Key';
  } else {
    dot.className = 'dot warn';
    text.textContent = '未配置 API Key，可在设置页填写或先用演示模式';
  }

  $('enabled').checked = s.enabled !== false;
  $('demoMode').checked = !!s.demoMode;
  $('recordHistory').checked = s.recordHistory === true;

  $('host').textContent = state.host || '';
  $('siteDisabled').checked = !!state.host && s.disabledSites.indexOf(state.host) >= 0;
  $('siteDisabled').disabled = !state.host;
  if (!state.host) $('host').textContent = '当前页面不支持按站点停用';

  $('favCount').textContent = String(state.favorites);
  $('hisCount').textContent = String(state.history);
}

async function persist() {
  await chrome.storage.local.set({ settings: state.settings });
}

function toggleSite(enabled) {
  var host = state.host;
  if (!host) return;
  var sites = state.settings.disabledSites.filter(function (h) { return h !== host; });
  if (enabled) sites.push(host);
  state.settings.disabledSites = sites;
}

function openOptions(tab) {
  var base = chrome.runtime.getURL('src/options.html');
  if (tab) chrome.tabs.create({ url: base + '#' + tab });
  else chrome.runtime.openOptionsPage();
}

function bind() {
  $('enabled').addEventListener('change', function (e) {
    state.settings.enabled = e.target.checked;
    persist().then(render, render);
  });
  $('demoMode').addEventListener('change', function (e) {
    state.settings.demoMode = e.target.checked;
    persist().then(render, render);
  });
  $('recordHistory').addEventListener('change', function (e) {
    state.settings.recordHistory = e.target.checked;
    persist().then(render, render);
  });
  $('siteDisabled').addEventListener('change', function (e) {
    toggleSite(e.target.checked);
    persist().then(render, render);
  });
  $('openOptions').addEventListener('click', function () { openOptions(null); });
  $('openFavorites').addEventListener('click', function () { openOptions('favorites'); });
  $('openHistory').addEventListener('click', function () { openOptions('history'); });
}

function init() {
  bind();
  load().catch(function () {
    $('statusText').textContent = '读取设置失败，请刷新后重试';
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}
