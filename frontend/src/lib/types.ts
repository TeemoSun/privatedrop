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
  expires_at?: string | null;
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
