import { useCallback, type CSSProperties } from "react";
import { useConfig } from "./ConfigContext";
import type { DisplaySettings, FontSettings } from "../types/display";

export function fontToStyle(font: FontSettings): CSSProperties {
  return {
    fontFamily: font.family || undefined,
    fontSize: font.size,
    fontWeight: font.bold ? 700 : 400,
    fontStyle: font.italic ? "italic" : "normal",
    textDecoration: font.underline ? "underline" : "none",
    color: font.color || undefined,
    WebkitTextStroke:
      font.strokeColor && font.strokeWidth > 0
        ? `${font.strokeWidth}px ${font.strokeColor}`
        : undefined,
    textShadow:
      font.glowColor && font.glowRadius > 0
        ? `0 0 ${font.glowRadius}px ${font.glowColor}`
        : undefined,
  };
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
