/*
 * SelectEnglish for Browser — 纯函数库
 * 这里只放不依赖 DOM / chrome API 的逻辑，便于用 Node 直接跑单元测试。
 * 通过 self.SELib 暴露（content script 与 service worker 共用）。
 */
(function (global) {
  'use strict';

  var MAX_TEXT = 1500;      // 选中文本上限
  var MAX_CONTEXT = 2000;   // 上下文上限

  var SYSTEM_PROMPT = [
    '你是一个面向中国大学英语六级（CET-6）读者的英文阅读助手。用户会在网页阅读时选中英文，你的任务是帮他在阅读中理解英文、积累表达。',
    '硬性要求：',
    '1. 只处理用户选中的英文以及必要的上下文，不要翻译或解释网页的其它内容。',
    '2. 生词（words）：优先挑出六级及以上词汇、学术/专业词汇，以及熟词在语境中的少见含义；略过 the、make、good 这类基础高频词和普通的四级常见释义。如果用户只选中了一个词，必须解释这个词本身，绝不能换成别的词、也不要因为它是常见词就留空。每项给出词性 pos（中文，如「动词」「名词」「形容词」）和简明中文释义 meaning（可写语境义）。',
    '3. 整句解释（sentence）：先给出选中内容所在句子在上下文中的通顺中文翻译 translation，再用中文解释这句话的意思、逻辑或修辞 explanation。选中内容是单词或短语时，同样要给出它所在句子的解释。',
    '4. 固定表达（phrases）：提取选中内容或其所在句子里的固定搭配、习语、短语动词等，给出中文释义 meaning 和一句简短英文例句 example。没有就返回空数组，不要硬凑。',
    '5. 词汇难度按语境近似判断，不接入官方词表，不保证词表归属。',
    '只输出一个 JSON 对象，不要输出任何解释性文字，也不要用 Markdown 代码块包裹。JSON 格式固定为：',
    '{"words":[{"word":"","pos":"","meaning":""}],"sentence":{"translation":"","explanation":""},"phrases":[{"phrase":"","meaning":"","example":""}]}',
    '除上述字段外不要输出多余字段；没有内容的数组写 []，没有整句解释时 sentence 写 {"translation":"","explanation":""}。'
  ].join('\n');

  /** 粗略判断选区是不是以英文为主；中文/日文为主的选区不弹窗、不发送。 */
  function looksLikeEnglish(value) {
    var s = String(value == null ? '' : value);
    var latin = s.match(/[A-Za-z]/g);
    var cjk = s.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g);
    var latinCount = latin ? latin.length : 0;
    var cjkCount = cjk ? cjk.length : 0;
    if (latinCount < 2) return false;
    return latinCount >= cjkCount * 2;
  }

  function truncate(value, max) {
    if (!(max >= 1)) return '';
    var s = value == null ? '' : String(value);
    s = s.replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)) + '…';
  }

  function buildMessages(input) {
    var text = truncate(input && input.text, MAX_TEXT).trim();
    var context = truncate(input && input.context, MAX_CONTEXT).trim();
    var title = truncate(input && input.pageTitle, 200).trim();
    var parts = [];
    parts.push('选中内容：');
    parts.push('"""');
    parts.push(text);
    parts.push('"""');
    if (context && context !== text) {
      parts.push('所在上下文（同一段落原文，可能不完整）：');
      parts.push('"""');
      parts.push(context.length > 600 ? context.slice(0, 600) + '…' : context);
      parts.push('"""');
    }
    if (title) parts.push('网页标题：' + title);
    parts.push('请严格按约定的 JSON 格式输出。');
    return [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: parts.join('\n') }
    ];
  }

  /** 从模型输出里尽力抠出一个 JSON 对象；失败返回 null。 */
  function extractJson(raw) {
    if (typeof raw !== 'string') return null;
    var s = raw.trim();
    if (!s) return null;

    var fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced && fenced[1]) s = fenced[1].trim();

    var candidates = [s];

    // 第一个括号配平的 {...}：容忍“前后有废话”以及“连吐两个 JSON”
    var balanced = firstBalanced(s);
    if (balanced && balanced !== s) candidates.push(balanced);

    // 第一个 { 到最后一个 }：容忍尾部废话
    var start = s.indexOf('{');
    var end = s.lastIndexOf('}');
    if (start >= 0 && end > start) candidates.push(s.slice(start, end + 1));

    // 截断抢救：模型被 max_tokens 切断时，尝试补齐结尾
    if (start >= 0) {
      var sub = s.slice(start);
      var bases = [sub];
      var lastComma = sub.lastIndexOf(',');
      if (lastComma > 0) bases.push(sub.slice(0, lastComma));
      var lastBrace = sub.lastIndexOf('}');
      if (lastBrace > 0) bases.push(sub.slice(0, lastBrace + 1));
      var suffixes = ['}', ']}', '"]}', '"}}', '"}]}', '"]}}', '"}'];
      for (var b = 0; b < bases.length; b++) {
        for (var x = 0; x < suffixes.length; x++) {
          candidates.push(bases[b] + suffixes[x]);
        }
      }
    }

    for (var i = 0; i < candidates.length; i++) {
      var parsed = tryParse(candidates[i]);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
    }
    return null;
  }

  /** 扫描第一个括号配平、字符串闭合的 {...}；找不到返回 null。 */
  function firstBalanced(s) {
    var start = s.indexOf('{');
    if (start < 0) return null;
    var depth = 0;
    var inString = false;
    var escaped = false;
    for (var i = start; i < s.length; i++) {
      var ch = s.charAt(i);
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
    return null;
  }

  function tryParse(candidate) {
    if (!candidate) return null;
    try {
      return JSON.parse(candidate);
    } catch (e) { /* 继续宽松解析 */ }
    // JSON 字符串里不允许出现任何 U+0000–U+001F（包括字面换行/制表）；
    // 它们出现在结构位置时本来就是空白，统一换成空格最稳
    var cleaned = candidate.replace(/[\u0000-\u001F]/g, ' ');
    try {
      return JSON.parse(cleaned);
    } catch (e1) { /* 继续 */ }
    var relaxed = cleaned
      .replace(/,\s*([}\]])/g, '$1')          // 尾随逗号
      .replace(/[“”]/g, '"');       // 中文引号
    try {
      return JSON.parse(relaxed);
    } catch (e2) {
      return null;
    }
  }

  function pick(obj, keys) {
    for (var i = 0; i < keys.length; i++) {
      if (obj && obj[keys[i]] != null && obj[keys[i]] !== '') return obj[keys[i]];
    }
    return null;
  }

  function asArray(value) {
    if (Array.isArray(value)) return value;
    if (value && typeof value === 'object') return [value];
    return [];
  }

  function cleanString(value, max) {
    if (value == null) return '';
    if (typeof value === 'object') {
      value = pick(value, ['text', 'value', 'meaning', 'content']) || '';
    }
    return truncate(String(value), max || 200).trim();
  }

  /**
   * 把模型返回的对象规整成固定结构，顺手容错各种字段别名与脏数据。
   * 返回：{words:[{word,pos,meaning}], sentence:{translation,explanation}|null, phrases:[...]}
   */
  function normalizeAnalysis(obj, selectedText) {
    var out = { words: [], sentence: null, phrases: [] };
    if (!obj || typeof obj !== 'object') return withFallback(out, selectedText);

    var rawWords = asArray(pick(obj, ['words', 'vocabulary', '生词', 'keyWords']));
    for (var i = 0; i < rawWords.length && out.words.length < 12; i++) {
      var w = rawWords[i];
      if (!w) continue;
      if (typeof w === 'string') {
        var only = cleanString(w, 80);
        if (only) out.words.push({ word: only, pos: '', meaning: '' });
        continue;
      }
      var word = cleanString(pick(w, ['word', 'term', 'text', '生词', 'w']), 80);
      var meaning = cleanString(pick(w, ['meaning', 'definition', 'translation', '释义', 'explain']), 300);
      var pos = cleanString(pick(w, ['pos', 'partOfSpeech', 'type', '词性']), 40);
      if (!word || !meaning) continue;
      out.words.push({ word: word, pos: pos, meaning: meaning });
    }
    var rawSentence = pick(obj, ['sentence', '整句解释', 'sentenceExplanation', 'translation']);
    if (rawSentence && typeof rawSentence === 'object') {
      var translation = cleanString(pick(rawSentence, ['translation', '译文', 'translate', 'zh', 'text']), 600);
      var explanation = cleanString(pick(rawSentence, ['explanation', 'explain', '解释', 'note', 'meaning']), 900);
      if (translation || explanation) out.sentence = { translation: translation, explanation: explanation };
    } else if (typeof rawSentence === 'string') {
      var text = cleanString(rawSentence, 900);
      if (text) out.sentence = { translation: text, explanation: '' };
    }

    var rawPhrases = asArray(pick(obj, ['phrases', '固定表达', 'expressions', 'idioms']));
    for (var j = 0; j < rawPhrases.length && out.phrases.length < 8; j++) {
      var p = rawPhrases[j];
      if (!p) continue;
      if (typeof p === 'string') {
        var onlyP = cleanString(p, 120);
        if (onlyP) out.phrases.push({ phrase: onlyP, meaning: '', example: '' });
        continue;
      }
      var phrase = cleanString(pick(p, ['phrase', 'term', 'expression', 'text', '固定表达']), 120);
      var pMeaning = cleanString(pick(p, ['meaning', 'definition', 'translation', '释义']), 300);
      var example = cleanString(pick(p, ['example', 'sentence', '例句', 'usage']), 300);
      if (!phrase) continue;
      out.phrases.push({ phrase: phrase, meaning: pMeaning, example: example });
    }

    return withFallback(out, selectedText);
  }

  /** 单选一个词时兜底：即使模型漏了，也把这个词本身列进「生词」。 */
  function withFallback(out, selectedText) {
    var single = String(selectedText || '').trim();
    if (!out.words.length && single && !/\s/.test(single)) {
      out.words.push({ word: single, pos: '', meaning: '' });
    }
    return out;
  }

  function isEmptyAnalysis(a) {
    if (!a) return true;
    var hasSentence = !!(a.sentence && (a.sentence.translation || a.sentence.explanation));
    var hasWords = !!(a.words && a.words.some(function (w) { return w.meaning; }));
    return !hasSentence && !hasWords && !(a.phrases && a.phrases.length);
  }

  /** 非 JSON 输出时的可读纯文本。 */
  function toPlainText(analysis) {
    if (!analysis) return '';
    var lines = [];
    if (analysis.words && analysis.words.length) {
      lines.push('生词');
      analysis.words.forEach(function (w) {
        lines.push('- ' + w.word + (w.pos ? '（' + w.pos + '）' : '') + (w.meaning ? '：' + w.meaning : ''));
      });
    }
    if (analysis.sentence && (analysis.sentence.translation || analysis.sentence.explanation)) {
      lines.push('整句解释');
      if (analysis.sentence.translation) lines.push(analysis.sentence.translation);
      if (analysis.sentence.explanation) lines.push(analysis.sentence.explanation);
    }
    if (analysis.phrases && analysis.phrases.length) {
      lines.push('固定表达');
      analysis.phrases.forEach(function (p) {
        lines.push('- ' + p.phrase + (p.meaning ? '：' + p.meaning : '') + (p.example ? ' 例：' + p.example : ''));
      });
    }
    return lines.join('\n');
  }

  /**
   * 演示模式的内置示例：不联网、不花钱，给商店审核和没填 Key 的人一次完整预览。
   * 形状与真实分析结果一致，UI 不用特殊分支。
   */
  function demoAnalysis(selectedText) {
    var sample = truncate(selectedText, 80);
    return {
      demo: true,
      words: [
        { word: 'persevered', pos: '动词', meaning: '坚持不懈；锲而不舍' },
        { word: 'setback', pos: '名词', meaning: '挫折；退步' },
        { word: 'tide', pos: '名词', meaning: '潮汐；局势、势头' }
      ],
      sentence: {
        translation: '尽管遭遇挫折，她仍坚持不懈，最终扭转了局势，使之对自己有利。',
        explanation: '（演示模式）这是内置示例，不消耗任何接口。选中「' + (sample || '一段英文') + '」这类内容后，填上自己的 API Key 并关闭演示模式，就会按真实语境分析。'
      },
      phrases: [
        { phrase: 'turn the tide', meaning: '扭转局势', example: 'Their persistence helped turn the tide.' }
      ]
    };
  }

  /** 从 speechSynthesis 的声音列表里挑一个英文声音：美音 > 英音 > 其它英语。 */
  function pickVoice(voices) {
    if (!voices || !voices.length) return null;
    var best = null;
    var bestScore = 0;
    for (var i = 0; i < voices.length; i++) {
      var v = voices[i];
      if (!v) continue;
      var lang = String(v.lang || '').replace(/_/g, '-').toLowerCase();
      var score = 0;
      if (lang === 'en-us') score = 40;
      else if (lang === 'en-gb') score = 30;
      else if (lang.indexOf('en-') === 0 || lang === 'en') score = 20;
      if (score && /google/i.test(v.name || '')) score += 1; // 同分略偏好在线音质
      if (score > bestScore) { best = v; bestScore = score; }
    }
    return best;
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** Anki 卡背：带 <br>/<b> 的 HTML（导入 Anki 时勾选「允许 HTML」）。 */
  function ankiBack(item) {
    if (!item) return '';
    var a = item.analysis || {};
    var parts = [];
    if (item.context && item.context !== item.text) {
      parts.push('<i>' + escapeHtml(item.context) + '</i>');
    }
    if (a.words && a.words.length) {
      parts.push('<b>生词</b><br>' + a.words.map(function (w) {
        return escapeHtml(w.word) + (w.pos ? '（' + escapeHtml(w.pos) + '）' : '') + (w.meaning ? '：' + escapeHtml(w.meaning) : '');
      }).join('<br>'));
    }
    if (a.sentence && (a.sentence.translation || a.sentence.explanation)) {
      var s = '<b>整句解释</b>';
      if (a.sentence.translation) s += '<br>' + escapeHtml(a.sentence.translation);
      if (a.sentence.explanation) s += '<br>' + escapeHtml(a.sentence.explanation);
      parts.push(s);
    }
    if (a.phrases && a.phrases.length) {
      parts.push('<b>固定表达</b><br>' + a.phrases.map(function (p) {
        return escapeHtml(p.phrase) + (p.meaning ? '：' + escapeHtml(p.meaning) : '') + (p.example ? '<br>例：' + escapeHtml(p.example) : '');
      }).join('<br>'));
    }
    return parts.join('<br><br>');
  }

  function csvCell(value) {
    return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  }

  /** 两列 Anki CSV：正面 = 选中原文，背面 = 结构化解析。 */
  function toAnkiCsv(items) {
    return (items || []).map(function (it) {
      var front = String((it && it.text) || '').replace(/\s+/g, ' ').trim();
      return csvCell(front) + ',' + csvCell(ankiBack(it));
    }).join('\r\n');
  }

  function toMarkdown(items) {
    var out = ['# SelectEnglish 导出', ''];
    (items || []).forEach(function (it, i) {
      out.push('## ' + (i + 1) + '. ' + String((it && it.text) || ''));
      if (it && it.context && it.context !== it.text) out.push('', '> ' + it.context);
      var meta = [];
      if (it && it.createdAt) meta.push(it.createdAt);
      if (it && it.title) meta.push(it.title);
      if (it && it.url) meta.push(it.url);
      if (meta.length) out.push('', '<sub>' + meta.join(' · ') + '</sub>');
      var plain = toPlainText(it && it.analysis);
      if (plain) out.push('', plain);
      out.push('');
    });
    return out.join('\n');
  }

  var api = {
    MAX_TEXT: MAX_TEXT,
    MAX_CONTEXT: MAX_CONTEXT,
    SYSTEM_PROMPT: SYSTEM_PROMPT,
    truncate: truncate,
    buildMessages: buildMessages,
    extractJson: extractJson,
    normalizeAnalysis: normalizeAnalysis,
    isEmptyAnalysis: isEmptyAnalysis,
    toPlainText: toPlainText,
    demoAnalysis: demoAnalysis,
    looksLikeEnglish: looksLikeEnglish,
    pickVoice: pickVoice,
    escapeHtml: escapeHtml,
    ankiBack: ankiBack,
    toAnkiCsv: toAnkiCsv,
    toMarkdown: toMarkdown
  };

  global.SELib = api;
})(typeof self !== 'undefined' ? self : globalThis);
