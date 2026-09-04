"use client";
import { useState, type FormEvent } from "react";

export function SupabaseLoginForm() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true); setError("");
    try {
      const response = await fetch("/auth/supabase/signin", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json", "x-ttq-request": "ledger-v1" },
        body: JSON.stringify({ email: data.get("email"), password: data.get("password") }),
      });
      const payload = await response.json();
      if (!response.ok || payload.location !== "/ledger") throw new Error(payload.error?.message || "登录未完成，请重试");
      form.reset();
      window.location.assign("/ledger");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "暂时无法登录"); setBusy(false); }
  }
  return <form className="supabase-login" onSubmit={submit} aria-busy={busy}>
    <label htmlFor="login-email">邮箱</label>
    <input id="login-email" name="email" type="email" autoComplete="username" required maxLength={254} disabled={busy} />
    <label htmlFor="login-password">密码</label>
    <input id="login-password" name="password" type="password" autoComplete="current-password" required maxLength={1024} disabled={busy} />
    <button className="action action-primary" type="submit" disabled={busy}>{busy ? "正在登录…" : "登录到账本"}</button>
    {error ? <p className="auth-error" role="alert">{error}</p> : null}
    <p className="auth-copy">账号由管理员开通；忘记密码请联系管理员。</p>
  </form>;
}
