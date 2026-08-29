import { useEffect, useState } from "react";
import {
  Box,
  IconButton,
  MenuItem,
  TextField,
  Typography,
} from "@mui/material";
import FormatBoldIcon from "@mui/icons-material/FormatBold";
import FormatItalicIcon from "@mui/icons-material/FormatItalic";
import FormatUnderlinedIcon from "@mui/icons-material/FormatUnderlined";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import type { FontSettings } from "../types/display";

interface FontSettingsEditorProps {
  value: FontSettings;
  onChange: (patch: Partial<FontSettings>) => void;
  disabled?: boolean;
}

const CANDIDATE_FONTS = [
  "Arial",
  "Segoe UI",
  "Consolas",
  "Courier New",
  "Times New Roman",
  "Verdana",
  "Tahoma",
  "Trebuchet MS",
  "Georgia",
  "Calibri",
  "Cambria",
  "Microsoft YaHei",
  "Microsoft JhengHei",
  "SimSun",
  "SimHei",
  "KaiTi",
  "FangSong",
  "Yu Gothic",
  "Meiryo",
  "MS Gothic",
  "MS Mincho",
  "Noto Sans",
  "Noto Sans CJK SC",
  "Noto Sans JP",
];

function detectAvailableFonts(): string[] {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx) return [];
  const text = "mmmmmmmmmmlli";
  ctx.font = "72px monospace";
  const baseline = ctx.measureText(text).width;
  return CANDIDATE_FONTS.filter((font) => {
    ctx.font = `72px "${font}", monospace`;
    return ctx.measureText(text).width !== baseline;
  });
}

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function FontSettingsEditor({ value, onChange, disabled }: FontSettingsEditorProps) {
  const { t } = useTranslation();
  const [fonts, setFonts] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    if (isTauri()) {
      invoke<string[]>("list_fonts")
        .then((list) => {
          if (!cancelled) setFonts(list);
        })
        .catch(() => {
          if (!cancelled) setFonts(detectAvailableFonts());
        });
    } else {
      setFonts(detectAvailableFonts());
    }
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        opacity: disabled ? 0.45 : 1,
        pointerEvents: disabled ? "none" : "auto",
      }}
    >
      <TextField
        select
        size="small"
        fullWidth
        label={t("settings.fontFamily")}
        value={value.family}
        onChange={(e) => onChange({ family: e.target.value })}
      >
        <MenuItem value="">{t("settings.fontDefault")}</MenuItem>
        {fonts.map((font) => (
          <MenuItem key={font} value={font}>
            {font}
          </MenuItem>
        ))}
      </TextField>

      <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
        <TextField
          label={t("settings.fontSize")}
          type="number"
          size="small"
          value={value.size}
          onChange={(e) => onChange({ size: Number(e.target.value) || value.size })}
          slotProps={{ htmlInput: { min: 8, max: 48 } }}
          sx={{ width: 110 }}
        />
        <IconButton size="small" color={value.bold ? "primary" : "default"} onClick={() => onChange({ bold: !value.bold })}>
          <FormatBoldIcon fontSize="small" />
        </IconButton>
        <IconButton size="small" color={value.italic ? "primary" : "default"} onClick={() => onChange({ italic: !value.italic })}>
          <FormatItalicIcon fontSize="small" />
        </IconButton>
        <IconButton size="small" color={value.underline ? "primary" : "default"} onClick={() => onChange({ underline: !value.underline })}>
          <FormatUnderlinedIcon fontSize="small" />
        </IconButton>
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32 }}>
          {t("settings.color")}
        </Typography>
        <input
          type="color"
          value={value.color || "#000000"}
          onChange={(e) => onChange({ color: e.target.value })}
          style={{ width: 30, height: 30, padding: 0, border: "none", background: "none", cursor: "pointer" }}
        />
        <TextField
          size="small"
          fullWidth
          value={value.color}
          onChange={(e) => onChange({ color: e.target.value })}
          placeholder="#RRGGBB"
          slotProps={{ htmlInput: { maxLength: 7 } }}
        />
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32 }}>
          {t("settings.stroke")}
        </Typography>
        <input
          type="color"
          value={value.strokeColor || "#000000"}
          onChange={(e) => onChange({ strokeColor: e.target.value })}
          style={{ width: 30, height: 30, padding: 0, border: "none", background: "none", cursor: "pointer" }}
        />
        <TextField
          type="number"
          size="small"
          value={value.strokeWidth}
          onChange={(e) => onChange({ strokeWidth: Math.max(0, Number(e.target.value) || 0) })}
          slotProps={{ htmlInput: { min: 0, max: 20, step: 0.5 } }}
          sx={{ width: 70 }}
        />
        <Typography variant="caption" color="text.secondary">px</Typography>
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <Typography variant="caption" color="text.secondary" sx={{ minWidth: 32 }}>
          {t("settings.glow")}
        </Typography>
        <input
          type="color"
          value={value.glowColor || "#000000"}
          onChange={(e) => onChange({ glowColor: e.target.value })}
          style={{ width: 30, height: 30, padding: 0, border: "none", background: "none", cursor: "pointer" }}
        />
        <TextField
          type="number"
          size="small"
          value={value.glowRadius}
          onChange={(e) => onChange({ glowRadius: Math.max(0, Number(e.target.value) || 0) })}
          slotProps={{ htmlInput: { min: 0, max: 50 } }}
          sx={{ width: 70 }}
        />
        <Typography variant="caption" color="text.secondary">px</Typography>
      </Box>
    </Box>
  );
}
