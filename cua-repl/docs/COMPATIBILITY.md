# 兼容性边界与证据

本项目实现用户提供的稳定 **CUA MCP 调用结构与浏览器 API 表面**。它不是官方
Codex Desktop、Owl、`@oai/browser-desktop` 或 Guardian 的重新分发版本。

## 实现与验证范围

浏览器与原生桌面采用无会话所有权的 MCP 资源视图。`turn_ended` 只确认结束，
不自动关闭标签页、窗口或应用，也不取消其他调用。`js_reset` 重置 JavaScript，
真实资源继续存在，可按 ID 重新绑定；没有强制的 `getState` 初始化顺序。
AX 默认返回完整观察，有限的索引上下文只用于验证目标，避免把旧索引用于新元素。
本轮验证结果见 `artifacts/stateless-review/`；旧 native-new 证据不能代替本轮 GPU/网络实测。

| 范围 | 实现及证据 |
|---|---|
| MCP | `cua_repl` 下 `js`、`js_add_node_module_dir`、`js_reset`、`turn_ended`、`cua_live`、`viewer_session`；stdio 与认证 Streamable HTTP |
| 持久 REPL | Node 24 LTS 真实 Node REPL，跨调用变量/句柄、顶层 await、异常、PNG 输出、超时及取消、过期回调拦截；额外 `node_modules` 搜索根支持 `import()`/`require()` 且跨 `js_reset` 保留 |
| CUA/Browser/Tab | 用户提供的 IAB 顶层及浏览器方法可由模型调用，真实 primitive `tab.id`、同步 Locator 构造；IAB 不伪造 `tab.cua`/`tab.dom_cua` |
| IAB | 自己的持久 Google Chrome profile；GUI 与模型共同操作；与外部 CDP profile Cookie 隔离 |
| Extension backend | 自有 MV3 扩展 + Native Messaging host + 本地 socket + `chrome.debugger`；真实 handshake、tab discovery/claim/new、Playwright-shaped DOM/locator、`cua`、`dom_cua`、AX/screenshot、raw CDP 端到端实测 |
| GUI | 认证网页控制台、鼠标键盘、地址栏、标签页、剪贴板；实时显示由独立服务提供，无审批面板 |
| 原生窗口 | 独立 Xvfb 上启动有头 Google Chrome；窗口隐藏/恢复不重建页面；测试不使用用户 :99 |
| Native Desktop | 独立 Linux CUA + 单个 systemd Sway 桌面；App 风格 AX 文本、Window2 结构、PNG、元素/像素操作、XWayland、自绘 OpenGL、REPL 重连与故障恢复实测；证据见 NATIVE_CONTRACT.md 与 native-new 产物 |
| Native Live | 独立 Rust WebRTC/DataChannel 服务；1920×1080 AV1、damage-driven VFR（120fps 上限/1fps idle heartbeat）、PTS pacing、stale GOP recovery、物理鼠标/键盘/滚轮、无 peer 时 encoder 自动退出均由真实 Google Chrome 端到端实测；GPU 由部署 YAML 选择并保持 compositor/capture/encoder 同设备 |
| AX | CDP Accessibility 树、多 frame 观察、单调索引、变更检测、过期索引拒绝、差分/完整状态、截图和组合观察 |
| Playwright | Locator/iframe/复合定位、表单、导航、DOM 只读检查、元素截图、下载与文件选择器 |
| 只读 evaluate | DOM/window/location/CSS 可用，navigator 隐藏；正向 AST 规则和 DOM 只读代理；不宣称是完整安全沙箱 |
| Clipboard | text/HTML/Markdown、格式化粘贴、模型快捷键与 GUI 的共享会话剪贴板 |
| pageAssets | 实际请求资源、限定 URL、携带专用 profile Cookie 的有界 GET、真实文件和 hash、拒绝路径穿越/符号链接 |
| CDP | 实际 send/events；full access，无开发模式或审批层 |
| WebMCP | 工具发现、可调用句柄、真实页面函数执行和导航失效；本环境成功执行的是明确标识的本地 shim |
| 外部 CDP | 仅连接宿主显式配置的测试自有 Google Chrome；发现/标签页/输入/独立 Cookie 实测 |
| 本地内容导出 | 输出真实 Markdown/HTML 文件，不用改扩展名伪造 Office/PDF |

## 不能冒充已完成的部分

**官方逐字 wire/schema/行为等价尚未认证。** 用户未提供官方 `tools/list` 原始响应、
完整初始化/生命周期消息记录或可供差分测试的官方运行时。本项目维持所确认的结构，
但不能据此保证 JSON Schema 描述/默认值、隐藏属性、完整 prototype 结构、错误文本、
AX 序列化文本或未描述的生命周期分支逐字相同。`js_reset` 的具体名称和 schema
属于本项目明确记录的兼容选择，而不是已核对过的官方工具快照。

**Native 以固定社区证据为兼容基线，而非认证全部私有 API。** 参考 Windows Window2
参数/状态结构与实际 macOS App-state 调用记录，各自保留独立输出形式；不把它们合成
不存在的“官方规范”。Native OS backend 无 agent session、进程常驻；每个 RPC 仍只执行一个 native method，桌面也由 systemd 常驻。
不依赖 trycua 或 OpenAI 私有原生库。OS 层由本项目 Rust crate `native-rs/`
实现（systemd-owned Sway desktop + 常驻单-action RPC worker + Wayland actuator）。
原生方法通过 JS 对象提供；Live 预览和 viewer capability 刷新是独立工具。

**Native Live 的 AV1 边界。** 当前生产媒体 backend 为 AV1-only。Sway、capture、Chrome、
display 与 Native Live encoder 使用部署 YAML 指定的同一稳定 render node。`/health` 对 AV1 报告
`hardwareAvailable=true`、`backendReady=true`；Native Live 已通过真实 Google Chrome
1920×1080 WebRTC 解码、MWP1/OBU parser、idle encoder 生命周期和物理输入端到端测试。
不再保留旧 codec fallback。

**Native 的已知语义差异。** Linux PID/app_id/AX 角色/实际像素不可能与 macOS/Windows
相同；只匹配有证据的字段、调用和格式，不伪造内容、版本或使用次数。Sway 截图和像素
输入会激活窗口，不实现官方某些 macOS 路线的后台无焦点操作。AX 过期校验是本项目明确
定义的保守语义；不认证官方完整 renderer/error 行为。Minecraft 未作为真实应用测试。

**请求无状态不等于 backend 进程短命。** Rust backend 常驻，同一传输可连续处理独立 Window2 RPC；每个输入原语仍仅接收本次请求与本次提供的观察；索引
所需的有限 AX 快照由 Node 客户端保存，并在变更、过期或重置/取消时失效，结束轮次不改变它。不创建 Agent session
或临时桌面；REPL 重启不影响 App。实际桌面进程崩溃仍会断开 GUI 客户端，不能恢复未保存数据。

**Extension API 是后端专属增量，不重新定义旧 IAB contract。** 社区可观察到的
Chrome 路径有 `browser.user.openTabs()/claimTab()`、`browser.tabs.finalize()`、
`tab.cua`、`tab.dom_cua` 等；这些只在 extension Browser/Tab 上公布。当前 extension
实现尚未把 IAB 的所有高级能力一比一搬过去：跨域 FrameLocator、download/filechooser
wait、pageAssets/WebMCP、丰富 Workspace/YouTube 导出仍以 IAB 为完整实现，extension
路径会明确返回 unsupported，而不是假成功。

**Google Workspace 和 YouTube 的真实账号/联网导出未验证。** 原生导出 endpoint、
URL/格式校验、签名校验与文件写入路径已实现；缺少授权账号时无法证明所有文档格式
在真实账号里都成功。Google 文档 Markdown 目前通过文本导出转换，复杂版式不保证
保真；电子表格 Markdown 通过 CSV 转换。YouTube 依赖实际页面可见的字幕源，可能
因站点变更、登录、地区和版权限制不可用。不会绕过登录、付费墙或 TLS 警告。

**原生 WebMCP 未通过本环境的成功执行测试。** 默认仅在本地测试 origin 上安装
明确标识的 shim；`fetchTools()` 返回 mode。已实现现代 document.modelContext 和
旧 testing API 的检测适配，但其正式原生执行兼容性仍需目标浏览器验证。不会偷偷
开启实验性浏览器 flag 来伪造支持。

**只实现 full access。** 本项目不实现用户审批、自动审批、confirmation policy
元数据或 MCP elicitation 授权层。表单提交、文件上传、WebMCP、CDP 写操作和外部
导出均直接执行。GUI 与模型可并发控制同一浏览器；不存在 human/model 写入锁，也不是 Guardian
或授权系统，也不声称兼容 Codex 的其他访问模式。

## 有意采用的保守语义

AX 索引绝不回收给新元素；不确定是否仍有效时宁可要求重新观察。截图和 UI 变化
使旧索引失效。只读 evaluator 是受限语法子集，动态属性/循环等即使在官方实现可用，
在本实现也可能被拒绝。会话句柄隔离不是 profile Cookie 的多租户隔离。

Node REPL 对含 top-level await 的 `const` 声明存在原生转换语义：与普通独立
`const` 声明不完全等价。本项目保留真实 Node REPL 行为，不宣称这一细节等同
于未知的官方 REPL。超时可终止模型 worker 并拒绝后续动作，已经发送到浏览器或
远端服务的请求未必能够撤回。

## 快照与测试文件

`acceptance/contract.json` 是用户要求；`artifacts/api-surface.snapshot.json` 是实际
模型可见对象快照；`artifacts/tools-list.snapshot.json` 是本项目实际 MCP 工具列表。
方法存在测试和真实执行测试分别列出，结果见 `artifacts/TEST_REPORT.md`。
