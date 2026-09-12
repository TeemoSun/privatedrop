import { useEffect, useState, type FormEvent } from "react";
import { useMutation } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";

import { api, setDeviceName, setTokens } from "../lib/api";
import { detectDeviceNameAsync, detectDeviceNameSync } from "../lib/device";
import { useI18n } from "../lib/i18n";
import { Button } from "../components/ui/Button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/Card";
import { Input } from "../components/ui/Input";
import { Spinner } from "../components/ui/Misc";

export function Login() {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceNameInput] = useState(() => detectDeviceNameSync());
  const [isCustomName, setIsCustomName] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (localStorage.getItem("pd_device_name")) return;

    detectDeviceNameAsync().then((detected) => {
      if (!isCustomName && detected) {
        setDeviceNameInput(detected);
      }
    });
  }, [isCustomName]);

  const mutation = useMutation({
    mutationFn: async (pwd: string) => {
      const finalName = deviceName.trim() || detectDeviceNameSync();
      setDeviceName(finalName);
      return api.login(pwd);
    },
    onSuccess: (data) => {
      setTokens(data.access_token, data.refresh_token);
      navigate("/", { replace: true });
    },
  });

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!password) return;
    mutation.mutate(password);
  };

  return (
    <div className="fixed inset-0 flex items-center justify-center bg-muted/30 px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>PrivateDrop</CardTitle>
          <CardDescription>{t("login.subtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="flex flex-col gap-3">
            <Input
              type="text"
              placeholder={t("login.deviceName")}
              value={deviceName}
              maxLength={255}
              onChange={(e) => {
                setIsCustomName(true);
                setDeviceNameInput(e.target.value);
              }}
            />
            <Input
              type="password"
              placeholder={t("login.password")}
              value={password}
              autoFocus
              onChange={(e) => setPassword(e.target.value)}
            />
            {mutation.isError && (
              <p className="text-xs text-destructive">
                {(mutation.error as Error).message === "invalid password"
                  ? t("login.invalidPassword")
                  : t("login.loginFailed")}
              </p>
            )}
            <Button type="submit" disabled={mutation.isPending || !password}>
              {mutation.isPending && <Spinner />}
              {t("login.submit")}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
