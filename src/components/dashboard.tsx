"use client";

/**
 * لوحة التحكم — واجهة عربية RTL من ثلاث بطاقات:
 * (أ) مدير المفاتيح — التجربة تسلسلية حسب ترتيب الإضافة مع تبديل تلقائي.
 * (ب) لوحة المهام — إحصائيات وقائمة تتحدث تلقائيًا كل ~5 ثوانٍ.
 * (ج) ربط السيرفر — الرابط المطلق لـ /mcp و JSON جاهز للنسخ لكل عميل.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import {
  Activity,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  PauseCircle,
  PlayCircle,
  Plug,
  RefreshCw,
  Trash2,
} from "lucide-react";

interface HealthInfo {
  ok: boolean;
  database: string;
  mcpEndpoint: string;
  models: Array<{ canonical: string; type: string; providers: string[] }>;
  merger: { base: string | null; healthy: boolean };
  authRequired: boolean;
}

interface KeyItem {
  id: string;
  provider: string;
  label: string;
  maskedKey: string;
  status: string;
  usageCount: number;
  successCount: number;
  failCount: number;
  lastUsedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

interface TaskItem {
  id: string;
  provider: string | null;
  model: string;
  type: string;
  status: string;
  progress: number;
  prompt: string;
  resultUrls: string[];
  errorMessage: string | null;
  attemptsCount: number;
  createdAt: string;
}

interface TasksResponse {
  stats: { total: number; completed: number; failed: number; processing: number };
  tasks: TaskItem[];
}

const PROVIDER_LABEL: Record<string, string> = { kie: "kie.ai", cometapi: "CometAPI", merger: "خدمة الدمج" };
const TYPE_LABEL: Record<string, string> = { image: "صورة", video: "فيديو", merge: "دمج" };

function StatusBadge({ status }: { status: string }) {
  if (status === "active")
    return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">نشط</Badge>;
  if (status === "exhausted")
    return <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">مستنزف الرصيد</Badge>;
  if (status === "disabled")
    return <Badge className="bg-slate-500/15 text-slate-400 border-slate-500/30">معطّل</Badge>;
  return <Badge variant="outline">{status}</Badge>;
}

function TaskStatusBadge({ status, progress }: { status: string; progress?: number }) {
  if (status === "completed")
    return <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">مكتملة</Badge>;
  if (status === "failed")
    return <Badge className="bg-red-500/15 text-red-400 border-red-500/30">فاشلة</Badge>;
  if (status === "processing" || status === "pending")
    return (
      <Badge className="bg-sky-500/15 text-sky-400 border-sky-500/30">
        جارية{progress ? ` ${progress}%` : ""}
      </Badge>
    );
  return <Badge variant="outline">{status}</Badge>;
}

function CopyButton({ text, label }: { text: string; label?: string }) {
  const { toast } = useToast();
  const [copied, setCopied] = useState(false);
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="gap-1.5"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        } catch {
          toast({ title: "تعذر النسخ", description: "المتصفح منع الوصول للحافظة", variant: "destructive" });
        }
      }}
    >
      {copied ? <Check className="size-4 text-emerald-400" /> : <Copy className="size-4" />}
      {copied ? "تم النسخ" : label ?? "نسخ"}
    </Button>
  );
}

/* ============================ مدير المفاتيح ============================ */

function KeyManagerCard({ onChange }: { onChange?: () => void }) {
  const { toast } = useToast();
  const [keys, setKeys] = useState<KeyItem[]>([]);
  const [provider, setProvider] = useState("kie");
  const [label, setLabel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/keys", { cache: "no-store" });
      const data = (await res.json()) as { keys: KeyItem[] };
      setKeys(data.keys ?? []);
    } catch {
      /* الشبكة تعود لاحقًا — التحديث التلقائي يعيد المحاولة */
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 8000);
    return () => clearInterval(t);
  }, [load]);

  async function addKey() {
    if (!apiKey.trim()) {
      toast({ title: "أدخل المفتاح أولًا", variant: "destructive" });
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, api_key: apiKey.trim(), label: label.trim() }),
      });
      const data = (await res.json()) as { ok?: boolean; error?: string };
      if (!res.ok) {
        toast({ title: "تعذرت إضافة المفتاح", description: data.error, variant: "destructive" });
      } else {
        toast({ title: "أُضيف المفتاح", description: "سيُجرَّب أولًا في الترتيب التسلسلي حسب تاريخ الإضافة" });
        setApiKey("");
        setLabel("");
        onChange?.();
      }
      load();
    } finally {
      setBusy(false);
    }
  }

  async function toggleStatus(k: KeyItem) {
    const next = k.status === "disabled" ? "active" : "disabled";
    await fetch(`/api/keys/${k.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    toast({ title: next === "disabled" ? "عُطّل المفتاح" : "نُشّط المفتاح" });
    load();
  }

  async function removeKey(k: KeyItem) {
    await fetch(`/api/keys/${k.id}`, { method: "DELETE" });
    toast({ title: "حُذف المفتاح" });
    load();
  }

  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-slate-100">
          <KeyRound className="size-5 text-emerald-400" /> مدير المفاتيح
        </CardTitle>
        <CardDescription className="text-slate-400 leading-relaxed">
          أضف عدة مفاتيح لكل مزود — التجربة تسلسلية (أول مفتاح ثم التالي ثم التالي) مع تبديل فوري
          تلقائي عند أي خطأ أو نفاد رصيد دون توقف.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* نموذج الإضافة */}
        <div className="grid gap-3 sm:grid-cols-[160px_1fr_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label className="text-slate-300">المزود</Label>
            <Select value={provider} onValueChange={setProvider}>
              <SelectTrigger className="w-full bg-slate-950 border-slate-700 text-slate-100">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="kie">kie.ai</SelectItem>
                <SelectItem value="cometapi">CometAPI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label className="text-slate-300">تسمية اختيارية</Label>
            <Input
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="مثال: المفتاح الرئيسي"
              className="bg-slate-950 border-slate-700 text-slate-100"
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-slate-300">مفتاح API</Label>
            <Input
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="ألصق المفتاح هنا"
              type="password"
              className="bg-slate-950 border-slate-700 text-slate-100 font-mono"
              onKeyDown={(e) => e.key === "Enter" && addKey()}
            />
          </div>
          <Button onClick={addKey} disabled={busy} className="bg-emerald-600 hover:bg-emerald-500 text-white">
            {busy ? "جارٍ…" : "إضافة"}
          </Button>
        </div>

        {/* قائمة المفاتيح */}
        <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-800">
          {keys.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-500">لا توجد مفاتيح بعد — أضف أول مفتاح من النموذج أعلاه.</p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {keys.map((k, i) => (
                <li key={k.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-xs text-slate-500">#{i + 1}</span>
                    <Badge variant="outline" className="border-slate-600 text-slate-300">
                      {PROVIDER_LABEL[k.provider] ?? k.provider}
                    </Badge>
                    <StatusBadge status={k.status} />
                    {k.label && <span className="text-sm text-slate-300">{k.label}</span>}
                    <code className="text-xs text-slate-400 font-mono" dir="ltr">
                      {k.maskedKey}
                    </code>
                    <span className="ms-auto flex items-center gap-1.5">
                      <Button size="icon" variant="ghost" title={k.status === "disabled" ? "تنشيط" : "تعطيل"} onClick={() => toggleStatus(k)}>
                        {k.status === "disabled" ? <PlayCircle className="size-4 text-emerald-400" /> : <PauseCircle className="size-4 text-amber-400" />}
                      </Button>
                      <Button size="icon" variant="ghost" title="حذف" onClick={() => removeKey(k)}>
                        <Trash2 className="size-4 text-red-400" />
                      </Button>
                    </span>
                  </div>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-400">
                    <span>استخدام: {k.usageCount}</span>
                    <span className="text-emerald-400">نجاح: {k.successCount}</span>
                    <span className="text-red-400">فشل: {k.failCount}</span>
                    <span>آخر استخدام: {k.lastUsedAt ? k.lastUsedAt.slice(0, 16).replace("T", " ") + "Z" : "—"}</span>
                    {k.lastError && <span className="text-amber-400" dir="auto">آخر خطأ: {k.lastError}</span>}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================ لوحة المهام ============================ */

function TasksCard() {
  const [data, setData] = useState<TasksResponse | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/tasks?limit=20", { cache: "no-store" });
      setData((await res.json()) as TasksResponse);
    } catch {
      /* التحديث التالي يعيد المحاولة */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  const stats = data?.stats ?? { total: 0, completed: 0, failed: 0, processing: 0 };

  const chips: Array<[string, number, string]> = [
    ["الإجمالي", stats.total, "bg-slate-500/15 text-slate-300 border-slate-600"],
    ["مكتملة", stats.completed, "bg-emerald-500/15 text-emerald-400 border-emerald-500/30"],
    ["فاشلة", stats.failed, "bg-red-500/15 text-red-400 border-red-500/30"],
    ["جارية", stats.processing, "bg-sky-500/15 text-sky-400 border-sky-500/30"],
  ];

  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardHeader className="flex-row items-start justify-between space-y-0">
        <div className="space-y-1.5">
          <CardTitle className="flex items-center gap-2 text-slate-100">
            <Activity className="size-5 text-emerald-400" /> لوحة المهام
          </CardTitle>
          <CardDescription className="text-slate-400">
            أحدث المهام تتحدث تلقائيًا كل ~5 ثوانٍ — الروابط تُفتح عند الاكتمال.
          </CardDescription>
        </div>
        <Button variant="ghost" size="icon" onClick={load} title="تحديث الآن">
          <RefreshCw className="size-4 text-slate-400" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* شرائح الإحصائيات */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {chips.map(([name, value, cls]) => (
            <div key={name} className={`rounded-lg border px-3 py-2 text-center ${cls}`}>
              <div className="text-lg font-bold">{value}</div>
              <div className="text-xs opacity-80">{name}</div>
            </div>
          ))}
        </div>

        {/* قائمة المهام */}
        <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-800">
          {loading ? (
            <p className="p-6 text-center text-sm text-slate-500">جارٍ التحميل…</p>
          ) : !data?.tasks.length ? (
            <p className="p-6 text-center text-sm text-slate-500">
              لا توجد مهام بعد — استخدم أي عميل MCP لاستدعاء generate_image أو generate_video.
            </p>
          ) : (
            <ul className="divide-y divide-slate-800">
              {data.tasks.map((t) => (
                <li key={t.id} className="p-4 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline" className="border-slate-600 text-slate-300">{TYPE_LABEL[t.type] ?? t.type}</Badge>
                    <TaskStatusBadge status={t.status} progress={t.progress} />
                    <code className="text-xs text-slate-400 font-mono">{t.model}</code>
                    <span className="ms-auto text-xs text-slate-500">{t.createdAt.slice(0, 16).replace("T", " ")}Z</span>
                  </div>
                  {t.status === "processing" && <Progress value={t.progress} className="h-1.5" />}
                  {t.prompt && <p className="text-sm text-slate-300 line-clamp-2" dir="auto">{t.prompt}</p>}
                  <div className="flex flex-wrap items-center gap-2 text-xs">
                    {t.resultUrls.map((u) => (
                      <a
                        key={u}
                        href={u}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center gap-1 text-emerald-400 hover:text-emerald-300 font-mono"
                        dir="ltr"
                      >
                        <ExternalLink className="size-3.5" /> فتح النتيجة
                      </a>
                    ))}
                    {t.errorMessage && <span className="text-red-400" dir="auto">الخطأ: {t.errorMessage}</span>}
                    <span className="text-slate-500">محاولات: {t.attemptsCount}</span>
                    <code className="text-slate-600 font-mono" dir="ltr">{t.id.slice(0, 8)}…</code>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================ بطاقة الربط ============================ */

// مستمع ثابت بلا أحداث — القيمة (origin) لا تتغير عبر عمر الصفحة، والنمط المعتمد لـ useSyncExternalStore
const subscribeNoop = () => () => {};

const TOOL_CHIPS: Array<[string, string]> = [
  ["generate_image", "توليد صورة من وصف نصي عبر gpt-image-2-6/flare-text-to-image"],
  ["generate_video", "توليد فيديو مع صوت متزامن أصلي، مع image-to-video اختياري"],
  ["merge_videos", "دمج حتى 10 مقاطع في مقطع واحد نهائي بالترتيب المعطى"],
  ["get_task", "متابعة أي مهمة بمعرّفها حتى الاكتمال وعرض روابط النتائج"],
  ["list_media", "استرجاع أحدث الوسائط المخزنة بروابطها دون إعادة توليد"],
];

function ConnectCard({ health }: { health: HealthInfo | null }) {
  // قراءة origin المتصفح بالنمط المعتمد للقيم التي لا تُتاح أثناء SSR —
  // لا فرق في الترطيب لأن useSyncExternalStore يعيد السnapshot الخادمي "" أولًا
  const origin = useSyncExternalStore(subscribeNoop, () => window.location.origin, () => "");
  const mcpUrl = `${origin}/mcp`;

  const headersJson = health?.authRequired
    ? `,\n        "headers": {\n          "Authorization": "Bearer <ضع قيمة MCP_ACCESS_TOKEN هنا>"\n        }`
    : "";

  const chatgptJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${headersJson}\n    }\n  }\n}`;
  const claudeJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "type": "http",\n      "url": "${mcpUrl}"${headersJson}\n    }\n  }\n}`;
  const cursorJson = `{\n  "mcpServers": {\n    "media-generator": {\n      "url": "${mcpUrl}"${headersJson}\n    }\n  }\n}`;

  return (
    <Card className="border-slate-800 bg-slate-900/60">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-slate-100">
          <Plug className="size-5 text-emerald-400" /> ربط السيرفر
        </CardTitle>
        <CardDescription className="text-slate-400">
          الرابط المطلق لنقطة MCP مع إعدادات جاهزة للنسخ لأي عميل.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* الرابط المطلق */}
        <div className="flex flex-wrap items-center gap-2">
          <code
            dir="ltr"
            className="flex-1 min-w-[240px] rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-emerald-400 font-mono truncate"
          >
            {mcpUrl}
          </code>
          <CopyButton text={mcpUrl} label="نسخ الرابط" />
        </div>

        {/* تبويبات العملاء */}
        <Tabs defaultValue="chatgpt">
          <TabsList className="bg-slate-950 border border-slate-800">
            <TabsTrigger value="chatgpt" className="data-[state=active]:bg-slate-800">ChatGPT / GPT Agents</TabsTrigger>
            <TabsTrigger value="claude" className="data-[state=active]:bg-slate-800">Claude Desktop</TabsTrigger>
            <TabsTrigger value="cursor" className="data-[state=active]:bg-slate-800">Cursor / Windsurf / Cline</TabsTrigger>
          </TabsList>
          <TabsContent value="chatgpt" className="space-y-2">
            <p className="text-xs text-slate-400">
              في ChatGPT: Settings → Connectors → Create → Custom MCP server وضع الرابط في «Server URL».
            </p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-md border border-slate-700 bg-slate-950 p-3 text-xs text-slate-200 font-mono" dir="ltr">
                {chatgptJson}
              </pre>
              <div className="absolute top-2 left-2">
                <CopyButton text={chatgptJson} />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="claude" className="space-y-2">
            <p className="text-xs text-slate-400">ألصقه في ملف claude_desktop_config.json ثم أعد فتح التطبيق.</p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-md border border-slate-700 bg-slate-950 p-3 text-xs text-slate-200 font-mono" dir="ltr">
                {claudeJson}
              </pre>
              <div className="absolute top-2 left-2">
                <CopyButton text={claudeJson} />
              </div>
            </div>
          </TabsContent>
          <TabsContent value="cursor" className="space-y-2">
            <p className="text-xs text-slate-400">ألصقه في mcp.json (Cursor / Windsurf / Cline) ثم أعد تحميل النافذة.</p>
            <div className="relative">
              <pre className="overflow-x-auto rounded-md border border-slate-700 bg-slate-950 p-3 text-xs text-slate-200 font-mono" dir="ltr">
                {cursorJson}
              </pre>
              <div className="absolute top-2 left-2">
                <CopyButton text={cursorJson} />
              </div>
            </div>
          </TabsContent>
        </Tabs>

        {/* رقائق الأدوات */}
        <div className="flex flex-wrap gap-2">
          {TOOL_CHIPS.map(([name, desc]) => (
            <span
              key={name}
              className="inline-flex max-w-full flex-wrap items-baseline gap-x-2 rounded-full border border-slate-700 bg-slate-950 px-3 py-1.5 text-xs"
              title={desc}
            >
              <code className="text-emerald-400 font-mono" dir="ltr">{name}</code>
              <span className="text-slate-400">{desc}</span>
            </span>
          ))}
        </div>

        {/* ملاحظة الفيديو الكهرمانية */}
        <div className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm leading-relaxed text-amber-300">
          الفيديو يحتاج دقائق: يعيد السيرفر task_id فورًا، ويتابَع تلقائيًا بـ get_task كل 10 ثوانٍ — وعند اكتمال
          المهمة يُعرض الرابط في الدردشة ويتوقف. أثناء الانتظار يُبَث تقدم حي (Progress notifications) حتى لا
          تنقطع العملية.
        </div>
      </CardContent>
    </Card>
  );
}

/* ============================ اللوحة الرئيسية ============================ */

export default function Dashboard() {
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [tick, setTick] = useState(0);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health", { cache: "no-store" });
      if (res.ok) setHealth((await res.json()) as HealthInfo);
    } catch {
      /* انقطاع شبكة عابر — نحتفظ بآخر حالة معروفة بدل الفلاش إلى «غير متصل» */
    }
  }, []);

  useEffect(() => {
    // التحميل الأول عبر مؤقت — setState داخل callback مؤقت (النمط المعتمد للقاعدة) لا في جسم التأثير مباشرة
    const first = setTimeout(loadHealth, 0);
    const t = setInterval(loadHealth, 15000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [loadHealth]);

  const refreshAll = useCallback(() => setTick((x) => x + 1), []);

  return (
    <div className="flex min-h-screen flex-col bg-slate-950 text-slate-100" dir="rtl">
      {/* الهيدر */}
      <header className="sticky top-0 z-10 border-b border-slate-800 bg-slate-950/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3">
          <h1 className="text-lg font-extrabold">مولّد الوسائط — خادم MCP</h1>
          <div className="ms-auto flex flex-wrap items-center gap-2 text-xs">
            {health?.ok ? (
              <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">Turso متصل</Badge>
            ) : (
              <Badge className="bg-red-500/15 text-red-400 border-red-500/30">غير متصل</Badge>
            )}
            {health?.merger.base ? (
              health.merger.healthy ? (
                <Badge className="bg-emerald-500/15 text-emerald-400 border-emerald-500/30">خدمة الدمج جاهزة</Badge>
              ) : (
                <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">خدمة الدمج غير جاهزة</Badge>
              )
            ) : (
              <Badge className="bg-amber-500/15 text-amber-400 border-amber-500/30">MERGER_API_BASE غير مضبوط</Badge>
            )}
            {health?.authRequired && <Badge variant="outline" className="border-slate-600 text-slate-300">محمي بـ Bearer</Badge>}
            <code className="rounded border border-slate-800 px-2 py-0.5 font-mono text-slate-400" dir="ltr">/mcp</code>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl space-y-6 px-4 py-6">
        <KeyManagerCard key={`keys-${tick}`} onChange={refreshAll} />
        <TasksCard />
        <ConnectCard health={health} />
      </main>

      <footer className="mt-auto border-t border-slate-800 py-4 text-center text-xs text-slate-500">
        خادم MCP لتوليد الوسائط — روابط فقط دون تنزيل أي ملفات، وتبديل تسلسلي صامت للمفاتيح.
      </footer>
    </div>
  );
}
