import { useEffect, useState } from "react";
import { Navigate, Route, Routes } from "react-router-dom";

import { AppShell } from "./components/AppShell";
import { getAccessToken } from "./lib/api";
import { Devices } from "./pages/Devices";
import { DropBoard } from "./pages/DropBoard";
import { Login } from "./pages/Login";

function RequireAuth({ children }: { children: React.ReactNode }) {
  const [authed, setAuthed] = useState(() => !!getAccessToken());

  useEffect(() => {
    const onUnauthorized = () => setAuthed(false);
    window.addEventListener("pd:unauthorized", onUnauthorized);
    return () => window.removeEventListener("pd:unauthorized", onUnauthorized);
  }, []);

  return authed ? <>{children}</> : <Navigate to="/login" replace />;
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
        <Route path="/" element={<DropBoard />} />
        <Route path="/devices" element={<Devices />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
