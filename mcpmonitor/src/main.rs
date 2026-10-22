use anyhow::{Context, Result, ensure};
use std::{
    net::{IpAddr, SocketAddr},
    path::Path,
};

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "mcpmonitor=info".into()),
        )
        .init();
    let args: Vec<_> = std::env::args().collect();
    if args.len() == 2 && args[1] == "--version" {
        println!("mcpmonitor {}", env!("CARGO_PKG_VERSION"));
        return Ok(());
    }
    ensure!(
        args.len() == 2 || args.len() == 3,
        "usage: mcpmonitor CONFIG.json [127.0.0.1:35122]"
    );
    let bind: SocketAddr = args
        .get(2)
        .map(String::as_str)
        .unwrap_or("127.0.0.1:35122")
        .parse()
        .context("invalid listen address")?;
    ensure!(
        matches!(bind.ip(), IpAddr::V4(ip) if ip.is_loopback())
            || matches!(bind.ip(), IpAddr::V6(ip) if ip.is_loopback()),
        "monitor must bind to loopback; expose externally only through TLS reverse proxy"
    );
    let plane = mcpmonitor::build_control_plane(Path::new(&args[1])).await?;
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(%bind, "standalone mcpmonitor ready");
    axum::serve(listener, plane.router())
        .with_graceful_shutdown(async move {
            #[cfg(unix)]
            {
                if let Ok(mut term) =
                    tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                {
                    tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = term.recv() => {} }
                } else {
                    let _ = tokio::signal::ctrl_c().await;
                }
            }
            #[cfg(not(unix))]
            {
                let _ = tokio::signal::ctrl_c().await;
            }
            drop(plane);
        })
        .await?;
    Ok(())
}
