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
  /** 原生效果 tint 颜色（#RRGGBB，空 = 自动跟随主题）。 */
  effectTint: string;
  /**
   * 面板底色跟随主题（默认 true）。
   *
   * 以前 `effect: none` 时面板底色也由 `effectTint` 决定，但这个选项只在
   * "有原生效果"时才显示 —— 于是一旦存过 `#ffffff`，切到深色主题后底还是白的，
   * 而且在界面上根本改不掉。现在默认跟随主题，想固定某个颜色再手动取消。
   */
  tintFollowTheme: boolean;
  /** 原生效果 tint 不透明度 0..1。 */
  effectTintOpacity: number;
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
  /** 原生效果 tint 颜色（#RRGGBB，空 = 自动跟随主题）。 */
  effectTint: string;
  /** 原生效果 tint 不透明度 0..1。 */
  effectTintOpacity: number;
  /** 主题背景不透明度 0..1（作用于 background.default/paper）。 */
  opacity: number;
  backgroundImage: string;
  backgroundImageOpacity: number;
}
