/*
 * 扩展结构自检：node tests/check-manifest.mjs
 * 校验 manifest 是否合法、引用的文件是否都存在、是否满足 MV3 的基本约束。
 */
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];
let passed = 0;

function check(name, condition, detail) {
  if (condition) passed++;
  else failures.push(name + (detail ? ' → ' + detail : ''));
}

const manifestPath = path.join(root, 'manifest.json');
let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  passed++;
} catch (e) {
  console.error('manifest.json 无法解析：' + e.message);
  process.exit(1);
}

check('manifest_version === 3', manifest.manifest_version === 3);
check('有 name/version/description', !!(manifest.name && manifest.version && manifest.description));
check('版本号格式', /^\d+(\.\d+){0,3}$/.test(manifest.version), manifest.version);

const refs = [];
if (manifest.background?.service_worker) refs.push(manifest.background.service_worker);
check('没有 MV2 的 background.scripts', !manifest.background?.scripts);
check('没有 MV2 的 browser_action', !manifest.browser_action);
for (const cs of manifest.content_scripts || []) (cs.js || []).forEach((f) => refs.push(f));
(manifest.content_scripts || []).forEach((cs) => (cs.css || []).forEach((f) => refs.push(f)));
if (manifest.options_page) refs.push(manifest.options_page);
if (manifest.action?.default_popup) refs.push(manifest.action.default_popup);
Object.values(manifest.icons || {}).forEach((f) => refs.push(f));

for (const ref of refs) {
  check('文件存在: ' + ref, existsSync(path.join(root, ref)));
}

check('无 remote code / 无 content_security_policy 越权', !manifest.content_security_policy);
check('无 web_accessible_resources 泄露', !manifest.web_accessible_resources);
check('permissions 只有 storage + contextMenus', JSON.stringify(manifest.permissions) === JSON.stringify(['storage', 'contextMenus']),
  JSON.stringify(manifest.permissions));
check('externally_connectable 未声明（网页不能直接发消息）', !manifest.externally_connectable);

const cs = (manifest.content_scripts || [])[0] || {};
check('content script 覆盖 http/https', JSON.stringify(cs.matches) === JSON.stringify(['http://*/*', 'https://*/*']),
  JSON.stringify(cs.matches));
check('lib.js 先于 content.js 注入', (cs.js || []).indexOf('src/lib.js') >= 0 &&
  (cs.js || []).indexOf('src/lib.js') < (cs.js || []).indexOf('src/content.js'));

const contentSrc = readFileSync(path.join(root, 'src/content.js'), 'utf8');
check('content script 不读取 API Key', !/credentials/.test(contentSrc) && !/apiKey/.test(contentSrc));
check('content script 不使用 innerHTML', !/\.innerHTML\s*=|\[\s*['"]innerHTML['"]\s*\]/.test(contentSrc));
check('content script 使用 closed shadow root', /attachShadow\s*\(\s*\{\s*mode:\s*'closed'\s*\}/.test(contentSrc));

for (const file of ['src/content.js', 'src/background.js', 'src/options.js']) {
  const code = readFileSync(path.join(root, file), 'utf8');
  check(file + ' 无动态代码执行', !/\beval\s*\(|new\s+Function\s*\(|document\.write\s*\(|insertAdjacentHTML|\.srcdoc\s*=/.test(code));
}

for (const t of ['tests/lib.test.mjs', 'tests/background.test.mjs', 'tests/content-dom.test.mjs']) {
  check('存在真实执行型测试: ' + t, existsSync(path.join(root, t)));
}

const bgSrc = readFileSync(path.join(root, 'src/background.js'), 'utf8');
check('background 不把 apiKey 回传 content script', !/settings:\s*cfg\.settings,\s*apiKey/.test(bgSrc));

console.log(`structure: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
