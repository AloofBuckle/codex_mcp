//! Real-GPU sparse desktop protocol feasibility probe.
//! Measures damage-region readback from KWin's leased output DMA-BUF without
//! changing the production streaming protocol.
use anyhow::{Context, Result, ensure};
use mcpbrowser_native_cua::{
    live::{
        capture::Capture,
        gpu::{DamageRect, EncoderInput},
    },
    read_desktop_info,
};
use std::{
    path::Path,
    time::{Duration, Instant},
};

fn bounding_damage(rects: &[DamageRect], width: u32, height: u32) -> DamageRect {
    if rects.is_empty() {
        return DamageRect::full(width, height);
    }
    let mut x0 = width;
    let mut y0 = height;
    let mut x1 = 0u32;
    let mut y1 = 0u32;
    for rect in rects {
        x0 = x0.min(rect.x.min(width));
        y0 = y0.min(rect.y.min(height));
        x1 = x1.max(rect.x.saturating_add(rect.width).min(width));
        y1 = y1.max(rect.y.saturating_add(rect.height).min(height));
    }
    if x1 <= x0 || y1 <= y0 {
        DamageRect::full(width, height)
    } else {
        DamageRect {
            x: x0,
            y: y0,
            width: x1 - x0,
            height: y1 - y0,
        }
    }
}

fn percentile(values: &mut [u64], p: f64) -> u64 {
    values.sort_unstable();
    let at = ((values.len().saturating_sub(1)) as f64 * p).round() as usize;
    values[at]
}

fn main() -> Result<()> {
    tracing_subscriber::fmt().with_env_filter("warn").init();
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    let seconds = args
        .first()
        .cloned()
        .unwrap_or_else(|| "5".into())
        .parse::<u64>()?;
    let multi = args.get(1).is_some_and(|v| v == "multi");
    let fixed = match (args.get(1), args.get(2)) {
        (Some(v), _) if v == "multi" => None,
        (Some(w), Some(h)) => Some((w.parse::<u32>()?, h.parse::<u32>()?)),
        (None, None) => None,
        _ => anyhow::bail!("usage: sparse_readback_probe [SECONDS [FIXED_WIDTH FIXED_HEIGHT]]"),
    };
    let desktop = read_desktop_info()?;
    let input = EncoderInput::new(
        Path::new(&desktop.render_node),
        desktop.width,
        desktop.height,
    )?;
    let mut capture = Capture::connect(&desktop)?;
    let deadline = Instant::now() + Duration::from_secs(seconds);
    let mut samples = Vec::new();
    let mut bytes = 0u64;
    let mut pixels = 0u64;
    let mut region_pixels = Vec::new();
    let mut rect_sum_pixels = Vec::new();
    let mut rect_counts = Vec::new();
    let mut frames = 0u64;
    let mut fourcc = 0u32;

    while Instant::now() < deadline {
        capture.pump(Duration::from_millis(20), &unsafe {
            use std::os::fd::{FromRawFd, OwnedFd};
            // This fd is never signaled; Capture::pump also wakes on Wayland.
            let fd = libc::eventfd(0, libc::EFD_CLOEXEC | libc::EFD_NONBLOCK);
            ensure!(fd >= 0, "eventfd failed");
            OwnedFd::from_raw_fd(fd)
        })?;
        let Some(frame) = capture.take_latest() else {
            continue;
        };
        if !frame.is_ready()? {
            continue;
        }
        let damage = bounding_damage(&frame.damage, frame.buffer.width, frame.buffer.height);
        let sum = frame.damage.iter().map(|rect| rect.area()).sum::<u64>();
        rect_sum_pixels.push(sum);
        rect_counts.push(frame.damage.len() as u64);
        let region = if let Some((width, height)) = fixed {
            ensure!(
                width > 0
                    && height > 0
                    && width <= frame.buffer.width
                    && height <= frame.buffer.height,
                "invalid fixed sparse readback size"
            );
            DamageRect {
                x: damage.x.min(frame.buffer.width - width),
                y: damage.y.min(frame.buffer.height - height),
                width,
                height,
            }
        } else {
            damage
        };
        region_pixels.push(region.area());
        // Skip the force-full bootstrap frame; sparse feasibility is about the
        // steady-state damage path.
        if frames == 0
            && region.area() == u64::from(frame.buffer.width) * u64::from(frame.buffer.height)
        {
            frames += 1;
            continue;
        }
        let started = Instant::now();
        let frame_bytes;
        if multi {
            let (fmt, patches) = input
                .readback_rects_bounding_32(&frame.buffer, &frame.damage)
                .context("bounding sparse readback")?;
            fourcc = fmt;
            frame_bytes = patches.iter().map(|(_, data)| data.len()).sum();
        } else {
            let (fmt, width, height, data) = input
                .readback_region_32(&frame.buffer, region)
                .with_context(|| {
                    format!(
                        "readback {}x{} at {},{}",
                        region.width, region.height, region.x, region.y
                    )
                })?;
            ensure!(
                data.len() == width as usize * height as usize * 4,
                "unexpected sparse payload size"
            );
            fourcc = fmt;
            frame_bytes = data.len();
        }
        let elapsed = started.elapsed().as_micros() as u64;
        samples.push(elapsed);
        bytes += frame_bytes as u64;
        pixels += if multi { sum } else { region.area() };
        frames += 1;
    }
    ensure!(!samples.is_empty(), "no sparse readback samples");
    let avg = samples.iter().sum::<u64>() / samples.len() as u64;
    let mut p50v = samples.clone();
    let mut p95v = samples.clone();
    let mut p99v = samples.clone();
    let mut region_p50 = region_pixels.clone();
    let mut region_p95 = region_pixels.clone();
    let mut sum_p50 = rect_sum_pixels.clone();
    let mut sum_p95 = rect_sum_pixels.clone();
    let mut count_p50 = rect_counts.clone();
    let sparse_64k = region_pixels
        .iter()
        .filter(|&&area| area.saturating_mul(4) <= 64 * 1024)
        .count();
    let sparse_128k = region_pixels
        .iter()
        .filter(|&&area| area.saturating_mul(4) <= 128 * 1024)
        .count();
    let report = serde_json::json!({
        "samples": samples.len(),
        "frames_seen": frames,
        "fourcc": fourcc,
        "avg_us": avg,
        "p50_us": percentile(&mut p50v, 0.50),
        "p95_us": percentile(&mut p95v, 0.95),
        "p99_us": percentile(&mut p99v, 0.99),
        "max_us": samples.iter().copied().max().unwrap_or(0),
        "avg_pixels": pixels / samples.len() as u64,
        "region_p50_pixels": percentile(&mut region_p50, 0.50),
        "region_p95_pixels": percentile(&mut region_p95, 0.95),
        "rect_sum_p50_pixels": percentile(&mut sum_p50, 0.50),
        "rect_sum_p95_pixels": percentile(&mut sum_p95, 0.95),
        "rect_count_p50": percentile(&mut count_p50, 0.50),
        "under_64k_ratio": sparse_64k as f64 / region_pixels.len() as f64,
        "under_128k_ratio": sparse_128k as f64 / region_pixels.len() as f64,
        "avg_bytes": bytes / samples.len() as u64,
        "fixed_width": fixed.map(|v| v.0),
        "fixed_height": fixed.map(|v| v.1),
        "multi_rect": multi,
        "payload_mbps_at_120fps": (bytes as f64 / samples.len() as f64) * 120.0 * 8.0 / 1_000_000.0,
    });
    println!("{}", serde_json::to_string_pretty(&report)?);
    Ok(())
}
