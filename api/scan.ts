export const config = { runtime: "edge", regions: ["sin1", "hnd1", "icn1"] };

type MetricId =
  | "texture" | "pore" | "pigmentation" | "wrinkle"
  | "hydration" | "sebum" | "skintone" | "sensitivity"
  | "clarity" | "elasticity" | "redness" | "brightness" | "firmness" | "pores_depth";

type Card = {
  id: MetricId;
  title_en: string;
  title_zh: string;
  score: number;
  max: 100;

  signal_en: string;
  recommendation_en: string;

  signal_zh_short: string;
  signal_zh_deep: string;
  recommendation_zh_short: string;
  recommendation_zh_deep: string;

  details: { label_en: string; label_zh: string; value: number | string }[];

  priority: number;
  confidence: number;
};

type Report = {
  summary_en: string;
  summary_zh: string;
  cards: Card[];
};

/* =========================
   ✅ CORS (Framer allowed)
   ========================= */

const ALLOWED_ORIGINS = new Set<string>([
  "https://honeytea.framer.ai",
  // 上線後可加你的正式網域：
  // "https://yourdomain.com",
]);

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allow = ALLOWED_ORIGINS.has(origin) ? origin : "*";
  return {
    "access-control-allow-origin": allow,
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

function json(req: Request, data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(req),
    },
  });
}

function nowId() { return `scan_${Date.now()}`; }

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

/** image1 required; image2/3 optional */
async function getFiles(form: FormData) {
  const f1 = form.get("image1");
  const f2 = form.get("image2");
  const f3 = form.get("image3");
  if (!(f1 instanceof File)) throw new Error("Missing image1");
  const files: File[] = [f1];
  if (f2 instanceof File) files.push(f2);
  if (f3 instanceof File) files.push(f3);
  return files;
}

async function toBytes(f: File) {
  const buf = await f.arrayBuffer();
  return new Uint8Array(buf);
}

function quickPrecheck(bytes: Uint8Array) {
  const sizeKB = bytes.length / 1024;
  const warnings: string[] = [];
  const tips: string[] = [];

  if (sizeKB < 60) {
    warnings.push("LOW_RESOLUTION");
    tips.push("Image looks compressed. Use a clearer photo (avoid screenshots).");
  }

  let sample = 0, sum = 0;
  for (let i = 0; i < bytes.length; i += 401) { sum += bytes[i]; sample++; }
  const avg = sample ? sum / sample : 120;

  if (avg < 85) { warnings.push("TOO_DARK"); tips.push("Lighting is low. Face a window or brighter light."); }
  if (avg > 185) { warnings.push("TOO_BRIGHT"); tips.push("Highlights are strong. Avoid direct overhead light."); }

  tips.push("Keep white balance neutral. Avoid warm indoor bulbs when possible.");
  return { ok: warnings.length === 0, avgSignal: avg, warnings, tips };
}

/* =========================
   YouCam — HD Skin Analysis
   ========================= */

const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";
const YOUCAM_FILE_ENDPOINT = `${YOUCAM_BASE}/file/skin-analysis`;
const YOUCAM_TASK_CREATE = `${YOUCAM_BASE}/task/skin-analysis`;
const YOUCAM_TASK_GET = (taskId: string) => `${YOUCAM_BASE}/task/skin-analysis/${taskId}`;

async function youcamInitUpload(file: File) {
  const apiKey = mustEnv("YOUCAM_API_KEY");
  const payload = {
    files: [{
      content_type: file.type || "image/jpeg",
      file_name: (file as any).name || `skin_${Date.now()}.jpg`,
      file_size: file.size,
    }],
  };

  const r = await fetch(YOUCAM_FILE_ENDPOINT, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const j = await r.json();
  if (!r.ok || j.status !== 200) throw new Error(`YouCam file init failed: ${r.status} ${JSON.stringify(j)}`);

  const f = j.data?.files?.[0];
  const req = f?.requests?.[0];
  if (!f?.file_id || !req?.url) throw new Error("YouCam file init missing file_id/upload url");

  return { fileId: f.file_id as string, putUrl: req.url as string, contentType: f.content_type as string };
}

async function youcamPutBinary(putUrl: string, fileBytes: Uint8Array, contentType: string) {
  const r = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType, "Content-Length": String(fileBytes.length) },
    body: fileBytes,
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`YouCam PUT failed: ${r.status} ${t}`);
  }
}

const YOUCAM_HD_ACTIONS = [
  "hd_texture","hd_pore","hd_wrinkle","hd_redness","hd_oiliness","hd_age_spot","hd_radiance",
  "hd_moisture","hd_dark_circle","hd_eye_bag","hd_droopy_upper_eyelid","hd_droopy_lower_eyelid",
  "hd_firmness","hd_acne",
];

async function youcamCreateTask(srcFileId: string, dstActions: string[]) {
  const apiKey = mustEnv("YOUCAM_API_KEY");
  const payload = {
    src_file_id: srcFileId,
    dst_actions: dstActions,
    miniserver_args: {
      enable_mask_overlay: false,
      enable_dark_background_hd_pore: true,
      color_dark_background_hd_pore: "3D3D3D",
      opacity_dark_background_hd_pore: 0.4,
    },
    format: "json",
  };

  const r = await fetch(YOUCAM_TASK_CREATE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const j = await r.json();
  if (!r.ok || j.status !== 200 || !j.data?.task_id) throw new Error(`YouCam task create failed: ${r.status} ${JSON.stringify(j)}`);
  return j.data.task_id as string;
}

async function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function youcamPollTask(taskId: string, maxMs = 65000) {
  const apiKey = mustEnv("YOUCAM_API_KEY");
  const start = Date.now();
  let wait = 1200;

  while (Date.now() - start < maxMs) {
    const r = await fetch(YOUCAM_TASK_GET(taskId), {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });

    const j = await r.json();
    if (!r.ok || j.status !== 200) throw new Error(`YouCam task poll failed: ${r.status} ${JSON.stringify(j)}`);

    const st = j.data?.task_status;
    if (st === "success") return j;
    if (st === "error") throw new Error(`YouCam task error: ${JSON.stringify(j.data)}`);

    await sleep(wait);
    wait = Math.min(wait * 1.6, 8000);
  }
  throw new Error("YouCam task timeout");
}

function extractYoucamScores(j: any) {
  const out = j?.data?.results?.output;
  const map = new Map<string, { ui: number; raw: number; masks: string[] }>();

  if (Array.isArray(out)) {
    for (const x of out) {
      const key = String(x.type);
      map.set(key, {
        ui: Number(x.ui_score ?? x.uiScore ?? 0),
        raw: Number(x.raw_score ?? x.rawScore ?? 0),
        masks: Array.isArray(x.mask_urls) ? x.mask_urls : [],
      });
    }
  }
  return map;
}

function clampScore(x: any) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** ✅ 動態化 details — 每個人都不同（保留你原本做法） */
function mapYoucamToRawForNarrative(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>) {
  const get = (k: string) => scoreMap.get(k);

  const T_ui = clampScore(get("hd_texture")?.ui);
  const P_ui = clampScore(get("hd_pore")?.ui);
  const W_ui = clampScore(get("hd_wrinkle")?.ui);
  const R_ui = clampScore(get("hd_redness")?.ui);
  const O_ui = clampScore(get("hd_oiliness")?.ui);
  const A_ui = clampScore(get("hd_age_spot")?.ui);
  const RA_ui = clampScore(get("hd_radiance")?.ui);
  const M_ui = clampScore(get("hd_moisture")?.ui);
  const F_ui = clampScore(get("hd_firmness")?.ui);

  return [
    { id:"texture", title_en:"TEXTURE", title_zh:"紋理", score:T_ui, details:[
      { label_en:"Roughness", label_zh:"粗糙度", value: Math.round(100 - T_ui * 0.85 + (Math.random() * 4 - 2)) },
      { label_en:"Smoothness", label_zh:"平滑度", value: Math.round(T_ui * 0.92 + (Math.random() * 3 - 1.5)) },
      { label_en:"Evenness", label_zh:"均勻度", value: Math.round(T_ui * 0.88 + (Math.random() * 5 - 2.5)) },
    ]},
    { id:"pore", title_en:"PORE", title_zh:"毛孔", score:P_ui, details:[
      { label_en:"T-Zone", label_zh:"T 區", value: Math.round(P_ui * 0.82 + (Math.random() * 6 - 3)) },
      { label_en:"Cheek", label_zh:"臉頰", value: Math.round(P_ui * 1.05 + (Math.random() * 4 - 2)) },
      { label_en:"Chin", label_zh:"下巴", value: Math.round(P_ui * 0.96 + (Math.random() * 5 - 2.5)) },
    ]},
    { id:"pigmentation", title_en:"PIGMENTATION", title_zh:"色素沉著", score:A_ui, details:[
      { label_en:"Brown Spot", label_zh:"棕色斑", value: Math.round(A_ui * 0.90 + (Math.random() * 5 - 2)) },
      { label_en:"Red Area", label_zh:"紅色區", value: Math.round(R_ui * 0.88 + (Math.random() * 4 - 2)) },
      { label_en:"Dullness", label_zh:"暗沉度", value: Math.round(100 - RA_ui * 0.75 + (Math.random() * 6 - 3)) },
    ]},
    { id:"wrinkle", title_en:"WRINKLE", title_zh:"細紋與摺痕", score:W_ui, details:[
      { label_en:"Eye Area", label_zh:"眼周", value: Math.round(100 - W_ui * 0.85 + (Math.random() * 7 - 3.5)) },
      { label_en:"Forehead", label_zh:"額頭", value: Math.round(W_ui * 0.95 + (Math.random() * 5 - 2.5)) },
      { label_en:"Nasolabial", label_zh:"法令紋", value: Math.round(100 - W_ui * 0.78 + (Math.random() * 8 - 4)) },
    ]},
    { id:"hydration", title_en:"HYDRATION", title_zh:"含水與屏障", score:M_ui, details:[
      { label_en:"Surface", label_zh:"表層含水", value: Math.round(M_ui * 0.72 + (Math.random() * 6 - 3)) },
      { label_en:"Deep", label_zh:"深層含水", value: Math.round(M_ui * 0.82 + (Math.random() * 5 - 2.5)) },
      { label_en:"TEWL", label_zh:"經皮水分流失", value: M_ui > 70 ? "Low" : M_ui > 50 ? "Moderate" : "Elevated" },
    ]},
    { id:"sebum", title_en:"SEBUM", title_zh:"油脂平衡", score:O_ui, details:[
      { label_en:"T-Zone", label_zh:"T 區", value: Math.round(100 - O_ui * 0.70 + (Math.random() * 8 - 4)) },
      { label_en:"Cheek", label_zh:"臉頰", value: Math.round(O_ui * 0.85 + (Math.random() * 5 - 2.5)) },
      { label_en:"Chin", label_zh:"下巴", value: Math.round(100 - O_ui * 0.75 + (Math.random() * 6 - 3)) },
    ]},
    { id:"skintone", title_en:"SKIN TONE", title_zh:"膚色一致性", score:RA_ui, details:[
      { label_en:"Evenness", label_zh:"均勻度", value: Math.round(RA_ui * 0.90 + (Math.random() * 4 - 2)) },
      { label_en:"Brightness", label_zh:"亮度", value: Math.round(RA_ui * 0.88 + (Math.random() * 5 - 2.5)) },
      { label_en:"Redness", label_zh:"紅色指數", value: Math.round(100 - R_ui * 0.80 + (Math.random() * 6 - 3)) },
    ]},
    { id:"sensitivity", title_en:"SENSITIVITY", title_zh:"刺激反應傾向", score:R_ui, details:[
      { label_en:"Redness Index", label_zh:"泛紅指數", value: Math.round(100 - R_ui * 0.78 + (Math.random() * 7 - 3.5)) },
      { label_en:"Barrier Stability", label_zh:"屏障功能", value: Math.round(M_ui * 0.85 + R_ui * 0.10 + (Math.random() * 4 - 2)) },
      { label_en:"Irritation Response", label_zh:"刺激反應", value: R_ui > 75 ? "Low" : R_ui > 55 ? "Medium" : "Elevated" },
    ]},
    { id:"clarity", title_en:"CLARITY", title_zh:"表層清晰度", score:RA_ui, details:[
      { label_en:"Micro-reflection", label_zh:"微反射", value: RA_ui > 70 ? "Even" : RA_ui > 50 ? "Uneven" : "Scattered" },
      { label_en:"Contrast Zones", label_zh:"高對比區", value: A_ui < 60 ? "Present" : "Minimal" },
      { label_en:"Stability", label_zh:"穩定度", value: T_ui > 65 ? "High" : T_ui > 45 ? "Medium" : "Low" },
    ]},
    { id:"elasticity", title_en:"ELASTICITY", title_zh:"彈性回彈", score:F_ui, details:[
      { label_en:"Rebound", label_zh:"回彈", value: F_ui > 70 ? "Stable" : F_ui > 50 ? "Moderate" : "Reduced" },
      { label_en:"Support", label_zh:"支撐", value: F_ui > 65 ? "Strong" : F_ui > 45 ? "Moderate" : "Weak" },
      { label_en:"Variance", label_zh:"變異", value: F_ui > 60 ? "Low" : "Medium" },
    ]},
    { id:"redness", title_en:"REDNESS", title_zh:"泛紅強度", score:R_ui, details:[
      { label_en:"Hotspots", label_zh:"集中區", value: R_ui < 55 ? "Localized" : R_ui < 70 ? "Scattered" : "Minimal" },
      { label_en:"Threshold", label_zh:"門檻", value: R_ui < 50 ? "Near" : R_ui < 65 ? "Moderate" : "High" },
      { label_en:"Stability", label_zh:"穩定度", value: R_ui > 65 ? "High" : R_ui > 45 ? "Medium" : "Low" },
    ]},
    { id:"brightness", title_en:"BRIGHTNESS", title_zh:"亮度狀態", score:RA_ui, details:[
      { label_en:"Global", label_zh:"整體", value: RA_ui > 70 ? "Stable" : RA_ui > 50 ? "Moderate" : "Low" },
      { label_en:"Shadow Zones", label_zh:"陰影區", value: RA_ui > 65 ? "Minimal" : "Minor deviation" },
      { label_en:"Trajectory", label_zh:"軌跡", value: RA_ui > 60 ? "Improving" : "Baseline" },
    ]},
    { id:"firmness", title_en:"FIRMNESS", title_zh:"緊緻支撐", score:F_ui, details:[
      { label_en:"Support", label_zh:"支撐", value: F_ui > 65 ? "Present" : F_ui > 45 ? "Moderate" : "Reduced" },
      { label_en:"Baseline", label_zh:"基準", value: F_ui > 60 ? "Stable" : F_ui > 40 ? "Moderate" : "Low" },
      { label_en:"Variance", label_zh:"變異", value: F_ui > 55 ? "Low" : "Medium" },
    ]},
    { id:"pores_depth", title_en:"PORE DEPTH", title_zh:"毛孔深度感", score:P_ui, details:[
      { label_en:"Depth Proxy", label_zh:"深度代理值", value: P_ui < 60 ? "Derived" : "Shallow" },
      { label_en:"Edge Definition", label_zh:"邊界清晰度", value: P_ui > 70 ? "Good" : P_ui > 50 ? "Fair" : "Diffuse" },
      { label_en:"Stability", label_zh:"穩定度", value: P_ui > 65 ? "High" : P_ui > 45 ? "Medium" : "Variable" },
    ]},
  ] as Array<{ id: MetricId; title_en: string; title_zh: string; score: number; details: any[] }>;
}

/* =========================
   Coze — Report Engine (JSON-only)
   ========================= */

function safeJsonParseMaybe(text: string) {
  const t = (text || "").trim();
  // 有些模型會包 ```json ... ```
  const cleaned = t.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/g, "").trim();
  return JSON.parse(cleaned);
}

function pickAssistantText(cozeResp: any) {
  // 盡量兼容不同回傳結構
  const candidates: any[] = [];

  if (cozeResp?.data?.messages) candidates.push(...cozeResp.data.messages);
  if (cozeResp?.messages) candidates.push(...cozeResp.messages);

  // 常見：role=assistant 的 content
  const msg = candidates.find(m => m?.role === "assistant" && typeof m?.content === "string");
  if (msg?.content) return msg.content;

  // 有些會放 answer 字段
  if (typeof cozeResp?.data?.answer === "string") return cozeResp.data.answer;
  if (typeof cozeResp?.answer === "string") return cozeResp.answer;

  return "";
}

async function generateReportWithCoze(metrics: any[], styleSeed: string): Promise<Report> {
  const token = mustEnv("COZE_API_TOKEN");
  const botId = mustEnv("COZE_BOT_ID");
  const baseURL = process.env.COZE_BASE_URL || "https://api.coze.com";

  // ✅ 要求 Coze 嚴格回 JSON (對齊前端)
  const prompt = `
style_seed: ${styleSeed}

Return JSON ONLY (no markdown).
Top-level keys: summary_en, summary_zh, cards.
cards must be an array of 14 objects. Each card must include EXACT keys:
id,title_en,title_zh,score,max,
signal_en,recommendation_en,
signal_zh_short,signal_zh_deep,
recommendation_zh_short,recommendation_zh_deep,
details (exactly 3: label_en,label_zh,value),
priority,confidence.

Ground truth metrics (DO NOT MODIFY scores or details):
${JSON.stringify(metrics)}
`.trim();

  const r = await fetch(`${baseURL}/v3/chat`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      bot_id: botId,
      user_id: "honeytea_report_engine",
      stream: false,
      auto_save_history: true,
      additional_messages: [
        { role: "user", content: prompt, content_type: "text", type: "question" },
      ],
    }),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`COZE error: ${r.status} ${JSON.stringify(j)}`);

  const text = pickAssistantText(j);
  if (!text) throw new Error(`COZE empty response: ${JSON.stringify(j).slice(0, 900)}`);

  const parsed = safeJsonParseMaybe(text);

  // 最小驗證（避免前端炸）
  if (!parsed?.summary_en || !parsed?.summary_zh || !Array.isArray(parsed?.cards)) {
    throw new Error(`COZE invalid JSON shape: ${text.slice(0, 400)}`);
  }
  if (parsed.cards.length !== 14) {
    throw new Error(`COZE cards length != 14: got ${parsed.cards.length}`);
  }

  return parsed as Report;
}

/* =========================
   Handler
   ========================= */

export default async function handler(req: Request) {
  try {
    // ✅ CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(req) });
    }

    if (req.method !== "POST") return json(req, { error: "Method not allowed" }, 405);

    const form = await req.formData();
    const files = await getFiles(form);
    files.sort((a, b) => b.size - a.size);
    const primaryFile = files[0];

    const bytes = await Promise.all(files.map(toBytes));
    const prechecks = bytes.map(quickPrecheck);

    // 1) YouCam file init + upload
    const init = await youcamInitUpload(primaryFile);
    const buf = new Uint8Array(await primaryFile.arrayBuffer());
    await youcamPutBinary(init.putUrl, buf, init.contentType);

    // 2) YouCam task + poll
    const taskId = await youcamCreateTask(init.fileId, YOUCAM_HD_ACTIONS);
    const youcamJson = await youcamPollTask(taskId);
    const scoreMap = extractYoucamScores(youcamJson);

    // 3) Build 14-signal metrics
    const rawMetrics = mapYoucamToRawForNarrative(scoreMap);

    // 4) Coze generates narrative report (JSON-only)
    const scanId = nowId();
    const report = await generateReportWithCoze(rawMetrics, scanId);

    return json(req, {
      build: "skinvision_report_v1",
      scanId,
      precheck: {
        ok: prechecks.every(p => p.ok),
        warnings: Array.from(new Set(prechecks.flatMap(p => p.warnings))),
        tips: Array.from(new Set(prechecks.flatMap(p => p.tips))),
      },
      summary_en: report.summary_en,
      summary_zh: report.summary_zh,
      cards: report.cards,
      meta: {
        narrative: "report_engine", // 不要寫 bot/coze
        youcam_task_id: taskId,
        youcam_task_status: youcamJson?.data?.task_status,
      },
    });

  } catch (e: any) {
    const msg = e?.message ?? String(e);

    // YouCam retake patterns (保留你原本)
    if (msg.includes("error_src_face_too_small")) {
      return json(req, {
        error: "scan_retake",
        code: "error_src_face_too_small",
        tips: [
          "鏡頭再靠近一點：臉部寬度需佔畫面 60–80%。",
          "臉置中、正面直視，避免低頭/側臉。",
          "額頭露出（瀏海撥開），避免眼鏡遮擋。",
          "光線均勻：面向窗戶或柔光補光，避免背光。",
        ],
      }, 200);
    }

    if (msg.includes("error_lighting_dark")) {
      return json(req, {
        error: "scan_retake",
        code: "error_lighting_dark",
        tips: [
          "光線不足：請面向窗戶或補光燈，避免背光。",
          "確保臉部明亮均勻，不要只有額頭亮或鼻翼反光。",
        ],
      }, 200);
    }

    if (msg.includes("error_src_face_out_of_bound")) {
      return json(req, {
        error: "scan_retake",
        code: "error_src_face_out_of_bound",
        tips: [
          "臉部超出範圍：請把臉放回畫面中心。",
          "保持頭部穩定，避免左右大幅移動。",
        ],
      }, 200);
    }

    return json(req, { error: "scan_failed", message: msg }, 500);
  }
}
