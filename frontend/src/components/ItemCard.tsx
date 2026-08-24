import { useState } from "react";
import { Download, File as FileIcon, FileText, Trash2 } from "lucide-react";

import { api } from "../lib/api";
import { fromNow } from "../lib/format";
import type { Item } from "../lib/types";
import { cn, formatBytes } from "../lib/utils";
import { Button } from "./ui/Button";

interface ItemCardProps {
  item: Item;
  onDeleted: (id: string) => void;
}

export function ItemCard({ item, onDeleted }: ItemCardProps) {
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

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
        </div>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 opacity-0 transition-opacity group-hover:opacity-100"
          onClick={remove}
          disabled={deleting}
          title="删除"
        >
          <Trash2 className="h-4 w-4 text-destructive" />
        </Button>
      </div>

      {item.note && <p className="mb-2 whitespace-pre-wrap text-sm leading-relaxed">{item.note}</p>}

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
