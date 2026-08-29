import { memo } from "react";
import { Box, Button, CircularProgress, IconButton, Paper, Tooltip, Typography } from "@mui/material";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CopyAllIcon from "@mui/icons-material/CopyAll";
import TranslateIcon from "@mui/icons-material/Translate";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import ReplayIcon from "@mui/icons-material/Replay";
import { useTranslation } from "react-i18next";
import { fontToStyle, useDisplaySettings } from "../settings/DisplaySettingsContext";
import type { TextBlock } from "../types/translation";

interface TranslationBlockProps {
  block: TextBlock;
  showTranslation: boolean;
  onDelete: () => void;
  onTranslate: (provider: string) => void;
  onRetry: (provider: string) => void;
}

export const TranslationBlock = memo(
  function TranslationBlock({
    block,
    showTranslation,
    onDelete,
    onTranslate,
    onRetry,
  }: TranslationBlockProps) {
    const { t } = useTranslation();
  const { display } = useDisplaySettings();
  const translationFont = display.sameForBoth ? display.source : display.translation;

  const providerLabel = (provider: string) => t(`extensions.${provider}`);

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  const doneTranslations = block.translations.filter((e) => e.state === "done" && e.text);
  const translationText = doneTranslations.map((e) => e.text).join("\n");
  const copyOriginal = () => copyText(block.original);
  const copyTranslation = () => copyText(translationText);
  const copyBoth = () => copyText(`${block.original}\n\n${translationText}`);

  return (
    <Paper variant="outlined" sx={{ p: 1.5, position: "relative" }}>
      <Box sx={{ position: "absolute", top: 4, right: 4, display: "flex" }}>
        <Tooltip title={t("content.copyOriginal")}>
          <IconButton size="small" onClick={copyOriginal}>
            <ContentCopyIcon fontSize="small" />
          </IconButton>
        </Tooltip>
        <Tooltip title={t("content.copyTranslation")}>
          <span>
            <IconButton size="small" onClick={copyTranslation} disabled={translationText === ""}>
              <TranslateIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("content.copyBoth")}>
          <span>
            <IconButton size="small" onClick={copyBoth} disabled={translationText === ""}>
              <CopyAllIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={t("content.delete")}>
          <IconButton size="small" onClick={onDelete}>
            <DeleteOutlinedIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>

      {!display.hideLabels && (
        <Typography variant="caption" color="text.secondary" sx={{ userSelect: "none" }}>
          {t("content.original")}
        </Typography>
      )}
      <Typography
        variant="body1"
        sx={{ whiteSpace: "pre-wrap", mt: 0.25, pr: 7, ...fontToStyle(display.source) }}
      >
        {block.original}
      </Typography>

      {block.romanji && (
        <Typography
          variant="body2"
          sx={{
            whiteSpace: "pre-wrap",
            mt: 0.25,
            pr: 7,
            color: "text.secondary",
            ...fontToStyle(translationFont),
          }}
        >
          {block.romanji}
        </Typography>
      )}

      {showTranslation && block.translations.length > 0 && (
        <Box sx={{ mt: 1 }}>
          {!display.hideLabels && (
            <Typography variant="caption" color="text.secondary" sx={{ userSelect: "none" }}>
              {t("content.translation")}
            </Typography>
          )}

          {block.translations.map((entry) => {
            if (entry.state === "pending") {
              return (
                <Box key={entry.provider} sx={{ mt: 0.25 }}>
                  <Button size="small" onClick={() => onTranslate(entry.provider)}>
                    {t("content.translate")} · {providerLabel(entry.provider)}
                  </Button>
                </Box>
              );
            }
            if (entry.state === "loading") {
              return (
                <Box key={entry.provider} sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.25 }}>
                  <CircularProgress size={12} />
                  <Typography variant="caption" color="text.secondary">
                    {providerLabel(entry.provider)} {t("content.translating")}
                  </Typography>
                </Box>
              );
            }
            if (entry.state === "error") {
              return (
                <Box key={entry.provider} sx={{ mt: 0.25 }}>
                  <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                    {!display.hideProviderLabel && (
                      <Typography variant="caption" color="text.secondary" sx={{ userSelect: "none" }}>
                        {providerLabel(entry.provider)}
                      </Typography>
                    )}
                    <Typography variant="body2" color="error.main" sx={{ flexGrow: 1 }}>
                      {entry.error}
                    </Typography>
                    <Button
                      size="small"
                      startIcon={<ReplayIcon fontSize="small" />}
                      onClick={() => onRetry(entry.provider)}
                    >
                      {t("content.retry")}
                    </Button>
                  </Box>
                </Box>
              );
            }
            // done
            return (
              <Box key={entry.provider} sx={{ mt: 0.5 }}>
                {!display.hideProviderLabel && (
                  <Typography variant="caption" color="text.secondary" sx={{ userSelect: "none" }}>
                    {providerLabel(entry.provider)}
                    {entry.fromCache ? ` · ${t("content.fromCache")}` : ""}
                  </Typography>
                )}
                <Typography
                  variant="body2"
                  sx={{ whiteSpace: "pre-wrap", mt: 0.1, pr: 7, ...fontToStyle(translationFont) }}
                >
                  {entry.text}
                </Typography>
              </Box>
            );
          })}
        </Box>
      )}
    </Paper>
  );
  },
  // 仅当文本块内容或“是否显示译文”变化时才重渲染；
  // 历史块的 block 引用在 setBlocks 中保持不变，从而跳过无意义的重渲染。
  // 显示设置/i18n 变化会通过各自的 Context 直接触发重渲染，不受此比较器影响。
  (prev, next) => prev.block === next.block && prev.showTranslation === next.showTranslation,
);
