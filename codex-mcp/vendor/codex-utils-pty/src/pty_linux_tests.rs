//! Portable PTY fallback must release the unsuccessful native launch's resources.

use std::collections::HashMap;
use std::io;
use std::os::fd::AsRawFd;
use std::os::fd::FromRawFd;
use std::os::fd::OwnedFd;
use std::path::Path;

use pretty_assertions::assert_eq;

#[tokio::test]
async fn portable_fallback_releases_native_pty_descriptors() -> anyhow::Result<()> {
    if std::env::var_os("CODEX_TEST_PTY_FALLBACK_PRESSURE").is_none() {
        let output = std::process::Command::new(std::env::current_exe()?)
            .args([
                "--exact",
                "pty::linux_tests::portable_fallback_releases_native_pty_descriptors",
                "--nocapture",
            ])
            .env("CODEX_TEST_PTY_FALLBACK_PRESSURE", "1")
            .output()?;
        assert!(output.status.success(), "{output:?}");
        return Ok(());
    }
    let source = std::fs::File::open("/dev/null")?;
    let mut limit = std::mem::MaybeUninit::<libc::rlimit>::uninit();
    // SAFETY: This isolated subprocess owns its descriptor limit and reservations.
    assert_eq!(
        unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, limit.as_mut_ptr()) },
        0
    );
    let mut limit = unsafe { limit.assume_init() };
    limit.rlim_cur = limit.rlim_cur.min(128);
    assert_eq!(unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) }, 0);
    let mut occupied = Vec::new();
    loop {
        let fd = unsafe { libc::fcntl(source.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 3) };
        if fd == -1 {
            assert_eq!(
                io::Error::last_os_error().raw_os_error(),
                Some(libc::EMFILE)
            );
            break;
        }
        occupied.push(unsafe { OwnedFd::from_raw_fd(fd) });
    }
    // The initial PTY fits, but helper setup cannot. The portable replacement
    // fits only after the initial PTY and its stdio copies have been closed.
    anyhow::ensure!(occupied.len() >= 10, "not enough descriptors to reserve");
    occupied.truncate(occupied.len() - 10);
    let mut child = crate::spawn_pty_process(
        "/bin/sh",
        &["-c".to_owned(), "printf fallback".to_owned()],
        Path::new("/"),
        &HashMap::from([("SHELL".to_owned(), "/bin/sh".to_owned())]),
        &None,
        crate::TerminalSize::default(),
        crate::ChildFds::Inherited(&[]),
    )
    .await?;
    drop(occupied);
    let mut output = Vec::new();
    while let Some(bytes) = child.stdout_rx.recv().await {
        output.extend(bytes);
    }
    assert_eq!((child.exit_rx.await?, output), (0, b"fallback".to_vec()));
    Ok(())
}

#[tokio::test]
async fn portable_pty_reports_argument_overflow_and_keeps_the_valid_boundary() -> anyhow::Result<()>
{
    let maximum = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as usize * 32 - 1;
    for bytes in [maximum, maximum + 1] {
        let command = format!(":{}", " ".repeat(bytes - 1));
        let result = super::spawn_process_portable(
            "/bin/sh",
            &["-c".into(), command],
            Path::new("/"),
            &HashMap::from([("SHELL".into(), "/bin/sh".into())]),
            &None,
            crate::TerminalSize::default(),
        )
        .await;
        if bytes == maximum {
            let child = result?;
            assert_eq!(child.exit_rx.await?, 0);
        } else {
            let error = match result {
                Err(error) => error,
                Ok(child) => {
                    let code = child.exit_rx.await?;
                    anyhow::bail!("overflow incorrectly returned a child with exit code {code}");
                }
            };
            assert_eq!(
                error
                    .downcast_ref::<io::Error>()
                    .and_then(io::Error::raw_os_error),
                Some(libc::E2BIG)
            );
        }
    }
    Ok(())
}

#[tokio::test]
async fn portable_pty_reports_missing_interpreter_before_returning_a_child() -> anyhow::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let root = tempfile::tempdir()?;
    let program = root.path().join("missing-interpreter");
    std::fs::write(&program, "#!/codex-pty-no-such-interpreter\nexit 0\n")?;
    std::fs::set_permissions(&program, std::fs::Permissions::from_mode(0o700))?;
    let result = super::spawn_process_portable(
        program.to_str().unwrap(),
        &[],
        root.path(),
        &HashMap::from([("SHELL".into(), "/bin/sh".into())]),
        &None,
        crate::TerminalSize::default(),
    )
    .await;
    let error = match result {
        Err(error) => error,
        Ok(child) => {
            let code = child.exit_rx.await?;
            anyhow::bail!("missing interpreter incorrectly returned a child with exit code {code}");
        }
    };
    assert_eq!(
        error
            .downcast_ref::<io::Error>()
            .and_then(io::Error::raw_os_error),
        Some(libc::ENOENT)
    );
    Ok(())
}

#[tokio::test]
async fn helper_argument_overflow_is_not_downgraded_to_fallback() -> anyhow::Result<()> {
    let bytes = unsafe { libc::sysconf(libc::_SC_PAGESIZE) } as usize * 32;
    for setup in [
        crate::spawn_helper::Setup::Pipe,
        crate::spawn_helper::Setup::Pty,
    ] {
        let mut command = crate::Command::new("/bin/sh");
        command.arg("a".repeat(bytes));
        let error = match crate::spawn_helper::spawn(&command, setup).await {
            Err(error) => error,
            Ok(_) => anyhow::bail!("argument overflow was downgraded to a compatibility fallback"),
        };
        assert_eq!(error.raw_os_error(), Some(libc::E2BIG));
    }
    Ok(())
}
