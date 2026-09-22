import { spawn } from 'node:child_process';
const CURSOR_SIZE = 64;
// neon_cursor_smooth.svg is scaled to 80% around (104,104) in its 512x512
// viewBox specifically so the original 13px/64px click hotspot is preserved.
// Keep screenshot compositing identical to the mcpmonitor live overlay.
const HOTSPOT_X = 13;
const HOTSPOT_Y = 13;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/**
 * Composite the MCP/agent pointer into an already-captured PNG.
 *
 * This happens after Google Chrome has produced the screenshot bytes, so the
 * pointer never leaks into the real page DOM or encoded display capture. The
 * human Live viewer renders the same agentPointer state as a local SVG overlay.
 */
export async function compositeAgentCursorPng(
  bytes,
  pointer,
  { logger, cursorPath, executable } = {},
) {
  if (!pointer?.visible) return Buffer.from(bytes);
  if (!cursorPath || !executable) return Buffer.from(bytes);
  const x = Math.max(0, Math.round(Number(pointer.x) || 0) - HOTSPOT_X);
  const y = Math.max(0, Math.round(Number(pointer.y) || 0) - HOTSPOT_Y);

  return await new Promise((resolve) => {
    const child = spawn(
      executable,
      [
        'png:-',
        '(',
        '-background',
        'none',
        cursorPath,
        '-resize',
        `${CURSOR_SIZE}x${CURSOR_SIZE}`,
        ')',
        '-geometry',
        `+${x}+${y}`,
        '-composite',
        'png:-',
      ],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

    const stdout = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      logger?.warn?.('agent cursor compositor timed out; returning the original screenshot');
      finish(Buffer.from(bytes));
    }, 2500);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        clearTimeout(timer);
        logger?.warn?.(
          'agent cursor compositor exceeded output limit; returning the original screenshot',
        );
        finish(Buffer.from(bytes));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8');
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      logger?.warn?.(`agent cursor compositor unavailable: ${error.message}`);
      finish(Buffer.from(bytes));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (settled) return;
      if (code !== 0 || !stdout.length) {
        logger?.warn?.(
          `agent cursor compositor failed${stderr ? `: ${stderr.trim()}` : ` (exit ${code})`}`,
        );
        finish(Buffer.from(bytes));
        return;
      }
      finish(Buffer.concat(stdout));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(bytes);
  });
}
