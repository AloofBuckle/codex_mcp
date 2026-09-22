# 已确认 API 表面

来源：用户提供的信息。运行期核验见 artifacts/api-surface.snapshot.json；方法存在不等于外部依赖已经可用。

## cua

`getState`、`listBrowsers`、`getBrowser`、`createBrowserTab`、`getTab`、`listTabs`

## browser

`documentation`、`history`、`nameSession`

## browser.tabs

`new`、`selected`、`list`、`get`

## browser.capabilities

`list`、`get`

## tab

`getAXState`、`getScreenshot`、`getAXStateAndScreenshot`、`paste`、`click`、`drag`、`pressKey`、`scroll`、`selectText`、`setValue`、`typeText`、`performSecondaryAction`、`goto`、`back`、`forward`、`reload`、`close`、`title`、`url`、`getJsDialog`、`markDeliverable`、`markHandoff`

## tab.ax

`get`、`write`、`click`、`drag`、`performSecondaryAction`、`pressKey`、`scroll`、`selectText`、`setValue`、`typeText`

## tab.playwright

`goBack`、`goForward`、`evaluate`、`locator`、`getByRole`、`getByText`、`getByLabel`、`getByPlaceholder`、`getByTestId`、`frameLocator`、`waitForURL`、`waitForLoadState`、`waitForTimeout`、`waitForEvent`、`expectNavigation`、`elementInfo`、`elementScreenshot`、`domSnapshot`

## locator

`click`、`dblclick`、`fill`、`type`、`pressSequentially`、`press`、`setChecked`、`check`、`uncheck`、`selectOption`、`waitFor`、`count`、`all`、`textContent`、`innerText`、`allTextContents`、`getAttribute`、`isVisible`、`isEnabled`、`evaluate`、`evaluateAll`、`locator`、`first`、`last`、`nth`、`and`、`or`、`filter`、`getByRole`、`getByText`、`getByLabel`、`getByPlaceholder`、`getByTestId`、`downloadMedia`

## frameLocator

`locator`、`frameLocator`、`getByRole`、`getByText`、`getByLabel`、`getByPlaceholder`、`getByTestId`

## tab.content

`export`、`exportGsuite`、`exportYouTubeTranscript`

## tab.clipboard

`read`、`readText`、`write`、`writeText`

## tab.dev

`logs`

## tab.capabilities

`list`、`get`

## visibility

`documentation`、`get`、`set`

## viewport

`documentation`、`set`、`reset`

## pageAssets

`documentation`、`list`、`bundle`

## webmcp

`documentation`、`fetchTools`

## cdp

`documentation`、`send`、`readEvents`

## Native CUA：社区行为对齐与 Linux 扩展

来源、固定版本与输出格式详见 `docs/NATIVE_CONTRACT.md`；不宣称未获取的官方
完整 schema 或内部实现逐字等价。原生后端是本项目独立 Rust/Linux 系统调用实现，
不再使用 trycua。

`cua`：`nativeDocumentation`、`listApps`、`getApp`、`launchApp`、`listWindows`、
`getWindow`、`getComputer`。`getState()` 新增 `apps`，移除旧 `native.sessions`。

App/Window：`getAXState`、`getScreenshot`、`getAXStateAndScreenshot`、`click`、`drag`、
`pressKey`、`scroll`、`setValue`、`typeText`、`performSecondaryAction`、`activate`、`close`。
App 还有 `windows`、`getWindow`、`waitForWindow`。`getState` 返回结构化 Window2 state。

`cua.getComputer()` 返回的 Window2 原语按固定社区源码顺序：

`list_windows`、`list_apps`、`get_window`、`launch_app`、`activate_window`、
`get_window_state`、`click`、`type_text`、`press_key`、`scroll`、`drag`、`set_value`、
`perform_secondary_action`；末尾 `documentation`、`health`、`get_desktop_state` 是本地扩展。

不新增平铺的 MCP tool，不新建 namespace，不添加要求填写的 session 字段。
`createNativeSession/listNativeSessions/getNativeSession` 已从当前模型 API 移除。
