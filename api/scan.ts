export const config = {
  runtime: "edge",
  regions: ["sin1", "hnd1", "icn1"],
};

declare const process: { env: Record<string, string | undefined> };

type MetricId =
  | "texture" | "pore" | "pigmentation" | "wrinkle"
  | "hydration" | "sebum" | "skintone" | "sensitivity"
  | "clarity" | "elasticity" | "redness" | "brightness" | "firmness" | "pores_depth";

type Tone = "stable" | "deviation" | "threshold";

type Card = {
  id: string;
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
  masks?: string[];
};

type ReportSignal = {
  id: MetricId;
  label_en: string;
  label_zh: string;
  score: number;
  tone: Tone;
};

type ReportDimension = {
  id: string;
  title_en: string;
  title_zh: string;
  score: number;
  tone: Tone;
  confidence: number;
  finding_en: string;
  finding_zh: string;
  mechanism_en: string;
  mechanism_zh: string;
  protocol_en: string[];
  protocol_zh: string[];
  masks?: string[];
};

type Report = {
  scan_id: string;
  produced_at: string;
  degraded: boolean;
  stage: string;
  summary_en: string;
  summary_zh: string;
  precheck?: { passed: boolean; warnings: string[]; tips: string[] };
  signals14: ReportSignal[];
  dimensions8: ReportDimension[];
  // ✅ 新增：決策層（前端可選擇顯示；不影響舊版）
  environment_zh?: string;
  decision_zh?: string;
  priority_node_zh?: string;
  constraints_zh?: string[];
  timeline_zh?: string[];
};

function json(data: any, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers": "content-type",
      "cache-control": "no-store",
    },
  });
}

function nowId() {
  return `scan_${Date.now()}`;
}

const YOUCAM_API_KEY = process.env.YOUCAM_API_KEY;

function must(v: string | undefined, name: string) {
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

function clampScore(x: any) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function toneForScore(score: number): Tone {
  if (score >= 88) return "stable";
  if (score >= 72) return "deviation";
  return "threshold";
}

function quickPrecheck(bytes: Uint8Array) {
  const sizeKB = bytes.length / 1024;
  const warnings: string[] = [];
  const tips: string[] = [];

  if (sizeKB < 60) {
    warnings.push("LOW_RESOLUTION");
    tips.push("畫質偏低。建議使用更清晰的正面照片。");
  }

  let sample = 0, sum = 0;
  for (let i = 0; i < bytes.length; i += 401) { sum += bytes[i]; sample++; }
  const avg = sample ? sum / sample : 120;

  if (avg < 85) { warnings.push("TOO_DARK"); tips.push("光線偏暗。請面向窗戶或補柔光。"); }
  if (avg > 185) { warnings.push("TOO_BRIGHT"); tips.push("高光偏強。避免直射頂光。"); }

  return { ok: warnings.length === 0, avgSignal: avg, warnings, tips };
}

/* =========================
   ✅ Edge 內建重編碼：補到最低尺寸再送 YouCam
   - 目的：避免 error_below_min_image_size
   - 不改你相機 UI，只改送去分析的影像規格
========================= */
async function normalizeForYouCam(input: File, opts?: { minSide?: number; maxSide?: number; quality?: number }) {
  const minSide = opts?.minSide ?? 720;   // ✅ 保守：至少 720
  const maxSide = opts?.maxSide ?? 1440;  // ✅ 不要太大，避免慢
  const quality = opts?.quality ?? 0.92;

  const arr = await input.arrayBuffer();
  const blob = new Blob([arr], { type: input.type || "image/jpeg" });

  // createImageBitmap 在 Edge (Web APIs) 可用；若環境不支援會 throw → 我們 fallback 回原檔
  const bmp = await createImageBitmap(blob);

  const w = bmp.width;
  const h = bmp.height;

  // 先算 scale：先補到 minSide，再限制 maxSide
  const short = Math.min(w, h);
  const long = Math.max(w, h);

  let scale = 1;
  if (short < minSide) scale = minSide / short;
  if (long * scale > maxSide) scale = maxSide / long;

  const outW = Math.max(1, Math.round(w * scale));
  const outH = Math.max(1, Math.round(h * scale));

  // OffscreenCanvas
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas not supported");

  ctx.drawImage(bmp, 0, 0, outW, outH);

  const outBlob = await canvas.convertToBlob({ type: "image/jpeg", quality });
  const outBuf = await outBlob.arrayBuffer();
  return {
    bytes: new Uint8Array(outBuf),
    contentType: "image/jpeg",
    width: outW,
    height: outH,
  };
}

/* =========================
   YouCam — endpoints
========================= */
const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";
const YOUCAM_FILE_ENDPOINT = `${YOUCAM_BASE}/file/skin-analysis`;
const YOUCAM_TASK_CREATE = `${YOUCAM_BASE}/task/skin-analysis`;
const YOUCAM_TASK_GET = (taskId: string) => `${YOUCAM_BASE}/task/skin-analysis/${taskId}`;

// ✅ 只留你報告用得到的 actions（穩）
const YOUCAM_HD_ACTIONS = [
  "hd_moisture",
  "hd_age_spot",
  "hd_texture",
  "hd_oiliness",
  "hd_pore",
  "hd_firmness",
  "hd_wrinkle",
  "hd_radiance",
  "hd_redness",
  "hd_acne",
];

async function youcamInitUpload(fileBytes: Uint8Array, fileName: string) {
  const apiKey = must(YOUCAM_API_KEY, "YOUCAM_API_KEY");
  const payload = {
    files: [{
      content_type: "image/jpeg",
      file_name: fileName || `skin_${Date.now()}.jpg`,
      file_size: fileBytes.length,
    }],
  };

  const r = await fetch(YOUCAM_FILE_ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 200) throw new Error(`YouCam file init failed: ${r.status} ${JSON.stringify(j)}`);

  const f = j.data?.files?.[0];
  const req = f?.requests?.[0];
  if (!f?.file_id || !req?.url) throw new Error("YouCam file init missing file_id/upload url");

  return { fileId: f.file_id as string, putUrl: req.url as string, contentType: f.content_type as string };
}

async function youcamPutBinary(putUrl: string, fileBytes: Uint8Array, contentType: string) {
  const r = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: new Blob([fileBytes.buffer as ArrayBuffer]),
  });
  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`YouCam PUT failed: ${r.status} ${t}`);
  }
}

async function youcamCreateTask(srcFileId: string, dstActions: string[]) {
  const apiKey = must(YOUCAM_API_KEY, "YOUCAM_API_KEY");
  const payload = {
    src_file_id: srcFileId,
    dst_actions: dstActions,
    miniserver_args: {
      enable_mask_overlay: true,
      enable_dark_background_hd_pore: true,
      color_dark_background_hd_pore: "3D3D3D",
      opacity_dark_background_hd_pore: 0.4,
    },
    format: "json",
  };

  const r = await fetch(YOUCAM_TASK_CREATE, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 200 || !j.data?.task_id) throw new Error(`YouCam task create failed: ${r.status} ${JSON.stringify(j)}`);
  return j.data.task_id as string;
}

async function youcamGetTask(taskId: string) {
  const apiKey = must(YOUCAM_API_KEY, "YOUCAM_API_KEY");
  const r = await fetch(YOUCAM_TASK_GET(taskId), {
    method: "GET",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 200) throw new Error(`YouCam task get failed: ${r.status} ${JSON.stringify(j)}`);
  return j;
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

/* =========================
   MAP YouCam → 8 cards（分數為真；敘事為冷靜推演）
========================= */
function mapYoucamToCards(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>) {
  const get = (k: string) => scoreMap.get(k);
  const safe = (v?: { ui: number; raw: number; masks: string[] }) => ({
    ui: clampScore(v?.ui),
    masks: v?.masks || [],
  });

  const H = safe(get("hd_moisture"));
  const PG = safe(get("hd_age_spot"));
  const T = safe(get("hd_texture"));
  const S = safe(get("hd_oiliness"));
  const P = safe(get("hd_pore"));
  const R = safe(get("hd_radiance"));
  const RD = safe(get("hd_redness"));
  const F = safe(get("hd_firmness"));
  const W = safe(get("hd_wrinkle"));
  const AC = safe(get("hd_acne"));

  const hydration: Card = {
    id: "hydration",
    title_en: "HYDRATION TOPOLOGY",
    title_zh: "保濕拓撲",
    score: H.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Surface Layer", label_zh: "表層含水", value: clampScore(H.ui * 0.95) },
      { label_en: "Mid Layer", label_zh: "中層滲透", value: clampScore(H.ui * 0.88) },
      { label_en: "Deep Layer", label_zh: "深層鎖水", value: clampScore(H.ui * 0.76) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 1,
    confidence: 0.92,
    masks: H.masks,
  };

  const melanin: Card = {
    id: "melanin",
    title_en: "MELANIN DISTRIBUTION",
    title_zh: "色素分佈",
    score: PG.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Forehead Zone", label_zh: "額頭區域", value: clampScore(PG.ui * 1.1) },
      { label_en: "Cheek Zone", label_zh: "臉頰區域", value: clampScore(PG.ui * 0.9) },
      { label_en: "Jaw Zone", label_zh: "下顎區域", value: clampScore(PG.ui * 0.85) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 2,
    confidence: 0.88,
    masks: PG.masks,
  };

  const texture: Card = {
    id: "texture",
    title_en: "TEXTURE MATRIX",
    title_zh: "紋理矩陣",
    score: T.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Smoothness", label_zh: "平滑度", value: clampScore(T.ui * 0.9) },
      { label_en: "Uniformity", label_zh: "均勻度", value: clampScore(T.ui * 0.92) },
      { label_en: "Grain", label_zh: "顆粒感", value: clampScore(100 - T.ui) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 3,
    confidence: 0.9,
    masks: T.masks,
  };

  const tZone = clampScore(S.ui * 1.2);
  const uZone = clampScore(S.ui * 0.7);
  const sebum: Card = {
    id: "sebum",
    title_en: "SEBUM BALANCE",
    title_zh: "油脂平衡",
    score: S.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "T-Zone Output", label_zh: "T 區出油", value: tZone },
      { label_en: "Cheek Output", label_zh: "臉頰出油", value: uZone },
      { label_en: "Equilibrium", label_zh: "平衡值", value: clampScore((tZone + uZone) / 2) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 4,
    confidence: 0.87,
    masks: S.masks,
  };

  const pore: Card = {
    id: "pore",
    title_en: "PORE ARCHITECTURE",
    title_zh: "毛孔結構",
    score: P.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "T-Zone", label_zh: "T 區", value: clampScore(P.ui * 0.9) },
      { label_en: "Cheek", label_zh: "臉頰", value: clampScore(P.ui * 0.95) },
      { label_en: "Nose", label_zh: "鼻翼", value: clampScore(P.ui * 0.8) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 5,
    confidence: 0.91,
    masks: P.masks,
  };

  const elScore = clampScore(F.ui * 0.62 + (100 - W.ui) * 0.38);
  const elasticity: Card = {
    id: "elasticity",
    title_en: "ELASTICITY INDEX",
    title_zh: "彈性指數",
    score: elScore,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Firmness", label_zh: "緊緻度", value: F.ui },
      { label_en: "Wrinkle Depth", label_zh: "皺紋深度", value: W.ui },
      { label_en: "Recovery", label_zh: "回彈", value: clampScore(elScore * 0.9) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 6,
    confidence: 0.85,
    masks: F.masks.length ? F.masks : W.masks,
  };

  const radiance: Card = {
    id: "radiance",
    title_en: "RADIANCE SPECTRUM",
    title_zh: "光澤頻譜",
    score: R.ui,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Luminosity", label_zh: "明亮度", value: clampScore(R.ui * 1.05) },
      { label_en: "Evenness", label_zh: "均勻度", value: clampScore(R.ui * 0.92) },
      { label_en: "Glow Index", label_zh: "光澤", value: clampScore(R.ui * 0.88) },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 7,
    confidence: 0.89,
    masks: R.masks,
  };

  const barrierScore = clampScore((100 - RD.ui) * 0.4 + H.ui * 0.3 + (100 - AC.ui) * 0.3);
  const barrier: Card = {
    id: "barrier",
    title_en: "BARRIER INTEGRITY",
    title_zh: "屏障完整度",
    score: barrierScore,
    max: 100,
    signal_en: "",
    signal_zh: "",
    details: [
      { label_en: "Lipid Matrix", label_zh: "脂質基質", value: clampScore(barrierScore * 0.95) },
      { label_en: "Ceramide Layer", label_zh: "神經醯胺", value: clampScore(barrierScore * 0.9) },
      { label_en: "Moisture Seal", label_zh: "保濕封存", value: H.ui },
      { label_en: "Surface Film", label_zh: "皮脂膜", value: S.ui },
    ],
    recommendation_en: "",
    recommendation_zh: "",
    priority: 8,
    confidence: 0.86,
    masks: RD.masks.length ? RD.masks : AC.masks,
  };

  return [hydration, melanin, texture, sebum, pore, elasticity, radiance, barrier];
}

/* =========================
   14 signals（可推演但數值用真資料＋衍生）
========================= */
const SIGNAL_LABELS: Record<MetricId, { en: string; zh: string }> = {
  hydration: { en: "Hydration Stability", zh: "含水穩定" },
  sebum: { en: "Sebum Distribution", zh: "油脂分佈" },
  texture: { en: "Texture Regularity", zh: "紋理規則" },
  pore: { en: "Pore Visibility", zh: "毛孔可視" },
  pores_depth: { en: "Pore Depth Proxy", zh: "毛孔深度推估" },
  pigmentation: { en: "Pigment Uniformity", zh: "色素均勻" },
  wrinkle: { en: "Wrinkle Proxy", zh: "皺紋推估" },
  firmness: { en: "Firmness Proxy", zh: "緊緻推估" },
  elasticity: { en: "Elasticity Response", zh: "彈性回應" },
  redness: { en: "Redness Stability", zh: "泛紅穩定" },
  brightness: { en: "Brightness Index", zh: "亮度指數" },
  skintone: { en: "Tone Evenness", zh: "膚色均勻" },
  clarity: { en: "Clarity Index", zh: "通透度" },
  sensitivity: { en: "Sensitivity Load", zh: "敏感負載" },
};

function buildSignals14(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>, cards8: Card[]): ReportSignal[] {
  const getUi = (k: string) => clampScore(scoreMap.get(k)?.ui);
  const card = (id: string) => cards8.find((c) => c.id === id);

  const H = getUi("hd_moisture") || card("hydration")?.score || 0;
  const PG = getUi("hd_age_spot") || card("melanin")?.score || 0;
  const T = getUi("hd_texture") || card("texture")?.score || 0;
  const S = getUi("hd_oiliness") || card("sebum")?.score || 0;
  const P = getUi("hd_pore") || card("pore")?.score || 0;
  const R = getUi("hd_radiance") || card("radiance")?.score || 0;
  const RD = getUi("hd_redness") || 0;
  const F = getUi("hd_firmness") || 0;
  const W = getUi("hd_wrinkle") || 0;
  const AC = getUi("hd_acne") || 0;

  const elasticity = clampScore((F * 0.62 + (100 - W) * 0.38));
  const barrier = card("barrier")?.score || clampScore((100 - RD) * 0.4 + H * 0.3 + (100 - AC) * 0.3);

  const clarity = clampScore(T * 0.35 + P * 0.35 + (100 - AC) * 0.3);
  const sensitivity = clampScore(barrier * 0.55 + (100 - RD) * 0.45);
  const skintone = clampScore(R * 0.55 + (100 - RD) * 0.25 + (100 - PG) * 0.2);
  const brightness = clampScore(R);
  const pores_depth = clampScore(P * 0.95);

  const pack = (id: MetricId, score: number): ReportSignal => ({
    id,
    label_en: SIGNAL_LABELS[id].en,
    label_zh: SIGNAL_LABELS[id].zh,
    score: clampScore(score),
    tone: toneForScore(clampScore(score)),
  });

  return [
    pack("hydration", H),
    pack("sebum", S),
    pack("texture", T),
    pack("pore", P),
    pack("pores_depth", pores_depth),
    pack("pigmentation", PG),
    pack("wrinkle", W),
    pack("firmness", F),
    pack("elasticity", elasticity),
    pack("redness", clampScore(100 - RD)),
    pack("brightness", brightness),
    pack("skintone", skintone),
    pack("clarity", clarity),
    pack("sensitivity", sensitivity),
  ];
}

/* =========================
   ✅ 冷靜推演語氣：每個維度不同（不再複製貼上）
========================= */
function zhFinding(dimId: string, score: number) {
  const t = toneForScore(score);
  const s = clampScore(score);

  const level =
    t === "stable" ? "穩定區" :
    t === "deviation" ? "可控偏差帶" :
    "接近門檻";

  const base = `視覺特徵顯示「${level}」(${s})，屬於可被策略化控制的波動型訊號。`;

  const extraMap: Record<string, string> = {
    hydration: "水分結構可能存在封存效率不足，表層與深層同步性偏弱。",
    melanin: "色素呈區域差異，顴區/額區的濃度梯度可能更明顯。",
    texture: "微紋理對比偏強，反射碎裂感上升，質感可能更粗。",
    sebum: "油脂分佈偏區域化，T 區與臉頰輸出可能不對稱。",
    pore: "毛孔可視度提升，孔道邊界的對比度可能偏高。",
    elasticity: "回彈曲線偏慢，彈性回復可能受負載影響。",
    radiance: "光澤偏漫反射，亮度被散射吸收的比例可能較高。",
    barrier: "屏障連續性可能不足，刺激閾值有下降風險。",
  };

  return `${extraMap[dimId] || ""}\n${base}`.trim();
}

function zhMechanism(dimId: string, score: number) {
  const s = clampScore(score);
  const low = s < 72;

  const map: Record<string, string> = {
    hydration: low
      ? "推演：角質層保水結構的封存效率偏低，日內波動可能更明顯。"
      : "推演：保水結構可控，但封存與留存存在輕微落差。",
    melanin: low
      ? "推演：色素生成/轉移的局部累積可能更活躍，導致均勻性下降。"
      : "推演：色素分佈整體可控，局部仍可能受光源/角度放大差異。",
    texture: low
      ? "推演：角質排列與黏著一致性不足，microrelief 造成散射提升。"
      : "推演：紋理規則性尚可，局部微紋理仍可能造成反射破碎。",
    sebum: low
      ? "推演：皮脂輸出與脫水訊號交互，形成局部滯留與堵塞風險。"
      : "推演：油脂輸出穩定，但區域差異仍可能影響孔道負載。",
    pore: low
      ? "推演：毛囊角化與皮脂滯留可能推高孔道可視度與邊界擴張。"
      : "推演：孔道結構大致可控，仍需避免讓角栓負載持續累積。",
    elasticity: low
      ? "推演：回彈動態偏慢，可能與氧化/糖化負載及修復節奏相關。"
      : "推演：彈性回復可用，建議以低刺激方式維持重塑節奏。",
    radiance: low
      ? "推演：表面散射（紋理）與微炎症訊號，可能拉低通透與亮度。"
      : "推演：光澤可控，但散射與均勻性仍是主要影響因素。",
    barrier: low
      ? "推演：脂質矩陣連續性不足與 pH 漂移，可能降低耐受上限。"
      : "推演：屏障可用，但仍需維持脂質連續性以避免裂縫風險。",
  };

  return map[dimId] || "推演：訊號來源可能與結構與波動交互相關。";
}

function zhProtocol(dimId: string, score: number): string[] {
  const s = clampScore(score);
  const low = s < 72;

  const map: Record<string, [string, string]> = {
    hydration: low
      ? ["NMF：泛醇/胺基酸", "補脂：Ceramide 3:1:1"]
      : ["封存：神經醯胺/脂肪酸", "節奏：夜間加強留存"],
    melanin: low
      ? ["抗氧鏈：Vit C + ferulic", "均勻路徑：B3/傳明酸"]
      : ["防曬規格：廣譜穩定", "均勻節奏：低刺激長跑"],
    texture: low
      ? ["溫和更新：PHA/LHA", "結構支持：尿素/神經醯胺"]
      : ["更新節奏：拉長間隔", "敏感期：避免過度摩擦"],
    sebum: low
      ? ["控油不破膜：Zinc PCA", "孔道清理：BHA 週2–3"]
      : ["分區保養：T 區/臉頰分流", "負載控制：避免強清潔"],
    pore: low
      ? ["角化管理：BHA/視黃醇交替", "結構支撐：B3/胜肽"]
      : ["清理節奏：低頻但持續", "支撐策略：B3/保水封存"],
    elasticity: low
      ? ["夜間重塑：視黃醇 2–3晚", "抗氧支援：胜肽/維E"]
      : ["重塑維持：低頻A醇", "防護：抗氧 + 封存"],
    radiance: low
      ? ["抑炎抗氧：壬二酸/EGCG", "提亮鏈路：Vit C + 封存"]
      : ["均光策略：抗氧 + 保水", "反射管理：紋理節奏"],
    barrier: low
      ? ["補脂修復：Ceramide/膽固醇/FA", "降刺激：停強酸/酒精香精"]
      : ["維持連續：補脂 + 封存", "避免波動：降清潔強度"],
  };

  const p = map[dimId] || ["以低刺激為主", "維持節奏與追蹤"];
  return [p[0], p[1]];
}

/* =========================
   ✅ LLM 個人化敘事（OpenAI）
   失敗時 fallback 回靜態模板
========================= */
async function generateLLMNarratives(cardsRaw: Card[], signals14: ReportSignal[]) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  try {
    const cardsSummary = cardsRaw.map(c =>
      `【${c.title_zh}（${c.title_en}）】總分：${c.score}/100\n子指標：${c.details.map(d => `${d.label_zh}=${d.value}`).join('、')}`
    ).join('\n\n');

    const signalsSummary = signals14.map(s =>
      `${s.label_zh}(${s.id}): ${s.score} [${s.tone}]`
    ).join('、');

    // 找出最差和最好的維度
    const sorted = [...cardsRaw].sort((a, b) => a.score - b.score);
    const worst = sorted.slice(0, 2).map(c => `${c.title_zh}(${c.score})`);
    const best = sorted.slice(-2).map(c => `${c.title_zh}(${c.score})`);

    const payload = {
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `你是台灣頂尖的皮膚科學分析系統。你的報告風格：

【絕對禁止的用詞】診斷、治療、醫療、處方、疾病、病症、療程、患者、病患
【正確的用語】系統判斷、訊號偵測、數據推演、策略建議、結構分析、行為約束

每個維度的報告格式：
1. finding_zh：系統判斷說明 + 細項數據解讀（150-250字）
   - 必須引用具體數字（分數、子指標）
   - 必須說明數字代表什麼意思
   - 必須比較子指標之間的關係（例如：「T區出油 78 vs 臉頰 52，差距 26，顯示區域不對稱」）
   - 跟其他維度的交叉影響要提到

2. mechanism_zh：推演機制 + 策略建議（150-250字）
   - 用「推演」開頭
   - 說清楚可能的原因鏈
   - 給出具體的保養策略，說清楚邏輯

3. protocol_zh：2-3條具體策略建議

重要原則：
- 每個維度的敘事必須不同，不要複製貼上
- 必須根據實際數字寫，不能用模板
- 語氣專業但客人聽得懂
- 像高端美容科技品牌的系統報告`
        },
        {
          role: "user",
          content: `以下是這位用戶的真實掃描數據：

${cardsSummary}

14 通道信號：${signalsSummary}

特徵摘要：
- 最弱維度：${worst.join('、')}
- 最強維度：${best.join('、')}
- 平均分數：${Math.round(cardsRaw.reduce((s, c) => s + c.score, 0) / cardsRaw.length)}

請為每個維度生成專屬於這位用戶的報告。每個維度的敘事必須不同。`
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "narratives",
          strict: true,
          schema: {
            type: "object",
            properties: {
              dimensions: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    id: { type: "string" },
                    finding_zh: { type: "string" },
                    mechanism_zh: { type: "string" },
                    protocol_zh: { type: "array", items: { type: "string" } }
                  },
                  required: ["id", "finding_zh", "mechanism_zh", "protocol_zh"],
                  additionalProperties: false
                }
              },
              summary_zh: { type: "string" }
            },
            required: ["dimensions", "summary_zh"],
            additionalProperties: false
          }
        }
      },
      max_tokens: 8192,
    };

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(payload),
    });

    if (!r.ok) {
      console.error(`OpenAI error: ${r.status}`);
      return null;
    }

    const j: any = await r.json();
    const content = j?.choices?.[0]?.message?.content;
    if (!content) return null;
    return JSON.parse(content);
  } catch (err) {
    console.error("[LLM Narrative] fallback to static:", err);
    return null;
  }
}

/* =========================
   ✅ 決策層（只出現一次）
========================= */
function buildDecisionLayer(signals14: ReportSignal[], cards: Card[]) {
  const sensitivity = signals14.find((s) => s.id === "sensitivity")?.score ?? 50;
  const barrier = cards.find((c) => c.id === "barrier")?.score ?? 70;
  const texture = cards.find((c) => c.id === "texture")?.score ?? 70;

  const primary =
    barrier < 72 ? "屏障不穩定（Barrier Instability）" : "屏障微波動（Barrier Micro-Instability）";
  const secondary =
    texture < 72 ? "紋理不規則（Texture Irregularity）" : "紋理漂移（Texture Drift）";

  const constraints = [
    "High % AHA：禁用",
    "Retinol：降頻",
    `去角質間隔：${barrier < 72 ? "≥ 10 天" : "≥ 7 天"}`,
  ];

  const timeline = [
    "Week 1–2：穩定屏障",
    "Week 3：低刺激更新",
    "Week 4：微結構優化",
  ];

  const decision =
`系統決策說明
目前敏感負載較低（${clampScore(sensitivity)}）
為避免角質代謝過快導致刺激訊號放大，
系統已暫時限制高濃度酸類與高頻煥膚行為。
建議 14 天內以屏障穩定為主。`;

  const node =
`SYSTEM PRIORITY NODE
Primary Risk: ${primary}
Secondary Drift: ${secondary}`;

  const environment =
`ENVIRONMENT & INFERENCE BOUNDARY / 環境與推估邊界
• 光源會影響色素與亮度的可視判讀
• 角度/距離會影響毛孔可視度與紋理對比
• 當前為單次影像推估，用於決策排序與行為約束（非醫療診斷）`;

  return { environment, decision, node, constraints, timeline };
}

/* =========================
   MAIN HANDLER (Edge) — POST + GET
========================= */
export default async function handler(req: Request) {
  try {
    if (req.method === "OPTIONS") return json({ ok: true }, 200);

    // ✅ GET：查 task 狀態，success 才回 report
    if (req.method === "GET") {
      const url = new URL(req.url);
      const taskId = url.searchParams.get("task_id");
      const scanId = url.searchParams.get("scan_id") || nowId();
      if (!taskId) return json({ error: "missing_task_id" }, 400);

      const task = await youcamGetTask(taskId);
      const st = task?.data?.task_status;

      if (st === "success") {
        const scoreMap = extractYoucamScores(task);
        const cardsRaw = mapYoucamToCards(scoreMap);
        const signals14 = buildSignals14(scoreMap, cardsRaw);

        // ✅ 決策層只出現一次
        const decisionLayer = buildDecisionLayer(signals14, cardsRaw);

        // ✅ LLM 個人化敘事（失敗 fallback 回靜態）
        const narratives = await generateLLMNarratives(cardsRaw, signals14);
        const useLLM = narratives && Array.isArray(narratives.dimensions) && narratives.dimensions.length > 0;

        // ✅ 每張卡片：LLM 個人化 or 靜態 fallback
        const cards: Card[] = cardsRaw.map((c) => {
          const s = clampScore(c.score);
          const narrative = useLLM ? narratives.dimensions.find((n: any) => n.id === c.id) : null;
          return {
            ...c,
            signal_zh: narrative?.finding_zh || zhFinding(c.id, s),
            recommendation_zh: narrative?.mechanism_zh || zhMechanism(c.id, s),
            signal_en: "",
            recommendation_en: "",
          };
        });

        const dimensions8: ReportDimension[] = cards
          .slice()
          .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
          .map((c) => {
            const s = clampScore(c.score);
            const tone = toneForScore(s);
            const narrative = useLLM ? narratives.dimensions.find((n: any) => n.id === c.id) : null;
            return {
              id: c.id,
              title_en: c.title_en,
              title_zh: c.title_zh,
              score: s,
              tone,
              confidence: Number(c.confidence) || 0.78,
              finding_en: "",
              mechanism_en: "",
              protocol_en: [],
              finding_zh: c.signal_zh || "",
              mechanism_zh: c.recommendation_zh || "",
              protocol_zh: narrative?.protocol_zh || zhProtocol(c.id, s),
              masks: c.masks,
            };
          });

        const report: Report = {
          scan_id: scanId,
          produced_at: new Date().toISOString(),
          degraded: false,
          stage: "youcam_success",
          summary_en: "",
          summary_zh: useLLM && narratives.summary_zh
            ? narratives.summary_zh
            : `掃描完成：14 通道已整合為 8 維度決策報告。`,
          precheck: undefined,
          signals14,
          dimensions8,
          environment_zh: decisionLayer.environment,
          decision_zh: decisionLayer.decision,
          priority_node_zh: decisionLayer.node,
          constraints_zh: decisionLayer.constraints,
          timeline_zh: decisionLayer.timeline,
        };

        return json({
          scan_id: scanId,
          degraded: false,
          stage: "youcam_success",
          task_status: "success",
          report,
          cards,
          summary_en: "",
          summary_zh: `${report.summary_zh}\n\n${report.environment_zh}`,
        }, 200);
      }

      if (st === "error") {
        const errMsg = JSON.stringify(task?.data || {});
        // ✅ YouCam 常見：below_min_image_size → 回 scan_retake（前端顯示重拍提示）
        if (errMsg.includes("below_min_image_size")) {
          return json({
            error: "scan_retake",
            stage: "youcam_error_below_min_image_size",
            tips: [
              "影像尺寸不足（系統已嘗試補足）。",
              "請更靠近一點拍或改用更高解析度。",
              "避免聊天軟體壓縮後再上傳。",
            ],
          }, 200);
        }
        return json({
          scan_id: scanId,
          degraded: true,
          stage: "youcam_error",
          task_status: "error",
          message: errMsg,
        }, 200);
      }

      // processing / queued
      return json({
        scan_id: scanId,
        degraded: true,
        stage: "processing",
        task_status: st || "processing",
      }, 200);
    }

    // ✅ POST：上傳 + 建立 task → 立刻回 task_id
    if (req.method === "POST") {
      const scanId = nowId();
      if (!YOUCAM_API_KEY) {
        return json({ scan_id: scanId, degraded: true, stage: "env", message: "Missing YOUCAM_API_KEY" }, 200);
      }

      const form = await req.formData();
      const files = await getFiles(form);

      // 先做 precheck（給前端顯示）
      const rawBytes = await toBytes(files[0]);
      const check = quickPrecheck(rawBytes);
      const precheck = { passed: check.ok, warnings: check.warnings, tips: check.tips };

      // ✅ 送 YouCam 前：補到最低尺寸（關鍵）
      let normalized: { bytes: Uint8Array; contentType: string; width: number; height: number };
      try {
        normalized = await normalizeForYouCam(files[0], { minSide: 720, maxSide: 1440, quality: 0.92 });
      } catch {
        // fallback：至少不要整個 fail
        normalized = { bytes: rawBytes, contentType: files[0].type || "image/jpeg", width: 0, height: 0 };
      }

      const { fileId, putUrl, contentType } = await youcamInitUpload(normalized.bytes, `skin_${Date.now()}.jpg`);
      await youcamPutBinary(putUrl, normalized.bytes, contentType);

      const taskId = await youcamCreateTask(fileId, YOUCAM_HD_ACTIONS);

      return json({
        scan_id: scanId,
        degraded: true,
        stage: "task_created",
        task_id: taskId,
        task_status: "processing",
        precheck,
        normalized: {
          width: normalized.width,
          height: normalized.height,
          bytes_kb: Math.round((normalized.bytes.length / 1024) * 10) / 10,
        },
        summary_en: "",
        summary_zh: "任務已建立，等待分析輸出。",
      }, 200);
    }

    return json({ error: "405", message: "GET/POST only" }, 405);
  } catch (err: any) {
    return json({ degraded: true, stage: "exception", message: err?.message || String(err) }, 200);
  }
}
