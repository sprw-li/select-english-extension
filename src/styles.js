/*
 * SelectEnglish for Browser — 弹窗样式
 * 放进 Shadow DOM 的 constructed stylesheet（page CSP 不会拦），
 * 视觉上复刻原 App v0.9.2 起的牛皮纸小窗。
 */
(function (global) {
  'use strict';

  var CSS = [
    ':host, * { box-sizing: border-box; }',
    '.se-ui { position: fixed; z-index: 2147483647; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", sans-serif; color: #3B2A1A; font-size: 13px; line-height: 1.6; text-align: left; }',
    '.se-ui * { margin: 0; padding: 0; }',

    /* 选中后出现的小圆钮 */
    '.se-bubble { position: fixed; width: 30px; height: 30px; border-radius: 50%; display: flex; align-items: center; justify-content: center;',
    '  background: linear-gradient(160deg, #F8EFDE 0%, #E9D6B6 100%); border: 1px solid #C6AE8A; color: #5A4126;',
    '  font-size: 14px; font-weight: 600; cursor: pointer; user-select: none;',
    '  box-shadow: 0 3px 10px rgba(60, 40, 20, 0.30), inset 0 1px 0 rgba(255, 255, 255, 0.6); transition: transform .08s ease; }',
    '.se-bubble:hover { transform: scale(1.08); }',
    '.se-bubble:active { transform: scale(0.96); }',

    /* 牛皮纸面板 */
    '.se-panel { position: fixed; width: min(430px, calc(100vw - 20px)); max-height: min(72vh, 620px); overflow-y: auto; overscroll-behavior: contain;',
    '  padding: 12px 14px 11px; border: 1px solid #C6AE8A; border-radius: 14px;',
    '  background: radial-gradient(130% 90% at 10% 6%, rgba(255, 255, 255, 0.60), rgba(255, 255, 255, 0) 62%),',
    '    repeating-linear-gradient(112deg, rgba(150, 120, 80, 0.045) 0 2px, rgba(150, 120, 80, 0) 2px 6px),',
    '    linear-gradient(158deg, #F7EDDB 0%, #EFDFC4 100%);',
    '  box-shadow: 0 12px 30px rgba(60, 40, 20, 0.26), 0 2px 6px rgba(60, 40, 20, 0.16); }',
    '.se-panel::-webkit-scrollbar { width: 8px; }',
    '.se-panel::-webkit-scrollbar-thumb { background: rgba(150, 120, 80, 0.35); border-radius: 4px; }',

    '.se-head { display: flex; align-items: flex-start; gap: 8px; }',
    '.se-quote { flex: 1; min-width: 0; font-family: Georgia, "Times New Roman", "Songti SC", serif; font-size: 13.5px; color: #4A3520;',
    '  border-left: 3px solid #C6AE8A; padding-left: 8px; }',
    /* 按行裁断并带省略号，避免上一版的“半行字” */
    '.se-qtext { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden; }',
    '.se-quote .se-src { display: block; font-family: inherit; font-size: 11px; color: #8A7250; margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }',
    '.se-tools { display: flex; gap: 4px; flex: none; }',
    '.se-icon { width: 26px; height: 26px; border-radius: 8px; border: 1px solid transparent; background: rgba(255, 255, 255, 0.45);',
    '  color: #5A4126; cursor: pointer; font-size: 13px; line-height: 1; display: flex; align-items: center; justify-content: center; }',
    '.se-icon:hover { background: rgba(255, 255, 255, 0.85); border-color: #C6AE8A; }',
    '.se-icon[data-on="1"] { background: #E4C98F; border-color: #B99A62; }',

    '.se-body { margin-top: 10px; }',
    '.se-sec + .se-sec { margin-top: 9px; padding-top: 9px; border-top: 1px dashed rgba(150, 120, 80, 0.38); }',
    '.se-label { font-size: 11px; letter-spacing: .14em; color: #8A7250; margin-bottom: 5px; }',
    '.se-word { display: flex; flex-wrap: wrap; gap: 4px 6px; padding: 2px 0; }',
    '.se-word b { font-family: Georgia, "Times New Roman", serif; font-weight: 700; color: #2F2113; }',
    '.se-pos { font-size: 11px; color: #7A6242; background: rgba(198, 174, 138, 0.28); border-radius: 5px; padding: 0 4px; }',
    '.se-meaning { color: #3B2A1A; }',
    '.se-sentence .se-tr { font-weight: 600; color: #33240F; }',
    '.se-sentence .se-ex { color: #4A3520; margin-top: 2px; }',
    '.se-phrase { padding: 2px 0; }',
    '.se-phrase b { font-family: Georgia, "Times New Roman", serif; color: #2F2113; }',
    '.se-phrase .se-ex { color: #6B5537; font-size: 12px; }',
    '.se-empty { color: #8A7250; }',

    '.se-status { display: flex; align-items: center; gap: 8px; color: #6B5537; }',
    '.se-dots { display: inline-flex; gap: 3px; }',
    '.se-dots i { width: 5px; height: 5px; border-radius: 50%; background: #A98B5F; animation: se-bounce 1s infinite ease-in-out; }',
    '.se-dots i:nth-child(2) { animation-delay: .15s; }',
    '.se-dots i:nth-child(3) { animation-delay: .3s; }',
    '@keyframes se-bounce { 0%, 80%, 100% { transform: translateY(0); opacity: .45; } 40% { transform: translateY(-3px); opacity: 1; } }',

    '.se-error { color: #8C2F1F; white-space: pre-wrap; word-break: break-word; }',
    '.se-actions { display: flex; gap: 6px; margin-top: 8px; }',
    '.se-btn { border: 1px solid #C6AE8A; background: rgba(255, 255, 255, 0.55); color: #5A4126; border-radius: 8px;',
    '  padding: 3px 10px; font-size: 12px; cursor: pointer; }',
    '.se-btn:hover { background: rgba(255, 255, 255, 0.95); }',
    '.se-foot { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: 10px; padding-top: 7px;',
    '  border-top: 1px solid rgba(150, 120, 80, 0.30); font-size: 11px; color: #8A7250; }',
    '.se-raw { white-space: pre-wrap; word-break: break-word; font-family: Consolas, Menlo, monospace; font-size: 12px; color: #4A3520; }',

    /* 朗读按钮 + 拖动 */
    '.se-say { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; margin-left: 2px;',
    '  border-radius: 5px; font-size: 11px; color: #7A6242; cursor: pointer; opacity: .55; vertical-align: -2px; }',
    '.se-say:hover { opacity: 1; background: rgba(198, 174, 138, 0.35); }',
    '.se-head, .se-foot { cursor: grab; user-select: none; }',
    '.se-head .se-quote, .se-head .se-tools, .se-foot button { user-select: text; }',
    '.se-panel.se-dragging { cursor: grabbing; }',

    /* 深色模式：深棕纸面 */
    '@media (prefers-color-scheme: dark) {',
    '  .se-ui { color: #E4D6BE; }',
    '  .se-bubble { background: linear-gradient(160deg, #4A3A28 0%, #37291B 100%); border-color: #6B5638; color: #E4D6BE;',
    '    box-shadow: 0 3px 10px rgba(0, 0, 0, 0.55), inset 0 1px 0 rgba(255, 255, 255, 0.08); }',
    '  .se-panel { border-color: #6B5638;',
    '    background: radial-gradient(130% 90% at 10% 6%, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0) 62%),',
    '      repeating-linear-gradient(112deg, rgba(230, 205, 165, 0.03) 0 2px, rgba(230, 205, 165, 0) 2px 6px),',
    '      linear-gradient(158deg, #31261A 0%, #271D12 100%);',
    '    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.4); }',
    '  .se-quote { color: #D8C6A8; border-left-color: #6B5638; }',
    '  .se-quote .se-src { color: #9A8464; }',
    '  .se-icon { background: rgba(255, 255, 255, 0.07); color: #E4D6BE; }',
    '  .se-icon:hover { background: rgba(255, 255, 255, 0.16); border-color: #6B5638; }',
    '  .se-icon[data-on="1"] { background: #6B5638; border-color: #8A7250; }',
    '  .se-sec + .se-sec { border-top-color: rgba(230, 205, 165, 0.22); }',
    '  .se-label { color: #9A8464; }',
    '  .se-word b, .se-phrase b { color: #F0E4CE; }',
    '  .se-pos { color: #C9B18C; background: rgba(230, 205, 165, 0.14); }',
    '  .se-meaning, .se-sentence .se-ex { color: #E4D6BE; }',
    '  .se-sentence .se-tr { color: #F4EBD8; }',
    '  .se-phrase .se-ex { color: #B9A17C; }',
    '  .se-empty { color: #9A8464; }',
    '  .se-status { color: #B9A17C; }',
    '  .se-dots i { background: #A98B5F; }',
    '  .se-error { color: #E08A76; }',
    '  .se-btn { border-color: #6B5638; background: rgba(255, 255, 255, 0.07); color: #E4D6BE; }',
    '  .se-btn:hover { background: rgba(255, 255, 255, 0.16); }',
    '  .se-foot { border-top-color: rgba(230, 205, 165, 0.18); color: #9A8464; }',
    '  .se-raw { color: #D8C6A8; }',
    '  .se-say { color: #C9B18C; }',
    '  .se-say:hover { background: rgba(230, 205, 165, 0.18); }',
    '}',

    /* 解析失败时的原始输出：默认折叠，免得糊一脸 */
    '.se-rawwrap summary { cursor: pointer; font-size: 11px; color: #8A7250; letter-spacing: .05em; }',
    '.se-rawwrap summary:hover { color: #5A4126; }',
    '@media (prefers-color-scheme: dark) {',
    '  .se-rawwrap summary { color: #9A8464; }',
    '  .se-rawwrap summary:hover { color: #E4D6BE; }',
    '}'
  ].join('\n');

  global.SE_STYLES = CSS;
})(typeof self !== 'undefined' ? self : globalThis);
