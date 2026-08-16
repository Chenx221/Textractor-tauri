import { useState } from "react";
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
  IconButton,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
} from "@mui/material";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import FolderOpenOutlinedIcon from "@mui/icons-material/FolderOpenOutlined";
import { useTranslation } from "react-i18next";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useExtensions } from "../extensions/ExtensionsContext";
import { useConfig } from "../settings/ConfigContext";
import { TOOL_DEFS, TRANSLATOR_DEFS } from "../types/extensions";
import type { FieldDef } from "../types/extensions";

interface ExtensionsDialogProps {
  open: boolean;
  onClose: () => void;
}

// AI 类翻译服务的语言可以自由填写，不受固定列表限制。
const AI_PROVIDERS = new Set(["openai", "claude", "deepseek", "gemini"]);

export function ExtensionsDialog({ open, onClose }: ExtensionsDialogProps) {
  const { t } = useTranslation();
  const { extensions, updateExtension, moveExtension, addExtension, removeExtension } =
    useExtensions();
  const { config, setWebSocket } = useConfig();
  const ws = config.websocket;
  const [addTranslator, setAddTranslator] = useState("");
  const [addTool, setAddTool] = useState("");

  const translators = extensions.filter((ext) => ext.kind === "translation");
  const tools = extensions.filter((ext) => ext.kind === "tool");

  const availableTranslators = TRANSLATOR_DEFS.filter(
    (def) => !translators.some((ext) => ext.kind === "translation" && ext.provider === def.id),
  );
  const availableTools = TOOL_DEFS.filter(
    (def) => !tools.some((ext) => ext.kind === "tool" && ext.tool === def.id),
  );

  const pickFile = async (extId: string, settings: Record<string, string>, fieldKey: string) => {
    try {
      const selected = await openDialog({ multiple: false });
      if (typeof selected === "string") {
        updateExtension(extId, { settings: { ...settings, [fieldKey]: selected } });
      }
    } catch {
      // 用户取消或浏览器环境。
    }
  };

  const renderField = (
    field: FieldDef,
    settings: Record<string, string>,
    extId: string,
  ) => {
    const value = settings[field.key] ?? "";
    // 推理强度仅在开启思考模式时显示。
    if (field.key === "reasoningEffort" && settings.enableThinking !== "true") {
      return null;
    }
    if (field.type === "checkbox") {
      return (
        <FormControlLabel
          key={field.key}
          sx={{ mt: 0.5 }}
          control={
            <Switch
              size="small"
              checked={value === "true"}
              onChange={(e) =>
                updateExtension(extId, {
                  settings: { ...settings, [field.key]: e.target.checked ? "true" : "false" },
                })
              }
            />
          }
          label={t(field.labelKey)}
        />
      );
    }
    if (field.type === "select") {
      return (
        <FormControl key={field.key} size="small" fullWidth margin="dense">
          <InputLabel>{t(field.labelKey)}</InputLabel>
          <Select
            value={value}
            label={t(field.labelKey)}
            onChange={(e) =>
              updateExtension(extId, { settings: { ...settings, [field.key]: e.target.value } })
            }
          >
            {(field.options ?? []).map((option) => (
              <MenuItem key={option} value={option}>
                {option}
              </MenuItem>
            ))}
          </Select>
        </FormControl>
      );
    }
    if (field.type === "file") {
      return (
        <Box key={field.key} sx={{ display: "flex", gap: 1, alignItems: "center", mt: 0.5 }}>
          <TextField
            label={t(field.labelKey)}
            value={value}
            size="small"
            fullWidth
            helperText={field.helpKey ? t(field.helpKey) : undefined}
            onChange={(e) =>
              updateExtension(extId, { settings: { ...settings, [field.key]: e.target.value } })
            }
          />
          <IconButton size="small" onClick={() => void pickFile(extId, settings, field.key)}>
            <FolderOpenOutlinedIcon fontSize="small" />
          </IconButton>
        </Box>
      );
    }
    return (
      <TextField
        key={field.key}
        label={t(field.labelKey)}
        placeholder={field.placeholder}
        helperText={field.helpKey ? t(field.helpKey) : undefined}
        value={value}
        onChange={(e) =>
          updateExtension(extId, { settings: { ...settings, [field.key]: e.target.value } })
        }
        size="small"
        fullWidth
        margin="dense"
        type={field.type === "password" ? "password" : field.type === "number" ? "number" : "text"}
      />
    );
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{t("extensions.title")}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          {t("extensions.translationCategory")}
        </Typography>

        {translators.map((ext, index) => {
          if (ext.kind !== "translation") return null;
          const def = TRANSLATOR_DEFS.find((d) => d.id === ext.provider);
          const targetLanguages = def?.targetLanguages ?? def?.languages ?? [];
          const isAi = def ? AI_PROVIDERS.has(def.id) : false;
          return (
            <Box key={ext.id} sx={{ mb: 2, p: 1, border: 1, borderColor: "divider", borderRadius: 1 }}>
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                  <IconButton size="small" disabled={index === 0} onClick={() => moveExtension(ext.id, -1)}>
                    <KeyboardArrowUpIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    disabled={index === translators.length - 1}
                    onClick={() => moveExtension(ext.id, 1)}
                  >
                    <KeyboardArrowDownIcon fontSize="small" />
                  </IconButton>
                  <Typography variant="body1">{t(ext.nameKey)}</Typography>
                </Box>
                <Box sx={{ display: "flex", alignItems: "center" }}>
                  <Switch
                    checked={ext.enabled}
                    onChange={(e) => updateExtension(ext.id, { enabled: e.target.checked })}
                  />
                  <IconButton size="small" onClick={() => removeExtension(ext.id)}>
                    <DeleteOutlinedIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>

              <Box sx={{ display: "flex", gap: 1 }}>
                {isAi ? (
                  <>
                    <TextField
                      size="small"
                      fullWidth
                      margin="dense"
                      label={t("extensions.sourceLanguage")}
                      value={ext.sourceLanguage}
                      onChange={(e) => updateExtension(ext.id, { sourceLanguage: e.target.value })}
                    />
                    <TextField
                      size="small"
                      fullWidth
                      margin="dense"
                      label={t("extensions.targetLanguage")}
                      value={ext.targetLanguage}
                      onChange={(e) => updateExtension(ext.id, { targetLanguage: e.target.value })}
                    />
                  </>
                ) : (
                  <>
                    <FormControl size="small" fullWidth margin="dense">
                      <InputLabel>{t("extensions.sourceLanguage")}</InputLabel>
                      <Select
                        value={ext.sourceLanguage}
                        label={t("extensions.sourceLanguage")}
                        onChange={(e) => updateExtension(ext.id, { sourceLanguage: e.target.value })}
                      >
                        {(def?.languages ?? []).map((lang) => (
                          <MenuItem key={lang.value} value={lang.value}>
                            {lang.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                    <FormControl size="small" fullWidth margin="dense">
                      <InputLabel>{t("extensions.targetLanguage")}</InputLabel>
                      <Select
                        value={ext.targetLanguage}
                        label={t("extensions.targetLanguage")}
                        onChange={(e) => updateExtension(ext.id, { targetLanguage: e.target.value })}
                      >
                        {targetLanguages.map((lang) => (
                          <MenuItem key={lang.value} value={lang.value}>
                            {lang.label}
                          </MenuItem>
                        ))}
                      </Select>
                    </FormControl>
                  </>
                )}
              </Box>

              {(def?.fields ?? []).map((field) => renderField(field, ext.settings, ext.id))}
            </Box>
          );
        })}

        {availableTranslators.length > 0 && (
          <Stack direction="row" spacing={1} sx={{ mb: 2 }}>
            <FormControl size="small" fullWidth>
              <InputLabel>{t("extensions.addTranslator")}</InputLabel>
              <Select
                value={addTranslator}
                label={t("extensions.addTranslator")}
                onChange={(e) => setAddTranslator(e.target.value)}
              >
                {availableTranslators.map((def) => (
                  <MenuItem key={def.id} value={def.id}>
                    {t(def.nameKey)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button
              variant="outlined"
              disabled={!addTranslator}
              onClick={() => {
                addExtension("translation", addTranslator);
                setAddTranslator("");
              }}
            >
              {t("extensions.add")}
            </Button>
          </Stack>
        )}

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          {t("extensions.toolCategory")}
        </Typography>

        {tools.map((ext, index) => {
          if (ext.kind !== "tool") return null;
          const def = TOOL_DEFS.find((d) => d.id === ext.tool);
          return (
            <Box key={ext.id} sx={{ mb: 1.5, p: 1, border: 1, borderColor: "divider", borderRadius: 1 }}>
              <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                  <IconButton size="small" disabled={index === 0} onClick={() => moveExtension(ext.id, -1)}>
                    <KeyboardArrowUpIcon fontSize="small" />
                  </IconButton>
                  <IconButton
                    size="small"
                    disabled={index === tools.length - 1}
                    onClick={() => moveExtension(ext.id, 1)}
                  >
                    <KeyboardArrowDownIcon fontSize="small" />
                  </IconButton>
                  <Typography variant="body1">{t(ext.nameKey)}</Typography>
                </Box>
                <Box sx={{ display: "flex", alignItems: "center" }}>
                  <Switch
                    checked={ext.enabled}
                    onChange={(e) => updateExtension(ext.id, { enabled: e.target.checked })}
                  />
                  <IconButton size="small" onClick={() => removeExtension(ext.id)}>
                    <DeleteOutlinedIcon fontSize="small" />
                  </IconButton>
                </Box>
              </Box>

              {(def?.fields ?? []).map((field) => renderField(field, ext.settings, ext.id))}
            </Box>
          );
        })}

        {availableTools.length > 0 && (
          <Stack direction="row" spacing={1}>
            <FormControl size="small" fullWidth>
              <InputLabel>{t("extensions.addTool")}</InputLabel>
              <Select value={addTool} label={t("extensions.addTool")} onChange={(e) => setAddTool(e.target.value)}>
                {availableTools.map((def) => (
                  <MenuItem key={def.id} value={def.id}>
                    {t(def.nameKey)}
                  </MenuItem>
                ))}
              </Select>
            </FormControl>
            <Button
              variant="outlined"
              disabled={!addTool}
              onClick={() => {
                addExtension("tool", addTool);
                setAddTool("");
              }}
            >
              {t("extensions.add")}
            </Button>
          </Stack>
        )}

        <Divider sx={{ my: 2 }} />

        <Typography variant="subtitle2" color="text.secondary" sx={{ mb: 1 }}>
          {t("extensions.webSocketTitle")}
        </Typography>

        <Box sx={{ mb: 2, p: 1, border: 1, borderColor: "divider", borderRadius: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Typography variant="body1">{t("extensions.wsServer")}</Typography>
            <Switch
              checked={ws.serverEnabled}
              onChange={(e) => setWebSocket({ ...ws, serverEnabled: e.target.checked })}
            />
          </Box>
          <TextField
            size="small"
            fullWidth
            margin="dense"
            type="number"
            label={t("extensions.wsServerPort")}
            value={ws.serverPort}
            disabled={!ws.serverEnabled}
            onChange={(e) => {
              const n = Number(e.target.value);
              if (Number.isFinite(n)) setWebSocket({ ...ws, serverPort: Math.max(0, Math.min(65535, n)) });
            }}
          />
          <FormControlLabel
            sx={{ mt: 0.5 }}
            control={
              <Switch
                size="small"
                checked={ws.serverIncludeClipboard}
                onChange={(e) => setWebSocket({ ...ws, serverIncludeClipboard: e.target.checked })}
              />
            }
            label={t("extensions.wsServerIncludeClipboard")}
          />
        </Box>

        <Box sx={{ p: 1, border: 1, borderColor: "divider", borderRadius: 1 }}>
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Typography variant="body1">{t("extensions.wsClient")}</Typography>
            <Switch
              checked={ws.clientEnabled}
              onChange={(e) => setWebSocket({ ...ws, clientEnabled: e.target.checked })}
            />
          </Box>
          <TextField
            size="small"
            fullWidth
            margin="dense"
            label={t("extensions.wsClientUrl")}
            value={ws.clientUrl}
            disabled={!ws.clientEnabled}
            onChange={(e) => setWebSocket({ ...ws, clientUrl: e.target.value })}
          />
        </Box>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("extensions.close")}</Button>
      </DialogActions>
    </Dialog>
  );
}
