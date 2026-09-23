use mcpbrowser_native_cua::live::input::{InputController, RemoteInput};
use std::{thread, time::Duration};

fn key(input: &InputController, code: &str) {
    input.send_from(
        1,
        RemoteInput::Key {
            code: code.into(),
            down: true,
        },
    );
    input.send_from(
        1,
        RemoteInput::Key {
            code: code.into(),
            down: false,
        },
    );
}

fn main() {
    let input = InputController::start();
    thread::sleep(Duration::from_millis(250));
    input.send_from(1, RemoteInput::Move { x: 960.0, y: 540.0 });
    input.send_from(
        1,
        RemoteInput::Button {
            button: 0,
            down: true,
        },
    );
    input.send_from(
        1,
        RemoteInput::Button {
            button: 0,
            down: false,
        },
    );
    key(&input, "KeyO");
    key(&input, "KeyK");
    key(&input, "Enter");
    thread::sleep(Duration::from_millis(500));
    input.release_peer(1);
    thread::sleep(Duration::from_millis(100));
}
