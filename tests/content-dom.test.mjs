/*
 * content script 的 DOM 冒烟测试（需要 jsdom，见下）
 *   node tests/content-dom.test.mjs
 *
 * jsdom 装在扩展目录同级：<workspace>/.devtools-jsdom
 * 没有装的话本测试自动 SKIP（不影响其它测试）。
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
  console.log('content.js DOM 测试：SKIP（未找到 jsdom，可运行 npm install jsdom 于 ' + devtools + '）');
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

const PARAGRAPH = 'Despite the setback, she persevered and eventually turned the tide in her favor.';

const CANNED = {
  words: [{ word: 'persevered', pos: '动词', meaning: '坚持不懈' }],
  sentence: { translation: '尽管遭遇挫折，她仍坚持不懈。', explanation: '转折结构。' },
  phrases: [{ phrase: 'turn the tide', meaning: '扭转局势', example: 'They helped turn the tide.' }]
};

const dom = new JSDOM(
  `<!doctype html><html><head><title>测试页</title></head><body><p id="t">${PARAGRAPH}</p><p id="u">Serendipity means finding something good without looking for it.</p><p id="zh">这是中文段落，用来验证不会触发查询。</p></body></html>`,
  { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.com/article' }
);
const win = dom.window;

/* ---- 让 jsdom 里的 Range 有尺寸，并记录被创建出来的 shadow root ---- */
win.Range.prototype.getBoundingClientRect = function () {
  return { width: 220, height: 16, left: 60, top: 80, right: 280, bottom: 96, x: 60, y: 80 };
};
const origAttachShadow = win.Element.prototype.attachShadow;
win.Element.prototype.attachShadow = function (init) {
  const shadowRoot = origAttachShadow.call(this, init);
  win.__seRoot = shadowRoot;
  return shadowRoot;
};

/* ---- chrome.* 假实现（content script 现在不碰 storage，全靠消息） ---- */
const messages = [];
const favoriteCalls = [];
let favoriteSavedId = null;
win.chrome = {
  runtime: {
    lastError: undefined,
    sendMessage(msg, cb) {
      messages.push(msg);
      let reply;
      if (msg.type === 'se-analyze') {
        reply = { ok: true, analysis: CANNED, meta: { model: 'deepseek-chat', ms: 12 } };
      } else if (msg.type === 'se-ui-settings') {
        reply = { ok: true, settings: { enabled: true, trigger: 'button' } };
      } else if (msg.type === 'se-favorite-toggle') {
        favoriteCalls.push(msg);
        favoriteSavedId = msg.savedId ? null : 'fav-1';
        reply = { ok: true, savedId: favoriteSavedId };
      } else {
        reply = { ok: true };
      }
      setTimeout(() => cb && cb(reply), 0);
    },
    onMessage: {
      addListener(fn) { win.__seOnMessage = fn; }
    }
  }
};

/* ---- 朗读（speechSynthesis）假实现 ---- */
win.__speakCalls = [];
win.speechSynthesis = {
  cancel() { win.__speakCancelled = (win.__speakCancelled || 0) + 1; },
  speak(u) { win.__speakCalls.push(u); },
  getVoices() { return []; }
};
win.SpeechSynthesisUtterance = function (text) { this.text = text; };

/* ---- 加载扩展脚本 ---- */
win.eval(readFileSync(path.join(root, 'src', 'lib.js'), 'utf8'));
win.eval(readFileSync(path.join(root, 'src', 'styles.js'), 'utf8'));
win.eval(readFileSync(path.join(root, 'src', 'content.js'), 'utf8'));

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- 1. 选中文本 → 出现小圆钮 ---- */
const range = win.document.createRange();
range.selectNodeContents(win.document.getElementById('t'));
const sel = win.getSelection();
sel.removeAllRanges();
sel.addRange(range);

win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
await wait(20);

check('创建了 shadow root', !!win.__seRoot);
const shadow = win.__seRoot;
check('shadow root 是 closed', shadow && win.document.querySelector('#select-english-host').shadowRoot === null);
const bubble = shadow && shadow.querySelector('.se-bubble');
check('出现了小圆钮', !!bubble);
eq('小圆钮文字', bubble && bubble.textContent, '译');
check('此时还没有面板', !shadow.querySelector('.se-panel'));

/* ---- 2. 点小圆钮 → 发消息给后台 → 渲染结果 ---- */
bubble.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
await wait(30);

const analyzeMsgs = messages.filter((m) => m.type === 'se-analyze');
eq('只发了一条查询消息', analyzeMsgs.length, 1);
eq('消息类型', analyzeMsgs[0].type, 'se-analyze');
eq('消息文本', analyzeMsgs[0].text, PARAGRAPH);
check('消息带上下文', typeof analyzeMsgs[0].context === 'string' && analyzeMsgs[0].context.length > 0);
check('消息里不含 API Key', !JSON.stringify(messages).includes('apiKey') && !JSON.stringify(messages).includes('sk-'));

const panel = shadow.querySelector('.se-panel');
check('渲染出面板', !!panel);
const text = panel ? panel.textContent : '';
check('有生词分区', text.includes('生词'));
check('有整句解释分区', text.includes('整句解释'));
check('有固定表达分区', text.includes('固定表达'));
check('渲染了释义', text.includes('坚持不懈'));
check('渲染了译文', text.includes('尽管遭遇挫折'));
check('渲染了固定表达', text.includes('turn the tide'));
check('渲染了例句', text.includes('They helped turn the tide.'));
check('页脚显示模型', text.includes('deepseek-chat'));
check('没有把模型输出当 HTML 解析', panel && panel.querySelectorAll('script').length === 0);

/* ---- 3. 收藏（经后台消息，content 无 storage 权限） ---- */
const saveBtn = shadow.querySelector('[data-action="save"]');
check('有收藏按钮', !!saveBtn);
saveBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
await wait(20);
check('向后台发收藏消息', favoriteCalls.length === 1);
eq('收藏消息类型', favoriteCalls[0] && favoriteCalls[0].type, 'se-favorite-toggle');
eq('收藏的原文', favoriteCalls[0] && favoriteCalls[0].payload.text, PARAGRAPH);
eq('收藏的释义', favoriteCalls[0] && favoriteCalls[0].payload.analysis.words[0].meaning, '坚持不懈');
eq('收藏按钮变为已保存', saveBtn.textContent, '★');
saveBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
await wait(20);
check('再点一次走取消收藏', favoriteCalls.length === 2 && favoriteCalls[1].savedId === 'fav-1');
eq('取消后按钮还原', saveBtn.textContent, '☆');

/* ---- 3b. 同一选区再次查询 → 命中 content script 缓存，不重复请求 ---- */
const beforeCount = messages.length;
win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
await wait(20);
const bubble2 = shadow.querySelector('.se-bubble');
check('小圆钮再次出现', !!bubble2);
bubble2.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
await wait(20);
eq('缓存命中不重复请求', messages.length, beforeCount);
const panel2 = shadow.querySelector('.se-panel');
check('页脚标注缓存', !!panel2 && panel2.textContent.includes('缓存'));
check('缓存路径仍渲染释义', !!panel2 && panel2.textContent.includes('坚持不懈'));

/* ---- 4. Esc 关闭 ---- */
win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(10);
check('Esc 后面板被移除', !shadow.querySelector('.se-panel'));

/* ---- 5. 关闭状态下点空白处不报错 ---- */
win.document.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true }));
win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
await wait(10);
check('空白处点击不会新建面板', !shadow.querySelector('.se-panel'));
eq('没有发出多余消息', messages.filter((m) => m.type === 'se-analyze').length, 1);

/* ---- 5b. 选中中文：不弹窗、不发请求 ---- */
const rZh = win.document.createRange();
rZh.selectNodeContents(win.document.getElementById('zh'));
const sZh = win.getSelection();
sZh.removeAllRanges();
sZh.addRange(rZh);
const beforeZh = messages.filter((m) => m.type === 'se-analyze').length;
win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
await wait(20);
eq('中文选区不发请求', messages.filter((m) => m.type === 'se-analyze').length, beforeZh);
const bubbleZh = win.__seRoot.querySelector('.se-bubble');
check('中文选区不出圆钮', !bubbleZh || bubbleZh.style.display === 'none');

check('启动时向后台要过设置', messages.some((m) => m.type === 'se-ui-settings'));

/* ---- 6. SPA 把宿主连根拔掉后，小圆钮还能重新出现（回归：findings #1） ---- */
const oldHost = win.document.getElementById('select-english-host');
check('宿主先前存在', !!oldHost);
oldHost.remove();
const r2 = win.document.createRange();
r2.selectNodeContents(win.document.getElementById('t'));
const s2 = win.getSelection();
s2.removeAllRanges();
s2.addRange(r2);
win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
await wait(20);
const newHost = win.document.getElementById('select-english-host');
check('宿主被重建', !!newHost && newHost !== oldHost);
check('重建后小圆钮出现', !!(win.__seRoot && win.__seRoot.querySelector('.se-bubble')));
check('重建后小圆钮可见', win.__seRoot.querySelector('.se-bubble').style.display === 'flex');

/* ---- 6b. 朗读：整段按钮 + 生词小喇叭 ---- */
win.__seRoot.querySelector('.se-bubble').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
await wait(20);
const panel3 = win.__seRoot.querySelector('.se-panel');
check('朗读测试前面板已打开', !!panel3);
panel3.querySelector('[data-action="speak"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
eq('朗读整段选中', win.__speakCalls[0] && win.__speakCalls[0].text, PARAGRAPH);
const sayBtn = panel3.querySelector('.se-say');
check('生词旁有小喇叭', !!sayBtn);
sayBtn.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
eq('朗读单个生词', win.__speakCalls[1] && win.__speakCalls[1].text, 'persevered');

/* ---- 6c. 拖动小窗并记住位置 ---- */
const head = panel3.querySelector('.se-head');
head.dispatchEvent(new win.MouseEvent('mousedown', { bubbles: true, clientX: 100, clientY: 100 }));
win.dispatchEvent(new win.MouseEvent('mousemove', { bubbles: true, clientX: 260, clientY: 180 }));
win.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true }));
eq('拖动后 left', panel3.style.left, '160px');
eq('拖动后 top', panel3.style.top, '80px');

win.document.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
await wait(10);
win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
await wait(20);
win.__seRoot.querySelector('.se-bubble').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
await wait(20);
const panel4 = win.__seRoot.querySelector('.se-panel');
eq('重开后记住 left', panel4 && panel4.style.left, '160px');
eq('重开后记住 top', panel4 && panel4.style.top, '80px');

/* ---- 6d. 面板开着时用键盘选中新文本 → 旧面板立即关闭，不会出现「新查询显示旧内容」 ---- */
check('6d 前面板开着', !!win.__seRoot.querySelector('.se-panel'));
const r3 = win.document.createRange();
r3.selectNodeContents(win.document.getElementById('u'));
const s3 = win.getSelection();
s3.removeAllRanges();
s3.addRange(r3);
win.document.dispatchEvent(new win.Event('selectionchange'));
await wait(20);
check('键盘新选区后旧面板关闭', !win.__seRoot.querySelector('.se-panel'));
const bubble3 = win.__seRoot.querySelector('.se-bubble');
check('键盘新选区后圆钮出现', !!bubble3 && bubble3.style.display === 'flex');
const before6d = messages.length;
bubble3.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
await wait(30);
check('新选区发了新请求', messages.length > before6d);
eq('请求的是新文本', messages[messages.length - 1].text, 'Serendipity means finding something good without looking for it.');
const panel5 = win.__seRoot.querySelector('.se-panel');
check('新面板渲染的是新内容', !!panel5 && panel5.textContent.includes('Serendipity'));

/* ---- 7. 停用后快捷键与划词都不再触发（设置变化经后台消息广播） ---- */
win.__seOnMessage({ type: 'se-settings-changed', settings: { enabled: false, trigger: 'button' } }, {}, () => {});
await wait(10);
const reply = await new Promise((resolve) => {
  const keep = win.__seOnMessage({ type: 'se-trigger' }, {}, resolve);
  if (keep !== true) resolve(undefined);
});
eq('停用后命令被拒绝', reply && reply.ok, false);
check('提示已停用', /停用/.test((reply && reply.error) || ''), reply && reply.error);

const beforeDisabled = messages.length;
win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
await wait(20);
eq('停用后不再发请求', messages.length, beforeDisabled);
check('停用后小圆钮隐藏', win.__seRoot.querySelector('.se-bubble').style.display === 'none');

/* ---- 8. 重新启用后快捷键可用（改设置会清缓存，所以会重新发请求） ---- */
win.__seOnMessage({ type: 'se-settings-changed', settings: { enabled: true, trigger: 'button' } }, {}, () => {});
await wait(10);
const beforeEnabled = messages.length;
const reply2 = await new Promise((resolve) => {
  const keep = win.__seOnMessage({ type: 'se-trigger' }, {}, resolve);
  if (keep !== true) resolve(undefined);
});
eq('启用后命令被接受', reply2 && reply2.ok, true);
await wait(20);
check('启用后重新发起查询', messages.length > beforeEnabled);

/* ---- 9. 在本站停用后：不弹圆钮、不发请求 ---- */
win.__seOnMessage({ type: 'se-settings-changed', settings: { enabled: true, trigger: 'button', disabledSites: ['example.com'] } }, {}, () => {});
await wait(10);
const rSite = win.document.createRange();
rSite.selectNodeContents(win.document.getElementById('t'));
const sSite = win.getSelection();
sSite.removeAllRanges();
sSite.addRange(rSite);
const beforeSite = messages.filter((m) => m.type === 'se-analyze').length;
win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
await wait(20);
eq('本站停用后不发请求', messages.filter((m) => m.type === 'se-analyze').length, beforeSite);
const bubbleSite = win.__seRoot.querySelector('.se-bubble');
check('本站停用后不出圆钮', !bubbleSite || bubbleSite.style.display === 'none');

const siteTrigger = await new Promise((resolve) => {
  const keep = win.__seOnMessage({ type: 'se-trigger' }, {}, resolve);
  if (keep !== true) resolve(undefined);
});
check('本站停用时快捷键被拒', siteTrigger && siteTrigger.ok === false && /本站/.test(siteTrigger.error || ''), JSON.stringify(siteTrigger));

/* ---- 10. 恢复本站 ---- */
win.__seOnMessage({ type: 'se-settings-changed', settings: { enabled: true, trigger: 'button', disabledSites: [] } }, {}, () => {});
await wait(10);
win.document.dispatchEvent(new win.MouseEvent('mouseup', { bubbles: true, button: 0 }));
await wait(20);
const bubbleRestored = win.__seRoot.querySelector('.se-bubble');
check('恢复后圆钮重新出现', !!bubbleRestored && bubbleRestored.style.display === 'flex');

console.log(`content.js DOM: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
