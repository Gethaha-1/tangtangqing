"use client";

import { useState } from "react";

type AuthPostButtonProps = {
  action: string;
  className: string;
  children: React.ReactNode;
};

export function AuthPostButton({
  action,
  className,
  children,
}: AuthPostButtonProps) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(action, {
        method: "POST",
        credentials: "same-origin",
        headers: {
          "content-type": "application/json",
          "x-ttq-request": "ledger-v1",
        },
        body: "{}",
      });
      const payload = await response.json() as {
        location?: string;
        error?: { message?: string };
      };
      if (!response.ok || !payload.location) {
        throw new Error(payload.error?.message || "认证请求失败");
      }
      window.location.assign(payload.location);
    } catch (cause) {
      setBusy(false);
      setError(cause instanceof Error ? cause.message : "认证请求失败");
    }
  }

  return (
    <>
      <button
        className={className}
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={submit}
      >
        {busy ? "正在处理…" : children}
      </button>
      {error ? <p className="auth-error" role="alert">{error}</p> : null}
    </>
  );
}
