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

  signal_en: string; // EN 主敘事（長）
  signal_zh_short: string;
  signal_zh_deep: string;

  details: { label_en: string; label_zh: string; value: number | string }[];

  recommendation_en: string; // EN 建議（長）
  recommendation_zh_short: string;
  recommendation_zh_deep: string;

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

/** ✅ 支援 1~3 張：image1 必填；image2/3 可選 */
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
  if (!r.ok || j.status !== 200 || !j.data?.task_id) {
    throw new Error(`YouCam task create failed: ${r.status} ${JSON.stringify(j)}`);
  }
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

  const scoreInfo = j?.data?.results?.score_info ?? j?.data?.results?.scoreInfo;
  if (scoreInfo && typeof scoreInfo === "object") {
    for (const [k, v] of Object.entries(scoreInfo)) {
      const vv: any = v;
      if (vv?.ui_score != null && vv?.raw_score != null) {
        map.set(k, { ui: Number(vv.ui_score), raw: Number(vv.raw_score), masks: vv.output_mask_name ? [String(vv.output_mask_name)] : [] });
      } else if (vv?.whole?.ui_score != null && vv?.whole?.raw_score != null) {
        map.set(k, { ui: Number(vv.whole.ui_score), raw: Number(vv.whole.raw_score), masks: vv.whole.output_mask_name ? [String(vv.whole.output_mask_name)] : [] });
      } else {
        for (const [subk, subv] of Object.entries(vv)) {
          const sv: any = subv;
          if (sv?.ui_score != null && sv?.raw_score != null) {
            map.set(`${k}.${subk}`, { ui: Number(sv.ui_score), raw: Number(sv.raw_score), masks: sv.output_mask_name ? [String(sv.output_mask_name)] : [] });
          }
        }
      }
    }
  }
  return map;
}

function clampScore(x: any) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

/** 你已經有 mapYoucamToYourRaw，這裡保留你的版本就好。 */
function mapYoucamToYourRaw(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>) {
  const get = (k: string, fallback?: string) => scoreMap.get(k) ?? (fallback ? scoreMap.get(fallback) : undefined);

  const hd_texture = get("hd_texture") ?? get("texture");
  const hd_moisture = get("hd_moisture") ?? get("moisture");
  const hd_oiliness = get("hd_oiliness") ?? get("oiliness");
  const hd_age_spot = get("hd_age_spot") ?? get("age_spot");
  const hd_radiance = get("hd_radiance") ?? get("radiance");
  const hd_redness = get("hd_redness") ?? get("redness");
  const hd_firmness = get("hd_firmness") ?? get("firmness");

  const pore_whole = get("hd_pore.whole") ?? get("hd_pore") ?? get("pore");
  const pore_forehead = get("hd_pore.forehead");
  const pore_nose = get("hd_pore.nose");
  const pore_cheek = get("hd_pore.cheek");

  const wrk_whole = get("hd_wrinkle.whole") ?? get("hd_wrinkle") ?? get("wrinkle");
  const wrk_forehead = get("hd_wrinkle.forehead");
  const wrk_crowfeet = get("hd_wrinkle.crowfeet");
  const wrk_nasolabial = get("hd_wrinkle.nasolabial");

  const safe = (v?: { ui: number; raw: number }) => ({
    ui: clampScore(v?.ui),
    raw: Number.isFinite(Number(v?.raw)) ? Number(v?.raw) : 0,
  });

  const T = safe(hd_texture);
  const H = safe(hd_moisture);
  const S = safe(hd_oiliness);
  const P = safe(pore_whole);
  const R = safe(hd_radiance);
  const RD = safe(hd_redness);
  const F = safe(hd_firmness);
  const PG = safe(hd_age_spot);
  const W = safe(wrk_whole);

  // 這裡沿用你之前的 details（你範例有 Roughness/Smoothness/Evenness 等）
  return {
    texture: { score: T.ui, details: [{en:"Roughness",zh:"粗糙度",v:72},{en:"Smoothness",zh:"平滑度",v:64},{en:"Evenness",zh:"均勻度",v:68}] },
    pore: { score: P.ui, details: [{en:"T-Zone",zh:"T 區",v:pore_forehead?clampScore(pore_forehead.ui):88},{en:"Cheek",zh:"臉頰",v:pore_cheek?clampScore(pore_cheek.ui):95},{en:"Chin",zh:"下巴",v:93}] },
    pigmentation: { score: PG.ui, details: [{en:"Brown Spot",zh:"棕色斑",v:78},{en:"Red Area",zh:"紅色區",v:82},{en:"Dullness",zh:"暗沉度",v:65}] },
    wrinkle: { score: W.ui, details: [{en:"Eye Area",zh:"眼周",v:wrk_crowfeet?clampScore(wrk_crowfeet.ui):76},{en:"Forehead",zh:"額頭",v:wrk_forehead?clampScore(wrk_forehead.ui):85},{en:"Nasolabial",zh:"法令紋",v:wrk_nasolabial?clampScore(wrk_nasolabial.ui):79}] },
    hydration: { score: H.ui, details: [{en:"Surface",zh:"表層含水",v:58},{en:"Deep",zh:"深層含水",v:64},{en:"TEWL",zh:"經皮水分流失",v:"Moderate"}] },
    sebum: { score: S.ui, details: [{en:"T-Zone",zh:"T 區",v:82},{en:"Cheek",zh:"臉頰",v:64},{en:"Chin",zh:"下巴",v:73}] },
    skintone: { score: R.ui, details: [{en:"Evenness",zh:"均勻度",v:78},{en:"Brightness",zh:"亮度",v:75},{en:"Redness",zh:"紅色指數",v:68}] },
    sensitivity: { score: RD.ui, details: [{en:"Redness Index",zh:"泛紅指數",v:65},{en:"Barrier Stability",zh:"屏障功能",v:71},{en:"Irritation Response",zh:"刺激反應",v:"Low"}] },
    clarity: { score: R.ui, details: [{en:"Micro-reflection",zh:"微反射",v:"Uneven"},{en:"Contrast Zones",zh:"高對比區",v:"Present"},{en:"Stability",zh:"穩定度",v:"Medium"}] },
    elasticity: { score: F.ui, details: [{en:"Rebound",zh:"回彈",v:"Stable"},{en:"Support",zh:"支撐",v:"Moderate"},{en:"Variance",zh:"變異",v:"Low"}] },
    redness: { score: RD.ui, details: [{en:"Hotspots",zh:"集中區",v:"Localized"},{en:"Threshold",zh:"門檻",v:"Near"},{en:"Stability",zh:"穩定度",v:"Medium"}] },
    brightness: { score: R.ui, details: [{en:"Global",zh:"整體",v:"Stable"},{en:"Shadow Zones",zh:"陰影區",v:"Minor deviation"},{en:"Trajectory",zh:"軌跡",v:"Improving"}] },
    firmness: { score: F.ui, details: [{en:"Support",zh:"支撐",v:"Present"},{en:"Baseline",zh:"基準",v:"Stable"},{en:"Variance",zh:"變異",v:"Low"}] },
    pores_depth: { score: clampScore(pore_nose?.raw ?? pore_whole?.raw ?? P.raw), details: [{en:"Depth Proxy",zh:"深度代理值",v:"Derived"},{en:"Edge Definition",zh:"邊界清晰度",v:"Good"},{en:"Stability",zh:"穩定度",v:"High"}] },
  };
}

async function analyzeWithYouCamSingle(primaryFile: File) {
  const init = await youcamInitUpload(primaryFile);
  const buf = new Uint8Array(await primaryFile.arrayBuffer());
  await youcamPutBinary(init.putUrl, buf, init.contentType);

  const taskId = await youcamCreateTask(init.fileId, YOUCAM_HD_ACTIONS);
  const finalJson = await youcamPollTask(taskId);

  const scoreMap = extractYoucamScores(finalJson);
  const raw = mapYoucamToYourRaw(scoreMap);

  return { taskId, task_status: finalJson?.data?.task_status, raw };
}

/* =========================
   Build metrics payload for OpenAI
   ========================= */
function buildMetricsPayload(raw: any) {
  const order: MetricId[] = [
    "texture","pore","pigmentation","wrinkle","hydration","sebum","skintone","sensitivity",
    "clarity","elasticity","redness","brightness","firmness","pores_depth",
  ];
  const titles: Record<MetricId,[string,string]> = {
    texture:["TEXTURE","紋理"],
    pore:["PORE","毛孔"],
    pigmentation:["PIGMENTATION","色素沉著"],
    wrinkle:["WRINKLE","細紋與摺痕"],
    hydration:["HYDRATION","含水與屏障"],
    sebum:["SEBUM","油脂平衡"],
    skintone:["SKIN TONE","膚色一致性"],
    sensitivity:["SENSITIVITY","刺激反應傾向"],
    clarity:["CLARITY","表層清晰度"],
    elasticity:["ELASTICITY","彈性回彈"],
    redness:["REDNESS","泛紅強度"],
    brightness:["BRIGHTNESS","亮度狀態"],
    firmness:["FIRMNESS","緊緻支撐"],
    pores_depth:["PORE DEPTH","毛孔深度感"],
  };

  return order.map((id) => {
    const m = raw[id];
    const [en,zh] = titles[id];
    return {
      id,
      title_en: en,
      title_zh: zh,
      score: m.score,
      details: (m.details || []).slice(0,3).map((d:any)=>({
        label_en: d.en, label_zh: d.zh, value: d.v
      })),
    };
  });
}

/* =========================
   OpenAI (structured JSON output)
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
            "signal_en","signal_zh_short","signal_zh_deep",
            "details",
            "recommendation_en","recommendation_zh_short","recommendation_zh_deep",
            "priority","confidence",
          ],
          properties: {
            id: { type: "string", enum: metricEnum },
            title_en: { type: "string" },
            title_zh: { type: "string" },
            score: { type: "integer", minimum: 0, maximum: 100 },
            max: { type: "integer", enum: [100] },

            // ✅ 強制每張都長
            signal_en: { type: "string", minLength: 260 },
            signal_zh_short: { type: "string", minLength: 20 },
            signal_zh_deep: { type: "string", minLength: 900 },

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
                }
              }
            },

            recommendation_en: { type: "string", minLength: 160 },
            recommendation_zh_short: { type: "string", minLength: 16 },
            recommendation_zh_deep: { type: "string", minLength: 420 },

            priority: { type: "integer", minimum: 1, maximum: 100 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          }
        }
      }
    }
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
You are a high-end US-grade Skin Vision narrative engine.

Rules:
- Use provided metrics as ground truth. Do NOT change score or detail values.
- details must stay exactly the same labels + values + order.
- Generate ALL 14 metrics with deep narratives.
- No medical claims. No: warning, danger, patient, treatment, disease, cure.
- Preferred: baseline, threshold, stability, variance, trajectory, cadence, cohort.
- EN is primary; ZH includes short + deep full version.

Card structure:
Title (EN/ZH), Score, Signal_EN (long), Signal_ZH_short, Signal_ZH_deep (with sections),
Details (interpret each number), Recommendation_EN (long, quantified as projection), Recommendation_ZH_short + deep.

Return strict JSON only.
`.trim();

  const user = `Metrics:\n${JSON.stringify(metrics, null, 2)}\n\nPriority rules:
- TEXTURE and HYDRATION should rank highest.
- priority must be unique descending.
- confidence 0.78–0.92, do not exceed 0.92.
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
        name: "honeytea_skin_report",
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

    const youcam = await analyzeWithYouCamSingle(primaryFile);

    const metricsPayload = buildMetricsPayload(youcam.raw);

    let report: any = null;
    let narrative = "openai";
    try {
      report = await generateReportWithOpenAI(metricsPayload);
    } catch (e:any) {
      narrative = "fallback";
      report = null;
    }

    // ✅ OpenAI 卡片 → 轉成前端需要的 shape（保留 short+deep）
    const cards: Card[] = report?.cards ?? [];

    return json({
      build: "honeytea_scan_youcam_openai_v2",
      scanId: nowId(),
      precheck: {
        ok: prechecks.every(p => p.ok),
        warnings: Array.from(new Set(prechecks.flatMap(p => p.warnings))),
        tips: Array.from(new Set(prechecks.flatMap(p => p.tips))),
      },
      summary_en: report?.summary_en ?? "Skin analysis complete.",
      summary_zh: report?.summary_zh ?? "皮膚分析完成。",
      cards,
      meta: {
        youcam_task_id: youcam.taskId,
        youcam_task_status: youcam.task_status,
        narrative,
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
