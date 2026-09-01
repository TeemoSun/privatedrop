import { useEffect, useRef, useState } from "react";
import {
  Check,
  Clock,
  Copy,
  Download,
  File as FileIcon,
  FileText,
  MoreHorizontal,
  Trash2,
} from "lucide-react";

import { api } from "../lib/api";
import { formatDateTime, fromNow } from "../lib/format";
import type { Item } from "../lib/types";
import { cn, formatBytes } from "../lib/utils";
import { ExpandableText } from "./ui/ExpandableText";

interface ItemCardProps {
  item: Item;
  onDeleted: (id: string) => void;
}

function formatRemaining(expiresAt: string): string {
  const diff = new Date(expiresAt).getTime() - Date.now();
  if (diff <= 0) return "即将销毁";
  const hours = Math.floor(diff / (1000 * 60 * 60));
  const minutes = Math.floor((diff % (1000 * 60 * 60)) / (1000 * 60));
  if (hours > 0) return `剩 ${hours} 小时`;
  return `剩 ${Math.max(1, minutes)} 分钟`;
}

export function ItemCard({ item, onDeleted }: ItemCardProps) {
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [menuOpen]);

  const download = async (fileId: string) => {
    setDownloading(true);
    try {
      const { url } = await api.downloadUrl(item.id, fileId);
      window.open(url, "_blank", "noopener,noreferrer");
    } finally {
      setDownloading(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setMenuOpen(false);
    try {
      await api.deleteItem(item.id);
      onDeleted(item.id);
    } finally {
      setDeleting(false);
    }
  };

  const copyNote = async () => {
    if (!item.note) return;
    try {
      await navigator.clipboard.writeText(item.note);
      setCopied(true);
      setTimeout(() => {
        setCopied(false);
        setMenuOpen(false);
      }, 1200);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="group flex flex-col gap-1.5">
      {/* 框外顶部栏：左侧元信息（类型、发送时间、剩余时间），右侧折叠三点菜单 */}
      <div className="flex items-center justify-between px-1 text-xs text-muted-foreground">
        {/* 框外左上方 */}
        <div className="flex items-center gap-1.5 flex-wrap">
          {item.kind === "note" ? (
            <FileText className="h-3.5 w-3.5 text-muted-foreground/80" />
          ) : (
            <FileIcon className="h-3.5 w-3.5 text-muted-foreground/80" />
          )}
          <span title={formatDateTime(item.created_at)} className="cursor-default select-none">
            {fromNow(item.created_at)}
          </span>
          {item.is_ephemeral && (
            <span
              className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400 select-none"
              title={item.expires_at ? `到期时间: ${new Date(item.expires_at).toLocaleString()}` : "24小时后自动销毁"}
            >
              <Clock className="h-3 w-3" />
              <span>{item.expires_at ? formatRemaining(item.expires_at) : "24h 临时"}</span>
            </span>
          )}
        </div>

        {/* 框外右侧：三点折叠菜单 */}
        <div className="relative" ref={menuRef}>
          <button
            type="button"
            onClick={() => setMenuOpen((prev) => !prev)}
            className={cn(
              "flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none cursor-pointer",
              menuOpen && "bg-accent text-foreground",
            )}
            title="更多操作"
          >
            <MoreHorizontal className="h-4 w-4" />
          </button>

          {/* 下拉浮层菜单 */}
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-30 min-w-[110px] overflow-hidden rounded-lg border bg-card p-1 text-card-foreground shadow-lg animate-in fade-in-0 zoom-in-95">
              {item.note && (
                <button
                  type="button"
                  onClick={copyNote}
                  className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs transition-colors hover:bg-accent hover:text-accent-foreground text-left cursor-pointer"
                >
                  {copied ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-green-600" />
                      <span className="text-green-600 font-medium">已复制</span>
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5 text-muted-foreground" />
                      <span>复制文本</span>
                    </>
                  )}
                </button>
              )}

              <button
                type="button"
                onClick={remove}
                disabled={deleting}
                className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-xs text-destructive transition-colors hover:bg-destructive/10 text-left disabled:opacity-50 cursor-pointer"
              >
                <Trash2 className="h-3.5 w-3.5" />
                <span>删除</span>
              </button>
            </div>
          )}
        </div>
      </div>

      {/* 消息框主体（框内仅展示内容） */}
      <div className="rounded-xl border bg-card p-3.5 sm:p-4 shadow-xs transition-shadow hover:shadow-sm">
        {item.note && (
          <ExpandableText
            text={item.note}
            className={cn(item.kind === "file" && "mb-2.5")}
          />
        )}

        {item.kind === "file" && (
          <ul className="flex flex-col gap-1.5">
            {item.files.map((f) => (
              <li key={f.id}>
                <button
                  type="button"
                  onClick={() => download(f.id)}
                  disabled={downloading}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-lg border bg-background/50 px-3 py-2 text-sm transition-colors",
                    "hover:bg-accent",
                    downloading && "opacity-60",
                  )}
                >
                  <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate text-left">{f.file_name}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                  <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
