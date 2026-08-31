import { NavLink, Outlet } from "react-router-dom";
import { LayoutDashboard, LogOut, Smartphone } from "lucide-react";

import { Button } from "./ui/Button";
import { api, clearTokens, getDeviceName } from "../lib/api";
import { cn } from "../lib/utils";

function SidebarNav() {
  const navClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors",
      isActive
        ? "bg-accent text-accent-foreground"
        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    );

  return (
    <nav className="flex flex-col gap-1">
      <NavLink to="/" end className={navClass}>
        <LayoutDashboard className="h-4 w-4" />
        时间线
      </NavLink>
      <NavLink to="/devices" className={navClass}>
        <Smartphone className="h-4 w-4" />
        设备
      </NavLink>
    </nav>
  );
}

function handleLogout() {
  api.logout().finally(() => {
    clearTokens();
    window.dispatchEvent(new Event("pd:unauthorized"));
  });
}

export function AppShell() {
  return (
    <div className="flex min-h-screen">
      <aside className="hidden w-56 flex-col border-r bg-card md:flex">
        <div className="border-b px-4 py-4">
          <h1 className="text-lg font-bold tracking-tight">PrivateDrop</h1>
          <p className="text-xs text-muted-foreground">{getDeviceName()}</p>
        </div>
        <div className="flex-1 px-3 py-4">
          <SidebarNav />
        </div>
        <div className="border-t p-3">
          <Button variant="ghost" size="sm" className="w-full justify-start" onClick={handleLogout}>
            <LogOut className="h-4 w-4" />
            退出登录
          </Button>
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between border-b bg-card/90 px-4 py-3 backdrop-blur md:hidden">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold">PrivateDrop</h1>
            <span className="max-w-[140px] truncate text-xs text-muted-foreground">
              {getDeviceName()}
            </span>
          </div>
          <Button variant="ghost" size="icon" onClick={handleLogout} title="退出登录">
            <LogOut className="h-4 w-4" />
          </Button>
        </header>
        <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-4 pb-24 md:py-6 md:pb-6">
          <Outlet />
        </main>
        <nav className="fixed bottom-0 left-0 right-0 z-30 flex items-center justify-around border-t bg-card/90 py-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center gap-1 py-1 text-xs font-medium transition-colors",
                isActive ? "text-primary font-semibold" : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            <LayoutDashboard className="h-5 w-5" />
            时间线
          </NavLink>
          <NavLink
            to="/devices"
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center gap-1 py-1 text-xs font-medium transition-colors",
                isActive ? "text-primary font-semibold" : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            <Smartphone className="h-5 w-5" />
            设备
          </NavLink>
        </nav>
      </div>
    </div>
  );
}
