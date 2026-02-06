declare const process: any;

export const config = {
  runtime: "edge",
  regions: ["sin1", "hnd1", "icn1"],
};

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
  signal_zh: string;
  details: { label_en: string; label_zh: string; value: number | string }[];
  recommendation_en: string;
  recommendation_zh: string;
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

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

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

const YOUCAM_HD_ACTIONS = [
  "hd_texture","hd_pore","hd_wrinkle","hd_redness","hd_oiliness","hd_age_spot","hd_radiance",
  "hd_moisture","hd_dark_circle","hd_eye_bag","hd_droopy_upper_eyelid","hd_droopy_lower_eyelid",
  "hd_firmness","hd_acne",
];

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

  return {
    texture: { score: T.ui, details: [{en:"Roughness",zh:"粗糙度",v:T.raw},{en:"Smoothness",zh:"平滑度",v:Math.round(T.raw*0.9)},{en:"Evenness",zh:"均勻度",v:Math.round(T.raw*0.95)}] },
    pore: { score: P.ui, details: [{en:"T-Zone",zh:"T 區",v:pore_forehead?clampScore(pore_forehead.ui):88},{en:"Cheek",zh:"臉頰",v:pore_cheek?clampScore(pore_cheek.ui):95},{en:"Chin",zh:"下巴",v:93}] },
    pigmentation: { score: PG.ui, details: [{en:"Brown Spot",zh:"棕色斑",v:78},{en:"Red Area",zh:"紅色區",v:82},{en:"Dullness",zh:"暗沉度",v:65}] },
    wrinkle: { score: W.ui, details: [{en:"Eye Area",zh:"眼周",v:wrk_crowfeet?clampScore(wrk_crowfeet.ui):76},{en:"Forehead",zh:"額頭",v:wrk_forehead?clampScore(wrk_forehead.ui):85},{en:"Nasolabial",zh:"法令紋",v:wrk_nasolabial?clampScore(wrk_nasolabial.ui):79}] },
    hydration: { score: H.ui, details: [{en:"Surface",zh:"表層含水",v:Math.round(H.raw*0.9)},{en:"Deep",zh:"深層含水",v:H.raw},{en:"TEWL",zh:"經皮水分流失",v:Math.round(100-H.raw)}] },
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
   OpenAI: generate narratives
   ========================= */

function cardSchema() {
  const metricEnum: MetricId[] = [
    "texture","pore","pigmentation","wrinkle","hydration","sebum","skintone","sensitivity",
    "clarity","elasticity","redness","brightness","firmness","pores_depth",
  ];

  return {
    type: "object",
    additionalProperties: false,
    required: ["summary_en", "summary_zh", "cards"],
    properties: {
      summary_en: { type: "string", minLength: 120 },
      summary_zh: { type: "string", minLength: 260 },
      cards: {
        type: "array",
        minItems: 14,
        maxItems: 14,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id","title_en","title_zh","score","max",
            "signal_en","signal_zh","details",
            "recommendation_en","recommendation_zh",
            "priority","confidence",
          ],
          properties: {
            id: { type: "string", enum: metricEnum },
            title_en: { type: "string", minLength: 3 },
            title_zh: { type: "string", minLength: 1 },
            score: { type: "integer", minimum: 0, maximum: 100 },
            max: { type: "integer", enum: [100] },
            signal_en: { type: "string", minLength: 260 },
            signal_zh: { type: "string", minLength: 720 },
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
            recommendation_en: { type: "string", minLength: 180 },
            recommendation_zh: { type: "string", minLength: 520 },
            priority: { type: "integer", minimum: 1, maximum: 100 },
            confidence: { type: "number", minimum: 0, maximum: 1 },
          },
        },
      },
    },
  };
}

function buildMetricsPayload(raw: any) {
  const order: MetricId[] = [
    "texture","pore","pigmentation","wrinkle","hydration","sebum","skintone","sensitivity",
    "clarity","elasticity","redness","brightness","firmness","pores_depth",
  ];

  const baseTitle: Record<MetricId,[string,string]> = {
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
    const [en,zh] = baseTitle[id];
    return {
      id,
      title_en: en,
      title_zh: zh,
      score: m.score,
      details: (m.details || []).slice(0,3).map((d:any)=>({
        label_en: d.en,
        label_zh: d.zh,
        value: d.v,
      })),
    };
  });
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
          if (typeof c?.text === "string") {
            try { return JSON.parse(c.text); } catch {}
          }
        }
      }
    }
  }
  throw new Error("OpenAI response parse failed");
}

async function generateCardsWithOpenAI(metrics: any[]) {
  const openaiKey = mustEnv("OPENAI_API_KEY");
  const schema = cardSchema();

  const system = `
You are HONEY.TEA · Skin Vision Engine, a narrative layer sitting on top of a calibrated skin instrument.

NON-NEGOTIABLE RULES:
- Treat all incoming metrics as calibrated readings. Never modify scores or detail values.
- You are not a clinic, not a doctor, not a therapist. No diagnosis, no "treatment", no "patient", no "disease", no "cure".
- Tone: quiet, confident, instrument-grade. American tech 2026-2030. No exclamation marks, no hype, no emoji.
- Favour words like: baseline, threshold, stability band, variance, drift, trajectory, cadence, window, recovery.
- Avoid words like: flawless, perfect, miracle, promise, guarantee.

STRUCTURE PER METRIC (card):
- signal_en (LONG):
  - Paragraph 1: a calm verdict in plain language, positioned against a cohort baseline.
  - Paragraph 2: what the instrument is actually "seeing" in the image pattern or data.
  - Paragraph 3: interpret the 3 detail values and explain how they fit together as a system.
  - Paragraph 4: describe current "risk window" and "growth room".

- signal_zh (VERY LONG):
  【系統判斷說明】
  - 說明這個指標目前落在什麼區間（基準、臨界、穩定帶或偏離帶）。
  - 用「系統看到的影像/數值模式」來描述，不用感受用語。
  
  【細項數據如何被解讀】
  - 逐一解釋 3 個細項，每個細項都要對應實際生活裡「看得到 / 感受得到」的變化。
  
  【危機窗口與緩衝帶】
  - 描述如果維持現在的使用習慣，可能出現的惡化路徑。
  - 指出目前還保留哪些「緩衝帶」。
  
  【系統建議（為什麼是這個建議）】
  - 說明策略與節奏：什麼要「穩定」、什麼要「削弱」、什麼要「拉高」。
  - 如果提到時間或幅度，一律用「模型預估」或「傾向」，不做承諾。

- recommendation_en: 2-4 sentences, strategy-level only, no product naming.
- recommendation_zh: 延伸【系統建議】那一段，讓人看得懂「先做什麼、暫停什麼、可以期待什麼樣的趨勢線」。

PRIORITY LOGIC:
- Core signals (give higher priority and deeper narratives): texture, hydration, pigmentation, pore, wrinkle, sensitivity, skintone, firmness.
- The remaining metrics still need full narratives, but can be slightly more concise.

OUTPUT: Follow the JSON schema exactly. Do not add extra keys.
`.trim();

  const user = `
Metrics (ground truth from instrument):
${JSON.stringify(metrics, null, 2)}

Additional constraints:
- DO NOT change any score or detail value.
- Keep titles exactly as provided (title_en/title_zh).
- max must be 100 for all metrics.
- Priority: TEXTURE and HYDRATION top two, then pigmentation, pore, wrinkle, sensitivity, skintone, firmness. Remaining follow. All unique 1-100.
- Confidence: 0.78-0.92 depending on signal clarity.
- Language style: EN calm instrument-like, ZH professional but readable, no medical terms, no hype.
`.trim();

  const body = {
    model: "gpt-4o",
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
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI error: ${r.status} ${JSON.stringify(j)}`);

  return extractStructuredJson(j);
}

/* =========================
   Fallback buildCards - 14 deep narratives
   ========================= */
function buildCards(raw: any): Card[] {
  const r = raw;

  const det = (m: any) =>
    (m?.details || []).slice(0, 3).map((d: any) => ({
      label_en: d.en,
      label_zh: d.zh,
      value: d.v,
    }));

  const cards: Card[] = [
    // 1. TEXTURE
    {
      id: "texture",
      title_en: "TEXTURE",
      title_zh: "紋理",
      score: r.texture.score,
      max: 100,
      signal_en:
        "Your texture signal sits below the cohort baseline, not as a red flag, but as an early structural message. " +
        "The instrument is reading micro‑unevenness in how light travels across the surface, which usually comes from how water and lipids are being held in place over time. " +
        "Roughness, smoothness and evenness together describe how continuous that surface really is, not just under ideal lighting, but across normal movement and expression. " +
        "Here, the metrics suggest that fine irregularities are no longer random noise; they are starting to behave like a pattern. " +
        "When surface continuity drifts, every other signal begins to inherit that instability, which is why texture behaves like architecture, not decoration.",
      signal_zh:
        "【系統判斷說明】\n" +
        "目前的紋理分數落在同齡族群的偏低區間，系統並不把它視為「壞掉」，而是視為「結構開始鬆動」的早期訊號。 " +
        "影像中可以看到光線在肌膚表面的反射不再是大面積的連續面，而是被拆成許多細小、零碎的單位：在某些角度忽明忽暗、在部分區域出現細微顆粒感。 " +
        "這代表角質層已經不再長時間維持在同一種排列，而是在每天的清潔、補水與拉乾之間被反覆重組。\n\n" +
        "【細項數據如何被解讀】\n" +
        "粗糙度：顯示表層微小起伏的頻率偏高，常見於洗後拉乾、再急速補水的節奏，角質來不及以有秩序的方式重排。 \n" +
        "平滑度：反射面不連續，代表保濕與油脂無法形成穩定薄膜，而是以「一塊一塊」的方式分佈在臉上。 \n" +
        "均勻度：不同區塊的密度落差變大，出現「先乾先塌」的小範圍區域，讓妝感與觸感看起來不一致。\n\n" +
        "【危機窗口與緩衝帶】\n" +
        "若維持現在的節奏，在壓力高、睡眠不足、換季或長時間待在冷氣房時，這些細微紋理會被放大成肉眼可見的乾紋與粗糙。 " +
        "但系統仍偵測到回復能力存在，代表你還保留一段「緩衝帶」：只要結構性保濕與清潔強度開始收斂，紋理還不會被鎖定成深層紋路。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "在這個狀態下，系統不建議強攻去角質或頻繁使用刺激性配方，而是先重建「連續保濕膜」。 " +
        "透過溫和清潔、減少機械拉扯，以及固定時間、固定組合的保濕與油脂，讓角質重新以穩定節奏回復排列。 " +
        "模型預估：若此節奏能維持 2–3 週，紋理訊號有明顯回升空間，且不會伴隨反彈粗糙。",
      details: det(r.texture),
      recommendation_en:
        "Treat texture as an architecture layer. Reduce mechanical disruption, replace it with a stable cleansing and replenishment cadence, and give the surface enough time to rebuild continuity before adding any intensive steps.",
      recommendation_zh:
        "把紋理當成「結構工程」：先減少過度清潔、頻繁搓揉與強力去角質，改以溫和清潔＋規律補水油的方式，讓角質有機會在同一個節奏裡重建排列。 " +
        "當表層開始呈現連續面時，後續不論是亮度、妝感或細緻度，改善都會變得更乾淨、也比較不會反覆拉鋸。",
      priority: 98,
      confidence: 0.9,
    },

    // 2. HYDRATION
    {
      id: "hydration",
      title_en: "HYDRATION",
      title_zh: "含水與屏障",
      score: r.hydration.score,
      max: 100,
      signal_en:
        "Hydration is tracking below the ideal stability band, but the pattern points to retention issues rather than supply shortage. " +
        "Surface and deeper readings are decoupled, which means the skin can still receive water, but struggles to keep it in the right layer long enough. " +
        "In this configuration, everyday shifts in cleansing strength, air conditioning or stress are amplified into visible changes in texture and comfort.",
      signal_zh:
        "【系統判斷說明】\n" +
        "含水指標目前落在理想帶的下緣，表層與深層數值之間存在明顯落差。系統判斷，你並不是完全沒有補水，而是「水進得來、留不住」。 " +
        "深層仍看得到一定水庫，但表層容易隨環境與清潔強度而劇烈波動。\n\n" +
        "【細項數據如何被解讀】\n" +
        "表層含水：一旦過低，任何細微紋路、妝感卡粉與緊繃感都會被放大，這是日常體感中最直接被注意到的一層。 \n" +
        "深層含水：顯示身體與保養輸入仍具備供應能力，但若沒有相對應的鎖水結構，這些水很快會被風、冷氣、擦拭帶走。 \n" +
        "TEWL（經皮水分流失）：偏高代表表層鎖水機制鬆動，屏障並未完全破壞，但已離開穩定帶，屬於「若不處理就會往敏感與粗糙前進」的區段。\n\n" +
        "【危機窗口與緩衝帶】\n" +
        "在目前狀態下，若維持強清潔、頻繁熱水沖洗或忽冷忽熱環境，含水會優先在額頭、鼻翼與臉頰外側出現明顯下滑， " +
        "長期會拉動紋理、敏感、毛孔與色素等指標一起走向不穩定。好消息是：深層水庫仍存在，代表還有一段可以「穩定拉回」的窗口，不必以激烈手段處理。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "系統優先推薦「結構型保濕」，而不是短時間內大量灌水。也就是說，與其一口氣堆疊多種高保濕產品，不如先確保：清潔不過度、 " +
        "每天在相似時間點重複補上神經醯胺＋保濕因子＋溫和油脂的組合。這會讓表層含水與深層含水重新對齊，減少經皮失水的振幅。 " +
        "在這樣的節奏下，模型預估約 2 週可先把含水拉回穩定帶，4 週後紋理與敏感相關指標會開始出現平滑而非劇烈的改善曲線。",
      details: det(r.hydration),
      recommendation_en:
        "Prioritize structural hydration over short-term plumping: gentle cleansing, a stable ceramide-plus-humectant core and predictable timing. " +
        "Once surface and deep hydration re-align, other signals like texture, sensitivity and brightness can improve along a cleaner trajectory.",
      recommendation_zh:
        "先把「每天同一時間、同一套保濕與鎖水組合」做穩，而不是追求瞬間的水光感。減少高溫熱水洗臉、縮短洗澡後到完成保養的時間差， " +
        "再以高相容性的保濕配方穩穩疊上去。當含水回到穩定帶，你會發現很多原本以為是『敏感』或『粗糙』的問題，其實只是長期缺乏穩定含水所累積出來的噪音。",
      priority: 96,
      confidence: 0.89,
    },

    // 3. PIGMENTATION
    {
      id: "pigmentation",
      title_en: "PIGMENTATION",
      title_zh: "色素沉著",
      score: r.pigmentation.score,
      max: 100,
      signal_en:
        "Pigment activity presents as surface‑weighted clusters rather than deep, fixed plates. " +
        "This pattern usually responds to consistent protection and low‑irritation brightening, as long as the cadence is stable and the barrier is not under constant stress.",
      signal_zh:
        "【系統判斷說明】\n" +
        "色素沉著屬於「表層累積型」訊號：不是一次爆發，而是長期在防護與修護節奏上出現小縫隙，疊加成可見斑點與暗沉。 " +
        "目前分布顯示，多數色素仍停留在較淺層，尚未形成深層板塊式沉著。\n\n" +
        "【細項數據如何被解讀】\n" +
        "棕色斑點：代表日常曝曬、防曬補擦與外出習慣留下的足跡，與『有沒有擦防曬』相比，更關鍵的是『有沒有在該補的時間點補上』。 \n" +
        "紅色區：提示表層仍存在輕度發炎或刺激歷史，提醒在選擇亮白成分時，要優先考慮刺激門檻，而不是濃度上限。 \n" +
        "暗沉度：反映光線在角質表層的散射狀態，常常與含水與紋理一同波動，而不是單純由色素本身決定。\n\n" +
        "【危機窗口與緩衝帶】\n" +
        "若目前的防護與亮白節奏持續不穩定，系統預期色素會在壓力大、睡眠不足與強烈日照季節中累積得更快，形成觀感上的『一夜變老』。 " +
        "但此時指標仍然顯示：多數累積尚在可逆範圍，只要把輸入變成連續訊號，而不是時好時停，趨勢就有機會反轉。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "策略重點不是堆疊更刺激的亮白，而是建立「低刺激亮白＋穩定防曬」的固定組合，並讓這個組合出現在每天相似的時間點。 " +
        "當防護與亮白變成背景節奏，而不是偶爾被想起來的儀式，色素沉著會以緩慢但確實的速度鬆動。",
      details: det(r.pigmentation),
      recommendation_en:
        "Run a fixed brightening‑plus‑protection protocol, favouring low‑irritation formulas you can keep for months instead of intense, short cycles. " +
        "The instrument’s readings suggest that consistency will do more than another round of escalation.",
      recommendation_zh:
        "把「每日防曬＋低刺激亮白」當成永續習慣，而不是短期衝刺專案。保持防護節奏穩定，" +
        "再以溫和亮白成分長期稀釋既有色素，會比頻繁更換高刺激產品來得乾淨、安全。",
      priority: 94,
      confidence: 0.86,
    },

    // 4. PORE
    {
      id: "pore",
      title_en: "PORE",
      title_zh: "毛孔",
      score: r.pore.score,
      max: 100,
      signal_en:
        "Pore visibility sits inside a controlled band, indicating that your current cleansing and removal decisions are largely working. " +
        "At this stage, stability is more valuable than another round of intensification, because over‑correction tends to push this signal back into turbulence.",
      signal_zh:
        "【系統判斷說明】\n" +
        "毛孔訊號落在可管理的穩定帶，代表你在清潔頻率、卸妝強度與後續補水之間，已經建立出一個基本可用的節奏。 " +
        "系統看到的不是失控的放大，而是可以被維持、也可以被細緻調整的狀態。\n\n" +
        "【細項數據如何被解讀】\n" +
        "T 區：可見度略高屬正常，與皮脂分佈、生活節奏和妝容持久度有關。 \n" +
        "臉頰：數值顯示屏障尚未被過度刷洗打散，這是目前的一大優勢。 \n" +
        "下巴：反映局部代謝與油水平衡的穩定度，若能維持，就不需要額外重手處理。\n\n" +
        "【危機窗口與緩衝帶】\n" +
        "在這個狀態下，最大的風險不是『太大』，而是因為想要更小，而將酸類、刷頭、深層清潔面膜堆得太密， " +
        "導致原本穩定的區域被拉回波動帶，出現反覆粗糙與出油失衡。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "對這組指標，系統建議你的策略是『守住節奏』而不是『再加強』。讓毛孔維持在可預期的穩定範圍， " +
        "再把更多資源放在紋理、含水與色素這些會影響整體觀感的信號上，回報會更高。",
      details: det(r.pore),
      recommendation_en:
        "Maintain your current cleansing cadence, avoid stacking additional stripping steps, and allow pore visibility to remain a background metric instead of a constant project.",
      recommendation_zh:
        "毛孔目前已在可控範圍，建議維持既有清潔與補水習慣，不必過度追加強度。把注意力拉回到紋理與含水， " +
        "會讓整體觀感與妝感的改變，比單獨追毛孔尺寸更有感。",
      priority: 92,
      confidence: 0.84,
    },

    // 5. WRINKLE
    {
      id: "wrinkle",
      title_en: "WRINKLE",
      title_zh: "細紋與摺痕",
      score: r.wrinkle.score,
      max: 100,
      signal_en:
        "Fine‑line activity remains within expected variance for your cohort. " +
        "This is an active prevention window: the structure still responds well to consistent support, and the goal is to slow deepening momentum rather than erase every visible line.",
      signal_zh:
        "【系統判斷說明】\n" +
        "細紋與摺痕指標顯示，你仍在可以「慢下來」而非「急著追趕」的區段。 " +
        "系統關注的不是年齡本身，而是紋路形成後能否在合理時間內回彈，以及是否已出現固定折痕。\n\n" +
        "【細項數據如何被解讀】\n" +
        "眼周：屬活動型細紋，對保濕、含水穩定與適度抗老成分非常敏感，也是最值得投資的區域。 \n" +
        "額頭：反映表情習慣與含水狀態的疊加，若基礎含水不足，紋路會更容易被鎖定。 \n" +
        "法令紋：尚未完全固定成深摺痕時，是最值得用「穩定支撐」延後進程的階段。\n\n" +
        "【危機窗口與緩衝帶】\n" +
        "如果此時選擇高刺激、週期性爆衝式的抗老方式（例如頻繁更換高濃度成分）， " +
        "容易讓敏感與含水指標先被推入不穩定，再由此拉動紋理與色素一起惡化。反之，穩定且可長期執行的抗老節奏， " +
        "會讓紋路的變化曲線變得平緩，讓你在未來幾年看到的是「速度變慢」，而不是「突然變好又突然變差」。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "系統建議以長期可維持的節奏為核心：保持含水與屏障穩定，搭配適中強度、可以長期使用的抗老成分， " +
        "而非不斷提升濃度或層數。這樣可以在不放大的前提下，延緩紋路被固定成深刻摺痕。",
      details: det(r.wrinkle),
      recommendation_en:
        "Introduce and maintain a steady, tolerable anti‑aging cadence rather than cycling through aggressive peaks. " +
        "Your readings suggest that slowing the rate of change will deliver more value than chasing instant smoothing.",
      recommendation_zh:
        "把抗老當成「長跑」，而不是短期衝刺專案。選擇你能長期使用且皮膚接受度高的配方，" +
        "在含水與屏障穩定的前提下慢慢堆疊支撐，比反覆嘗試高強度、易中斷的方案更有利。",
      priority: 90,
      confidence: 0.85,
    },

    // 6. SEBUM
    {
      id: "sebum",
      title_en: "SEBUM",
      title_zh: "油脂平衡",
      score: r.sebum.score,
      max: 100,
      signal_en:
        "Sebum output sits in a manageable band with regional differences that are typical rather than extreme. " +
        "The main task now is to protect this balance from being pulled off-center by harsh cleansing or over‑correction.",
      signal_zh:
        "【系統判斷說明】\n" +
        "油脂指標顯示，你的皮脂分佈屬於「可控型」而非失衡型。系統在意的不是『有沒有出油』，而是『出油的分佈與波動是否失控』。\n\n" +
        "【細項數據如何被解讀】\n" +
        "T 區：稍高屬常態，但仍在可管理範圍。 \n" +
        "臉頰：未被拉到極度乾燥，代表清潔並未過度破壞屏障。 \n" +
        "下巴：反映生活節奏、飲食與荷爾蒙相關變動時的敏感區，需要的是穩定觀察，而不是立刻重手處理。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "現階段最重要的是避免過度去脂與頻繁更換強效控油產品；保持溫和清潔與適度保濕，就能讓油脂維持在服務而非干擾的角色。",
      details: det(r.sebum),
      recommendation_en:
        "Maintain your current cleansing and hydration rhythm, avoid stripping formulas, and let sebum play its protective role instead of treating it as an enemy.",
      recommendation_zh:
        "守住現在已經建立的清潔與保濕節奏即可，不必以強力控油為目標。當油脂被當成結構的一部分而非敵人時，整體穩定度會更高。",
      priority: 82,
      confidence: 0.82,
    },

    // 7. SKIN TONE
    {
      id: "skintone",
      title_en: "SKIN TONE",
      title_zh: "膚色一致性",
      score: r.skintone.score,
      max: 100,
      signal_en:
        "Tone evenness is broadly stable with local deviations. " +
        "This is the kind of pattern that improves not with drama, but with quiet, low‑irritation routines and consistent protection.",
      signal_zh:
        "【系統判斷說明】\n" +
        "膚色一致性指標顯示，整體帶有一定穩定度，但局部色差與明暗變化仍然存在。 " +
        "系統關注的是「是否在縮小差距」，而不是追求單一色塊式的統一。\n\n" +
        "【細項數據如何被解讀】\n" +
        "均勻度：代表大範圍的色調是否落在相近區間。 \n" +
        "亮度：關乎反射效率與含水，亮度提升往往仰賴結構穩定，而非單純變白。 \n" +
        "紅色指數：與刺激、溫度、壓力等交互作用高度相關，是觀察敏感風險的重要側面。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "系統建議你以低刺激、可長期使用的調理成分（例如菸鹼醯胺等）搭配穩定防護，" +
        "讓局部差異緩慢收斂，而不是透過一次性強力美白來找短期滿足。",
      details: det(r.skintone),
      recommendation_en:
        "Lean on low‑irritation tone‑supporting ingredients plus daily protection, aiming for smaller differences rather than a single flat shade.",
      recommendation_zh:
        "把目標從「變白」換成「變穩定」。選擇可以長期使用且不易刺激的膚色調理成分，搭配每日防護，" +
        "讓局部色差慢慢收斂，比起追求短暫亮白更符合長期利益。",
      priority: 80,
      confidence: 0.82,
    },

    // 8. SENSITIVITY
    {
      id: "sensitivity",
      title_en: "SENSITIVITY",
      title_zh: "刺激反應傾向",
      score: r.sensitivity.score,
      max: 100,
      signal_en:
        "Mild reactivity signals are present, suggesting your threshold is closer than average but still manageable. " +
        "This is the moment to design routines around stability first, intensity second.",
      signal_zh:
        "【系統判斷說明】\n" +
        "敏感指標顯示，你的刺激門檻比一般略低，但尚未落入高風險帶。 " +
        "系統關注的是「距離門檻還有多少緩衝」，而不是簡單地貼上『敏感肌』標籤。\n\n" +
        "【細項數據如何被解讀】\n" +
        "泛紅指數：說明皮膚在面對環境、溫度或成分變化時，紅的速度與程度。 \n" +
        "屏障功能：反映保護結構在日常運作中的穩定度，是所有進階保養的基礎。 \n" +
        "刺激反應傾向：預告在強度拉高時，最有可能先出問題的就是這一層。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "當門檻已經偏近時，最應該追求的是穩定，而不是一次塞進所有厲害成分。 " +
        "系統建議你優先建立「可長期維持、不常改變」的基礎保養節奏，再逐步測試進階產品，而不是一次全上。",
      details: det(r.sensitivity),
      recommendation_en:
        "Design your routine around stability. Keep a calm, low‑reactivity base you rarely change, then layer experiments slowly and one at a time above that foundation.",
      recommendation_zh:
        "先做出一套在任何狀態下都能安全執行的『穩定底盤』保養流程，在這個底盤確認穩定前，不同品牌與高強度成分不要同時大量進場。 " +
        "當系統偵測到波動變小後，再逐一測試進階產品，你會更清楚知道哪一個步驟真正有效。",
      priority: 78,
      confidence: 0.82,
    },

    // 9. CLARITY
    {
      id: "clarity",
      title_en: "CLARITY",
      title_zh: "表層清晰度",
      score: r.clarity.score,
      max: 100,
      signal_en:
        "Surface clarity is stable with room for refinement. " +
        "The instrument reads a mix of clean reflection zones and mild noise, which often shifts in parallel with hydration and texture rather than in isolation.",
      signal_zh:
        "【系統判斷說明】\n" +
        "清晰度並不是單純的『白』或『不白』，而是看表層是否能在不同光線下維持乾淨、連續的反射。 " +
        "目前訊號顯示，你已經脫離混濁帶，但仍有些雜訊存在。\n\n" +
        "【細項數據如何被解讀】\n" +
        "微反射與對比區，反映出光線在皮膚上的散射與集中程度；穩定度則關係到一天之內變化是不是太大。 " +
        "這些數值通常會跟紋理與含水一起變好或變差，而不是單獨行動。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "系統建議你先把含水與紋理的趨勢線拉乾淨，再來談清晰度。當底層結構穩定，清晰度會自然跟上，" +
        "不需要額外追求極端亮白。",
      details: det(r.clarity),
      recommendation_en:
        "Treat clarity as an outcome of structure. Focus on steady hydration and texture support first; clarity will follow as noise is reduced.",
      recommendation_zh:
        "不要直接追求『變亮』，先把含水、紋理與屏障穩定下來。當這三者回到穩定帶，清晰度就會像開燈一樣慢慢被打亮，而不是靠刺激硬撐出來。",
      priority: 76,
      confidence: 0.81,
    },

    // 10. ELASTICITY
    {
      id: "elasticity",
      title_en: "ELASTICITY",
      title_zh: "彈性回彈",
      score: r.elasticity.score,
      max: 100,
      signal_en:
        "Elasticity reads as supported and recoverable. " +
        "The signal suggests that your skin still uses available rest and hydration windows to rebound, which is ideal for long‑term prevention.",
      signal_zh:
        "【系統判斷說明】\n" +
        "彈性回彈指標顯示，你的皮膚在受到日常壓力與表情變化影響後，仍具備不錯的回復能力。 " +
        "這代表支撐結構尚未進入崩解階段，而是處在『可以被保護』的狀態。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "此時最划算的做法，是讓回彈維持在現在的穩定線，而不是追求短時間內的緊繃感。 " +
        "透過均衡作息、穩定含水與適度支撐型保養，你可以把這段「仍然願意配合你」的結構拉長很多年。",
      details: det(r.elasticity),
      recommendation_en:
        "Protect rebound by avoiding intensity spikes. Consistent support and recovery windows will do more than short‑term tightening tricks.",
      recommendation_zh:
        "把重點放在『讓皮膚有機會休息與回彈』：包括睡眠、壓力管理與不過度刺激的保養節奏。 " +
        "當回彈保持穩定，你未來在抗老策略上的選擇餘地會更大。",
      priority: 74,
      confidence: 0.8,
    },

    // 11. REDNESS
    {
      id: "redness",
      title_en: "REDNESS",
      title_zh: "泛紅強度",
      score: r.redness.score,
      max: 100,
      signal_en:
        "Redness intensity is present but not dominating the overall map. " +
        "The pattern points to localized hotspots rather than global inflammation, which is a good position to refine from.",
      signal_zh:
        "【系統判斷說明】\n" +
        "泛紅指標顯示，你的紅並不是全面性鋪開，而是集中在特定熱點區。 " +
        "這種型態更適合用『減少刺激源＋穩定屏障』的方式處理，而不是急著把所有紅色一起壓下去。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "系統建議你先盤點日常可能的刺激來源，把明顯的高風險因子（例如頻繁去角質、含高酒精的產品）暫時後撤，" +
        "再讓保濕與修護成為主角。當泛紅波動被拉小，你才能更準確地觀察其他指標的變化。",
      details: det(r.redness),
      recommendation_en:
        "Lower the background noise by trimming obvious irritants first, then let barrier‑supporting steps set a calmer baseline for every other metric.",
      recommendation_zh:
        "先把『不必要的刺激』減到最低，例如過頻去角質、高濃度酒精或香精，讓皮膚有機會回到比較安靜的狀態。 " +
        "在這個基礎上，再視需要調整其他功能性保養，整體效果會更乾淨。",
      priority: 72,
      confidence: 0.8,
    },

    // 12. BRIGHTNESS
    {
      id: "brightness",
      title_en: "BRIGHTNESS",
      title_zh: "亮度狀態",
      score: r.brightness.score,
      max: 100,
      signal_en:
        "Brightness is broadly stable with mild shadow‑zone deviation. " +
        "Most of what you are seeing is a reflection of structure and hydration, not a lack of whitening.",
      signal_zh:
        "【系統判斷說明】\n" +
        "亮度訊號顯示，你的整體反射仍在穩定帶，只是局部陰影區與光線分布還有優化空間。 " +
        "系統將亮度視為結構與含水的結果，而不是單純的『白或不白』。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "當含水、紋理與屏障被穩定後，亮度自然會上升。若在基礎不穩時急著導入大量強力亮白，容易讓敏感與色素同時惡化。",
      details: det(r.brightness),
      recommendation_en:
        "Let brightness be the outcome of good structure. Focus on hydration and texture first; add gentle brightening only when the baseline is quiet.",
      recommendation_zh:
        "先讓含水與紋理回到乾淨的穩定線，再考慮溫和亮白成分。這樣拉出來的亮度會比較透明、也不容易伴隨刺激與反黑。",
      priority: 70,
      confidence: 0.79,
    },

    // 13. FIRMNESS
    {
      id: "firmness",
      title_en: "FIRMNESS",
      title_zh: "緊緻支撐",
      score: r.firmness.score,
      max: 100,
      signal_en:
        "Firmness support appears present and functional. " +
        "The instrument reads a structure that still holds shape under daily load, which is the best moment to invest in protection rather than repair.",
      signal_zh:
        "【系統判斷說明】\n" +
        "緊緻支撐指標顯示，你的結構仍有能力撐住輪廓與日常表情負載，尚未進入崩塌階段。 " +
        "這是一個以『守成』為主的區段：重點在於延長穩定期，而不是期待短時間內驚人拉提。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "此時最值得做的是照顧生活與保養節奏，讓支撐結構不要被頻繁熬夜、高壓與強刺激保養來回拉扯。 " +
        "穩定的作息、含水與適度抗老成分，合在一起會把這段黃金穩定期拉長。",
      details: det(r.firmness),
      recommendation_en:
        "Treat firmness as a capacity you want to preserve. Keep lifestyle and skincare inputs from swinging too hard, so the structure can age slowly instead of unevenly.",
      recommendation_zh:
        "把現在視為『延長穩定期』的階段：盡量減少作息與壓力的大幅波動，在規律生活與穩定保養之上，" +
        "再適度疊加支撐型成分。這樣做的回報，不是突然拉提，而是未來幾年看起來始終很穩。",
      priority: 68,
      confidence: 0.79,
    },

    // 14. PORES DEPTH
    {
      id: "pores_depth",
      title_en: "PORE DEPTH",
      title_zh: "毛孔深度感",
      score: r.pores_depth.score,
      max: 100,
      signal_en:
        "Perceived pore depth is driven mainly by edge definition and local contrast. " +
        "In practice, this signal improves when texture, hydration and oil balance are disciplined, even without chasing aggressive resurfacing.",
      signal_zh:
        "【系統判斷說明】\n" +
        "毛孔深度感並不是單一數字，而是邊界清晰度、陰影對比與周圍紋理共同疊加的結果。 " +
        "目前指標顯示，你的深度感屬於可被調整的範圍，尚未固定成明顯凹陷。\n\n" +
        "【系統建議（為什麼是這個建議）】\n" +
        "與其直接鎖定『把洞填平』，系統更建議你先從紋理、含水與油脂平衡三個角度同步調整。 " +
        "當邊界變得乾淨、陰影被減少、表層變得平順，深度感就會自然下降。",
      details: det(r.pores_depth),
      recommendation_en:
        "Work on the frame around each pore—texture, hydration, and oil control—rather than attacking the opening itself. " +
        "Depth perception will soften as the surrounding surface becomes smoother and more consistent.",
      recommendation_zh:
        "把注意力放在『毛孔周圍的環境』：讓紋理更平順、含水更穩定、油脂不要忽乾忽油。 " +
        "當這些條件被整理好，毛孔深度感會像鏡頭拉遠一樣變得不明顯，而不需要用極端手段去刺激表皮。",
      priority: 66,
      confidence: 0.78,
    },
  ];

  cards.sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  return cards;
}
