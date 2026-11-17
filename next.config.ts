import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // بناء قياسي يعمل على Vercel مباشرة (دون standalone) — وفحص أنواع TypeScript مفروض أثناء البناء
  reactStrictMode: false,
  // نُبقي حزم الاتصال بالمزودين خارج حِزَم التجميع — توافق أفضل مع serverless وترابط libSQL عبر HTTP
  serverExternalPackages: ["@libsql/client", "@modelcontextprotocol/sdk"],
};

export default nextConfig;
