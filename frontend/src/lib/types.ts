export interface FileOut {
  id: string;
  file_name: string;
  mime_type: string;
  size: number;
  sha256: string;
  uploaded_at: string | null;
}

export interface Item {
  id: string;
  kind: "file" | "note";
  note: string | null;
  is_ephemeral?: boolean;
  is_secret?: boolean;
  expires_at?: string | null;
  deleted_at?: string | null;
  created_at: string;
  created_by_device: string | null;
  files: FileOut[];
}

export interface ItemList {
  items: Item[];
  next_cursor: string | null;
}

export interface Device {
  id: string;
  name: string;
  created_at: string;
  last_seen_at: string;
}

export interface TokenResponse {
  access_token: string;
  refresh_token: string;
  device_id: string;
}

export interface UploadTarget {
  file_id: string;
  upload_url: string;
  already_exists?: boolean;
}

export interface ItemCreateResponse {
  item_id: string;
  files: UploadTarget[];
}

export interface DownloadUrlResponse {
  url: string;
  expires_at: string;
}

export type WsEvent =
  | { type: "item_created"; item: Item }
  | { type: "item_deleted"; id: string };

export interface MissingFileRecord {
  item_id: string;
  item_kind: string;
  item_note: string | null;
  item_created_at: string;
  item_is_ephemeral: boolean;
  item_is_secret: boolean;
  item_deleted_at: string | null;
  file_id: string;
  file_name: string;
  file_size: number;
  sha256: string;
}

export interface OrphanFileRecord {
  sha256: string;
  size: number;
  path: string;
}

export interface StorageCheckResult {
  status: "healthy" | "issues_found";
  total_db_items: number;
  total_db_files: number;
  total_disk_files: number;
  total_disk_size: number;
  missing_files: MissingFileRecord[];
  orphan_files: OrphanFileRecord[];
}

export interface StorageFixResult {
  deleted_orphan_files_count: number;
  deleted_orphan_files_size: number;
  deleted_broken_items_count: number;
}

