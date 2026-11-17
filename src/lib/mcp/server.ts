/**
 * خادم MCP — media-generator-mcp v1.2.0
 * نستخدم SDK الرسمي حصرًا: McpServer + WebStandardStreamableHTTPServerTransport
 * (هو نفس قلب StreamableHTTPServerTransport الرسمي — نسخة بمعايير Web Request/Response
 * المبنية لبيئات مثل Next.js App Router وVercel، دون أي كتابة JSON-RPC يدوية).
 *
 * الأدوات الخمس مسجلة بأوصافها الإنجليزية الدقيقة (يقرأها العميل)، أما نتائج الاستدعاء
 * فتُصاغ بالعربية. نستبدل معالج CallTool الافتراضي بمعالج موحد يعطي رسائل عربية
 * للأدوات المجهولة والمعطيات غير الصالحة، ويعهد بالمهام المسجلة لنفس مستدعيات الأدوات.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { CallToolResult, ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { runGeneration, refreshTask, type ProgressCb } from "@/lib/generation";
import { runMerge } from "@/lib/merger";
import { getTask, listRecentTasks } from "@/lib/turso";
import { fmtTaskResult, fmtFailed, fmtMediaList } from "@/lib/format";

export const SERVER_INFO = { name: "media-generator-mcp", version: "1.2.0" } as const;

/** التعليمات الجاهزة المُرسلة مع initialize (نص المواصفة حرفيًا) */
export const SERVER_INSTRUCTIONS = `AI media generation server (kie.ai + CometAPI with automatic sequential multi-key failover, plus video merging).
Workflow: call generate_image or generate_video. If the response contains finished URLs, show them to the user.
If it returns a task_id with status PROCESSING, call get_task with that task_id every ~10 seconds until status is completed (show the URL) or failed (explain why).
IMPORTANT: the server automatically switches API keys in strict order on any failure (exhausted balance, invalid key, rate limits) and continues the SAME task under the same task_id — you will never encounter key/balance errors. Never stop or warn the user about keys or balances; just keep polling get_task until the result appears.
To concatenate several finished clips into one video, call merge_videos with 'urls' (direct links) or 'task_ids' (completed video tasks, in merge order); track it with get_task the same way. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.
Use list_media to recall previously generated media from the database.`;

type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type ToolCb = (args: unknown, extra: ToolExtra) => Promise<CallToolResult>;

/** بناء كائن الإشعار التقدمي من _meta.progressToken إن زوّد العميل الطلب به */
function progressCbFromExtra(extra: ToolExtra, _label: string): ProgressCb | undefined {
  const meta = (extra as unknown as { _meta?: Record<string, unknown> })._meta;
  const token = meta?.progressToken as string | number | undefined;
  if (token === undefined || token === null) return undefined;
  return async (p) => {
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: { progressToken: token, progress: p.progress, total: p.total, message: p.message },
      });
    } catch {
      // فشل بث التقدم لا يكسر المهمة أبدًا
    }
  };
}

/** نتائج الأدوات تُعاد كمحتوى نصي */
function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError: true } : {}) };
}

export function buildMcpServer(): McpServer {
  const server = new McpServer(SERVER_INFO, { instructions: SERVER_INSTRUCTIONS });

  // سجل الأدوات المحلي: اسم → (مخطط zod, مستدعي) — يُستخدم في معالج CallTool الموحد
  const registry = new Map<string, { schema: z.ZodTypeAny; cb: ToolCb }>();

  function register(
    name: string,
    description: string,
    shape: z.ZodRawShape,
    cb: ToolCb
  ) {
    // نستخدم registerTool الرسمي كي تُعرض الأدوات بمخططاتها في tools/list
    server.registerTool(name, { description, inputSchema: shape }, async (args, extra) => cb(args, extra));
    registry.set(name, { schema: z.object(shape), cb });
  }

  /* ==================== 1) generate_image ==================== */
  register(
    "generate_image",
    "Generate an image with gpt-image-2-6/flare-text-to-image (automatic sequential failover across all active keys). " +
      "Returns the finished image URL immediately if it completes within the wait window; otherwise returns a task_id — " +
      "call get_task every ~10 seconds until completed, then show the URL and stop.",
    {
      prompt: z.string().min(1).describe("What to draw. Detailed prompts give better results."),
      model: z
        .enum(["gpt-image-2-6/flare-text-to-image", "gpt-image-2.6/flare-text-to-image"])
        .default("gpt-image-2-6/flare-text-to-image"),
      aspect_ratio: z
        .enum(["auto", "1:1", "3:2", "2:3", "4:3", "3:4", "5:4", "4:5", "16:9", "9:16", "2:1", "1:2", "21:9", "9:21", "3:1", "1:3"])
        .default("auto"),
      resolution: z.enum(["1K", "2K", "4K"]).default("1K"),
      background: z.enum(["auto", "transparent", "opaque"]).default("auto").describe("Only applied at 1K."),
      output_format: z.enum(["png", "jpeg", "webp", "gif"]).default("png"),
      wait_seconds: z.number().int().min(0).max(240).default(90),
    },
    async (rawArgs, extra) => {
      const args = rawArgs as {
        prompt: string;
        model?: string;
        aspect_ratio?: string;
        resolution?: string;
        background?: string;
        output_format?: string;
        wait_seconds?: number;
      };
      const outcome = await runGeneration({
        type: "image",
        args: { ...args, prompt: args.prompt },
        progressCb: progressCbFromExtra(extra, "الصورة"),
      });
      switch (outcome.kind) {
        case "bad_model":
          return textResult(outcome.message, true);
        case "no_keys":
          return textResult(
            `❌ لا توجد مفاتيح نشطة لخدمة ${outcome.model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
            true
          );
        case "failed":
          return textResult(fmtFailed(outcome.message), true);
        case "completed":
        case "processing":
          return textResult(fmtTaskResult(outcome.task).text, fmtTaskResult(outcome.task).isError);
      }
    }
  );

  /* ==================== 2) generate_video ==================== */
  register(
    "generate_video",
    "Generate a video with grok-imagine-video-1-5-preview (native synchronized audio: dialogue/effects/music; optional image-to-video). " +
      "Video takes minutes: short wait with live progress streaming, then a task_id — track with get_task every ~10 seconds.",
    {
      prompt: z.string().max(4096).describe("Scene description. Dialogue in the prompt is spoken in the video."),
      image_url: z.string().optional().describe("Optional public image URL as the first frame (image-to-video)."),
      model: z
        .enum(["grok-imagine-video-1-5-preview", "grok-imagine-video-1.5-preview"])
        .default("grok-imagine-video-1-5-preview"),
      aspect_ratio: z.enum(["auto", "1:1", "16:9", "9:16", "3:2", "2:3"]).default("auto"),
      resolution: z.enum(["480p", "720p", "1080p"]).default("480p"),
      enable_audio: z.boolean().default(true),
      duration: z.number().int().min(1).max(15).default(8).describe("Duration in seconds."),
      wait_seconds: z.number().int().min(0).max(240).default(25),
    },
    async (rawArgs, extra) => {
      const args = rawArgs as {
        prompt: string;
        image_url?: string;
        model?: string;
        aspect_ratio?: string;
        resolution?: string;
        enable_audio?: boolean;
        duration?: number;
        wait_seconds?: number;
      };
      const outcome = await runGeneration({
        type: "video",
        args: { ...args, prompt: args.prompt },
        progressCb: progressCbFromExtra(extra, "الفيديو"),
      });
      switch (outcome.kind) {
        case "bad_model":
          return textResult(outcome.message, true);
        case "no_keys":
          return textResult(
            `❌ لا توجد مفاتيح نشطة لخدمة ${outcome.model}. أضف مفتاحًا واحدًا على الأقل من واجهة الإدارة، ثم أعد المحاولة.`,
            true
          );
        case "failed":
          return textResult(fmtFailed(outcome.message), true);
        case "completed":
        case "processing":
          return textResult(fmtTaskResult(outcome.task).text, fmtTaskResult(outcome.task).isError);
      }
    }
  );

  /* ==================== 3) merge_videos ==================== */
  register(
    "merge_videos",
    "Merge multiple clips into ONE final video in the given order. Pass 'urls' (public direct video URLs — e.g. from generate_video) " +
      "or 'task_ids' (COMPLETED video generation tasks — their result URLs are resolved from the database in this order; ideal after " +
      "generating several clips). Merging is usually fast: short wait with live progress streaming, then a merge task_id — track it " +
      "with get_task. Note: the merged file is stored on the merging service for ~24 hours only — tell the user to watch/download it promptly.",
    {
      urls: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe("Public direct video URLs (http/https) in merge order — the first clip starts the final video."),
      task_ids: z
        .array(z.string())
        .min(2)
        .max(10)
        .optional()
        .describe("Alternative to urls: task_ids of COMPLETED video generation tasks — their result URLs are merged in this order."),
      wait_seconds: z.number().int().min(0).max(240).default(60),
    },
    async (rawArgs, extra) => {
      const args = rawArgs as { urls?: string[]; task_ids?: string[]; wait_seconds?: number };
      if ((!args.urls || args.urls.length === 0) && (!args.task_ids || args.task_ids.length === 0)) {
        return textResult(
          "❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.",
          true
        );
      }
      const outcome = await runMerge({
        urls: args.urls ?? [],
        task_ids: args.task_ids ?? [],
        wait_seconds: args.wait_seconds,
        progressCb: progressCbFromExtra(extra, "الدمج"),
      });
      switch (outcome.kind) {
        case "service_unconfigured":
        case "validation_failed": {
          const details = outcome.details.length ? `\n\nتفاصيل المعرّفات/الروابط المرفوضة:\n${outcome.details.join("\n")}` : "";
          return textResult(outcome.message + details, true);
        }
        case "failed":
          return textResult(fmtFailed(outcome.message), true);
        case "completed":
        case "processing":
          return textResult(fmtTaskResult(outcome.task).text, fmtTaskResult(outcome.task).isError);
      }
    }
  );

  /* ==================== 4) get_task ==================== */
  register(
    "get_task",
    "Track any task by its id — image/video generation AND merging (reads the database and refreshes live from the provider/merging " +
      "service while still running). Poll it every ~10 seconds; when completed you will find the result URLs — show them to the user " +
      "and stop polling.",
    { task_id: z.string().describe("Task identifier returned by generate_image / generate_video / merge_videos.") },
    async (rawArgs) => {
      const { task_id } = rawArgs as { task_id: string };
      const task = await refreshTask(task_id);
      if (!task) {
        return textResult(`❌ لا توجد مهمة بهذا المعرّف: ${task_id}. تحقق من task_id أو اعرض المهام بأداة list_media.`, true);
      }
      const r = fmtTaskResult(task);
      return textResult(r.text, r.isError);
    }
  );

  /* ==================== 5) list_media ==================== */
  register(
    "list_media",
    "List the most recent images/videos/merges stored in the database with their URLs (no regeneration) — for recalling previously " +
      "generated media.",
    {
      type: z.enum(["image", "video", "merge"]).optional(),
      status: z.enum(["completed", "failed", "processing"]).optional(),
      limit: z.number().int().min(1).max(50).default(10),
    },
    async (rawArgs) => {
      const args = rawArgs as { type?: string; status?: string; limit?: number };
      const tasks = await listRecentTasks(Math.min(50, Math.max(1, args.limit ?? 10)), {
        type: args.type,
        status: args.status,
      });
      return textResult(fmtMediaList(tasks));
    }
  );

  /* ==================== معالج CallTool الموحد ==================== */
  // رسائل عربية للأدوات المجهولة والمعطيات غير الصالحة، وأي خطأ غير متوقع يخرج برسالة عامة
  // لا تكشف تفاصيل داخلية (أولًا: لا تُذكر مفاتيح أو رصيد مطلقًا).
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const name = request.params.name;

    // فحوص الدمج قبل zod: مخالفات الحدود تعيد الرسائل العربية الدقيقة من المواصفة
    // (المخطط المُعلن يظل minItems 2 / maxItems 10، لكن الاستخدام الفعلي يُقابل برسائل دقيقة)
    if (name === "merge_videos") {
      const a = (request.params.arguments ?? {}) as { urls?: unknown[]; task_ids?: unknown[] };
      const total = (a.urls?.length ?? 0) + (a.task_ids?.length ?? 0);
      if (total > 10) {
        return textResult("❌ أقصى عدد مقاطع للدمج هو 10 (خدمة الدمج تقبل 10 مقاطع كحد أقصى).", true);
      }
      if (total < 2) {
        return textResult("❌ الدمج يحتاج مقطعَين على الأقل. مرّر urls (روابط مباشرة) أو task_ids لمهام مكتملة.", true);
      }
    }

    const tool = registry.get(name);
    if (!tool) {
      return textResult(`❌ أداة غير معروفة: ${name}. المتاح: ${[...registry.keys()].join("، ")}`, true);
    }
    const parsed = tool.schema.safeParse(request.params.arguments ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => `${i.path.length ? i.path.join(".") : "المعطيات"}: ${i.message}`)
        .join("؛ ");
      return textResult(`❌ معطيات غير صالحة للأداة ${name}: ${issues}`, true);
    }
    try {
      return await tool.cb(parsed.data, extra);
    } catch (e) {
      // أي خطأ غير متوقع: رسالة عامة دون تفاصيل داخلية
      return textResult("❌ فشلت المهمة: خطأ داخلي غير متوقع — أعد المحاولة بعد قليل.", true);
    }
  });

  return server;
}
