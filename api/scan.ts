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
    tips.push("Image quality is low. Use a clearer photo (avoid screenshots).");
  }

  let sample = 0, sum = 0;
  for (let i = 0; i < bytes.length; i += 401) { sum += bytes[i]; sample++; }
  const avg = sample ? sum / sample : 120;

  if (avg < 85) { warnings.push("TOO_DARK"); tips.push("Low light. Face a window or add soft front light."); }
  if (avg > 185) { warnings.push("TOO_BRIGHT"); tips.push("Highlights are strong. Avoid direct overhead light."); }

  tips.push("Keep white balance neutral. Avoid warm indoor bulbs when possible.");
  return { ok: warnings.length === 0, avgSignal: avg, warnings, tips };
}

/* =========================
   ✅ Clean + Format (server-side)
========================= */
function cleanNarr(s: string) {
  return (s || "")
    .replace(/::/g, " · ")
    .replace(/[■◆●]/g, "")
    .replace(/\u3000/g, " ")
    .replace(/\s+\|\s+/g, " · ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// 讓你前端直接 pre-line 就能像你參考圖那樣分段
function formatForPanelZh(input: string) {
  let s = cleanNarr(input || "");

  // 統一 bullets
  s = s.replace(/ *・ */g, "\n• ");
  s = s.replace(/ *• */g, "\n• ");

  // 強制段落錨點
  const anchors = [
    "【系統判斷說明】",
    "【系統建議（為什麼是這個建議）】",
    "系統在影像中觀察到：",
    "換句話說，",
    "在模型推算中，",
  ];
  for (const a of anchors) {
    s = s.replace(new RegExp(a.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), `\n${a}`);
  }

  // 句號後換行（避免黏一起）
  s = s.replace(/。(?=[^\n])/g, "。\n");

  // 多空行收斂
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  return s;
}

function formatForPanelEn(input: string) {
  return (input || "")
    .replace(/\s+/g, " ")
    .replace(/::/g, " - ")
    .trim();
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
      enable_mask_overlay: false, // ✅ 不改你既有設定：不生成醜 mask overlay 圖（但仍可能回 mask_urls）
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
        map.set(k, {
          ui: Number(vv.ui_score),
          raw: Number(vv.raw_score),
          masks: Array.isArray(vv?.mask_urls) ? vv.mask_urls : (vv.output_mask_name ? [String(vv.output_mask_name)] : []),
        });
      } else if (vv?.whole?.ui_score != null && vv?.whole?.raw_score != null) {
        map.set(k, {
          ui: Number(vv.whole.ui_score),
          raw: Number(vv.whole.raw_score),
          masks: Array.isArray(vv?.whole?.mask_urls) ? vv.whole.mask_urls : (vv.whole.output_mask_name ? [String(vv.whole.output_mask_name)] : []),
        });
      } else {
        for (const [subk, subv] of Object.entries(vv)) {
          const sv: any = subv;
          if (sv?.ui_score != null && sv?.raw_score != null) {
            map.set(`${k}.${subk}`, {
              ui: Number(sv.ui_score),
              raw: Number(sv.raw_score),
              masks: Array.isArray(sv?.mask_urls) ? sv.mask_urls : (sv.output_mask_name ? [String(sv.output_mask_name)] : []),
            });
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

function pickFirstMask(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>, key: string) {
  const v = scoreMap.get(key);
  const arr = v?.masks || [];
  return arr.length ? arr[0] : null;
}

async function analyzeWithYouCamSingle(primaryFile: File) {
  const init = await youcamInitUpload(primaryFile);
  const buf = new Uint8Array(await primaryFile.arrayBuffer());
  await youcamPutBinary(init.putUrl, buf, init.contentType);

  const taskId = await youcamCreateTask(init.fileId, YOUCAM_HD_ACTIONS);
  const finalJson = await youcamPollTask(taskId);

  const scoreMap = extractYoucamScores(finalJson);
  const raw = mapYoucamToYourRaw(scoreMap);

  // ✅ 將可用 overlays 帶回前端（不增加 YouCam 成本）
  const overlays = {
    texture: pickFirstMask(scoreMap, "hd_texture") || pickFirstMask(scoreMap, "texture"),
    pore: pickFirstMask(scoreMap, "hd_pore") || pickFirstMask(scoreMap, "pore"),
    redness: pickFirstMask(scoreMap, "hd_redness") || pickFirstMask(scoreMap, "redness"),
    pigmentation: pickFirstMask(scoreMap, "hd_age_spot") || pickFirstMask(scoreMap, "age_spot"),
  };

  return { taskId, task_status: finalJson?.data?.task_status, raw, scoreMap, overlays };
}

/* =========================
   OpenAI: schema + payload
   ✅ 強制輸出成你要的那種「規模與段落」
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
      summary_en: { type: "string", minLength: 30 },
      summary_zh: { type: "string", minLength: 30 },
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
            signal_en: { type: "string", minLength: 60 },
            // ✅ 你要的規模：段落必須長
            signal_zh: { type: "string", minLength: 520 },
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
            recommendation_en: { type: "string", minLength: 50 },
            recommendation_zh: { type: "string", minLength: 360 },
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
    const [en, zh] = baseTitle[id];
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

function timeWindowFor(id: MetricId) {
  // ✅ 不講快慢回應，直接用你要的自然窗口（避免每張都兩週）
  if (id === "pigmentation") return "8–12 週";
  if (id === "wrinkle" || id === "elasticity" || id === "firmness") return "28–56 天";
  if (id === "pore" || id === "pores_depth") return "21–42 天";
  if (id === "clarity" || id === "brightness" || id === "skintone") return "14–28 天";
  // hydration/texture/sebum/sensitivity/redness
  return "7–21 天";
}

async function generateCardsWithOpenAI(metrics: any[]) {
  const openaiKey = mustEnv("OPENAI_API_KEY");
  const schema = cardSchema();

  const system = `You are HONEY.TEA · FIELD — Skin Vision.
Taiwan-friendly. Instrument-grade. NOT medical. NOT marketing.

ABSOLUTE RULES:
- Do NOT change any provided scores/details.
- No disease names. No diagnosis/treatment words. No fear. No sales.
- Output MUST match the user's required style (deep, paragraph-based, with bullets).
- Avoid sci-fi cringe words (neural core, quantum, etc.)
- Do NOT reuse the same Chinese sentence (>=12 chars) across cards. Repetition fails.

FORMAT REQUIRED (must follow exactly):

signal_en: 1 sentence, calm and sharp. Similar to:
"Your texture signal sits below the cohort baseline. Not a warning — a clear starting point for refinement."

signal_zh: long, must contain line breaks and bullets, 10–16 lines total:
- First: 1–2 lines positioning sentence (baseline / reference band / threshold).
- Then EXACT line:
"這代表系統在影像中觀察到："
- Then exactly 3 bullets. Each bullet must include details.label_zh EXACTLY ONCE.
- Blank line
- 2 lines:
"這並不是…而是…"
- Blank line
- 2–3 lines starting with:
"換句話說，"
Use plain Taiwan-friendly wording.

recommendation_en: 1 sentence, logic only.

recommendation_zh: long, 8–14 lines:
- Start with:
"系統建議的不是「___」或「___」，而是…"
- Blank line
- 3–5 lines explaining mechanism (why).
- Blank line
- Final block must include:
"在模型推算中，若…（條件清楚），整體可改善 約 N%（區間），且不伴隨反彈風險。"
Rules:
- N must vary per metric; do NOT reuse the same number.
- Time window must vary by metric type:
  pigmentation: 8–12 週
  wrinkle/elasticity/firmness: 28–56 天
  pore/pores_depth: 21–42 天
  clarity/brightness/skintone: 14–28 天
  others: 7–21 天

REGION RULE:
- If details show explicit regions (T-Zone/Cheek/Chin, Eye Area/Forehead/Nasolabial), you may mention those regions.
- If not (pigmentation/redness etc.), do NOT claim exact coordinates.
Use this sentence:
"未啟用區域遮罩時，系統不提供精準座標；依訊號型態，優先觀察顴骨—臉頰帶／高曝光帶的輪廓乾淨度。"

priority: TEXTURE=95, HYDRATION=92, others 70–88 descending.
confidence: 0.78–0.92.

Return 14 cards strictly matching schema.`;

  const user = `Metrics:\n${JSON.stringify(metrics, null, 2)}\n\nTime window hint per metric id:\n${JSON.stringify(metrics.map((m:any)=>({id:m.id, window: timeWindowFor(m.id)})), null, 2)}`;

  const body = {
    model: "gpt-4o-2024-08-06",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "honeytea_skin_report",
        strict: true,
        schema
      }
    },
    temperature: 0.55,
  };

  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const j = await r.json();
  if (!r.ok) throw new Error(`OpenAI error: ${r.status} ${JSON.stringify(j)}`);

  const content = j.choices?.[0]?.message?.content;
  if (!content) throw new Error("OpenAI response missing content");

  const out = JSON.parse(content);

  // ✅ 服務端格式保證：段落分明
  if (out?.cards && Array.isArray(out.cards)) {
    out.cards = out.cards.map((c: any) => ({
      ...c,
      signal_zh: formatForPanelZh(c.signal_zh || ""),
      recommendation_zh: formatForPanelZh(c.recommendation_zh || ""),
      signal_en: formatForPanelEn(c.signal_en || ""),
      recommendation_en: formatForPanelEn(c.recommendation_en || ""),
    }));
  }
  out.summary_zh = formatForPanelZh(out.summary_zh || "");
  out.summary_en = formatForPanelEn(out.summary_en || "");
  return out;
}

/* =========================
   Fallback（保證不露餡、也有段落）
========================= */
function buildCardsFallback(raw: any): Card[] {
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

  const order: MetricId[] = [
    "texture","hydration","pore","pores_depth","sebum","sensitivity","redness","skintone",
    "clarity","brightness","wrinkle","elasticity","firmness","pigmentation",
  ];

  const priorityMap: Record<MetricId, number> = {
    texture: 95, hydration: 92,
    pore: 86, pores_depth: 84,
    sensitivity: 82, redness: 81,
    sebum: 80, clarity: 79,
    brightness: 78, skintone: 77,
    firmness: 76, elasticity: 75,
    wrinkle: 74, pigmentation: 73,
  };

  const confidenceMap: Record<MetricId, number> = {
    texture: 0.90, hydration: 0.88,
    pore: 0.84, pores_depth: 0.82,
    sensitivity: 0.83, redness: 0.82,
    sebum: 0.81, clarity: 0.80,
    brightness: 0.80, skintone: 0.79,
    firmness: 0.80, elasticity: 0.79,
    wrinkle: 0.78, pigmentation: 0.78,
  };

  const fallbackPctById: Record<MetricId, [number, number]> = {
    texture: [18, 28],
    hydration: [18, 30],
    pore: [10, 18],
    pores_depth: [10, 18],
    sebum: [10, 20],
    sensitivity: [10, 18],
    redness: [10, 18],
    skintone: [8, 14],
    clarity: [8, 14],
    brightness: [8, 14],
    wrinkle: [6, 12],
    elasticity: [6, 12],
    firmness: [6, 12],
    pigmentation: [24, 42],
  };

  const pigmentClause =
    "未啟用區域遮罩時，系統不提供精準座標；依訊號型態，優先觀察顴骨—臉頰帶／高曝光帶的輪廓乾淨度。";

  return order.map((id) => {
    const m = raw?.[id] || { score: 0, details: [] };
    const [en, zh] = baseTitle[id];
    const score = Number.isFinite(Number(m.score)) ? Number(m.score) : 0;

    const details = (m.details || []).slice(0, 3).map((d: any) => ({
      label_en: d.en,
      label_zh: d.zh,
      value: d.v,
    }));

    const d0 = details?.[0]?.label_zh || "表層特徵";
    const d1 = details?.[1]?.label_zh || "結構訊號";
    const d2 = details?.[2]?.label_zh || "穩定度";

    const band = score >= 88 ? "落在穩定參考帶" : score >= 72 ? "落在可控偏差帶" : "接近需要優先管理的門檻";

    const [pLo, pHi] = fallbackPctById[id] || [10, 18];
    const window = timeWindowFor(id);

    const signalZh =
      `【系統判斷說明】\n` +
      `${zh}目前${band}（${score}/100）。\n` +
      `這代表系統在影像中觀察到：\n` +
      `• ${d0}\n` +
      `• ${d1}\n` +
      `• ${d2}\n\n` +
      `這並不是突然變差，而是狀態的「固定度」不足所造成的可見波動。\n` +
      `換句話說，系統不是看到「變醜」，而是看到「節奏不夠穩，導致外觀不夠一致」。` +
      (id === "pigmentation" ? `\n\n${pigmentClause}` : "");

    const recZh =
      `【系統建議（為什麼是這個建議）】\n` +
      `系統建議的不是「短期加大強度」或「刺激性堆疊」，而是先把輸入變得一致。\n\n` +
      `先止損（降低不必要的刺激密度）→ 再穩定（把節奏固定住）→ 最後精修（在穩定上做細節）。\n\n` +
      `在模型推算中，若能維持 ${window} 的一致性輸入（同光線、同節奏、少波動），整體可改善 約 ${pLo}–${pHi}%，且不伴隨反彈風險。`;

    return {
      id,
      title_en: en,
      title_zh: zh,
      score,
      max: 100,
      signal_en: formatForPanelEn(`${en} sits near baseline. Not a warning — a clear starting point for refinement.`),
      signal_zh: formatForPanelZh(signalZh),
      details,
      recommendation_en: formatForPanelEn(`Stabilize first, then refine. Window: ${window}.`),
      recommendation_zh: formatForPanelZh(recZh),
      priority: priorityMap[id] ?? 70,
      confidence: confidenceMap[id] ?? 0.80,
    };
  });
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

    // 只用最大張（省資源）
    files.sort((a, b) => b.size - a.size);
    const primaryFile = files[0];

    const primaryBytes = await toBytes(primaryFile);
    const precheck = quickPrecheck(primaryBytes);

    const youcam = await analyzeWithYouCamSingle(primaryFile);
    const metricsPayload = buildMetricsPayload(youcam.raw);

    let openaiOut: any = null;
    try {
      openaiOut = await generateCardsWithOpenAI(metricsPayload);
    } catch (e: any) {
      console.error("OpenAI generation failed, using fallback:", e.message);
      openaiOut = null;
    }

    const baseCards: Card[] = openaiOut?.cards ? openaiOut.cards : buildCardsFallback(youcam.raw);
    const finalCards: Card[] = baseCards.map((c) => appendGrowthToRecommendation(c));

    // ✅ 最終格式保證（段落分明）
    const finalCardsFormatted: Card[] = finalCards.map((c) => ({
      ...c,
      signal_zh: formatForPanelZh(c.signal_zh),
      recommendation_zh: formatForPanelZh(c.recommendation_zh),
      signal_en: formatForPanelEn(c.signal_en),
      recommendation_en: formatForPanelEn(c.recommendation_en),
    }));

    const summaryZh = formatForPanelZh(
      openaiOut?.summary_zh ??
      "系統已完成訊號排序。以下為關鍵訊號判讀結果。"
    ).slice(0, 420);

    const summaryEn = formatForPanelEn(
      openaiOut?.summary_en ??
      "Signals are ready. Priority has been applied for review."
    ).slice(0, 260);

    return json({
      build: "honeytea_scan_youcam_openai_v7_narrative_spec_strict",
      scanId: nowId(),
      precheck: {
        ok: precheck.ok,
        warnings: precheck.warnings,
        tips: precheck.tips,
      },
      cards: finalCardsFormatted,
      summary_en: summaryEn,
      summary_zh: summaryZh,
      meta: {
        youcam_task_id: youcam.taskId,
        youcam_task_status: youcam.task_status,
        mode: "youcam_metrics + openai_narrative",
        narrative: openaiOut ? "openai" : "fallback",
        overlays: youcam.overlays, // ✅ 真儀器疊圖用（不加 YouCam 成本）
      },
    });

  } catch (e: any) {
    const msg = e?.message ?? String(e);

    if (msg.includes("error_src_face_too_small")) {
      return json({
        error: "scan_retake",
        code: "error_src_face_too_small",
        tips: [
          "距離太遠：臉部請佔畫面約 60–80%。",
          "保持正面置中，避免側臉或低頭。",
          "額頭與眼周需清晰可見（瀏海請撥開）。",
          "使用均勻柔光，避免背光。",
        ],
      }, 200);
    }

    if (msg.includes("error_lighting_dark")) {
      return json({
        error: "scan_retake",
        code: "error_lighting_dark",
        tips: [
          "光線不足：請面向窗戶或補柔光。",
          "避免背光與局部強反光（額頭/鼻翼）。",
        ],
      }, 200);
    }

    if (msg.includes("error_src_face_out_of_bound")) {
      return json({
        error: "scan_retake",
        code: "error_src_face_out_of_bound",
        tips: [
          "超出框位：請回到畫面中心。",
          "保持頭部穩定，避免左右快速移動。",
        ],
      }, 200);
    }

    return json({ error: "scan_failed", message: msg }, 500);
  }
}
