import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import i18n from "../i18n";
import type { AppConfig } from "../types/config";
import type { DisplaySettings, FontSettings } from "../types/display";
import type {
  BackdropEffect,
  ExtraWindowSettings,
  WindowAppearance,
} from "../types/extraWindow";
import type { Extension } from "../types/extensions";
import { TRANSLATOR_DEFS } from "../types/extensions";
import type { TextThreadSettings, WebSocketSettings } from "../types/config";
import type { ThemeMode } from "../theme";

function makeFont(size: number): FontSettings {
  return {
    family: "",
    size,
    bold: false,
    italic: false,
    underline: false,
    color: "",
    strokeColor: "",
    strokeWidth: 0,
    glowColor: "",
    glowRadius: 0,
  };
}

const DEFAULT_CONFIG: AppConfig = {
  language: "en",
  themeMode: "system",
  hideSystemProcesses: false,
  display: {
    sameForBoth: true,
    hideLabels: false,
    hideProviderLabel: false,
    source: {
      family: "", size: 14, bold: false, italic: false, underline: false, color: "",
      strokeColor: "", strokeWidth: 0, glowColor: "", glowRadius: 0,
    },
    translation: {
      family: "", size: 14, bold: false, italic: false, underline: false, color: "",
      strokeColor: "", strokeWidth: 0, glowColor: "", glowRadius: 0,
    },
  },
  extensions: [
    {
      id: "google",
      kind: "translation",
      nameKey: "extensions.google",
      enabled: false,
      provider: "google",
      sourceLanguage: "ja",
      targetLanguage: "zh-CN",
      settings: {},
    },
    {
      id: "google2",
      kind: "translation",
      nameKey: "extensions.google2",
      enabled: false,
      provider: "google2",
      sourceLanguage: "ja",
      targetLanguage: "zh-CN",
      settings: {},
    },
    {
      id: "deepl",
      kind: "translation",
      nameKey: "extensions.deepl",
      enabled: false,
      provider: "deepl",
      sourceLanguage: "ja",
      targetLanguage: "zh",
      settings: { apiKey: "" },
    },
    {
      id: "openai",
      kind: "translation",
      nameKey: "extensions.openai",
      enabled: false,
      provider: "openai",
      sourceLanguage: "Japanese",
      targetLanguage: "Simplified Chinese",
      settings: { baseUrl: "https://api.openai.com", apiKey: "", model: "gpt-4o-mini" },
    },
    {
      id: "baidu",
      kind: "translation",
      nameKey: "extensions.baidu",
      enabled: false,
      provider: "baidu",
      sourceLanguage: "jp",
      targetLanguage: "zh",
      settings: { appId: "", appKey: "" },
    },
    {
      id: "aliyun",
      kind: "translation",
      nameKey: "extensions.aliyun",
      enabled: false,
      provider: "aliyun",
      sourceLanguage: "ja",
      targetLanguage: "zh",
      settings: { version: "free", authKey: "" },
    },
    {
      id: "bing",
      kind: "translation",
      nameKey: "extensions.bing",
      enabled: false,
      provider: "bing",
      sourceLanguage: "ja",
      targetLanguage: "zh-Hans",
      settings: { apiKey: "" },
    },
    {
      id: "bing2",
      kind: "translation",
      nameKey: "extensions.bing2",
      enabled: false,
      provider: "bing2",
      sourceLanguage: "ja",
      targetLanguage: "zh-Hans",
      settings: { apiKey: "" },
    },
    {
      id: "claude",
      kind: "translation",
      nameKey: "extensions.claude",
      enabled: false,
      provider: "claude",
      sourceLanguage: "Japanese",
      targetLanguage: "Simplified Chinese",
      settings: {
        apiKey: "",
        apiHost: "",
        apiPath: "",
        model: "",
        systemPrompt:
          "You are a professional translator. Translate faithfully and keep original line breaks. If previous-context sentences are provided, use them only for disambiguation and output only the translation of the current paragraphs.",
        temperature: "0.3",
        enableThinking: "false",
      },
    },
    {
      id: "deepseek",
      kind: "translation",
      nameKey: "extensions.deepseek",
      enabled: false,
      provider: "deepseek",
      sourceLanguage: "Japanese",
      targetLanguage: "Simplified Chinese",
      settings: {
        apiKey: "",
        apiHost: "",
        apiPath: "",
        model: "",
        systemPrompt:
          "You are a professional translator. Translate faithfully and keep original line breaks. If previous-context sentences are provided, use them only for disambiguation and output only the translation of the current paragraphs.",
        temperature: "0.3",
        enableThinking: "false",
        reasoningEffort: "high",
      },
    },
    {
      id: "gemini",
      kind: "translation",
      nameKey: "extensions.gemini",
      enabled: false,
      provider: "gemini",
      sourceLanguage: "Japanese",
      targetLanguage: "Simplified Chinese",
      settings: {
        apiKey: "",
        apiHost: "",
        apiPath: "",
        model: "",
        systemPrompt:
          "You are a professional translator. Translate faithfully and keep original line breaks. If previous-context sentences are provided, use them only for disambiguation and output only the translation of the current paragraphs.",
        temperature: "0.3",
        enableThinking: "false",
      },
    },
    {
      id: "lingocloud",
      kind: "translation",
      nameKey: "extensions.lingocloud",
      enabled: false,
      provider: "lingocloud",
      sourceLanguage: "ja",
      targetLanguage: "zh",
      settings: { apiKey: "" },
    },
    {
      id: "tencent",
      kind: "translation",
      nameKey: "extensions.tencent",
      enabled: false,
      provider: "tencent",
      sourceLanguage: "ja",
      targetLanguage: "zh",
      settings: { secretId: "", secretKey: "" },
    },
    {
      id: "tencenttransmart",
      kind: "translation",
      nameKey: "extensions.tencenttransmart",
      enabled: false,
      provider: "tencenttransmart",
      sourceLanguage: "ja",
      targetLanguage: "zh",
      settings: {},
    },
    {
      id: "regex-filter",
      kind: "tool",
      nameKey: "extensions.regexFilter",
      enabled: false,
      tool: "regex-filter",
      settings: { pattern: "" },
    },
    {
      id: "remove-repeated-chars",
      kind: "tool",
      nameKey: "extensions.removeRepeatedChars",
      enabled: false,
      tool: "remove-repeated-chars",
      settings: {},
    },
    {
      id: "copy-clipboard",
      kind: "tool",
      nameKey: "extensions.copyClipboard",
      enabled: false,
      tool: "copy-clipboard",
      settings: {},
    },
  ],
  textThread: {
    filter_repetition: false,
    flush_delay_spacing: 0,
    flush_delay_ms: 500,
    max_buffer: 3000,
    limit_string_length: 0,
  },
  translateTimeoutMs: 10000,
  window: {
    effect: "none",
    effectTint: "",
    effectTintOpacity: 0.75,
    opacity: 1,
    backgroundImage: "",
    backgroundImageOpacity: 0.6,
  },
  extraWindow: {
    sameForBoth: true,
    source: makeFont(18),
    translation: makeFont(18),
    order: "originalFirst",
    showOriginal: true,
    showTranslation: true,
    hideLabels: false,
    autoResizeHeight: true,
    opacity: 1,
    effect: "none",
    effectTint: "",
    effectTintOpacity: 0.75,
    backgroundImage: "",
    backgroundImageOpacity: 0.6,
    alwaysOnTop: true,
    clickThrough: false,
  },
  websocket: {
    serverEnabled: false,
    serverPort: 6677,
    serverIncludeClipboard: false,
    clientEnabled: false,
    clientUrl: "ws://127.0.0.1:6677",
  },
};

interface ConfigContextValue {
  config: AppConfig;
  setLanguage: (language: string) => void;
  setThemeMode: (mode: ThemeMode) => void;
  setHideSystemProcesses: (value: boolean) => void;
  setDisplay: (display: DisplaySettings) => void;
  setExtensions: (extensions: Extension[]) => void;
  setTextThread: (textThread: TextThreadSettings) => void;
  setTranslateTimeout: (value: number) => void;
  setWindowAppearance: (window: WindowAppearance) => void;
  setExtraWindow: (extraWindow: ExtraWindowSettings) => void;
  setWebSocket: (websocket: WebSocketSettings) => void;
}

const ConfigContext = createContext<ConfigContextValue | null>(null);

const STORAGE_KEY = "textractor.config";

const AI_DEFAULT_SYSTEM_PROMPT =
  "You are a professional translator. Translate faithfully and keep original line breaks. If previous-context sentences are provided, use them only for disambiguation and output only the translation of the current paragraphs.";

const AI_PROVIDERS = new Set(["claude", "deepseek", "gemini"]);

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

function isMainWindow(): boolean {
  if (!isTauri()) return true;
  try {
    return getCurrentWindow().label === "main";
  } catch {
    return true;
  }
}

// Aero（Windows Blur）在新系统上需要走原生实现，这里保留其作为合法值。
function sanitizeEffect(effect: string | undefined): BackdropEffect {
  if (effect === "mica" || effect === "acrylic" || effect === "aero") return effect;
  return "none";
}

function mergeConfig(partial: Partial<AppConfig> | null | undefined): AppConfig {
  if (!partial) return DEFAULT_CONFIG;
  // 过滤掉已移除的翻译服务（DeepLX / Yandex），并迁移旧语言码、补 AI 默认值。
  const extensions = (partial.extensions ?? DEFAULT_CONFIG.extensions)
    .filter(
      (ext) =>
        !(ext.kind === "translation" && (ext.provider === "deeplx" || ext.provider === "yandex")),
    )
    .map((ext) => {
      if (ext.kind !== "translation") return ext;
      const def = TRANSLATOR_DEFS.find((d) => d.id === ext.provider);
      if (!def) return ext;
      const inList = (value: string, list: { value: string }[]) =>
        list.some((l) => l.value === value);
      const targetList = def.targetLanguages ?? def.languages;
      let settings = ext.settings ?? {};
      // AI 服务补默认系统提示词 / 温度 / 思考开关（老配置也生效）。
      if (AI_PROVIDERS.has(ext.provider)) {
        if (!settings.systemPrompt) settings = { ...settings, systemPrompt: AI_DEFAULT_SYSTEM_PROMPT };
        if (!settings.temperature) settings = { ...settings, temperature: "0.3" };
        if (settings.enableThinking === undefined) settings = { ...settings, enableThinking: "false" };
      }
      return {
        ...ext,
        settings,
        sourceLanguage: inList(ext.sourceLanguage, def.languages)
          ? ext.sourceLanguage
          : def.defaultSource,
        targetLanguage: inList(ext.targetLanguage, targetList)
          ? ext.targetLanguage
          : def.defaultTarget,
      };
    });
  return {
    language: partial.language ?? DEFAULT_CONFIG.language,
    themeMode: partial.themeMode ?? DEFAULT_CONFIG.themeMode,
    hideSystemProcesses: partial.hideSystemProcesses ?? DEFAULT_CONFIG.hideSystemProcesses,
    display: {
      sameForBoth: partial.display?.sameForBoth ?? DEFAULT_CONFIG.display.sameForBoth,
      hideLabels: partial.display?.hideLabels ?? DEFAULT_CONFIG.display.hideLabels,
      hideProviderLabel:
        partial.display?.hideProviderLabel ?? DEFAULT_CONFIG.display.hideProviderLabel,
      source: { ...DEFAULT_CONFIG.display.source, ...(partial.display?.source ?? {}) },
      translation: { ...DEFAULT_CONFIG.display.translation, ...(partial.display?.translation ?? {}) },
    },
    extensions,
    textThread: {
      ...DEFAULT_CONFIG.textThread,
      ...(partial.textThread ?? {}),
    },
    translateTimeoutMs: partial.translateTimeoutMs ?? DEFAULT_CONFIG.translateTimeoutMs,
    window: {
      effect: sanitizeEffect(partial.window?.effect),
      effectTint: partial.window?.effectTint ?? DEFAULT_CONFIG.window.effectTint,
      effectTintOpacity:
        partial.window?.effectTintOpacity ?? DEFAULT_CONFIG.window.effectTintOpacity,
      opacity: partial.window?.opacity ?? DEFAULT_CONFIG.window.opacity,
      backgroundImage:
        partial.window?.backgroundImage ?? DEFAULT_CONFIG.window.backgroundImage,
      backgroundImageOpacity:
        partial.window?.backgroundImageOpacity ?? DEFAULT_CONFIG.window.backgroundImageOpacity,
    },
    extraWindow: {
      sameForBoth:
        partial.extraWindow?.sameForBoth ?? DEFAULT_CONFIG.extraWindow.sameForBoth,
      source: {
        ...DEFAULT_CONFIG.extraWindow.source,
        ...(partial.extraWindow?.source ?? {}),
      },
      translation: {
        ...DEFAULT_CONFIG.extraWindow.translation,
        ...(partial.extraWindow?.translation ?? {}),
      },
      order: partial.extraWindow?.order ?? DEFAULT_CONFIG.extraWindow.order,
      showOriginal:
        partial.extraWindow?.showOriginal ?? DEFAULT_CONFIG.extraWindow.showOriginal,
      showTranslation:
        partial.extraWindow?.showTranslation ?? DEFAULT_CONFIG.extraWindow.showTranslation,
      hideLabels:
        partial.extraWindow?.hideLabels ?? DEFAULT_CONFIG.extraWindow.hideLabels,
      autoResizeHeight:
        partial.extraWindow?.autoResizeHeight ?? DEFAULT_CONFIG.extraWindow.autoResizeHeight,
      effectTint:
        partial.extraWindow?.effectTint ?? DEFAULT_CONFIG.extraWindow.effectTint,
      effectTintOpacity:
        partial.extraWindow?.effectTintOpacity ?? DEFAULT_CONFIG.extraWindow.effectTintOpacity,
      opacity: partial.extraWindow?.opacity ?? DEFAULT_CONFIG.extraWindow.opacity,
      effect: sanitizeEffect(partial.extraWindow?.effect),
      backgroundImage:
        partial.extraWindow?.backgroundImage ?? DEFAULT_CONFIG.extraWindow.backgroundImage,
      backgroundImageOpacity:
        partial.extraWindow?.backgroundImageOpacity ??
        DEFAULT_CONFIG.extraWindow.backgroundImageOpacity,
      position: partial.extraWindow?.position,
      width: partial.extraWindow?.width,
      alwaysOnTop:
        partial.extraWindow?.alwaysOnTop ?? DEFAULT_CONFIG.extraWindow.alwaysOnTop,
      clickThrough:
        partial.extraWindow?.clickThrough ?? DEFAULT_CONFIG.extraWindow.clickThrough,
    },
    websocket: {
      serverEnabled:
        partial.websocket?.serverEnabled ?? DEFAULT_CONFIG.websocket.serverEnabled,
      serverPort: partial.websocket?.serverPort ?? DEFAULT_CONFIG.websocket.serverPort,
      serverIncludeClipboard:
        partial.websocket?.serverIncludeClipboard ??
        DEFAULT_CONFIG.websocket.serverIncludeClipboard,
      clientEnabled:
        partial.websocket?.clientEnabled ?? DEFAULT_CONFIG.websocket.clientEnabled,
      clientUrl: partial.websocket?.clientUrl ?? DEFAULT_CONFIG.websocket.clientUrl,
    },
  };
}

export function ConfigProvider({ children }: { children: ReactNode }) {
  const [config, setConfig] = useState<AppConfig>(DEFAULT_CONFIG);
  const configRef = useRef(config);
  configRef.current = config;
  const loadedRef = useRef(false);
  const lastEmittedRef = useRef("");
  const lastAppliedRef = useRef("");

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      let raw: Partial<AppConfig> | null = null;
      if (isTauri()) {
        try {
          raw = await invoke<Partial<AppConfig>>("load_config");
        } catch {
          raw = null;
        }
      } else {
        try {
          raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<AppConfig>;
        } catch {
          raw = null;
        }
      }
      if (!cancelled && raw && Object.keys(raw).length > 0) {
        setConfig(mergeConfig(raw));
      }
      loadedRef.current = true;
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!loadedRef.current) return;
    const id = window.setTimeout(() => {
      if (isTauri()) {
        const json = JSON.stringify(config);
        void invoke("save_config", { config }).catch(() => {});
        // 只有主窗口负责广播配置变更，避免窗口间互相触发形成循环。
        if (isMainWindow() && lastEmittedRef.current !== json) {
          lastEmittedRef.current = json;
          void emit("config-changed", config).catch(() => {});
        }
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
      }
    }, 300);
    return () => window.clearTimeout(id);
  }, [config]);

  // 非主窗口（extra window）监听主窗口广播的配置变更并应用。
  useEffect(() => {
    if (!isTauri() || isMainWindow()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<AppConfig>("config-changed", (event) => {
      if (disposed) return;
      const json = JSON.stringify(event.payload);
      if (lastAppliedRef.current === json) return;
      lastAppliedRef.current = json;
      setConfig(mergeConfig(event.payload));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 主窗口监听悬浮窗移动事件，把位置记入配置以便下次打开时恢复。
  useEffect(() => {
    if (!isTauri() || !isMainWindow()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<{ x: number; y: number }>("extra-window-position", (event) => {
      if (disposed) return;
      setConfig((prev) => ({
        ...prev,
        extraWindow: { ...prev.extraWindow, position: { x: event.payload.x, y: event.payload.y } },
      }));
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 主窗口监听悬浮窗尺寸事件，把宽度记入配置以便下次打开时恢复。
  useEffect(() => {
    if (!isTauri() || !isMainWindow()) return;
    let disposed = false;
    let unlisten: UnlistenFn | undefined;
    void listen<{ width: number }>("extra-window-size", (event) => {
      if (disposed) return;
      const next: AppConfig = {
        ...configRef.current,
        extraWindow: { ...configRef.current.extraWindow, width: event.payload.width },
      };
      configRef.current = next;
      setConfig(next);
      // 宽度是用户拖拽悬浮窗产生的、需要跨重启保留；立即持久化，
      // 避免主窗口很快关闭时 300ms 防抖还没落盘导致宽度丢失。
      void invoke("save_config", { config: next }).catch(() => {});
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // 主窗口负责启动 / 停止 WebSocket 服务端与客户端（跟随配置）。
  useEffect(() => {
    if (!isTauri() || !isMainWindow()) return;
    if (config.websocket.serverEnabled) {
      void invoke("ws_start_server", { port: config.websocket.serverPort }).catch(() => {});
    } else {
      void invoke("ws_stop_server").catch(() => {});
    }
  }, [config.websocket.serverEnabled, config.websocket.serverPort]);

  useEffect(() => {
    if (!isTauri() || !isMainWindow()) return;
    if (config.websocket.clientEnabled) {
      void invoke("ws_start_client", { url: config.websocket.clientUrl }).catch(() => {});
    } else {
      void invoke("ws_stop_client").catch(() => {});
    }
  }, [config.websocket.clientEnabled, config.websocket.clientUrl]);

  useEffect(() => {
    if (i18n.language !== config.language) {
      void i18n.changeLanguage(config.language);
    }
  }, [config.language]);

  const setLanguage = useCallback((language: string) => {
    setConfig((prev) => ({ ...prev, language }));
  }, []);

  const setThemeMode = useCallback((mode: ThemeMode) => {
    setConfig((prev) => ({ ...prev, themeMode: mode }));
  }, []);

  const setHideSystemProcesses = useCallback((value: boolean) => {
    setConfig((prev) => ({ ...prev, hideSystemProcesses: value }));
  }, []);

  const setDisplay = useCallback((display: DisplaySettings) => {
    setConfig((prev) => ({ ...prev, display }));
  }, []);

  const setExtensions = useCallback((extensions: Extension[]) => {
    setConfig((prev) => ({ ...prev, extensions }));
  }, []);

  const setTextThread = useCallback((textThread: TextThreadSettings) => {
    setConfig((prev) => ({ ...prev, textThread }));
  }, []);

  const setTranslateTimeout = useCallback((translateTimeoutMs: number) => {
    setConfig((prev) => ({ ...prev, translateTimeoutMs }));
  }, []);

  const setWindowAppearance = useCallback((window: WindowAppearance) => {
    setConfig((prev) => ({ ...prev, window }));
  }, []);

  const setExtraWindow = useCallback((extraWindow: ExtraWindowSettings) => {
    setConfig((prev) => ({ ...prev, extraWindow }));
  }, []);

  const setWebSocket = useCallback((websocket: WebSocketSettings) => {
    setConfig((prev) => ({ ...prev, websocket }));
  }, []);

  const value = useMemo(
    () => ({
      config,
      setLanguage,
      setThemeMode,
      setHideSystemProcesses,
      setDisplay,
      setExtensions,
      setTextThread,
      setTranslateTimeout,
      setWindowAppearance,
      setExtraWindow,
      setWebSocket,
    }),
    [
      config,
      setLanguage,
      setThemeMode,
      setHideSystemProcesses,
      setDisplay,
      setExtensions,
      setTextThread,
      setTranslateTimeout,
      setWindowAppearance,
      setExtraWindow,
      setWebSocket,
    ],
  );

  return <ConfigContext.Provider value={value}>{children}</ConfigContext.Provider>;
}

export function useConfig(): ConfigContextValue {
  const ctx = useContext(ConfigContext);
  if (!ctx) throw new Error("useConfig must be used within a ConfigProvider");
  return ctx;
}
