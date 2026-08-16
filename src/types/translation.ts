/** 某个翻译服务对一条原文的翻译结果。 */
export interface TranslationEntry {
  /** 翻译服务 id。 */
  provider: string;
  /** pending=未请求（显示“翻译”按钮）, loading=翻译中, done=完成, error=失败。 */
  state: "pending" | "loading" | "done" | "error";
  text?: string;
  error?: string;
  fromCache?: boolean;
}

export interface TextBlock {
  id: string;
  original: string;
  /** 多个启用翻译服务的结果（按翻译器顺序）。 */
  translations: TranslationEntry[];
  /** 所属 hook 线程 id（`pid:addr:ctx:ctx2`）。 */
  threadId?: string;
  /** 罗马音标注（仅当启用罗马音增强扩展时存在，不影响翻译）。 */
  romanji?: string;
}

/** 主窗口转发给无边框悬浮窗（extra window）的最新文本块载荷。 */
export interface ExtraWindowText {
  original: string;
  threadId: string;
  translations: TranslationEntry[];
  /** 罗马音标注（可选，仅显示）。 */
  romanji?: string;
}
