import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { WsProvider } from "./hooks/useWs";
import { getAccessToken } from "./lib/api";
import { DropBoard } from "./pages/DropBoard";
import { Login } from "./pages/Login";
import { Manage } from "./pages/Manage";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => !!getAccessToken());

  useEffect(() => {
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener("pd:unauthorized", onUnauthorized);
    return () => window.removeEventListener("pd:unauthorized", onUnauthorized);
  }, []);

  return authed ? <WsProvider>{children}</WsProvider> : <Navigate to="/login" replace />;
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        element={
          <RequireAuth>
            <AppShell />
          </RequireAuth>
        }
      >
        <Route path="/" element={<DropBoard isEphemeral={true} />} />
        <Route path="/timeline" element={<DropBoard isEphemeral={false} />} />
        <Route path="/secret" element={<DropBoard isEphemeral={false} isSecret={true} />} />
        <Route path="/manage/*" element={<Manage />} />
        <Route path="/devices" element={<Navigate to="/manage/devices" replace />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
