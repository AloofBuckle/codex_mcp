use crate::{find_executable, write_atomic};
use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    env, fs,
    os::unix::fs::{PermissionsExt, symlink},
    path::{Path, PathBuf},
    process::Command,
};

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReleaseConfig {
    pub schema_version: u64,
    pub name: String,
    pub release: String,
    pub summary: String,
    pub maintainer: String,
    pub license: String,
    pub source_date_epoch: u64,
    pub registry: String,
    pub defaults: Value,
    pub paths: PackagePaths,
    pub service: Service,
    pub system_paths: SystemPaths,
    pub runtime: Runtime,
    pub dependencies: Dependencies,
    pub builder: Builder,
    pub native: NativePackage,
}

#[derive(Debug, Clone, Deserialize)]
pub struct PackagePaths {
    pub app: String,
    pub command: String,
    pub config: String,
    pub state: String,
    pub cache: String,
    pub log: String,
    pub run: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Service {
    pub name: String,
    pub user: String,
    pub group: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemPaths {
    pub units_dir: String,
    pub sysusers_dir: String,
    pub tmpfiles_dir: String,
    pub docs_dir: String,
    pub nologin: String,
    pub systemd_runtime_dir: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Runtime {
    pub version: String,
    pub base_url: String,
    pub architectures: BTreeMap<String, RuntimeArch>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeArch {
    pub deb: String,
    pub rpm: String,
    pub elf_machine: u16,
    pub sha256: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Dependencies {
    pub deb: Vec<String>,
    pub rpm: Vec<String>,
    pub deb_recommends: Vec<String>,
    pub rpm_recommends: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Builder {
    pub deb_image: String,
    pub docker: String,
    pub dpkg_deb: String,
    pub dpkg_shlibdeps: String,
    pub rpmbuild: String,
    pub cargo: String,
    pub curl: String,
    pub npm: String,
    pub tar: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct NativePackage {
    pub name: String,
    pub binaries: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct PackageOptions {
    pub format: String,
    pub arch: String,
    pub out: PathBuf,
    pub cache: PathBuf,
    pub offline: bool,
    pub deb_container: bool,
    pub config: Option<PathBuf>,
}

fn run(command: &mut Command, label: &str) -> Result<()> {
    let status = command.status().with_context(|| format!("run {label}"))?;
    if !status.success() {
        bail!("{label} failed with {status}")
    }
    Ok(())
}

fn output(command: &mut Command, label: &str) -> Result<String> {
    let out = command.output().with_context(|| format!("run {label}"))?;
    if !out.status.success() {
        bail!(
            "{label} failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        )
    }
    Ok(String::from_utf8(out.stdout)?.trim().to_string())
}

fn sha256_file(path: &Path) -> Result<String> {
    let bytes = fs::read(path)?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn parse_release(path: &Path) -> Result<ReleaseConfig> {
    let text = fs::read_to_string(path)?;
    let cfg: ReleaseConfig = serde_yaml::from_str(&text)?;
    if cfg.schema_version != 1 {
        bail!("unsupported packaging schema")
    }
    if !cfg
        .name
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_lowercase())
    {
        bail!("invalid package name")
    }
    for path in [
        &cfg.paths.app,
        &cfg.paths.command,
        &cfg.paths.config,
        &cfg.paths.state,
        &cfg.paths.cache,
        &cfg.paths.log,
        &cfg.paths.run,
        &cfg.system_paths.units_dir,
        &cfg.system_paths.sysusers_dir,
        &cfg.system_paths.tmpfiles_dir,
        &cfg.system_paths.docs_dir,
        &cfg.system_paths.nologin,
        &cfg.system_paths.systemd_runtime_dir,
    ] {
        if !path.starts_with('/') || path.contains("..") || path == "/" {
            bail!("package paths must be normalized absolute paths")
        }
    }
    if cfg.service.user == "root" || cfg.service.user != cfg.service.group {
        bail!("package service must use a dedicated matching non-root user/group")
    }
    if !cfg.runtime.version.starts_with("24.") {
        bail!("package runtime must pin Node 24")
    }
    Ok(cfg)
}

fn write_root(root: &Path, absolute: &str, bytes: &[u8], mode: u32) -> Result<PathBuf> {
    let rel = absolute.trim_start_matches('/');
    let file = root.join(rel);
    write_atomic(&file, bytes, mode)?;
    Ok(file)
}

fn relative_symlink_target(link: &Path, target: &Path) -> Result<PathBuf> {
    let from = link
        .parent()
        .ok_or_else(|| anyhow!("symlink has no parent: {}", link.display()))?;
    let from_components = from.components().collect::<Vec<_>>();
    let target_components = target.components().collect::<Vec<_>>();
    let mut common = 0;
    while common < from_components.len()
        && common < target_components.len()
        && from_components[common] == target_components[common]
    {
        common += 1;
    }
    let mut out = PathBuf::new();
    for _ in common..from_components.len() {
        out.push("..");
    }
    for component in &target_components[common..] {
        out.push(component.as_os_str());
    }
    if out.as_os_str().is_empty() {
        out.push(".");
    }
    Ok(out)
}

fn copy_tree(src: &Path, dst: &Path, dependency: bool) -> Result<()> {
    let meta = fs::symlink_metadata(src)?;
    if meta.file_type().is_symlink() {
        if !dependency {
            bail!("unexpected source symlink: {}", src.display())
        }
        let target = fs::read_link(src)?;
        if target.is_absolute() {
            bail!("absolute dependency symlink: {}", src.display())
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        symlink(target, dst)?;
    } else if meta.is_dir() {
        fs::create_dir_all(dst)?;
        for entry in fs::read_dir(src)? {
            let entry = entry?;
            let name = entry.file_name();
            if matches!(
                name.to_str(),
                Some(".git" | ".cache" | "__pycache__" | ".package-lock.json")
            ) {
                continue;
            }
            copy_tree(&entry.path(), &dst.join(name), dependency)?;
        }
    } else if meta.is_file() {
        if dependency
            && matches!(
                src.extension().and_then(|x| x.to_str()),
                Some("sh" | "py" | "ps1" | "cmd" | "bat")
            )
        {
            return Ok(());
        }
        if let Some(parent) = dst.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = fs::read(src)?;
        if dependency
            && (bytes.starts_with(b"\x7fELF")
                || matches!(
                    src.extension().and_then(|x| x.to_str()),
                    Some("node" | "so" | "dll" | "dylib" | "exe")
                ))
        {
            bail!(
                "native dependency requires target-specific build: {}",
                src.display()
            )
        }
        fs::write(dst, &bytes)?;
        let mut p = fs::metadata(dst)?.permissions();
        p.set_mode(if bytes.starts_with(b"#!") {
            0o755
        } else {
            0o644
        });
        fs::set_permissions(dst, p)?;
    }
    Ok(())
}

fn inventory(root: &Path) -> Result<Vec<(String, u64)>> {
    fn visit(root: &Path, p: &Path, out: &mut Vec<(String, u64)>) -> Result<()> {
        for entry in fs::read_dir(p)? {
            let entry = entry?;
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.is_dir() {
                visit(root, &entry.path(), out)?;
            } else {
                let rel = entry
                    .path()
                    .strip_prefix(root)?
                    .to_string_lossy()
                    .replace('\\', "/");
                out.push((
                    format!("/{rel}"),
                    if meta.is_file() { meta.len() } else { 0 },
                ));
            }
        }
        Ok(())
    }
    let mut out = Vec::new();
    visit(root, root, &mut out)?;
    out.sort();
    Ok(out)
}

fn validate_elf(path: &Path, machine: u16) -> Result<()> {
    let bytes = fs::read(path)?;
    if bytes.len() < 20
        || &bytes[..4] != b"\x7fELF"
        || bytes[4] != 2
        || bytes[5] != 1
        || u16::from_le_bytes([bytes[18], bytes[19]]) != machine
    {
        bail!("ELF architecture mismatch: {}", path.display())
    }
    Ok(())
}

fn host_arch() -> Result<&'static str> {
    match env::consts::ARCH {
        "x86_64" => Ok("x64"),
        "aarch64" => Ok("arm64"),
        other => bail!("unsupported host architecture {other}"),
    }
}

fn rust_target(arch: &str) -> Result<&'static str> {
    match arch {
        "x64" => Ok("x86_64-unknown-linux-gnu"),
        "arm64" => Ok("aarch64-unknown-linux-gnu"),
        _ => bail!("arch must be x64 or arm64"),
    }
}

fn build_control(
    root: &Path,
    stage: &Path,
    arch: &str,
    offline: bool,
    cfg: &ReleaseConfig,
) -> Result<PathBuf> {
    let cargo = find_executable(&cfg.builder.cargo)
        .ok_or_else(|| anyhow!("cargo is required for Rust control-plane packaging"))?;
    let host = host_arch()?;
    let target_dir = stage.join("cargo-control");
    let mut cmd = Command::new(cargo);
    cmd.current_dir(root)
        .env("CARGO_TARGET_DIR", &target_dir)
        .args(["build", "--locked", "--release", "--manifest-path"])
        .arg(root.join("control-rs/Cargo.toml"))
        .arg("--bin")
        .arg("mcpbrowserctl");
    if arch != host {
        cmd.arg("--target").arg(rust_target(arch)?);
    }
    if offline {
        cmd.arg("--offline");
    }
    run(&mut cmd, "build mcpbrowserctl")?;
    Ok(if arch == host {
        target_dir.join("release/mcpbrowserctl")
    } else {
        target_dir
            .join(rust_target(arch)?)
            .join("release/mcpbrowserctl")
    })
}

fn runtime_archive(
    cfg: &ReleaseConfig,
    arch: &str,
    cache: &Path,
    offline: bool,
) -> Result<PathBuf> {
    let info = cfg
        .runtime
        .architectures
        .get(arch)
        .ok_or_else(|| anyhow!("unsupported runtime arch {arch}"))?;
    fs::create_dir_all(cache)?;
    let name = format!("node-v{}-linux-{arch}.tar.xz", cfg.runtime.version);
    let file = cache.join(&name);
    if !file.exists() {
        if offline {
            bail!("offline runtime archive missing: {}", file.display())
        }
        let curl = find_executable(&cfg.builder.curl)
            .ok_or_else(|| anyhow!("curl is required to download the pinned Node runtime"))?;
        let url = format!(
            "{}/v{}/{}",
            cfg.runtime.base_url.trim_end_matches('/'),
            cfg.runtime.version,
            name
        );
        let tmp = file.with_extension("partial");
        let mut cmd = Command::new(curl);
        cmd.args([
            "--fail",
            "--location",
            "--silent",
            "--show-error",
            "--max-time",
            "180",
            "--output",
        ])
        .arg(&tmp)
        .arg(&url);
        run(&mut cmd, "download Node runtime")?;
        fs::rename(tmp, &file)?;
    }
    let got = sha256_file(&file)?;
    if got != info.sha256 {
        bail!("Node runtime SHA-256 mismatch: {}", file.display())
    }
    Ok(file)
}

fn merge(base: &mut Value, extra: &Value) {
    match (base, extra) {
        (Value::Object(a), Value::Object(b)) => {
            for (k, v) in b {
                match a.get_mut(k) {
                    Some(old) => merge(old, v),
                    None => {
                        a.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        (a, b) => *a = b.clone(),
    }
}

fn packaged_config(cfg: &ReleaseConfig) -> Value {
    let p = &cfg.paths;
    let mut value = cfg.defaults.clone();
    merge(
        &mut value,
        &json!({
            "schemaVersion": 1,
            "runtimeDir": p.state,
            "artifactsDir": format!("{}/artifacts", p.state),
            "profilesDir": format!("{}/profiles", p.state),
            "downloadsDir": format!("{}/downloads", p.state),
            "tmpDir": format!("{}/tmp", p.cache),
            "logFile": format!("{}/daemon.log", p.log),
            "gui": {"tokenFile": format!("{}/gui-token", p.state)},
            "tools": {
                "node": format!("{}/runtime/bin/node", p.app),
                "controlBinary": p.command,
                "chromeCandidates": ["chromium", "google-chrome", "chromium-browser"],
                "nativeDesktop": format!("{}/native/bin/mcpbrowser-cua-native-desktop", p.app),
                "nativeWorker": format!("{}/native/bin/mcpbrowser-cua-native-worker", p.app),
                "nativeLive": format!("{}/native/bin/mcpbrowser-cua-native-live", p.app),
                "nativePointer": format!("{}/native/bin/mcpbrowser-wayland-pointer", p.app),
                "nativeSession": format!("{}/native/bin/mcpbrowser-session", p.app),
            },
            "deployment": {"user": cfg.service.user, "group": cfg.service.group, "controlBinary": p.command}
        }),
    );
    value
}

fn service_unit(cfg: &ReleaseConfig) -> String {
    format!(
        "[Unit]\nDescription={}\nAfter=network.target\n\n[Service]\nType=exec\nUser={}\nGroup={}\nEnvironment=HOME={}/home\nEnvironment=MCPBROWSER_ROOT={}\nEnvironment=CUA_CONFIG={}\nWorkingDirectory={}\nExecStart={} serve --config {}\nRestart=on-failure\nRestartSec=3\nTimeoutStopSec=30\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=true\nProtectSystem=full\nProtectHome=true\n\n[Install]\nWantedBy=multi-user.target\n",
        cfg.summary,
        cfg.service.user,
        cfg.service.group,
        cfg.paths.state,
        cfg.paths.app,
        cfg.paths.config,
        cfg.paths.state,
        cfg.paths.command,
        cfg.paths.config
    )
}

fn stage_main(
    root: &Path,
    cfg: &ReleaseConfig,
    options: &PackageOptions,
    stage: &Path,
) -> Result<PathBuf> {
    let payload = stage.join("root");
    let app = payload.join(cfg.paths.app.trim_start_matches('/'));
    fs::create_dir_all(&app)?;
    for dir in [
        "src",
        "public",
        "extension",
        "assets",
        "types",
        "docs",
        "native-live",
    ] {
        copy_tree(&root.join(dir), &app.join(dir), false)?;
    }
    for file in [
        "config/defaults.yaml",
        "config/environment.yaml",
        "package.json",
        "package-lock.json",
        "LICENSE",
    ] {
        copy_tree(&root.join(file), &app.join(file), false)?;
    }

    let deps = stage.join("deps");
    fs::create_dir_all(&deps)?;
    fs::copy(root.join("package.json"), deps.join("package.json"))?;
    fs::copy(
        root.join("package-lock.json"),
        deps.join("package-lock.json"),
    )?;
    let mut npm = Command::new(&cfg.builder.npm);
    npm.current_dir(&deps)
        .env("PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD", "1")
        .args([
            "ci",
            "--omit=dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            "--cache",
        ])
        .arg(options.cache.join("npm"))
        .arg("--registry")
        .arg(&cfg.registry);
    if options.offline {
        npm.arg("--offline");
    }
    run(&mut npm, "npm ci production dependencies")?;
    copy_tree(&deps.join("node_modules"), &app.join("node_modules"), true)?;

    let archive = runtime_archive(cfg, &options.arch, &options.cache, options.offline)?;
    let runtime = app.join("runtime");
    fs::create_dir_all(&runtime)?;
    let prefix = format!("node-v{}-linux-{}", cfg.runtime.version, options.arch);
    let mut tar = Command::new(&cfg.builder.tar);
    tar.args(["-xJf"])
        .arg(&archive)
        .args(["--strip-components=1", "--no-same-owner", "-C"])
        .arg(&runtime)
        .arg(format!("{prefix}/bin/node"))
        .arg(format!("{prefix}/LICENSE"));
    run(&mut tar, "extract Node runtime")?;
    validate_elf(
        &runtime.join("bin/node"),
        cfg.runtime.architectures[&options.arch].elf_machine,
    )?;

    let control = build_control(root, stage, &options.arch, options.offline, cfg)?;
    validate_elf(
        &control,
        cfg.runtime.architectures[&options.arch].elf_machine,
    )?;
    let installed_control = format!("{}/bin/mcpbrowserctl", cfg.paths.app);
    write_root(&payload, &installed_control, &fs::read(control)?, 0o755)?;
    let command_path = payload.join(cfg.paths.command.trim_start_matches('/'));
    if let Some(parent) = command_path.parent() {
        fs::create_dir_all(parent)?;
    }
    let _ = fs::remove_file(&command_path);
    let link_target =
        relative_symlink_target(Path::new(&cfg.paths.command), Path::new(&installed_control))?;
    symlink(link_target, &command_path)?;

    let yaml = serde_yaml::to_string(&packaged_config(cfg))?;
    write_root(&payload, &cfg.paths.config, yaml.as_bytes(), 0o640)?;
    write_root(
        &payload,
        &format!(
            "{}/{}",
            cfg.system_paths.units_dir.trim_end_matches('/'),
            cfg.service.name
        ),
        service_unit(cfg).as_bytes(),
        0o644,
    )?;
    write_root(
        &payload,
        &format!(
            "{}/{}.conf",
            cfg.system_paths.sysusers_dir.trim_end_matches('/'),
            cfg.name
        ),
        format!(
            "u {} - \"MCPBrowser service\" {}/home {}\n",
            cfg.service.user, cfg.paths.state, cfg.system_paths.nologin
        )
        .as_bytes(),
        0o644,
    )?;
    let tmpfiles = [
        cfg.paths.state.clone(),
        format!("{}/home", cfg.paths.state),
        cfg.paths.cache.clone(),
        cfg.paths.log.clone(),
        cfg.paths.run.clone(),
    ]
    .into_iter()
    .map(|d| format!("d {d} 0700 {} {} -", cfg.service.user, cfg.service.group))
    .collect::<Vec<_>>()
    .join("\n")
        + "\n";
    write_root(
        &payload,
        &format!(
            "{}/{}.conf",
            cfg.system_paths.tmpfiles_dir.trim_end_matches('/'),
            cfg.name
        ),
        tmpfiles.as_bytes(),
        0o644,
    )?;
    write_root(
        &payload,
        &format!(
            "{}/{}/copyright",
            cfg.system_paths.docs_dir.trim_end_matches('/'),
            cfg.name
        ),
        &fs::read(root.join("LICENSE"))?,
        0o644,
    )?;
    write_root(
        &payload,
        &format!(
            "{}/{}/PACKAGING.md",
            cfg.system_paths.docs_dir.trim_end_matches('/'),
            cfg.name
        ),
        &fs::read(root.join("docs/PACKAGING.md"))?,
        0o644,
    )?;
    write_root(
        &payload,
        &format!(
            "{}/{}/node-LICENSE",
            cfg.system_paths.docs_dir.trim_end_matches('/'),
            cfg.name
        ),
        &fs::read(runtime.join("LICENSE"))?,
        0o644,
    )?;
    Ok(payload)
}

fn deb_control(
    cfg: &ReleaseConfig,
    name: &str,
    summary: &str,
    version: &str,
    arch: &str,
    root: &Path,
    deps: &[String],
    recommends: &[String],
) -> Result<String> {
    let size = (inventory(root)?.iter().map(|(_, b)| *b).sum::<u64>() + 1023) / 1024;
    Ok(format!(
        "Package: {name}\nVersion: {version}-{}\nSection: net\nPriority: optional\nArchitecture: {arch}\nMaintainer: {}\nInstalled-Size: {size}\nDepends: {}\n{}Description: {summary}\n Rust-controlled deployment; installation does not start services automatically.\n",
        cfg.release,
        cfg.maintainer,
        deps.join(", "),
        if recommends.is_empty() {
            String::new()
        } else {
            format!("Recommends: {}\n", recommends.join(", "))
        }
    ))
}

fn maintainer_scripts(cfg: &ReleaseConfig) -> (String, String, String) {
    let sysusers = format!(
        "{}/{}.conf",
        cfg.system_paths.sysusers_dir.trim_end_matches('/'),
        cfg.name
    );
    let tmpfiles = format!(
        "{}/{}.conf",
        cfg.system_paths.tmpfiles_dir.trim_end_matches('/'),
        cfg.name
    );
    let runtime = &cfg.system_paths.systemd_runtime_dir;
    let postinst = format!(
        "#!/bin/sh\nset -eu\nif command -v systemd-sysusers >/dev/null 2>&1; then systemd-sysusers {sysusers} || :; fi\nif command -v systemd-tmpfiles >/dev/null 2>&1; then systemd-tmpfiles --create {tmpfiles} || :; fi\nif [ -d {runtime} ] && command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || :; fi\nexit 0\n"
    );
    let prerm = format!(
        "#!/bin/sh\nset -eu\nif [ \"${{1:-}}\" = remove ] && [ -d {runtime} ] && command -v systemctl >/dev/null 2>&1; then systemctl stop {} || :; systemctl disable {} || :; fi\nexit 0\n",
        cfg.service.name, cfg.service.name
    );
    let postrm = format!(
        "#!/bin/sh\nset -eu\nif [ -d {runtime} ] && command -v systemctl >/dev/null 2>&1; then systemctl daemon-reload || :; fi\nexit 0\n"
    );
    (postinst, prerm, postrm)
}

fn build_deb(
    cfg: &ReleaseConfig,
    options: &PackageOptions,
    root: &Path,
    stage: &Path,
    name: &str,
    summary: &str,
    version: &str,
    deps: &[String],
    recommends: &[String],
) -> Result<PathBuf> {
    let arch = &cfg.runtime.architectures[&options.arch].deb;
    let debian = root.join("DEBIAN");
    fs::create_dir_all(&debian)?;
    write_atomic(
        &debian.join("control"),
        deb_control(cfg, name, summary, version, arch, root, deps, recommends)?.as_bytes(),
        0o644,
    )?;
    let (postinst, prerm, postrm) = maintainer_scripts(cfg);
    write_atomic(&debian.join("postinst"), postinst.as_bytes(), 0o755)?;
    write_atomic(&debian.join("prerm"), prerm.as_bytes(), 0o755)?;
    write_atomic(&debian.join("postrm"), postrm.as_bytes(), 0o755)?;
    if name == cfg.name {
        write_atomic(
            &debian.join("conffiles"),
            format!("{}\n", cfg.paths.config).as_bytes(),
            0o644,
        )?;
    }
    let out = stage.join(format!("{name}_{version}-{}_{arch}.deb", cfg.release));
    if let Some(dpkg) = find_executable(&cfg.builder.dpkg_deb) {
        let mut cmd = Command::new(dpkg);
        cmd.args(["--root-owner-group", "-Zxz", "-z6", "--build"])
            .arg(root)
            .arg(&out);
        run(&mut cmd, "dpkg-deb")?;
    } else if options.deb_container {
        let docker =
            find_executable(&cfg.builder.docker).ok_or_else(|| anyhow!("docker not found"))?;
        let mut cmd = Command::new(docker);
        cmd.args([
            "run",
            "--rm",
            "--network=none",
            "--security-opt=label=disable",
            "-v",
        ])
        .arg(format!("{}:/build", stage.display()))
        .arg(&cfg.builder.deb_image)
        .args([
            "dpkg-deb",
            "--root-owner-group",
            "-Zxz",
            "-z6",
            "--build",
            "/build/root",
        ])
        .arg(format!(
            "/build/{}",
            out.file_name().unwrap().to_string_lossy()
        ));
        run(&mut cmd, "container dpkg-deb")?;
    } else {
        bail!("dpkg-deb unavailable; install it or use --deb-container")
    }
    fs::remove_dir_all(&debian).ok();
    Ok(out)
}

fn build_rpm(
    cfg: &ReleaseConfig,
    options: &PackageOptions,
    root: &Path,
    stage: &Path,
    name: &str,
    summary: &str,
    version: &str,
    deps: &[String],
    recommends: &[String],
) -> Result<PathBuf> {
    let rpm =
        find_executable(&cfg.builder.rpmbuild).ok_or_else(|| anyhow!("rpmbuild is required"))?;
    let arch = &cfg.runtime.architectures[&options.arch].rpm;
    let top = stage.join("rpm");
    for d in ["BUILD", "BUILDROOT", "RPMS", "SOURCES", "SPECS", "SRPMS"] {
        fs::create_dir_all(top.join(d))?;
    }
    let files = inventory(root)?
        .into_iter()
        .map(|(p, _)| p)
        .filter(|p| !p.starts_with("/DEBIAN/"))
        .collect::<Vec<_>>()
        .join("\n");
    let spec = format!(
        "Name: {name}\nVersion: {version}\nRelease: {}\nSummary: {summary}\nLicense: {}\nPackager: {}\nBuildArch: {arch}\n{}{}\n\n%description\n{summary}. Installation does not start services.\n\n%prep\n%build\n%install\nmkdir -p %{{buildroot}}\ncp -a {}/. %{{buildroot}}/\n\n%files\n%defattr(-,root,root,-)\n{files}\n",
        cfg.release,
        cfg.license,
        cfg.maintainer,
        deps.iter()
            .map(|d| format!("Requires: {d}\n"))
            .collect::<String>(),
        recommends
            .iter()
            .map(|d| format!("Recommends: {d}\n"))
            .collect::<String>(),
        root.display(),
    );
    let spec_path = top.join("SPECS").join(format!("{name}.spec"));
    fs::write(&spec_path, spec)?;
    let mut cmd = Command::new(rpm);
    cmd.arg("-bb")
        .arg("--target")
        .arg(arch)
        .arg("--define")
        .arg(format!("_topdir {}", top.display()))
        .arg("--define")
        .arg("_build_id_links none")
        .arg("--define")
        .arg("__os_install_post %{nil}")
        .arg("--define")
        .arg("_enable_debug_packages 0")
        .arg("--define")
        .arg("debug_package %{nil}")
        .arg(&spec_path);
    run(&mut cmd, "rpmbuild")?;
    let dir = top.join("RPMS").join(arch);
    let built = fs::read_dir(&dir)?
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .find(|p| p.extension().and_then(|x| x.to_str()) == Some("rpm"))
        .ok_or_else(|| anyhow!("rpmbuild produced no rpm"))?;
    Ok(built)
}

pub fn package_main(root: &Path, options: PackageOptions) -> Result<Value> {
    let cfg = parse_release(
        options
            .config
            .as_deref()
            .unwrap_or(&root.join("packaging/release.yaml")),
    )?;
    if !matches!(options.format.as_str(), "rpm" | "deb" | "all") {
        bail!("format must be rpm, deb or all")
    }
    if !cfg.runtime.architectures.contains_key(&options.arch) {
        bail!("unsupported arch")
    }
    fs::create_dir_all(&options.out)?;
    fs::create_dir_all(&options.cache)?;
    let pkg: Value = serde_json::from_slice(&fs::read(root.join("package.json"))?)?;
    let version = pkg
        .get("version")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("package version missing"))?;
    let stage = env::temp_dir().join(format!("mcpbrowser-package-{}", std::process::id()));
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    fs::create_dir_all(&stage)?;
    let payload = stage_main(root, &cfg, &options, &stage)?;
    let mut artifacts = Vec::new();
    for format in if options.format == "all" {
        vec!["rpm", "deb"]
    } else {
        vec![options.format.as_str()]
    } {
        let built = if format == "deb" {
            build_deb(
                &cfg,
                &options,
                &payload,
                &stage,
                &cfg.name,
                &cfg.summary,
                version,
                &cfg.dependencies.deb,
                &cfg.dependencies.deb_recommends,
            )?
        } else {
            build_rpm(
                &cfg,
                &options,
                &payload,
                &stage,
                &cfg.name,
                &cfg.summary,
                version,
                &cfg.dependencies.rpm,
                &cfg.dependencies.rpm_recommends,
            )?
        };
        let dst = options.out.join(built.file_name().unwrap());
        fs::copy(&built, &dst)?;
        let sha = sha256_file(&dst)?;
        fs::write(
            dst.with_extension(format!(
                "{}sha256",
                dst.extension()
                    .map(|x| format!("{}.", x.to_string_lossy()))
                    .unwrap_or_default()
            )),
            format!("{sha}  {}\n", dst.file_name().unwrap().to_string_lossy()),
        )?;
        artifacts.push(json!({"format": format, "file": dst, "sha256": sha}));
    }
    let result = json!({"name": cfg.name, "version": version, "release": cfg.release, "arch": options.arch, "artifacts": artifacts, "files": inventory(&payload)?.len()});
    fs::write(
        options.out.join("manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&result)?),
    )?;
    fs::remove_dir_all(stage).ok();
    Ok(result)
}

fn os_release() -> Result<BTreeMap<String, String>> {
    let text = fs::read_to_string("/etc/os-release")?;
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let Some((k, v)) = line.split_once('=') else {
            continue;
        };
        if k.chars().all(|c| c.is_ascii_uppercase() || c == '_') {
            out.insert(k.into(), v.trim_matches('"').into());
        }
    }
    Ok(out)
}

pub fn package_native(root: &Path, mut options: PackageOptions) -> Result<Value> {
    let cfg = parse_release(
        options
            .config
            .as_deref()
            .unwrap_or(&root.join("packaging/release.yaml")),
    )?;
    if !matches!(options.format.as_str(), "rpm" | "deb") {
        bail!("native package requires --format rpm|deb")
    }
    let host = host_arch()?.to_string();
    options.arch = host.clone();
    let distro = os_release()?;
    let families = format!(
        "{} {}",
        distro.get("ID").cloned().unwrap_or_default(),
        distro.get("ID_LIKE").cloned().unwrap_or_default()
    );
    if options.format == "deb"
        && !families
            .split_whitespace()
            .any(|x| matches!(x, "debian" | "ubuntu"))
    {
        bail!("build native DEBs on Debian/Ubuntu")
    }
    if options.format == "rpm"
        && !families
            .split_whitespace()
            .any(|x| matches!(x, "fedora" | "rhel" | "centos" | "suse" | "opensuse"))
    {
        bail!("build native RPMs on a compatible RPM distribution")
    }
    let cargo = find_executable(&cfg.builder.cargo).ok_or_else(|| anyhow!("cargo is required"))?;
    let target = root.join("native-rs/target");
    let mut control = Command::new(&cargo);
    control
        .current_dir(root)
        .args(["build", "--locked", "--release", "--manifest-path"])
        .arg(root.join("control-rs/Cargo.toml"))
        .arg("--bin")
        .arg("mcpbrowser-session");
    if options.offline {
        control.arg("--offline");
    }
    run(&mut control, "build native session")?;
    let mut native = Command::new(cargo);
    native
        .current_dir(root)
        .args(["build", "--locked", "--release", "--bins", "--target-dir"])
        .arg(&target)
        .arg("--manifest-path")
        .arg(root.join("native-rs/Cargo.toml"));
    if options.offline {
        native.arg("--offline");
    }
    run(&mut native, "build native binaries")?;
    let stage = env::temp_dir().join(format!("mcpbrowser-native-package-{}", std::process::id()));
    if stage.exists() {
        fs::remove_dir_all(&stage)?;
    }
    let payload = stage.join("root");
    fs::create_dir_all(&payload)?;
    let machine = cfg.runtime.architectures[&host].elf_machine;
    let mut binaries = cfg.native.binaries.clone();
    binaries.push("mcpbrowser-session".into());
    for binary in &binaries {
        let source = if binary == "mcpbrowser-session" {
            root.join("control-rs/target/release/mcpbrowser-session")
        } else {
            target.join("release").join(binary)
        };
        validate_elf(&source, machine)?;
        write_root(
            &payload,
            &format!("{}/native/bin/{binary}", cfg.paths.app),
            &fs::read(source)?,
            0o755,
        )?;
    }
    write_root(
        &payload,
        &format!(
            "{}/{}/copyright",
            cfg.system_paths.docs_dir.trim_end_matches('/'),
            cfg.native.name
        ),
        &fs::read(root.join("LICENSE"))?,
        0o644,
    )?;
    write_root(
        &payload,
        &format!(
            "{}/{}/Cargo.lock",
            cfg.system_paths.docs_dir.trim_end_matches('/'),
            cfg.native.name
        ),
        &fs::read(root.join("native-rs/Cargo.lock"))?,
        0o644,
    )?;
    write_root(
        &payload,
        &format!(
            "{}/{}/native.yaml",
            cfg.system_paths.docs_dir.trim_end_matches('/'),
            cfg.native.name
        ),
        &fs::read(root.join("examples/native.yaml"))?,
        0o644,
    )?;
    fs::create_dir_all(&options.out)?;
    let pkg: Value = serde_json::from_slice(&fs::read(root.join("package.json"))?)?;
    let version = pkg
        .get("version")
        .and_then(Value::as_str)
        .unwrap_or("0.0.0");
    let mut deb_deps = vec![
        format!("{} (= {}-{})", cfg.name, version, cfg.release),
        "sway".into(),
        "grim".into(),
        "wtype".into(),
        "wlr-randr".into(),
        "at-spi2-core".into(),
        "dbus".into(),
    ];
    if options.format == "deb" {
        if let Some(shlibdeps) = find_executable(&cfg.builder.dpkg_shlibdeps) {
            let debian = stage.join("debian");
            fs::create_dir_all(&debian)?;
            fs::write(
                debian.join("control"),
                format!(
                    "Source: {}\nSection: utils\nPriority: optional\nMaintainer: {}\n\nPackage: {}\nArchitecture: any\nDescription: native backend\n",
                    cfg.native.name, cfg.maintainer, cfg.native.name
                ),
            )?;
            let mut c = Command::new(shlibdeps);
            c.current_dir(&stage).arg("-O");
            for binary in &binaries {
                c.arg(format!(
                    "-e{}",
                    payload
                        .join(cfg.paths.app.trim_start_matches('/'))
                        .join("native/bin")
                        .join(binary)
                        .display()
                ));
            }
            if let Ok(text) = output(&mut c, "dpkg-shlibdeps") {
                if let Some(line) = text.lines().find(|l| l.starts_with("shlibs:Depends=")) {
                    deb_deps.extend(
                        line.trim_start_matches("shlibs:Depends=")
                            .split(", ")
                            .map(str::to_string),
                    );
                }
            }
        }
    }
    let rpm_deps = vec![
        format!("{} = {}-{}", cfg.name, version, cfg.release),
        "sway".into(),
        "grim".into(),
        "wtype".into(),
        "wlr-randr".into(),
        "at-spi2-core".into(),
        "dbus".into(),
    ];
    let built = if options.format == "deb" {
        build_deb(
            &cfg,
            &options,
            &payload,
            &stage,
            &cfg.native.name,
            "Optional native backend for MCPBrowser",
            version,
            &deb_deps,
            &[],
        )?
    } else {
        build_rpm(
            &cfg,
            &options,
            &payload,
            &stage,
            &cfg.native.name,
            "Optional native backend for MCPBrowser",
            version,
            &rpm_deps,
            &[],
        )?
    };
    let dst = options.out.join(built.file_name().unwrap());
    fs::copy(&built, &dst)?;
    let sha = sha256_file(&dst)?;
    let result = json!({"file": dst, "sha256": sha, "distro": distro, "arch": host, "files": inventory(&payload)?.len()});
    fs::write(
        options.out.join("native-manifest.json"),
        format!("{}\n", serde_json::to_string_pretty(&result)?),
    )?;
    fs::remove_dir_all(stage).ok();
    Ok(result)
}
