use mcpbrowser_native_cua::live::input::{InputController, RemoteInput};
use std::{thread, time::Duration};

fn main() {
    let input = InputController::start();
    thread::sleep(Duration::from_millis(250));
    for i in 0..960u32 {
        let phase = i % 480;
        let x = if phase < 240 {
            200 + phase * 6
        } else {
            1640 - (phase - 240) * 6
        };
        let y = 540.0 + ((i as f64) / 18.0).sin() * 180.0;
        input.send_from(1, RemoteInput::Move { x: x as f64, y });
        thread::sleep(Duration::from_micros(8_333));
    }
    input.release_peer(1);
    thread::sleep(Duration::from_millis(100));
}
