/*
 * 流式输出：纯函数测试（Node）
 *   node tests/streaming.test.mjs
 * 覆盖：不完整 JSON 补齐、SSE 解析、后台流式链路、内容脚本边下边渲染
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

let passed = 0;
const failures = [];
function check(name, cond, detail) {
  if (cond) passed++;
  else failures.push(name + (detail ? ' → ' + detail : ''));
}
function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ---------------------------------------------------------- lib 部分 --- */

const libSrc = readFileSync(path.join(root, 'src', 'lib.js'), 'utf8');
const sandbox = { self: {}, console };
vm.createContext(sandbox);
vm.runInContext(libSrc, sandbox, { filename: 'lib.js' });
const L = sandbox.self.SELib;

/* 不完整 JSON */
eq('完整 JSON 保持可用', L.parsePartialJson('{"words":[]}').words.length, 0);

const p1 = '{"words":[{"word":"lucid","pos":"形容词","meaning":"清晰易懂的"}],"sentence":{"transl';
const r1 = L.parsePartialJson(p1);
check('截断在字符串中间也能解析', r1 && r1.words && r1.words[0].word === 'lucid', JSON.stringify(r1));
check('截断时保留已完整的字段', r1 && r1.words[0].meaning === '清晰易懂的');

const p2 = '{"words":[{"word":"a","meaning":"A"},{"word":"b","mean';
const r2 = L.parsePartialJson(p2);
check('截断在第二个对象中间：保留第一个', r2 && r2.words.length >= 1 && r2.words[0].word === 'a', JSON.stringify(r2));

check('空串返回 null', L.parsePartialJson('') === null);
check('还没有花括号时返回 null', L.parsePartialJson('好的，结果是') === null);
check('不完整的键名不会抛错', L.parsePartialJson('{"wor') === null);
eq('括号补齐器：数组+对象', L.closePartialJson('{"a":[1,2'), '{"a":[1,2]}');

/* ---------------------------------------------------- 后台流式链路 --- */

function bootBackground({ settings, fetchImpl, tabsSent }) {
  const mem = { settings, credentials: { apiKey: 'sk-test' } };
  const sandbox = {
    console,
    self: {},
    AbortController,
    setTimeout,
    clearTimeout,
    TextDecoder,
    fetch: fetchImpl,
    chrome: {
      storage: {
        local: {
          get: async (d) => Object.assign({}, d, mem),
          set: async (v) => Object.assign(mem, v),
          setAccessLevel: async () => {}
        },
        onChanged: { addListener() {} }
      },
      runtime: {
        onMessage: { addListener(fn) { sandbox.__onMessage = fn; } },
        onInstalled: { addListener() {} },
        openOptionsPage() {},
        lastError: undefined
      },
      action: { onClicked: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      contextMenus: null,
      tabs: {
        query(_q, cb) { cb([]); },
        sendMessage(tabId, msg, cb) { tabsSent.push({ tabId, msg }); if (cb) cb(); }
      }
    }
  };
  vm.createContext(sandbox);
  sandbox.importScripts = (f) => vm.runInContext(readFileSync(path.join(root, 'src', f), 'utf8'), sandbox, { filename: f });
  vm.runInContext(readFileSync(path.join(root, 'src', 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
  return sandbox;
}

function sseResponse(pieces) {
  const encoder = new TextEncoder();
  const chunks = pieces.map((p) => encoder.encode(p));
  let i = 0;
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'text/event-stream' },
    body: {
      getReader() {
        return {
          read: async () => (i < chunks.length ? { done: false, value: chunks[i++] } : { done: true, value: undefined }),
          cancel() {}
        };
      }
    }
  };
}

function ask(sandbox, message, sender) {
  return new Promise((resolve) => {
    const keep = sandbox.__onMessage(message, sender || { tab: { id: 7 } }, resolve);
    if (keep !== true) resolve(undefined);
  });
}

{
  const full = '{"words":[{"word":"lucid","pos":"形容词","meaning":"清晰易懂的"}],"sentence":{"translation":"清楚","explanation":"说明"},"phrases":[]}';
  const half = full.slice(0, 40);
  const tabsSent = [];
  const requests = [];
  const sandbox = bootBackground({
    settings: { apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat', temperature: 0.3, jsonMode: true, streaming: true, recordHistory: false },
    tabsSent,
    fetchImpl: async (url, opts) => {
      requests.push(JSON.parse(opts.body));
      return sseResponse([
        'data: ' + JSON.stringify({ choices: [{ delta: { content: half } }] }) + '\n\n',
        'data: ' + JSON.stringify({ choices: [{ delta: { content: full.slice(40) } }] }) + '\n\n',
        'data: [DONE]\n\n'
      ]);
    }
  });

  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: 'ctx', streamId: 'r1' });
  check('流式最终结果 ok', res && res.ok === true, JSON.stringify(res));
  eq('最终解析出单词', res.analysis.words[0].word, 'lucid');
  eq('标记为流式', res.meta.streamed, true);
  check('请求带 stream:true', requests[0].stream === true);

  const streams = tabsSent.filter((m) => m.msg.type === 'se-stream');
  check('至少推送了两次中间结果', streams.length >= 2, JSON.stringify(streams.map((s) => s.msg.text.length)));
  eq('推送目标是发起查询的标签页', streams[0].tabId, 7);
  eq('推送携带 streamId', streams[0].msg.streamId, 'r1');
  check('最后一条推送是完整文本', streams[streams.length - 1].msg.text.includes('清晰易懂的'));
}

/* 服务端忽略 stream（直接返回 JSON）→ 自动退回非流式 */
{
  const tabsSent = [];
  const sandbox = bootBackground({
    settings: { apiBase: 'https://api.deepseek.com/v1', model: 'm', streaming: true },
    tabsSent,
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => ({ choices: [{ message: { content: '{"words":[{"word":"x","meaning":"y"}]}' } }] })
    })
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'x', context: '', streamId: 'r2' });
  check('非 SSE 店也能拿到结果', res && res.ok === true, JSON.stringify(res));
  eq('解析正常', res.analysis.words[0].word, 'x');
  eq('没有中间推送', tabsSent.filter((m) => m.msg.type === 'se-stream').length, 0);
}

/* 关闭流式开关 → 普通请求 */
{
  const requests = [];
  const sandbox = bootBackground({
    settings: { apiBase: 'https://api.deepseek.com/v1', model: 'm', streaming: false },
    tabsSent: [],
    fetchImpl: async (url, opts) => {
      requests.push(JSON.parse(opts.body));
      return {
        ok: true,
        status: 200,
        json: async () => ({ choices: [{ message: { content: '{"words":[{"word":"k","meaning":"m"}]}' } }] })
      };
    }
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'k', context: '', streamId: 'r3' });
  eq('关闭流式时 stream=false', requests[0].stream, false);
  check('关闭流式也能出结果', res && res.ok === true);
}

/* 流式过程中服务端报错 → 干净地返回错误 */
{
  const sandbox = bootBackground({
    settings: { apiBase: 'https://api.deepseek.com/v1', model: 'm', streaming: true },
    tabsSent: [],
    fetchImpl: async () => ({
      ok: false,
      status: 500,
      text: async () => 'boom'
    })
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'k', context: '', streamId: 'r4' });
  eq('错误正确返回', res.ok, false);
  check('错误提示是状态码', /HTTP 500/.test(res.error), res.error);
}

/* --------------------------------------------------- 内容脚本渲染 --- */

const devtools = process.env.SE_JSDOM_DIR || path.resolve(root, '..', '.devtools-jsdom');
let JSDOM;
try {
  const req = createRequire(path.join(devtools, 'package.json'));
  ({ JSDOM } = req('jsdom'));
} catch (e) {
  JSDOM = null;
  console.log('注意：未装 jsdom，跳过内容脚本流式渲染测试');
}

if (JSDOM) {
  const dom = new JSDOM('<!doctype html><html><body><p id="t">Despite the setback, she persevered.</p></body></html>', {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://example.com/x'
  });
  const win = dom.window;
  win.Range.prototype.getBoundingClientRect = () => ({ width: 200, height: 16, left: 40, top: 40, right: 240, bottom: 56 });
  const origAttach = win.Element.prototype.attachShadow;
  win.Element.prototype.attachShadow = function (init) {
    const shadowRoot = origAttach.call(this, init);
    win.__seRoot = shadowRoot;
    return shadowRoot;
  };
  win.chrome = {
    runtime: {
      lastError: undefined,
      sendMessage(msg, cb) { win.chrome.__lastAnalyze = msg; setTimeout(() => cb({ ok: true, analysis: null, meta: {} }), 5); },
      onMessage: { addListener(fn) { win.__seOnMessage = fn; } }
    }
  };
  win.eval(readFileSync(path.join(root, 'src', 'lib.js'), 'utf8'));
  win.eval(readFileSync(path.join(root, 'src', 'styles.js'), 'utf8'));
  win.eval(readFileSync(path.join(root, 'src', 'content.js'), 'utf8'));

  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const range = win.document.createRange();
  range.selectNodeContents(win.document.getElementById('t'));
  const sel = win.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
  await wait(20);
  win.__seRoot.querySelector('.se-bubble').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  await wait(20);

  const shadow = win.__seRoot;
  const analyzeMsg = win.chrome.__lastAnalyze;
  check('发起查询时带了 streamId', !!analyzeMsg && typeof analyzeMsg.streamId === 'string');

  // 模拟后台推来半截 JSON
  win.__seOnMessage({ type: 'se-stream', streamId: analyzeMsg.streamId, text: '{"words":[{"word":"persevere","pos":"动词","meaning":"坚' }, {}, () => {});
  await wait(20);
  const panel = shadow.querySelector('.se-panel');
  check('半截 JSON 已渲染出局部结果', !!panel && panel.textContent.includes('坚'), panel ? panel.textContent.slice(0, 80) : 'no panel');
  check('显示「生成中…」', !!panel && panel.textContent.includes('生成中'), panel ? panel.textContent.slice(0, 120) : '');
}

console.log(`streaming: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
