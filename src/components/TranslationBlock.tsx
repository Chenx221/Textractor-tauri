import { memo, useEffect, useRef, useState, type MouseEvent } from "react";
import { Box, Button, CircularProgress, IconButton, Paper, Tooltip, Typography } from "@mui/material";
import { keyframes } from "@emotion/react";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import CopyAllIcon from "@mui/icons-material/CopyAll";
import TranslateIcon from "@mui/icons-material/Translate";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import ReplayIcon from "@mui/icons-material/Replay";
import { useTranslation } from "react-i18next";
import { fontToStyle, useDisplaySettings } from "../settings/DisplaySettingsContext";
import type { TextBlock } from "../types/translation";

/** 指针进入右上角这片区域（距右边/上边多少 px 以内）时，才淡入块操作按钮。 */
const ACTION_ZONE_WIDTH = 176;
const ACTION_ZONE_HEIGHT = 48;

/** 删除单块时的淡出 + 高度收拢动画时长（毫秒）。 */
const LEAVE_ANIMATION_MS = 200;

/**
 * 删除动画：整块淡出并收拢高度，让后面的块平滑上移，而不是移除瞬间“跳”一下。
 * 这里只声明终态，起始高度由行内 style 指定为测量到的实际高度。
 */
const blockLeaveKeyframes = keyframes`
  to {
    opacity: 0;
    height: 0;
    padding-top: 0;
    padding-bottom: 0;
    border-width: 0;
  }
`;

interface TranslationBlockProps {
  block: TextBlock;
  showTranslation: boolean;
  onDelete: () => void;
  onTranslate: (provider: string) => void;
  onRetry: (provider: string) => void;
  /** 对已完成的译文重新翻译（绕过缓存）。 */
  onRetranslate: (provider: string) => void;
}

export const TranslationBlock = memo(
  function TranslationBlock({
    block,
    showTranslation,
    onDelete,
    onTranslate,
    onRetry,
    onRetranslate,
  }: TranslationBlockProps) {
    const { t } = useTranslation();
  const { display } = useDisplaySettings();
  const translationFont = display.sameForBoth ? display.source : display.translation;

  const rootRef = useRef<HTMLDivElement>(null);
  // 指针靠近右上角时才显示操作按钮，平时文本块保持干净。
  const [actionsVisible, setActionsVisible] = useState(false);
  // 删除：先播放淡出动画再从列表移除；collapseFrom 为动画起始高度。
  const [leaving, setLeaving] = useState(false);
  const [collapseFrom, setCollapseFrom] = useState<number | null>(null);
  const deleteTimerRef = useRef<number | undefined>(undefined);

  // 动画结束前块若已被外部卸载（例如整线程清空），清理定时器。
  useEffect(() => () => window.clearTimeout(deleteTimerRef.current), []);

  const providerLabel = (provider: string) => t(`extensions.${provider}`);

  const copyText = (text: string) => {
    void navigator.clipboard.writeText(text).catch(() => {});
  };

  const doneTranslations = block.translations.filter((e) => e.state === "done" && e.text);
  const translationText = doneTranslations.map((e) => e.text).join("\n");
  const copyOriginal = () => copyText(block.original);
  const copyTranslation = () => copyText(translationText);
  const copyBoth = () => copyText(`${block.original}\n\n${translationText}`);

  // 只有指针贴近右上角（按钮所在区域）时才显示按钮组；
  // 用鼠标坐标判断而非叠一层热区，避免遮挡正文的文本选择。
  const handleMouseMove = (e: MouseEvent<HTMLElement>) => {
    if (leaving) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const nearRight = rect.right - e.clientX <= ACTION_ZONE_WIDTH;
    const nearTop = e.clientY - rect.top <= ACTION_ZONE_HEIGHT;
    setActionsVisible(nearRight && nearTop);
  };

  const handleMouseLeave = () => setActionsVisible(false);

  const handleDelete = () => {
    if (leaving) return;
    setCollapseFrom(rootRef.current?.offsetHeight ?? null);
    setLeaving(true);
    setActionsVisible(false);
    // 动画播完再真正移除（+20ms 缓冲，避免末帧被截断）。
    deleteTimerRef.current = window.setTimeout(onDelete, LEAVE_ANIMATION_MS + 20);
  };

  return (
    <Paper
      ref={rootRef}
      variant="outlined"
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      style={collapseFrom !== null ? { height: collapseFrom } : undefined}
      sx={{
        p: 1.5,
        position: "relative",
        ...(leaving && {
          overflow: "hidden",
          pointerEvents: "none",
          animation: `${blockLeaveKeyframes} ${LEAVE_ANIMATION_MS}ms ease forwards`,
        }),
      }}
    >
      <Box
        sx={{
          position: "absolute",
          top: 4,
          right: 4,
          display: "flex",
          opacity: actionsVisible ? 1 : 0,
          transition: "opacity 150ms ease",
          pointerEvents: actionsVisible ? "auto" : "none",
          // 触摸设备没有 hover，直接常显，否则无法复制/删除。
          "@media (hover: none)": { opacity: 1, pointerEvents: "auto" },
        }}
      >
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
          <IconButton size="small" aria-label={t("content.delete")} onClick={handleDelete}>
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
                <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                  {!display.hideProviderLabel && (
                    <Typography variant="caption" color="text.secondary" sx={{ userSelect: "none" }}>
                      {providerLabel(entry.provider)}
                      {entry.fromCache ? ` · ${t("content.fromCache")}` : ""}
                    </Typography>
                  )}
                  <Box sx={{ flexGrow: 1 }} />
                  <Tooltip title={t("content.retranslate")}>
                    <IconButton
                      size="small"
                      aria-label={t("content.retranslate")}
                      onClick={() => onRetranslate(entry.provider)}
                    >
                      <ReplayIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </Box>
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
