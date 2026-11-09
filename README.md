# SelectEnglish · 划词阅读助手（浏览器版）

> 这是 [James-Yao-xj/SelectEnglish](https://github.com/James-Yao-xj/SelectEnglish) 的**浏览器复刻版**。
> 原项目是 macOS 原生 App（Swift/AppKit，需要 Force Touch 触控板），Windows 上的 Edge/Chrome **无法安装**它；
> 本扩展把它的核心体验搬到浏览器里：**选中英文 → 牛皮纸小窗 → 「生词 → 整句解释 → 固定表达」**。

> **⚠️ 不内置任何 API Key，也不提供官方接口。**
> AI 能力由**你自己配置**：填一个 OpenAI 兼容接口（DeepSeek、硅基流动、OpenAI、本地 Ollama 等）的地址、模型名和你的 Key。
> 没配之前也能用：打开设置页勾选 **「演示模式」**，选中英文会返回内置示例，先看效果、不联网、不花钱。

## 安装（Microsoft Edge / Chrome，约 30 秒）

1. 在本页右侧 **Releases** 下载最新的 `select-english-extension-vX.Y.Z.zip`，解压。
2. 地址栏打开 `edge://extensions/`（Chrome 用 `chrome://extensions/`）。
3. 打开左下角 **「开发人员模式」** 开关。
4. 点 **「加载解压缩的扩展」**，选中解压出来的文件夹（**里面直接有 `manifest.json` 的这一层**）。
5. 安装后自动打开设置页：
   - 想先看效果 → 勾选 **「演示模式」**，保存，随便选段英文试试；
   - 想真实分析 → 填 **接口地址 / 模型 / API Key**，关掉演示模式，点「保存」→「测试连接」。

> 加载后扩展会一直保留，**不要移动或删除这个解压目录**。

## 配置（Key 由你自己提供）

| 项 | 说明 |
| --- | --- |
| 接口地址 | OpenAI 兼容的 `chat/completions`，例如 `https://api.deepseek.com/v1`。填到 `/v1` 或直接填完整地址都行。 |
| 模型 | 例如 `deepseek-chat`；换成你所用服务商的模型名即可。 |
| API Key | **你自己的 Key**，只保存在浏览器本地存储里，不写进任何文件、不上传；网页脚本读不到。 |
| 演示模式 | 不联网、不调用接口，返回内置示例，供没配 Key 时体验。 |
| 触发方式 | 默认「选中后出现小圆钮，点击查询」；也可改成「选中即自动查询」。 |
| 请求 JSON 模式 | 默认开。若你的接口不支持 `response_format`，扩展会自动降级重试一次，也可以手动关掉。 |
| 温度 | 模型回答的随机程度：0 最稳定，越大越发散；查词建议 0–0.5（默认 0.3）。 |

## 使用

- 用鼠标选中一段英文 → 出现小圆钮「译」→ 点它；也可以 **在选中文本上点右键 →「查询选中的英文」**，或按 <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>E</kbd>。
- 小窗顺序固定：**生词**（词性 + 中文释义，优先六级及以上词汇、专业词、熟词僻义；单独选一个词时一定解释这个词）→ **整句解释**（译文 + 语境解释）→ **固定表达**（释义 + 例句）。
- 小窗右上角：**🔊** 朗读选中内容（每个生词后还有单独的小喇叭）、**☆** 收藏、**⧉** 复制、**✕** 关闭；点空白处或按 <kbd>Esc</kbd> 也可关闭。朗读用浏览器自带语音，优先美音，不走 API、不计费。
- **按住小窗顶部或底部可以拖动**，本次会话内会记住摆放位置；小窗和设置页都会跟随系统深色模式自动切换成深色纸面。
- 同一选区会复用最近一次结果（10 分钟内）；修改接口/模型/Key 后缓存自动作废。
- 每次查询自动记入 **历史**（可在设置里关掉，最多 300 条，只存本机）。
- 收藏和历史都在设置页查看/删除，并可导出 **Anki CSV**（导入 Anki 时勾选「允许在字段中使用 HTML」）、**Markdown** 或 **JSON**。

## 隐私

- 只有你主动查询时，才会把 **选中的英文 + 所在句子上下文 + 网页标题** 发给你自己填的 AI 接口；演示模式下完全不联网。
- 不做任何遥测，不连任何第三方服务器，收藏和查询历史只在本机（历史可在设置里关闭或随时清空）。
- API Key 只存在扩展自身的本地存储里（设置页与后台可读）；**网页脚本和页面里的代码都拿不到**，也不会写进任何文件。修改接口/模型/Key 后会自动作废缓存。
- 页面脚本无法读取小窗内容（closed Shadow DOM），模型输出一律按纯文本渲染（不使用 `innerHTML`）。
- 朗读只调用浏览器自带的 `speechSynthesis`，文本不离开本机。

## 目录结构

```
select-english-extension/
├─ manifest.json          MV3 清单
├─ src/
│  ├─ lib.js              纯函数：提示词、JSON 抽取、结果归一化（可单测）
│  ├─ styles.js           牛皮纸弹窗样式（构造式样式表，绕过页面 CSP）
│  ├─ content.js          划词交互、小圆钮、小窗渲染（不接触 API Key）
│  ├─ background.js       Service Worker：唯一持有 Key、调用接口、缓存
│  ├─ options.html/css/js 设置页 + 收藏/历史管理
├─ icons/                 扩展图标（由 tools/make_icons.py 生成）
├─ tests/                 单元测试与结构自检
└─ tools/                 make_icons.py、ci.yml（工作流模板）
```

## 打包

仓库根目录就是扩展根目录（`manifest.json` 在最外层）。在自己的克隆目录里：

```powershell
New-Item -ItemType Directory -Force -Path dist | Out-Null
Compress-Archive -Path manifest.json, src, icons, README.md, LICENSE -DestinationPath "dist/select-english-extension-v0.3.0.zip" -Force
```

`dist/` 已在 `.gitignore` 里。**API Key 永远不会进这个包**：它只存在浏览器本地存储中。

CI 工作流模板在 `tools/ci.yml`（跑测试 + 打 zip 构件）。启用方式：仓库 Settings → Actions 允许工作流后，
把该文件复制到 `.github/workflows/ci.yml` 再提交即可（用命令行提交需要 token 具备 `workflow` 权限：
`gh auth refresh -h github.com -s workflow`）。

## 测试

```powershell
node tests\lib.test.mjs         # 提示词 / JSON 解析（含截断抢救）/ 归一化 / 朗读选声 / Anki … 70 项
node tests\check-manifest.mjs   # MV3 结构、文件引用、安全不变量 ……………………………… 31 项
node tests\background.test.mjs  # 后台全链路：请求/缓存/历史/菜单/演示模式（假 chrome+fetch）… 77 项
node tests\content-dom.test.mjs # 划词交互 DOM 冒烟：圆钮/弹窗/收藏/朗读/拖动/启停/键盘选区 … 56 项
```

合计 234 项断言，全部通过。

- `background.test.mjs` 与 `content-dom.test.mjs` 会真正执行 `src/background.js` 与 `src/content.js`，不是只做字符串检查。
- `content-dom.test.mjs` 需要 jsdom（`npm i jsdom`，并把 `SE_JSDOM_DIR` 指向装它的目录；没装时该测试自动 SKIP 而不是失败）。

## 已知边界

- 只在顶层文档生效（`all_frames: false`），iframe 里的选区暂时不响应。
- 不处理图片、扫描 PDF 的文字（原 App 同样不支持 OCR）。
- 小说排版类整段选择可能命中 1500 字上限，超出部分会被截断。
- 收藏最多保留 300 条 / 约 4 MB，历史最多 300 条（浏览器本地存储配额），超出会从最旧的开始丢。
- 接口地址以 `http://` 开头时，Key 会明文传输；建议只用 `https://`。
- 朗读音质取决于系统安装的语音包（Windows 自带微软语音，英文足够用）。
- 版式与提示词参考原项目（MIT），本扩展为独立实现。
