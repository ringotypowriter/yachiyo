---
name: yachiyo-generative-ui
description: 当用户需要在对话中使用交互计算器、动态图表、可视化解释或小型交互体验时使用。通过 renderUi 在桌面原生聊天内生成隔离运行的 HTML、CSS 和 JavaScript。
---

# 对话内交互 UI

只有交互或可视化能帮助用户理解、探索或完成任务时才调用 `renderUi`。普通回答、表格和代码说明仍使用聊天文本；不要为了装饰调用工具。先确认当前工具可用，再按 title、css、html、js 顺序提供字符串，便于先显示样式和静态内容。标题简短，HTML、CSS 和 JS 合计不超过 UTF-8 256 KiB。

生成 HTML fragment，不写完整文档、meta、base 或嵌套 iframe。将样式放在 css，将执行代码放在 js；用 `addEventListener` 绑定交互，不使用 HTML 内的 script 或事件属性。JavaScript 只有工具成功完成后才运行，生成过程中静态 HTML 必须也有可读内容。使用浏览器原生能力；图表可以用 Canvas 或 SVG，不依赖 CDN、外部库、fetch、网络、Node、文件或宿主 API。没有经过工具获取的数据，不承诺实时结果。

界面使用请求的语言，采用响应式布局、清晰的输入标签和键盘可用的控件。内容直接融入消息流，外层保持透明，不加卡片边框、阴影、标题栏或整页背景，也不要用一层大面板把整个体验包起来；标题仅在说明内容确实需要时使用，不重复聊天中已经给出的说明。沙箱已继承应用的字体和主题色，默认控件也有基础样式；沿用这些样式，不另做一套页面皮肤。需要自定义时使用 `--yachiyo-font-ui` 和 `rgb(var(--yachiyo-rgb-ink))`、`rgb(var(--yachiyo-rgb-accent))` 等原生主题变量。适应消息宽度以及浅色、深色主题；可通过 `html[data-theme='dark']` 做必要调整。不要固定大宽度、设置满屏高度或自行做全屏按钮，宿主会提供可选全屏。避免过多留白。对计算输入、单位和边界给出明确反馈。优先小而完整的体验，不制作多页面应用。

沙箱提供 `window.yachiyoUi.reportHeight(height)`、`window.yachiyoUi.openLink(url)`、`window.yachiyoUi.continueConversation(text)`。高度会被宿主限制；链接只支持 HTTP/HTTPS，链接和继续对话都只是向用户提出待确认请求。用户确认后才打开链接或将文字追加到草稿，不会自动发送消息。不要把这两个 API 当作自动化能力，也不要尝试绕过确认。

交互 UI 仅在 Electron 原生聊天中执行。其他客户端显示标题或源码降级，不承诺手机或远程网页能交互。源码会随消息保存，但内部点击状态不会持久化；Reset、历史重新挂载或虚拟滚动卸载后应能从初始状态正常使用。完成后用简短文本解释重要假设或使用方式，不重复整份源码。
