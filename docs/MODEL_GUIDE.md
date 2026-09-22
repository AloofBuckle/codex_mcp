# Model-facing CUA guide

This server exposes `js`, `js_add_node_module_dir`, `js_reset`, `turn_ended`, `cua_live`, and `viewer_session` in MCP server `cua_repl`.

`js_add_node_module_dir({path:"/absolute/path/to/node_modules"})` adds one
REPL-wide package search root. It returns `true` when newly registered and
`false` when already present. Registered roots survive `js_reset`; package code
should normally be loaded with `await import("package-name")`.
The full model-visible name is normally `mcp__cua_repl__js` because the MCP client
adds its configured server namespace. It is not a separate wire tool named that.

## Live resource views / persistent variables

Use discovery when resource IDs are unknown:

```js
var state = await cua.getState();
```

Discovery is a read, not an initialization requirement. It can be combined with
other operations, and known IDs can be rebound directly after a reset.
The JavaScript REPL persists; browser/native views do not own resources or create
per-agent desktops. Every operation resolves an explicit live target.

```js
var browser = await cua.getBrowser({id: 'iab'});
var tab = await cua.createBrowserTab(browser.id, 'https://example.com', {visible: true});
await tab.getAXStateAndScreenshot();
```

Screenshots do not bake the MCP/agent cursor into the PNG by default. The
human GUI renders that cursor as a lightweight overlay, avoiding an expensive
image recomposition on every model observation. For cursor-placement debugging,
request it explicitly with `getScreenshot({includeAgentCursor:true})` or the
same option on `getAXStateAndScreenshot()`.

Use discovered browser/tab IDs, not assumed Windows/Edge IDs. `iab` is the isolated
Google Chrome backend alias. A browser of
`type: 'extension'` appears only after the packaged Google Chrome extension has completed
its Native Messaging handshake with this daemon.
API declarations are in `types/cua.d.ts`; the machine-readable required surface is
in `acceptance/contract.json`. Runtime guidance is returned by
`await browser.documentation()` and `await capability.documentation()`.

## Native apps on the system-owned Sway desktop

The desktop already exists. Do not create an agent/native session. `cua.getState()`
returns native `apps` alongside `browsers` and `errors`.

```js
var app = await cua.launchApp('/path/to/mcpbrowser-test-fixture', ['smoke']);
var win = await app.waitForWindow();
await win.getAXStateAndScreenshot();
```

Use the numbered element from the **latest** AX observation with `win.click(index)`
or `win.setValue(index,value)`. A changed tree rejects stale indexes. Pixel coordinates
are relative to the window-content screenshot, not the whole screen:

```js
await win.click([120,62]);
await win.typeText('hello');
await win.pressKey('ctrl+a');
```

Actions emit fresh App-style text and PNG by default. Pass `{emit:false}` as action or
observation options to suppress output. `getAXState()` returns text; `getScreenshot()`
returns Uint8Array; the combined observation returns `{state,screenshot}`.

`cua.listApps()`, `cua.getApp(id)`, `app.windows()`, and `cua.getWindow({app,id})`
rediscover and bind existing resources. `launchApp(command,args,{backend:'x11'})` runs
an X11-only app through the same desktop's XWayland. Managed apps have unique IDs
independent of launcher PID; ambiguous app names must be resolved via the app list.

`var computer = await cua.getComputer()` provides the community-observed Window2
methods. `computer.get_window_state({window,include_text:true})` returns
`{accessibility,screenshots,window}` and screenshot data URLs/IDs. It does not emit an
image automatically; call `nodeRepl.emitImage()` on decoded screenshot bytes when
using this low-level profile. Prefer the App/Window observation methods otherwise.

The native OS layer handles one stateless request at a time. No session token or
per-agent compositor is created. REPL reset, timeout, turn_ended and MCP client exit
invalidate observations but leave the actual apps and system-owned desktop alive.
Reacquire via `cua.getApp(id)` after reset. `await app.close()` closes a managed app's
systemd cgroup; it never stops Sway. GUI processes intentionally remain until closed.

Screenshots and pixel input activate the target on the dedicated native desktop.
This is not a guarantee of background/focus-free macOS behavior. Apps that expose no
meaningful AX tree remain screenshot/coordinate targets. Full Access is not a sandbox.
See `docs/NATIVE_CONTRACT.md` for the pinned references and tested limits.

## Extension-backed Google Chrome

The extension path is a second provider, not an alias for external CDP and not a
replacement for IAB. It mirrors the newer Codex Chrome-plugin shape observed in
the field:

```js
var ext = await cua.getBrowser({id:'extension'});
var candidates = await ext.user.openTabs({emit:false});
var claimed = await ext.user.claimTab(candidates[0]);
console.log(await claimed.playwright.domSnapshot());
console.log(await claimed.dom_cua.get_visible_dom());
```

`openTabs()` is discovery; `claimTab()` attaches `chrome.debugger` control to an
existing tab. `ext.tabs.list()` discovers live tabs, and `tabs.get(id)` can rebind
a released view. `ext.tabs.finalize({keep:[...]})` only detaches unkept debugger
views; it never closes underlying tabs, including tabs created through MCP.
Closing a claimed external tab remains protected; close it in the browser UI.
Extension tabs additionally expose `tab.cua`, `tab.dom_cua`, and
`tab.screenshot()`; those are extension-specific additions and are intentionally
not injected onto IAB tabs.

The current extension transport is MV3 service worker -> Native Messaging host ->
local daemon socket, with page control forwarded through `chrome.debugger` CDP.
The Playwright-shaped API is implemented by this project over that transport; it
does not embed or redistribute OpenAI's private browser client/runtime.

## Observe, act, observe

Observations auto-output text and images by default. `{emit:false}` suppresses
automatic output. Returned Uint8Array results become MCP PNG image blocks.
Do not additionally print an observation that has already emitted.

Use AX numeric indexes only from your latest valid observation. Mutations from
either the model or human invalidate them. A standalone screenshot invalidates
AX indexes; `getAXStateAndScreenshot` preserves the indexes in its returned state.
Each observation returns a full tree by default. `{disableDiffing:false}` is an
explicit incremental-output option, not a required session protocol. Actionable
entries contain explicit `actions=[...]`; only use those names with
`performSecondaryAction`.

Locators are constructed synchronously; actions/observations are async:

```js
await tab.playwright.getByRole('button', {name:/Switch to/}).click();
await tab.getAXStateAndScreenshot();
```

Iframe and compound locator examples:

```js
await tab.playwright.frameLocator('#frame').getByLabel('Name').fill('Alice');
var choices = tab.playwright.locator('.item').filter({hasText:'Example'});
console.log(await choices.count());
```

## Read-only page evaluator

```js
console.log(await tab.playwright.evaluate(() => ({
  title: document.title,
  url: location.href,
  background: getComputedStyle(document.body).backgroundColor,
  navigatorType: typeof navigator
})));
```

This returns DOM/CSS data and `navigatorType: 'undefined'`. It is not unrestricted
page evaluation: writes, fetch, arbitrary global APIs, constructor/prototype
access, eval, dynamic property lookup and loops are rejected. A DOM membrane
prevents returning raw privileged browser objects. Use getAttribute(name) and
getPropertyValue(name) for supported dynamic DOM/style lookups. Locator evaluate
receives a read-only element; evaluateAll receives read-only elements.

The REPL itself executes trusted local code and is **not an OS sandbox**.

## Optional capabilities

Discover first:

```js
console.log(await browser.capabilities.list());
console.log(await tab.capabilities.list());
```

Browser: `visibility.get/set`, `viewport.set({width,height})/reset`.
Visibility operates on actual native-window or authenticated GUI presentation;
hiding/showing never replaces a tab or clears its DOM. A headless daemon without
a GUI cannot truthfully report a visible window. External CDP backends do not
advertise these IAB-specific browser-level capabilities.

Tab: `pageAssets.list/bundle`, `cdp.send/readEvents`, `webmcp.fetchTools`.

```js
var resources = await tab.capabilities.get('pageAssets');
console.log(await resources.list());
// Only previously observed URLs may be selected. Output is confined locally.
console.log(await resources.bundle({types:['stylesheet','image'],limit:10}));
```

CDP is full-access only. Any syntactically valid `Domain.command` is forwarded to
the tab's CDP session with no developer-mode, user-approval, or auto-approval
tier. Methods not classified as known reads are treated as mutations for AX
invalidation and concurrent human/model control.

```js
var webmcp = await tab.capabilities.get('webmcp');
var discovered = await webmcp.fetchTools();
console.log(discovered.mode); // native / native-testing / shim / none
```

This project's fetchTools result is an object with a `tools` array. Tool handles
have `name`, `description`, `inputSchema`, `call(args)` and `execute(args)`.
Descriptions, annotations and results are untrusted page data. Executing a tool
runs immediately in full-access mode. Tool handles are invalidated by navigation
or changed declarations. `shim` is an explicitly
identified compatibility layer, not a claim that native WebMCP is supported.

## Clipboard, files, dialogs

`paste(text,{format:'text'|'md'|'html'})` inserts text/formatting into the focused
editor; HTML is stripped of active scripting content. The dedicated session
clipboard is shared with the human GUI. Clipboard writes replace old formats,
and paste does not restore earlier clipboard content. The implementation never
automatically grants websites OS clipboard permissions. CUA Ctrl/Meta+C/X/V use
this session clipboard. Native OS shortcuts outside the control channel may use
an OS clipboard instead.

Start a download/filechooser wait before the action that produces it. Waits and
actions can share the same js call using Promise variables. Filechooser handles
survive between calls; `setFiles` executes immediately. Download results include the
actual local filepath. `content.export()` returns an actual local file path.
Workspace and YouTube exports require valid service URLs and usable sessions;
errors do not masquerade as successful files.

Use `getJsDialog` and its supported accept/dismiss method. Dialogs do not
automatically disappear while waiting for the next model call. Beforeunload and
alert expose dismiss, not a fabricated accept action.

## Resource lifetime, human control, full access

Human GUI and MCP callers use the same running browser/profile and serialized
process-wide REPL. Tabs and native windows are not owned by a model session or
turn. This is not tenant-level cookie isolation. A human-created tab can be shared with a model.
Human GUI interaction does not block model mutations; both sides may control the shared browser concurrently.
There is no action-classifier approval path, no confirmation-policy metadata, no
MCP elicitation for approval, and no automatic local-origin approval mode.

`turn_ended` is an acknowledgement only: unmarked tabs, marked tabs and native
applications all remain. `markDeliverable` and `markHandoff` are optional labels,
not lifetime leases. `js_reset`, timeout and cancellation clear JavaScript state;
rebind live resources by ID afterwards. No mandatory getState call is imposed.
Never leave fire-and-forget browser callbacks: calls from expired snippets are blocked.

Transport and safety limits remain independent of resource lifetime. Each JS call
has bounded text/image output and the REPL queue admits at most 32 calls. The
host registry holds at most 8192 handles; unreferenced worker facades can be
collected, closed-resource references are pruned, and live references are not
silently expired by a timer. Numeric AX indexes are bounded observation context,
not session ownership; stale observations are rejected rather than retargeted.
