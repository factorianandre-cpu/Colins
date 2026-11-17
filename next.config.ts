import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // بناء قياسي يعمل على Vercel مباشرة (دون standalone) — وفحص أنواع TypeScript مفروض أثناء البناء
  reactStrictMode: false,
};

export default nextConfig;
