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

// ---- 配置诊断（后端 config_store 的返回结构，字段名与 Rust 保持一致） ----

/** 磁盘上 settings.json（或备份/快照）在某一刻的样子。 */
export interface ConfigFileState {
  exists: boolean;
  len: number;
  /** Unix 秒；0 表示未知。 */
  mtime: number;
  created: number;
  /** 内容 sha256 前 16 位。 */
  sha: string;
  /** missing | unreadable | invalid_json | not_object | bad_shape | ok */
  parse: string;
  reason: string;
}

export interface ConfigBackupInfo {
  exists: boolean;
  len: number;
  mtime: number;
  parse: string;
}

export interface ConfigHistoryEntry {
  name: string;
  stamp: string;
  len: number;
  parse: string;
}

/**
 * ok        正常读取
 * first_run 从没有过配置文件（首次运行）
 * recovered 启动时文件缺失/损坏，已自动用备份恢复
 * damaged   文件损坏/丢失，**等用户确认**才能继续
 * unreadable 文件读不出来（被占用/权限），同上
 */
export type ConfigLoadStatus = "ok" | "first_run" | "recovered" | "damaged" | "unreadable";

export interface ConfigLoadInfo {
  status: ConfigLoadStatus;
  config: Partial<AppConfig> | null;
  /** 给用户看的说明。 */
  detail: string;
  path: string;
  log_path: string;
  file: ConfigFileState;
  backup: ConfigBackupInfo;
  history: ConfigHistoryEntry[];
  /** clean | unknown | missing_after_exit | modified_while_closed | external_corruption */
  verdict: string;
  verdict_detail: string;
}

export interface ConfigPaths {
  config: string;
  backup: string;
  log: string;
  dir: string;
  history_dir: string;
}
