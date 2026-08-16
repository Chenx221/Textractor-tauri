export interface FontSettings {
  family: string;
  size: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  color: string;
  strokeColor: string;
  strokeWidth: number;
  glowColor: string;
  glowRadius: number;
}

export interface DisplaySettings {
  sameForBoth: boolean;
  source: FontSettings;
  translation: FontSettings;
  /** 隐藏“原文”“译文”标签，简化文本块。 */
  hideLabels: boolean;
  /** 隐藏译文里的翻译服务商标签。 */
  hideProviderLabel: boolean;
}
