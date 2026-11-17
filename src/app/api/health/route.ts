/**
 * GET /api/health — حالة النظام للواجهة وأدوات المراقبة.
 * يفحص Turso (SELECT 1) وخدمة الدمج (GET {MERGER_API_BASE}/api/config بمهلة 4 ثوانٍ).
 */
import { NextResponse } from "next/server";
import { dbHealthy } from "@/lib/turso";
import { checkMergerHealth, mergerBase } from "@/lib/merger";
import { MODELS } from "@/lib/models";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const [dbOk, mergerHealthy] = await Promise.all([dbHealthy(), checkMergerHealth()]);

  return NextResponse.json(
    {
      ok: dbOk,
      database: dbOk ? "turso-connected" : "turso-error",
      mcpEndpoint: "/mcp",
      models: MODELS.map((m) => ({ canonical: m.canonical, type: m.type, providers: m.providers })),
      merger: { base: mergerBase() || null, healthy: mergerHealthy },
      authRequired: Boolean(process.env.MCP_ACCESS_TOKEN),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
