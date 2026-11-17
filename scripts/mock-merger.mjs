/**
 * خدمة دمج وهمية (منفذ 3999) — تحاكي Video Merger API v2 بالأشكال الموصوفة حرفيًا:
 *   POST   /api/jobs                     {"videos":[...]} → {"jobId","status","statusUrl","processUrl","expiresAt"}
 *   POST   /api/jobs/{id}/process        blocking → {"status":"done","videoUrl","downloadUrl","size","duration","resolution","expiresAt"}
 *   GET    /api/jobs/{id}                {"status","progress"(كسر 0..1),"videoUrl","downloadUrl","error"}
 *   GET    /api/jobs/{id}/video?download=1  ملف MP4 مباشرة
 *   DELETE /api/jobs/{id}                حذف فوري
 *   GET    /api/config                   حدود الخدمة
 *
 * الدمج حقيقي فعليًا: تُنزَّل المقاطع ثم تُدمج بـ ffmpeg concat — الناتج يُخزَّن في /tmp/mock-merger
 * لأغراض الاختبار المحلي فقط (التطبيق نفسه لا يلمس الملفات أبدًا — يخزن الروابط فقط).
 * أي خطأ HTTP معلن يُعاد كما هو: 400 لقوائم غير صالحة، و404 لمهمة غير موجودة، و500 لفشل تحميل مصدر.
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const PORT = 3999;
const WORK = "/tmp/mock-merger";
fs.mkdirSync(WORK, { recursive: true });

/** jobs: id → {videos, status, progress, file?, error?, createdAt} */
const jobs = new Map();

function expiresAt() {
  return new Date(Date.now() + 24 * 3600 * 1000).toISOString();
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function download(url, dest) {
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Download failed (HTTP ${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(dest, buf);
  return buf.length;
}

async function mergeVideos(job) {
  job.status = "processing";
  job.progress = 0.1;
  try {
    // 1) تنزيل المصادر
    const files = [];
    for (let i = 0; i < job.videos.length; i++) {
      const f = path.join(WORK, `${job.id}-src-${i}.mp4`);
      await download(job.videos[i], f);
      files.push(f);
      job.progress = 0.1 + (0.6 * (i + 1)) / job.videos.length;
    }
    // 2) دمج بترتيب المصادر عبر ffmpeg concat filter (يعيد الترميز إلى H.264+AAC)
    const inputs = files.flatMap((f) => ["-i", f]);
    const filter = files.map((_, i) => `[${i}:v]scale=640:360,setsar=1[v${i}];[v${i}]format=yuv420p[vo${i}];[${i}:a]aresample=44100[ao${i}]`).join(";") + ";" +
      files.map((_, i) => `[vo${i}][ao${i}]`).join("") + `concat=n=${files.length}:v=1:a=1[vout][aout]`;
    const out = path.join(WORK, `${job.id}-video.mp4`);
    await execFileAsync("ffmpeg", [
      "-y", ...inputs,
      "-filter_complex", filter,
      "-map", "[vout]", "-map", "[aout]",
      "-c:v", "libx264", "-crf", "18", "-preset", "veryfast",
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      out,
    ], { timeout: 180_000 });
    job.file = out;
    job.size = fs.statSync(out).size;
    // مدة الناتج عبر ffprobe
    try {
      const { stdout } = await execFileAsync("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "json", out]);
      job.duration = Number(JSON.parse(stdout).format?.duration ?? 0);
    } catch {
      job.duration = 0;
    }
    job.resolution = "640x360";
    job.status = "done";
    job.progress = 1;
  } catch (e) {
    // فشل حتمي: مثل مصدر يرفض التحميل — تكرار المحاولة يعطي النتيجة نفسها
    job.status = "failed";
    job.error = e.message;
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean); // ["api","jobs",id,"process"?]

  console.log(`MOCK-MERGER] ${req.method} ${url.pathname}`);

  // GET /api/config
  if (url.pathname === "/api/config") {
    return json(res, 200, {
      limits: { maxVideos: 10, maxSourceSizeMB: 200, maxOutputSizeMB: 150, maxTotalDurationSec: 600, retentionHours: 24 },
    });
  }

  if (parts[0] !== "api" || parts[1] !== "jobs") return json(res, 404, {});

  const jobId = parts[2];
  const action = parts[3]; // "process" أو undefined أو "video"

  if (req.method === "POST" && parts.length === 2) {
    // POST /api/jobs
    let body = {};
    try {
      body = JSON.parse(await readBody(req));
    } catch {
      return json(res, 400, { error: "Invalid JSON body" });
    }
    const videos = body.videos;
    if (!Array.isArray(videos)) return json(res, 400, { error: "videos array required" });
    if (videos.length < 2) return json(res, 400, { error: "At least 2 videos are required" });
    if (videos.length > 10) return json(res, 400, { error: "Too many videos (max 10)" });
    const id = randomBytes(6).toString("hex"); // مثل wkucdefoxwvd
    jobs.set(id, { id, videos, status: "queued", progress: 0, createdAt: Date.now() });
    return json(res, 200, {
      jobId: id,
      status: "queued",
      statusUrl: `http://localhost:${PORT}/api/jobs/${id}`,
      processUrl: `http://localhost:${PORT}/api/jobs/${id}/process`,
      expiresAt: expiresAt(),
    });
  }

  if (req.method === "POST" && action === "process" && jobId) {
    const job = jobs.get(jobId);
    if (!job) return json(res, 404, {});
    if (job.status === "done" && job.file) {
      // عملية متزامنة معاد استدعاؤها — أعد النتيجة نفسها
      return json(res, 200, doneBody(job));
    }
    await mergeVideos(job); // blocking ~عدة ثوانٍ
    if (job.status === "failed") {
      return json(res, 500, { error: job.error ?? "Merge failed" });
    }
    return json(res, 200, doneBody(job));
  }

  if (req.method === "GET" && jobId && !action) {
    const job = jobs.get(jobId);
    if (!job) return json(res, 404, {}); // جسم فارغ كالخدمة الحقيقية
    const body = {
      status: job.status,
      progress: job.progress, // كسر 0..1 — العميل يجب أن يضرب في 100
      expiresAt: expiresAt(),
    };
    if (job.status === "done") Object.assign(body, doneBody(job));
    if (job.status === "failed") body.error = job.error;
    return json(res, 200, body);
  }

  if (req.method === "GET" && action === "video" && jobId) {
    const job = jobs.get(jobId);
    if (!job || !job.file || job.status !== "done") return json(res, 404, {});
    const stat = fs.statSync(job.file);
    res.writeHead(200, {
      "Content-Type": "video/mp4",
      "Content-Length": stat.size,
      "Content-Disposition": `attachment; filename="${jobId}.mp4"`,
      "Accept-Ranges": "none",
    });
    fs.createReadStream(job.file).pipe(res);
    return;
  }

  if (req.method === "DELETE" && jobId && !action) {
    const job = jobs.get(jobId);
    if (job?.file) {
      try { fs.rmSync(job.file); } catch {}
      for (let i = 0; i < (job.videos?.length ?? 0); i++) {
        try { fs.rmSync(path.join(WORK, `${jobId}-src-${i}.mp4`)); } catch {}
      }
    }
    jobs.delete(jobId);
    return json(res, 200, { deleted: true });
  }

  return json(res, 404, {});
});

function doneBody(job) {
  return {
    status: "done",
    videoUrl: `http://localhost:${PORT}/api/jobs/${job.id}/video`,
    downloadUrl: `http://localhost:${PORT}/api/jobs/${job.id}/video?download=1`,
    size: job.size,
    duration: job.duration,
    resolution: job.resolution,
    expiresAt: expiresAt(),
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

server.listen(PORT, () => console.log(`MOCK-MERGER] يعمل على ${PORT}`));
