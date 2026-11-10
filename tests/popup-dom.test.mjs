/*
 * 工具栏弹窗的 DOM 测试（jsdom）
 *   node tests/popup-dom.test.mjs
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const devtools = process.env.SE_JSDOM_DIR || path.resolve(root, '..', '.devtools-jsdom');

let JSDOM;
try {
  const req = createRequire(path.join(devtools, 'package.json'));
  ({ JSDOM } = req('jsdom'));
} catch (e) {
  console.log('popup DOM 测试：SKIP（未找到 jsdom）');
  process.exit(0);
}

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed++;
  else failures.push(name + (detail ? ' → ' + detail : ''));
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

const html = readFileSync(path.join(root, 'src', 'popup.html'), 'utf8');
const js = readFileSync(path.join(root, 'src', 'popup.js'), 'utf8');

const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'chrome-extension://test/src/popup.html' });
const win = dom.window;

const writes = [];
const createdTabs = [];
let storedSettings = { enabled: true, trigger: 'button', demoMode: false, recordHistory: false, disabledSites: [] };

win.chrome = {
  storage: {
    local: {
      get(defaults) {
        return Promise.resolve({
          settings: storedSettings,
          credentials: { apiKey: '' },
          favorites: [{ id: 'f1' }],
          history: []
        });
      },
      set(value) {
        writes.push(value);
        if (value && value.settings) storedSettings = value.settings;
        return Promise.resolve();
      }
    }
  },
  runtime: {
    getManifest: () => ({ version: '0.4.0' }),
    getURL: (p) => 'chrome-extension://test/' + p
  },
  tabs: {
    query(_q, cb) { cb([{ id: 1, url: 'https://example.com/article' }]); },
    create(opts) { createdTabs.push(opts); }
  }
};

win.eval(js);
await new Promise((r) => setTimeout(r, 40));

const $ = (id) => win.document.getElementById(id);

/* ---- 初始状态 ---- */
eq('显示版本号', $('version').textContent, 'v0.4.0');
eq('未配置 Key 且有演示模式提示', $('statusText').textContent.includes('未配置 API Key'), true);
eq('显示当前站点', $('host').textContent, 'example.com');
eq('收藏数', $('favCount').textContent, '1');
eq('历史数', $('hisCount').textContent, '0');

/* ---- 开关 ---- */
$('demoMode').checked = true;
$('demoMode').dispatchEvent(new win.Event('change'));
await new Promise((r) => setTimeout(r, 20));
check('演示模式写了设置', writes.length === 1 && writes[0].settings.demoMode === true, JSON.stringify(writes));
eq('状态变为演示模式', $('statusText').textContent.includes('演示模式'), true);

$('enabled').checked = false;
$('enabled').dispatchEvent(new win.Event('change'));
await new Promise((r) => setTimeout(r, 20));
eq('停用后状态提示', $('statusText').textContent, '划词已停用');

/* ---- 本站停用 ---- */
$('siteDisabled').checked = true;
$('siteDisabled').dispatchEvent(new win.Event('change'));
await new Promise((r) => setTimeout(r, 20));
const lastWrite = writes[writes.length - 1];
check('本站停用写入域名', lastWrite && lastWrite.settings.disabledSites.includes('example.com'),
  JSON.stringify(lastWrite));
check('再次渲染保持勾选', $('siteDisabled').checked === true);

/* ---- 跳转按钮 ---- */
$('openFavorites').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
$('openHistory').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
eq('打开收藏时带 hash', createdTabs[0] && createdTabs[0].url, 'chrome-extension://test/src/options.html#favorites');
eq('打开历史时带 hash', createdTabs[1] && createdTabs[1].url, 'chrome-extension://test/src/options.html#history');

console.log(`popup DOM: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
