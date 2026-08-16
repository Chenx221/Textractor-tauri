export interface ProcessInfo {
  pid: number;
  name: string;
  title: string;
  arch: string;
  has_file: boolean;
  is_system: boolean;
  /** 进程图标（BMP data URI）。 */
  icon: string | null;
}
