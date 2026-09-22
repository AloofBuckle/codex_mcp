# RPM and DEB releases

The binary packages include the application, locked production JavaScript
dependencies, and a private, checksum-pinned Node.js 24 runtime. They do not
install npm, modify the system Node installation, or download anything from
maintainer scripts. Chrome/Chromium remains a separately managed OS dependency.
The package manager may fetch declared OS dependencies during installation.

## Installation

```sh
# Debian / Ubuntu, on the machine where the service will run:
sudo apt install ./mcpbrowser_0.1.0-1_amd64.deb

# Fedora / other compatible RPM systems:
sudo dnf install ./mcpbrowser-0.1.0-1.x86_64.rpm
```

Package filenames depend on the release version and architecture. Review
`/etc/mcpbrowser/config.yaml` and ensure `browser.executablePath` resolves to a
working Chrome/Chromium executable. A browser is recommended by the packages,
not bundled. In particular, a distro browser wrapper requiring a separate
container or desktop login may not work as a headless system service; explicitly
select the appropriate browser executable in that case.

```sh
sudo -u mcpbrowser mcpbrowser check
sudo -u mcpbrowser mcpbrowser doctor
sudo systemctl enable --now mcpbrowser.service
sudo -u mcpbrowser mcpbrowser url
```

Installation does **not** enable or start the service. Upgrades do not restart a
running browser or discard its in-memory state. Restart explicitly during a
maintenance window to activate a new package version. Removal stops only the
package's service; it does not stop source deployments or unrelated browser
services. Runtime tokens, profiles, downloads and logs survive removal and even
DEB purge. Remove these sensitive data explicitly when decommissioning a host.

| Location | Ownership and purpose |
|---|---|
| `/usr/lib/mcpbrowser/` | Root-owned application and dependencies; not writable by the service |
| `/usr/lib/mcpbrowser/runtime/bin/node` | Private Node runtime, with its upstream license |
| `/usr/bin/mcpbrowser` | CLI; no npm command needed at runtime |
| `/etc/mcpbrowser/config.yaml` | Administrator configuration, root:mcpbrowser 0640 |
| `/var/lib/mcpbrowser/` | Private profiles, downloads, persistent token and service home |
| `/var/cache/mcpbrowser/` | Temporary files |
| `/var/log/mcpbrowser/` | Service log |
| `/usr/lib/systemd/system/mcpbrowser.service` | Non-root browser service |

RPM declares the YAML as `%config(noreplace)`; DEB declares it as a conffile.
Maintainer scripts do not rewrite its contents. A modified file is preserved
when upgrading normally, with package-manager conflict handling when the
shipped default also changes. DEB purge removes the package-owned YAML, but
does not delete the separate data directories. Do not store secrets in the
distributed default configuration.

Direct HTTP on loopback, built-in HTTPS, path prefixes, external viewer mode and
stateless MCP resource views work exactly as with source deployment. See
`DEPLOYMENT.md` for the runtime YAML fields and certificate permissions. The
package does not edit Caddy, firewall rules, browser defaults or desktop sessions.

## Build

`packaging/release.yaml` holds package metadata, target paths, OS dependencies,
service identity and pinned Node archive digests. Application version comes from
`package.json`. Replace the local maintainer address with the release owner's
real contact before distributing publicly.

```sh
npm ci
cargo run --quiet --manifest-path control-rs/Cargo.toml -- package --format rpm --arch x64
cargo run --quiet --manifest-path control-rs/Cargo.toml -- package --format deb --arch x64
# Explicit isolated Debian builder when the host lacks dpkg-deb:
docker pull debian:13-slim
cargo run --quiet --manifest-path control-rs/Cargo.toml -- package --format all --arch x64 --deb-container
```

Build requirements: Rust/Cargo, Node 24, npm, tar/xz, rpmbuild for RPM, and dpkg-deb for DEB
(or the explicitly selected Docker build adapter). The build downloads the
official Node archive, verifies the YAML SHA-256, and uses `npm ci --omit=dev
--ignore-scripts` in a private staging tree. Dependencies and their licenses are
included; browser profiles and local configuration are never copied. Only the
build stage needs npm. `--offline` requires a populated `--cache` and fails
rather than downloading. Architecture must be `x64` or `arm64`; this is a build
target, not a claim that every target has been runtime-tested.

Output is written to `artifacts/packages/` unless overridden with `--out`.
It includes RPM/DEB, individual SHA-256 files and `manifest.json` with payload
hashes, package scripts, runtime version and lockfile hash. Component inventory
is installed under `/usr/share/doc/mcpbrowser/components.json`. Private Node
and bundled dependencies must be updated and rebuilt by the release maintainer
when security updates arrive; OS Node updates do not update this private copy.

The artifacts are unsigned local builds. SHA-256 is not publisher identity.
Sign RPMs and publish a signed APT repository before a public release; signing
keys are deliberately neither generated nor embedded by the Rust package builder.

## Native desktop boundary

The main package does not force-install Sway, Plasma, GPU drivers or a recorder.
Native support is optional and still has platform-specific shared-library,
Wayland/VA-API and oneVPL requirements. Native ELF binaries must be built for the target
distribution and architecture, not copied from Fedora into a Debian package.
The private Node runtime remains available for native configuration adapters.
No native service is started by installing the browser package.

Build an optional `mcpbrowser-native` addon **on its target distribution**:

```sh
# On Fedora / RPM builder with the Rust and native development dependencies:
cargo run --quiet --manifest-path control-rs/Cargo.toml -- package-native --format rpm
# On Debian / Ubuntu builder, also requires dpkg-dev:
cargo run --quiet --manifest-path control-rs/Cargo.toml -- package-native --format deb
```

The addon puts four compiled executables in `/usr/lib/mcpbrowser/native/bin/`.
It depends on the matching main package, uses automatic ELF dependencies for
RPM or `dpkg-shlibdeps` for DEB, and records the build distribution. It does not
install units or choose GPU devices. Render and review native units with
`mcpbrowser deploy` using a separate explicit native YAML and the service
identity/permissions required by the systemd-managed desktop. The base browser
service account is not granted root, polkit or systemd-run privileges by this
package. Native provisioning is deliberately an explicit administrator step.
