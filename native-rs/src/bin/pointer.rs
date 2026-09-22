use anyhow::{Context, Result, bail};
use mcpbrowser_native_cua::settings::tool;
use std::process::Command;
use std::time::Duration;
use wayland_client::{
    Connection, Dispatch, QueueHandle, delegate_noop,
    globals::{GlobalListContents, registry_queue_init},
    protocol::wl_registry,
};
use xkbcommon::xkb;

mod fake_input {
    // The generated client resolves the crate through super::wayland_client.
    use wayland_client;
    pub mod __interfaces {
        wayland_scanner::generate_interfaces!("protocols/fake-input.xml");
    }
    use self::__interfaces::*;
    wayland_scanner::generate_client_code!("protocols/fake-input.xml");
}
use fake_input::org_kde_kwin_fake_input::OrgKdeKwinFakeInput;

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

struct Device {
    queue: wayland_client::EventQueue<State>,
    state: State,
    input: OrgKdeKwinFakeInput,
}

impl Device {
    fn connect() -> Result<Self> {
        let conn = Connection::connect_to_env().context("Wayland connect")?;
        let (globals, mut queue) = registry_queue_init::<State>(&conn)?;
        let qh = queue.handle();
        let input: OrgKdeKwinFakeInput = globals
            .bind(&qh, 6..=6, ())
            .context("KWin fake-input protocol unavailable")?;
        input.authenticate(
            "MCPBrowser Native Worker".into(),
            "private remote desktop input".into(),
        );
        let mut state = State;
        queue.roundtrip(&mut state)?;
        Ok(Self {
            queue,
            state,
            input,
        })
    }

    fn flush(&mut self) -> Result<()> {
        self.queue.flush()?;
        self.queue.roundtrip(&mut self.state)?;
        Ok(())
    }

    fn move_abs(&mut self, x: f64, y: f64) -> Result<()> {
        self.input.pointer_motion_absolute(x, y);
        self.flush()
    }

    fn click(&mut self, button: u32, count: u32) -> Result<()> {
        let code = match button {
            1 => 0x110,
            2 => 0x111,
            3 => 0x112,
            _ => bail!("invalid button"),
        };
        for _ in 0..count {
            self.input.button(code, 1);
            self.flush()?;
            std::thread::sleep(Duration::from_millis(35));
            self.input.button(code, 0);
            self.flush()?;
            std::thread::sleep(Duration::from_millis(45));
        }
        Ok(())
    }

    fn scroll(&mut self, dx: f64, dy: f64) -> Result<()> {
        if dy != 0.0 {
            self.input.axis(0, dy.clamp(-1000.0, 1000.0));
        }
        if dx != 0.0 {
            self.input.axis(1, dx.clamp(-1000.0, 1000.0));
        }
        self.flush()
    }

    fn keycode(&mut self, code: u32, down: bool) -> Result<()> {
        self.input.keyboard_key(code, u32::from(down));
        self.flush()
    }
}

impl Drop for Device {
    fn drop(&mut self) {
        self.input.destroy();
        let _ = self.queue.flush();
    }
}

fn parse_num(value: &str, name: &str) -> Result<f64> {
    let number: f64 = value.parse().with_context(|| format!("invalid {name}"))?;
    if !number.is_finite() {
        bail!("invalid {name}");
    }
    Ok(number)
}

fn parse_pointer_geometry(argv: &[String]) -> Result<(f64, f64, u32, u32)> {
    if argv.len() < 6 {
        bail!("pointer mode requires X Y WIDTH HEIGHT");
    }
    let x = parse_num(&argv[2], "x")?;
    let y = parse_num(&argv[3], "y")?;
    let width = parse_num(&argv[4], "width")? as u32;
    let height = parse_num(&argv[5], "height")? as u32;
    if width == 0
        || height == 0
        || width > 16384
        || height > 16384
        || x < 0.0
        || x >= width as f64
        || y < 0.0
        || y >= height as f64
    {
        bail!("invalid pointer geometry");
    }
    Ok((x, y, width, height))
}

fn named_keysym(name: &str) -> Result<u32> {
    let aliases = [
        ("enter", "Return"),
        ("return", "Return"),
        ("escape", "Escape"),
        ("esc", "Escape"),
        ("backspace", "BackSpace"),
        ("delete", "Delete"),
        ("tab", "Tab"),
        ("space", "space"),
        ("up", "Up"),
        ("down", "Down"),
        ("left", "Left"),
        ("right", "Right"),
        ("home", "Home"),
        ("end", "End"),
        ("pageup", "Page_Up"),
        ("pagedown", "Page_Down"),
    ];
    let lower = name.to_ascii_lowercase();
    let resolved = aliases
        .iter()
        .find_map(|(alias, value)| (*alias == lower).then_some(*value))
        .unwrap_or(name);
    let sym = xkb::keysym_from_name(resolved, xkb::KEYSYM_CASE_INSENSITIVE);
    if sym.raw() == 0 {
        bail!("unknown keysym {name}");
    }
    Ok(sym.raw())
}

fn evdev_for_keysym(sym: u32) -> Result<(u32, bool)> {
    const EVDEV_OFFSET: u32 = 8;
    let context = xkb::Context::new(xkb::CONTEXT_NO_FLAGS);
    let keymap = xkb::Keymap::new_from_names(&context, "", "", "", "", None, xkb::COMPILE_NO_FLAGS)
        .context("compile default XKB keymap")?;
    let mut found = None;
    keymap.key_for_each(|map, key| {
        if found.is_some() {
            return;
        }
        let levels = map.num_levels_for_key(key, 0);
        for level in 0..levels {
            if map
                .key_get_syms_by_level(key, 0, level)
                .iter()
                .any(|candidate| candidate.raw() == sym)
            {
                let raw = key.raw();
                if raw >= EVDEV_OFFSET {
                    found = Some((raw - EVDEV_OFFSET, level > 0));
                }
                break;
            }
        }
    });
    found.context("keysym is not present in the default keymap")
}

fn send_chord(device: &mut Device, chord: &str) -> Result<()> {
    let parts: Vec<_> = chord.split('+').filter(|part| !part.is_empty()).collect();
    if parts.is_empty() {
        bail!("invalid key chord");
    }
    let mut held: Vec<u32> = Vec::new();
    for part in &parts[..parts.len() - 1] {
        let code = match part.to_ascii_lowercase().as_str() {
            "ctrl" | "control" => 29,
            "alt" => 56,
            "shift" => 42,
            "super" | "meta" | "win" | "cmd" | "command" => 125,
            _ => bail!("unknown key modifier {part}"),
        };
        if !held.contains(&code) {
            device.keycode(code, true)?;
            held.push(code);
        }
    }
    let target = named_keysym(parts[parts.len() - 1])?;
    let (target_code, needs_shift) = evdev_for_keysym(target)?;
    let implicit_shift = needs_shift && !held.contains(&42);
    if implicit_shift {
        device.keycode(42, true)?;
    }
    device.keycode(target_code, true)?;
    std::thread::sleep(Duration::from_millis(35));
    device.keycode(target_code, false)?;
    if implicit_shift {
        device.keycode(42, false)?;
    }
    for code in held.into_iter().rev() {
        device.keycode(code, false)?;
    }
    Ok(())
}

fn send_text(device: &mut Device, text: &str) -> Result<()> {
    let qdbus = tool("qdbus");
    let get = Command::new(&qdbus)
        .args([
            "org.kde.klipper",
            "/klipper",
            "org.kde.klipper.klipper.getClipboardContents",
        ])
        .output()
        .context("read Klipper clipboard")?;
    if !get.status.success() {
        bail!("Klipper clipboard is unavailable");
    }
    let previous = String::from_utf8_lossy(&get.stdout)
        .trim_end_matches('\n')
        .to_string();
    let set = |value: &str| -> Result<()> {
        let status = Command::new(&qdbus)
            .args([
                "org.kde.klipper",
                "/klipper",
                "org.kde.klipper.klipper.setClipboardContents",
                value,
            ])
            .status()
            .context("set Klipper clipboard")?;
        if !status.success() {
            bail!("Klipper rejected clipboard contents");
        }
        Ok(())
    };
    set(text)?;
    // Shift+Insert is the common Wayland/Linux paste gesture across terminal,
    // Qt/GTK and Chromium text controls, unlike Ctrl+V which terminals treat
    // as a literal-next control character.
    send_chord(device, "Shift+Insert")?;
    std::thread::sleep(Duration::from_millis(80));
    let _ = set(&previous);
    Ok(())
}

fn run() -> Result<()> {
    let argv: Vec<String> = std::env::args().collect();
    if argv.len() < 2 {
        bail!("usage: pointer MODE ...");
    }
    let mode = argv[1].as_str();
    let mut device = Device::connect()?;
    match mode {
        "raw" => {
            if argv.len() != 3 {
                bail!("raw requires an evdev keycode");
            }
            let code: u32 = argv[2].parse().context("invalid evdev keycode")?;
            device.input.keyboard_key(code, 1);
            device.flush()?;
            std::thread::sleep(Duration::from_millis(35));
            device.input.keyboard_key(code, 0);
            device.flush()?;
        }
        "key" => {
            if argv.len() != 3 {
                bail!("key requires chord");
            }
            send_chord(&mut device, &argv[2])?;
        }
        "text" => {
            if argv.len() != 3 {
                bail!("text requires one argument");
            }
            send_text(&mut device, &argv[2])?;
        }
        "move" | "click" | "scroll" | "drag" => {
            let (x, y, width, height) = parse_pointer_geometry(&argv)?;
            device.move_abs(x, y)?;
            match mode {
                "move" => {}
                "click" => {
                    if argv.len() != 8 {
                        bail!("click requires button and count");
                    }
                    let button = parse_num(&argv[6], "button")? as u32;
                    let count = parse_num(&argv[7], "count")? as u32;
                    if !(1..=3).contains(&count) {
                        bail!("invalid click count");
                    }
                    device.click(button, count)?;
                }
                "scroll" => {
                    if argv.len() != 8 {
                        bail!("scroll requires dx dy");
                    }
                    device.scroll(parse_num(&argv[6], "dx")?, parse_num(&argv[7], "dy")?)?;
                }
                "drag" => {
                    if argv.len() != 8 {
                        bail!("drag requires target x y");
                    }
                    let tx = parse_num(&argv[6], "to_x")?;
                    let ty = parse_num(&argv[7], "to_y")?;
                    if tx < 0.0 || tx >= width as f64 || ty < 0.0 || ty >= height as f64 {
                        bail!("drag target out of range");
                    }
                    device.input.button(0x110, 1);
                    device.flush()?;
                    for step in 1..=24 {
                        let f = step as f64 / 24.0;
                        device.move_abs(x + (tx - x) * f, y + (ty - y) * f)?;
                        std::thread::sleep(Duration::from_millis(12));
                    }
                    device.input.button(0x110, 0);
                    device.flush()?;
                }
                _ => unreachable!(),
            }
        }
        _ => bail!("unknown pointer mode"),
    }
    Ok(())
}

fn main() {
    if let Err(error) = run() {
        eprintln!("mcpbrowser-wayland-pointer: {error:#}");
        std::process::exit(64);
    }
}
