import { Fragment, type ReactNode } from "react";
import { Box, Typography } from "@mui/material";

/**
 * 极简 Markdown 渲染（只覆盖 GitHub Release 正文里实际会出现的语法）。
 *
 * 为什么不用 react-markdown：为一屏更新日志再引入一条解析器依赖（含 remark 全家桶）
 * 不划算，而且这个项目刚做过一轮依赖安全清理。这里只处理：
 * 标题、无序/有序列表、代码块、段落，以及行内的 **粗体**、`代码`、[文本](链接)。
 */

type Block =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "bullet"; text: string }
  | { kind: "ordered"; text: string }
  | { kind: "code"; lines: string[] };

function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = [];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  let paragraph: string[] = [];
  let inCode = false;
  let code: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length > 0) {
      blocks.push({ kind: "paragraph", text: paragraph.join(" ") });
      paragraph = [];
    }
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        blocks.push({ kind: "code", lines: code });
        code = [];
        inCode = false;
      } else {
        flushParagraph();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(rawLine);
      continue;
    }
    const trimmed = line.trim();
    // 发布说明里常见 HTML 注释 / 徽章图片，直接丢掉。
    if (trimmed === "" || trimmed.startsWith("<!--") || trimmed.startsWith("![")) {
      flushParagraph();
      continue;
    }
    const heading = /^#{1,6}\s+(.*)$/.exec(trimmed);
    if (heading) {
      flushParagraph();
      blocks.push({ kind: "heading", text: heading[1] });
      continue;
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(trimmed);
    if (bullet) {
      flushParagraph();
      blocks.push({ kind: "bullet", text: bullet[1] });
      continue;
    }
    const ordered = /^\d+[.)]\s+(.*)$/.exec(trimmed);
    if (ordered) {
      flushParagraph();
      blocks.push({ kind: "ordered", text: ordered[1] });
      continue;
    }
    // 引用块按普通段落处理。
    paragraph.push(trimmed.replace(/^>\s?/, ""));
  }
  if (inCode) {
    blocks.push({ kind: "code", lines: code });
  }
  flushParagraph();
  return blocks;
}

/** 行内格式：**粗体** / `代码` / [文本](链接)。 */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;
  const parts = text.split(pattern).filter((part) => part !== "");
  return parts.map((part, index) => {
    const key = `${keyPrefix}-${index}`;
    if (part.startsWith("**") && part.endsWith("**")) {
      return (
        <Box component="span" key={key} sx={{ fontWeight: 600 }}>
          {part.slice(2, -2)}
        </Box>
      );
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return (
        <Box
          component="code"
          key={key}
          sx={{ fontFamily: "Consolas, monospace", fontSize: "0.95em", opacity: 0.9 }}
        >
          {part.slice(1, -1)}
        </Box>
      );
    }
    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      // 不在正文里做可点击链接：内容来自外部（GitHub），统一让用户走"在 GitHub 上查看"。
      return <Fragment key={key}>{link[1]}</Fragment>;
    }
    return <Fragment key={key}>{part}</Fragment>;
  });
}

export function ReleaseNotesBody({ markdown }: { markdown: string }) {
  const blocks = parseBlocks(markdown);
  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
      {blocks.map((block, index) => {
        const key = `block-${index}`;
        switch (block.kind) {
          case "heading":
            return (
              <Typography
                key={key}
                variant="subtitle2"
                sx={{ fontWeight: 600, mt: index === 0 ? 0 : 0.5 }}
              >
                {renderInline(block.text, key)}
              </Typography>
            );
          case "bullet":
            return (
              <Box key={key} sx={{ display: "flex", gap: 0.75, alignItems: "baseline" }}>
                <Box component="span" sx={{ opacity: 0.6 }}>
                  •
                </Box>
                <Typography variant="caption" component="span" sx={{ flex: 1 }}>
                  {renderInline(block.text, key)}
                </Typography>
              </Box>
            );
          case "ordered":
            return (
              <Typography key={key} variant="caption" component="div" sx={{ pl: 1 }}>
                {renderInline(block.text, key)}
              </Typography>
            );
          case "code":
            return (
              <Box
                key={key}
                component="pre"
                sx={{
                  m: 0,
                  p: 0.75,
                  borderRadius: 1,
                  bgcolor: "action.selected",
                  fontSize: 11.5,
                  lineHeight: 1.45,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {block.lines.join("\n")}
              </Box>
            );
          default:
            return (
              <Typography key={key} variant="caption" component="p" sx={{ m: 0 }}>
                {renderInline(block.text, key)}
              </Typography>
            );
        }
      })}
    </Box>
  );
}
