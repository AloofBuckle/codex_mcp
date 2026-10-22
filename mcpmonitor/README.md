# MCP Monitor — standalone HTTP edition

This is the `mws/service/mcpmonitor` 3.1.4 code extracted into
`codex_mcp/mcpmonitor`. The standalone server uses **Axum TCP/HTTP**, not
Pingora/Ferron or the MWS binary Unix-domain socket framework.

## Supported features

- Live Codex MCP tool-call observation from `GET /monitor/v2/events` (SSE),
  terminal ACK to `POST /monitor/v2/ack`, reconnection/replay, and durable SQLite
  history, search, stats, and details.
- User-input APIs (`/monitor/v2/user-input/*`), widgets, authenticated event
  streaming, optional browser push notifications, and native user-input WS.
- The original dashboard HTML/CSS/JS assets and browser GUI websocket proxy
  (when configured).
- OIDC authorization-code + PKCE login via a normal HTTP(S) token endpoint
  and userinfo verification. Only the configured `subject` can authenticate.
- Native Live `/health` and WebRTC DataChannel SDP signaling `/dc` via an
  **optional, standalone loopback HTTP** endpoint (compatible with the
  `cua-repl/native-rs/src/bin/live.rs` service).

### Deliberate separation / limitations

The former Browser compositor, libva/oneVPL media worker, Unix-domain socket
controls and memfd shared-memory AV1/Opus transport were **not** copied into
this distribution. They were coupled to the original MWS runtime. Accordingly,
Browser WebRTC video/audio and local desktop service restart return a clear
HTTP `501 Not Implemented` rather than a misleading success response. Native
Live works **if** the independent Native Live HTTP service is configured;
browser GUI control WS works **if** the independent browser GUI WS is configured.
The dashboard contains the original video panel UI, but the missing Browser
media backend is not functional here. A separate portable media transport can
be added later without pulling in MWS IPC.

## Dependencies

- Rust stable (edition 2024); Linux is recommended for deployment.
- A running **standalone codex-mcp** using a loopback HTTP listener, usually
  `127.0.0.1:35121`. Enable its `monitor` configuration and share the contents
  of `monitor.token_file` with `mcpmonitor.upstream_token_file`. Keep the file
  restricted (at least 32 characters, chmod 600).
- An OIDC provider with `/authorize`, `/token`, `/userinfo` (or configure
  explicit endpoints); the provider must issue expiring **JWT access tokens**
  and validate them at userinfo. Both `client_secret_post` (form fields) and
  PKCE are used. The HTTP URLs can be overridden in the OIDC JSON as
  `authorization_endpoint`, `token_endpoint`, `userinfo_endpoint`; explicit
  endpoints must be on the issuer's origin.

## Build and run

From the repository root:

```sh
cargo build --manifest-path mcpmonitor/Cargo.toml --locked --release
cargo test --manifest-path mcpmonitor/Cargo.toml --locked
```

Create config files **outside Git**:

1. Copy `mcpmonitor/config.example.json` to `/etc/mcpmonitor/config.json`.
   Set `public_origin`, `database`, the loopback `codex_http_url`,
   `upstream_token_file` and the `oidc_config` path. Make the state directory
   writable for the service user.
2. Copy `mcpmonitor/oidc.example.json` to `/etc/mcpmonitor/oidc.json`.
   Set your issuer, `client_id`, `client_secret`, exact allowed user `subject`,
   and `redirect_uri` equal to `public_origin + /mcpmonitor/auth/callback`.
3. Register that redirect URI with your OIDC provider, and grant the monitor
   service user read access to both configuration files and token files.
4. Start `mcpmonitor/target/release/mcpmonitor /etc/mcpmonitor/config.json
   127.0.0.1:35122`, and expose it through HTTPS (for example,
   `deploy/Caddyfile.example`, with `deploy/mcpmonitor.service.example`).
5. Visit `https://monitor.example.com/mcpmonitor/`.

For *loopback-only* local development, use
`public_origin=http://127.0.0.1:35122`, `secure_cookie=false` in both
configuration files, and a loopback HTTP redirect URI. **Never** deploy that
configuration on a publicly reachable interface.

`browser_ws_url` and `browser_token_file` are optional but must be configured
as a pair; `native_live_url` is optional and must be a loopback HTTP origin
(e.g. `http://127.0.0.1:35123`). `native_user_input_token_file` is optional;
it must contain exactly 64 hexadecimal characters. Optional Web Push requires
`web_push.private_key` and `web_push.subject`. These paths and OAuth secrets
must never be checked into Git.

## Testing

```sh
cargo test --manifest-path mcpmonitor/Cargo.toml --locked
cargo build --manifest-path mcpmonitor/Cargo.toml --locked
python3 mcpmonitor/tests/standalone_http.py mcpmonitor/target/debug/mcpmonitor
```

The integration test starts temporary mock Codex and OIDC HTTP services and
verifies login, history, upstream SSE/ACK, native HTTP proxy and disabled media.
It does not contact a production server.

## Security and compatibility

The monitor listens on **loopback only**. It rejects non-loopback upstream
Codex, Browser WS, and Native Live addresses; HTTP clients bypass environment
proxies for loopback services. Protected APIs require verified OIDC session
cookies, with an exact origin check for requests that supply `Origin`.
The user-input widget capability derivation deliberately retains its original
`mws-user-input-widget-v1` domain separator for protocol compatibility with
Codex MCP; it is not an MWS library or transport dependency.

The original `/data/mws` checkout remains untouched. This project contains
no symlinks or path dependencies pointing at that checkout.

Source license: MIT, copyright AloofBuckle; see `LICENSE`.
