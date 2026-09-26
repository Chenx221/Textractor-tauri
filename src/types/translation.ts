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

/** 主窗口转发给无边框悬浮窗（extra window）的文本块载荷。 */
export interface ExtraWindowText {
  /** 文本块 id（用于历史浏览去重/比对）。 */
  id: string;
  original: string;
  threadId: string;
  translations: TranslationEntry[];
  /** 罗马音标注（可选，仅显示）。 */
  romanji?: string;
  /**
   * true = 主窗口处于暂停：悬浮窗仍然把这条记进历史缓冲，
   * 但不要切换当前显示（保持暂停那一刻的文本）。
   * 历史批次返回的条目不带此标记。
   */
  hold?: boolean;
}

/** 悬浮窗向主窗口请求历史文本（滚轮上翻时按需加载）。 */
export interface ExtraWindowHistoryRequest {
  threadId: string;
  /** 只取该 id 之前（更旧）的条目；null = 从最新一条往前取。 */
  beforeId: string | null;
  /** 本批最多返回多少条。 */
  limit: number;
}

/** 主窗口返回的历史文本（按时间正序，旧 → 新）。 */
export interface ExtraWindowHistory {
  threadId: string;
  /** 该线程当前的文本块总数（用于显示浏览位置）。 */
  total: number;
  /** 是否还有更旧的条目可继续加载。 */
  hasMore: boolean;
  entries: ExtraWindowText[];
}
