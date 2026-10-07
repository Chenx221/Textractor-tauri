import { Fragment, type ReactNode } from "react";
import {
  Badge,
  Box,
  Divider,
  IconButton,
  List,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  MenuItem,
  Select,
  Tooltip,
} from "@mui/material";
import { useTranslation } from "react-i18next";

import {
  AppWindow,
  ArrowLeftToLine,
  ArrowRightFromLine,
  Blocks,
  Cog,
  Cpu,
  Info,
  Link,
  Rocket,
  Save,
  SearchCode,
  Settings,
  Shield,
  StarMinus,
  StarPlus,
  Trash2,
  Unlink,
} from "lucide-react";

import type { ProcessInfo } from "../types/process";

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapsed: () => void;
  onOpenSettings: () => void;
  onOpenExtensions: () => void;
  onOpenAttach: () => void;
  onOpenLaunch: () => void;
  onOpenAbout: () => void;
  onToggleExtraWindow: () => void;
  onRestartAsAdmin: () => void;
  onDetach: () => void;
  onSaveHooks: () => void;
  onConfigure: () => void;
  onForget: () => void;
  onAddHook: () => void;
  onRemoveHook: () => void;
  onSearchHooks: () => void;
  isAdmin: boolean | null;
  /** 已附加的目标进程（可能多个）。 */
  targets: ProcessInfo[];
  /** 当前操作目标 PID。 */
  targetPid: number | null;
  /** 切换当前操作目标。 */
  onSelectTarget: (pid: number) => void;
}

interface ActionItem {
  key: string;
  icon: ReactNode;
}

const ACTION_ITEMS: ActionItem[] = [
  { key: "attach", icon: <Link /> },
  { key: "launch", icon: <Rocket /> },
  { key: "configure", icon: <Cog /> },
  { key: "detach", icon: <Unlink /> },
  { key: "forget", icon: <Trash2 /> },
  { key: "addHook", icon: <StarPlus /> },
  { key: "removeHook", icon: <StarMinus /> },
  { key: "saveHooks", icon: <Save /> },
  { key: "searchHooks", icon: <SearchCode /> },
  { key: "extraWindow", icon: <AppWindow /> },
];

const ACTION_ITEMS_AFTER: ActionItem[] = [
  { key: "extensions", icon: <Blocks /> },
  { key: "restartAdmin", icon: <Shield /> },
];

export function Sidebar({
  collapsed,
  onToggleCollapsed,
  onOpenSettings,
  onOpenExtensions,
  onOpenAttach,
  onOpenLaunch,
  onToggleExtraWindow,
  onOpenAbout,
  onRestartAsAdmin,
  onDetach,
  onSaveHooks,
  onConfigure,
  onForget,
  onAddHook,
  onRemoveHook,
  onSearchHooks,
  isAdmin,
  targets,
  targetPid,
  onSelectTarget,
}: SidebarProps) {
  const { t } = useTranslation();

  const hasTarget = targetPid !== null;
  const targetLabel = (process: ProcessInfo) => `${process.name} (PID ${process.pid})`;

  const renderAction = (item: ActionItem) => {
    const label = t(`sidebar.actions.${item.key}`);
    const onClick =
      item.key === "attach"
        ? onOpenAttach
        : item.key === "launch"
          ? onOpenLaunch
          : item.key === "extensions"
            ? onOpenExtensions
            : item.key === "restartAdmin"
              ? onRestartAsAdmin
              : item.key === "extraWindow"
                ? onToggleExtraWindow
                : item.key === "detach"
                ? onDetach
                : item.key === "saveHooks"
                  ? onSaveHooks
                  : item.key === "configure"
                    ? onConfigure
                    : item.key === "forget"
                      ? onForget
                      : item.key === "addHook"
                        ? onAddHook
                        : item.key === "removeHook"
                          ? onRemoveHook
                          : item.key === "searchHooks"
                            ? onSearchHooks
                            : undefined;
    const needsProcess =
      item.key === "detach" ||
      item.key === "saveHooks" ||
      item.key === "configure" ||
      item.key === "forget" ||
      item.key === "addHook" ||
      item.key === "removeHook" ||
      item.key === "searchHooks";
    const disabled =
      (item.key === "restartAdmin" && isAdmin === true) ||
      (needsProcess && !hasTarget);
    const button = (
      <ListItemButton
        onClick={onClick}
        disabled={disabled}
        disableGutters
        sx={{ px: 1, justifyContent: collapsed ? "center" : "flex-start" }}
      >
        <ListItemIcon sx={{ minWidth: 0, mr: collapsed ? 0 : 1.5, justifyContent: "center" }}>
          {item.icon}
        </ListItemIcon>
        {!collapsed && <ListItemText primary={label} />}
      </ListItemButton>
    );

    return collapsed ? (
      <Tooltip key={item.key} title={label} placement="right">
        {button}
      </Tooltip>
    ) : (
      <Fragment key={item.key}>{button}</Fragment>
    );
  };

  const settingsButton = (
    <ListItemButton
      onClick={onOpenSettings}
      disableGutters
      sx={{ px: 1, justifyContent: collapsed ? "center" : "flex-start" }}
    >
      <ListItemIcon sx={{ minWidth: 0, mr: collapsed ? 0 : 1.5, justifyContent: "center" }}>
        <Settings />
      </ListItemIcon>
      {!collapsed && <ListItemText primary={t("sidebar.actions.settings")} />}
    </ListItemButton>
  );

  const aboutButton = (
    <ListItemButton
      onClick={onOpenAbout}
      disableGutters
      sx={{ px: 1, justifyContent: collapsed ? "center" : "flex-start" }}
    >
      <ListItemIcon sx={{ minWidth: 0, mr: collapsed ? 0 : 1.5, justifyContent: "center" }}>
        <Info />
      </ListItemIcon>
      {!collapsed && <ListItemText primary={t("sidebar.actions.about")} />}
    </ListItemButton>
  );

  return (
    <Box
      component="nav"
      sx={{
        width: collapsed ? 56 : 216,
        flexShrink: 0,
        display: "flex",
        flexDirection: "column",
        borderRight: 1,
        borderColor: "divider",
        bgcolor: "background.paper",
        overflow: "hidden",
        transition: (theme) =>
          theme.transitions.create("width", {
            duration: theme.transitions.duration.shorter,
          }),
      }}
    >
      <Box sx={{ p: 1 }}>
        {collapsed ? (
          <Tooltip
            placement="right"
            title={
              targets.length > 0 ? (
                <Box component="span" sx={{ whiteSpace: "pre-line" }}>
                  {targets.map(targetLabel).join("\n")}
                </Box>
              ) : (
                t("sidebar.process")
              )
            }
          >
            <IconButton size="small" sx={{ width: "100%" }}>
              {/* 多目标时用徽标提示数量（不占宽度，折叠状态下也能看出来）。 */}
              <Badge
                color="primary"
                max={99}
                badgeContent={targets.length > 1 ? targets.length : 0}
              >
                <Cpu />
              </Badge>
            </IconButton>
          </Tooltip>
        ) : (
          <Select
            value={targetPid !== null ? String(targetPid) : ""}
            displayEmpty
            size="small"
            fullWidth
            onChange={(e) => onSelectTarget(Number(e.target.value))}
            renderValue={(value) => {
              const current = targets.find((process) => String(process.pid) === value);
              return current ? (
                targetLabel(current)
              ) : (
                <Box component="span" sx={{ color: "text.secondary" }}>
                  {t("sidebar.noProcess")}
                </Box>
              );
            }}
          >
            {targets.length === 0 ? (
              <MenuItem value="" disabled>
                {t("sidebar.noProcess")}
              </MenuItem>
            ) : (
              targets.map((process) => (
                <MenuItem key={process.pid} value={String(process.pid)}>
                  {targetLabel(process)}
                </MenuItem>
              ))
            )}
          </Select>
        )}
      </Box>

      <Divider />

      <List
        sx={{
          flex: 1,
          overflowY: "auto",
          py: 0.5,
          "& .MuiListItemButton-root": { borderRadius: 1.5, mx: 0.5, mb: 0.25 },
        }}
      >
        {ACTION_ITEMS.map(renderAction)}

        {collapsed ? (
          <Tooltip title={t("sidebar.actions.settings")} placement="right">
            {settingsButton}
          </Tooltip>
        ) : (
          settingsButton
        )}

        {ACTION_ITEMS_AFTER.map(renderAction)}

        {collapsed ? (
          <Tooltip key="collapse" title={t("sidebar.actions.expand")} placement="right">
            <ListItemButton
              onClick={onToggleCollapsed}
              disableGutters
              sx={{ px: 1, justifyContent: "center" }}
            >
              <ListItemIcon sx={{ minWidth: 0, justifyContent: "center" }}>
                <ArrowRightFromLine />
              </ListItemIcon>
            </ListItemButton>
          </Tooltip>
        ) : (
          <ListItemButton key="collapse" onClick={onToggleCollapsed} disableGutters sx={{ px: 1 }}>
            <ListItemIcon sx={{ minWidth: 0, mr: 1.5, justifyContent: "center" }}>
              <ArrowLeftToLine />
            </ListItemIcon>
            <ListItemText primary={t("sidebar.actions.collapse")} />
          </ListItemButton>
        )}

        {collapsed ? (
          <Tooltip key="about" title={t("sidebar.actions.about")} placement="right">
            {aboutButton}
          </Tooltip>
        ) : (
          aboutButton
        )}
      </List>
    </Box>
  );
}
