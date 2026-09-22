use anyhow::{Context, Result, bail};
use mcpbrowser_media_session::Session;
use serde::Deserialize;
use std::{
    collections::HashSet,
    os::unix::net::UnixStream,
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender, TrySendError},
    },
    time::{Duration, Instant},
};
use wayland_client::{
    Connection, Dispatch, QueueHandle, delegate_noop,
    globals::{GlobalListContents, registry_queue_init},
    protocol::wl_registry,
};

use crate::read_desktop_info;

mod fake_input {
    use wayland_client;
    pub mod __interfaces {
        wayland_scanner::generate_interfaces!("protocols/fake-input.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("protocols/fake-input.xml");
}

use fake_input::org_kde_kwin_fake_input::OrgKdeKwinFakeInput;

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t")]
pub enum RemoteInput {
    #[serde(rename = "m")]
    Move { x: f64, y: f64 },
    #[serde(rename = "mr")]
    MoveRelative { dx: f64, dy: f64 },
    #[serde(rename = "b")]
    Button { button: u8, down: bool },
    #[serde(rename = "w")]
    Wheel { dx: f64, dy: f64 },
    #[serde(rename = "k")]
    Key { code: String, down: bool },
    #[serde(rename = "reset")]
    Reset,
    #[serde(rename = "snapshot")]
    Snapshot,
}

#[derive(Clone)]
pub struct InputController {
    tx: SyncSender<QueuedInput>,
    overflowed: Arc<AtomicBool>,
}

#[derive(Debug)]
enum InputCommand {
    Event(RemoteInput),
    ReleasePeer,
}

struct QueuedInput {
    peer_id: u64,
    command: InputCommand,
    enqueued_at: Instant,
    session: Option<Session>,
}

impl InputController {
    pub fn start() -> Self {
        let (tx, rx) = mpsc::sync_channel::<QueuedInput>(512);
        let overflowed = Arc::new(AtomicBool::new(false));
        let reset_after_overflow = Arc::clone(&overflowed);
        std::thread::Builder::new()
            .name("native-live-input".into())
            .spawn(move || {
                let mut device: Option<LiveInputDevice> = None;
                let mut owner_peer_id: Option<u64> = None;
                let mut report_started = Instant::now();
                let mut samples = 0u64;
                let mut queue_total_us = 0u128;
                let mut queue_max_us = 0u128;
                let mut total_total_us = 0u128;
                let mut total_max_us = 0u128;
                while let Ok(queued) = rx.recv() {
                    if queued.session.as_ref().is_some_and(Session::is_closed) { continue; }
                    if reset_after_overflow.swap(false, Ordering::AcqRel) {
                        for _ in 0..512 { if rx.try_recv().is_err() { break; } }
                        if let Some(device) = device.as_mut() { let _ = device.release_all(); }
                        owner_peer_id = None;
                        tracing::warn!("native input backlog discarded and pressed state reset");
                        continue;
                    }
                    if matches!(&queued.command, InputCommand::ReleasePeer) {
                        if owner_peer_id == Some(queued.peer_id) {
                            if let Some(device) = device.as_mut() {
                                let _ = device.release_all();
                            }
                            owner_peer_id = None;
                            tracing::info!(peer_id = queued.peer_id, "native live input ownership released");
                        }
                        continue;
                    }

                    let queue_us = queued.enqueued_at.elapsed().as_micros();
                    queue_total_us += queue_us;
                    queue_max_us = queue_max_us.max(queue_us);
                    let started = queued.enqueued_at;
                    let event = match queued.command {
                        InputCommand::Event(event) => event,
                        InputCommand::ReleasePeer => unreachable!(),
                    };

                    if matches!(&event, RemoteInput::Reset) {
                        if owner_peer_id == Some(queued.peer_id) {
                            if let Some(device) = device.as_mut() {
                                let _ = device.release_all();
                            }
                            owner_peer_id = None;
                            tracing::info!(peer_id = queued.peer_id, "native live input ownership reset");
                        }
                        continue;
                    }

                    if owner_peer_id != Some(queued.peer_id) {
                        if let Some(device) = device.as_mut() {
                            let _ = device.release_all();
                        }
                        let previous_peer_id = owner_peer_id.unwrap_or(0);
                        owner_peer_id = Some(queued.peer_id);
                        tracing::info!(
                            previous_peer_id,
                            peer_id = queued.peer_id,
                            "native live input ownership transferred"
                        );
                    }
                    let mut retry = Some(event);
                    for _ in 0..2 {
                        let event = match retry.take() {
                            Some(event) => event,
                            None => break,
                        };
                        if device.is_none() {
                            match LiveInputDevice::connect() {
                                Ok(next) => device = Some(next),
                                Err(error) => {
                                    tracing::warn!(%error, "native live input could not connect to Wayland");
                                    break;
                                }
                            }
                        }
                        match device.as_mut().unwrap().apply(&event) {
                            Ok(()) => break,
                            Err(error) => {
                                tracing::warn!(%error, "native live input connection lost; reconnecting");
                                device = None;
                                retry = Some(event);
                            }
                        }
                    }
                    let total_us = started.elapsed().as_micros();
                    total_total_us += total_us;
                    total_max_us = total_max_us.max(total_us);
                    samples += 1;
                    if report_started.elapsed() >= Duration::from_secs(1) {
                        tracing::info!(
                            samples,
                            queue_avg_us = if samples > 0 { queue_total_us / samples as u128 } else { 0 },
                            queue_max_us,
                            enqueue_to_flush_avg_us = if samples > 0 { total_total_us / samples as u128 } else { 0 },
                            enqueue_to_flush_max_us = total_max_us,
                            "native live input latency"
                        );
                        report_started = Instant::now();
                        samples = 0;
                        queue_total_us = 0;
                        queue_max_us = 0;
                        total_total_us = 0;
                        total_max_us = 0;
                    }
                }
                if let Some(mut device) = device {
                    let _ = device.release_all();
                }
            })
            .expect("spawn native live input thread");
        Self { tx, overflowed }
    }

    pub fn send_from(&self, peer_id: u64, event: RemoteInput) {
        self.send_from_impl(peer_id, event, None);
    }

    pub fn send_from_session(&self, peer_id: u64, event: RemoteInput, session: &Session) {
        if !session.is_closed() {
            self.send_from_impl(peer_id, event, Some(session.clone()));
        }
    }

    fn send_from_impl(&self, peer_id: u64, event: RemoteInput, session: Option<Session>) {
        if matches!(event, RemoteInput::Snapshot) {
            return;
        }
        if matches!(&event, RemoteInput::Key { code, .. } if code.len() > 128) {
            return;
        }
        self.enqueue(QueuedInput {
            peer_id,
            command: InputCommand::Event(event),
            enqueued_at: Instant::now(),
            session,
        });
    }

    pub fn release_peer(&self, peer_id: u64) {
        self.enqueue(QueuedInput {
            peer_id,
            command: InputCommand::ReleasePeer,
            enqueued_at: Instant::now(),
            session: None,
        });
    }

    fn enqueue(&self, input: QueuedInput) {
        if matches!(self.tx.try_send(input), Err(TrySendError::Full(_))) {
            // Dropping a key-up alone would stick the key. Saturation instead
            // resets all pending input and the physical seat on the consumer.
            self.overflowed.store(true, Ordering::Release);
            // If the consumer drained the queue between try_send and the flag
            // store, wake it so the reset cannot wait for another user event.
            let _ = self.tx.try_send(QueuedInput {
                peer_id: 0,
                command: InputCommand::ReleasePeer,
                enqueued_at: Instant::now(),
                session: None,
            });
        }
    }
}

#[derive(Default)]
struct State;

impl Dispatch<wl_registry::WlRegistry, GlobalListContents> for State {
    fn event(
        _: &mut Self,
        _: &wl_registry::WlRegistry,
        _: wl_registry::Event,
        _: &GlobalListContents,
        _: &Connection,
        _: &QueueHandle<Self>,
    ) {
    }
}

delegate_noop!(State: ignore OrgKdeKwinFakeInput);

struct LiveInputDevice {
    queue: wayland_client::EventQueue<State>,
    input: OrgKdeKwinFakeInput,
    width: u32,
    height: u32,
    pressed_keys: HashSet<u32>,
    pressed_buttons: HashSet<u32>,
}

impl LiveInputDevice {
    fn connect() -> Result<Self> {
        let desktop = read_desktop_info()?;
        let runtime = desktop
            .env
            .get("XDG_RUNTIME_DIR")
            .context("desktop has no XDG_RUNTIME_DIR")?;
        let display = desktop
            .env
            .get("WAYLAND_DISPLAY")
            .context("desktop has no WAYLAND_DISPLAY")?;
        let socket = if display.starts_with('/') {
            PathBuf::from(display)
        } else {
            PathBuf::from(runtime).join(display)
        };
        let stream = UnixStream::connect(&socket)
            .with_context(|| format!("connect Wayland socket {}", socket.display()))?;
        let conn = Connection::from_socket(stream).context("create Wayland connection")?;
        let (globals, mut queue) = registry_queue_init::<State>(&conn)?;
        let qh = queue.handle();
        let input: OrgKdeKwinFakeInput = globals
            .bind(&qh, 4..=6, ())
            .context("KWin fake-input protocol unavailable")?;
        input.authenticate(
            "MCPBrowser Native Live".into(),
            "remote desktop input for the private Native compositor".into(),
        );
        let mut state = State;
        queue.roundtrip(&mut state)?;

        Ok(Self {
            queue,
            input,
            width: desktop.width,
            height: desktop.height,
            pressed_keys: HashSet::new(),
            pressed_buttons: HashSet::new(),
        })
    }

    fn apply(&mut self, event: &RemoteInput) -> Result<()> {
        match event {
            RemoteInput::Move { x, y } => {
                let x = x.clamp(0.0, (self.width.saturating_sub(1)) as f64);
                let y = y.clamp(0.0, (self.height.saturating_sub(1)) as f64);
                self.input.pointer_motion_absolute(x, y);
            }
            RemoteInput::MoveRelative { dx, dy } => {
                let dx = dx.clamp(-4096.0, 4096.0);
                let dy = dy.clamp(-4096.0, 4096.0);
                self.input.pointer_motion(dx, dy);
            }
            RemoteInput::Button { button, down } => {
                let code = mouse_button(*button)?;
                if *down {
                    if self.pressed_buttons.insert(code) {
                        self.input.button(code, 1);
                    }
                } else if self.pressed_buttons.remove(&code) {
                    self.input.button(code, 0);
                }
            }
            RemoteInput::Wheel { dx, dy } => {
                if *dy != 0.0 {
                    self.input.axis(0, dy.clamp(-1000.0, 1000.0));
                }
                if *dx != 0.0 {
                    self.input.axis(1, dx.clamp(-1000.0, 1000.0));
                }
            }
            RemoteInput::Key { code, down } => {
                let key = browser_code_to_evdev(code)
                    .with_context(|| format!("unsupported browser key code {code}"))?;
                if *down {
                    if self.pressed_keys.insert(key) {
                        self.input.keyboard_key(key, 1);
                    }
                } else if self.pressed_keys.remove(&key) {
                    self.input.keyboard_key(key, 0);
                }
            }
            RemoteInput::Reset => self.release_all()?,
            RemoteInput::Snapshot => {}
        }
        // Input requests are one-way. Waiting for a Wayland sync roundtrip on
        // every pointer/key event serializes the input path behind the
        // compositor and can build a visible queue at 120 Hz. Flush the
        // requests immediately instead; fake-input is a one-way protocol.
        self.queue.flush()?;
        Ok(())
    }

    fn release_all(&mut self) -> Result<()> {
        let keys = self.pressed_keys.drain().collect::<Vec<_>>();
        for key in keys {
            self.input.keyboard_key(key, 0);
        }
        let buttons = self.pressed_buttons.drain().collect::<Vec<_>>();
        for button in buttons {
            self.input.button(button, 0);
        }
        self.queue.flush()?;
        Ok(())
    }
}

impl Drop for LiveInputDevice {
    fn drop(&mut self) {
        let _ = self.release_all();
        self.input.destroy();
        let _ = self.queue.flush();
    }
}

fn mouse_button(button: u8) -> Result<u32> {
    match button {
        0 => Ok(0x110), // BTN_LEFT
        1 => Ok(0x112), // BTN_MIDDLE
        2 => Ok(0x111), // BTN_RIGHT
        3 => Ok(0x113), // BTN_SIDE
        4 => Ok(0x114), // BTN_EXTRA
        _ => bail!("unsupported mouse button {button}"),
    }
}

pub fn browser_code_to_evdev(code: &str) -> Option<u32> {
    Some(match code {
        "Escape" => 1,
        "Digit1" => 2,
        "Digit2" => 3,
        "Digit3" => 4,
        "Digit4" => 5,
        "Digit5" => 6,
        "Digit6" => 7,
        "Digit7" => 8,
        "Digit8" => 9,
        "Digit9" => 10,
        "Digit0" => 11,
        "Minus" => 12,
        "Equal" => 13,
        "Backspace" => 14,
        "Tab" => 15,
        "KeyQ" => 16,
        "KeyW" => 17,
        "KeyE" => 18,
        "KeyR" => 19,
        "KeyT" => 20,
        "KeyY" => 21,
        "KeyU" => 22,
        "KeyI" => 23,
        "KeyO" => 24,
        "KeyP" => 25,
        "BracketLeft" => 26,
        "BracketRight" => 27,
        "Enter" => 28,
        "ControlLeft" => 29,
        "KeyA" => 30,
        "KeyS" => 31,
        "KeyD" => 32,
        "KeyF" => 33,
        "KeyG" => 34,
        "KeyH" => 35,
        "KeyJ" => 36,
        "KeyK" => 37,
        "KeyL" => 38,
        "Semicolon" => 39,
        "Quote" => 40,
        "Backquote" => 41,
        "ShiftLeft" => 42,
        "Backslash" => 43,
        "KeyZ" => 44,
        "KeyX" => 45,
        "KeyC" => 46,
        "KeyV" => 47,
        "KeyB" => 48,
        "KeyN" => 49,
        "KeyM" => 50,
        "Comma" => 51,
        "Period" => 52,
        "Slash" => 53,
        "ShiftRight" => 54,
        "NumpadMultiply" => 55,
        "AltLeft" => 56,
        "Space" => 57,
        "CapsLock" => 58,
        "F1" => 59,
        "F2" => 60,
        "F3" => 61,
        "F4" => 62,
        "F5" => 63,
        "F6" => 64,
        "F7" => 65,
        "F8" => 66,
        "F9" => 67,
        "F10" => 68,
        "NumLock" => 69,
        "ScrollLock" => 70,
        "Numpad7" => 71,
        "Numpad8" => 72,
        "Numpad9" => 73,
        "NumpadSubtract" => 74,
        "Numpad4" => 75,
        "Numpad5" => 76,
        "Numpad6" => 77,
        "NumpadAdd" => 78,
        "Numpad1" => 79,
        "Numpad2" => 80,
        "Numpad3" => 81,
        "Numpad0" => 82,
        "NumpadDecimal" => 83,
        "IntlBackslash" => 86,
        "F11" => 87,
        "F12" => 88,
        "NumpadEnter" => 96,
        "ControlRight" => 97,
        "NumpadDivide" => 98,
        "PrintScreen" => 99,
        "AltRight" => 100,
        "Home" => 102,
        "ArrowUp" => 103,
        "PageUp" => 104,
        "ArrowLeft" => 105,
        "ArrowRight" => 106,
        "End" => 107,
        "ArrowDown" => 108,
        "PageDown" => 109,
        "Insert" => 110,
        "Delete" => 111,
        "AudioVolumeMute" => 113,
        "AudioVolumeDown" => 114,
        "AudioVolumeUp" => 115,
        "Pause" => 119,
        "MetaLeft" => 125,
        "MetaRight" => 126,
        "ContextMenu" => 127,
        "BrowserStop" => 128,
        "Again" => 129,
        "Props" => 130,
        "Undo" => 131,
        "Copy" => 133,
        "Open" => 134,
        "Paste" => 135,
        "Find" => 136,
        "Cut" => 137,
        "Help" => 138,
        "F13" => 183,
        "F14" => 184,
        "F15" => 185,
        "F16" => 186,
        "F17" => 187,
        "F18" => 188,
        "F19" => 189,
        "F20" => 190,
        "F21" => 191,
        "F22" => 192,
        "F23" => 193,
        "F24" => 194,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn saturated_input_requests_a_seat_reset_instead_of_silently_losing_key_up() {
        let (tx, rx) = mpsc::sync_channel(1);
        let overflowed = Arc::new(AtomicBool::new(false));
        let controller = InputController {
            tx,
            overflowed: Arc::clone(&overflowed),
        };
        controller.send_from(
            1,
            RemoteInput::Key {
                code: "ShiftLeft".into(),
                down: true,
            },
        );
        controller.send_from(
            1,
            RemoteInput::Key {
                code: "ShiftLeft".into(),
                down: false,
            },
        );
        assert!(overflowed.load(Ordering::Acquire));
        assert!(rx.try_recv().is_ok());
        assert!(rx.try_recv().is_err());
    }

    #[test]
    fn maps_game_and_modifier_keys() {
        assert_eq!(browser_code_to_evdev("KeyW"), Some(17));
        assert_eq!(browser_code_to_evdev("Space"), Some(57));
        assert_eq!(browser_code_to_evdev("ShiftLeft"), Some(42));
        assert_eq!(browser_code_to_evdev("ControlRight"), Some(97));
        assert_eq!(browser_code_to_evdev("ArrowUp"), Some(103));
    }
}

#[cfg(test)]
mod peer_epoch_tests {
    use super::*;
    #[test]
    fn queued_input_from_closed_peer_is_not_live() {
        let session = Session::new();
        let queued = QueuedInput {
            peer_id: 7,
            command: InputCommand::Event(RemoteInput::Reset),
            enqueued_at: Instant::now(),
            session: Some(session.clone()),
        };
        session.close();
        assert!(queued.session.as_ref().is_some_and(Session::is_closed));
    }
}
