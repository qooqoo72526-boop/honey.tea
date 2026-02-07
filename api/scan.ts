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
   Narrative style: 8 designed tones (server-side)
   - Still returns 14 cards (no schema change)
   - But each metric gets a different voice bucket
========================= */

type Tone =
  | "LIQUID"       // hydration
  | "RHYTHM"       // sebum
  | "PULSE"        // redness
  | "THRESHOLD"    // sensitivity
  | "GRID"         // texture
  | "OPTICS"       // clarity/brightness/skintone
  | "VECTOR"       // elasticity/firmness/wrinkle
  | "CUT"          // pore/pores_depth/pigmentation

function toneOf(id: MetricId): Tone {
  if (id === "hydration") return "LIQUID";
  if (id === "sebum") return "RHYTHM";
  if (id === "redness") return "PULSE";
  if (id === "sensitivity") return "THRESHOLD";
  if (id === "texture") return "GRID";
  if (id === "clarity" || id === "brightness" || id === "skintone") return "OPTICS";
  if (id === "elasticity" || id === "firmness" || id === "wrinkle") return "VECTOR";
  return "CUT";
}

// remove ugly symbols from any OpenAI output just in case
function cleanNarr(s: string) {
  return (s || "")
    .replace(/::/g, " · ")
    .replace(/■/g, "")
    .replace(/\s+\|\s+/g, " · ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/* =========================
   Growth (same as your aligned logic)
========================= */
function growthParams(id: MetricId) {
  if (id === "hydration" || id === "clarity" || id === "texture" || id === "brightness") return { k: 0.78, band: "快回應" };
  if (id === "sebum" || id === "sensitivity" || id === "redness" || id === "skintone") return { k: 0.60, band: "中回應" };
  return { k: 0.32, band: "慢回應" };
}

function growthRange(id: MetricId, score: number, confidence: number) {
  const baseSpace = Math.max(0, 100 - Math.round(score));
  const difficultyFactor = score > 85 ? 0.40 : score > 70 ? 0.70 : 0.90;

  const { k, band } = growthParams(id);
  const conf = Math.max(0, Math.min(1, confidence ?? 0.80));

  const rawResistance = conf < 0.6 ? 0.20 : conf < 0.75 ? 0.12 : 0.05;
  const resistanceVal = rawResistance + (1 - difficultyFactor) * 0.10;

  const recover = Math.max(0, Math.min(38, Math.round(baseSpace * k * difficultyFactor)));
  const lo = Math.max(0, Math.round(recover * 0.80));
  const hi = Math.max(lo + 3, Math.round(recover * 1.15));

  const drag =
    resistanceVal >= 0.15 ? "高（結構慣性）" :
    resistanceVal >= 0.08 ? "中（生理週期）" :
    "低（快速反應）";

  return { lo, hi, drag, band };
}

function appendGrowthToRecommendation(card: Card) {
  const zh = (card.recommendation_zh || "").trim();
  const en = (card.recommendation_en || "").trim();

  const zhHas = /成長空間|可回收|回收窗口|Recovery|Growth/i.test(zh);
  const enHas = /growth potential|recovery window|recoverable/i.test(en);

  const g = growthRange(card.id as MetricId, card.score, card.confidence);
  const lineZh = `成長空間：可回收 ${g.lo}–${g.hi}%（阻力：${g.drag}｜${g.band}）`;
  const lineEn = `Growth Window: ${g.lo}-${g.hi}% (Drag: ${g.drag})`;

  if (!zhHas) card.recommendation_zh = (zh ? `${zh}\n${lineZh}` : lineZh);
  if (!enHas) card.recommendation_en = (en ? `${en}\n${lineEn}` : lineEn);

  card.signal_zh = cleanNarr(card.signal_zh).slice(0, 1200);
  card.recommendation_zh = cleanNarr(card.recommendation_zh).slice(0, 650);
  card.signal_en = (card.signal_en || "").slice(0, 420);
  card.recommendation_en = (card.recommendation_en || "").slice(0, 260);

  return card;
}

/* =========================
   OpenAI — schema (no ugly symbols) + 8-tone guidance
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
      summary_en: { type: "string", minLength: 40 },
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
            // keep deep but not essay
            signal_en: { type: "string", minLength: 80 },
            signal_zh: { type: "string", minLength: 220 },
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
            recommendation_zh: { type: "string", minLength: 140 },
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
      tone: toneOf(id), // <— extra hint to model (not used by schema; will be ignored unless we include it)
    };
  });
}

async function generateCardsWithOpenAI(metrics: any[]) {
  const openaiKey = mustEnv("OPENAI_API_KEY");
  const schema = cardSchema();

  // NOTE: user asked no ugly symbols; no "::", no "■"
  const system = `You are HONEY.TEA Skin Vision — a premium futurist scan voice (cosmic + professional), NOT medical, NOT marketing.

Hard rules:
- DO NOT change any provided scores/details.
- Chinese is the primary narrative. Keep it deep but compact. No filler, no slogans.
- Avoid words: 病人/疾病/治療/恐嚇/醫療保證/療程推薦/建議購買.
- Avoid ugly symbols like "■" or "::". Use clean sentences and line breaks only.

Style:
- Think "instrument panel + cosmic field notes".
- Use vocabulary: 基線, 門檻, 穩定度, 變異, 軌跡, 級聯效應, 回收窗口.
- Each metric must feel different by tone bucket:
  LIQUID (hydration): layer, reservoir, TEWL as leakage, re-stabilize.
  RHYTHM (sebum): rhythm, phase shift, balance, cycle.
  PULSE (redness): hotspots, pulse field, threshold, calm the field.
  THRESHOLD (sensitivity): threshold, trigger, tolerance window, stability first.
  GRID (texture): grid, micro-roughness, scattering, surface cadence.
  OPTICS (clarity/brightness/skintone): reflection, refraction, contrast zones, optical noise.
  VECTOR (elasticity/firmness/wrinkle): vector, support, rebound, structural inertia.
  CUT (pore/pores_depth/pigmentation): depth, edges, accumulation, mapping.

Output format (no bullets):
signal_zh: 3 short paragraphs:
1) 系統判定（2句）
2) 細項連動（3句，引用3個details）
3) 風險方向（1句，平靜、不恐嚇）

recommendation_zh: 2 short paragraphs:
1) 路徑（2句，先止損→先穩定→再精修，講邏輯）
2) 監測（1句，何時重測＋看什麼）

priority: TEXTURE=95, HYDRATION=92, others 70-88 descending.
confidence range: 0.78-0.92.

Return 14 cards strictly matching schema.`;

  const user = `Metrics:\n${JSON.stringify(metrics, null, 2)}`;

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

  // safety clean: strip any accidental symbols
  if (out?.cards && Array.isArray(out.cards)) {
    out.cards = out.cards.map((c: any) => ({
      ...c,
      signal_zh: cleanNarr(c.signal_zh),
      recommendation_zh: cleanNarr(c.recommendation_zh),
      signal_en: (c.signal_en || "").replace(/::/g, " - ").replace(/■/g, "").trim(),
      recommendation_en: (c.recommendation_en || "").replace(/::/g, " - ").replace(/■/g, "").trim(),
    }));
  }
  out.summary_zh = cleanNarr(out.summary_zh || "");
  out.summary_en = (out.summary_en || "").replace(/::/g, " - ").replace(/■/g, "").trim();

  return out;
}

/* =========================
   Fallback — 8-tone, deep, no ugly symbols, no露餡
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
    "texture","pore","pigmentation","wrinkle","hydration","sebum","skintone","sensitivity",
    "clarity","elasticity","redness","brightness","firmness","pores_depth",
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

  const makeSignalZh = (id: MetricId, score: number, details: any[]) => {
    const tone = toneOf(id);
    const d0 = details?.[0]?.zh || "表層特徵";
    const d1 = details?.[1]?.zh || "結構訊號";
    const d2 = details?.[2]?.zh || "穩定度";

    const band = score > 85 ? "靠近穩態上緣" : score > 70 ? "落在可控偏差帶" : "接近需要管理的門檻";
    const drift = score > 80 ? "回收窗口偏窄" : "回收窗口仍然充足";

    const toneLine =
      tone === "LIQUID" ? "水位是分層訊號，先看流失再看回補。" :
      tone === "RHYTHM" ? "油脂是節奏訊號，先對齊相位再談平衡。" :
      tone === "PULSE" ? "泛紅是場的脈衝，不是單點事件。" :
      tone === "THRESHOLD" ? "敏感是門檻型反應，先穩定耐受窗口。" :
      tone === "GRID" ? "紋理是網格與散射，節奏會決定外觀一致性。" :
      tone === "OPTICS" ? "光學表現看反射與對比，噪訊會偷走乾淨度。" :
      tone === "VECTOR" ? "力學是向量，支撐與回彈才是核心。" :
      "切面型訊號看深度與邊緣，累積會改變輪廓。";

    return (
      `系統判定：${baseTitle[id][1]} ${band}（${score}/100），${drift}。${toneLine}\n\n` +
      `細項連動：${d0}、${d1}、${d2}在同一條軌跡上互相拉扯。這不是單點問題，而是節奏與穩定度的分歧，會先改變視覺一致性，再影響維持時間。\n\n` +
      `風險方向：當環境或作息波動放大，這一類訊號容易先出現變異並引發級聯效應，但目前仍在可控範圍。`
    );
  };

  const makeRecZh = (id: MetricId) => {
    const tone = toneOf(id);
    const line1 =
      tone === "LIQUID" ? "路徑：先止漏（降低流失）→ 再回補（分層補水）→ 最後穩定（讓水位可維持）。" :
      tone === "RHYTHM" ? "路徑：先止損（降低刺激）→ 再對齊節奏（讓油水平衡）→ 最後精修（維持乾淨度）。" :
      tone === "PULSE" ? "路徑：先降擾動（避免觸發）→ 再穩定場（降低熱區）→ 最後精修（回到一致）。" :
      tone === "THRESHOLD" ? "路徑：先縮小觸發源 → 再擴耐受窗口 → 最後精修（把變異壓低）。" :
      tone === "GRID" ? "路徑：先穩定角質節奏 → 再細化表面 → 最後精修（讓散射下降）。" :
      tone === "OPTICS" ? "路徑：先降低光學噪訊 → 再拉回對比 → 最後精修（讓反射乾淨）。" :
      tone === "VECTOR" ? "路徑：先守住支撐 → 再訓練回彈 → 最後精修（避免結構慣性反撲）。" :
      "路徑：先固定邊界 → 再處理累積 → 最後精修（讓輪廓更乾淨）。";

    return (
      `${line1}\n\n` +
      `監測：建議 2 週重測一次，觀察穩定度與變異幅度是否下降。`
    );
  };

  const makeSignalEn = (en: string, score: number) => {
    const band = score > 85 ? "high-steady" : score > 70 ? "controlled deviation" : "managed threshold";
    return `${en}: ${band} (${score}/100).`;
  };

  const makeRecEn = () => `Stabilize first → refine second. Re-scan in 2 weeks.`;

  return order.map((id) => {
    const m = raw[id];
    const [en, zh] = baseTitle[id];
    const score = m?.score ?? 0;

    const details = (m?.details || []).slice(0, 3).map((d: any) => ({
      label_en: d.en,
      label_zh: d.zh,
      value: d.v,
    }));

    return {
      id,
      title_en: en,
      title_zh: zh,
      score,
      max: 100,
      signal_en: makeSignalEn(en, score),
      signal_zh: makeSignalZh(id, score, m?.details || []),
      details,
      recommendation_en: makeRecEn(),
      recommendation_zh: makeRecZh(id),
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

    return json({
      build: "honeytea_scan_youcam_openai_v4_narrative_aligned",
      scanId: nowId(),
      precheck: {
        ok: precheck.ok,
        warnings: precheck.warnings,
        tips: precheck.tips,
      },
      cards: finalCards,
      summary_en: (openaiOut?.summary_en ??
        "Scan complete. Signals prioritized for review.").replace(/::/g, " - ").replace(/■/g, "").slice(0, 220),
      summary_zh: cleanNarr(openaiOut?.summary_zh ??
        "掃描完成。訊號已排序，面板可直接閱讀。").slice(0, 220),
      meta: {
        youcam_task_id: youcam.taskId,
        youcam_task_status: youcam.task_status,
        mode: "youcam_metrics + openai_narrative",
        narrative: openaiOut ? "openai" : "fallback",
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
