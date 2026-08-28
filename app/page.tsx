import { SupabaseLoginForm } from "./supabase-login-form";
import { headers } from "next/headers";
import { authLogoutPath } from "../lib/auth/logout";
import { INTERNAL_AUTH_HEADERS } from "../lib/server/auth";
import {
  chatGPTSignInPath,
  getChatGPTUser,
} from "./chatgpt-auth";
import { AuthPostButton } from "./auth-post-button";

export const dynamic = "force-dynamic";

const LEDGER_PATH = "/ledger";

function isLocalHost(host: string | null): boolean {
  if (!host) return false;

  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === "localhost" ||
    normalizedHost.startsWith("localhost:") ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost.startsWith("127.0.0.1:") ||
    normalizedHost === "[::1]" ||
    normalizedHost.startsWith("[::1]:")
  );
}

export default async function LoginPage() {
  const [user, requestHeaders] = await Promise.all([
    getChatGPTUser(),
    headers(),
  ]);
  const authMode =
    requestHeaders.get(INTERNAL_AUTH_HEADERS.mode) ??
    process.env.TTQ_AUTH_MODE;
  const showLocalSignIn =
    !user &&
    authMode === "local" &&
    process.env.NODE_ENV !== "production" &&
    isLocalHost(requestHeaders.get("host"));
  const showSitesSignIn = !user && authMode === "sites";
  const showSupabaseSignIn = !user && authMode === "supabase";
  const showCloudbaseSignIn = !user && authMode === "cloudbase";

  return (
    <main className="login-page">
      <div className="ink-wash ink-wash-one" aria-hidden="true" />
      <div className="ink-wash ink-wash-two" aria-hidden="true" />

      <div className="login-frame">
        <header className="brand-block" aria-labelledby="page-title">
          <div className="brand-line">
            <span className="brand-mark hand" aria-hidden="true">
              趟
            </span>
            <p className="eyebrow">给跑车人用的云账本</p>
          </div>

          <h1 id="page-title" className="display">
            趟趟清
            <span>货运账本</span>
          </h1>

          <p className="brand-promise">
            上车就记，收车就清。
            <br />
            登录后，账本可跨设备保存。
          </p>

          <div className="road-rule" aria-hidden="true">
            <span />
          </div>
        </header>

        <section className="auth-card" aria-labelledby="auth-title">
          <div className="auth-card-inner">
            {user ? (
              <>
                <p className="status-line">
                  <span aria-hidden="true">✓</span>
                  已登录
                </p>
                <h2 id="auth-title" className="display">
                  继续记今天的账
                </h2>
                <p className="auth-copy">
                  <strong>{user.displayName}</strong>
                  ，账本已经认出你了。进去后可查看车队里的全部车辆。
                </p>

                <div className="auth-actions">
                  <a className="action action-primary" href={LEDGER_PATH}>
                    继续到账本
                    <span aria-hidden="true">→</span>
                  </a>
                  <AuthPostButton
                    className="action action-secondary"
                    action={authLogoutPath("/")}
                  >
                    退出这个账号
                  </AuthPostButton>
                </div>
              </>
            ) : (
              <>
                <p className="status-line">车队云端保存</p>
                <h2 id="auth-title" className="display">
                  登录后，账本跟着你走
                </h2>
                <p className="auth-copy">
                  趟次、收入、油费和维修都会保存到车队账本。换台手机，也能接着记。
                </p>

                <div className="auth-actions">
                  {showSupabaseSignIn ? <SupabaseLoginForm /> : null}
                  {showSitesSignIn ? (
                    <a
                      className="action action-primary"
                      href={chatGPTSignInPath(LEDGER_PATH)}
                    >
                      使用 ChatGPT 登录
                      <span aria-hidden="true">→</span>
                    </a>
                  ) : null}

                  {showCloudbaseSignIn ? (
                    <a
                      className="action action-primary"
                      href="/auth/cloudbase/login?return_to=/ledger"
                    >
                      使用微信登录
                      <span aria-hidden="true">→</span>
                    </a>
                  ) : null}

                  {showLocalSignIn ? (
                    <div className="local-access">
                      <span>仅本地测试</span>
                      <AuthPostButton
                        className="action action-primary"
                        action="/api/local-auth/signin?return_to=/ledger"
                      >
                        用 13800000000 进入
                      </AuthPostButton>
                    </div>
                  ) : null}

                  {!showSitesSignIn && !showCloudbaseSignIn && !showLocalSignIn && !showSupabaseSignIn ? (
                    <p className="auth-error" role="alert">
                      认证模式尚未配置，账本保持锁定。
                    </p>
                  ) : null}
                </div>
              </>
            )}

            <dl className="trust-list">
              <div>
                <dt>账本归车队</dt>
                <dd>你记下的数据会汇总到所属车队，不绑在邮箱上。</dd>
              </div>
              <div>
                <dt>身份每次核对</dt>
                <dd>打开和保存账本时，都会重新确认你在车队里的权限。</dd>
              </div>
            </dl>
          </div>
        </section>

        <footer className="page-note">
          <p>登录只用于确认记账人和车队归属。</p>
          <p>第一阶段先向车主开放，司机账号与车辆分配稍后接入。</p>
        </footer>
      </div>
    </main>
  );
}
