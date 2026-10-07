import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import AddIcon from "@mui/icons-material/Add";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DeleteForeverOutlinedIcon from "@mui/icons-material/DeleteForeverOutlined";
import DeleteOutlinedIcon from "@mui/icons-material/DeleteOutlined";
import EditOutlinedIcon from "@mui/icons-material/EditOutlined";
import RefreshIcon from "@mui/icons-material/Refresh";
import SearchIcon from "@mui/icons-material/Search";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { formatBytes } from "../utils/format";

interface CacheStats {
  entries: number;
  bytes: number;
  services: { service: string; count: number }[];
}

interface CacheRow {
  id: number;
  service: string;
  source_lang: string;
  target_lang: string;
  original_text: string;
  translated_text: string;
}

interface CachePage {
  rows: CacheRow[];
  total: number;
}

/** 编辑/新增中的条目；id === null 表示新增。 */
interface Draft {
  id: number | null;
  service: string;
  source: string;
  target: string;
  original: string;
  translated: string;
}

interface TranslationCacheDialogProps {
  open: boolean;
  onClose: () => void;
}

const PAGE_SIZE = 20;

/**
 * 已知翻译服务 id（与 Rust 端 `call_provider` 的分支一致），
 * 仅用于"新增条目"时的下拉选择；已存在的其它 service 值也会出现在选项里。
 */
const KNOWN_SERVICES = [
  "google",
  "google2",
  "deepl",
  "openai",
  "baidu",
  "aliyun",
  "bing",
  "bing2",
  "claude",
  "deepseek",
  "gemini",
  "lingocloud",
  "tencent",
  "tencenttransmart",
];

function isTauri(): boolean {
  return "__TAURI_INTERNALS__" in window;
}

export function TranslationCacheDialog({ open, onClose }: TranslationCacheDialogProps) {
  const { t, i18n } = useTranslation();
  const [stats, setStats] = useState<CacheStats | null>(null);
  const [rows, setRows] = useState<CacheRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(0);
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  /** 按翻译服务过滤（空串 = 全部服务），与文本搜索叠加生效。 */
  const [serviceFilter, setServiceFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  /** 需要二次确认的破坏性操作。 */
  const [confirm, setConfirm] = useState<"all" | "filtered" | null>(null);

  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  const load = useCallback(async () => {
    if (!isTauri()) return;
    setLoading(true);
    try {
      const [nextStats, nextPage] = await Promise.all([
        invoke<CacheStats>("cache_stats"),
        invoke<CachePage>("cache_list", {
          query,
          service: serviceFilter === "" ? null : serviceFilter,
          offset: page * PAGE_SIZE,
          limit: PAGE_SIZE,
        }),
      ]);
      setStats(nextStats);
      setRows(nextPage.rows);
      setTotal(nextPage.total);
      // 删除/清空后当前页可能已越界，回退到最后一页。
      const lastPage = Math.max(0, Math.ceil(nextPage.total / PAGE_SIZE) - 1);
      if (page > lastPage) setPage(lastPage);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [page, query, serviceFilter]);

  useEffect(() => {
    if (!open) return;
    void load();
  }, [open, load]);

  // 打开时重置搜索与编辑状态（但保留上次翻到的页码会让人困惑，故一并重置）。
  useEffect(() => {
    if (open) return;
    setQueryInput("");
    setQuery("");
    setServiceFilter("");
    setPage(0);
    setDraft(null);
    setError("");
    setConfirm(null);
  }, [open]);

  // 搜索输入防抖：每次按键都查库没必要。
  useEffect(() => {
    const timer = window.setTimeout(() => {
      setQuery(queryInput.trim());
      setPage(0);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [queryInput]);

  const providerLabel = (service: string) => {
    const key = `extensions.${service}`;
    return i18n.exists(key) ? t(key) : service;
  };

  const serviceOptions = useMemo(() => {
    const set = new Set(KNOWN_SERVICES);
    if (draft?.service) set.add(draft.service);
    return [...set];
  }, [draft?.service]);

  /** 服务过滤下拉的选项：缓存里实际存在的服务 + 当前选中的（即使它已被删空）。 */
  const serviceFilterOptions = useMemo(() => {
    const list = (stats?.services ?? []).map((item) => item.service);
    if (serviceFilter !== "" && !list.includes(serviceFilter)) list.push(serviceFilter);
    return list;
  }, [stats, serviceFilter]);

  const hasFilter = query !== "" || serviceFilter !== "";

  const startAdd = () => {
    setError("");
    setDraft({
      id: null,
      // 默认沿用当前的服务过滤，避免新增的条目一保存就被过滤掉。
      service: serviceFilter !== "" ? serviceFilter : KNOWN_SERVICES[0],
      source: "ja",
      target: "zh-CN",
      original: "",
      translated: "",
    });
  };

  const startEdit = (row: CacheRow) => {
    setError("");
    setDraft({
      id: row.id,
      service: row.service,
      source: row.source_lang,
      target: row.target_lang,
      original: row.original_text,
      translated: row.translated_text,
    });
  };

  const saveDraft = async () => {
    if (!draft) return;
    if (
      draft.service.trim() === "" ||
      draft.source.trim() === "" ||
      draft.target.trim() === "" ||
      draft.original === "" ||
      draft.translated === ""
    ) {
      setError(t("cache.requireAll"));
      return;
    }
    setError("");
    try {
      if (draft.id === null) {
        await invoke("cache_insert", {
          service: draft.service.trim(),
          source: draft.source.trim(),
          target: draft.target.trim(),
          original: draft.original,
          translated: draft.translated,
        });
      } else {
        await invoke("cache_update", { id: draft.id, translated: draft.translated });
      }
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const removeRow = async (id: number) => {
    try {
      await invoke("cache_delete", { ids: [id] });
      if (draft?.id === id) setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const runConfirm = async () => {
    const kind = confirm;
    setConfirm(null);
    try {
      // 清空全部不受筛选影响；删除筛选结果时带上当前的文本/服务条件。
      await invoke("cache_clear", {
        query: kind === "filtered" ? query : null,
        service: kind === "filtered" && serviceFilter !== "" ? serviceFilter : null,
      });
      setDraft(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  /** 条目原文/译文的单元格：多行显示但限定高度，避免超长文本撑开表格。 */
  const textCellSx = {
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
    maxHeight: 72,
    overflow: "hidden",
  } as const;

  const renderEditor = (value: Draft, isNew: boolean) => (
    <>
      <TableCell sx={{ verticalAlign: "top" }}>
        <Select
          size="small"
          fullWidth
          value={value.service}
          disabled={!isNew}
          onChange={(e) => setDraft({ ...value, service: e.target.value })}
        >
          {serviceOptions.map((service) => (
            <MenuItem key={service} value={service}>
              {providerLabel(service)}
            </MenuItem>
          ))}
        </Select>
        <Box sx={{ display: "flex", gap: 0.5, mt: 0.5 }}>
          <TextField
            size="small"
            label={t("cache.sourceLang")}
            value={value.source}
            disabled={!isNew}
            onChange={(e) => setDraft({ ...value, source: e.target.value })}
          />
          <TextField
            size="small"
            label={t("cache.targetLang")}
            value={value.target}
            disabled={!isNew}
            onChange={(e) => setDraft({ ...value, target: e.target.value })}
          />
        </Box>
      </TableCell>
      <TableCell sx={{ verticalAlign: "top" }}>
        <TextField
          size="small"
          fullWidth
          multiline
          maxRows={6}
          placeholder={t("cache.original")}
          value={value.original}
          // 原文属于缓存主键的一部分，不允许就地修改（改了请删除后重新添加）。
          disabled={!isNew}
          onChange={(e) => setDraft({ ...value, original: e.target.value })}
        />
      </TableCell>
      <TableCell sx={{ verticalAlign: "top" }}>
        <TextField
          size="small"
          fullWidth
          multiline
          maxRows={6}
          placeholder={t("cache.translation")}
          value={value.translated}
          onChange={(e) => setDraft({ ...value, translated: e.target.value })}
        />
      </TableCell>
      <TableCell align="right" sx={{ verticalAlign: "top" }}>
        <Button size="small" variant="contained" onClick={() => void saveDraft()}>
          {t("cache.save")}
        </Button>
        <Button size="small" sx={{ mt: 0.5 }} onClick={() => setDraft(null)}>
          {t("attach.cancel")}
        </Button>
      </TableCell>
    </>
  );

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="md">
      <DialogTitle>{t("cache.title")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 1.5 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, flexWrap: "wrap" }}>
          <Chip size="small" color="primary" variant="outlined" label={t("cache.entries", { n: total })} />
          <Chip
            size="small"
            variant="outlined"
            label={`${t("cache.size")}: ${formatBytes(stats?.bytes ?? 0)}`}
          />
          {stats?.services.map((item) => (
            <Chip
              key={item.service}
              size="small"
              variant="outlined"
              label={`${providerLabel(item.service)} ${item.count}`}
            />
          ))}
        </Box>

        <Box sx={{ display: "flex", gap: 1 }}>
          <Select
            size="small"
            value={serviceFilter}
            onChange={(e) => {
              setServiceFilter(e.target.value);
              setPage(0);
            }}
            renderValue={(value) =>
              value === "" ? (
                <Box component="span" sx={{ color: "text.secondary" }}>
                  {t("cache.allServices")}
                </Box>
              ) : (
                providerLabel(String(value))
              )
            }
            sx={{ minWidth: 170, flexShrink: 0 }}
          >
            <MenuItem value="">{t("cache.allServices")}</MenuItem>
            {serviceFilterOptions.map((service) => (
              <MenuItem key={service} value={service}>
                {providerLabel(service)}
              </MenuItem>
            ))}
          </Select>
          <TextField
            size="small"
            fullWidth
            value={queryInput}
            placeholder={t("cache.search")}
            onChange={(e) => setQueryInput(e.target.value)}
            slotProps={{
              input: {
                startAdornment: <SearchIcon fontSize="small" sx={{ mr: 1, opacity: 0.6 }} />,
              },
            }}
          />
          <Button
            variant="outlined"
            startIcon={<AddIcon />}
            sx={{ flexShrink: 0 }}
            onClick={startAdd}
          >
            {t("cache.add")}
          </Button>
        </Box>

        {error !== "" && (
          <Alert severity="error" onClose={() => setError("")}>
            {error}
          </Alert>
        )}

        <TableContainer sx={{ maxHeight: 420, border: 1, borderColor: "divider", borderRadius: 1 }}>
          <Table size="small" stickyHeader sx={{ tableLayout: "fixed" }}>
            <TableHead>
              <TableRow>
                <TableCell sx={{ width: 150 }}>{t("cache.service")}</TableCell>
                <TableCell>{t("cache.original")}</TableCell>
                <TableCell>{t("cache.translation")}</TableCell>
                <TableCell align="right" sx={{ width: 96 }} />
              </TableRow>
            </TableHead>
            <TableBody>
              {draft !== null && draft.id === null && <TableRow>{renderEditor(draft, true)}</TableRow>}

              {rows.map((row) => {
                if (draft !== null && draft.id === row.id) {
                  return <TableRow key={row.id}>{renderEditor(draft, false)}</TableRow>;
                }
                return (
                  <TableRow key={row.id} hover>
                    <TableCell>
                      <Typography variant="body2" noWrap title={row.service}>
                        {providerLabel(row.service)}
                      </Typography>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {row.source_lang} → {row.target_lang}
                      </Typography>
                    </TableCell>
                    <TableCell sx={textCellSx}>{row.original_text}</TableCell>
                    <TableCell sx={textCellSx}>{row.translated_text}</TableCell>
                    <TableCell align="right">
                      <Tooltip title={t("cache.edit")}>
                        <IconButton size="small" onClick={() => startEdit(row)}>
                          <EditOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                      <Tooltip title={t("content.delete")}>
                        <IconButton size="small" onClick={() => void removeRow(row.id)}>
                          <DeleteOutlinedIcon fontSize="small" />
                        </IconButton>
                      </Tooltip>
                    </TableCell>
                  </TableRow>
                );
              })}

              {rows.length === 0 && draft === null && !loading && (
                <TableRow>
                  <TableCell colSpan={4} align="center" sx={{ color: "text.secondary" }}>
                    {hasFilter ? t("cache.noMatch") : t("cache.empty")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>

        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <IconButton size="small" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>
            <ChevronLeftIcon />
          </IconButton>
          <Typography variant="caption" color="text.secondary">
            {t("cache.pageInfo", { page: page + 1, pages })}
          </Typography>
          <IconButton
            size="small"
            disabled={page >= pages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            <ChevronRightIcon />
          </IconButton>
          {loading && <CircularProgress size={14} />}
          <Box sx={{ flexGrow: 1 }} />
          {hasFilter && (
            <Button
              size="small"
              color="warning"
              startIcon={<DeleteOutlinedIcon />}
              onClick={() => setConfirm("filtered")}
            >
              {t("cache.deleteFiltered")}
            </Button>
          )}
          <Button
            size="small"
            color="error"
            startIcon={<DeleteForeverOutlinedIcon />}
            disabled={total === 0}
            onClick={() => setConfirm("all")}
          >
            {t("cache.clearAll")}
          </Button>
        </Box>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<RefreshIcon />} onClick={() => void load()}>
          {t("cache.refresh")}
        </Button>
        <Button variant="contained" onClick={onClose}>
          {t("settings.close")}
        </Button>
      </DialogActions>

      {/* 破坏性操作二次确认（清空全部 / 删除筛选结果）。 */}
      <Dialog open={confirm !== null} onClose={() => setConfirm(null)} maxWidth="xs">
        <DialogTitle>{t("cache.confirmTitle")}</DialogTitle>
        <DialogContent>
          <Typography variant="body2">
            {confirm === "all"
              ? t("cache.confirmClearAll", { n: total })
              : t("cache.confirmDeleteFiltered", { n: total })}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setConfirm(null)}>{t("attach.cancel")}</Button>
          <Button color="error" variant="contained" onClick={() => void runConfirm()}>
            {t("content.delete")}
          </Button>
        </DialogActions>
      </Dialog>
    </Dialog>
  );
}
