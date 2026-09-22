import fs from 'node:fs/promises';
const tap = await fs.readFile('artifacts/all-tests.tap', 'utf8');
const count = (name) => Number(tap.match(new RegExp(`^# ${name} (\\d+)$`, 'm'))?.[1] || 0);
const acceptance = JSON.parse(await fs.readFile('artifacts/independent-acceptance.json', 'utf8'));
const surface = JSON.parse(await fs.readFile('artifacts/api-surface.snapshot.json', 'utf8'));
const webmcp = JSON.parse(await fs.readFile('artifacts/webmcp-runtime.json', 'utf8'));
let nativeSmoke = '';
try {
  nativeSmoke = (await fs.readFile('artifacts/native-smoke.log', 'utf8')).trim();
} catch {}
let nativeLiveSmoke = '';
try {
  nativeLiveSmoke = (await fs.readFile('artifacts/native-live-smoke.log', 'utf8')).trim();
} catch {}
let audit = null;
try {
  audit = JSON.parse(await fs.readFile('artifacts/npm-audit.json', 'utf8'));
} catch {}
const nativeSummary =
  nativeSmoke.split('\n').find((line) => line.startsWith('native smoke: PASS')) ?? 'not passed';
const nativePassed = nativeSummary !== 'not passed';
const nativeLiveSummary =
  nativeLiveSmoke.split('\n').find((line) => line.startsWith('Native Live: PASS')) ?? 'not passed';
const nativeLivePassed = nativeLiveSummary !== 'not passed';
let nativeEvidence = null;
try {
  nativeEvidence = JSON.parse(await fs.readFile('artifacts/native-new/test-results.json', 'utf8'));
} catch {}
let recoveryEvidence = null;
try {
  recoveryEvidence = JSON.parse(
    await fs.readFile('artifacts/native-new/recovery-results.json', 'utf8'),
  );
} catch {}
const report = {
  generatedAt: new Date().toISOString(),
  nodeTest: {
    tests: count('tests'),
    pass: count('pass'),
    fail: count('fail'),
    skipped: count('skipped'),
    note: 'Node count includes parent test cases.',
  },
  stdioAcceptance: { pass: acceptance.passed, fail: acceptance.failed },
  nativeDesktop: {
    pass: nativePassed,
    summary: nativeSummary,
    checks: nativeEvidence?.results?.length ?? 0,
    recovery: recoveryEvidence?.checks ?? [],
  },
  nativeLive: { pass: nativeLivePassed, summary: nativeLiveSummary },
  surface: { requiredMethodPositions: surface.requiredMethodCount, missing: surface.missing },
  environment: surface.environment,
  webmcpMode: webmcp.mode,
};
report.dependencyAudit = audit?.metadata?.vulnerabilities ?? { status: 'not available' };
await fs.writeFile('artifacts/TEST_REPORT.json', JSON.stringify(report, null, 2));
const lines = [
  '# 自测报告',
  '',
  `生成时间：${report.generatedAt}`,
  '',
  '## 实际执行结果',
  '',
  `- Node 集成/安全/GUI/后端测试：${report.nodeTest.pass}/${report.nodeTest.tests} 通过，${report.nodeTest.fail} 失败，${report.nodeTest.skipped} 跳过。Node 计数包括父测试。`,
  `- 独立 stdio MCP 黑盒验收：${acceptance.passed} 通过，${acceptance.failed} 失败。`,
  `- Linux Native Desktop：${nativePassed ? '通过' : '未通过'}；${nativeSummary}。`,
  `- Native Live WebRTC：${nativeLivePassed ? '通过' : '未通过'}；${nativeLiveSummary}。`,
  `- 模型可见对象快照：${surface.requiredMethodCount} 个要求的方法位置已存在，缺失 ${surface.missing.length}；这证明表面覆盖，不等同于每个外部服务都经过成功调用。`,
  `- 运行环境：${surface.environment.node}；${surface.environment.chrome}。`,
  `- 本地测试页面 WebMCP 模式：${webmcp.mode}，不冒充原生 WebMCP。`,
  '',
  `- npm 依赖审计：${report.dependencyAudit.total === undefined ? '本次无有效审计结果' : report.dependencyAudit.total + ' 个已报告漏洞'}。这不是不存在其他安全风险的证明。`,
  '',
  '## 执行命令',
  '',
  '```sh',
  'npm ci',
  'npm run test:all',
  '```',
  '',
  '## 实际覆盖',
  '',
  '真实 Google Chrome 页面；stdio/HTTP MCP；持久 REPL/顶层 await/取消/超时；AX 索引失效；PNG；Locator/iframe；DOM/CSS 只读检查；文本、HTML、Markdown 粘贴；文件上传选择器和下载；页面资源文件；full-access CDP；WebMCP 注册、发现、直接执行、导航失效；双客户端所有权；GUI 实际鼠标键盘输入、并发控制、地址栏、Cookie 登录认证；独立 CDP 浏览器与 IAB 的 Cookie 隔离；独立 Xvfb 上的原生 Google Chrome 窗口；MV3 extension + Native Messaging + chrome.debugger 的真实 handshake，以及 extension tab discovery/claim/new、Playwright-shaped DOM/locator、dom_cua、cua、screenshot、raw CDP 和 finalize provenance 生命周期；独立无会话 Linux Native 常驻单-action RPC worker + 单个 systemd Sway 1920×1080 桌面；App AX 文本、Window2 状态/回执、真实截图、元素/像素输入、Unicode、滚动拖拽、XWayland、自绘 OpenGL、REPL reset/退出后的 App 保留，以及独立恢复测试；独立 Native Live WebRTC AV1 1920×1080、DataChannel 物理鼠标/键盘/滚轮和 idle encoder shutdown。',
  '',
  '## 尚不能证明的部分',
  '',
  '没有官方 cua_repl tools/list、原始消息录制及官方运行时供差分测试，因此不能认证官方描述、完整 schema、所有隐藏属性、AX 文本格式、错误文本、Guardian 行为或 OpenAI 私有 Chrome extension wire protocol 逐字一致。项目实现的是公开可观察架构/对象表面的独立 extension backend，不冒充官方 extension ID/native host/runtime。原生 Windows/macOS App 控制仍未实现；Google Workspace 登录态导出及真实 YouTube 字幕联网未验证。原生 WebMCP 不在本次成功执行证据之内。详见 docs/COMPATIBILITY.md。',
  '',
  '## 证据文件',
  '',
  '`all-tests.tap`、`junit.xml`、`native-smoke.log`、`native-live-smoke.log`、`independent-acceptance.json`、`api-surface.snapshot.json`、`tools-list.snapshot.json`、`webmcp-runtime.json`。',
  '',
  '图像：`gui-live.png`、`gui-final.png`、`native-window-page.png`、`independent-browser.png`。',
  '',
  '这些测试不读取原有浏览器 9222、用户原有 DISPLAY :99、用户 Chrome/Edge profile、或用户的账号凭据。',
  '',
];
await fs.writeFile('artifacts/TEST_REPORT.md', lines.join('\n'));
if (
  report.nodeTest.fail ||
  acceptance.failed ||
  !nativePassed ||
  !nativeLivePassed ||
  surface.missing.length
)
  process.exitCode = 1;
console.log(JSON.stringify(report, null, 2));
