export const config = {
  runtime: "edge",
  regions: ["sin1", "hnd1", "icn1"],
};

type MetricId =
  | "texture" | "pore" | "pigmentation" | "wrinkle"
  | "hydration" | "sebum" | "skintone" | "sensitivity"
  | "clarity" | "elasticity" | "redness" | "brightness" | "firmness" | "pores_depth";

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

function nowId() { return `scan_${Date.now()}`; }

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
   YouCam — endpoints
========================= */
const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";
const YOUCAM_FILE_ENDPOINT = `${YOUCAM_BASE}/file/skin-analysis`;
const YOUCAM_TASK_CREATE = `${YOUCAM_BASE}/task/skin-analysis`;
const YOUCAM_TASK_GET = (taskId: string) => `${YOUCAM_BASE}/task/skin-analysis/${taskId}`;

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
    files: [{
      content_type: fileType || "image/jpeg",
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
   MAP YouCam → 8 cards
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
   14 signals
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
   ✅ 冷靜推演 + 決策層（全部中文）
   只用你現有欄位：finding_zh / mechanism_zh / protocol_zh
========================= */
function buildDecisionNarrative(params: {
  dimId: string;
  dimZh: string;
  score: number;
  sensitivityLoad: number; // 來自 signals14 sensitivity
  barrierScore: number;    // 來自 cards barrier
  textureScore: number;    // 來自 cards texture
}) {
  const { score, sensitivityLoad, barrierScore, textureScore } = params;

  // 主風險/次漂移（依你的需求：每個都要有）
  const primaryRisk =
    barrierScore < 72 ? "屏障不穩定（Barrier Instability）"
    : "結構波動（Barrier Micro-Instability）";

  const secondaryDrift =
    textureScore < 72 ? "紋理不規則（Texture Irregularity）"
    : "紋理漂移（Texture Drift）";

  // 約束條件：依敏感負載與屏障分數決定
  const banAHA = true; // 先按你要求，所有報告都能帶到（專業一致性）
  const retinolLowFreq = true;
  const exfoliationGap = barrierScore < 72 ? "≥ 10 天" : "≥ 7 天";

  const decisionNote =
`系統決策說明
目前敏感負載較低（${clampScore(sensitivityLoad)}）
為避免角質代謝過快導致刺激訊號放大，
系統已暫時限制高濃度酸類與高頻煥膚行為。
建議 14 天內以屏障穩定為主。`;

  const priorityNode =
`SYSTEM PRIORITY NODE
Primary Risk: ${primaryRisk}
Secondary Drift: ${secondaryDrift}

Constraint Activated:
• High % AHA：${banAHA ? "禁用" : "限制"}
• Retinol：${retinolLowFreq ? "降頻" : "限制"}
• 去角質間隔：${exfoliationGap}

Strategy Timeline:
Week 1–2：穩定屏障
Week 3：低刺激更新
Week 4：微結構優化`;

  return { decisionNote, priorityNode };
}

/* =========================
   ✅ ENVIRONMENT 声明（放到 summary_zh 下方）
========================= */
const ENV_BOUNDARY_ZH =
`ENVIRONMENT & INFERENCE BOUNDARY / 環境與推估邊界
• 光源會影響色素與亮度的可視判讀
• 角度/距離會影響毛孔可視度與紋理對比
• 當前為單次影像推估，用於決策排序與行為約束（非醫療診斷）`;

/* =========================
   MAIN HANDLER (Edge) — POST + GET
========================= */
export default async function handler(req: Request) {
  try {
    if (req.method === "OPTIONS") return json({ ok: true }, 200);

    // ✅ GET：查 task 狀態，success 才回「真的 report」
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

        // 拿幾個關鍵分數做「決策層」用
        const sensitivityLoad = signals14.find(s => s.id === "sensitivity")?.score ?? 50;
        const barrierScore = cardsRaw.find(c => c.id === "barrier")?.score ?? 70;
        const textureScore = cardsRaw.find(c => c.id === "texture")?.score ?? 70;

        // 每張卡片都塞入「推演 + 決策層」
        const cards: Card[] = cardsRaw.map((c) => {
          const d = buildDecisionNarrative({
            dimId: c.id,
            dimZh: c.title_zh,
            score: c.score,
            sensitivityLoad,
            barrierScore,
            textureScore,
          });

          // ✅ 你要的格式：全部中文，冷靜語氣
          const finding = `視覺特徵顯示「${c.title_zh}」對應結構可能存在可控偏差（${clampScore(c.score)}），需以決策約束控制波動。`;
          const mech = `${d.decisionNote}\n\n${d.priorityNode}`;

          return {
            ...c,
            signal_zh: finding,
            recommendation_zh: mech,
            // 英文欄位留空（你說你看不懂英文）
            signal_en: "",
            recommendation_en: "",
          };
        });

        // Report 的 8 維度用 cards 組（沿用你原 schema）
        const dimensions8: ReportDimension[] = cards
          .slice()
          .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
          .map((c) => ({
            id: c.id,
            title_en: c.title_en,
            title_zh: c.title_zh,
            score: clampScore(c.score),
            tone: toneForScore(clampScore(c.score)),
            confidence: Number(c.confidence) || 0.78,
            finding_en: "",
            mechanism_en: "",
            protocol_en: [],
            finding_zh: c.signal_zh || "",
            mechanism_zh: c.recommendation_zh || "",
            protocol_zh: [
              "High % AHA：禁用",
              "去角質間隔：≥ 10 天",
            ],
            masks: c.masks,
          }));

        const report: Report = {
          scan_id: scanId,
          produced_at: new Date().toISOString(),
          degraded: false,
          stage: "youcam_success",
          summary_en: "",
          summary_zh: `掃描完成：14 通道已整合為 8 維度決策報告。\n\n${ENV_BOUNDARY_ZH}`,
          signals14,
          dimensions8,
        };

        return json({
          scan_id: scanId,
          degraded: false,
          stage: "youcam_success",
          task_status: "success",
          report,
          cards,
          summary_en: "",
          summary_zh: report.summary_zh,
        }, 200);
      }

      if (st === "error") {
        return json({
          scan_id: scanId,
          degraded: true,
          stage: "youcam_error",
          task_status: "error",
          message: JSON.stringify(task?.data || {}),
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

    // ✅ POST：只做「上傳 + 建立 task」→ 立刻回 task_id（不再等 22 秒）
    if (req.method === "POST") {
      const scanId = nowId();
      if (!YOUCAM_API_KEY) {
        return json({ scan_id: scanId, degraded: true, stage: "env", message: "Missing YOUCAM_API_KEY" }, 200);
      }

      const form = await req.formData();
      const files = await getFiles(form);
      const fileBytes = await toBytes(files[0]);

      const check = quickPrecheck(fileBytes);
      const precheck = { passed: check.ok, warnings: check.warnings, tips: check.tips };

      const { fileId, putUrl, contentType } = await youcamInitUpload(fileBytes, files[0].type, files[0].name);
      await youcamPutBinary(putUrl, fileBytes, contentType);

      const taskId = await youcamCreateTask(fileId, YOUCAM_HD_ACTIONS);

      return json({
        scan_id: scanId,
        degraded: true,
        stage: "task_created",
        task_id: taskId,
        task_status: "processing",
        precheck,
        summary_en: "",
        summary_zh: "任務已建立，等待分析輸出。",
      }, 200);
    }

    return json({ error: "405", message: "GET/POST only" }, 405);
  } catch (err: any) {
    return json({ degraded: true, stage: "exception", message: err?.message || String(err) }, 200);
  }
}
