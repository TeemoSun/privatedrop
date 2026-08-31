import { detectDeviceNameSync } from "./device";
import type {
  Device,
  DownloadUrlResponse,
  Item,
  ItemCreateResponse,
  ItemList,
  TokenResponse,
} from "./types";
import { generateDeviceId } from "./utils";

const ACCESS_TOKEN = "pd_access_token";
const REFRESH_KEY = "pd_refresh_token";
const DEVICE_KEY = "pd_device_id";

export function getAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN);
}

export function setTokens(access: string, refresh: string): void {
  localStorage.setItem(ACCESS_TOKEN, access);
  localStorage.setItem(REFRESH_KEY, refresh);
}

export function getDeviceId(): string {
  let id = localStorage.getItem(DEVICE_KEY);
  if (!id) {
    id = generateDeviceId();
    localStorage.setItem(DEVICE_KEY, id);
  }
  return id;
}

export function getDeviceName(): string {
  const name = localStorage.getItem("pd_device_name");
  if (name) return name;
  return detectDeviceNameSync().slice(0, 255);
}

export function setDeviceName(name: string): void {
  localStorage.setItem("pd_device_name", name);
}

export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN);
  localStorage.removeItem(REFRESH_KEY);
}

let refreshPromise: Promise<string | null> | null = null;

async function doRefresh(): Promise<string | null> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh) return null;
  try {
    const resp = await fetch("/api/auth/refresh", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    });
    if (!resp.ok) {
      clearTokens();
      return null;
    }
    const data = (await resp.json()) as TokenResponse;
    localStorage.setItem(ACCESS_TOKEN, data.access_token);
    localStorage.setItem(REFRESH_KEY, data.refresh_token);
    return data.access_token;
  } catch {
    return null;
  }
}

export async function refreshAccessToken(): Promise<string | null> {
  if (!refreshPromise) {
    refreshPromise = doRefresh().finally(() => {
      refreshPromise = null;
    });
  }
  return refreshPromise;
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const headers = new Headers(init.headers);
  const token = getAccessToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  const resp = await fetch(path, { ...init, headers });
  if (resp.status === 401 && retry) {
    const newToken = await refreshAccessToken();
    if (newToken) {
      headers.set("Authorization", `Bearer ${newToken}`);
      const retried = await fetch(path, { ...init, headers });
      if (!retried.ok) {
        throw new ApiError(retried.status, await errorMessage(retried));
      }
      return (await retried.json()) as T;
    }
    window.dispatchEvent(new CustomEvent("pd:unauthorized"));
    throw new ApiError(401, "unauthorized");
  }
  if (!resp.ok) {
    throw new ApiError(resp.status, await errorMessage(resp));
  }
  if (resp.status === 204) return undefined as T;
  return (await resp.json()) as T;
}

async function errorMessage(resp: Response): Promise<string> {
  try {
    const body = (await resp.json()) as { detail?: string };
    return typeof body.detail === "string" ? body.detail : resp.statusText;
  } catch {
    return resp.statusText;
  }
}

export const api = {
  login: (password: string) =>
    request<TokenResponse>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({
        password,
        device_id: getDeviceId(),
        device_name: getDeviceName(),
      }),
    }),

  logout: async () => {
    const refresh = localStorage.getItem(REFRESH_KEY);
    try {
      if (refresh) {
        await request<void>("/api/auth/logout", {
          method: "POST",
          body: JSON.stringify({ refresh_token: refresh }),
        });
      }
    } catch {
      /* 忽略注销失败 */
    } finally {
      clearTokens();
    }
  },

  devices: () => request<Device[]>("/api/devices"),

  renameDevice: (id: string, name: string) =>
    request<Device>(`/api/devices/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ name }),
    }),

  deleteDevice: (id: string) =>
    request<void>(`/api/devices/${id}`, { method: "DELETE" }),

  items: (params: { cursor?: string; limit?: number; kind?: "file" | "note" } = {}) => {
    const qs = new URLSearchParams();
    if (params.cursor) qs.set("cursor", params.cursor);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.kind) qs.set("kind", params.kind);
    const q = qs.toString();
    return request<ItemList>(`/api/items${q ? `?${q}` : ""}`);
  },

  createNote: (note: string) =>
    request<ItemCreateResponse>("/api/items", {
      method: "POST",
      body: JSON.stringify({ kind: "note", note }),
    }),

  createFileItem: (specs: { file_name: string; mime_type: string; size: number; sha256: string }[], note: string | null) =>
    request<ItemCreateResponse>("/api/items", {
      method: "POST",
      body: JSON.stringify({ kind: "file", note, files: specs }),
    }),

  uploadComplete: (itemId: string) =>
    request<Item>(`/api/items/${itemId}/upload-complete`, { method: "POST" }),

  downloadUrl: (itemId: string, fileId: string) =>
    request<DownloadUrlResponse>(`/api/items/${itemId}/files/${fileId}/download-url`),

  deleteItem: (itemId: string) =>
    request<void>(`/api/items/${itemId}`, { method: "DELETE" }),
};
