import type { FontSettings } from "./display";

export type ExtraWindowOrder = "originalFirst" | "translationFirst";
export type BackdropEffect = "none" | "aero" | "acrylic" | "mica";

/** 无边框悬浮窗（extra window）的独立设置，持久化到主配置。 */
export interface ExtraWindowSettings {
  /** 译文与原文使用相同字体样式。 */
  sameForBoth: boolean;
  source: FontSettings;
  translation: FontSettings;
  /** 文本块内原文/译文的显示顺序。 */
  order: ExtraWindowOrder;
  showOriginal: boolean;
  showTranslation: boolean;
  /** 隐藏“原文”“译文”标签。 */
  hideLabels: boolean;
  /** 根据内容自动调整窗口高度。 */
  autoResizeHeight: boolean;
  /** 面板背景不透明度 0..1（文字不受影响）。 */
  opacity: number;
  /** 原生背景效果（普通透明/Aero/亚克力/云母）。 */
  effect: BackdropEffect;
  /** 背景图路径（空 = 不使用）。 */
  backgroundImage: string;
  backgroundImageOpacity: number;
  /** 上次窗口位置（物理像素），关闭后下次打开时恢复。 */
  position?: { x: number; y: number };
  /** 上次窗口宽度（逻辑像素），关闭后下次打开时恢复。 */
  width?: number;
  /** 悬浮窗置顶。 */
  alwaysOnTop: boolean;
  /** 点击穿透（忽略鼠标事件）。 */
  clickThrough: boolean;
}

/** 主窗口外观设置（原生背景效果 + 背景图）。 */
export interface WindowAppearance {
  effect: BackdropEffect;
  /** 主题背景不透明度 0..1（作用于 background.default/paper）。 */
  opacity: number;
  backgroundImage: string;
  backgroundImageOpacity: number;
}
