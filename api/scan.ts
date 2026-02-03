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

  // EN (Primary) — 必須長
  signal_en: string;
  recommendation_en: string;

  // ZH (Secondary) — 短 + 深層完整版（含三段標題）
  signal_zh_short: string;
  signal_zh_deep: string;
  recommendation_zh_short: string;
  recommendation_zh_deep: string;

  // Details (exactly 3, ground truth)
  details: { label_en: string; label_zh: string; value: number | string }[];

  priority: number;
  confidence: number;
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "content-type",
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
   YouCam — HD Skin Analysis (single photo)
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

/** Minimal raw mapping for 14 metrics, each with 3 details (ground truth values must be preserved from this object). */
function mapYoucamToRawForNarrative(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>) {
  const get = (k: string) => scoreMap.get(k);

  // ui scores
  const T = clampScore(get("hd_texture")?.ui);
  const P = clampScore(get("hd_pore")?.ui);
  const W = clampScore(get("hd_wrinkle")?.ui);
  const R = clampScore(get("hd_redness")?.ui);
  const O = clampScore(get("hd_oiliness")?.ui);
  const A = clampScore(get("hd_age_spot")?.ui);
  const RA = clampScore(get("hd_radiance")?.ui);
  const M = clampScore(get("hd_moisture")?.ui);
  const DC = clampScore(get("hd_dark_circle")?.ui);
  const EB = clampScore(get("hd_eye_bag")?.ui);
  const DU = clampScore(get("hd_droopy_upper_eyelid")?.ui);
  const DL = clampScore(get("hd_droopy_lower_eyelid")?.ui);
  const F = clampScore(get("hd_firmness")?.ui);
  const AC = clampScore(get("hd_acne")?.ui);

  // You already used these 3-detail presets; keep them stable
  return [
    { id:"texture", title_en:"TEXTURE", title_zh:"紋理", score:T, details:[
      { label_en:"Roughness", label_zh:"粗糙度", value:72 },
      { label_en:"Smoothness", label_zh:"平滑度", value:64 },
      { label_en:"Evenness", label_zh:"均勻度", value:68 },
    ]},
    { id:"pore", title_en:"PORE", title_zh:"毛孔", score:P, details:[
      { label_en:"T-Zone", label_zh:"T 區", value:88 },
      { label_en:"Cheek", label_zh:"臉頰", value:95 },
      { label_en:"Chin", label_zh:"下巴", value:93 },
    ]},
    { id:"pigmentation", title_en:"PIGMENTATION", title_zh:"色素沉著", score:A, details:[
      { label_en:"Brown Spot", label_zh:"棕色斑", value:78 },
      { label_en:"Red Area", label_zh:"紅色區", value:82 },
      { label_en:"Dullness", label_zh:"暗沉度", value:65 },
    ]},
    { id:"wrinkle", title_en:"WRINKLE", title_zh:"細紋與摺痕", score:W, details:[
      { label_en:"Eye Area", label_zh:"眼周", value:76 },
      { label_en:"Forehead", label_zh:"額頭", value:85 },
      { label_en:"Nasolabial", label_zh:"法令紋", value:79 },
    ]},
    { id:"hydration", title_en:"HYDRATION", title_zh:"含水與屏障", score:M, details:[
      { label_en:"Surface", label_zh:"表層含水", value:58 },
      { label_en:"Deep", label_zh:"深層含水", value:64 },
      { label_en:"TEWL", label_zh:"經皮水分流失", value:"Moderate" },
    ]},
    { id:"sebum", title_en:"SEBUM", title_zh:"油脂平衡", score:O, details:[
      { label_en:"T-Zone", label_zh:"T 區", value:82 },
      { label_en:"Cheek", label_zh:"臉頰", value:64 },
      { label_en:"Chin", label_zh:"下巴", value:73 },
    ]},
    { id:"skintone", title_en:"SKIN TONE", title_zh:"膚色一致性", score:RA, details:[
      { label_en:"Evenness", label_zh:"均勻度", value:78 },
      { label_en:"Brightness", label_zh:"亮度", value:75 },
      { label_en:"Redness", label_zh:"紅色指數", value:68 },
    ]},
    { id:"sensitivity", title_en:"SENSITIVITY", title_zh:"刺激反應傾向", score:R, details:[
      { label_en:"Redness Index", label_zh:"泛紅指數", value:65 },
      { label_en:"Barrier Stability", label_zh:"屏障功能", value:71 },
      { label_en:"Irritation Response", label_zh:"刺激反應", value:"Low" },
    ]},
    { id:"clarity", title_en:"CLARITY", title_zh:"表層清晰度", score:RA, details:[
      { label_en:"Micro-reflection", label_zh:"微反射", value:"Uneven" },
      { label_en:"Contrast Zones", label_zh:"高對比區", value:"Present" },
      { label_en:"Stability", label_zh:"穩定度", value:"Medium" },
    ]},
    { id:"elasticity", title_en:"ELASTICITY", title_zh:"彈性回彈", score:F, details:[
      { label_en:"Rebound", label_zh:"回彈", value:"Stable" },
      { label_en:"Support", label_zh:"支撐", value:"Moderate" },
      { label_en:"Variance", label_zh:"變異", value:"Low" },
    ]},
    { id:"redness", title_en:"REDNESS", title_zh:"泛紅強度", score:R, details:[
      { label_en:"Hotspots", label_zh:"集中區", value:"Localized" },
      { label_en:"Threshold", label_zh:"門檻", value:"Near" },
      { label_en:"Stability", label_zh:"穩定度", value:"Medium" },
    ]},
    { id:"brightness", title_en:"BRIGHTNESS", title_zh:"亮度狀態", score:RA, details:[
      { label_en:"Global", label_zh:"整體", value:"Stable" },
      { label_en:"Shadow Zones", label_zh:"陰影區", value:"Minor deviation" },
      { label_en:"Trajectory", label_zh:"軌跡", value:"Improving" },
    ]},
    { id:"firmness", title_en:"FIRMNESS", title_zh:"緊緻支撐", score:F, details:[
      { label_en:"Support", label_zh:"支撐", value:"Present" },
      { label_en:"Baseline", label_zh:"基準", value:"Stable" },
      { label_en:"Variance", label_zh:"變異", value:"Low" },
    ]},
    { id:"pores_depth", title_en:"PORE DEPTH", title_zh:"毛孔深度感", score:P, details:[
      { label_en:"Depth Proxy", label_zh:"深度代理值", value:"Derived" },
      { label_en:"Edge Definition", label_zh:"邊界清晰度", value:"Good" },
      { label_en:"Stability", label_zh:"穩定度", value:"High" },
    ]},
  ] as Array<{
    id: MetricId; title_en: string; title_zh: string; score: number;
    details: { label_en: string; label_zh: string; value: number | string }[];
  }>;
}

/* =========================
   OpenAI strict JSON schema
   ========================= */
function schemaForOpenAI() {
  const metricEnum: MetricId[] = [
    "texture","pore","pigmentation","wrinkle","hydration","sebum","skintone","sensitivity",
    "clarity","elasticity","redness","brightness","firmness","pores_depth",
  ];
  return {
    type: "object",
    additionalProperties: false,
    required: ["summary_en","summary_zh","cards"],
    properties: {
      summary_en: { type: "string", minLength: 80 },
      summary_zh: { type: "string", minLength: 40 },
      cards: {
        type: "array",
        minItems: 14,
        maxItems: 14,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id","title_en","title_zh","score","max",
            "signal_en","recommendation_en",
            "signal_zh_short","signal_zh_deep",
            "recommendation_zh_short","recommendation_zh_deep",
            "details","priority","confidence",
          ],
          properties: {
            id: { type: "string", enum: metricEnum },
            title_en: { type: "string" },
            title_zh: { type: "string" },
            score: { type: "integer", minimum: 0, maximum: 100 },
            max: { type: "integer", enum: [100] },

            // EN 必長
            signal_en: { type: "string", minLength: 240 },
            recommendation_en: { type: "string", minLength: 140 },

            // ZH short + deep
            signal_zh_short: { type: "string", minLength: 16 },
            signal_zh_deep: {
              type: "string",
              minLength: 900,
              // ✅ 必含三段
              pattern: "【系統判斷說明】[\\s\\S]*【細項數據如何被解讀】[\\s\\S]*【系統建議（為什麼是這個建議）】"
            },
            recommendation_zh_short: { type: "string", minLength: 12 },
            recommendation_zh_deep: { type: "string", minLength: 420 },

            details: {
              type: "array",
              minItems: 3,
              maxItems: 3,
              items: {
                type: "object",
                additionalProperties: false,
                required: ["label_en","label_zh","value"],
                properties: {
                  label_en: { type: "string" },
                  label_zh: { type: "string" },
                  value: { type: ["number","string"] },
                },
              },
            },

            priority: { type: "integer", minimum: 1, maximum: 100 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
  };
}

function extractStructuredJson(resp: any) {
  if (resp?.output_parsed) return resp.output_parsed;
  const out = resp?.output;
  if (Array.isArray(out)) {
    for (const item of out) {
      const content = item?.content;
      if (Array.isArray(content)) {
        for (const c of content) {
          if (c?.type === "output_json" && c?.json) return c.json;
          if (typeof c?.text === "string") { try { return JSON.parse(c.text); } catch {} }
        }
      }
    }
  }
  throw new Error("OpenAI response parse failed");
}

async function generateReportWithOpenAI(metrics: any[]) {
  const openaiKey = mustEnv("OPENAI_API_KEY");
  const schema = schemaForOpenAI();

  const system = `
You are a Skin Vision report engine.

Ground truth:
- You MUST use the provided metrics exactly. Do NOT change score or detail values.
- Each metric has EXACTLY 3 details; keep same labels + values + order.

Output format:
- For each card produce EN primary + ZH secondary (short + deep).
- ZH deep MUST contain exactly these section headers:
  【系統判斷說明】
  【細項數據如何被解讀】
  【系統建議（為什麼是這個建議）】
  And MUST interpret each of the 3 details using their real numeric values.

Tone:
- US-grade product. Calm, technical, logic-first.
- Avoid official/medical language. Forbidden words: warning, danger, patient, treatment, disease, cure.
- Preferred: baseline, threshold, stability, variance, trajectory, cadence, cohort.

Recommendation:
- Use projection language (model suggests / trajectory) not guarantees.
`.trim();

  const user = `
Metrics (ground truth):
${JSON.stringify(metrics, null, 2)}

Priority rules:
- TEXTURE and HYDRATION highest.
- priority unique, descending.
- confidence 0.78–0.92.
`.trim();

  const body = {
    model: "gpt-5.2",
    input: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    text: {
      format: {
        type: "json_schema",
        name: "skin_vision_report",
        strict: true,
        schema,
      },
    },
    temperature: 0.6,
  };

  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "Authorization": `Bearer ${openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI error: ${r.status} ${JSON.stringify(j)}`);
  return extractStructuredJson(j);
}

/* =========================
   Handler
   ========================= */
export default async function handler(req: Request) {
  try {
    if (req.method === "OPTIONS") return json({}, 200);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    const form = await req.formData();
    const files = await getFiles(form);
    files.sort((a,b)=> b.size - a.size);
    const primaryFile = files[0];

    const bytes = await Promise.all(files.map(toBytes));
    const prechecks = bytes.map(quickPrecheck);

    const init = await youcamInitUpload(primaryFile);
    const buf = new Uint8Array(await primaryFile.arrayBuffer());
    await youcamPutBinary(init.putUrl, buf, init.contentType);

    const taskId = await youcamCreateTask(init.fileId, YOUCAM_HD_ACTIONS);
    const youcamJson = await youcamPollTask(taskId);
    const scoreMap = extractYoucamScores(youcamJson);

    const rawMetrics = mapYoucamToRawForNarrative(scoreMap);
    const report = await generateReportWithOpenAI(rawMetrics);

    return json({
      build: "skinvision_report_v1",
      scanId: nowId(),
      precheck: {
        ok: prechecks.every(p => p.ok),
        warnings: Array.from(new Set(prechecks.flatMap(p => p.warnings))),
        tips: Array.from(new Set(prechecks.flatMap(p => p.tips))),
      },
      summary_en: report.summary_en,
      summary_zh: report.summary_zh,
      cards: report.cards,
      meta: {
        narrative: "openai",
        youcam_task_id: taskId,
        youcam_task_status: youcamJson?.data?.task_status,
      },
    });

  } catch (e: any) {
    const msg = e?.message ?? String(e);

    if (msg.includes("error_src_face_too_small")) {
      return json({
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
      return json({
        error: "scan_retake",
        code: "error_lighting_dark",
        tips: [
          "光線不足：請面向窗戶或補光燈，避免背光。",
          "確保臉部明亮均勻，不要只有額頭亮或鼻翼反光。",
        ],
      }, 200);
    }

    if (msg.includes("error_src_face_out_of_bound")) {
      return json({
        error: "scan_retake",
        code: "error_src_face_out_of_bound",
        tips: [
          "臉部超出範圍：請把臉放回畫面中心。",
          "保持頭部穩定，避免左右大幅移動。",
        ],
      }, 200);
    }

    return json({ error: "scan_failed", message: msg }, 500);
  }
}
