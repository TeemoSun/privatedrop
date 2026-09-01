import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronRight,
  CornerDownLeft,
  Database,
  File as FileIcon,
  HardDrive,
  Laptop,
  LogOut,
  Moon,
  Pencil,
  RefreshCw,
  RotateCcw,
  Smartphone,
  Sun,
  SunMoon,
  Trash2,
  Wrench,
} from "lucide-react";
import { Link, Route, Routes, useNavigate } from "react-router-dom";

import { api, clearTokens, getDeviceId, getDeviceName, setDeviceName } from "../lib/api";
import { getSendOnEnter, getTheme, setSendOnEnter, setTheme, type Theme } from "../lib/settings";
import { Button } from "../components/ui/Button";
import { Card, CardContent } from "../components/ui/Card";
import { ExpandableText } from "../components/ui/ExpandableText";
import { EmptyState, Spinner } from "../components/ui/Misc";
import { formatBytes, cn } from "../lib/utils";
import { formatDateTime, fromNow } from "../lib/format";
import type { Item } from "../lib/types";

function formatTrashRemaining(deletedAtStr?: string | null, isEphemeral?: boolean): string {
  if (!deletedAtStr) return "保留中";
  const deletedAt = new Date(deletedAtStr).getTime();
  const ttlMs = isEphemeral ? 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
  const expiresAt = deletedAt + ttlMs;
  const diffMs = expiresAt - Date.now();
  if (diffMs <= 0) return "即将彻底销毁";

  if (isEphemeral) {
    const hours = Math.floor(diffMs / (1000 * 60 * 60));
    const minutes = Math.floor((diffMs % (1000 * 60 * 60)) / (1000 * 60));
    if (hours > 0) return `剩 ${hours} 小时彻底销毁`;
    return `剩 ${Math.max(1, minutes)} 分钟彻底销毁`;
  }

  const diffDays = Math.ceil(diffMs / (24 * 60 * 60 * 1000));
  if (diffDays <= 1) {
    const diffHours = Math.max(1, Math.ceil(diffMs / (60 * 60 * 1000)));
    return `剩 ${diffHours} 小时彻底销毁`;
  }
  return `剩 ${diffDays} 天彻底销毁`;
}

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmText?: string;
  cancelText?: string;
  variant?: "destructive" | "default";
  onConfirm: () => void;
  onCancel: () => void;
  loading?: boolean;
}

function ConfirmDialog({
  open,
  title,
  description,
  confirmText = "确定",
  cancelText = "取消",
  variant = "default",
  onConfirm,
  onCancel,
  loading = false,
}: ConfirmDialogProps) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-xs p-4 animate-in fade-in-0">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
          <p className="text-sm text-muted-foreground mt-2 whitespace-pre-line leading-relaxed">{description}</p>
        </div>
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={loading}>
            {cancelText}
          </Button>
          <Button
            variant={variant === "destructive" ? "destructive" : "default"}
            size="sm"
            onClick={onConfirm}
            disabled={loading}
          >
            {loading ? <Spinner className="h-3.5 w-3.5 mr-1" /> : null}
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface PromptDialogProps {
  open: boolean;
  title: string;
  initialValue: string;
  placeholder?: string;
  confirmText?: string;
  cancelText?: string;
  onConfirm: (val: string) => void;
  onCancel: () => void;
  loading?: boolean;
}

function PromptDialog({
  open,
  title,
  initialValue,
  placeholder,
  confirmText = "保存",
  cancelText = "取消",
  onConfirm,
  onCancel,
  loading = false,
}: PromptDialogProps) {
  const [val, setVal] = useState(initialValue);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-xs p-4 animate-in fade-in-0">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 shadow-lg space-y-4">
        <div>
          <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
        </div>
        <input
          autoFocus
          className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={val}
          placeholder={placeholder}
          maxLength={255}
          onChange={(e) => setVal(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && val.trim()) {
              e.preventDefault();
              onConfirm(val.trim());
            }
          }}
        />
        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" size="sm" onClick={onCancel} disabled={loading}>
            {cancelText}
          </Button>
          <Button
            size="sm"
            onClick={() => onConfirm(val.trim())}
            disabled={!val.trim() || loading}
          >
            {loading ? <Spinner className="h-3.5 w-3.5 mr-1" /> : null}
            {confirmText}
          </Button>
        </div>
      </div>
    </div>
  );
}

function handleLogout() {
  api.logout().finally(() => {
    clearTokens();
    window.dispatchEvent(new Event("pd:unauthorized"));
  });
}

function ManageMenu() {
  const { data: devices = [] } = useQuery({
    queryKey: ["devices"],
    queryFn: api.devices,
  });

  const { data: trashItems = [] } = useQuery({
    queryKey: ["trash"],
    queryFn: api.trashItems,
  });

  const { data: storageData } = useQuery({
    queryKey: ["storage-check"],
    queryFn: api.storageCheck,
  });

  const [sendOnEnter, setSendOnEnterState] = useState(() => getSendOnEnter());
  const [theme, setThemeState] = useState<Theme>(() => getTheme());
  const [showRenameDialog, setShowRenameDialog] = useState(false);
  const [currentDevName, setCurrentDevName] = useState(() => getDeviceName());
  const [renaming, setRenaming] = useState(false);

  const handleThemeChange = (newTheme: Theme) => {
    setThemeState(newTheme);
    setTheme(newTheme);
  };

  const handleRenameCurrent = async (newName: string) => {
    setRenaming(true);
    try {
      await api.renameDevice(getDeviceId(), newName);
      setDeviceName(newName);
      setCurrentDevName(newName);
      setShowRenameDialog(false);
    } finally {
      setRenaming(false);
    }
  };

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-1 min-h-0 flex-col overflow-y-auto px-4 py-4 sm:py-6 gap-6">
      <PromptDialog
        open={showRenameDialog}
        title="修改当前设备名称"
        initialValue={currentDevName}
        placeholder="输入新的设备名称"
        loading={renaming}
        onConfirm={handleRenameCurrent}
        onCancel={() => setShowRenameDialog(false)}
      />

      <div>
        <h1 className="text-xl font-bold tracking-tight">管理</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          设备连接、回收站与系统偏好设置
        </p>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase px-1">
          通用设置
        </span>
        <Card className="divide-y overflow-hidden border shadow-sm">
          <Link
            to="/manage/devices"
            className="flex items-center justify-between p-4 hover:bg-accent/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-foreground">
                <Smartphone className="h-5 w-5" />
              </div>
              <div>
                <div className="font-medium text-sm">设备管理</div>
                <div className="text-xs text-muted-foreground">
                  已连接 {devices.length} 台设备
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 text-muted-foreground">
              <ChevronRight className="h-4 w-4" />
            </div>
          </Link>

          <Link
            to="/manage/trash"
            className="flex items-center justify-between p-4 hover:bg-accent/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-rose-500/10 text-rose-600 dark:text-rose-400">
                <Trash2 className="h-5 w-5" />
              </div>
              <div>
                <div className="font-medium text-sm">回收站</div>
                <div className="text-xs text-muted-foreground">
                  已删除内容保留（常规 30 天，中转站 24 小时）
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 text-muted-foreground">
              {trashItems.length > 0 && (
                <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-400">
                  {trashItems.length}
                </span>
              )}
              <ChevronRight className="h-4 w-4" />
            </div>
          </Link>

          <Link
            to="/manage/storage"
            className="flex items-center justify-between p-4 hover:bg-accent/50 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted text-foreground">
                <HardDrive className="h-5 w-5" />
              </div>
              <div>
                <div className="font-medium text-sm">存储与索引校验</div>
                <div className="text-xs text-muted-foreground">
                  校验记录与物理文件一致性，清理冗余与失效文件
                </div>
              </div>
            </div>
            <div className="flex items-center gap-1 text-muted-foreground">
              {storageData?.status === "issues_found" && (
                <span className="rounded-full bg-rose-500/15 px-2 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-400">
                  发现异常
                </span>
              )}
              <ChevronRight className="h-4 w-4" />
            </div>
          </Link>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase px-1">
          外观与偏好
        </span>
        <Card className="divide-y overflow-hidden border shadow-sm">
          {/* 主题外观切换 */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between p-4 gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                <SunMoon className="h-5 w-5" />
              </div>
              <div>
                <div className="font-medium text-sm">主题外观</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  支持浅色、深色模式与跟随系统自动切换
                </div>
              </div>
            </div>
            <div className="flex items-center rounded-lg border bg-muted/60 p-1 gap-1 self-start sm:self-auto shrink-0">
              <button
                type="button"
                onClick={() => handleThemeChange("light")}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all select-none cursor-pointer",
                  theme === "light"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Sun className="h-3.5 w-3.5" />
                <span>浅色</span>
              </button>
              <button
                type="button"
                onClick={() => handleThemeChange("dark")}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all select-none cursor-pointer",
                  theme === "dark"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Moon className="h-3.5 w-3.5" />
                <span>深色</span>
              </button>
              <button
                type="button"
                onClick={() => handleThemeChange("system")}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-all select-none cursor-pointer",
                  theme === "system"
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Laptop className="h-3.5 w-3.5" />
                <span>跟随系统</span>
              </button>
            </div>
          </div>

          {/* 按 Enter 发送 */}
          <div className="flex items-center justify-between p-4 gap-4">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
                <CornerDownLeft className="h-5 w-5" />
              </div>
              <div>
                <div className="font-medium text-sm">按 Enter 键发送</div>
                <div className="text-xs text-muted-foreground mt-0.5">
                  开启后按 Enter 发送、Shift+Enter 换行；关闭后按 Enter 仅换行（适合移动端输入）
                </div>
              </div>
            </div>
            <label className="relative inline-flex cursor-pointer items-center shrink-0">
              <input
                type="checkbox"
                checked={sendOnEnter}
                onChange={(e) => {
                  const val = e.target.checked;
                  setSendOnEnterState(val);
                  setSendOnEnter(val);
                }}
                className="peer sr-only"
              />
              <div className="h-6 w-11 rounded-full bg-input transition-colors peer-checked:bg-primary peer-focus-visible:outline-none peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-focus-visible:ring-offset-2 after:absolute after:left-[2px] after:top-[2px] after:h-5 after:w-5 after:rounded-full after:bg-background after:transition-transform after:content-[''] peer-checked:after:translate-x-full" />
            </label>
          </div>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <span className="text-xs font-semibold text-muted-foreground uppercase px-1">
          当前设备与账户
        </span>
        <Card className="divide-y overflow-hidden border shadow-sm">
          <div className="flex items-center justify-between p-4">
            <div className="text-sm">
              <div className="font-medium">当前设备名称</div>
              <div className="text-xs text-muted-foreground mt-0.5">{currentDevName}</div>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowRenameDialog(true)}
            >
              <Pencil className="h-3.5 w-3.5 mr-1" />
              改名
            </Button>
          </div>

          <div
            onClick={handleLogout}
            className="flex items-center justify-between p-4 hover:bg-destructive/10 text-destructive cursor-pointer transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-destructive/10 text-destructive">
                <LogOut className="h-5 w-5" />
              </div>
              <div>
                <div className="font-medium text-sm">退出登录</div>
                <div className="text-xs text-destructive/80">清除本机登录凭证并断开连接</div>
              </div>
            </div>
            <ChevronRight className="h-4 w-4 text-destructive/60" />
          </div>
        </Card>
      </div>
    </div>
  );
}

function DevicesSubPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [deviceToDelete, setDeviceToDelete] = useState<{ id: string; name: string; isCurrent: boolean } | null>(null);
  const currentDeviceId = getDeviceId();

  const { data: devices = [], isLoading } = useQuery({
    queryKey: ["devices"],
    queryFn: api.devices,
  });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) => api.renameDevice(id, name),
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      if (variables.id.toLowerCase() === currentDeviceId.toLowerCase()) {
        setDeviceName(variables.name);
      }
      setEditing(null);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => api.deleteDevice(id),
    onSuccess: (_data, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["devices"] });
      if (deletedId.toLowerCase() === currentDeviceId.toLowerCase()) {
        clearTokens();
        window.dispatchEvent(new Event("pd:unauthorized"));
      }
      setDeviceToDelete(null);
    },
  });

  const sortedDevices = [...devices].sort((a, b) => {
    const aCurrent = a.id.toLowerCase() === currentDeviceId.toLowerCase();
    const bCurrent = b.id.toLowerCase() === currentDeviceId.toLowerCase();
    if (aCurrent && !bCurrent) return -1;
    if (!aCurrent && bCurrent) return 1;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-1 min-h-0 flex-col overflow-y-auto px-4 py-4 sm:py-6 gap-3">
      <ConfirmDialog
        open={!!deviceToDelete}
        title="确认解绑设备"
        description={
          deviceToDelete?.isCurrent
            ? "确定删除当前设备？删除后将立即退出登录。"
            : `确定删除设备「${deviceToDelete?.name}」？该设备的登录将立即失效。`
        }
        variant="destructive"
        confirmText="删除"
        loading={deleteMutation.isPending}
        onConfirm={() => {
          if (deviceToDelete) deleteMutation.mutate(deviceToDelete.id);
        }}
        onCancel={() => setDeviceToDelete(null)}
      />

      <div className="flex items-center gap-2 mb-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/manage")}
          className="gap-1 -ml-2 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          返回管理
        </Button>
      </div>

      <div>
        <h1 className="text-xl font-bold tracking-tight">设备管理</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          查看所有使用当前密码登记的设备，支持改名或解绑
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : sortedDevices.length === 0 ? (
        <EmptyState
          icon={<Smartphone className="h-10 w-10 text-muted-foreground" />}
          title="还没有登记的设备"
        />
      ) : (
        <div className="space-y-3 mt-2">
          {sortedDevices.map((device) => {
            const isCurrent = device.id.toLowerCase() === currentDeviceId.toLowerCase();
            return (
              <Card
                key={device.id}
                className={cn("transition-colors", isCurrent && "border-primary/50 shadow-sm")}
              >
                <CardContent className="flex items-center justify-between gap-3 p-4">
                  <div className="min-w-0 flex-1">
                    {editing === device.id ? (
                      <div className="flex items-center gap-2">
                        <input
                          className="h-8 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2 text-base md:text-sm"
                          value={name}
                          maxLength={255}
                          onChange={(e) => setName(e.target.value)}
                        />
                        <Button
                          size="sm"
                          disabled={!name.trim() || renameMutation.isPending}
                          onClick={() =>
                            renameMutation.mutate({ id: device.id, name: name.trim() })
                          }
                        >
                          保存
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => setEditing(null)}>
                          取消
                        </Button>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-center gap-2">
                          <p className="truncate font-medium">{device.name}</p>
                          {isCurrent && (
                            <span className="inline-flex shrink-0 items-center rounded-full bg-primary/10 px-2 py-0.5 text-xs font-medium text-primary">
                              当前设备
                            </span>
                          )}
                        </div>
                        <p className="mt-0.5 text-xs text-muted-foreground">
                          最后在线 {formatDateTime(device.last_seen_at)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          登记于 {formatDateTime(device.created_at)}
                        </p>
                      </>
                    )}
                  </div>
                  {editing !== device.id && (
                    <div className="flex shrink-0 items-center gap-1">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setEditing(device.id);
                          setName(device.name);
                        }}
                      >
                        <Pencil className="h-3.5 w-3.5" />
                        改名
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          setDeviceToDelete({ id: device.id, name: device.name, isCurrent });
                        }}
                      >
                        删除
                      </Button>
                    </div>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function TrashSubPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [confirmEmpty, setConfirmEmpty] = useState(false);
  const [purgeItemId, setPurgeItemId] = useState<string | null>(null);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ["trash"],
    queryFn: api.trashItems,
  });

  const restoreMutation = useMutation({
    mutationFn: (id: string) => api.restoreItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      queryClient.invalidateQueries({ queryKey: ["items"] });
    },
  });

  const purgeMutation = useMutation({
    mutationFn: (id: string) => api.purgeItem(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      setPurgeItemId(null);
    },
  });

  const emptyMutation = useMutation({
    mutationFn: api.emptyTrash,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      setConfirmEmpty(false);
    },
  });

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-1 min-h-0 flex-col overflow-y-auto px-4 py-4 sm:py-6 gap-3">
      <ConfirmDialog
        open={confirmEmpty}
        title="确认一键清空回收站"
        description="确定一键清空回收站？所有内容和物理文件将被永久彻底销毁，无法找回。"
        variant="destructive"
        confirmText="清空"
        loading={emptyMutation.isPending}
        onConfirm={() => {
          emptyMutation.mutate();
        }}
        onCancel={() => setConfirmEmpty(false)}
      />

      <ConfirmDialog
        open={!!purgeItemId}
        title="确认彻底删除"
        description="确定彻底删除此条目？关联的物理文件将被彻底粉碎无法恢复。"
        variant="destructive"
        confirmText="彻底删除"
        loading={purgeMutation.isPending}
        onConfirm={() => {
          if (purgeItemId) {
            purgeMutation.mutate(purgeItemId);
          }
        }}
        onCancel={() => setPurgeItemId(null)}
      />

      <div className="flex items-center justify-between gap-2 mb-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/manage")}
          className="gap-1 -ml-2 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          返回管理
        </Button>

        {items.length > 0 && (
          <Button
            variant="destructive"
            size="sm"
            disabled={emptyMutation.isPending}
            onClick={() => setConfirmEmpty(true)}
          >
            <Trash2 className="h-4 w-4 mr-1" />
            清空回收站
          </Button>
        )}
      </div>

      <div>
        <h1 className="text-xl font-bold tracking-tight">回收站</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          被删除的文字与文件在此保留（常规内容 30 天，临时中转 24 小时），到期后自动彻底销毁
        </p>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={<Trash2 className="h-10 w-10 text-muted-foreground" />}
          title="回收站是空的"
          hint="在此处可以恢复误删的内容或彻底物理销毁文件"
        />
      ) : (
        <div className="space-y-3 mt-2">
          {items.map((item: Item) => (
            <Card key={item.id} className="overflow-hidden border shadow-sm">
              <CardContent className="p-4 space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                    <span>删除于 {fromNow(item.deleted_at || item.created_at)}</span>
                    {item.is_ephemeral && (
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground">
                        临时中转
                      </span>
                    )}
                  </div>
                  <span className="rounded-full bg-rose-500/10 px-2.5 py-0.5 text-xs font-medium text-rose-600 dark:text-rose-400">
                    {formatTrashRemaining(item.deleted_at, item.is_ephemeral)}
                  </span>
                </div>

                {item.kind === "note" ? (
                  <ExpandableText
                    text={item.note || ""}
                    textClassName="text-foreground/90 leading-relaxed font-sans"
                  />
                ) : (
                  <div className="space-y-2">
                    {item.note && (
                      <ExpandableText
                        text={item.note}
                        textClassName="text-foreground/90 font-sans"
                      />
                    )}
                    <div className="space-y-1.5">
                      {item.files.map((file) => (
                        <div
                          key={file.id}
                          className="flex items-center gap-2 rounded-md bg-muted/60 px-3 py-2 text-xs"
                        >
                          <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                          <span className="min-w-0 flex-1 truncate font-medium">{file.file_name}</span>
                          <span className="shrink-0 text-muted-foreground">{formatBytes(file.size)}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-1 border-t border-border/50">
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={restoreMutation.isPending}
                    onClick={() => restoreMutation.mutate(item.id)}
                    className="gap-1 text-xs"
                  >
                    <RotateCcw className="h-3.5 w-3.5" />
                    恢复
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={purgeMutation.isPending}
                    onClick={() => setPurgeItemId(item.id)}
                    className="gap-1 text-xs"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    彻底删除
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function StorageCheckSubPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [fixSuccessMsg, setFixSuccessMsg] = useState<string | null>(null);
  const [showFixConfirm, setShowFixConfirm] = useState(false);

  const {
    data: storageData,
    isLoading,
    isFetching,
    refetch,
  } = useQuery({
    queryKey: ["storage-check"],
    queryFn: api.storageCheck,
  });

  const fixMutation = useMutation({
    mutationFn: api.storageFix,
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["storage-check"] });
      queryClient.invalidateQueries({ queryKey: ["items"] });
      queryClient.invalidateQueries({ queryKey: ["trash"] });
      setShowFixConfirm(false);
      setFixSuccessMsg(
        `修复完成：已删除 ${result.deleted_orphan_files_count} 个多余物理文件（释放 ${formatBytes(
          result.deleted_orphan_files_size
        )}），已清理 ${result.deleted_broken_items_count} 条失效记录。`
      );
    },
  });

  const hasIssues = storageData && storageData.status === "issues_found";

  return (
    <div className="mx-auto flex h-full w-full max-w-2xl flex-1 min-h-0 flex-col overflow-y-auto px-4 py-4 sm:py-6 gap-4">
      <ConfirmDialog
        open={showFixConfirm}
        title="确认一键清理修复"
        description={`检测到 ${(storageData?.missing_files.length || 0) + (storageData?.orphan_files.length || 0)} 项对不上的异常内容。\n\n确定执行一键修复？将彻底删除所有数据库无引用的多余物理文件，并清理所有磁盘文件已丢失的失效数据库记录。`}
        variant="destructive"
        confirmText="一键修复"
        loading={fixMutation.isPending}
        onConfirm={() => {
          setFixSuccessMsg(null);
          fixMutation.mutate();
        }}
        onCancel={() => setShowFixConfirm(false)}
      />

      <div className="flex items-center justify-between gap-2">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => navigate("/manage")}
          className="gap-1 -ml-2 text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="h-4 w-4" />
          返回管理
        </Button>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={isFetching || fixMutation.isPending}
            onClick={() => {
              setFixSuccessMsg(null);
              refetch();
            }}
            className="gap-1 text-xs"
          >
            <RefreshCw className={cn("h-3.5 w-3.5", isFetching && "animate-spin")} />
            重新校验
          </Button>

          {hasIssues && (
            <Button
              variant="destructive"
              size="sm"
              disabled={fixMutation.isPending}
              onClick={() => setShowFixConfirm(true)}
              className="gap-1 text-xs"
            >
              <Wrench className="h-3.5 w-3.5" />
              一键清理修复
            </Button>
          )}
        </div>
      </div>

      <div>
        <h1 className="text-xl font-bold tracking-tight">存储与索引校验</h1>
        <p className="text-xs text-muted-foreground mt-0.5">
          校验数据库记录与磁盘物理 CAS 文件的一致性，检出并清理多余或丢失的文件
        </p>
      </div>

      {fixSuccessMsg && (
        <div className="rounded-lg bg-muted border border-border p-3 text-xs text-foreground flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 shrink-0 text-muted-foreground" />
            <span>{fixSuccessMsg}</span>
          </div>
          <button
            onClick={() => setFixSuccessMsg(null)}
            className="text-muted-foreground hover:text-foreground ml-auto text-xs"
          >
            关闭
          </button>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : !storageData ? null : (
        <>
          {/* 统计指标 */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Card
              className={cn(
                "border shadow-sm p-3.5 flex flex-col justify-between gap-1",
                hasIssues
                  ? "border-rose-500/40 bg-rose-500/5"
                  : "border-border bg-card"
              )}
            >
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>一致性状态</span>
                {hasIssues ? (
                  <AlertTriangle className="h-4 w-4 text-rose-500" />
                ) : (
                  <CheckCircle2 className="h-4 w-4 text-muted-foreground" />
                )}
              </div>
              <div className="text-base font-semibold">
                {hasIssues ? (
                  <span className="text-rose-600 dark:text-rose-400">发现对不上的异常</span>
                ) : (
                  <span className="text-foreground">完全一致 (正常)</span>
                )}
              </div>
              <div className="text-[11px] text-muted-foreground">
                {hasIssues
                  ? `${storageData.missing_files.length} 个缺失 / ${storageData.orphan_files.length} 个多余`
                  : "索引与物理文件完全对应"}
              </div>
            </Card>

            <Card className="border shadow-sm p-3.5 flex flex-col justify-between gap-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>数据库记录</span>
                <Database className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-base font-semibold">
                {storageData.total_db_files} 个文件
              </div>
              <div className="text-[11px] text-muted-foreground">
                共 {storageData.total_db_items} 条条目记录
              </div>
            </Card>

            <Card className="border shadow-sm p-3.5 flex flex-col justify-between gap-1">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>磁盘物理存储</span>
                <HardDrive className="h-4 w-4 text-muted-foreground" />
              </div>
              <div className="text-base font-semibold">
                {formatBytes(storageData.total_disk_size)}
              </div>
              <div className="text-[11px] text-muted-foreground">
                共 {storageData.total_disk_files} 个磁盘 CAS 文件
              </div>
            </Card>
          </div>

          {/* 如果完全健康 */}
          {!hasIssues ? (
            <Card className="border shadow-sm p-6 text-center">
              <div className="flex flex-col items-center justify-center gap-2">
                <div className="flex h-12 w-12 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <CheckCircle2 className="h-6 w-6" />
                </div>
                <h3 className="font-semibold text-sm">存储与索引状态健康</h3>
                <p className="text-xs text-muted-foreground max-w-sm">
                  所有数据库记录与磁盘上的物理 CAS 文件均完全匹配，未发现文件丢失或多余孤立文件。
                </p>
              </div>
            </Card>
          ) : (
            <div className="space-y-4">
              {/* 异常 1: 数据库有记录，但后端物理文件丢失 */}
              {storageData.missing_files.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-rose-600 dark:text-rose-400 uppercase tracking-wider flex items-center gap-1.5">
                      <AlertTriangle className="h-3.5 w-3.5" />
                      缺失物理文件的失效记录 ({storageData.missing_files.length})
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    数据库中存在以下记录，但磁盘对应文件已不存在（无法下载）。修复时将自动删除这些失效记录。
                  </p>
                  <div className="space-y-2">
                    {storageData.missing_files.map((file) => (
                      <Card key={file.file_id} className="border border-rose-500/30 shadow-sm">
                        <CardContent className="p-3 space-y-1.5 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-center gap-2 font-medium min-w-0">
                              <FileIcon className="h-4 w-4 text-rose-500 shrink-0" />
                              <span className="truncate">{file.file_name}</span>
                            </div>
                            <span className="shrink-0 text-muted-foreground">
                              {formatBytes(file.file_size)}
                            </span>
                          </div>
                          {file.item_note && (
                            <p className="text-muted-foreground text-[11px] line-clamp-1">
                              备注: {file.item_note}
                            </p>
                          )}
                          <div className="flex items-center gap-2 text-[11px] text-muted-foreground flex-wrap pt-0.5">
                            <span className="font-mono text-[10px] bg-muted/60 px-1.5 py-0.5 rounded">
                              SHA: {file.sha256.slice(0, 16)}...
                            </span>
                            {file.item_is_ephemeral && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                                临时中转
                              </span>
                            )}
                            {file.item_is_secret && (
                              <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                                隐私时间线
                              </span>
                            )}
                            {file.item_deleted_at && (
                              <span className="rounded bg-rose-500/10 px-1.5 py-0.5 text-rose-600 dark:text-rose-400">
                                回收站中
                              </span>
                            )}
                            <span className="ml-auto">
                              创建于 {formatDateTime(file.item_created_at)}
                            </span>
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              )}

              {/* 异常 2: 磁盘有多余物理文件，但数据库无记录 */}
              {storageData.orphan_files.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-foreground uppercase tracking-wider flex items-center gap-1.5">
                      <HardDrive className="h-3.5 w-3.5" />
                      数据库无记录的多余物理文件 ({storageData.orphan_files.length})
                    </span>
                    <span className="text-xs text-muted-foreground">
                      总大小:{" "}
                      {formatBytes(
                        storageData.orphan_files.reduce((acc, f) => acc + f.size, 0)
                      )}
                    </span>
                  </div>
                  <p className="text-[11px] text-muted-foreground">
                    磁盘上存在以下物理文件，但没有任何数据库条目引用。修复时将直接从磁盘物理删除以释放存储空间。
                  </p>
                  <div className="space-y-2">
                    {storageData.orphan_files.map((file) => (
                      <Card key={file.sha256} className="border border-border/80 shadow-sm">
                        <CardContent className="p-3 space-y-1 text-xs">
                          <div className="flex items-center justify-between gap-2">
                            <span className="font-mono text-[11px] truncate flex-1">
                              {file.path}
                            </span>
                            <span className="font-medium shrink-0">
                              {formatBytes(file.size)}
                            </span>
                          </div>
                          <div className="text-[10px] font-mono text-muted-foreground truncate">
                            SHA-256: {file.sha256}
                          </div>
                        </CardContent>
                      </Card>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function Manage() {
  return (
    <Routes>
      <Route path="/" element={<ManageMenu />} />
      <Route path="/devices" element={<DevicesSubPage />} />
      <Route path="/trash" element={<TrashSubPage />} />
      <Route path="/storage" element={<StorageCheckSubPage />} />
    </Routes>
  );
}

