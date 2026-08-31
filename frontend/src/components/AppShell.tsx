import { useCallback, useRef } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { LayoutDashboard, Lock, LogOut, Settings, Zap } from "lucide-react";

import { Button } from "./ui/Button";
import { api, clearTokens, getDeviceName } from "../lib/api";
import { unlockSecretSession } from "../lib/secretSession";
import { cn } from "../lib/utils";

function useTimelineLongPress() {
  const navigate = useNavigate();
  const timerRef = useRef<number | null>(null);
  const isLongPressRef = useRef(false);

  const start = useCallback(() => {
    isLongPressRef.current = false;
    if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    timerRef.current = window.setTimeout(() => {
      isLongPressRef.current = true;
      try {
        if ("vibrate" in navigator) {
          navigator.vibrate([40, 50, 40]);
        }
      } catch {}
      unlockSecretSession();
      navigate("/secret");
    }, 700);
  }, [navigate]);

  const clear = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const onClick = useCallback((e: React.MouseEvent) => {
    if (isLongPressRef.current) {
      e.preventDefault();
      e.stopPropagation();
      isLongPressRef.current = false;
    }
  }, []);

  return {
    onMouseDown: start,
    onMouseUp: clear,
    onMouseLeave: clear,
    onTouchStart: start,
    onTouchEnd: clear,
    onTouchMove: clear,
    onClick,
  };
}

function SidebarNav() {
  const timelineLongPress = useTimelineLongPress();
  const location = useLocation();
  const isSecret = location.pathname === "/secret";

  const navClass = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-colors select-none",
      isActive
        ? "bg-accent text-accent-foreground"
        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
    );

  return (
    <nav className="flex flex-col gap-1">
      <NavLink to="/" end className={navClass}>
        <Zap className="h-4 w-4" />
        临时中转
      </NavLink>
      <NavLink
        to="/timeline"
        className={({ isActive }) => navClass({ isActive: isActive || isSecret })}
        {...timelineLongPress}
      >
        {isSecret ? <Lock className="h-4 w-4 text-primary" /> : <LayoutDashboard className="h-4 w-4" />}
        {isSecret ? "隐私时间线" : "时间线"}
      </NavLink>
      <NavLink to="/manage" className={navClass}>
        <Settings className="h-4 w-4" />
        管理
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
  const location = useLocation();
  const isSecret = location.pathname === "/secret";
  const timelineLongPress = useTimelineLongPress();

  return (
    <div className="fixed inset-0 flex overflow-hidden bg-background">
      <aside className="hidden w-56 shrink-0 flex-col border-r bg-card md:flex">
        <div className="border-b px-4 py-4">
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-bold tracking-tight">PrivateDrop</h1>
            {isSecret && <Lock className="h-4 w-4 text-muted-foreground" />}
          </div>
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

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="shrink-0 flex items-center justify-between border-b bg-card px-4 py-2.5 md:hidden">
          <div className="flex items-center gap-2">
            <h1 className="text-base font-bold">PrivateDrop</h1>
            {isSecret && <Lock className="h-3.5 w-3.5 text-muted-foreground" />}
            <span className="max-w-[140px] truncate text-xs text-muted-foreground">
              {getDeviceName()}
            </span>
          </div>
          <Button variant="ghost" size="icon" onClick={handleLogout} title="退出登录">
            <LogOut className="h-4 w-4" />
          </Button>
        </header>

        <main className="flex-1 min-h-0 flex flex-col overflow-hidden">
          <Outlet />
        </main>

        <nav className="shrink-0 flex items-center justify-around border-t bg-card py-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] md:hidden">
          <NavLink
            to="/"
            end
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center gap-1 py-1 text-xs font-medium transition-colors select-none",
                isActive ? "text-primary font-semibold" : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            <Zap className="h-5 w-5" />
            临时中转
          </NavLink>
          <NavLink
            to="/timeline"
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center gap-1 py-1 text-xs font-medium transition-colors select-none",
                isActive || isSecret ? "text-primary font-semibold" : "text-muted-foreground hover:text-foreground",
              )
            }
            {...timelineLongPress}
          >
            {isSecret ? <Lock className="h-5 w-5" /> : <LayoutDashboard className="h-5 w-5" />}
            {isSecret ? "隐私时间线" : "时间线"}
          </NavLink>
          <NavLink
            to="/manage"
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center gap-1 py-1 text-xs font-medium transition-colors select-none",
                isActive ? "text-primary font-semibold" : "text-muted-foreground hover:text-foreground",
              )
            }
          >
            <Settings className="h-5 w-5" />
            管理
          </NavLink>
        </nav>
      </div>
    </div>
  );
}
