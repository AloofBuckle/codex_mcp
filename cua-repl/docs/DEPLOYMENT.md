# YAML deployment

RPM and DEB are the binary installation path: see [PACKAGING.md](PACKAGING.md).
Those packages include a private Node runtime and JavaScript dependencies, so
installation does not require npm. The source workflow below remains available
for development and custom builds; it does not replace existing local installs.

The browser service runs without Caddy or mcpmonitor. It includes authenticated
HTTP MCP, the human control panel, a standalone browser viewer, optional built-in
TLS, and an authenticated signaling proxy for the separately running Native Live
backend. A reverse proxy is optional, not installed or configured by this project.

## Browser-only deployment

Requirements: Node.js 24, npm, and a locally installed Chrome/Chromium executable.
The source archive includes package-lock.json. Run from the extracted directory:

```sh
npm ci
cp cua.config.example.yaml cua.config.yaml
npm run config:check -- --config cua.config.yaml
npm run config:doctor -- --config cua.config.yaml
npm run gui -- --config cua.config.yaml
```

Set `browser.executablePath` to the desired executable when automatic detection is
not suitable. Native desktop, extensions and GPU streaming are disabled in the
browser-only example. `npm run gui` runs in the foreground; it does not install a
system service. Print the private login URL in a separate local shell:

```sh
cargo run --quiet --manifest-path control-rs/Cargo.toml -- url --config cua.config.yaml
```

The configured token file is generated with owner-only permissions. Keep it,
profiles, downloads and logs out of release archives. The standalone viewer URL
is the public origin plus `gui.basePath` and `viewer.path`. Its browser transport
uses bounded screenshot polling and WebSocket input, not the external
mcpmonitor high-frame-rate media pipeline. `viewer.screenshotIntervalMs` controls
poll frequency. The underlying browser is real and shared with MCP callers.

HTTP MCP is at `gui.publicOrigin` + `gui.basePath` + `/mcp`; provide the token in
`Authorization: Bearer`. The generated client examples use an environment
variable for the token rather than embedding it in configuration.

## Direct HTTPS, without a reverse proxy

`examples/direct-https.yaml` demonstrates Node terminating TLS itself. Supply
your own certificate and private key, and set the advertised hostname through
`CUA_PUBLIC_HOST` or replace that reference with your actual hostname. Certificate
paths resolve relative to the YAML file. No automatic certificate issuance or
renewal is performed. After replacing certificates, restart the service during
a maintenance window to reload them.

`gui.host` is the bind address; `gui.publicOrigin` is the client-visible HTTP(S)
origin, including its port. `gui.basePath` mounts all HTTP, WebSocket, viewer and
native signaling routes under one prefix, for example `/browser`. The origin
does not contain this path. Wildcard bind addresses are not public hostnames;
declare a public origin for remote clients. Host/Origin validation remains
enabled. Extra reverse-proxy aliases can be declared in `gui.allowedHosts` and
`gui.allowedOrigins`; forwarded headers are not blindly trusted.

Unencrypted non-loopback HTTP requires explicit `gui.allowInsecureRemote: true`.
Do not use it on untrusted networks. Embedded viewer capabilities require HTTPS
except on loopback. `viewer.frameAncestors` optionally restricts embedding origins;
leave it empty only when intentionally allowing arbitrary embedding hosts. Signed
viewer capabilities can use the view/control routes but cannot authenticate `/mcp`.

## Configuration rules

`config/defaults.yaml` declares deployment defaults. Your YAML is a partial
override, checked for unknown fields and invalid types. Duplicate keys, custom
tags, aliases, prototype keys and cyclic references are rejected. Priority is:

```text
defaults.yaml < supported legacy environment variables < selected YAML < CLI overrides
```

Use `${env:NAME}` to require a value from the environment explicitly. `${root}`
is the installation directory; `${configDir}` is the selected YAML directory;
`${home}` is the current account home. `${runtimeDir}`, `${nativeSystem.runDir}`
and other dotted references resolve after overrides. File paths are relative to
the YAML, not the process working directory. Bare executable names use PATH;
paths containing a slash are resolved as file paths.

Without `--config`, the loader searches `cua.config.yaml`, then `cua.config.yml`.
An existing `cua.config.json` remains a local compatibility fallback. Existing
local JSON files are neither rewritten nor shipped. The local-only
`config/local-compatibility.yaml`, when present, preserves the former deployment
defaults for legacy JSON. New release deployments use YAML directly.

`viewer.mode: external` preserves an independently deployed viewer. Declare its
`viewer.publicOrigin` and `viewer.path`; no project hostname is built into the
published runtime. External authentication/proxy setup belongs to that deployment.

## Native desktop and Native Live

Native support remains Linux/systemd-specific. Required system packages include
Sway/wlroots, Xwayland, D-Bus/AT-SPI, input/capture tools and Rust build dependencies.
Their executable paths are declared under `tools`. `nativeSystem` declares state
and runtime directories, compositor geometry/scale/output/seat, renderer and GPU
node. Host-specific compositor paths, library paths and capture modifiers also
belong in `nativeSystem`; oneVPL implementation selection belongs in
`video.native.oneVpl.vendorImplId`. None of those values are compiled into the
public source defaults. `native` declares the RPC socket and desktop environment
file. The Rust control plane reads the same YAML and execs Native binaries with the
resolved values; Native compilation no longer invokes Node or shell adapters.

```sh
npm run native:build -- --config /absolute/path/deployment.yaml
npm run deploy:render -- --config /absolute/path/deployment.yaml --out ./deployment-plan
```

Rendering writes unit files and client examples to the selected output directory
only. Review them before installation. The native installer also defaults to a
plan. Only `--apply` installs unit files; only adding `--start` enables/starts them:

```sh
npm run native:install -- --config /absolute/path/deployment.yaml
# Explicit installation, after reviewing the plan and building the binaries:
npm run native:install -- --config /absolute/path/deployment.yaml --apply
```

Configure the service user/group and ensure that account can read the project,
YAML and certificates and write its configured runtime/profile/state directories.
Changing an existing live service's settings may require an explicitly scheduled
restart. The generator and default installer do not restart the desktop, close
applications, rewrite compositor source, or change Caddy.

Native Live additionally requires compatible VA-API/oneVPL AV1 hardware and the
MCPBrowser DMA-BUF lease protocol. It does not spawn a recorder or FFmpeg.
Declare `nativeSystem.renderNode`, the compositor paths/modifier,
`nativeLive.publicHost` and `nativeLive.rtcBind` as demonstrated in
`examples/native.yaml`. Capture and encode must use the same compatible device. The raw Native Live HTTP listener stays on
loopback; clients access its signaling through the authenticated GUI listener.
The configured RTC UDP port must be reachable separately. HTTPS reachability
alone does not prove UDP/NAT connectivity; there is no TURN/TCP media fallback.

Optional nested Plasma is controlled by `nativePlasma`. Its compositor/socket,
geometry, audio socket source and optional refresh shim are YAML settings.
`mcpbrowserctl native-shims-build --config deployment.yaml` builds the configured
optional refresh shim. The generic Rust `mcpbrowser-session` is used by the Native
desktop; Plasma is started only when `nativePlasma.enabled` is true. No Python or
shell deployment helper is required.

## Extension packaging

For a side-loading-capable browser, set `extension.enabled` and
`extension.autoLoad`. The daemon prepares an extension copy under runtimeDir,
injects its YAML native-host name, and installs a native-host wrapper using the
configured Node path and socket. The source `extension/manifest.json` carries no
deployment identity. Put the public DER key in `extension.manifestKey` in the
selected YAML and set `extension.extensionId: auto`; the loader derives and
validates the Chrome extension ID before writing the runtime copy. Alternatively,
leave `manifestKey` empty and provide an explicit ID for an already-installed
extension. No source file needs to be edited. For manual installation:

```sh
cargo run --quiet --manifest-path control-rs/Cargo.toml -- extension-install --config deployment.yaml
```

Install the generated extension directory, not an unprepared source directory.
For profile-installed extensions set `extension.autoLoad: false`. Branded-browser
side-loading support is not assumed; failure to complete a required automatic
handshake fails startup rather than falsely advertising an extension backend.

## Verification and release packaging

```sh
npm test
npm run test:acceptance
cargo test --offline --all-targets --manifest-path native-rs/Cargo.toml
npm run release:pack
```

Native GUI/recovery tests can send real input or restart their test services.
They require `--allow-live-tests` and an explicit configuration; run them only
on disposable desktops. The ordinary test suite does not use the installed
native desktop. Installing a test Chromium is necessary for extension tests.

The source packager uses a file allowlist and includes package-lock.json for
`npm ci`. It excludes active configs, the local compatibility overlay, runtime
profiles, artifacts, screenshots, private keys, build outputs and dependencies.
It writes the source archive, SHA-256 file and member hashes without publishing
to a registry. `private: true` intentionally remains set in package.json.

OS/protocol constants such as private CDP loopback routing, `/proc`, X11 socket
conventions, RPC method names and upstream service endpoints are not deployment
hostnames. They remain code contracts rather than arbitrary YAML substitutions.
