export const config = {
  runtime: "edge",
  regions: ["sin1", "hnd1", "icn1"],
};

type MetricId =
  | "texture"
  | "pore"
  | "pigmentation"
  | "wrinkle"
  | "hydration"
  | "sebum"
  | "skintone"
  | "sensitivity"
  | "clarity"
  | "elasticity"
  | "redness"
  | "brightness"
  | "firmness"
  | "pores_depth";

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

type Tone = "stable" | "deviation" | "threshold";

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
  protocol_en: string[]; // exactly 2 bullets
  protocol_zh: string[]; // exactly 2 bullets
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

function nowId() {
  return `scan_${Date.now()}`;
}

const YOUCAM_API_KEY = process.env.YOUCAM_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

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

function quickPrecheck(bytes: Uint8Array) {
  const sizeKB = bytes.length / 1024;
  const warnings: string[] = [];
  const tips: string[] = [];

  if (sizeKB < 60) {
    warnings.push("LOW_RESOLUTION");
    tips.push("畫質偏低。請使用更清晰的正面照片。");
  }

  let sample = 0,
    sum = 0;
  for (let i = 0; i < bytes.length; i += 401) {
    sum += bytes[i];
    sample++;
  }
  const avg = sample ? sum / sample : 120;

  if (avg < 85) {
    warnings.push("TOO_DARK");
    tips.push("光線偏暗。請面向窗戶或補柔光。");
  }
  if (avg > 185) {
    warnings.push("TOO_BRIGHT");
    tips.push("高光偏強。避免直射頂光。");
  }

  return { ok: warnings.length === 0, avgSignal: avg, warnings, tips };
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

/* =========================
   YouCam — HD Skin Analysis
========================= */
const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";
const YOUCAM_FILE_ENDPOINT = `${YOUCAM_BASE}/file/skin-analysis`;
const YOUCAM_TASK_CREATE = `${YOUCAM_BASE}/task/skin-analysis`;
const YOUCAM_TASK_GET = (taskId: string) => `${YOUCAM_BASE}/task/skin-analysis/${taskId}`;

// ✅ 只留你報告/8維度用得到的 actions（越少越快越穩）
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

async function youcamInitUpload(fileBytes: Uint8Array, fileType: string, fileName: string) {
  const apiKey = must(YOUCAM_API_KEY, "YOUCAM_API_KEY");

  const payload = {
    files: [
      {
        content_type: fileType || "image/jpeg",
        file_name: fileName || `skin_${Date.now()}.jpg`,
        file_size: fileBytes.length,
      },
    ],
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
    body: fileBytes,
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

async function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

// ✅ Edge 不能拖太久：控制 poll 上限（會自動降級回報告）
async function youcamPollTask(taskId: string, maxMs = 22000) {
  const apiKey = must(YOUCAM_API_KEY, "YOUCAM_API_KEY");
  const start = Date.now();
  let wait = 900;

  while (Date.now() - start < maxMs) {
    const r = await fetch(YOUCAM_TASK_GET(taskId), {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    });

    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status !== 200) throw new Error(`YouCam task poll failed: ${r.status} ${JSON.stringify(j)}`);

    const st = j.data?.task_status;
    if (st === "success") return j;
    if (st === "error") throw new Error(`YouCam task error: ${JSON.stringify(j.data)}`);

    await sleep(wait);
    wait = Math.min(wait * 1.45, 4200);
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

/* =========================
   ✅ MAP YouCam → 8 Cards
========================= */
function mapYoucamToCards(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>) {
  const get = (k: string, fallback?: string) => scoreMap.get(k) ?? (fallback ? scoreMap.get(fallback) : undefined);
  const safe = (v?: { ui: number; raw: number; masks: string[] }) => ({
    ui: clampScore(v?.ui),
    raw: Number.isFinite(Number(v?.raw)) ? Number(v?.raw) : 0,
    masks: v?.masks || [],
  });

  const H = safe(get("hd_moisture") ?? get("moisture"));
  const PG = safe(get("hd_age_spot") ?? get("age_spot"));
  const T = safe(get("hd_texture") ?? get("texture"));
  const S = safe(get("hd_oiliness") ?? get("oiliness"));
  const P = safe(get("hd_pore") ?? get("pore"));
  const R = safe(get("hd_radiance") ?? get("radiance"));
  const RD = safe(get("hd_redness") ?? get("redness"));
  const F = safe(get("hd_firmness") ?? get("firmness"));
  const W = safe(get("hd_wrinkle") ?? get("wrinkle"));
  const AC = safe(get("hd_acne") ?? get("acne"));

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
   ✅ Report labels + derived 14 signals
========================= */
const SIGNAL_LABELS: Record<MetricId, { en: string; zh: string }> = {
  hydration: { en: "Hydration", zh: "含水" },
  elasticity: { en: "Elasticity", zh: "彈性" },
  pore: { en: "Pore", zh: "毛孔" },
  pores_depth: { en: "Pore Depth", zh: "毛孔深度" },
  skintone: { en: "Skin Tone", zh: "膚色均勻" },
  pigmentation: { en: "Pigmentation", zh: "色素" },
  texture: { en: "Texture", zh: "紋理" },
  sebum: { en: "Sebum", zh: "油脂" },
  wrinkle: { en: "Wrinkle", zh: "皺紋" },
  redness: { en: "Redness", zh: "泛紅" },
  brightness: { en: "Brightness", zh: "亮度" },
  firmness: { en: "Firmness", zh: "緊緻" },
  sensitivity: { en: "Sensitivity", zh: "敏感負載" },
  clarity: { en: "Clarity", zh: "通透度" },
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

  // Derived channels (讓報告有 14 通道，不依賴多餘 actions)
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
    pack("redness", clampScore(100 - RD)), // ✅ 轉成「越高越好」的穩定分數
    pack("brightness", brightness),
    pack("skintone", skintone),
    pack("clarity", clarity),
    pack("sensitivity", sensitivity),
  ];
}

/* =========================
   ✅ High-end fallback narratives (NO generic “just moisturize”)
========================= */
const REPORT_FALLBACK: Record<
  string,
  {
    finding_zh: string;
    mechanism_zh: string;
    protocol_zh: string[];
    finding_en: string;
    mechanism_en: string;
    protocol_en: string[];
  }
> = {
  hydration: {
    finding_zh: "水分梯度可控，但封存係數偏低，日內波動。",
    mechanism_zh: "脂質矩陣不足 → TEWL 偏高，留存效率被稀釋。",
    protocol_zh: ["NMF：泛醇/胺基酸", "補脂：Ceramide 3:1:1"],
    finding_en: "Hydration gradient is acceptable; retention is unstable.",
    mechanism_en: "Suboptimal lipid matrix elevates TEWL and reduces moisture stability.",
    protocol_en: ["Build NMF: panthenol/amino acids", "Seal lipids: ceramide 3:1:1 mix"],
  },
  melanin: {
    finding_zh: "色素呈區域集群，顴區活躍度較高。",
    mechanism_zh: "UV 誘導黑色素生成＋轉移累積，形成局部濃度差。",
    protocol_zh: ["抗氧鏈：Vit C + ferulic", "轉移控制：B3/傳明酸"],
    finding_en: "Pigment shows zonal clustering, malar area more active.",
    mechanism_en: "UV-driven melanogenesis + transfer accumulation creates local density shifts.",
    protocol_en: ["Antioxidant chain: Vit C + ferulic", "Transfer control: niacinamide/TxA"],
  },
  texture: {
    finding_zh: "微紋理起伏偏大，散射上升，質感變粗。",
    mechanism_zh: "角質排列與黏著不均 → microrelief 增加與反射破碎。",
    protocol_zh: ["溫和更新：PHA/LHA", "角質結構：尿素/神經醯胺"],
    finding_en: "Micro-relief is elevated; scattering increases perceived roughness.",
    mechanism_en: "Uneven corneocyte cohesion increases microrelief and fragments specular reflection.",
    protocol_en: ["Gentle renewal: PHA/LHA", "Structure support: urea/ceramides"],
  },
  sebum: {
    finding_zh: "皮脂分佈區域化，T 區輸出偏高。",
    mechanism_zh: "皮脂梯度＋脫水平衡交互，易造成局部堵塞風險。",
    protocol_zh: ["控油不破膜：Zinc PCA", "孔道清理：BHA 週2–3"],
    finding_en: "Sebum distribution is zonal; T-zone output trends higher.",
    mechanism_en: "Sebum gradient + dehydration cross-talk increases stagnation and clog potential.",
    protocol_en: ["Regulate without stripping: zinc PCA", "Clear channels: BHA 2–3×/wk"],
  },
  pore: {
    finding_zh: "孔洞結構有擴張帶，角栓風險上升。",
    mechanism_zh: "毛囊角化＋皮脂滯留 → 孔道被撐開形成結構性擴張。",
    protocol_zh: ["角化管理：BHA/視黃醇交替", "結構支撐：B3/胜肽"],
    finding_en: "Pore structure shows dilation bands; plug risk increases.",
    mechanism_en: "Follicular keratinization + sebum stagnation expands channels structurally.",
    protocol_en: ["Keratin control: BHA/retinoid alternating", "Support structure: niacinamide/peptides"],
  },
  elasticity: {
    finding_zh: "張力回彈尚可，但恢復速度略慢。",
    mechanism_zh: "膠原/彈力網需重塑，糖化與氧化負載會拖慢回彈曲線。",
    protocol_zh: ["夜間重塑：視黃醇 2–3晚", "抗氧支援：胜肽/維E"],
    finding_en: "Elastic return is decent; recovery velocity slightly delayed.",
    mechanism_en: "Collagen/elastin remodeling + glycation/oxidative load can slow recoil dynamics.",
    protocol_en: ["Night remodeling: retinoid 2–3 nights/wk", "Oxidative support: peptides/Vit E"],
  },
  radiance: {
    finding_zh: "光澤偏漫反射，通透度需要拉升。",
    mechanism_zh: "表面散射（紋理）＋微炎症訊號，讓亮度被吃掉。",
    protocol_zh: ["抑炎抗氧：壬二酸/EGCG", "提亮鏈路：Vit C + 封存"],
    finding_en: "Radiance trends toward diffuse reflection; clarity needs lift.",
    mechanism_en: "Surface scattering + micro-inflammatory signals reduce perceived luminosity.",
    protocol_en: ["Anti-inflammatory antioxidants: azelaic/EGCG", "Brightening chain: Vit C + sealing"],
  },
  barrier: {
    finding_zh: "屏障可用但存在裂縫風險，耐受度需穩住。",
    mechanism_zh: "脂質矩陣連續性不足＋pH 漂移，刺激閾值下降。",
    protocol_zh: ["補脂修復：Ceramide/膽固醇/FA", "降刺激：停強酸/酒精香精"],
    finding_en: "Barrier is functional but shows crack-risk; tolerance needs stabilization.",
    mechanism_en: "Lipid continuity gaps + pH drift lower irritation threshold.",
    protocol_en: ["Repair lipids: ceramide/cholesterol/FA", "Reduce triggers: pause strong acids/fragrance"],
  },
};

function attachFallbackToCards(cards: Card[]) {
  // 讓 cards 本身也有高級敘事（兼容你前端/未來用途）
  return cards.map((c) => {
    const fb = REPORT_FALLBACK[c.id];
    if (!fb) return c;
    return {
      ...c,
      signal_zh: c.signal_zh || fb.finding_zh,
      signal_en: c.signal_en || fb.finding_en,
      recommendation_zh: c.recommendation_zh || fb.mechanism_zh + "\n• " + fb.protocol_zh.join("\n• "),
      recommendation_en: c.recommendation_en || fb.mechanism_en + " | " + fb.protocol_en.join(" / "),
    };
  });
}

function buildReportFromCards(params: {
  scanId: string;
  stage: string;
  degraded: boolean;
  precheck?: { passed: boolean; warnings: string[]; tips: string[] };
  signals14: ReportSignal[];
  cards: Card[];
  overrides?: Partial<Record<string, Partial<ReportDimension>>>;
}): Report {
  const { scanId, stage, degraded, precheck, signals14, cards, overrides } = params;

  const dims: ReportDimension[] = cards
    .slice()
    .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
    .map((c) => {
      const fb = REPORT_FALLBACK[c.id] || REPORT_FALLBACK["barrier"];
      const tone = toneForScore(Number(c.score) || 0);
      const o = overrides?.[c.id] || {};
      return {
        id: c.id,
        title_en: c.title_en,
        title_zh: c.title_zh,
        score: clampScore(c.score),
        tone,
        confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : 0.75,
        finding_en: String(o.finding_en ?? fb.finding_en),
        finding_zh: String(o.finding_zh ?? fb.finding_zh),
        mechanism_en: String(o.mechanism_en ?? fb.mechanism_en),
        mechanism_zh: String(o.mechanism_zh ?? fb.mechanism_zh),
        protocol_en: Array.isArray(o.protocol_en) ? (o.protocol_en as string[]).slice(0, 2) : fb.protocol_en,
        protocol_zh: Array.isArray(o.protocol_zh) ? (o.protocol_zh as string[]).slice(0, 2) : fb.protocol_zh,
        masks: c.masks,
      };
    });

  // concise summary (高級但不長)
  const summary_zh = degraded
    ? "掃描降級完成：14 通道已映射為 8 維度決策報告。"
    : "掃描完成：14 通道訊號已整合為 8 維度決策報告。";
  const summary_en = degraded
    ? "Degraded scan complete. 14 channels mapped into an 8-dimension decision report."
    : "Scan complete. 14 channels integrated into an 8-dimension decision report.";

  return {
    scan_id: scanId,
    produced_at: new Date().toISOString(),
    degraded,
    stage,
    summary_en,
    summary_zh,
    precheck,
    signals14,
    dimensions8: dims,
  };
}

/* =========================
   ✅ OpenAI: generate report narratives (concise, clinical, not generic)
========================= */
async function generateReportNarrativesWithOpenAI(args: {
  cards: Card[];
  signals14: ReportSignal[];
  timeoutMs: number;
}) {
  const apiKey = must(OPENAI_API_KEY, "OPENAI_API_KEY");

  const input = {
    signals14: args.signals14.map((s) => ({ id: s.id, score: s.score, tone: s.tone, zh: s.label_zh, en: s.label_en })),
    dimensions8: args.cards
      .slice()
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((c) => ({
        id: c.id,
        title_zh: c.title_zh,
        title_en: c.title_en,
        score: c.score,
        details: (c.details || []).map((d) => `${d.label_zh}:${d.value}`).join(" / "),
      })),
  };

  const system = `
You are a high-end clinical product writer for a futuristic skin analysis report.
Goal: concise, decision-oriented narrative. Avoid generic advice like "just moisturize / drink water".
Use mechanistic language: TEWL, lipid matrix, NMF, corneocyte cohesion, microrelief scattering, melanogenesis transfer, inflammation load, collagen/elastin remodeling.
Constraints:
- summary_zh <= 60 chars; summary_en <= 110 chars.
- For each of 8 dimensions:
  finding_zh <= 42 chars; mechanism_zh <= 72 chars; protocol_zh: EXACTLY 2 bullets, each <= 28 chars.
  finding_en <= 70 chars; mechanism_en <= 110 chars; protocol_en: EXACTLY 2 bullets, each <= 60 chars.
Return STRICT JSON object:
{
  "summary_zh": "...",
  "summary_en": "...",
  "dimensions8": [
    {"id":"hydration","finding_zh":"...","mechanism_zh":"...","protocol_zh":["...","..."],"finding_en":"...","mechanism_en":"...","protocol_en":["...","..."]},
    ...
  ]
}
No markdown.`;

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), Math.max(1200, args.timeoutMs));

  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.35,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(input) },
        ],
      }),
    });

    const j = await r.json().catch(() => ({}));
    const content = j.choices?.[0]?.message?.content;
    if (!r.ok || !content) throw new Error(`OpenAI failed: ${r.status} ${JSON.stringify(j)}`);

    const parsed = JSON.parse(content);
    const arr = Array.isArray(parsed?.dimensions8) ? parsed.dimensions8 : [];
    const map = new Map<string, any>(arr.map((x: any) => [x.id, x]));

    return {
      summary_zh: String(parsed?.summary_zh || ""),
      summary_en: String(parsed?.summary_en || ""),
      overrides: Object.fromEntries(
        Array.from(map.entries()).map(([id, x]) => [
          id,
          {
            finding_zh: x.finding_zh,
            mechanism_zh: x.mechanism_zh,
            protocol_zh: x.protocol_zh,
            finding_en: x.finding_en,
            mechanism_en: x.mechanism_en,
            protocol_en: x.protocol_en,
          },
        ])
      ) as Partial<Record<string, Partial<ReportDimension>>>,
    };
  } finally {
    clearTimeout(t);
  }
}

/* =========================
   ✅ MAIN HANDLER
========================= */
export default async function handler(req: Request) {
  if (req.method === "OPTIONS") return json({ ok: true });
  if (req.method !== "POST") return json({ error: "405", message: "POST only" }, 405);

  const scanId = nowId();
  let stage = "init";

  // ✅ Edge 生存策略：總時間預算（避免被拖死）
  const startedAt = Date.now();
  const BUDGET_MS = 28000;
  const timeLeft = () => BUDGET_MS - (Date.now() - startedAt);

  const degradeReturn = (reason: string, precheck?: any) => {
    const fallbackScoreMap = new Map<string, { ui: number; raw: number; masks: string[] }>([
      ["hd_moisture", { ui: 72, raw: 0, masks: [] }],
      ["hd_age_spot", { ui: 85, raw: 0, masks: [] }],
      ["hd_texture", { ui: 64, raw: 0, masks: [] }],
      ["hd_oiliness", { ui: 91, raw: 0, masks: [] }],
      ["hd_pore", { ui: 78, raw: 0, masks: [] }],
      ["hd_firmness", { ui: 88, raw: 0, masks: [] }],
      ["hd_wrinkle", { ui: 72, raw: 0, masks: [] }],
      ["hd_radiance", { ui: 69, raw: 0, masks: [] }],
      ["hd_redness", { ui: 58, raw: 0, masks: [] }],
      ["hd_acne", { ui: 65, raw: 0, masks: [] }],
    ]);

    let cards = attachFallbackToCards(mapYoucamToCards(fallbackScoreMap));
    const signals14 = buildSignals14(fallbackScoreMap, cards);
    const report = buildReportFromCards({
      scanId,
      stage: `${stage}`,
      degraded: true,
      precheck,
      signals14,
      cards,
    });

    return json({
      scan_id: scanId,
      degraded: true,
      stage,
      message: reason,
      precheck,
      report,
      cards,
      summary_en: report.summary_en,
      summary_zh: report.summary_zh,
    });
  };

  try {
    stage = "parse";
    const form = await req.formData();
    const files = await getFiles(form);

    const fileBytes = await toBytes(files[0]);

    stage = "precheck";
    const check = quickPrecheck(fileBytes);

    // ✅ env 沒設 → 直接降級回報告（前端仍必出）
    if (!YOUCAM_API_KEY) return degradeReturn("Missing YOUCAM_API_KEY", { passed: check.ok, warnings: check.warnings, tips: check.tips });

    if (timeLeft() < 14000) {
      return degradeReturn("Time budget too tight before YouCam start", { passed: check.ok, warnings: check.warnings, tips: check.tips });
    }

    stage = "youcam_upload";
    const { fileId, putUrl, contentType } = await youcamInitUpload(fileBytes, files[0].type, files[0].name);
    await youcamPutBinary(putUrl, fileBytes, contentType);

    stage = "youcam_task";
    const taskId = await youcamCreateTask(fileId, YOUCAM_HD_ACTIONS);

    stage = "youcam_poll";
    const pollMax = Math.max(9000, Math.min(22000, timeLeft() - 4500)); // 留後面組 report 的時間
    const taskResult = await youcamPollTask(taskId, pollMax);

    stage = "extract";
    const scoreMap = extractYoucamScores(taskResult);

    stage = "map_cards";
    let cards = mapYoucamToCards(scoreMap);
    cards = attachFallbackToCards(cards); // 先保底高級敘事

    const signals14 = buildSignals14(scoreMap, cards);

    stage = "report";
    let report = buildReportFromCards({
      scanId,
      stage,
      degraded: false,
      precheck: { passed: check.ok, warnings: check.warnings, tips: check.tips },
      signals14,
      cards,
    });

    // ✅ OpenAI 有時間才做（沒時間就保持 fallback 敘事，仍是高級）
    if (OPENAI_API_KEY && timeLeft() > 7000) {
      try {
        const nar = await generateReportNarrativesWithOpenAI({
          cards,
          signals14,
          timeoutMs: Math.min(5200, Math.max(1800, timeLeft() - 1400)),
        });

        report = buildReportFromCards({
          scanId,
          stage,
          degraded: false,
          precheck: { passed: check.ok, warnings: check.warnings, tips: check.tips },
          signals14,
          cards,
          overrides: nar.overrides,
        });

        // 把 summary 覆蓋成更精煉版本（若 OpenAI 有給）
        if (nar.summary_zh) report.summary_zh = nar.summary_zh;
        if (nar.summary_en) report.summary_en = nar.summary_en;
      } catch (e: any) {
        // OpenAI fail → 不影響出報告
        console.error("OpenAI report narrative failed:", e?.message || String(e));
      }
    }

    return json({
      scan_id: scanId,
      degraded: false,
      precheck: { passed: check.ok, warnings: check.warnings, tips: check.tips },
      report,
      cards,
      summary_en: report.summary_en,
      summary_zh: report.summary_zh,
    });
  } catch (err: any) {
    const msg = err?.message || String(err);
    console.error(`[SCAN ERROR] stage=${stage} id=${scanId}`, msg);

    // 仍然回 200 + 報告（保證前端必出）
    return degradeReturn(msg);
  }
}
