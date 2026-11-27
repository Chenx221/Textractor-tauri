export interface ProcessInfo {
  pid: number;
  name: string;
  title: string;
  arch: string;
  has_file: boolean;
  is_system: boolean;
  /** 命令行带 `--type=renderer`（Chromium/Electron/CEF 渲染进程，通常没有窗口标题）。 */
  is_renderer: boolean;
  /** 进程图标（BMP data URI）。 */
  icon: string | null;
}
