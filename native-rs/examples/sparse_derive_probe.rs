use anyhow::{Result, ensure};
use mcpbrowser_native_cua::{
    live::{
        capture::Capture,
        gpu::{DamageRect, EncoderInput},
    },
    read_desktop_info,
};
use std::{
    os::fd::{FromRawFd, OwnedFd},
    path::Path,
    time::{Duration, Instant},
};

fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("warn").init();
    let desktop = read_desktop_info()?;
    let input = EncoderInput::new(
        Path::new(&desktop.render_node),
        desktop.width,
        desktop.height,
    )?;
    let mut capture = Capture::connect(&desktop)?;
    let raw = unsafe { libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK) };
    ensure!(raw >= 0, "eventfd failed");
    let wake = unsafe { OwnedFd::from_raw_fd(raw) };
    let deadline = Instant::now() + Duration::from_secs(4);
    let mut samples = Vec::new();
    let mut compared = 0u64;
    let mut mismatched = 0u64;
    let mut first_diff = None;
    while Instant::now() < deadline {
        capture.pump(Duration::from_millis(20), &wake)?;
        let Some(frame) = capture.take_latest() else {
            continue;
        };
        if !frame.is_ready()? {
            continue;
        }
        let rect = frame.damage.first().copied().unwrap_or(DamageRect {
            x: 0,
            y: 0,
            width: 96,
            height: 96,
        });
        let region = DamageRect {
            x: rect.x.min(desktop.width - 96),
            y: rect.y.min(desktop.height - 96),
            width: 96,
            height: 96,
        };
        let started = Instant::now();
        let derived = input.readback_region_derive_32(&frame.buffer, region);
        let elapsed = started.elapsed().as_micros() as u64;
        match derived {
            Ok((df, dw, dh, ddata)) => {
                let (rf, rw, rh, rdata) = input.readback_region_32(&frame.buffer, region)?;
                ensure!(dw == rw && dh == rh, "dimension mismatch");
                compared += 1;
                let equivalent = if df == rf {
                    ddata == rdata
                } else if df == 0x4247_5258 && rf == 0x5852_4742 {
                    // VA XRGB bytes are X,R,G,B; the vaGetImage reference is
                    // BGRX. Ignore the unspecified byte and compare RGB.
                    ddata
                        .chunks_exact(4)
                        .zip(rdata.chunks_exact(4))
                        .all(|(d, r)| d[1] == r[2] && d[2] == r[1] && d[3] == r[0])
                } else {
                    false
                };
                if !equivalent {
                    mismatched += 1;
                    if first_diff.is_none() {
                        first_diff = Some(0);
                    }
                }
                samples.push(elapsed);
            }
            Err(error) => {
                println!(
                    "{}",
                    serde_json::json!({"supported":false,"error":format!("{error:#}")})
                );
                return Ok(());
            }
        }
    }
    samples.sort_unstable();
    ensure!(!samples.is_empty(), "no samples");
    let pct = |p: f64| samples[((samples.len() - 1) as f64 * p).round() as usize];
    println!(
        "{}",
        serde_json::to_string_pretty(&serde_json::json!({
            "supported":true,"samples":samples.len(),"avg_us":samples.iter().sum::<u64>()/samples.len() as u64,
            "p50_us":pct(0.5),"p95_us":pct(0.95),"compared":compared,"mismatched":mismatched,"first_diff":first_diff
        }))?
    );
    Ok(())
}
