import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControl,
  FormControlLabel,
  IconButton,
  InputLabel,
  LinearProgress,
  MenuItem,
  Select,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  TextField,
  Typography,
} from "@mui/material";
import RefreshIcon from "@mui/icons-material/Refresh";
import { useTranslation } from "react-i18next";
import { invoke } from "@tauri-apps/api/core";
import { useConfig } from "../settings/ConfigContext";
import type { ProcessInfo } from "../types/process";

interface AttachDialogProps {
  open: boolean;
  onClose: () => void;
  onAttach: (process: ProcessInfo) => void;
}

type SortKey = "name" | "title" | "arch" | "pid";
type SortDir = "asc" | "desc";

export function AttachDialog({ open, onClose, onAttach }: AttachDialogProps) {
  const { t } = useTranslation();
  const { config } = useConfig();
  const [processes, setProcesses] = useState<ProcessInfo[]>([]);
  const [filter, setFilter] = useState("");
  const [archFilter, setArchFilter] = useState<"all" | "x86" | "x64">("all");
  const [hideNoTitle, setHideNoTitle] = useState(false);
  const [selectedPid, setSelectedPid] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [ownPid, setOwnPid] = useState<number | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  const refresh = useCallback(() => {
    setLoading(true);
    void invoke<ProcessInfo[]>("list_processes")
      .then((list) => {
        setProcesses(list);
        setSelectedPid(null);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  useEffect(() => {
    if (!open) return;
    void invoke<number>("get_own_pid")
      .then(setOwnPid)
      .catch(() => setOwnPid(null));
  }, [open]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((dir) => (dir === "asc" ? "desc" : "asc"));
    } else {
      setSortKey(key);
      setSortDir("asc");
    }
  };

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    let list = processes.filter((p) => {
      if (ownPid !== null && p.pid === ownPid) return false; // 不允许附加自身
      if (q) {
        const hit =
          p.name.toLowerCase().includes(q) ||
          p.title.toLowerCase().includes(q) ||
          String(p.pid).includes(q);
        if (!hit) return false;
      }
      if (archFilter !== "all" && p.arch !== archFilter) return false;
      if (hideNoTitle && !p.title) return false;
      if (config.hideSystemProcesses && p.is_system) return false;
      return true;
    });

    const dir = sortDir === "asc" ? 1 : -1;
    list = [...list].sort((a, b) => {
      if (sortKey === "pid") return (a.pid - b.pid) * dir;
      const av = (sortKey === "name" ? a.name : sortKey === "title" ? a.title : a.arch).toLowerCase();
      const bv = (sortKey === "name" ? b.name : sortKey === "title" ? b.title : b.arch).toLowerCase();
      return av.localeCompare(bv) * dir;
    });
    return list;
  }, [
    processes,
    filter,
    archFilter,
    hideNoTitle,
    config.hideSystemProcesses,
    ownPid,
    sortKey,
    sortDir,
  ]);

  const handleOk = () => {
    const process = processes.find((p) => p.pid === selectedPid);
    if (process) onAttach(process);
  };

  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>{t("attach.title")}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" color="text.secondary">
          {t("attach.hintAdmin")}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {t("attach.hintPid")}
        </Typography>

        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1.5, mb: 1 }}>
          <TextField
            size="small"
            fullWidth
            placeholder={t("attach.filterPlaceholder")}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <FormControl size="small" sx={{ minWidth: 110 }}>
            <InputLabel id="attach-arch-label">{t("attach.archFilter")}</InputLabel>
            <Select
              labelId="attach-arch-label"
              value={archFilter}
              label={t("attach.archFilter")}
              onChange={(e) => setArchFilter(e.target.value as "all" | "x86" | "x64")}
            >
              <MenuItem value="all">{t("attach.archAll")}</MenuItem>
              <MenuItem value="x86">x86</MenuItem>
              <MenuItem value="x64">x64</MenuItem>
            </Select>
          </FormControl>
          <FormControlLabel
            control={
              <Checkbox
                size="small"
                checked={hideNoTitle}
                onChange={(e) => setHideNoTitle(e.target.checked)}
              />
            }
            label={t("attach.hideNoTitle")}
          />
          <IconButton onClick={refresh} title={t("attach.refresh")}>
            <RefreshIcon />
          </IconButton>
        </Box>

        {loading && <LinearProgress sx={{ mb: 1 }} />}

        <TableContainer sx={{ maxHeight: 420, border: 1, borderColor: "divider" }}>
          <Table size="small" stickyHeader>
            <TableHead>
              <TableRow>
                <TableCell sortDirection={sortKey === "name" ? sortDir : false}>
                  <TableSortLabel
                    active={sortKey === "name"}
                    direction={sortDir}
                    onClick={() => handleSort("name")}
                  >
                    {t("attach.name")}
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortKey === "title" ? sortDir : false}>
                  <TableSortLabel
                    active={sortKey === "title"}
                    direction={sortDir}
                    onClick={() => handleSort("title")}
                  >
                    {t("attach.windowTitle")}
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortKey === "arch" ? sortDir : false}>
                  <TableSortLabel
                    active={sortKey === "arch"}
                    direction={sortDir}
                    onClick={() => handleSort("arch")}
                  >
                    {t("attach.arch")}
                  </TableSortLabel>
                </TableCell>
                <TableCell sortDirection={sortKey === "pid" ? sortDir : false}>
                  <TableSortLabel
                    active={sortKey === "pid"}
                    direction={sortDir}
                    onClick={() => handleSort("pid")}
                  >
                    {t("attach.pid")}
                  </TableSortLabel>
                </TableCell>
              </TableRow>
            </TableHead>
            <TableBody>
              {filtered.map((p) => (
                <TableRow
                  key={p.pid}
                  hover
                  selected={selectedPid === p.pid}
                  onClick={() => setSelectedPid(p.pid)}
                  sx={{ cursor: "pointer" }}
                >
                  <TableCell>
                    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
                      {p.icon ? (
                        <Box
                          component="img"
                          src={p.icon}
                          width={16}
                          height={16}
                          sx={{ flexShrink: 0 }}
                        />
                      ) : null}
                      <Box component="span">{p.name}</Box>
                    </Box>
                  </TableCell>
                  <TableCell>{p.title || "—"}</TableCell>
                  <TableCell>{p.arch}</TableCell>
                  <TableCell>{p.pid}</TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 && !loading && (
                <TableRow>
                  <TableCell colSpan={4} align="center" sx={{ color: "text.secondary" }}>
                    {t("attach.noResults")}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </DialogContent>
      <DialogActions>
        <Button onClick={onClose}>{t("attach.cancel")}</Button>
        <Button onClick={handleOk} disabled={selectedPid === null} variant="contained">
          {t("attach.ok")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
