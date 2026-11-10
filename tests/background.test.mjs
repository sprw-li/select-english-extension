/*
 * 后台集成测试：在 Node 里用假的 chrome.* 和 fetch 跑通整条链路
 *   content 消息 → 读取配置 → 组装请求 → 解析模型输出 → 归一化 → 回包
 * 运行：node tests/background.test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** 每次都新建一个隔离的后台实例（带持久化假存储） */
function boot({ store, fetchImpl }) {
  const calls = [];
  const writes = [];
  const mem = Object.assign({}, store.get());
  const createdMenus = [];
  const sentToTabs = [];
  const accessLevels = [];
  const sandbox = {
    console,
    self: {},
    AbortController,
    setTimeout,
    clearTimeout,
    fetch: async (url, opts) => {
      calls.push({ url, opts, body: JSON.parse(opts.body) });
      return fetchImpl(url, opts, calls.length);
    },
    chrome: {
      storage: {
        local: {
          get: async (defaults) => Object.assign({}, defaults, mem),
          set: async (value) => { writes.push(value); Object.assign(mem, value); },
          setAccessLevel: async (opts) => { accessLevels.push(opts); }
        },
        onChanged: { addListener(fn) { sandbox.__onChanged = fn; } }
      },
      runtime: {
        onMessage: { addListener(fn) { sandbox.__onMessage = fn; } },
        onInstalled: { addListener(fn) { sandbox.__onInstalled = fn; } },
        openOptionsPage() {},
        lastError: undefined
      },
      action: { onClicked: { addListener() {} } },
      commands: { onCommand: { addListener() {} } },
      contextMenus: {
        removeAll(cb) { if (cb) cb(); },
        create(opts) { createdMenus.push(opts); },
        onClicked: { addListener(fn) { sandbox.__onMenuClicked = fn; } }
      },
      tabs: {
        query(_q, cb) { cb([{ id: 1 }, { id: 2 }]); },
        sendMessage(tabId, msg, cb) { sentToTabs.push({ tabId, msg }); if (cb) cb(); }
      }
    }
  };
  vm.createContext(sandbox);
  sandbox.importScripts = (file) => {
    vm.runInContext(readFileSync(path.join(root, 'src', file), 'utf8'), sandbox, { filename: file });
  };
  vm.runInContext(readFileSync(path.join(root, 'src', 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
  return { sandbox, calls, writes, mem, createdMenus, sentToTabs, accessLevels };
}

function ask(sandbox, message) {
  return new Promise((resolve) => {
    const keepAlive = sandbox.__onMessage(message, {}, resolve);
    if (keepAlive !== true) resolve(undefined);
  });
}

function okResponse(payload) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ choices: [{ message: { content: JSON.stringify(payload) } }] })
  };
}

const DEFAULT_STORE = () => ({
  settings: { apiBase: 'https://api.deepseek.com/v1', model: 'deepseek-chat', temperature: 0.3, jsonMode: true, enabled: true, trigger: 'button', recordHistory: true },
  credentials: { apiKey: 'sk-test-key' }
});

/* ------------------------------------------------------ 1. 正常 JSON 回包 */

{
  const { sandbox, calls } = boot({
    store: { get: DEFAULT_STORE },
    fetchImpl: async () => okResponse({
      words: [{ word: 'persevered', pos: '动词', meaning: '坚持不懈' }],
      sentence: { translation: '尽管遭遇挫折，她仍坚持不懈。', explanation: '转折结构。' },
      phrases: [{ phrase: 'turn the tide', meaning: '扭转局势', example: 'They helped turn the tide.' }]
    })
  });
  const res = await ask(sandbox, {
    type: 'se-analyze',
    text: 'persevered',
    context: 'Despite the setback, she persevered.',
    pageTitle: 'Demo'
  });
  check('回包 ok', res && res.ok === true, JSON.stringify(res));
  eq('生词数量', res.analysis.words.length, 1);
  eq('生词释义', res.analysis.words[0].meaning, '坚持不懈');
  eq('整句译文', res.analysis.sentence.translation, '尽管遭遇挫折，她仍坚持不懈。');
  eq('固定表达', res.analysis.phrases[0].phrase, 'turn the tide');
  eq('meta.model', res.meta.model, 'deepseek-chat');
  check('meta.ms 是数字', typeof res.meta.ms === 'number');
  eq('请求地址正确', calls[0].url, 'https://api.deepseek.com/v1/chat/completions');
  eq('带 Authorization', calls[0].opts.headers.Authorization, 'Bearer sk-test-key');
  eq('模型透传', calls[0].body.model, 'deepseek-chat');
  eq('json 模式开启', calls[0].body.response_format.type, 'json_object');
  check('消息里含选中文本', calls[0].body.messages[1].content.includes('persevered'));
  check('system 提示是六级导向', calls[0].body.messages[0].content.includes('六级'));
  check('回包不含 apiKey', !JSON.stringify(res).includes('sk-test-key'));

  /* 同一选区第二次命中后台缓存 */
  const again = await ask(sandbox, { type: 'se-analyze', text: 'persevered', context: 'Despite the setback, she persevered.', pageTitle: 'Demo' });
  eq('缓存命中', again.meta.cached, true);
  eq('缓存不重复请求', calls.length, 1);
}

/* --------------------------------------------- 2. 非 JSON 输出 → 降级兜底 */

{
  const { sandbox } = boot({
    store: { get: DEFAULT_STORE },
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ choices: [{ message: { content: '生词：persevere 就是坚持的意思' } }] })
    })
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'persevered', context: 'ctx' });
  check('降级仍 ok', res.ok === true);
  check('保留了原始输出', typeof res.analysis.raw === 'string' && res.analysis.raw.includes('坚持'));
  eq('标记 fallback', res.meta.fallback, true);
}

/* ------------------------------- 3. 不支持 response_format → 自动重试一次 */

{
  let n = 0;
  const { sandbox, calls } = boot({
    store: { get: DEFAULT_STORE },
    fetchImpl: async (_url, _opts, count) => {
      if (count === 1) {
        return { ok: false, status: 400, text: async () => 'response_format unsupported' };
      }
      return okResponse({ words: [{ word: 'lucid', pos: '形容词', meaning: '清晰易懂的' }] });
    }
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '' });
  check('重试后成功', res.ok === true, JSON.stringify(res));
  eq('共请求两次', calls.length, 2);
  check('第一次带 response_format', !!calls[0].body.response_format);
  check('第二次已去掉 response_format', !calls[1].body.response_format);
  check('n 未被误用', n === 0);
}

/* ------------------------------------------------------ 4. 鉴权失败 */

{
  const { sandbox } = boot({
    store: { get: DEFAULT_STORE },
    fetchImpl: async () => ({ ok: false, status: 401, text: async () => 'invalid key' })
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '' });
  eq('返回失败', res.ok, false);
  check('错误信息是中文鉴权提示', /鉴权失败/.test(res.error), res.error);
}

/* ------------------------------------------------------ 5. 未配置 Key */

{
  const store = DEFAULT_STORE();
  store.credentials = { apiKey: '' };
  const { sandbox, calls } = boot({ store: { get: () => store }, fetchImpl: async () => okResponse({ words: [] }) });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '' });
  eq('未配置 Key 直接失败', res.ok, false);
  check('提示未配置 Key', /API Key/.test(res.error), res.error);
  eq('不发请求', calls.length, 0);
}

/* ------------------------------------------------ 6. 设置查询不泄露 Key */

{
  const { sandbox } = boot({ store: { get: DEFAULT_STORE }, fetchImpl: async () => okResponse({ words: [] }) });
  const res = await ask(sandbox, { type: 'se-get-settings' });
  eq('返回设置成功', res.ok, true);
  eq('hasKey 标记为真', res.hasKey, true);
  check('设置里没有 Key 字段', !('apiKey' in res.settings) && !('credentials' in res.settings));
  check('序列化后不含 Key', !JSON.stringify(res).includes('sk-test-key'));
}

/* ---------------------------------------------------- 7. 连接测试消息 */

{
  const { sandbox, calls } = boot({
    store: { get: DEFAULT_STORE },
    fetchImpl: async () => okResponse({ words: [{ word: 'persevered', pos: '动词', meaning: '坚持不懈' }] })
  });
  const res = await ask(sandbox, { type: 'se-test' });
  eq('测试连接 ok', res.ok, true);
  eq('测试用的模型', res.model, 'deepseek-chat');
  eq('只发一次请求', calls.length, 1);
  check('测试文本是 persevered', calls[0].body.messages[1].content.includes('persevered'));
}

/* ---------------------------------------------------- 8. 空选中内容 */

{
  const { sandbox } = boot({ store: { get: DEFAULT_STORE }, fetchImpl: async () => okResponse({}) });
  const res = await ask(sandbox, { type: 'se-analyze', text: '   ', context: '' });
  eq('空选中失败', res.ok, false);
  check('提示为空', /空/.test(res.error), res.error);
}

/* ------------------------------------- 9. 422（部分网关）也要降级重试 */

{
  const { sandbox, calls } = boot({
    store: { get: DEFAULT_STORE },
    fetchImpl: async (_u, _o, count) => {
      if (count === 1) return { ok: false, status: 422, text: async () => 'response_format is not supported' };
      return okResponse({ words: [{ word: 'lucid', pos: '形容词', meaning: '清晰易懂的' }] });
    }
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '' });
  check('422 重试后成功', res.ok === true, JSON.stringify(res));
  eq('422 共请求两次', calls.length, 2);
  check('422 第二次去掉 response_format', !calls[1].body.response_format);
}

/* --------------------------- 10. 接口地址：查询串要剥离，协议要校验 */

{
  const store = DEFAULT_STORE();
  store.settings.apiBase = 'https://api.example.com/v1/?key=abc#frag';
  const { sandbox, calls } = boot({ store: { get: () => store }, fetchImpl: async () => okResponse({ words: [] }) });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '' });
  check('带查询串的地址也能用', res.ok === true, JSON.stringify(res));
  eq('查询串被剥离', calls[0].url, 'https://api.example.com/v1/chat/completions');
}

{
  const store = DEFAULT_STORE();
  store.settings.apiBase = 'ftp://api.example.com';
  const { sandbox, calls } = boot({ store: { get: () => store }, fetchImpl: async () => okResponse({ words: [] }) });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '' });
  eq('非 http 协议被拒', res.ok, false);
  check('提示协议错误', /http/.test(res.error), res.error);
  eq('不发请求', calls.length, 0);
}

/* --------------------------------------------------- 11. 查询历史 */

{
  const { sandbox, mem } = boot({ store: { get: DEFAULT_STORE }, fetchImpl: async () => okResponse({ words: [{ word: 'lucid', pos: '形容词', meaning: '清晰易懂的' }] }) });
  await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: 'ctx A', pageTitle: 'PageA', pageUrl: 'https://a.example/' });
  await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: 'ctx B', pageTitle: 'PageB', pageUrl: 'https://b.example/' });
  eq('历史两条', mem.history.length, 2);
  eq('新的在前', mem.history[0].title, 'PageB');
  eq('历史带 URL', mem.history[1].url, 'https://a.example/');
  check('历史带分析结果', mem.history[0].analysis.words[0].word === 'lucid');
  check('历史带时间戳', typeof mem.history[0].createdAt === 'string' && mem.history[0].createdAt.includes('T'));

  /* 同文同上下文再查：缓存命中，历史不重复 */
  await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: 'ctx A', pageTitle: 'PageA', pageUrl: 'https://a.example/' });
  eq('缓存命中不重复记历史', mem.history.length, 2);
}

{
  /* 去重：预置同 key 旧条目会被顶掉而不是叠加 */
  const store = DEFAULT_STORE();
  const old = { id: 'hold', text: 'lucid', context: 'ctx A', title: 'Old', url: '', analysis: { words: [] }, createdAt: '2020-01-01T00:00:00.000Z' };
  store.history = [old];
  const { sandbox, mem } = boot({ store: { get: () => store }, fetchImpl: async () => okResponse({ words: [] }) });
  await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: 'ctx A', pageTitle: 'New', pageUrl: '' });
  eq('去重后仍一条', mem.history.length, 1);
  eq('旧条目被替换', mem.history[0].title, 'New');
}

{
  /* 上限 300 条 */
  const store = DEFAULT_STORE();
  store.history = Array.from({ length: 300 }, (_, i) => ({ id: 'h' + i, text: 'w' + i, context: '', title: '', url: '', analysis: {}, createdAt: '2020-01-01T00:00:00.000Z' }));
  const { sandbox, mem } = boot({ store: { get: () => store }, fetchImpl: async () => okResponse({ words: [] }) });
  await ask(sandbox, { type: 'se-analyze', text: 'newword', context: '', pageTitle: 'T', pageUrl: '' });
  eq('历史封顶 300', mem.history.length, 300);
  eq('最新在最前', mem.history[0].text, 'newword');
  check('最旧被挤出', !mem.history.some((h) => h.text === 'w299'));
}

{
  /* 关闭记录后不再写历史 */
  const store = DEFAULT_STORE();
  store.settings.recordHistory = false;
  const { sandbox, mem } = boot({ store: { get: () => store }, fetchImpl: async () => okResponse({ words: [] }) });
  await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '', pageTitle: 'T', pageUrl: '' });
  eq('关闭后无历史', (mem.history || []).length, 0);
}

/* ----------------------------------------------- 12. 右键菜单 */

{
  const { sandbox, createdMenus, sentToTabs } = boot({ store: { get: DEFAULT_STORE }, fetchImpl: async () => okResponse({ words: [] }) });
  sandbox.__onInstalled({ reason: 'install' });
  eq('创建了右键菜单', createdMenus.length, 1);
  eq('菜单 id', createdMenus[0].id, 'se-lookup');
  check('菜单只在选中文本时出现', JSON.stringify(createdMenus[0].contexts) === JSON.stringify(['selection']));

  sandbox.__onMenuClicked({ menuItemId: 'se-lookup' }, { id: 7 });
  eq('菜单点击转发给页面', sentToTabs.length, 1);
  eq('转发的是 se-trigger', sentToTabs[0].msg.type, 'se-trigger');
  eq('发给正确的标签页', sentToTabs[0].tabId, 7);

  sandbox.__onMenuClicked({ menuItemId: 'other' }, { id: 9 });
  eq('其它菜单项被忽略', sentToTabs.length, 1);
}

/* ------------------------------------------- 13. 改设置清缓存 */

{
  const { sandbox, calls } = boot({ store: { get: DEFAULT_STORE }, fetchImpl: async () => okResponse({ words: [{ word: 'lucid', pos: '', meaning: 'm' }] }) });
  await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: 'c', pageTitle: 'T' });
  const again = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: 'c', pageTitle: 'T' });
  eq('第二次命中缓存', again.meta.cached, true);
  eq('缓存时只请求一次', calls.length, 1);
  sandbox.__onChanged({ settings: { newValue: { model: 'other-model' } } }, 'local');
  await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: 'c', pageTitle: 'T' });
  eq('改设置后重新请求', calls.length, 2);
}

/* ------------------------------------------- 14. 演示模式：不联网也能出结果 */

{
  const store = DEFAULT_STORE();
  store.settings.demoMode = true;
  store.credentials = { apiKey: '' };   // 故意不配 Key
  let fetched = 0;
  const { sandbox, mem } = boot({
    store: { get: () => store },
    fetchImpl: async () => { fetched++; throw new Error('演示模式不应该发请求'); }
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'persevered', context: 'ctx', pageTitle: 'T' });
  check('演示模式返回 ok', res.ok === true, JSON.stringify(res));
  eq('标记为演示模式', res.meta.model, '演示模式');
  eq('不发网络请求', fetched, 0);
  check('演示结果有生词', res.analysis.words.length > 0);
  check('演示结果有整句解释', !!(res.analysis.sentence && res.analysis.sentence.translation));
  eq('演示模式也记历史', (mem.history || []).length, 1);

  const testRes = await ask(sandbox, { type: 'se-test' });
  eq('演示模式下测试连接成功', testRes.ok, true);
  eq('测试连接也不发请求', fetched, 0);
}

/* ------------------------------- 15. 存储访问级别：content script 读不到 storage */

{
  const { accessLevels } = boot({ store: { get: DEFAULT_STORE }, fetchImpl: async () => okResponse({ words: [] }) });
  eq('设置过 storage 访问级别', accessLevels.length, 1);
  eq('级别为 TRUSTED_CONTEXTS', accessLevels[0].accessLevel, 'TRUSTED_CONTEXTS');
}

/* ------------------------------------------- 16. 历史默认关闭 */

{
  const store = DEFAULT_STORE();
  delete store.settings.recordHistory;   // 用户没动过这个开关
  const { sandbox, mem } = boot({ store: { get: () => store }, fetchImpl: async () => okResponse({ words: [] }) });
  await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: 'c', pageTitle: 'T' });
  eq('默认不写历史', (mem.history || []).length, 0);
}

/* ----------------------------------- 17. 收藏经后台读写（含取消与上限） */

{
  const { sandbox, mem } = boot({ store: { get: DEFAULT_STORE }, fetchImpl: async () => okResponse({ words: [] }) });
  const add = await ask(sandbox, {
    type: 'se-favorite-toggle',
    savedId: null,
    payload: { text: 'persevered', context: 'ctx', title: 'T', url: 'https://e.x/', analysis: { words: [{ word: 'persevered', meaning: '坚持' }] } }
  });
  check('收藏成功', add.ok === true, JSON.stringify(add));
  check('返回收藏 id', typeof add.savedId === 'string' && add.savedId.length > 0);
  eq('写入一条收藏', mem.favorites.length, 1);
  eq('收藏原文', mem.favorites[0].text, 'persevered');

  const remove = await ask(sandbox, { type: 'se-favorite-toggle', savedId: add.savedId, payload: null });
  check('取消收藏成功', remove.ok === true);
  eq('取消后为空', mem.favorites.length, 0);
  eq('取消后无 id', remove.savedId, null);
}

/* ------------------------------------- 18. UI 设置接口不含 Key / 接口地址 */

{
  const { sandbox } = boot({ store: { get: DEFAULT_STORE }, fetchImpl: async () => okResponse({ words: [] }) });
  const res = await ask(sandbox, { type: 'se-ui-settings' });
  eq('返回 ok', res.ok, true);
  eq('设置只有三个字段', Object.keys(res.settings).sort().join(','), 'disabledSites,enabled,trigger');
  check('不含 apiKey/接口地址', !JSON.stringify(res).includes('sk-test') && !JSON.stringify(res).includes('deepseek'));
}

/* --------------------------- 19. 设置变化广播给页面（不含密钥） */

{
  const { sandbox, sentToTabs } = boot({ store: { get: DEFAULT_STORE }, fetchImpl: async () => okResponse({ words: [] }) });
  sandbox.__onChanged({ settings: { newValue: { enabled: false, trigger: 'auto' } } }, 'local');
  await new Promise((r) => setTimeout(r, 10));
  check('广播到每个标签页', sentToTabs.length === 2, JSON.stringify(sentToTabs));
  eq('消息类型', sentToTabs[0].msg.type, 'se-settings-changed');
  eq('enabled 透传', sentToTabs[0].msg.settings.enabled, false);
  eq('trigger 透传', sentToTabs[0].msg.settings.trigger, 'auto');
  check('广播不含密钥', !JSON.stringify(sentToTabs).includes('sk-test'));
}

/* --------------------------- 20. 404 且无格式提示 → 不重试、不泄露服务端原文 */

{
  const { sandbox, calls } = boot({
    store: { get: DEFAULT_STORE },
    fetchImpl: async () => ({ ok: false, status: 404, text: async () => '<html>not found: internal-host-42</html>' })
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '' });
  eq('404 直接失败', res.ok, false);
  eq('只请求一次（不盲目重试）', calls.length, 1);
  check('错误里不含服务端原文', !res.error.includes('internal-host-42'), res.error);
  check('错误提示是中文排查建议', /接口地址与模型名/.test(res.error), res.error);
}

/* ------------------------------------- 21. 瞬时故障重试（网关/网络抖动） */

{
  const { sandbox, calls } = boot({
    store: { get: DEFAULT_STORE },
    fetchImpl: async (_u, _o, count) => (count === 1
      ? { ok: false, status: 503, text: async () => 'busy' }
      : okResponse({ words: [{ word: 'lucid', pos: '', meaning: 'm' }] }))
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '' });
  check('503 后重试成功', res.ok === true, JSON.stringify(res));
  eq('503 共请求两次', calls.length, 2);
}

{
  const { sandbox, calls } = boot({
    store: { get: DEFAULT_STORE },
    fetchImpl: async (_u, _o, count) => {
      if (count === 1) throw new TypeError('fetch failed');
      return okResponse({ words: [] });
    }
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '' });
  check('网络抖动后重试成功', res.ok === true, JSON.stringify(res));
  eq('网络错误共请求两次', calls.length, 2);
}

{
  const { sandbox, calls } = boot({
    store: { get: DEFAULT_STORE },
    fetchImpl: async () => { throw new TypeError('fetch failed'); }
  });
  const res = await ask(sandbox, { type: 'se-analyze', text: 'lucid', context: '' });
  eq('连续失败最终报错', res.ok, false);
  eq('连续失败只重试一次', calls.length, 2);
  check('错误提示是网络问题', /网络请求失败|请求超时/.test(res.error), res.error);
}

/* ------------------------------------- 22. 站点停用名单透传（不含密钥） */

{
  const store = DEFAULT_STORE();
  store.settings.disabledSites = ['a.example', 'b.example'];
  const { sandbox, sentToTabs } = boot({ store: { get: () => store }, fetchImpl: async () => okResponse({ words: [] }) });
  const res = await ask(sandbox, { type: 'se-ui-settings' });
  check('设置里带停用名单', JSON.stringify(res.settings.disabledSites) === JSON.stringify(['a.example', 'b.example']),
    JSON.stringify(res.settings));
  sandbox.__onChanged({ settings: { newValue: store.settings } }, 'local');
  await new Promise((r) => setTimeout(r, 10));
  check('广播里也带停用名单', JSON.stringify(sentToTabs[0].msg.settings.disabledSites) === JSON.stringify(['a.example', 'b.example']));
}

console.log(`background.js: ${passed} passed, ${failures.length} failed`);if (failures.length) {
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
