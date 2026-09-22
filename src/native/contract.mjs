/** Pinned *observed* Window2 method order, not a claim about every Codex build.
 * Source: RS-Nocsi/codex-cua-mcp fc5b46f, src/server.ts and src/types.ts.
 * Method shapes are independently implemented; no Windows binary is shipped.
 */
export const WINDOW2_METHODS = Object.freeze([
  'list_windows',
  'list_apps',
  'get_window',
  'launch_app',
  'activate_window',
  'get_window_state',
  'click',
  'type_text',
  'press_key',
  'scroll',
  'drag',
  'set_value',
  'perform_secondary_action',
]);
export const NATIVE_TARGET_METHODS = Object.freeze([
  'getAXState',
  'getScreenshot',
  'getAXStateAndScreenshot',
  'click',
  'drag',
  'pressKey',
  'scroll',
  'setValue',
  'typeText',
  'performSecondaryAction',
]);
export function appStateText(state, observation, name) {
  const window = state.window;
  const ax = state.accessibility;
  const lines = [
    `App=${window.app} (pid ${observation?.pid ?? 'unknown'})`,
    `Window: ${JSON.stringify(window.title ?? '')}, App: ${name}.`,
    ax?.tree ?? 'Accessibility tree unavailable; use screenshot coordinates.',
  ];
  if (ax?.focused_element) lines.push(`The focused UI element is ${ax.focused_element}.`);
  if (ax?.selected_text) lines.push(`Selected text: [${ax.selected_text}]`);
  return lines.filter(Boolean).join('\n');
}
