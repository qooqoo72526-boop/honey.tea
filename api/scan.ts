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

  if (sizeKB < 60) { warnings.push("LOW_RESOLUTION"); tips.push("畫質偏低。請使用更清晰的正面照片。"); }

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
   YouCam endpoints
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
   MAP → 8 cards
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
    id: "hydration", title_en: "HYDRATION TOPOLOGY", title_zh: "保濕拓撲",
    score: H.ui, max: 100, signal_en: "", signal_zh: "",
    details: [
      { label_en: "Surface Layer", label_zh: "表層含水", value: clampScore(H.ui * 0.95) },
      { label_en: "Mid Layer", label_zh: "中層滲透", value: clampScore(H.ui * 0.88) },
      { label_en: "Deep Layer", label_zh: "深層鎖水", value: clampScore(H.ui * 0.76) },
    ],
    recommendation_en: "", recommendation_zh: "", priority: 1, confidence: 0.92, masks: H.masks,
  };

  const melanin: Card = {
    id: "melanin", title_en: "MELANIN DISTRIBUTION", title_zh: "色素分佈",
    score: PG.ui, max: 100, signal_en: "", signal_zh: "",
    details: [
      { label_en: "Forehead Zone", label_zh: "額頭區域", value: clampScore(PG.ui * 1.1) },
      { label_en: "Cheek Zone", label_zh: "臉頰區域", value: clampScore(PG.ui * 0.9) },
      { label_en: "Jaw Zone", label_zh: "下顎區域", value: clampScore(PG.ui * 0.85) },
    ],
    recommendation_en: "", recommendation_zh: "", priority: 2, confidence: 0.88, masks: PG.masks,
  };

  const texture: Card = {
    id: "texture", title_en: "TEXTURE MATRIX", title_zh: "紋理矩陣",
    score: T.ui, max: 100, signal_en: "", signal_zh: "",
    details: [
      { label_en: "Smoothness", label_zh: "平滑度", value: clampScore(T.ui * 0.9) },
      { label_en: "Uniformity", label_zh: "均勻度", value: clampScore(T.ui * 0.92) },
      { label_en: "Grain", label_zh: "顆粒感", value: clampScore(100 - T.ui) },
    ],
    recommendation_en: "", recommendation_zh: "", priority: 3, confidence: 0.9, masks: T.masks,
  };

  const tZone = clampScore(S.ui * 1.2);
  const uZone = clampScore(S.ui * 0.7);
  const sebum: Card = {
    id: "sebum", title_en: "SEBUM BALANCE", title_zh: "油脂平衡",
    score: S.ui, max: 100, signal_en: "", signal_zh: "",
    details: [
      { label_en: "T-Zone Output", label_zh: "T 區出油", value: tZone },
      { label_en: "Cheek Output", label_zh: "臉頰出油", value: uZone },
      { label_en: "Equilibrium", label_zh: "平衡值", value: clampScore((tZone + uZone) / 2) },
    ],
    recommendation_en: "", recommendation_zh: "", priority: 4, confidence: 0.87, masks: S.masks,
  };

  const pore: Card = {
    id: "pore", title_en: "PORE ARCHITECTURE", title_zh: "毛孔結構",
    score: P.ui, max: 100, signal_en: "", signal_zh: "",
    details: [
      { label_en: "T-Zone", label_zh: "T 區", value: clampScore(P.ui * 0.9) },
      { label_en: "Cheek", label_zh: "臉頰", value: clampScore(P.ui * 0.95) },
      { label_en: "Nose", label_zh: "鼻翼", value: clampScore(P.ui * 0.8) },
    ],
    recommendation_en: "", recommendation_zh: "", priority: 5, confidence: 0.91, masks: P.masks,
  };

  const elScore = clampScore(F.ui * 0.62 + (100 - W.ui) * 0.38);
  const elasticity: Card = {
    id: "elasticity", title_en: "ELASTICITY INDEX", title_zh: "彈性指數",
    score: elScore, max: 100, signal_en: "", signal_zh: "",
    details: [
      { label_en: "Firmness", label_zh: "緊緻度", value: F.ui },
      { label_en: "Wrinkle Depth", label_zh: "皺紋深度", value: W.ui },
      { label_en: "Recovery", label_zh: "回彈", value: clampScore(elScore * 0.9) },
    ],
    recommendation_en: "", recommendation_zh: "", priority: 6, confidence: 0.85, masks: F.masks.length ? F.masks : W.masks,
  };

  const radiance: Card = {
    id: "radiance", title_en: "RADIANCE SPECTRUM", title_zh: "光澤頻譜",
    score: R.ui, max: 100, signal_en: "", signal_zh: "",
    details: [
      { label_en: "Luminosity", label_zh: "明亮度", value: clampScore(R.ui * 1.05) },
      { label_en: "Evenness", label_zh: "均勻度", value: clampScore(R.ui * 0.92) },
      { label_en: "Glow Index", label_zh: "光澤", value: clampScore(R.ui * 0.88) },
    ],
    recommendation_en: "", recommendation_zh: "", priority: 7, confidence: 0.89, masks: R.masks,
  };

  const barrierScore = clampScore((100 - RD.ui) * 0.4 + H.ui * 0.3 + (100 - AC.ui) * 0.3);
  const barrier: Card = {
    id: "barrier", title_en: "BARRIER INTEGRITY", title_zh: "屏障完整度",
    score: barrierScore, max: 100, signal_en: "", signal_zh: "",
    details: [
      { label_en: "Lipid Matrix", label_zh: "脂質基質", value: clampScore(barrierScore * 0.95) },
      { label_en: "Ceramide Layer", label_zh: "神經醯胺", value: clampScore(barrierScore * 0.9) },
      { label_en: "Moisture Seal", label_zh: "保濕封存", value: H.ui },
      { label_en: "Surface Film", label_zh: "皮脂膜", value: S.ui },
    ],
    recommendation_en: "", recommendation_zh: "", priority: 8, confidence: 0.86, masks: RD.masks.length ? RD.masks : AC.masks,
  };

  return [hydration, melanin, texture, sebum, pore, elasticity, radiance, barrier];
}

/* =========================
   14 signals + report
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

function buildSignals14(scoreMap: Map<string, { ui: number; raw: number; masks: string[] }>) : ReportSignal[] {
  const getUi = (k: string) => clampScore(scoreMap.get(k)?.ui);

  const H = getUi("hd_moisture");
  const PG = getUi("hd_age_spot");
  const T = getUi("hd_texture");
  const S = getUi("hd_oiliness");
  const P = getUi("hd_pore");
  const R = getUi("hd_radiance");
  const RD = getUi("hd_redness");
  const F = getUi("hd_firmness");
  const W = getUi("hd_wrinkle");
  const AC = getUi("hd_acne");

  const elasticity = clampScore(F * 0.62 + (100 - W) * 0.38);
  const barrier = clampScore((100 - RD) * 0.4 + H * 0.3 + (100 - AC) * 0.3);

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

function buildReport(scanId: string, precheck: any, scoreMap: Map<string, any>, cards: Card[]): Report {
  return {
    scan_id: scanId,
    produced_at: new Date().toISOString(),
    degraded: false,
    stage: "youcam_success",
    summary_en: "Scan complete. 14 channels mapped into an 8-dimension decision report.",
    summary_zh: "掃描完成：14 通道已映射為 8 維度決策報告。",
    precheck,
    signals14: buildSignals14(scoreMap as any),
    dimensions8: cards
      .slice()
      .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0))
      .map((c) => ({
        id: c.id,
        title_en: c.title_en,
        title_zh: c.title_zh,
        score: clampScore(c.score),
        tone: toneForScore(clampScore(c.score)),
        confidence: Number(c.confidence) || 0.78,
        finding_en: c.signal_en || "",
        finding_zh: c.signal_zh || "",
        mechanism_en: c.recommendation_en || "",
        mechanism_zh: c.recommendation_zh || "",
        protocol_en: [],
        protocol_zh: [],
        masks: c.masks,
      })),
  };
}

/* =========================
   MAIN HANDLER
========================= */
export default async function handler(req: Request) {
  try {
    if (req.method === "OPTIONS") return json({ ok: true }, 200);

    // GET: poll task
    if (req.method === "GET") {
      const url = new URL(req.url);
      const taskId = url.searchParams.get("task_id");
      const scanId = url.searchParams.get("scan_id") || nowId();
      if (!taskId) return json({ error: "missing_task_id" }, 400);

      const task = await youcamGetTask(taskId);
      const st = task?.data?.task_status;

      if (st === "success") {
        const scoreMap = extractYoucamScores(task);
        const cards = mapYoucamToCards(scoreMap);
        const report = buildReport(scanId, undefined, scoreMap as any, cards);
        return json({
          scan_id: scanId,
          degraded: false,
          task_status: "success",
          report,
          cards,
          summary_en: report.summary_en,
          summary_zh: report.summary_zh,
        }, 200);
      }

      if (st === "error") {
        return json({
          scan_id: scanId,
          degraded: true,
          task_status: "error",
          message: JSON.stringify(task?.data || {}),
        }, 200);
      }

      return json({
        scan_id: scanId,
        degraded: true,
        task_status: st || "processing",
      }, 200);
    }

    // POST: create task
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
        summary_en: "Task created. Awaiting analysis output.",
        summary_zh: "任務已建立，等待分析輸出。",
      }, 200);
    }

    return json({ error: "405", message: "GET/POST only" }, 405);
  } catch (err: any) {
    return json({ degraded: true, stage: "exception", message: err?.message || String(err) }, 200);
  }
}
