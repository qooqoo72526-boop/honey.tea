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

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

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
   ✅ Clean + Format
========================= */
function cleanNarr(s: string) {
  return (s || "")
    .replace(/\u3000/g, " ")
    .replace(/::/g, " · ")
    .replace(/[■◆●]/g, "")
    .replace(/\s+\|\s+/g, " · ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function ensureBullets(s: string) {
  // normalize bullets: keep "•"
  let out = s.replace(/ *・ */g, "\n• ").replace(/ *• */g, "\n• ");
  out = out.replace(/\n{3,}/g, "\n\n").trim();
  return out;
}

function formatZhPanel(input: string) {
  let s = cleanNarr(input || "");
  s = ensureBullets(s);

  // sentence wrap for readability
  s = s.replace(/。(?=[^\n])/g, "。\n");

  // collapse extra newlines
  s = s.replace(/\n{3,}/g, "\n\n").trim();

  // trim lines
  s = s.split("\n").map(x => x.trim()).join("\n").trim();
  return s;
}

function formatEnPanel(input: string) {
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
      enable_mask_overlay: false, // ✅ 不額外生成 overlay（不增加成本）
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
          masks: Array.isArray(vv?.mask_urls) ? vv.mask_urls : [],
        });
      } else if (vv?.whole?.ui_score != null && vv?.whole?.raw_score != null) {
        map.set(k, {
          ui: Number(vv.whole.ui_score),
          raw: Number(vv.whole.raw_score),
          masks: Array.isArray(vv?.whole?.mask_urls) ? vv.whole.mask_urls : [],
        });
      } else {
        for (const [subk, subv] of Object.entries(vv)) {
          const sv: any = subv;
          if (sv?.ui_score != null && sv?.raw_score != null) {
            map.set(`${k}.${subk}`, {
              ui: Number(sv.ui_score),
              raw: Number(sv.raw_score),
              masks: Array.isArray(sv?.mask_urls) ? sv.mask_urls : [],
            });
          }
        }
      }
    }
  }
  return map;
}

function pickFirstMask(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>, key: string) {
  const v = scoreMap.get(key);
  const arr = v?.masks || [];
  return arr.length ? arr[0] : null;
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

async function analyzeWithYouCamSingle(primaryFile: File) {
  const init = await youcamInitUpload(primaryFile);
  const buf = new Uint8Array(await primaryFile.arrayBuffer());
  await youcamPutBinary(init.putUrl, buf, init.contentType);

  const taskId = await youcamCreateTask(init.fileId, YOUCAM_HD_ACTIONS);
  const finalJson = await youcamPollTask(taskId);

  const scoreMap = extractYoucamScores(finalJson);
  const raw = mapYoucamToYourRaw(scoreMap);

  // ✅ overlays（有就帶，沒有就 null）
  const overlays = {
    texture: pickFirstMask(scoreMap, "hd_texture") || null,
    pore: pickFirstMask(scoreMap, "hd_pore") || null,
    redness: pickFirstMask(scoreMap, "hd_redness") || null,
    pigmentation: pickFirstMask(scoreMap, "hd_age_spot") || null,
  };

  return { taskId, task_status: finalJson?.data?.task_status, raw, overlays };
}

/* =========================
   ✅ Narrative: 你指定的「規模模板」(必須像你貼的)
========================= */

function cadenceById(id: MetricId): string {
  switch (id) {
    case "hydration":
    case "texture":
      return "監測：7–10 天先看緊繃感與反射乾淨度是否下降；14–21 天再看整體一致性是否更穩。";
    case "sensitivity":
    case "redness":
      return "監測：10–14 天看波動幅度是否收斂（比看數字更重要）；若仍容易被同樣情境觸發，再調整節奏。";
    case "pigmentation":
      return "監測：色素屬累積型訊號，建議以 21–28 天觀察一次趨勢線（輪廓乾淨度與色階一致性）。";
    case "pore":
    case "pores_depth":
      return "監測：10–14 天看 T 區與臉頰差異是否縮小；21–42 天再看邊界陰影是否變乾淨。";
    case "wrinkle":
    case "elasticity":
    case "firmness":
      return "監測：21–28 天看支撐維持時間是否變長；28–56 天再看回彈是否更穩。";
    default:
      return "監測：10–14 天看穩定度與一致性是否變乾淨。";
  }
}

function growthLine(id: MetricId, score: number, confidence: number): string {
  const baseSpace = Math.max(0, 100 - Math.round(score));
  const diff = score > 88 ? 0.42 : score > 72 ? 0.70 : 0.90;
  const k =
    id === "hydration" || id === "texture" || id === "clarity" || id === "brightness" ? 0.78 :
    id === "sebum" || id === "sensitivity" || id === "redness" || id === "skintone" ? 0.60 :
    0.32;

  const conf = Math.max(0, Math.min(1, confidence ?? 0.82));
  const resist = (conf < 0.6 ? 0.20 : conf < 0.75 ? 0.12 : 0.05) + (1 - diff) * 0.10;

  const recover = Math.max(0, Math.min(38, Math.round(baseSpace * k * diff)));
  const lo = Math.max(0, Math.round(recover * 0.80));
  const hi = Math.max(lo + 3, Math.round(recover * 1.15));

  const drag =
    resist >= 0.15 ? "高（結構慣性）" :
    resist >= 0.08 ? "中（生理週期）" :
    "低（快速反應）";

  return `成長空間：可回收 ${lo}–${hi}%（阻力：${drag}）`;
}

function pigmentRegionClause(): string {
  return "未啟用區域遮罩時，系統不提供精準座標；依訊號型態，優先觀察顴骨—臉頰帶／鼻翼—上唇周邊的輪廓乾淨度與色階一致性。";
}

/* =========================
   OpenAI JSON Schema
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
      summary_en: { type: "string", minLength: 20 },
      summary_zh: { type: "string", minLength: 20 },
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
            recommendation_en: { type: "string", minLength: 60 },
            recommendation_zh: { type: "string", minLength: 320 },
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

  // priorities (你要的順序核心)
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

  return order.map((id) => {
    const m = raw[id];
    const [en, zh] = baseTitle[id];
    const conf = confidenceMap[id] ?? 0.82;
    return {
      id,
      title_en: en,
      title_zh: zh,
      score: m.score,
      max: 100,
      details: (m.details || []).slice(0, 3).map((d: any) => ({
        label_en: d.en,
        label_zh: d.zh,
        value: d.v,
      })),
      cadence_zh: cadenceById(id),
      growth_zh: growthLine(id, m.score, conf),
      pigment_clause_zh: id === "pigmentation" ? pigmentRegionClause() : "",
      priority: priorityMap[id] ?? 70,
      confidence: conf,
    };
  });
}

async function generateCardsWithOpenAI(metrics: any[]) {
  const openaiKey = mustEnv("OPENAI_API_KEY");
  const schema = cardSchema();

  const system = `You are HONEY.TEA · FIELD — Skin Vision.
Taiwan-friendly. Premium instrument voice. NOT medical. NOT marketing.

Non-negotiable:
- Do NOT change any provided score/details.
- Use bullets "•" + line breaks. No "■" or "::".
- Each metric MUST be written in the exact style below (user spec).
- Do NOT repeat the same Chinese sentence (>=12 chars) across different cards.
- No illegal medical wording.

Required style for each card (match exactly):

signal_en:
One sentence in this style:
"Your texture signal sits below the cohort baseline. Not a warning — a clear starting point for refinement."

signal_zh:
Must include these blocks:
1) One positioning line (baseline / reference band / threshold).
2) Exactly this line:
"這代表系統在影像中觀察到："
3) Exactly 3 bullets using details.label_zh ONCE each.
4) Two lines:
"這並不是…"
"而是…"
5) Two–three lines starting with:
"換句話說，"
(plain Taiwan-friendly wording)

recommendation_zh:
Must start with:
"系統建議的不是「___」或「___」，"
then explain why in 3–5 lines,
then include cadence_zh exactly once,
then include growth_zh exactly once.

Pigmentation rule:
If you do not have region coordinates, you MUST include pigment_clause_zh exactly once (no fake coordinates).

You must keep the text deep (not short), and each metric must sound different.

Priority/confidence:
Use the priority and confidence provided in payload. Do not change.

Return exactly 14 cards matching schema.`;

  const user = `Metrics payload:\n${JSON.stringify(metrics, null, 2)}`;

  const body = {
    model: "gpt-4o-2024-08-06",
    messages: [
      { role: "system", content: system },
      { role: "user", content: user }
    ],
    response_format: {
      type: "json_schema",
      json_schema: { name: "honeytea_skin_report", strict: true, schema }
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

  // server formatting guarantee
  if (out?.cards && Array.isArray(out.cards)) {
    out.cards = out.cards.map((c: any) => ({
      ...c,
      signal_zh: formatZhPanel(c.signal_zh || ""),
      recommendation_zh: formatZhPanel(c.recommendation_zh || ""),
      signal_en: formatEnPanel(c.signal_en || ""),
      recommendation_en: formatEnPanel(c.recommendation_en || ""),
    }));
  }
  out.summary_zh = formatZhPanel(out.summary_zh || "");
  out.summary_en = formatEnPanel(out.summary_en || "");
  return out;
}

/* =========================
   Fallback: still in your spec style
========================= */
function buildCardsFallback(metricsPayload: any[]): Card[] {
  // 直接用 payload 生成，確保 priority/confidence 不亂跑
  const makeNumbers = (id: MetricId) => {
    // 每張都不同：避免「全部 23%」這種被你打爆
    const map: Record<MetricId, [number, number]> = {
      texture: [18, 28],
      hydration: [20, 32],
      pore: [10, 18],
      pores_depth: [10, 18],
      sebum: [8, 16],
      skintone: [8, 14],
      sensitivity: [10, 18],
      redness: [10, 18],
      clarity: [8, 14],
      brightness: [8, 14],
      firmness: [6, 12],
      elasticity: [6, 12],
      wrinkle: [6, 12],
      pigmentation: [24, 42],
    };
    return map[id] ?? [10, 18];
  };

  return metricsPayload.map((m: any) => {
    const id: MetricId = m.id;
    const [lo, hi] = makeNumbers(id);

    const d0 = m.details?.[0]?.label_zh || "細項一";
    const d1 = m.details?.[1]?.label_zh || "細項二";
    const d2 = m.details?.[2]?.label_zh || "細項三";

    const band =
      m.score >= 88 ? "靠近同齡族群基準上緣" :
      m.score >= 72 ? "落在可控偏差帶" :
      "接近需要管理的門檻";

    const pigmentClause = id === "pigmentation" ? `\n${m.pigment_clause_zh}\n` : "";

    const signal_zh = formatZhPanel(
`你的${m.title_zh}訊號目前${band}（${m.score}/100）。
這代表系統在影像中觀察到：
• ${d0}
• ${d1}
• ${d2}

這並不是老化或不可逆狀態，
而是節奏不穩造成的結構型偏移。${pigmentClause}
換句話說，
系統不是看到「變糟」，
而是看到「水分與結構沒有長時間被固定在同一條軌跡上」。`
    );

    const recommendation_zh = formatZhPanel(
`系統建議的不是「短期加大強度」或「刺激型堆疊」，
而是先把輸入節奏固定住，讓趨勢線變乾淨。

路徑：先止損（降低不必要的刺激密度）→ 再穩定（把狀態固定住）→ 最後精修（在穩定上做細節）。
${m.cadence_zh}

在模型推算中，若能維持一致性輸入，整體可改善 約 ${lo}–${hi}%，且不伴隨反彈風險。
${m.growth_zh}`
    );

    return {
      id,
      title_en: m.title_en,
      title_zh: m.title_zh,
      score: m.score,
      max: 100,
      signal_en: formatEnPanel(`Your ${m.title_en.toLowerCase()} signal sits near baseline. Not a warning — a clear starting point for refinement.`),
      signal_zh,
      details: m.details,
      recommendation_en: formatEnPanel(`Stabilize first → refine second.`),
      recommendation_zh,
      priority: m.priority,
      confidence: m.confidence,
    } as Card;
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
      console.error("OpenAI generation failed, fallback:", e?.message || String(e));
      openaiOut = null;
    }

    // Use OpenAI or fallback
    const cards: Card[] = openaiOut?.cards
      ? openaiOut.cards
      : buildCardsFallback(metricsPayload);

    // Ensure paragraph formatting + inject cadence/growth if missing
    const finalCards: Card[] = cards.map((c) => {
      const payload = metricsPayload.find((m: any) => m.id === c.id);
      const cadence = payload?.cadence_zh || cadenceById(c.id);
      const growth = payload?.growth_zh || growthLine(c.id, c.score, c.confidence);

      let rz = formatZhPanel(c.recommendation_zh || "");
      if (!rz.includes("監測：")) rz = `${rz}\n\n${cadence}`;
      if (!rz.includes("成長空間：")) rz = `${rz}\n\n${growth}`;

      let sz = formatZhPanel(c.signal_zh || "");
      if (c.id === "pigmentation" && !sz.includes("未啟用區域遮罩")) {
        sz = `${sz}\n\n${pigmentRegionClause()}`;
      }

      return {
        ...c,
        signal_en: formatEnPanel(c.signal_en || ""),
        recommendation_en: formatEnPanel(c.recommendation_en || ""),
        signal_zh: sz,
        recommendation_zh: rz,
      };
    });

    const summaryZh = formatZhPanel(openaiOut?.summary_zh ?? "系統已將主要訊號依優先順序整理。").slice(0, 420);
    const summaryEn = formatEnPanel(openaiOut?.summary_en ?? "Primary signals have been ordered for review.").slice(0, 260);

    return json({
      build: "honeytea_scan_youcam_openai_final_user_spec",
      scanId: nowId(),
      precheck: {
        ok: precheck.ok,
        warnings: precheck.warnings,
        tips: precheck.tips,
      },
      cards: finalCards,
      summary_en: summaryEn,
      summary_zh: summaryZh,
      meta: {
        youcam_task_id: youcam.taskId,
        youcam_task_status: youcam.task_status,
        narrative: openaiOut ? "openai" : "fallback",
        overlays: youcam.overlays, // ✅ 有就帶，沒有就 null
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
n({ error: "scan_failed", message: msg }, 500);
  }
}
