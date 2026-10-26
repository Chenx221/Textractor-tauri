import { useCallback, type CSSProperties } from "react";
import { useConfig } from "./ConfigContext";
import type { DisplaySettings, FontSettings } from "../types/display";

/**
 * 字体设置 → CSS 样式。
 *
 * `fallbackColor` 用于"用户没指定颜色"的情况：传进来主题的正文色，而不是让
 * 文字去继承祖先元素。悬浮窗是透明窗口，继承链一旦断掉就会退回浏览器默认的
 * 黑色（深色主题下直接看不见），所以这里显式给默认值。
 */
export function fontToStyle(font: FontSettings, fallbackColor?: string): CSSProperties {
  const style: CSSProperties = {
    fontFamily: font.family || undefined,
    fontSize: font.size,
    fontWeight: font.bold ? 700 : 400,
    fontStyle: font.italic ? "italic" : "normal",
    textDecoration: font.underline ? "underline" : "none",
    color: font.color || fallbackColor,
  };

  const shadows: string[] = [];
  const strokeColor = font.strokeColor;
  const strokeWidth = font.strokeWidth;

  if (strokeColor && strokeWidth > 0) {
    if (strokeWidth <= 2) {
      // 细描边用 -webkit-text-stroke，边缘更锐利。
      style.WebkitTextStroke = `${strokeWidth}px ${strokeColor}`;
    } else {
      // 粗描边：-webkit-text-stroke 会向字形内部侵蚀，改用多方向 text-shadow
      // 在字形外围描一圈粗边，文字主体保持完整可读。
      const r = strokeWidth;
      const dirs: [number, number][] = [
        [0, -1], [1, -1], [1, 0], [1, 1],
        [0, 1], [-1, 1], [-1, 0], [-1, -1],
      ];
      for (const [dx, dy] of dirs) {
        shadows.push(`${(dx * r).toFixed(1)}px ${(dy * r).toFixed(1)}px 0 ${strokeColor}`);
      }
    }
  }

  if (font.glowColor && font.glowRadius > 0) {
    shadows.push(`0 0 ${font.glowRadius}px ${font.glowColor}`);
  }

  if (shadows.length > 0) {
    style.textShadow = shadows.join(", ");
  }

  return style;
}

interface DisplaySettingsContextValue {
  display: DisplaySettings;
  updateSource: (patch: Partial<FontSettings>) => void;
  updateTranslation: (patch: Partial<FontSettings>) => void;
  setSameForBoth: (value: boolean) => void;
  setHideLabels: (value: boolean) => void;
  setHideProviderLabel: (value: boolean) => void;
}

export function useDisplaySettings(): DisplaySettingsContextValue {
  const { config, setDisplay } = useConfig();
  const display = config.display;

  const updateSource = useCallback(
    (patch: Partial<FontSettings>) => {
      const source = { ...display.source, ...patch };
      setDisplay({
        ...display,
        source,
        translation: display.sameForBoth ? { ...source } : display.translation,
      });
    },
    [display, setDisplay],
  );

  const updateTranslation = useCallback(
    (patch: Partial<FontSettings>) => {
      setDisplay({ ...display, translation: { ...display.translation, ...patch } });
    },
    [display, setDisplay],
  );

  const setSameForBoth = useCallback(
    (value: boolean) => {
      setDisplay({
        ...display,
        sameForBoth: value,
        translation: value ? { ...display.source } : display.translation,
      });
    },
    [display, setDisplay],
  );

  const setHideLabels = useCallback(
    (value: boolean) => {
      setDisplay({ ...display, hideLabels: value });
    },
    [display, setDisplay],
  );

  const setHideProviderLabel = useCallback(
    (value: boolean) => {
      setDisplay({ ...display, hideProviderLabel: value });
    },
    [display, setDisplay],
  );

  return {
    display,
    updateSource,
    updateTranslation,
    setSameForBoth,
    setHideLabels,
    setHideProviderLabel,
  };
}
