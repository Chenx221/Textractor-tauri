import type { DisplaySettings } from "./display";
import type { Extension } from "./extensions";
import type { ExtraWindowSettings, WindowAppearance } from "./extraWindow";
import type { ThemeMode } from "../theme";

export interface TextThreadSettings {
  filter_repetition: boolean;
  /** 0=关闭, 1=空格, 2=换行 */
  flush_delay_spacing: number;
  /** flush 延迟（毫秒） */
  flush_delay_ms: number;
  max_buffer: number;
  /** 0=关闭，超过该长度丢弃 */
  limit_string_length: number;
}

export interface WebSocketSettings {
  /** 服务端：向已连接客户端广播当前线程文本。 */
  serverEnabled: boolean;
  serverPort: number;
  /** 是否包含剪切板线程的文本（默认仅文本线程）。 */
  serverIncludeClipboard: boolean;
  /** 客户端：连接到外部服务器并把收到的文本当作一个独立线程。 */
  clientEnabled: boolean;
  clientUrl: string;
}

export interface AppConfig {
  language: string;
  themeMode: ThemeMode;
  hideSystemProcesses: boolean;
  display: DisplaySettings;
  extensions: Extension[];
  textThread: TextThreadSettings;
  /** 翻译请求最大等待时间（毫秒）。 */
  translateTimeoutMs: number;
  /** 主窗口外观。 */
  window: WindowAppearance;
  /** 无边框悬浮窗独立设置。 */
  extraWindow: ExtraWindowSettings;
  /** WebSocket 服务端 / 客户端。 */
  websocket: WebSocketSettings;
}
