/**
 * مسار /mcp — خادم MCP بنقل Streamable HTTP عبر SDK الرسمي.
 *
 * نمط stateless: كل طلب POST/GET/DELETE ينشئ زوجًا جديدًا (McpServer + Transport)
 * لأن WebStandardStreamableHTTPServerTransport في الوضع عديم الجلسة لا يُعاد استخدامه
 * بين الطلبات (قيد SDK الصريح) — حالة المهام كلها في Turso لا في الذاكرة،
 * لذا هذا النمط آمن ومناسب تمامًا لبيئات serverless مثل Vercel.
 *
 * عمليات POST تأخذ JSON-RPC وترجع SSE streaming (يدعم progress notifications
 * أثناء نافذة الانتظار عبر _meta.progressToken)، وDELETE ينهي الجلسة.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { buildMcpServer } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 60 ثانية = الحد الآمن لكل خطط Vercel (تعمل على Hobby وPro دون رفض النشر).
// نوافذ الانتظار داخل الطلب مقصوصة على 40 ثانية لتبقى ضمن هذه المهلة،
// والمتابعة تكمل دائمًا عبر get_task (حالة المهمة كلها في Turso وليست في الذاكرة).
export const maxDuration = 60;

/** حماية اختيارية بـ Bearer token عند ضبط MCP_ACCESS_TOKEN */
function authorized(req: Request): boolean {
  const token = process.env.MCP_ACCESS_TOKEN;
  if (!token) return true;
  const auth = req.headers.get("authorization") ?? "";
  return auth === `Bearer ${token}`;
}

function unauthorizedResponse(): Response {
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      error: { code: -32001, message: "مطلوب تصريح: أرسل الترويسة Authorization: Bearer <MCP_ACCESS_TOKEN>" },
      id: null,
    }),
    { status: 401, headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer" } }
  );
}

async function handle(req: Request): Promise<Response> {
  if (!authorized(req)) return unauthorizedResponse();

  try {
    // زوج جديد لكل طلب — stateless حسب مواصفة Streamable HTTP
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // بلا جلسات: كل POST مستقل ويعمل على Vercel متعدد النسخ
      enableJsonResponse: false, // SSE streaming لدعم بث التقدم الحي
    });
    const server: McpServer = buildMcpServer();
    await server.connect(transport);

    // SDK يتولى كل شيء: التحقق، الجلسة، SSE، والرد — نمرر الطلب كما هو ونعيد الرد كما هو.
    // لا نستهلك response.body هنا إطلاقًا (البث يُقرأ مرة واحدة — تنظيف الجلسة يتكفل به SDK عبر cancel/close)
    return await transport.handleRequest(req);
  } catch (e) {
    // أخطاء إعداد غير متوقعة — رسالة عامة دون تفاصيل داخلية
    console.error("[mcp] خطأ غير متوقع في المسار:", e instanceof Error ? e.message : e);
    return new Response(
      JSON.stringify({ jsonrpc: "2.0", error: { code: -32603, message: "خطأ داخلي في الخادم" }, id: null }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
}

export async function POST(req: Request) {
  return handle(req);
}

// GET يفتح قناة SSE للاستماع (تُرجع 405 في النمط stateless حسب SDK) وDELETE ينهي الجلسة
export async function GET(req: Request) {
  return handle(req);
}

export async function DELETE(req: Request) {
  return handle(req);
}

// طلبات الاستكشاف (CORS preflight) — نسمح بها من أي أصل
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}
