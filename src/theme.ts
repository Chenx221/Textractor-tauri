import { createTheme, type Theme } from "@mui/material/styles";

export type ThemeMode = "light" | "dark" | "system";

const typography = {
  fontFamily: [
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "Roboto",
    "Helvetica Neue",
    "Arial",
    "sans-serif",
  ].join(","),
};

function hexToRgba(hex: string, alpha: number): string {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  if (Number.isNaN(n)) return hex;
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const a = Math.min(1, Math.max(0, alpha));
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export function createAppTheme(mode: "light" | "dark", backgroundAlpha = 1): Theme {
  const bg =
    mode === "dark"
      ? { default: "#1b1b1f", paper: "#222227" }
      : { default: "#f5f5f7", paper: "#ffffff" };
  return createTheme({
    palette: {
      mode,
      primary: { main: "#4f8ef7" },
      secondary: { main: "#c084fc" },
      background: {
        default: hexToRgba(bg.default, backgroundAlpha),
        paper: hexToRgba(bg.paper, backgroundAlpha),
      },
    },
    shape: { borderRadius: 8 },
    typography,
    components: {
      // 下拉菜单/弹窗/对话框保持不透明，避免背景透明度影响可读性。
      MuiMenu: {
        styleOverrides: {
          paper: { backgroundColor: bg.paper },
        },
      },
      MuiPopover: {
        styleOverrides: {
          paper: { backgroundColor: bg.paper },
        },
      },
      MuiDialog: {
        styleOverrides: {
          paper: { backgroundColor: bg.paper },
        },
      },
      // 主窗口半透明时，弹窗遮罩不渲染暗色背景，避免把桌面一起压暗。
      MuiBackdrop: {
        styleOverrides: {
          root: { backgroundColor: "transparent" },
        },
      },
    },
  });
}
