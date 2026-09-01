import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/ledger",
    name: "趟趟清 · 货运账本",
    short_name: "趟趟清",
    description: "上车就记，收车就清。登录后账本可跨设备安全保存。",
    start_url: "/ledger",
    scope: "/",
    display: "standalone",
    orientation: "portrait-primary",
    background_color: "#F1EBDC",
    theme_color: "#A63A2E",
    categories: ["business", "finance", "productivity"],
    prefer_related_applications: false,
    icons: [
      {
        src: "/icons/ttq-192.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/ttq-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
      {
        src: "/icons/ttq-512.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "maskable",
      },
    ],
  };
}
