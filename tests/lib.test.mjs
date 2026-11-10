/*
 * 纯函数库单元测试：node tests/lib.test.mjs
 */
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = readFileSync(path.join(here, '..', 'src', 'lib.js'), 'utf8');

const sandbox = { self: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: 'lib.js' });
const L = sandbox.self.SELib;

let passed = 0;
const failures = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
  } else {
    failures.push(name + (detail ? ' → ' + detail : ''));
  }
}

function eq(name, actual, expected) {
  check(name, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/* ------------------------------------------------------------ extractJson */

eq('fenced json', L.extractJson('```json\n{"words":[]}\n```').words.length, 0);
eq('prose around json', L.extractJson('好的，结果如下：{"words":[]} 以上。').words.length, 0);
eq('nested braces kept', L.extractJson('前言 {"a":{"b":[1,2]}} 结尾').a.b[1], 2);
check('garbage returns null', L.extractJson('完全不是 JSON') === null);
check('empty returns null', L.extractJson('') === null);
check('non-string returns null', L.extractJson(null) === null);
eq('trailing comma tolerated', L.extractJson('{"words":[],}').words.length, 0);
/* 字符串里带字面换行/制表等控制字符（JSON 本不允许）也能修 */
eq('literal newline inside string', L.extractJson('{"sentence":{"translation":"第一行\n第二行"}}').sentence.translation, '第一行 第二行');
eq('literal tab inside string', L.extractJson('{"words":[{"word":"a\tb"}],"x":1}').words[0].word, 'a b');
/* 连吐两个 JSON 对象：取第一个配平的 */
eq('sibling objects take first', L.extractJson('{"a":1} {"b":2}').a, 1);
check('sibling objects ignore second', !('b' in L.extractJson('{"a":1} {"b":2}')));
/* 前后废话 + 嵌套引号 */
eq('balanced scan respects strings', L.extractJson('前 {"a":"}{"} 后 {"c":3}').a, '}{');
/* 截断抢救：words 数组完整、sentence 写了一半被切 */
const truncated = '{"words":[{"word":"lucid","pos":"形容词","meaning":"清晰易懂的"}],"sentence":{"transl';
const salvaged = L.extractJson(truncated);
check('truncated salvages words', salvaged && salvaged.words && salvaged.words[0].word === 'lucid');
const truncated2 = '{"words":[{"word":"a","meaning":"b"},{"word":"c","mean';
const salvaged2 = L.extractJson(truncated2);
check('truncated mid-array keeps first item', salvaged2 && salvaged2.words.length >= 1 && salvaged2.words[0].word === 'a');

/* -------------------------------------------------------- normalizeAnalysis */

const full = L.normalizeAnalysis({
  words: [{ word: 'persevered', pos: '动词', meaning: '坚持不懈' }, { word: 'setback', pos: '名词', meaning: '挫折' }],
  sentence: { translation: '尽管遭遇挫折，她仍坚持不懈。', explanation: '转折结构，强调坚持。' },
  phrases: [{ phrase: 'turn the tide', meaning: '扭转局势', example: 'Their persistence helped turn the tide.' }]
}, 'persevered');
eq('words count', full.words.length, 2);
eq('word pos', full.words[0].pos, '动词');
eq('sentence translation', full.sentence.translation, '尽管遭遇挫折，她仍坚持不懈。');
eq('phrase example', full.phrases[0].example, 'Their persistence helped turn the tide.');

const alias = L.normalizeAnalysis({
  vocabulary: [{ term: 'lucid', partOfSpeech: '形容词', definition: '清晰易懂的' }, { term: '', definition: '空词丢弃' }],
  整句解释: { 译文: '句子译文', 解释: '句子解释' },
  expressions: ['break the ice']
}, 'lucid');
eq('alias words kept', alias.words.length, 1);
eq('alias word name', alias.words[0].word, 'lucid');
eq('alias sentence', alias.sentence.translation, '句子译文');
eq('string phrase coerced', alias.phrases.length, 1);

const single = L.normalizeAnalysis({ words: [] }, 'serendipity');
eq('single word fallback', single.words.length, 1);
eq('single word fallback name', single.words[0].word, 'serendipity');

const broken = L.normalizeAnalysis({ words: [null, 42, { word: 'x' }], sentence: 'only text' }, 'hello world');
eq('broken words dropped', broken.words.length, 0);
eq('string sentence kept', broken.sentence.translation, 'only text');
check('null input safe', L.normalizeAnalysis(null, 'abc').words.length === 1);
check('multi-word selection has no fallback', L.normalizeAnalysis({}, 'two words').words.length === 0);
check('empty detection', L.isEmptyAnalysis(L.normalizeAnalysis({}, 'a b c')) === true);
check('non-empty detection', L.isEmptyAnalysis(full) === false);

const long = L.normalizeAnalysis({ words: [{ word: 'w'.repeat(500), meaning: 'm'.repeat(900) }] }, 'w');
check('word length capped', long.words[0].word.length <= 81, String(long.words[0].word.length));
check('meaning length capped', long.words[0].meaning.length <= 301, String(long.words[0].meaning.length));

/* ------------------------------------------------------------ buildMessages */

const msgs = L.buildMessages({ text: 'turn the tide', context: 'She eventually turned the tide.', pageTitle: 'Demo' });
eq('two messages', msgs.length, 2);
eq('system role', msgs[0].role, 'system');
check('system mentions CET-6', msgs[0].content.includes('六级'));
check('system demands json', msgs[0].content.includes('JSON'));
check('no stray placeholder', !msgs[0].content.includes('votes'));
check('user contains selection', msgs[1].content.includes('turn the tide'));
check('user contains context', msgs[1].content.includes('eventually turned the tide'));
check('title included', msgs[1].content.includes('Demo'));

const longMsgs = L.buildMessages({ text: 'x'.repeat(5000), context: 'c'.repeat(9000) });
check('long text truncated', longMsgs[1].content.length < 4000, String(longMsgs[1].content.length));
check('context capped at 600 in user msg', !longMsgs[1].content.includes('c'.repeat(700)));

/* ----------------------------------------------------------------- misc */

eq('truncate short', L.truncate('abc', 10), 'abc');
eq('truncate long', L.truncate('abcdef', 4), 'abc…');
eq('truncate null', L.truncate(null, 5), '');

const plain = L.toPlainText(full);
check('plain has 生词', plain.includes('生词'));
check('plain has 整句解释', plain.includes('整句解释'));
check('plain has 固定表达', plain.includes('固定表达'));
eq('plain empty for null', L.toPlainText(null), '');

/* ------------------------------------------------------- pickVoice / 导出 */

const voices = [
  { name: 'Microsoft Xiaoxiao', lang: 'zh-CN' },
  { name: 'Google UK English Female', lang: 'en-GB' },
  { name: 'Microsoft Aria', lang: 'en-US' },
  { name: 'Google US English', lang: 'en_US' }
];
eq('pickVoice prefers en-US', L.pickVoice(voices).lang.replace('_', '-'), 'en-US');
eq('pickVoice falls back to en-GB', L.pickVoice([voices[0], voices[1]]).lang, 'en-GB');
eq('pickVoice null for no english', L.pickVoice([voices[0]]), null);
eq('pickVoice null for empty', L.pickVoice([]), null);
eq('pickVoice null for junk', L.pickVoice(null), null);

eq('escapeHtml basic', L.escapeHtml('<b>"x"</b> & y'), '&lt;b&gt;&quot;x&quot;&lt;/b&gt; &amp; y');
eq('escapeHtml null', L.escapeHtml(null), '');

const ankiItem = {
  text: 'persevered',
  context: 'Despite the setback, she persevered.',
  analysis: full
};
const back = L.ankiBack(ankiItem);
check('anki back has sections', back.includes('<b>生词</b>') && back.includes('<b>整句解释</b>') && back.includes('<b>固定表达</b>'));
check('anki back uses <br>', back.includes('<br>'));
check('anki back escapes html', L.ankiBack({ text: 't', analysis: { words: [{ word: '<script>', pos: '', meaning: 'x' }] } }).includes('&lt;script&gt;'));

const csv = L.toAnkiCsv([ankiItem]);
const csvFirstLine = csv.split('\r\n')[0];
check('csv starts with quoted front', csvFirstLine.startsWith('"persevered",'));
check('csv quotes doubled', L.toAnkiCsv([{ text: 'say "hi"', analysis: null }]).includes('"say ""hi"""'));
check('csv empty for no items', L.toAnkiCsv([]) === '');

const md = L.toMarkdown([ankiItem]);
check('md has heading', md.includes('## 1. persevered'));
check('md has context quote', md.includes('> Despite the setback'));
check('md has sections', md.includes('生词') && md.includes('固定表达'));

/* ---------------------------------------------------------- looksLikeEnglish */

check('英文句子通过', L.looksLikeEnglish('Despite the setback, she persevered.'));
check('单个英文单词通过', L.looksLikeEnglish('serendipity'));
check('中文不通过', L.looksLikeEnglish('这是中文段落') === false);
check('日文不通过', L.looksLikeEnglish('これは日本語です') === false);
check('韩文不通过', L.looksLikeEnglish('한국어 문장입니다') === false);
check('中英混排但以英文为主通过', L.looksLikeEnglish('The word 词 means word.') === true);
check('纯数字/符号不通过', L.looksLikeEnglish('12345 !!!') === false);
check('空字符串不通过', L.looksLikeEnglish('') === false);

/* ---------------------------------------------------------------- 结果 */

const demo = L.demoAnalysis('persevered');
check('demo 有生词', demo.words.length >= 2);
check('demo 有整句解释', !!(demo.sentence && demo.sentence.translation));
check('demo 把选中内容写进说明', demo.sentence.explanation.includes('persevered'));
check('demo 有固定表达', demo.phrases.length === 1);
eq('demo 标记', demo.demo, true);

console.log(`lib.js: ${passed} passed, ${failures.length} failed`);
if (failures.length) {
  failures.forEach((f) => console.error('  ✗ ' + f));
  process.exit(1);
}
