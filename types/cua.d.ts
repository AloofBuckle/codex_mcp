/** User-confirmed CUA surface implemented by this project; not an official OpenAI declaration. */
export type Vec2 = [number, number];
export type Direction = 'up' | 'down' | 'left' | 'right' | 'u' | 'd' | 'l' | 'r';
export type MouseButton = 'left' | 'right' | 'middle' | 'l' | 'r' | 'm';
export interface ObservationOptions {
  emit?: boolean;
  includeAgentCursor?: boolean;
}
export interface StateOptions extends ObservationOptions {
  disableDiffing?: boolean;
}
export interface StateAndScreenshot {
  state: string;
  screenshot?: Uint8Array;
}
export interface ClickOptions {
  mouseButton?: MouseButton;
  clickCount?: number;
}
export interface PasteOptions {
  format?: 'text' | 'md' | 'html';
}
export interface SelectTextOptions {
  prefix?: string;
  suffix?: string;
  selectionType?: 'text' | 'cursor_before' | 'cursor_after';
}
export interface BrowserInfo {
  id: string;
  name?: string;
  family?: string;
  type: 'iab' | 'extension' | 'cdp';
  profileName?: string;
  metadata?: Record<string, unknown>;
}
export interface TabInfo {
  id: string;
  providerTabId?: string;
  browserId: string;
  title?: string;
  url?: string;
}
export interface BrowserState extends BrowserInfo {
  tabs: TabInfo[];
}
/** Native interfaces are independently implemented from pinned public CUA observations. */
export interface NativeWindowInfo {
  app: string;
  id: number;
  title?: string;
}
export interface NativeAppInfo {
  id: string;
  displayName?: string;
  isRunning?: boolean;
  windows: NativeWindowInfo[];
}
export interface NativeScreenshot {
  id: string;
  url: string;
  width?: number;
  height?: number;
  originX?: number;
  originY?: number;
  zIndex: number;
}
export interface NativeWindowState {
  window: NativeWindowInfo;
  accessibility: null | {
    tree: string;
    document_text?: string;
    focused_element?: string;
    selected_elements?: string[];
    selected_text?: string;
  };
  screenshots: NativeScreenshot[];
}
export interface State {
  apps: NativeAppInfo[];
  browsers: BrowserState[];
  errors?: string[];
}
export interface NativeTarget {
  documentation(): Promise<string>;
  getAXState(options?: ObservationOptions): Promise<string>;
  getScreenshot(options?: ObservationOptions): Promise<Uint8Array>;
  getAXStateAndScreenshot(options?: ObservationOptions): Promise<StateAndScreenshot>;
  getState(options?: ObservationOptions): Promise<NativeWindowState>;
  click(
    target:
      | number
      | string
      | Vec2
      | {
          element_index?: number | string;
          x?: number;
          y?: number;
          screenshotId?: string;
          click_count?: number;
          mouse_button?: MouseButton;
        },
    options?: ClickOptions & ObservationOptions,
  ): Promise<void>;
  typeText(text: string, options?: ObservationOptions): Promise<void>;
  pressKey(key: string, options?: ObservationOptions): Promise<void>;
  setValue(index: number | string, value: string, options?: ObservationOptions): Promise<void>;
  performSecondaryAction(
    index: number | string,
    action: string,
    options?: ObservationOptions,
  ): Promise<void>;
  scroll(
    target: number | string | Vec2,
    direction: Direction,
    pages?: number,
    options?: ObservationOptions,
  ): Promise<void>;
  drag(
    from: Vec2,
    to: Vec2,
    options?: ObservationOptions & { screenshotId?: string },
  ): Promise<void>;
  activate(): Promise<void>;
  close(): Promise<void>;
}
export interface NativeApp extends NativeTarget {
  readonly id: string;
  readonly name: string;
  windows(): Promise<NativeWindow[]>;
  getWindow(id: number): Promise<NativeWindow>;
  waitForWindow(options?: { timeoutMs?: number }): Promise<NativeWindow>;
}
export interface NativeWindow extends NativeTarget {
  readonly id: number;
  readonly app: string;
  readonly title?: string;
}
export interface NativeComputer {
  list_windows(): Promise<NativeWindowInfo[]>;
  list_apps(): Promise<NativeAppInfo[]>;
  get_window(args: { id: number; app?: string }): Promise<NativeWindowInfo>;
  launch_app(args: { app: string }): Promise<string>;
  activate_window(args: { window: NativeWindowInfo }): Promise<string>;
  get_window_state(args: {
    window: NativeWindowInfo;
    include_text?: boolean;
    include_screenshot?: boolean;
  }): Promise<NativeWindowState>;
  click(args: {
    window: NativeWindowInfo;
    element_index?: number;
    x?: number;
    y?: number;
    click_count?: number;
    mouse_button?: MouseButton;
    screenshotId?: string;
  }): Promise<string>;
  type_text(args: { window: NativeWindowInfo; text: string }): Promise<string>;
  press_key(args: { window: NativeWindowInfo; key: string }): Promise<string>;
  scroll(args: {
    window: NativeWindowInfo;
    x: number;
    y: number;
    scrollX: number;
    scrollY: number;
    screenshotId?: string;
  }): Promise<string>;
  drag(args: {
    window: NativeWindowInfo;
    from_x: number;
    from_y: number;
    to_x: number;
    to_y: number;
    screenshotId?: string;
  }): Promise<string>;
  set_value(args: {
    window: NativeWindowInfo;
    element_index: number;
    value: string;
  }): Promise<string>;
  perform_secondary_action(args: {
    window: NativeWindowInfo;
    element_index: number;
    action: string;
  }): Promise<string>;
  health(): Promise<{
    available: boolean;
    backend: string;
    mode: 'full_access';
    width: number;
    height: number;
    epoch: string;
  }>;
  get_desktop_state(): Promise<{ screenshots: NativeScreenshot[]; windows: NativeWindowInfo[] }>;
  documentation(): Promise<string>;
}
export interface Target {
  getAXState(options?: StateOptions): Promise<string>;
  getScreenshot(options?: ObservationOptions): Promise<Uint8Array>;
  getAXStateAndScreenshot(options?: StateOptions): Promise<StateAndScreenshot>;
  paste(text: string, options?: PasteOptions): Promise<void>;
  click(target: number | Vec2, options?: ClickOptions): Promise<void>;
  drag(from: Vec2, to: Vec2): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(target: number | Vec2, direction: Direction, pages?: number): Promise<void>;
  selectText(index: number, text: string, options?: SelectTextOptions): Promise<void>;
  setValue(index: number, value: string): Promise<void>;
  typeText(text: string): Promise<void>;
  performSecondaryAction(index: number, action: string): Promise<void>;
}
export interface AX {
  get(options?: StateOptions): Promise<unknown>;
  write(options?: StateOptions): Promise<unknown>;
  click(index: number, options?: ClickOptions): Promise<void>;
  drag(from: Vec2, to: Vec2): Promise<void>;
  performSecondaryAction(index: number, action: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  scroll(target: number | Vec2, direction: Direction, pages?: number): Promise<void>;
  selectText(index: number, text: string, options?: SelectTextOptions): Promise<void>;
  setValue(index: number, value: string): Promise<void>;
  typeText(text: string): Promise<void>;
}
export type QueryOptions = { exact?: boolean; name?: string | RegExp; [key: string]: unknown };
export interface FrameLocator {
  locator(selector: string): Locator;
  frameLocator(selector: string): FrameLocator;
  getByRole(role: string, options?: QueryOptions): Locator;
  getByText(text: string | RegExp, options?: QueryOptions): Locator;
  getByLabel(text: string | RegExp, options?: QueryOptions): Locator;
  getByPlaceholder(text: string | RegExp, options?: QueryOptions): Locator;
  getByTestId(id: string | RegExp): Locator;
}
export interface Locator extends Omit<FrameLocator, 'frameLocator'> {
  click(options?: Record<string, unknown>): Promise<void>;
  dblclick(options?: Record<string, unknown>): Promise<void>;
  fill(value: string, options?: Record<string, unknown>): Promise<void>;
  type(text: string, options?: Record<string, unknown>): Promise<void>;
  pressSequentially(text: string, options?: Record<string, unknown>): Promise<void>;
  press(key: string, options?: Record<string, unknown>): Promise<void>;
  setChecked(checked: boolean, options?: Record<string, unknown>): Promise<void>;
  check(options?: Record<string, unknown>): Promise<void>;
  uncheck(options?: Record<string, unknown>): Promise<void>;
  selectOption(value: unknown, options?: Record<string, unknown>): Promise<string[]>;
  waitFor(options?: {
    state?: 'visible' | 'hidden' | 'attached' | 'detached';
    timeout?: number;
  }): Promise<unknown>;
  count(): Promise<number>;
  all(): Promise<Locator[]>;
  textContent(): Promise<string | null>;
  innerText(): Promise<string>;
  allTextContents(): Promise<string[]>;
  getAttribute(name: string): Promise<string | null>;
  isVisible(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  evaluate<R, A = undefined>(
    callback: (element: Element, arg: A) => R,
    arg?: A,
  ): Promise<Awaited<R>>;
  evaluateAll<R, A = undefined>(
    callback: (elements: Element[], arg: A) => R,
    arg?: A,
  ): Promise<Awaited<R>>;
  first(): Locator;
  last(): Locator;
  nth(index: number): Locator;
  and(other: Locator): Locator;
  or(other: Locator): Locator;
  filter(options: {
    has?: Locator;
    hasNot?: Locator;
    hasText?: string | RegExp;
    hasNotText?: string | RegExp;
  }): Locator;
  downloadMedia(
    options?: Record<string, unknown>,
  ): Promise<{ file: string; bytes: number; sha256: string }>;
  /** Documented project extensions, not asserted as official parity. */
  inputValue(): Promise<string>;
  setInputFiles(files: unknown, options?: Record<string, unknown>): Promise<void>;
}
export interface PlaywrightAPI extends FrameLocator {
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  evaluate<R, A = undefined>(callback: (arg: A) => R, arg?: A): Promise<Awaited<R>>;
  waitForURL(url: string | RegExp, options?: Record<string, unknown>): Promise<void>;
  waitForLoadState(
    state?: 'load' | 'domcontentloaded' | 'networkidle',
    options?: { timeout?: number },
  ): Promise<void>;
  waitForTimeout(ms: number): Promise<void>;
  waitForEvent(
    event: 'download' | 'filechooser' | 'dialog' | 'popup',
    options?: { timeout?: number },
  ): Promise<unknown>;
  expectNavigation(
    action: () => Promise<unknown>,
    options?: { timeout?: number },
  ): Promise<{ navigated: boolean; url: string }>;
  elementInfo(selector: string): Promise<unknown>;
  elementScreenshot(selector: string, options?: unknown): Promise<Uint8Array>;
  domSnapshot(): Promise<string>;
}
export interface CapabilityInfo {
  id: string;
  description?: string;
  status?: string;
  note?: string;
}
export interface Capability {
  documentation(): Promise<string>;
}
export interface Visibility extends Capability {
  get(): Promise<boolean>;
  set(visible: boolean): Promise<unknown>;
}
export interface Viewport extends Capability {
  set(size: { width: number; height: number }): Promise<unknown>;
  reset(): Promise<unknown>;
}
export interface PageAssets extends Capability {
  list(options?: { type?: string; includeDataUrls?: boolean }): Promise<unknown[]>;
  bundle(options?: {
    urls?: string[];
    types?: string[];
    directory?: string;
    limit?: number;
    maxBytes?: number;
    maxBundleBytes?: number;
  }): Promise<{
    directory: string;
    files: Array<{ file: string; url: string; bytes: number; sha256: string }>;
    skipped: unknown[];
    totalBytes: number;
  }>;
}
export interface WebMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  untrusted: true;
  mode: string;
  call(args?: Record<string, unknown>): Promise<unknown>;
  execute(args?: Record<string, unknown>): Promise<unknown>;
}
export interface WebMCP extends Capability {
  fetchTools(): Promise<{
    mode: 'native' | 'native-testing' | 'shim' | 'none';
    native: boolean;
    shim: boolean;
    untrusted: true;
    tools: WebMcpTool[];
    unavailableReason?: string;
  }>;
}
export interface CDP extends Capability {
  send(
    method: string,
    params?: Record<string, unknown>,
    options?: Record<string, unknown>,
  ): Promise<any>;
  readEvents(options?: {
    limit?: number;
    method?: string;
    since?: number;
    clear?: boolean;
  }): Promise<unknown>;
}
export interface TabCapabilities {
  list(): Promise<CapabilityInfo[]>;
  get(id: 'pageAssets'): Promise<PageAssets>;
  get(id: 'webmcp'): Promise<WebMCP>;
  get(id: 'cdp'): Promise<CDP>;
}
export type Dialog =
  | { type: 'alert' | 'beforeunload'; message: string; dismiss(): Promise<unknown> }
  | {
      type: 'confirm' | 'prompt';
      message: string;
      defaultValue?: string;
      accept(text?: string): Promise<unknown>;
      dismiss(): Promise<unknown>;
    };
export interface Tab extends Target {
  readonly id: string;
  readonly browserId: string;
  ax: AX;
  playwright: PlaywrightAPI;
  capabilities: TabCapabilities;
  screenshot(options?: ObservationOptions): Promise<Uint8Array>;
  goto(url: string): Promise<void>;
  back(): Promise<void>;
  forward(): Promise<void>;
  reload(): Promise<void>;
  close(): Promise<void>;
  title(): Promise<string>;
  url(): Promise<string>;
  getJsDialog(): Promise<Dialog | null>;
  markDeliverable(): Promise<void>;
  markHandoff(): Promise<void>;
  clipboard: {
    read(): Promise<{ text: string; html: string; markdown: string; updatedAt: string | null }>;
    readText(): Promise<string>;
    write(data: { text?: string; html?: string; markdown?: string }): Promise<unknown>;
    writeText(text: string): Promise<unknown>;
  };
  content: {
    export(options?: {
      format?: 'md' | 'html' | 'both';
      name?: string;
      selector?: string;
    }): Promise<string>;
    exportGsuite(type: 'pdf' | 'md' | 'xlsx' | 'csv' | 'docx' | 'pptx'): Promise<string>;
    exportYouTubeTranscript(options?: {
      language?: string;
    }): Promise<{ file: string; language: string; segments: number }>;
  };
  dev: { logs(options?: Record<string, unknown>): Promise<unknown> };
  cua?: {
    move(x: number, y: number): Promise<void>;
    click(x: number, y: number, options?: Record<string, unknown>): Promise<void>;
    write(text: string): Promise<void>;
    type(text: string): Promise<void>;
    key(key: string): Promise<void>;
    press(key: string): Promise<void>;
    scroll(x: number, y: number, dx?: number, dy?: number): Promise<void>;
    screenshot(): Promise<Uint8Array>;
  };
  dom_cua?: { get_visible_dom(options?: { maxNodes?: number }): Promise<string> };
}
export interface Browser {
  readonly id: string;
  readonly type: 'iab' | 'extension' | 'cdp';
  documentation(): Promise<string>;
  nameSession(name: string): Promise<void>;
  history(options?: {
    keyword?: string;
    from?: number | string;
    to?: number | string;
    limit?: number;
  }): Promise<{ entries: unknown[]; scope: string }>;
  user?: {
    openTabs(
      options?: ObservationOptions,
    ): Promise<Array<TabInfo & { active?: boolean; claimable?: boolean }>>;
    claimTab(tab: TabInfo): Promise<Tab>;
  };
  tabs: {
    new (options?: { url?: string; visible?: boolean; sessionName?: string }): Promise<Tab>;
    selected(): Promise<Tab | undefined>;
    list(options?: ObservationOptions): Promise<TabInfo[]>;
    get(id: string): Promise<Tab>;
    finalize?(options?: {
      keep?: Array<{ tab: Tab; status?: 'handoff' | 'deliverable' | 'keep' }>;
    }): Promise<unknown>;
  };
  capabilities: {
    list(): Promise<CapabilityInfo[]>;
    get(id: 'visibility'): Promise<Visibility>;
    get(id: 'viewport'): Promise<Viewport>;
  };
}
export interface Cua {
  getState(options?: ObservationOptions): Promise<State>;
  listBrowsers(options?: ObservationOptions): Promise<BrowserInfo[]>;
  getBrowser(options?: { id?: string; url?: string }): Promise<Browser>;
  createBrowserTab(
    browserId: string,
    url?: string,
    options?: { visible?: boolean; sessionName?: string },
  ): Promise<Tab>;
  getTab(id: string, options?: { browser?: string }): Promise<Tab>;
  listTabs(options?: ObservationOptions & { browser?: string }): Promise<TabInfo[]>;
  nativeDocumentation(): Promise<unknown>;
  listApps(options?: ObservationOptions): Promise<NativeAppInfo[]>;
  getApp(identifier: string): Promise<NativeApp>;
  launchApp(
    command: string,
    args?: string[],
    options?: { backend?: 'wayland' | 'x11'; cwd?: string; env?: Record<string, string> },
  ): Promise<NativeApp>;
  listWindows(options?: ObservationOptions): Promise<NativeWindowInfo[]>;
  getWindow(input: number | { id: number; app?: string }): Promise<NativeWindow>;
  getComputer(): Promise<NativeComputer>;
}
declare global {
  const cua: Cua;
  const nodeRepl: {
    write(value: unknown): void;
    emitImage(image: Uint8Array, options?: { mimeType?: string }): void;
  };
}
