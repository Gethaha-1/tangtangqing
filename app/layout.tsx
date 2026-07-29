import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "趟趟清 · 货运账本",
    template: "%s · 趟趟清",
  },
  description: "登录趟趟清，让车队账本跨设备安全保存。",
  applicationName: "趟趟清",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "light dark",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F1EBDC" },
    { media: "(prefers-color-scheme: dark)", color: "#10131B" },
  ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body className="theme-auto">{children}</body>
    </html>
  );
}
