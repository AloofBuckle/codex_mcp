use anyhow::{Context, Result};
use axum::{
    Json, Router,
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{Html, IntoResponse, Response},
    routing::{get, post},
};
use mcpbrowser_media_session::{Continuity, Session};
use mcpbrowser_native_cua::settings::setting;
use mcpbrowser_native_cua::{
    live::{
        codec::{
            CodecCapability, EncoderSelection, VideoCodec, VideoHub, discover_selection, start_av1,
        },
        input::{InputController, RemoteInput},
    },
    read_desktop_info,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    net::{IpAddr, SocketAddr},
    sync::{
        Arc, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::{
    net::{TcpListener, UdpSocket, lookup_host},
    sync::{Mutex, OwnedSemaphorePermit, Semaphore, oneshot},
};
use tracing_subscriber::EnvFilter;
use webrtc::{
    api::{
        API, APIBuilder,
        media_engine::{MIME_TYPE_AV1, MediaEngine},
        setting_engine::SettingEngine,
    },
    data_channel::{
        RTCDataChannel, data_channel_init::RTCDataChannelInit,
        data_channel_message::DataChannelMessage, data_channel_state::RTCDataChannelState,
    },
    ice::{
        mdns::MulticastDnsMode,
        network_type::NetworkType,
        udp_mux::{UDPMuxDefault, UDPMuxParams},
        udp_network::UDPNetwork,
    },
    ice_transport::ice_candidate_type::RTCIceCandidateType,
    peer_connection::{
        RTCPeerConnection, configuration::RTCConfiguration,
        peer_connection_state::RTCPeerConnectionState,
        sdp::session_description::RTCSessionDescription,
    },
    rtcp::payload_feedbacks::{
        full_intra_request::FullIntraRequest, picture_loss_indication::PictureLossIndication,
    },
    rtp::{
        codecs::av1::Av1Payloader,
        header::Header as RtpHeader,
        packet::Packet as RtpPacket,
        packetizer::Payloader,
        sequence::{Sequencer, new_random_sequencer},
    },
    rtp_transceiver::{
        RTCPFeedback,
        rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
    },
    track::track_local::{
        TrackLocal, TrackLocalWriter, track_local_static_rtp::TrackLocalStaticRTP,
    },
};

const AV1_PAYLOAD_TYPE: u8 = 125;
const VIDEO_DC_HEADER_LEN: usize = 24;
const VIDEO_DC_CHUNK_PAYLOAD: usize = 12 * 1024;
const INDEX_HTML: &str = include_str!("../../../native-live/index.html");
const MAX_PEERS: usize = 8;
const PEER_SETUP_TIMEOUT: Duration = Duration::from_secs(20);
const PEER_CONNECT_TIMEOUT: Duration = Duration::from_secs(30);
const PEER_DISCONNECT_GRACE: Duration = Duration::from_secs(15);
const PEER_MAX_LIFETIME: Duration = Duration::from_secs(4 * 60 * 60);

#[derive(Debug, Clone, Deserialize)]
struct Offer {
    sdp: String,
}

#[derive(Debug, Serialize)]
struct Answer {
    r#type: &'static str,
    sdp: String,
    codec: VideoCodec,
}

#[derive(Debug, Serialize)]
struct Health {
    ok: bool,
    desktop_epoch: String,
    width: u32,
    height: u32,
    fps: u32,
    idle_fps: u32,
    capture_mode: &'static str,
    rate_control: &'static str,
    bitrate_kbps: Option<u32>,
    max_bitrate_kbps: Option<u32>,
    selected_codec: VideoCodec,
    capture_device: String,
    encode_device: String,
    codecs: Vec<CodecCapability>,
    peers: usize,
    video_subscribers: usize,
    video_viewers: usize,
    peer_streams: Vec<serde_json::Value>,
    pipeline: serde_json::Value,
}

#[derive(Clone)]
struct AppState {
    rtc: RtcServer,
    selection: Arc<EncoderSelection>,
    desktop_epoch: Arc<str>,
    width: u32,
    height: u32,
}

struct PeerEntry {
    pc: Arc<RTCPeerConnection>,
    session: Session,
}

#[derive(Clone)]
struct RtcServer {
    udp_mux: Arc<UDPMuxDefault>,
    public_host: Option<Arc<str>>,
    video: VideoHub,
    input: InputController,
    peers: Arc<Mutex<HashMap<u64, PeerEntry>>>,
    next_peer_id: Arc<AtomicU64>,
    slots: Arc<Semaphore>,
}

impl RtcServer {
    async fn bind(
        bind_addr: &str,
        public_host: Option<String>,
        video: VideoHub,
        input: InputController,
    ) -> Result<Self> {
        let udp = UdpSocket::bind(bind_addr)
            .await
            .with_context(|| format!("bind native live WebRTC UDP {bind_addr}"))?;
        let local_addr = udp.local_addr()?;
        tracing::info!(%local_addr, ?public_host, "native live WebRTC UDP ready");
        Ok(Self {
            udp_mux: UDPMuxDefault::new(UDPMuxParams::new(udp)),
            public_host: public_host.map(Arc::from),
            video,
            input,
            peers: Arc::new(Mutex::new(HashMap::new())),
            next_peer_id: Arc::new(AtomicU64::new(1)),
            slots: Arc::new(Semaphore::new(MAX_PEERS)),
        })
    }

    async fn api(&self, public_route: bool, data_only: bool) -> Result<API> {
        let mut settings = SettingEngine::default();
        settings.set_udp_network(UDPNetwork::Muxed(self.udp_mux.clone()));
        // This endpoint is a fixed, publicly reachable server and should remain
        // ICE-Lite. Browsers are the controlling/full-ICE side. This is also
        // the behavior of the previously proven production path; switching the
        // server to full ICE made mDNS-hidden browser offers depend on a remote
        // candidate pair being materialized before connectivity checks.
        settings.set_lite(true);
        // Browsers may mask their host candidates with .local names. ICE-Lite
        // still needs those remote candidates materialized before nomination.
        // Resolve peer mDNS candidates without advertising our server as mDNS.
        settings.set_ice_multicast_dns_mode(MulticastDnsMode::QueryOnly);

        // Native Live is deliberately IPv4/UDP-only. The browser may include
        // other remote candidate types in its offer, but this endpoint never
        // advertises or listens on TCP and never falls back to it.
        let host = self
            .public_host
            .as_ref()
            .context("MCPBROWSER_NATIVE_LIVE_RTC_PUBLIC_HOST is unset")?;
        let mut resolved = lookup_host((host.as_ref(), 0))
            .await
            .with_context(|| format!("resolve native live RTC public host {host}"))?;
        let public_v4 = resolved
            .find_map(|addr| match addr.ip() {
                IpAddr::V4(ip) => Some(ip),
                IpAddr::V6(_) => None,
            })
            .with_context(|| format!("native live RTC public host {host} has no IPv4 A record"))?;

        let route_probe = UdpSocket::bind("0.0.0.0:0").await?;
        route_probe
            .connect(SocketAddr::from((public_v4, 9)))
            .await
            .context("resolve native live IPv4 default-route source")?;
        let local_v4 = match route_probe.local_addr()?.ip() {
            IpAddr::V4(ip) => ip,
            IpAddr::V6(_) => anyhow::bail!("native live IPv4 route probe selected IPv6"),
        };

        settings.set_network_types(native_udp_network_types());
        settings.set_ip_filter(Box::new(move |ip| ip == IpAddr::V4(local_v4)));

        if public_route {
            settings.set_nat_1to1_ips(vec![public_v4.to_string()], RTCIceCandidateType::Host);
        }
        tracing::info!(
            %public_v4,
            %local_v4,
            public_route,
            "native live WebRTC IPv4 UDP route selected"
        );

        let mut media = MediaEngine::default();
        if !data_only {
            media.register_codec(
                RTCRtpCodecParameters {
                    capability: video_capability(self.video.codec()),
                    payload_type: AV1_PAYLOAD_TYPE,
                    ..Default::default()
                },
                RTPCodecType::Video,
            )?;
        }
        Ok(APIBuilder::new()
            .with_media_engine(media)
            .with_setting_engine(settings)
            .build())
    }

    async fn answer(&self, offer_sdp: String, public_route: bool) -> Result<String> {
        anyhow::ensure!(
            !offer_sdp.is_empty() && offer_sdp.len() <= 64 * 1024,
            "invalid SDP offer"
        );
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .context("native live peer capacity reached")?;
        let api = self.api(public_route, false).await?;
        let pc = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);
        let peer_id = self.next_peer_id.fetch_add(1, Ordering::Relaxed);
        let (lease, lifetime) = self.watch_peer(peer_id, Arc::clone(&pc), permit);

        let setup: Result<String> = tokio::time::timeout(PEER_SETUP_TIMEOUT, async {
            self.install_peer_lifecycle(peer_id, &pc, lifetime.clone());
            self.install_input_channel(peer_id, &pc, lifetime.clone());

            let track = Arc::new(TrackLocalStaticRTP::new(
                video_capability(self.video.codec()),
                "native-video".to_owned(),
                "mcpbrowser-native-live".to_owned(),
            ));
            let sender = pc
                .add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
                .await
                .context("add native live video track")?;

            let video_for_rtcp = self.video.clone();
            lifetime.spawn(async move {
                while let Ok((packets, _)) = sender.read_rtcp().await {
                    let wants_keyframe = packets.iter().any(|packet| {
                        packet
                            .as_any()
                            .downcast_ref::<PictureLossIndication>()
                            .is_some()
                            || packet.as_any().downcast_ref::<FullIntraRequest>().is_some()
                    });
                    if wants_keyframe {
                        video_for_rtcp.request_keyframe();
                        tracing::info!(peer_id, "native live peer requested keyframe");
                    }
                }
            });

            let video_for_track = self.video.clone();
            let pc_for_video = Arc::clone(&pc);
            let task_lifetime = lifetime.clone();
            lifetime.spawn(async move {
                while pc_for_video.connection_state() != RTCPeerConnectionState::Connected {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
                let Some(_media_lease) = task_lifetime.media_lease(video_for_track.demand()) else {
                    return;
                };
                let _end = task_lifetime.close_on_drop();
                let mut frames = video_for_track.subscribe();
                video_for_track.request_keyframe();
                let sequencer = new_random_sequencer();
                let mut continuity = Continuity::default();
                while let Ok(frame) = frames.recv().await {
                    match continuity
                        .accept(frame.sequence as u32, frame.keyframe && frame.has_config)
                    {
                        Ok(true) => {}
                        Ok(false) => continue,
                        Err(error) => {
                            tracing::error!(
                                peer_id,
                                error,
                                "AV1 RTP reference chain discontinuity"
                            );
                            return;
                        }
                    }
                    let packets = match packetize_native_av1(&frame.data, frame.pts90k, &sequencer)
                    {
                        Ok(packets) => packets,
                        Err(error) => {
                            tracing::error!(peer_id, %error, "AV1 RTP packetization failed");
                            return;
                        }
                    };
                    for packet in packets {
                        if let Err(error) = track.write_rtp(&packet).await {
                            tracing::info!(peer_id, %error, "native RTP sender ended");
                            return;
                        }
                    }
                }
            });

            pc.set_remote_description(RTCSessionDescription::offer(offer_sdp)?)
                .await
                .context("set native live remote offer")?;
            let answer = pc
                .create_answer(None)
                .await
                .context("create native live answer")?;
            let mut gather_complete = pc.gathering_complete_promise().await;
            pc.set_local_description(answer)
                .await
                .context("set native live local answer")?;
            let _ = gather_complete.recv().await;
            let local = pc
                .local_description()
                .await
                .context("native live answer missing")?;
            Ok(local.sdp)
        })
        .await
        .unwrap_or_else(|_| Err(anyhow::anyhow!("native live setup deadline exceeded")));
        let sdp = complete_peer_setup(&pc, setup).await?;
        let mut peers = self.peers.lock().await;
        if lease.send(()).is_err() {
            drop(peers);
            let _ = pc.close().await;
            anyhow::bail!("peer expired before setup completed");
        }
        if lifetime.is_closed() {
            drop(peers);
            anyhow::bail!("peer closed during setup commit");
        }
        peers.insert(
            peer_id,
            PeerEntry {
                pc,
                session: lifetime,
            },
        );
        drop(peers);
        tracing::info!(peer_id, codec = %self.video.codec().as_str(), "native live peer created");
        Ok(sdp)
    }

    fn install_peer_lifecycle(&self, peer_id: u64, pc: &Arc<RTCPeerConnection>, lifetime: Session) {
        let peers = Arc::clone(&self.peers);
        let input = self.input.clone();
        pc.on_peer_connection_state_change(Box::new(move |state| {
            if matches!(
                state,
                RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
            ) {
                // Revoke demand/cancel I/O before any async transport cleanup.
                lifetime.close();
            }
            let peers = Arc::clone(&peers);
            let input = input.clone();
            Box::pin(async move {
                tracing::info!(peer_id, %state, "native live peer state");
                if state == RTCPeerConnectionState::Disconnected {
                    // Temporary disconnects are recoverable. The watchdog owns
                    // the 15s grace period and peer-registry lifetime; only
                    // release input ownership immediately so held keys/buttons
                    // cannot stick while the network is down.
                    input.release_peer(peer_id);
                } else if matches!(
                    state,
                    RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
                ) {
                    peers.lock().await.remove(&peer_id);
                    input.release_peer(peer_id);
                }
            })
        }));
    }

    fn watch_peer(
        &self,
        peer_id: u64,
        pc: Arc<RTCPeerConnection>,
        permit: OwnedSemaphorePermit,
    ) -> (oneshot::Sender<()>, Session) {
        let lifetime = Session::new();
        let commit = watch_peer_lifetime(
            peer_id,
            pc,
            permit,
            Arc::clone(&self.peers),
            self.input.clone(),
            lifetime.clone(),
        );
        (commit, lifetime)
    }

    fn install_input_channel(&self, peer_id: u64, pc: &Arc<RTCPeerConnection>, lifetime: Session) {
        let input = self.input.clone();
        let video = self.video.clone();
        let peer = Arc::downgrade(pc);
        pc.on_data_channel(Box::new(move |channel: Arc<RTCDataChannel>| {
            if channel.label() == "input" {
                configure_native_input_channel(
                    peer_id,
                    channel,
                    input.clone(),
                    video.clone(),
                    peer.clone(),
                    lifetime.clone(),
                );
            }
            Box::pin(async {})
        }));
    }

    async fn answer_datachannel(&self, offer_sdp: String, public_route: bool) -> Result<String> {
        anyhow::ensure!(
            !offer_sdp.is_empty() && offer_sdp.len() <= 64 * 1024,
            "invalid SDP offer"
        );
        anyhow::ensure!(
            self.video.codec() == VideoCodec::Av1,
            "native DataChannel renderer requires AV1"
        );
        let permit = self
            .slots
            .clone()
            .try_acquire_owned()
            .context("native live peer capacity reached")?;
        let api = self.api(public_route, true).await?;
        let pc = Arc::new(api.new_peer_connection(RTCConfiguration::default()).await?);
        let peer_id = self.next_peer_id.fetch_add(1, Ordering::Relaxed);
        let (lease, lifetime) = self.watch_peer(peer_id, Arc::clone(&pc), permit);
        let setup: Result<String> = tokio::time::timeout(PEER_SETUP_TIMEOUT, async {
            self.install_peer_lifecycle(peer_id, &pc, lifetime.clone());

            // Use pre-negotiated channel IDs so video/input do not depend on
            // in-band DATA_CHANNEL_OPEN ordering.
            let video_channel = pc
                .create_data_channel(
                    "video",
                    Some(RTCDataChannelInit {
                        ordered: Some(true),
                        max_retransmits: Some(0),
                        negotiated: Some(0),
                        ..Default::default()
                    }),
                )
                .await
                .context("create negotiated native video DataChannel")?;
            let input_channel = pc
                .create_data_channel(
                    "input",
                    Some(RTCDataChannelInit {
                        ordered: Some(true),
                        negotiated: Some(1),
                        ..Default::default()
                    }),
                )
                .await
                .context("create negotiated native input DataChannel")?;
            configure_native_video_channel(
                peer_id,
                video_channel,
                self.video.clone(),
                Arc::downgrade(&pc),
                lifetime.clone(),
            );
            configure_native_input_channel(
                peer_id,
                input_channel,
                self.input.clone(),
                self.video.clone(),
                Arc::downgrade(&pc),
                lifetime.clone(),
            );

            pc.set_remote_description(RTCSessionDescription::offer(offer_sdp)?)
                .await
                .context("set native live DataChannel remote offer")?;
            let answer = pc
                .create_answer(None)
                .await
                .context("create native live DataChannel answer")?;
            let mut gather_complete = pc.gathering_complete_promise().await;
            pc.set_local_description(answer)
                .await
                .context("set native live DataChannel local answer")?;
            let _ = gather_complete.recv().await;
            let local = pc
                .local_description()
                .await
                .context("native live DataChannel answer missing")?;
            Ok(local.sdp)
        })
        .await
        .unwrap_or_else(|_| {
            Err(anyhow::anyhow!(
                "native DataChannel setup deadline exceeded"
            ))
        });
        let sdp = complete_peer_setup(&pc, setup).await?;
        let mut peers = self.peers.lock().await;
        if lease.send(()).is_err() {
            drop(peers);
            let _ = pc.close().await;
            anyhow::bail!("DataChannel peer expired before setup completed");
        }
        if lifetime.is_closed() {
            drop(peers);
            anyhow::bail!("peer closed during setup commit");
        }
        peers.insert(
            peer_id,
            PeerEntry {
                pc,
                session: lifetime,
            },
        );
        drop(peers);
        tracing::info!(peer_id, "native live DataChannel peer created");
        Ok(sdp)
    }
}

fn native_udp_network_types() -> Vec<NetworkType> {
    vec![NetworkType::Udp4]
}

fn watch_peer_lifetime(
    peer_id: u64,
    pc: Arc<RTCPeerConnection>,
    permit: OwnedSemaphorePermit,
    peers: Arc<Mutex<HashMap<u64, PeerEntry>>>,
    input: InputController,
    lifetime: Session,
) -> oneshot::Sender<()> {
    let (committed, ready) = oneshot::channel();
    tokio::spawn(async move {
        let _permit = permit;
        // The setup future owns the sender. Cancellation therefore triggers
        // cleanup even when negotiation never returns an error value.
        if matches!(
            tokio::time::timeout(PEER_SETUP_TIMEOUT, ready).await,
            Ok(Ok(()))
        ) {
            let started = Instant::now();
            let mut connected = false;
            let mut disconnected_at = None;
            loop {
                if lifetime.is_closed() {
                    break;
                }
                let state = pc.connection_state();
                if peer_expired(
                    state,
                    started.elapsed(),
                    connected,
                    disconnected_at.map(|at: Instant| at.elapsed()),
                ) {
                    break;
                }
                if state == RTCPeerConnectionState::Connected {
                    connected = true;
                    disconnected_at = None;
                } else if state == RTCPeerConnectionState::Disconnected {
                    disconnected_at.get_or_insert_with(Instant::now);
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
        lifetime.close();
        peers.lock().await.remove(&peer_id);
        input.release_peer(peer_id);
        let _ = tokio::time::timeout(Duration::from_secs(3), pc.close()).await;
    });
    committed
}

fn close_peer_after_channel(peer: Weak<RTCPeerConnection>) {
    if let Some(pc) = peer.upgrade()
        && pc.connection_state() != RTCPeerConnectionState::Closed
    {
        tokio::spawn(async move {
            let _ = tokio::time::timeout(Duration::from_secs(3), pc.close()).await;
        });
    }
}

fn peer_expired(
    state: RTCPeerConnectionState,
    age: Duration,
    was_connected: bool,
    disconnected_for: Option<Duration>,
) -> bool {
    matches!(
        state,
        RTCPeerConnectionState::Failed | RTCPeerConnectionState::Closed
    ) || age >= PEER_MAX_LIFETIME
        || (!was_connected && age >= PEER_CONNECT_TIMEOUT)
        || (state == RTCPeerConnectionState::Disconnected
            && disconnected_for.is_some_and(|duration| duration >= PEER_DISCONNECT_GRACE))
}

async fn complete_peer_setup<T>(pc: &RTCPeerConnection, result: Result<T>) -> Result<T> {
    if result.is_err() {
        // Failed negotiation never enters the peer registry. Close transports
        // explicitly so its tasks and encoder subscription can terminate.
        let _ = tokio::time::timeout(Duration::from_secs(3), pc.close()).await;
    }
    result
}

fn configure_native_input_channel(
    peer_id: u64,
    channel: Arc<RTCDataChannel>,
    input: InputController,
    video: VideoHub,
    peer: std::sync::Weak<RTCPeerConnection>,
    lifetime: Session,
) {
    let control_video = video.clone();
    let cursor_channel = Arc::clone(&channel);
    let cursor_lifetime = lifetime.clone();
    channel.on_open(Box::new(move || {
        let channel = Arc::clone(&cursor_channel);
        let video = video.clone();
        let lifetime = cursor_lifetime.clone();
        Box::pin(async move {
            tracing::info!(peer_id, channel_id = 1u16, "native live input channel open");
            lifetime.spawn(send_cursor_state(peer_id, channel, video));
        })
    }));

    let input_message = input.clone();
    let video_message = control_video;
    let message_lifetime = lifetime.clone();
    channel.on_message(Box::new(move |message: DataChannelMessage| {
        if message_lifetime.is_closed() || message.data.len() > 2048 {
            return Box::pin(async {});
        }
        match serde_json::from_slice::<RemoteInput>(&message.data) {
            Ok(RemoteInput::Snapshot) => {
                video_message.request_keyframe();
                tracing::info!(peer_id, "native live DataChannel peer requested keyframe");
            }
            Ok(event) => input_message.send_from_session(peer_id, event, &message_lifetime),
            Err(error) => tracing::debug!(peer_id, %error, "invalid native live input message"),
        }
        Box::pin(async {})
    }));

    let input_close = input;
    channel.on_close(Box::new(move || {
        lifetime.close();
        input_close.release_peer(peer_id);
        close_peer_after_channel(peer.clone());
        Box::pin(async move {
            tracing::info!(
                peer_id,
                channel_id = 1u16,
                "native live input channel closed"
            );
        })
    }));
}

async fn send_cursor_state(peer_id: u64, channel: Arc<RTCDataChannel>, video: VideoHub) {
    let mut cursor = video.subscribe_cursor();
    loop {
        if channel.ready_state() != RTCDataChannelState::Open {
            return;
        }
        let message = match serde_json::to_string(&*cursor.borrow_and_update()) {
            Ok(message) => message,
            Err(error) => {
                tracing::warn!(peer_id, %error, "serialize native cursor state failed");
                return;
            }
        };
        if let Err(error) = channel.send_text(message).await {
            tracing::debug!(peer_id, %error, "native cursor metadata send loop ended");
            return;
        }
        if cursor.changed().await.is_err() {
            return;
        }
    }
}

fn configure_native_video_channel(
    peer_id: u64,
    channel: Arc<RTCDataChannel>,
    video: VideoHub,
    peer: Weak<RTCPeerConnection>,
    lifetime: Session,
) {
    tracing::info!(
        peer_id,
        channel_id = 0u16,
        ordered = channel.ordered(),
        max_retransmits = ?channel.max_retransmits(),
        max_packet_lifetime = ?channel.max_packet_lifetime(),
        "native live negotiated video DataChannel configured"
    );
    // Keep the negotiated channel alive through SCTP/DTLS establishment.  A
    // Weak handle here races the local Arc going out of scope after the SDP
    // answer is returned, which leaves ICE connected but the video channel
    // never reaches Open.
    let close_lifetime = lifetime.clone();
    let close_peer = peer.clone();
    channel.on_close(Box::new(move || {
        close_lifetime.close();
        close_peer_after_channel(close_peer.clone());
        Box::pin(async {})
    }));
    let channel_for_open = Arc::clone(&channel);
    channel.on_open(Box::new(move || {
        let channel = Arc::clone(&channel_for_open);
        let video = video.clone();
        let peer = peer.clone();
        let lifetime = lifetime.clone();
        Box::pin(async move {
            // on_open is a transport callback, not the lifetime of the stream.
            // Keeping it pending can block channel shutdown and strand a video
            // subscriber after the peer has gone, keeping the GPU alive forever.
            let media_lifetime = lifetime.clone();
            lifetime.spawn(async move {
            tracing::info!(peer_id, channel_id = 0u16, "native live video channel open");
            let Some(_media_lease) = media_lifetime.media_lease(video.demand()) else { return; };
            let _end = media_lifetime.close_on_drop();
            let observation_channel = channel.clone();
            let observation_lifetime = media_lifetime.clone();
            media_lifetime.spawn(async move {
                let mut interval = tokio::time::interval(Duration::from_secs(1));
                loop {
                    interval.tick().await;
                    observation_lifetime.send_metrics().set_buffered(observation_channel.buffered_amount().await);
                }
            });
            let mut frames = video.subscribe();
            video.request_keyframe();
            let mut continuity = Continuity::default();
            let mut lagged_frames = 0u64;
            let mut sent_frames = 0u64;
            let mut sent_chunks = 0u64;
            let mut sent_bytes = 0u64;
            let mut report_started = Instant::now();
            let mut publisher_age_us_max = 0u64;
            let mut send_us_max = 0u64;

            'stream: loop {
                // A closed receiver must not keep a capture subscription alive
                // forever, especially while the desktop has no new damage.
                if channel.ready_state() != RTCDataChannelState::Open {
                    break;
                }
                let peer_state = peer
                    .upgrade()
                    .map(|pc| pc.connection_state())
                    .unwrap_or(RTCPeerConnectionState::Closed);
                if matches!(
                    peer_state,
                    RTCPeerConnectionState::Closed | RTCPeerConnectionState::Failed
                ) {
                    break;
                }
                let frame = match tokio::time::timeout(
                    Duration::from_millis(250),
                    frames.recv(),
                )
                .await
                {
                    Err(_) => continue,
                    Ok(Ok(frame)) => frame,
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Lagged(skipped))) => {
                        tracing::warn!(peer_id, skipped, "native live DataChannel subscriber lagged");
                        lagged_frames += skipped;
                        tracing::error!(peer_id, lagged_frames, "AV1 reference chain lost; ending only this sender without recovery");
                        break;
                    }
                    Ok(Err(tokio::sync::broadcast::error::RecvError::Closed)) => break,
                };
                publisher_age_us_max = publisher_age_us_max.max(frame.published_at.elapsed().as_micros() as u64);
                match continuity.accept(frame.sequence as u32, frame.keyframe && frame.has_config) {
                    Ok(true) => {}, Ok(false) => continue,
                    Err(error) => { tracing::error!(peer_id, error, "AV1 fanout discontinuity"); break; }
                }

                let chunk_count = frame.data.len().div_ceil(VIDEO_DC_CHUNK_PAYLOAD);
                if chunk_count == 0 || chunk_count > u16::MAX as usize {
                    tracing::error!(peer_id, sequence = frame.sequence, bytes = frame.data.len(), "invalid AV1 frame; ending reference chain");
                    break;
                }
                let flags = if frame.keyframe { 1u8 } else { 0u8 };
                let frame_id = frame.sequence as u32;
                let pts90k = frame.pts90k;
                for (chunk_index, payload) in
                    frame.data.chunks(VIDEO_DC_CHUNK_PAYLOAD).enumerate()
                {
                    let mut message = Vec::with_capacity(VIDEO_DC_HEADER_LEN + payload.len());
                    message.extend_from_slice(b"MWD1");
                    message.push(flags);
                    message.push(0);
                    message.extend_from_slice(&(VIDEO_DC_HEADER_LEN as u16).to_be_bytes());
                    message.extend_from_slice(&frame_id.to_be_bytes());
                    message.extend_from_slice(&pts90k.to_be_bytes());
                    message.extend_from_slice(&(chunk_index as u16).to_be_bytes());
                    message.extend_from_slice(&(chunk_count as u16).to_be_bytes());
                    message.extend_from_slice(&(frame.data.len() as u32).to_be_bytes());
                    message.extend_from_slice(payload);
                    let message = bytes::Bytes::from(message);
                    let send_started = Instant::now();
                    media_lifetime.send_metrics().begin();
                    let sent = channel.send(&message).await;
                    if sent.is_err() { media_lifetime.send_metrics().end(); }
                    if let Err(error) = sent {
                        tracing::info!(peer_id, %error, "native live video DataChannel send loop ended");
                        break 'stream;
                    }
                    send_us_max = send_us_max.max(send_started.elapsed().as_micros() as u64);
                    media_lifetime.send_metrics().complete(message.len());
                    sent_bytes += message.len() as u64;
                    sent_chunks += 1;
                }
                sent_frames += 1;

                if report_started.elapsed() >= Duration::from_secs(1) {
                    let seconds = report_started.elapsed().as_secs_f64();
                    let buffered_amount = channel.buffered_amount().await;
                    tracing::info!(
                        peer_id,
                        fps = sent_frames as f64 / seconds,
                        chunks_per_second = sent_chunks as f64 / seconds,
                        mbps = sent_bytes as f64 * 8.0 / seconds / 1_000_000.0,
                        buffered_amount,
                        lagged_frames,
                        publisher_age_us_max,
                        send_us_max,
                        sender_pacing = "source-realtime",
                        "native live AV1 DataChannel stream"
                    );
                    sent_frames = 0;
                    sent_chunks = 0;
                    sent_bytes = 0;
                    lagged_frames = 0;
                    publisher_age_us_max = 0;
                    send_us_max = 0;
                    report_started = Instant::now();
                }
            }
            tracing::info!(peer_id, "native live DataChannel capture subscription released");
            });
        })
    }));
}

fn video_capability(codec: VideoCodec) -> RTCRtpCodecCapability {
    match codec {
        VideoCodec::Av1 => RTCRtpCodecCapability {
            mime_type: MIME_TYPE_AV1.to_owned(),
            clock_rate: 90_000,
            channels: 0,
            sdp_fmtp_line: "profile-id=0".to_owned(),
            rtcp_feedback: vec![
                RTCPFeedback {
                    typ: "goog-remb".into(),
                    parameter: String::new(),
                },
                RTCPFeedback {
                    typ: "ccm".into(),
                    parameter: "fir".into(),
                },
                RTCPFeedback {
                    typ: "nack".into(),
                    parameter: String::new(),
                },
                RTCPFeedback {
                    typ: "nack".into(),
                    parameter: "pli".into(),
                },
            ],
        },
    }
}

fn packetize_native_av1(
    data: &bytes::Bytes,
    pts90k: u32,
    sequencer: &dyn Sequencer,
) -> Result<Vec<RtpPacket>> {
    let payloads = Av1Payloader::default().payload(1188, data)?;
    anyhow::ensure!(!payloads.is_empty(), "empty AV1 RTP frame");
    let last = payloads.len() - 1;
    Ok(payloads
        .into_iter()
        .enumerate()
        .map(|(index, payload)| RtpPacket {
            header: RtpHeader {
                version: 2,
                marker: index == last,
                payload_type: AV1_PAYLOAD_TYPE,
                sequence_number: sequencer.next_sequence_number(),
                timestamp: pts90k,
                ..Default::default()
            },
            payload,
        })
        .collect())
}

async fn index() -> Response {
    let mut response = Html(INDEX_HTML).into_response();
    response.headers_mut().insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("no-store, max-age=0"),
    );
    response.headers_mut().insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    response
}

async fn health(State(state): State<AppState>) -> Json<Health> {
    let peers = state.rtc.peers.lock().await;
    Json(Health {
        ok: true,
        desktop_epoch: state.desktop_epoch.to_string(),
        width: state.width,
        height: state.height,
        fps: state.selection.max_fps,
        idle_fps: state.selection.idle_fps,
        capture_mode: "damage-vfr",
        rate_control: state.selection.rate_control.mode.as_str(),
        bitrate_kbps: state.selection.rate_control.target_kbps(),
        max_bitrate_kbps: state.selection.rate_control.max_kbps(),
        selected_codec: state.selection.codec,
        capture_device: state.selection.capture_device.clone(),
        encode_device: state.selection.encode_device.clone(),
        codecs: state.selection.capabilities.clone(),
        peers: peers.len(),
        video_subscribers: state.rtc.video.receiver_count(),
        video_viewers: state.rtc.video.viewer_count(),
        peer_streams: peers
            .iter()
            .map(|(id, entry)| {
                serde_json::json!({
                    "peer_id": id, "state": entry.pc.connection_state().to_string(),
                    "tasks": entry.session.task_count(), "cancelled": entry.session.is_closed(),
                    "send_pending_ms": entry.session.send_metrics().pending_ms(),
                    "buffered_bytes": entry.session.send_metrics().buffered_bytes(),
                    "sent_chunks": entry.session.send_metrics().chunks(),
                    "sent_bytes": entry.session.send_metrics().bytes(),
                })
            })
            .collect(),
        pipeline: state.rtc.video.diagnostics(),
    })
}

async fn offer(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(offer): Json<Offer>,
) -> Response {
    let public_route = headers
        .get("x-native-live-public")
        .and_then(|value| value.to_str().ok())
        == Some("1");
    match state.rtc.answer(offer.sdp, public_route).await {
        Ok(sdp) => Json(Answer {
            r#type: "answer",
            sdp,
            codec: state.selection.codec,
        })
        .into_response(),
        Err(error) => {
            tracing::warn!(%error, "native live offer failed");
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response()
        }
    }
}

async fn offer_datachannel(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(offer): Json<Offer>,
) -> Response {
    let public_route = headers
        .get("x-native-live-public")
        .and_then(|value| value.to_str().ok())
        == Some("1");
    match state.rtc.answer_datachannel(offer.sdp, public_route).await {
        Ok(sdp) => Json(Answer {
            r#type: "answer",
            sdp,
            codec: state.selection.codec,
        })
        .into_response(),
        Err(error) => {
            tracing::warn!(%error, "native live DataChannel offer failed");
            (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": error.to_string()})),
            )
                .into_response()
        }
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let desktop = read_desktop_info().context("native desktop is not ready")?;
    let selection = discover_selection(&desktop)?;
    tracing::info!(
        codec = %selection.codec.as_str(),
        capture_device = %selection.capture_device,
        encode_device = %selection.encode_device,
        "native live codec selected"
    );
    let video = start_av1(desktop.clone(), &selection).await?;
    let input = InputController::start();
    let rtc_bind = setting("MCPBROWSER_NATIVE_LIVE_RTC_BIND");
    let public_host =
        Some(setting("MCPBROWSER_NATIVE_LIVE_RTC_PUBLIC_HOST")).filter(|v| !v.is_empty());
    let rtc = RtcServer::bind(&rtc_bind, public_host, video, input).await?;
    let state = AppState {
        rtc,
        selection: Arc::new(selection),
        desktop_epoch: Arc::from(desktop.epoch),
        width: desktop.width,
        height: desktop.height,
    };
    let app = Router::new()
        .route("/", get(index))
        .route("/health", get(health))
        .route("/rtc", post(offer))
        .route("/dc", post(offer_datachannel))
        .with_state(state);
    let listen = setting("MCPBROWSER_NATIVE_LIVE_LISTEN");
    let listener = TcpListener::bind(&listen)
        .await
        .with_context(|| format!("bind native live HTTP {listen}"))?;
    tracing::info!(%listen, %rtc_bind, "native live standalone ready");
    axum::serve(listener, app)
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_live_is_strictly_ipv4_udp() {
        assert_eq!(native_udp_network_types(), vec![NetworkType::Udp4]);
    }

    #[test]
    fn peer_expiry_respects_connection_deadline_and_disconnect_grace() {
        assert!(peer_expired(
            RTCPeerConnectionState::New,
            PEER_CONNECT_TIMEOUT,
            false,
            None
        ));
        assert!(!peer_expired(
            RTCPeerConnectionState::Connected,
            Duration::from_secs(60),
            true,
            None
        ));
        assert!(!peer_expired(
            RTCPeerConnectionState::Disconnected,
            Duration::from_secs(60),
            true,
            Some(Duration::from_secs(1))
        ));
        assert!(peer_expired(
            RTCPeerConnectionState::Disconnected,
            Duration::from_secs(60),
            true,
            Some(PEER_DISCONNECT_GRACE)
        ));
        assert!(peer_expired(
            RTCPeerConnectionState::Connected,
            PEER_MAX_LIFETIME,
            true,
            None
        ));
    }

    #[tokio::test]
    async fn cancelled_setup_closes_peer_removes_registry_and_returns_quota() {
        let api = APIBuilder::new().build();
        let pc = Arc::new(
            api.new_peer_connection(RTCConfiguration::default())
                .await
                .unwrap(),
        );
        let lifetime = Session::new();
        let peers = Arc::new(Mutex::new(HashMap::from([(
            42,
            PeerEntry {
                pc: Arc::clone(&pc),
                session: lifetime.clone(),
            },
        )])));
        let slots = Arc::new(Semaphore::new(1));
        let permit = slots.clone().try_acquire_owned().unwrap();
        assert!(slots.clone().try_acquire_owned().is_err());
        let lease = watch_peer_lifetime(
            42,
            Arc::clone(&pc),
            permit,
            Arc::clone(&peers),
            InputController::start(),
            lifetime,
        );
        drop(lease);
        tokio::time::timeout(Duration::from_secs(2), async {
            while slots.available_permits() == 0 {
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(pc.connection_state(), RTCPeerConnectionState::Closed);
        assert!(peers.lock().await.is_empty());
    }

    #[tokio::test]
    async fn failed_peer_setup_closes_transports_and_preserves_the_error() {
        let api = APIBuilder::new().build();
        let pc = api
            .new_peer_connection(RTCConfiguration::default())
            .await
            .unwrap();
        pc.create_data_channel("test", None).await.unwrap();
        let error = complete_peer_setup::<()>(&pc, Err(anyhow::anyhow!("invalid offer")))
            .await
            .unwrap_err();
        assert_eq!(error.to_string(), "invalid offer");
        assert_eq!(pc.connection_state(), RTCPeerConnectionState::Closed);
    }

    #[tokio::test]
    async fn successful_peer_setup_leaves_the_peer_open() {
        let api = APIBuilder::new().build();
        let pc = api
            .new_peer_connection(RTCConfiguration::default())
            .await
            .unwrap();
        let result = complete_peer_setup(&pc, Ok("answer")).await.unwrap();
        assert_eq!(result, "answer");
        assert_ne!(pc.connection_state(), RTCPeerConnectionState::Closed);
        pc.close().await.unwrap();
    }

    #[test]
    fn rtp_preserves_irregular_capture_pts_and_wraparound() {
        let sequencer = webrtc::rtp::sequence::new_fixed_sequencer(65534);
        let frame = bytes::Bytes::from_static(&[0x32, 3, 1, 2, 3]);
        for (index, pts) in [482, 1125, 2459, 93222, u32::MAX - 100, 649]
            .into_iter()
            .enumerate()
        {
            let packets = packetize_native_av1(&frame, pts, &sequencer).unwrap();
            assert_eq!(packets.len(), 1);
            assert_eq!(packets[0].header.timestamp, pts);
            assert_eq!(
                packets[0].header.sequence_number,
                65534u16.wrapping_add(index as u16)
            );
            assert!(packets[0].header.marker);
        }
    }

    #[test]
    fn fragmented_av1_has_one_timestamp_and_one_final_marker() {
        let sequencer = webrtc::rtp::sequence::new_fixed_sequencer(1);
        let mut frame = vec![0x32, 0x80, 0x20];
        frame.resize(4099, 0x55);
        let packets = packetize_native_av1(&frame.into(), 1234567, &sequencer).unwrap();
        assert!(packets.len() > 1);
        for (i, packet) in packets.iter().enumerate() {
            assert_eq!(packet.header.timestamp, 1234567);
            assert_eq!(packet.header.marker, i + 1 == packets.len());
            assert!(packet.payload.len() <= 1188);
        }
    }
}
