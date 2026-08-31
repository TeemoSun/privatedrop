import { useState } from "react";
import { Check, Clock, Copy, Download, File as FileIcon, FileText, Trash2 } from "lucide-react";

import { api } from "../lib/api";
import { fromNow } from "../lib/format";
import type { Item } from "../lib/types";
import { cn, formatBytes } from "../lib/utils";
import { Button } from "./ui/Button";

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
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // Fallback
    }
  };

  return (
    <div className="group rounded-lg border bg-card p-4 shadow-sm transition-shadow hover:shadow-md">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {item.kind === "note" ? (
            <FileText className="h-3.5 w-3.5" />
          ) : (
            <FileIcon className="h-3.5 w-3.5" />
          )}
          <span>{fromNow(item.created_at)}</span>
          {item.is_ephemeral && (
            <span
              className="inline-flex items-center gap-1 rounded bg-amber-500/10 px-1.5 py-0.5 text-[11px] font-medium text-amber-600 dark:text-amber-400"
              title={item.expires_at ? `到期时间: ${new Date(item.expires_at).toLocaleString()}` : "24小时后自动销毁"}
            >
              <Clock className="h-3 w-3" />
              <span>{item.expires_at ? formatRemaining(item.expires_at) : "24h 临时"}</span>
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {item.note && (
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-muted-foreground hover:text-foreground"
              onClick={copyNote}
              title={copied ? "已复制" : "复制文本"}
            >
              {copied ? (
                <Check className="h-3.5 w-3.5 text-green-600" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 opacity-100 transition-opacity md:opacity-0 md:group-hover:opacity-100"
            onClick={remove}
            disabled={deleting}
            title="删除"
          >
            <Trash2 className="h-4 w-4 text-destructive" />
          </Button>
        </div>
      </div>

      {item.note && (
        <p className="mb-2 whitespace-pre-wrap break-words break-all text-sm leading-relaxed">
          {item.note}
        </p>
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
                  "flex w-full items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors",
                  "hover:bg-accent",
                  downloading && "opacity-60",
                )}
              >
                <FileIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate">{f.file_name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{formatBytes(f.size)}</span>
                <Download className="h-4 w-4 shrink-0 text-muted-foreground" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
