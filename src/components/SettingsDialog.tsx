import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControl,
  FormControlLabel,
  FormLabel,
  MenuItem,
  Radio,
  RadioGroup,
  Select,
  Slider,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { LANGUAGES } from "../i18n";
import { useThemeMode } from "../ThemeModeProvider";
import { useConfig } from "../settings/ConfigContext";
import { useDisplaySettings } from "../settings/DisplaySettingsContext";
import { FontSettingsEditor } from "./FontSettingsEditor";
import { TranslationCacheDialog } from "./TranslationCacheDialog";
import { formatBytes } from "../utils/format";
import type { ThemeMode } from "../theme";
import type { FontSettings } from "../types/display";
import type { BackdropEffect } from "../types/extraWindow";

interface SettingsDialogProps {
  open: boolean;
  onClose: () => void;
}

interface CacheOverview {
  entries: number;
  bytes: number;
}

const THEME_OPTIONS: { value: ThemeMode; labelKey: string }[] = [
  { value: "light", labelKey: "settings.themeLight" },
  { value: "dark", labelKey: "settings.themeDark" },
  { value: "system", labelKey: "settings.themeSystem" },
];

const EFFECT_OPTIONS: { value: BackdropEffect; labelKey: string }[] = [
  { value: "none", labelKey: "settings.effectNone" },
  { value: "aero", labelKey: "settings.effectAero" },
  { value: "acrylic", labelKey: "settings.effectAcrylic" },
  { value: "mica", labelKey: "settings.effectMica" },
];

interface AppearanceValue {
  effect: BackdropEffect;
  effectTint: string;
  effectTintOpacity: number;
  opacity: number;
  backgroundImage: string;
  backgroundImageOpacity: number;
}

type AppearancePatch = Partial<AppearanceValue>;

function Section({ titleKey, children }: { titleKey: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <>
      <Divider sx={{ my: 2 }} />
      <Typography variant="subtitle1" sx={{ mb: 1.5, fontWeight: 600 }}>
        {t(titleKey)}
      </Typography>
      {children}
    </>
  );
}

export function SettingsDialog({ open, onClose }: SettingsDialogProps) {
  const { t } = useTranslation();
  const { mode, setMode } = useThemeMode();
  const {
    config,
    setLanguage,
    setHideSystemProcesses,
    setTextThread,
    setTranslateTimeout,
    setWindowAppearance,
    setExtraWindow,
  } = useConfig();
  const {
    display,
    updateSource,
    updateTranslation,
    setSameForBoth,
    setHideLabels,
    setHideProviderLabel,
  } = useDisplaySettings();

  const extra = config.extraWindow;

  // 翻译缓存概览：打开设置时读一次，关掉缓存管理后再刷新一次。
  const [cacheStats, setCacheStats] = useState<CacheOverview | null>(null);
  const [cacheOpen, setCacheOpen] = useState(false);

  const loadCacheStats = useCallback(() => {
    if (!("__TAURI_INTERNALS__" in window)) return;
    void invoke<CacheOverview>("cache_stats")
      .then((stats) => setCacheStats({ entries: stats.entries, bytes: stats.bytes }))
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (open) loadCacheStats();
  }, [open, loadCacheStats]);

  const updateExtraSource = (patch: Partial<FontSettings>) => {
    const source = { ...extra.source, ...patch };
    setExtraWindow({
      ...extra,
      source,
      translation: extra.sameForBoth ? { ...source } : extra.translation,
    });
  };

  const updateExtraTranslation = (patch: Partial<FontSettings>) => {
    setExtraWindow({ ...extra, translation: { ...extra.translation, ...patch } });
  };

  const setExtraSameForBoth = (value: boolean) => {
    setExtraWindow({
      ...extra,
      sameForBoth: value,
      translation: value ? { ...extra.source } : extra.translation,
    });
  };

  const pickImage = async (target: "window" | "extraWindow") => {
    try {
      const selected = await openDialog({ multiple: false });
      if (typeof selected !== "string") return;
      if (target === "window") {
        setWindowAppearance({ ...config.window, backgroundImage: selected });
      } else {
        setExtraWindow({ ...extra, backgroundImage: selected });
      }
    } catch {
      // 用户取消或浏览器环境。
    }
  };

  const renderAppearance = (
    value: AppearanceValue,
    onChange: (patch: AppearancePatch) => void,
    target: "window" | "extraWindow",
    opacityDisabled = false,
  ) => (
    <>
      <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
        <FormLabel>{t("settings.effect")}</FormLabel>
        <Select
          value={value.effect}
          onChange={(e) => onChange({ effect: e.target.value as BackdropEffect })}
        >
          {EFFECT_OPTIONS.map((option) => (
            <MenuItem key={option.value} value={option.value}>
              {t(option.labelKey)}
            </MenuItem>
          ))}
        </Select>
      </FormControl>

      {value.effect !== "none" && (
        <>
          <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
            <FormLabel>{t("settings.effectTint")}</FormLabel>
            <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
              <input
                type="color"
                value={value.effectTint || "#202020"}
                onChange={(e) => onChange({ effectTint: e.target.value })}
                style={{
                  width: 30,
                  height: 30,
                  padding: 0,
                  border: "none",
                  background: "none",
                  cursor: "pointer",
                }}
              />
              <TextField
                size="small"
                fullWidth
                value={value.effectTint}
                onChange={(e) => onChange({ effectTint: e.target.value })}
                placeholder="#RRGGBB"
                slotProps={{ htmlInput: { maxLength: 7 } }}
              />
              <Button size="small" onClick={() => onChange({ effectTint: "" })}>
                {t("settings.clearImage")}
              </Button>
            </Box>
          </FormControl>

          <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
            <FormLabel>{t("settings.effectTintOpacity")}</FormLabel>
            <Slider
              value={value.effectTintOpacity}
              min={0}
              max={1}
              step={0.05}
              valueLabelDisplay="auto"
              onChange={(_, v) => onChange({ effectTintOpacity: v as number })}
            />
          </FormControl>
        </>
      )}

      <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
        <FormLabel>{t("settings.windowOpacity")}</FormLabel>
        <Slider
          value={value.opacity}
          min={0.05}
          max={1}
          step={0.05}
          valueLabelDisplay="auto"
          disabled={opacityDisabled}
          onChange={(_, v) => onChange({ opacity: v as number })}
        />
      </FormControl>

      <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
        <FormLabel>{t("settings.backgroundImage")}</FormLabel>
        <Box sx={{ display: "flex", gap: 1, alignItems: "center" }}>
          <TextField
            size="small"
            fullWidth
            value={value.backgroundImage}
            onChange={(e) => onChange({ backgroundImage: e.target.value })}
            placeholder={t("settings.backgroundImage")}
          />
          <Button size="small" onClick={() => pickImage(target)}>
            {t("settings.browse")}
          </Button>
          <Button size="small" onClick={() => onChange({ backgroundImage: "" })}>
            {t("settings.clearImage")}
          </Button>
        </Box>
      </FormControl>

      <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
        <FormLabel>{t("settings.backgroundImageOpacity")}</FormLabel>
        <Slider
          value={value.backgroundImageOpacity}
          min={0}
          max={1}
          step={0.05}
          valueLabelDisplay="auto"
          onChange={(_, v) => onChange({ backgroundImageOpacity: v as number })}
        />
      </FormControl>
    </>
  );

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("settings.title")}</DialogTitle>
      <DialogContent>
        <Section titleKey="settings.general">
          <FormControl fullWidth sx={{ mb: 1.5 }}>
            <FormLabel>{t("settings.language")}</FormLabel>
            <Select
              value={config.language}
              onChange={(e) => setLanguage(e.target.value)}
              size="small"
              fullWidth
            >
              {LANGUAGES.map((lang) => (
                <MenuItem key={lang.code} value={lang.code}>
                  {lang.label}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth sx={{ mb: 1.5 }}>
            <FormLabel>{t("settings.theme")}</FormLabel>
            <RadioGroup value={mode} onChange={(e) => setMode(e.target.value as ThemeMode)}>
              {THEME_OPTIONS.map((option) => (
                <FormControlLabel
                  key={option.value}
                  value={option.value}
                  control={<Radio size="small" />}
                  label={t(option.labelKey)}
                />
              ))}
            </RadioGroup>
          </FormControl>

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={config.hideSystemProcesses}
                onChange={(e) => setHideSystemProcesses(e.target.checked)}
              />
            }
            label={t("settings.hideSystemProcesses")}
            sx={{ mb: 1.5 }}
          />

          <TextField
            size="small"
            type="number"
            fullWidth
            label={t("settings.translateTimeout")}
            value={config.translateTimeoutMs}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n) && n > 0) {
                setTranslateTimeout(n);
              }
            }}
            sx={{ mb: 1.5 }}
          />
        </Section>

        <Section titleKey="settings.textThread">
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={config.textThread.filter_repetition}
                onChange={(e) =>
                  setTextThread({ ...config.textThread, filter_repetition: e.target.checked })
                }
              />
            }
            label={t("settings.filterRepetition")}
            sx={{ mb: 1.5 }}
          />

          <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
            <FormLabel>{t("settings.flushSpacing")}</FormLabel>
            <Select
              value={config.textThread.flush_delay_spacing}
              onChange={(e) =>
                setTextThread({
                  ...config.textThread,
                  flush_delay_spacing: Number(e.target.value),
                })
              }
            >
              <MenuItem value={0}>{t("settings.flushSpacingOff")}</MenuItem>
              <MenuItem value={1}>{t("settings.flushSpacingSpace")}</MenuItem>
              <MenuItem value={2}>{t("settings.flushSpacingNewline")}</MenuItem>
            </Select>
          </FormControl>

          <TextField
            size="small"
            type="number"
            fullWidth
            label={t("settings.flushDelay")}
            value={config.textThread.flush_delay_ms}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                setTextThread({ ...config.textThread, flush_delay_ms: n });
              }
            }}
            sx={{ mb: 1.5 }}
          />

          <TextField
            size="small"
            type="number"
            fullWidth
            label={t("settings.maxBuffer")}
            value={config.textThread.max_buffer}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                setTextThread({ ...config.textThread, max_buffer: n });
              }
            }}
            sx={{ mb: 1.5 }}
          />

          <TextField
            size="small"
            type="number"
            fullWidth
            label={t("settings.limitStringLength")}
            value={config.textThread.limit_string_length}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) {
                setTextThread({ ...config.textThread, limit_string_length: n });
              }
            }}
            sx={{ mb: 1.5 }}
          />
        </Section>

        <Section titleKey="settings.displayTitle">
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={display.sameForBoth}
                onChange={(e) => setSameForBoth(e.target.checked)}
              />
            }
            label={t("settings.sameFont")}
            sx={{ mb: 1.5 }}
          />

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={display.hideLabels}
                onChange={(e) => setHideLabels(e.target.checked)}
              />
            }
            label={t("settings.hideLabels")}
            sx={{ mb: 1.5 }}
          />

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={display.hideProviderLabel}
                onChange={(e) => setHideProviderLabel(e.target.checked)}
              />
            }
            label={t("settings.hideProviderLabel")}
            sx={{ mb: 1.5 }}
          />

          <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 1, mb: 0.5 }}>
            {t("settings.sourceFont")}
          </Typography>
          <FontSettingsEditor value={display.source} onChange={updateSource} />

          <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 2, mb: 0.5 }}>
            {t("settings.translationFont")}
          </Typography>
          <FontSettingsEditor
            value={display.translation}
            onChange={updateTranslation}
            disabled={display.sameForBoth}
          />
        </Section>

        <Section titleKey="settings.mainWindowAppearanceTitle">
          {renderAppearance(
            config.window,
            (patch) => setWindowAppearance({ ...config.window, ...patch }),
            "window",
          )}
        </Section>

        <Section titleKey="settings.extraWindowTitle">
          <FormControl fullWidth size="small" sx={{ mb: 1.5 }}>
            <FormLabel>{t("settings.extraOrder")}</FormLabel>
            <Select
              value={extra.order}
              onChange={(e) =>
                setExtraWindow({ ...extra, order: e.target.value as typeof extra.order })
              }
            >
              <MenuItem value="originalFirst">{t("settings.orderOriginalFirst")}</MenuItem>
              <MenuItem value="translationFirst">{t("settings.orderTranslationFirst")}</MenuItem>
            </Select>
          </FormControl>

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={extra.showOriginal}
                onChange={(e) => setExtraWindow({ ...extra, showOriginal: e.target.checked })}
              />
            }
            label={t("settings.showOriginal")}
            sx={{ mb: 1.5 }}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={extra.showTranslation}
                onChange={(e) => setExtraWindow({ ...extra, showTranslation: e.target.checked })}
              />
            }
            label={t("settings.showTranslation")}
            sx={{ mb: 1.5 }}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={extra.hideLabels}
                onChange={(e) => setExtraWindow({ ...extra, hideLabels: e.target.checked })}
              />
            }
            label={t("settings.hideLabels")}
            sx={{ mb: 1.5 }}
          />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={extra.autoResizeHeight}
                onChange={(e) => setExtraWindow({ ...extra, autoResizeHeight: e.target.checked })}
              />
            }
            label={t("settings.autoResizeHeight")}
            sx={{ mb: 1.5 }}
          />

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={extra.alwaysOnTop}
                onChange={(e) => setExtraWindow({ ...extra, alwaysOnTop: e.target.checked })}
              />
            }
            label={t("settings.alwaysOnTop")}
            sx={{ mb: 1.5 }}
          />

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={extra.clickThrough}
                onChange={(e) => setExtraWindow({ ...extra, clickThrough: e.target.checked })}
              />
            }
            label={t("settings.clickThrough")}
            sx={{ mb: 1.5 }}
          />

          <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1.5 }}>
            {t("settings.extraWindowWheelHint")}
          </Typography>

          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={extra.sameForBoth}
                onChange={(e) => setExtraSameForBoth(e.target.checked)}
              />
            }
            label={t("settings.sameFont")}
            sx={{ mb: 1.5 }}
          />

          <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 1, mb: 0.5 }}>
            {t("settings.sourceFont")}
          </Typography>
          <FontSettingsEditor value={extra.source} onChange={updateExtraSource} />

          <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 2, mb: 0.5 }}>
            {t("settings.translationFont")}
          </Typography>
          <FontSettingsEditor
            value={extra.translation}
            onChange={updateExtraTranslation}
            disabled={extra.sameForBoth}
          />

          <Typography variant="subtitle2" color="text.secondary" sx={{ mt: 2, mb: 1 }}>
            {t("settings.windowAppearanceTitle")}
          </Typography>
          {renderAppearance(extra, (patch) => setExtraWindow({ ...extra, ...patch }), "extraWindow")}
        </Section>

        <Section titleKey="cache.title">
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
            {t("cache.summary", {
              n: cacheStats?.entries ?? 0,
              size: formatBytes(cacheStats?.bytes ?? 0),
            })}
          </Typography>
          <Button size="small" variant="outlined" onClick={() => setCacheOpen(true)}>
            {t("cache.manage")}
          </Button>
        </Section>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("settings.close")}</Button>
      </DialogActions>

      {/* 缓存管理：统计/搜索/新增/编辑/删除/重置（嵌套对话框，关闭时刷新概览）。 */}
      <TranslationCacheDialog
        open={cacheOpen}
        onClose={() => {
          setCacheOpen(false);
          loadCacheStats();
        }}
      />
    </Dialog>
  );
}
