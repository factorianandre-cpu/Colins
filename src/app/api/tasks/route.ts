/**
 * GET /api/tasks — لوحة المهام للواجهة: إحصائيات + أحدث المهام (حد أقصى 50).
 * لا تكشف أي بيانات حساسة: الرسائل الداخلية فقط وعدد المحاولات.
 */
import { NextResponse } from "next/server";
import { listRecentTasks, taskStats, parseTaskUrls, parseTaskAttempts } from "@/lib/turso";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const limit = Math.min(50, Math.max(1, Number(url.searchParams.get("limit") ?? 20)));
  const type = url.searchParams.get("type") ?? undefined;
  const status = url.searchParams.get("status") ?? undefined;

  const [stats, tasks] = await Promise.all([
    taskStats(),
    listRecentTasks(limit, {
      type: type && ["image", "video", "merge"].includes(type) ? type : undefined,
      status: status && ["completed", "failed", "processing", "pending"].includes(status) ? status : undefined,
    }),
  ]);

  return NextResponse.json(
    {
      stats,
      tasks: tasks.map((t) => ({
        id: t.id,
        provider: t.provider,
        model: t.model,
        type: t.type,
        status: t.status,
        progress: t.progress,
        prompt: (t.prompt || "").slice(0, 140),
        resultUrls: parseTaskUrls(t),
        errorMessage: t.error_message,
        attemptsCount: parseTaskAttempts(t).length,
        createdAt: t.created_at,
        completedAt: t.completed_at,
      })),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}
