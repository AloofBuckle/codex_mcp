# Native CUA behavioral contract: single Sway desktop

Status: implemented on this Linux server; independently written backend. Full Access only.
This is a **pinned community-observed compatibility target**, not a claim of byte-for-byte
parity with every version of OpenAI's proprietary Desktop runtime.

## Sources and evidence levels

| Source | Pinned revision / observation | Used for |
| --- | --- | --- |
| [RS-Nocsi/codex-cua-mcp](https://github.com/RS-Nocsi/codex-cua-mcp) | `fc5b46fd6278ad94851fd3f4dc51b8bea3573a4d`; `src/types.ts`, `src/server.ts` | Window2 method names/order, input fields, WindowState, screenshot metadata; community broker's text receipts |
| [iFurySt/open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use) | `5674185f0c8be048f50c4335b7ee660ecdd5faa1`; `tool-call-samples-2026-04-17.md`, `state-rendering-1.0.770.md` | Recorded official macOS App-state text, integer AX indexes, focus/selection lines, state/images after mutation |
| [OpenCodexLabs trace kit](https://github.com/OpenCodexLabs/open-codex-computer-use/blob/ce313c1a292f0d737f26bfd8cd8837460e2d0a8d/docs/codex-native-trace-kit.md) | `ce313c1a292f0d737f26bfd8cd8837460e2d0a8d` | Observe/act/observe and weak-AX testing methodology, not normative schemas |
| [OpenAI Codex issue 43386](https://github.com/openai/codex/issues/43386) | User-reported Desktop behavior, 2026-09-07 | `cua.getApp(identifier)` and `app.getAXState({emit:false})` public usage |

The macOS App-state contract and Windows Window2 contract are **different**. We preserve
that distinction. The research repos were inspected, not installed as native engines.
No proprietary executable, `@oai/sky`, or trycua runtime is needed or distributed.

## Registration and normal use

Existing MCP namespace and tool order remain:

```
cua_repl.js
cua_repl.js_add_node_module_dir
cua_repl.js_reset
cua_repl.turn_ended
cua_repl.cua_live
cua_repl.viewer_session
```

The complete official bundled runtime's tools/list is not available here, so this order
is the project's current tool contract, not newly certified official ordering.
Native actions are JS methods inside this namespace, **not** new flat MCP tools or a
second MCP namespace. No agent/conversation identifier is added to tool arguments.

`await cua.getState()` returns `apps`, `browsers`, `errors` for discovery. It is not
a mandatory initialization step; known resource IDs may be rebound directly.
Subsequent calls may use `cua.getApp(id)` or `cua.launchApp(command,args,options)`.
Binding a running App with a window also emits an initial AX/screenshot observation.
`launchApp`, explicit Window handles, `waitForWindow`, `getComputer`, and native health
are documented project extensions where the exact unified upstream API is not proven.

An App/Window supports `getAXState`, `getScreenshot`, `getAXStateAndScreenshot`,
`click`, `drag`, `pressKey`, `scroll`, `setValue`, `typeText`, and
`performSecondaryAction`. The App handle also has `windows`, `getWindow`,
`waitForWindow`, `activate`, `close`. Window handles retain exact window identity.
`getState()` on a native target returns structured Window2 state for debugging.

## Output profiles

### App profile

`getAXState()` returns a string; `getScreenshot()` returns PNG `Uint8Array`;
`getAXStateAndScreenshot()` returns `{state,screenshot}`. Observations emit text/images
by default; `{emit:false}` suppresses emission without suppressing the return value.
Input actions emit fresh post-action state and PNG by default and return `undefined`.

```
App=org.example.Editor (pid 1234)
Window: "Document", App: Editor.
0 standard window Document
    1 text field (settable, string) Value: hello
The focused UI element is 1 text field.
```

There is no invented `<app_state>` or fake CUA version wrapper. Accessible role names,
labels, actions, and values come from the actual Linux application. macOS-only roles
and complex undocumented pruning/flattening algorithms are not fabricated.

### Window2 profile

`var computer = await cua.getComputer()` exposes methods in the pinned source's order:

```
list_windows, list_apps, get_window, launch_app, activate_window,
get_window_state, click, type_text, press_key, scroll, drag,
set_value, perform_secondary_action
```

Window: `{app, id, title?}`.
Window state: `{accessibility, screenshots, window}`.
Accessibility: `{tree, focused_element?, selected_elements?, selected_text?}` or null.
Screenshot: `{id, url, width, height, originX, originY, zIndex}`. URL is PNG data URI.
Default `get_window_state` captures a screenshot; AX text requires `include_text:true`.

Actions return the pinned community broker receipts: `Clicked`, `Typed: ...`,
`Pressed: ...`, `Scrolled`, `Dragged`, `Set value: ...`, `Performed action: ...`,
`Window activated`, `Launched app: ...`. These strings are **community broker output**,
not independent proof of the private native helper's exact output.

`health` and `get_desktop_state` are local diagnostic extensions. The raw launch method
accepts `{app}`; `cua.launchApp` additionally accepts argv, backend and working directory.

## Statelessness and ownership

No `createNativeSession`, `listNativeSessions`, `getNativeSession`, session token,
`start_session`/`end_session`, per-model desktop, or fallback identity hierarchy exists.

One systemd unit owns Sway, XWayland, normal D-Bus, accessibility D-Bus/registry/broker,
and a permanent virtual keyboard/pointer seat. A separate Rust backend is persistent and
receives the non-accepting systemd Unix socket. One transport can carry consecutive NDJSON
requests, but every request names exactly one Window2 method. There is deliberately no
native `batch` method; multi-step execution is the persistent `cua_repl.js` evaluating
consecutive awaits. The backend refreshes the current desktop epoch/routing for each RPC
and keeps no agent session or model-owned application lifecycle database.

An AX index inherently refers to an observation. The Node client keeps at most 64
observations for five minutes and sends the relevant observation into the next single-action
RPC. This small cache is **not a desktop or agent session**. It is invalidated on
REPL reset, interruption, expiry and relevant mutations; turn end leaves it unchanged.
Screenshot IDs encode enough geometry and process/compositor identity to remap input
without a persistent screenshot table. They are routing data, not authentication tokens.

Applications launched by the agent run in independent transient `mcpbrowser-cua-app-*.service`
units with `ExitType=cgroup`. Launcher exit does not orphan untracked descendants.
`App.close()` stops its managed cgroup. Existing attached apps are closed through their
specific windows; no unrelated process tree is killed. App IDs are rediscovered from
cgroups and Window IDs from Sway. No model-owned lifecycle database is required.

## Failure and concurrency contract

- REPL error/reset/disconnection or cua_repl restart does **not** kill native apps or desktop.
- A native request worker has a 25-second systemd runtime cap, 256 MiB memory cap, and 64-task cap.
- One kernel file lock serializes native seat operations. Kernel releases it on worker death.
- A request disconnected while waiting for the lock is rejected before dispatch.
- Already delivered native events cannot be rolled back. Mutations are never silently retried.
- A permanent virtual seat prevents toolkits losing pointer/keyboard capabilities between calls.
- Native socket restart does not restart Sway/apps.
- A critical desktop child exit causes systemd restart. Actual compositor loss **does terminate**
  its GUI clients; BindsTo stops managed application units. Old Window IDs then fail, rather
  than binding to recycled compositor IDs. Unsaved app state cannot be promised to survive.
- Unclosed apps intentionally remain usable on this one desktop. This avoids leaking entire
  compositor stacks but is not automatic inference of when an application is no longer needed.
- Browser display remains the existing independent mcpmonitor display service.

## Deliberate differences / unverified areas

Full Access means no Guardian, approval/auto-approval UI, policy escalation, or
elicitation. This does not make a root desktop a sandbox or a multi-user security boundary.

Sway screen capture is visible pixels. The implementation raises/focuses the target
before screenshot/pixel input; it does **not** claim background, focus-free macOS input,
unoccluded offscreen window textures, simultaneous independent cursors, or desktop-shell
parity. AT-SPI semantic actions may execute without focus when the application supports it.

Linux app IDs, process IDs, window titles, real pixels and AX role trees naturally differ
from Windows/macOS. Optional usage statistics are omitted rather than made up. Unsupported
or ambiguous targets return errors. Exact error codes/messages and entire proprietary
AX renderer transformations are not certified against a running official Codex Desktop.

GTK Wayland, GTK XWayland, an actual OpenGL-rendered input fixture, Unicode text, scroll,
drag, window switching, stale observations, reset/disconnect and restart recovery are
covered by local tests. Minecraft, arbitrary Electron/Qt apps, and every possible GPU
backend are not thereby certified.

## Build, operations, evidence

```
npm run native:build
sudo npm run native:install
npm run test:native
node test/native-recovery.mjs
npm run test:all
```

The recovery test deliberately SIGKILLs only the new native desktop supervisor and
refuses to run if existing native windows are present. Do not run it during real work.
The installer renders a plan by default. Installation requires --apply; starting services additionally requires --start.

Files: `native-rs/` (Rust desktop supervisor, persistent single-action RPC worker, and Wayland actuator),
`src/native/provider.mjs`, `src/native/contract.mjs`, and YAML-generated systemd unit files.
State: `nativeSystem.runDir` (private sockets), `nativeSystem.stateDir` (persistent home); see DEPLOYMENT.md.
Evidence: `artifacts/native-new/test-results.json`, `recovery-results.json`, PNGs,
`artifacts/native-smoke.log`, and `artifacts/TEST_REPORT.md`.
