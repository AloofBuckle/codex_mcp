//! Opt-in, real-GPU integration probe. Not part of the production producer.
use anyhow::{Context, Result, ensure};
use mcpbrowser_native_cua::{
    live::codec::{discover_selection, start_av1},
    read_desktop_info,
};
use std::{
    io::Write,
    time::{Duration, Instant},
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_env_filter("info")
        .init();
    let mut args = std::env::args().skip(1);
    let path = args
        .next()
        .context("usage: direct_gpu_probe OUTPUT.obu [SECONDS]")?;
    let seconds = args.next().unwrap_or_else(|| "8".into()).parse::<u64>()?;
    let desktop = read_desktop_info()?;
    let selection = discover_selection(&desktop)?;
    let hub = start_av1(desktop, &selection).await?;
    let mut rx = hub.subscribe();
    hub.request_keyframe();
    let mut out = std::io::BufWriter::new(std::fs::File::create(&path)?);
    let began = Instant::now();
    let mut frames = 0u64;
    let mut keys = 0u64;
    let mut pts = Vec::new();
    let mut requested_second_key = false;
    while began.elapsed() < Duration::from_secs(seconds) {
        if frames > 0
            && !requested_second_key
            && began.elapsed() >= Duration::from_secs(seconds / 2)
        {
            // This must work on a completely static desktop without a new RGB
            // capture or VPP conversion. The worker owns the keyframe latch.
            hub.request_keyframe();
            requested_second_key = true;
        }
        let remaining = Duration::from_secs(seconds).saturating_sub(began.elapsed());
        match tokio::time::timeout(remaining.min(Duration::from_secs(3)), rx.recv()).await {
            Ok(Ok(frame)) => {
                ensure!(
                    frames != 0 || (frame.keyframe && frame.has_config),
                    "first packet is not random access"
                );
                out.write_all(&frame.data)?;
                pts.push(frame.pts90k);
                frames += 1;
                keys += u64::from(frame.keyframe);
            }
            Ok(Err(e)) => return Err(e.into()),
            Err(_) if frames == 0 => anyhow::bail!("no encoded frame: {}", hub.diagnostics()),
            Err(_) => {}
        }
    }
    out.flush()?;
    ensure!(frames > 0, "no frames");
    ensure!(
        !requested_second_key || keys >= 2,
        "explicit static IDR request was not honored"
    );
    let report = serde_json::json!({"frames":frames,"keyframes":keys,"pts90k":pts,"pipeline":hub.diagnostics()});
    std::fs::write(format!("{path}.json"), serde_json::to_vec_pretty(&report)?)?;
    println!("{report}");
    drop(rx);
    tokio::time::sleep(Duration::from_millis(2300)).await;
    ensure!(
        hub.diagnostics()["active"] == false,
        "GPU stream did not idle after last subscriber"
    );
    let last_sequence = hub.diagnostics()["encoded"].as_u64().unwrap_or(0);
    let mut rx = hub.subscribe();
    hub.request_keyframe();
    let resumed = tokio::time::timeout(Duration::from_secs(4), rx.recv()).await??;
    ensure!(
        resumed.keyframe && resumed.has_config,
        "restarted stream lacks random access"
    );
    ensure!(
        resumed.sequence >= last_sequence,
        "frame identity reset across idle restart"
    );
    ensure!(
        resumed.pts90k > *pts.last().unwrap(),
        "PTS moved backwards across idle restart"
    );
    drop(rx);
    tokio::time::sleep(Duration::from_millis(2300)).await;
    ensure!(
        hub.diagnostics()["active"] == false,
        "restarted stream did not release GPU resources"
    );
    println!(
        "lifecycle and keyframe checks passed: {}",
        hub.diagnostics()
    );
    Ok(())
}
