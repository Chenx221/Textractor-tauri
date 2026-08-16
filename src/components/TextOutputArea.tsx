import { useEffect, useRef, useState } from "react";
import { Box, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { useExtensions } from "../extensions/ExtensionsContext";
import { useHost } from "../host/HostContext";
import { TranslationBlock } from "./TranslationBlock";
import type { TextBlock } from "../types/translation";

interface TextOutputAreaProps {
  blocks: TextBlock[];
  onDelete: (id: string) => void;
  onCopy: (block: TextBlock) => void;
}

export function TextOutputArea({ blocks, onDelete, onCopy }: TextOutputAreaProps) {
  const { t } = useTranslation();
  const { hasEnabledTranslationProvider } = useExtensions();
  const { translateBlock, retryBlock } = useHost();
  const containerRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const handleScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    setAutoScroll(atBottom);
  };

  useEffect(() => {
    if (autoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [blocks, autoScroll]);

  return (
    <Box
      ref={containerRef}
      onScroll={handleScroll}
      sx={{
        flex: 1,
        minHeight: 0,
        overflowY: "auto",
        display: "flex",
        flexDirection: "column",
        gap: 1,
      }}
    >
      {!hasEnabledTranslationProvider && (
        <Typography variant="caption" color="text.secondary">
          {t("content.noProvider")}
        </Typography>
      )}
      {blocks.map((block) => (
        <TranslationBlock
          key={block.id}
          block={block}
          showTranslation={hasEnabledTranslationProvider}
          onDelete={() => onDelete(block.id)}
          onCopy={() => onCopy(block)}
          onTranslate={() => translateBlock(block.id)}
          onRetry={(provider) => retryBlock(block.id, provider)}
        />
      ))}
      {blocks.length === 0 && (
        <Typography variant="body2" color="text.secondary">
          {t("content.noOutput")}
        </Typography>
      )}
    </Box>
  );
}
