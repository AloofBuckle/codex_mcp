/** Create one real top-level window in the already-running Native Chrome. */
import WebSocket from 'ws';

const [portText, widthText, heightText] = process.argv.slice(2);
const port = Number(portText),
  width = Number(widthText),
  height = Number(heightText);
if (
  !Number.isInteger(port) ||
  port < 1 ||
  port > 65535 ||
  !Number.isInteger(width) ||
  width < 200 ||
  !Number.isInteger(height) ||
  height < 200
) {
  throw new Error('usage: native-browser-window.mjs <cdp-port> <width> <height>');
}

const version = await fetch(`http://127.0.0.1:${port}/json/version`).then(async (response) => {
  if (!response.ok) throw new Error(`CDP version endpoint returned HTTP ${response.status}`);
  return response.json();
});
if (!version.webSocketDebuggerUrl) throw new Error('CDP browser WebSocket URL is missing');

const socket = new WebSocket(version.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.once('open', resolve);
  socket.once('error', reject);
});

const id = 1;
const created = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error('Target.createTarget timed out')), 4000);
  socket.on('message', (data) => {
    const message = JSON.parse(String(data));
    if (message.id !== id) return;
    clearTimeout(timer);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  });
  socket.send(
    JSON.stringify({
      id,
      method: 'Target.createTarget',
      params: {
        url: 'chrome://new-tab-page/',
        newWindow: true,
        background: false,
        width,
        height,
      },
    }),
  );
});
if (!created?.targetId) throw new Error('Chrome did not return a targetId for the new window');

// This connection only creates the window. Closing the raw CDP socket must not
// send Browser.close or dispose any browser context/window.
socket.close();
await new Promise((resolve) => socket.once('close', resolve));
