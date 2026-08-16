import { useMemo, type ReactNode } from "react";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import useMediaQuery from "@mui/material/useMediaQuery";
import { createAppTheme, type ThemeMode } from "./theme";
import { useConfig } from "./settings/ConfigContext";

export function ThemeModeProvider({ children }: { children: ReactNode }) {
  const { config } = useConfig();
  const prefersDark = useMediaQuery("(prefers-color-scheme: dark)");

  const resolvedMode: "light" | "dark" =
    config.themeMode === "system" ? (prefersDark ? "dark" : "light") : config.themeMode;

  // 背景不透明度跟随“背景不透明度”设置（所有效果均生效）。
  // 对话框/菜单/弹窗背景已在 createAppTheme 中强制为不透明，且弹窗遮罩设为透明，
  // 因此主窗口半透明时不会出现“阴影把桌面一起压暗”的问题。
  const backgroundAlpha = Math.min(1, Math.max(0, config.window.opacity));

  const theme = useMemo(
    () => createAppTheme(resolvedMode, backgroundAlpha),
    [resolvedMode, backgroundAlpha],
  );

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}

export function useThemeMode(): { mode: ThemeMode; setMode: (mode: ThemeMode) => void } {
  const { config, setThemeMode } = useConfig();
  return { mode: config.themeMode, setMode: setThemeMode };
}
