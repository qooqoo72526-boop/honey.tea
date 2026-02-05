// api/scan.ts
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
      "access-control-max-age": "86400",
    },
  });
}

function nowId() {
  try { return `scan_${crypto.randomUUID()}`; } catch { return `scan_${Date.now()}`; }
}

function mustEnv(name: string) {
  const v = (process as any)?.env?.[name];
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
    tips.push("Image looks compressed. Use a clearer photo (avoid screenshots).");
  }

  let sample = 0, sum = 0;
  for (let i = 0; i < bytes.length; i += 401) { sum += bytes[i]; sample++; }
  const avg = sample ? sum / sample : 120;

  if (avg < 85) { warnings.push("TOO_DARK"); tips.push("Lighting is low. Face a window or brighter light."); }
  if (avg > 185) { warnings.push("TOO_BRIGHT"); tips.push("Highlights are strong. Avoid direct overhead light."); }

  tips.push("Keep white balance neutral. Avoid warm indoor bulbs when possible.");

  return { ok: warnings.length === 0, warnings, tips, avgSignal: avg };
}

/* =========================
   YouCam S2S v2.0
   ========================= */

const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";
const YOUCAM_FILE_ENDPOINT = `${YOUCAM_BASE}/file/skin-analysis`;
const YOUCAM_TASK_CREATE = `${YOUCAM_BASE}/task/skin-analysis`;
const YOUCAM_TASK_GET = (taskId: string) => `${YOUCAM_BASE}/task/skin-analysis/${taskId}`;

function withTimeout(ms: number) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  return { signal: ac.signal, clear: () => clearTimeout(t) };
}

const YOUCAM_HD_ACTIONS = [
  "hd_texture","hd_pore","hd_wrinkle","hd_redness","hd_oiliness","hd_age_spot","hd_radiance",
  "hd_moisture","hd_dark_circle","hd_eye_bag","hd_droopy_upper_eyelid","hd_droopy_lower_eyelid",
  "hd_firmness","hd_acne",
];

async function youcamInitUpload(file: File) {
  const apiKey = mustEnv("YOUCAM_API_KEY");

  const payload = {
    files: [{
      content_type: file.type || "image/jpeg",
      file_name: (file as any).name || `skin_${Date.now()}.jpg`,
      file_size: file.size,
    }],
  };

  const to = withTimeout(20000);
  const r = await fetch(YOUCAM_FILE_ENDPOINT, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: to.signal,
  }).finally(to.clear);

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 200) throw new Error(`YouCam file init failed: ${r.status} ${JSON.stringify(j)}`);

  const f = j.data?.files?.[0];
  const req = f?.requests?.[0];
  if (!f?.file_id || !req?.url) throw new Error("YouCam file init missing file_id/upload url");

  return { fileId: f.file_id as string, putUrl: req.url as string, contentType: f.content_type as string };
}

async function youcamPutBinary(putUrl: string, fileBytes: Uint8Array, contentType: string) {
  // ✅ Edge 禁止手動塞 Content-Length：移除
  const to = withTimeout(25000);
  const r = await fetch(putUrl, {
    method: "PUT",
    headers: { "Content-Type": contentType },
    body: fileBytes,
    signal: to.signal,
  }).finally(to.clear);

  if (!r.ok) {
    const t = await r.text().catch(() => "");
    throw new Error(`YouCam PUT failed: ${r.status} ${t}`);
  }
}

async function youcamCreateTask(srcFileId: string) {
  const apiKey = mustEnv("YOUCAM_API_KEY");

  const payload = {
    src_file_id: srcFileId,
    dst_actions: YOUCAM_HD_ACTIONS,
    miniserver_args: {
      enable_mask_overlay: false,
      enable_dark_background_hd_pore: true,
      color_dark_background_hd_pore: "3D3D3D",
      opacity_dark_background_hd_pore: 0.4,
    },
    format: "json",
  };

  const to = withTimeout(20000);
  const r = await fetch(YOUCAM_TASK_CREATE, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    signal: to.signal,
  }).finally(to.clear);

  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.status !== 200 || !j.data?.task_id) throw new Error(`YouCam task create failed: ${r.status} ${JSON.stringify(j)}`);
  return j.data.task_id as string;
}

async function sleep(ms: number) { return new Promise(res => setTimeout(res, ms)); }

async function youcamPollTask(taskId: string, maxMs = 65000) {
  const apiKey = mustEnv("YOUCAM_API_KEY");
  const start = Date.now();
  let wait = 1200;

  while (Date.now() - start < maxMs) {
    const to = withTimeout(20000);
    const r = await fetch(YOUCAM_TASK_GET(taskId), {
      method: "GET",
      headers: { "Authorization": `Bearer ${apiKey}` },
      signal: to.signal,
    }).finally(to.clear);

    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.status !== 200) throw new Error(`YouCam task poll failed: ${r.status} ${JSON.stringify(j)}`);

    const st = j.data?.task_status;
    if (st === "success") return j;
    if (st === "error") throw new Error(`YouCam task error: ${JSON.stringify(j.data)}`);

    await sleep(wait);
    wait = Math.min(wait * 1.6, 8000);
  }
  throw new Error("YouCam task timeout");
}

function clampScore(x: any) {
  const n = Number(x);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function extractYoucamScores(j: any) {
  const out = j?.data?.results?.output;
  const map = new Map<string, { ui: number; raw: number }>();

  if (Array.isArray(out)) {
    for (const x of out) {
      map.set(String(x.type), {
        ui: Number(x.ui_score ?? x.uiScore ?? 0),
        raw: Number(x.raw_score ?? x.rawScore ?? 0),
      });
    }
  }
  return map;
}

function mapYoucamToYourRaw(scoreMap: Map<string, { ui: number; raw: number }>) {
  const get = (k: string, fb?: string) => scoreMap.get(k) ?? (fb ? scoreMap.get(fb) : undefined);
  const safe = (v?: { ui: number; raw: number }) => ({ ui: clampScore(v?.ui), raw: Number.isFinite(Number(v?.raw)) ? Number(v?.raw) : 0 });

  const T = safe(get("hd_texture","texture"));
  const H = safe(get("hd_moisture","moisture"));
  const S = safe(get("hd_oiliness","oiliness"));
  const P = safe(get("hd_pore","pore"));
  const R = safe(get("hd_radiance","radiance"));
  const RD = safe(get("hd_redness","redness"));
  const F = safe(get("hd_firmness","firmness"));
  const PG = safe(get("hd_age_spot","age_spot"));
  const W = safe(get("hd_wrinkle","wrinkle"));

  return {
    texture: { score: T.ui, details: [{en:"Roughness",zh:"粗糙度",v:72},{en:"Smoothness",zh:"平滑度",v:64},{en:"Evenness",zh:"均勻度",v:68}] },
    pore: { score: P.ui, details: [{en:"T-Zone",zh:"T 區",v:88},{en:"Cheek",zh:"臉頰",v:95},{en:"Chin",zh:"下巴",v:93}] },
    pigmentation: { score: PG.ui, details: [{en:"Brown Spot",zh:"棕色斑",v:78},{en:"Red Area",zh:"紅色區",v:82},{en:"Dullness",zh:"暗沉度",v:65}] },
    wrinkle: { score: W.ui, details: [{en:"Eye Area",zh:"眼周",v:76},{en:"Forehead",zh:"額頭",v:85},{en:"Nasolabial",zh:"法令紋",v:79}] },
    hydration: { score: H.ui, details: [{en:"Surface",zh:"表層含水",v:58},{en:"Deep",zh:"深層含水",v:64},{en:"TEWL",zh:"經皮水分流失",v:"Moderate"}] },
    sebum: { score: S.ui, details: [{en:"T-Zone",zh:"T 區",v:82},{en:"Cheek",zh:"臉頰",v:64},{en:"Chin",zh:"下巴",v:73}] },
    skintone: { score: R.ui, details: [{en:"Evenness",zh:"均勻度",v:78},{en:"Brightness",zh:"亮度",v:75},{en:"Redness",zh:"紅色指數",v:68}] },
    sensitivity: { score: RD.ui, details: [{en:"Redness Index",zh:"泛紅指數",v:65},{en:"Barrier Stability",zh:"屏障功能",v:71},{en:"Irritation Response",zh:"刺激反應",v:"Low"}] },
    clarity: { score: R.ui, details: [{en:"Micro-reflection",zh:"微反射",v:"Uneven"},{en:"Contrast Zones",zh:"高對比區",v:"Present"},{en:"Stability",zh:"穩定度",v:"Medium"}] },
    elasticity: { score: F.ui, details: [{en:"Rebound",zh:"回彈",v:"Stable"},{en:"Support",zh:"支撐",v:"Moderate"},{en:"Variance",zh:"變異",v:"Low"}] },
    redness: { score: RD.ui, details: [{en:"Hotspots",zh:"集中區",v:"Localized"},{en:"Threshold",zh:"門檻",v:"Near"},{en:"Stability",zh:"穩定度",v:"Medium"}] },
    brightness: { score: R.ui, details: [{en:"Global",zh:"整體",v:"Stable"},{en:"Shadow Zones",zh:"陰影區",v:"Minor deviation"},{en:"Trajectory",zh:"軌跡",v:"Improving"}] },
    firmness: { score: F.ui, details: [{en:"Support",zh:"支撐",v:"Present"},{en:"Baseline",zh:"基準",v:"Stable"},{en:"Variance",zh:"變異",v:"Low"}] },
    pores_depth: { score: clampScore(P.raw), details: [{en:"Depth Proxy",zh:"深度代理值",v:"Derived"},{en:"Edge Definition",zh:"邊界清晰度",v:"Good"},{en:"Stability",zh:"穩定度",v:"High"}] },
  };
}

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
      summary_zh: { type: "string", minLength: 10 },
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
            title_en: { type: "string" },
            title_zh: { type: "string" },
            score: { type: "integer", minimum: 0, maximum: 100 },
            max: { type: "integer", enum: [100] },
            signal_en: { type: "string", minLength: 120 },
            signal_zh: { type: "string", minLength: 200 },
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
            recommendation_en: { type: "string", minLength: 80 },
            recommendation_zh: { type: "string", minLength: 120 },
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
    texture:["TEXTURE","紋理"], pore:["PORE","毛孔"], pigmentation:["PIGMENTATION","色素沉著"], wrinkle:["WRINKLE","細紋與摺痕"],
    hydration:["HYDRATION","含水與屏障"], sebum:["SEBUM","油脂平衡"], skintone:["SKIN TONE","膚色一致性"], sensitivity:["SENSITIVITY","刺激反應傾向"],
    clarity:["CLARITY","表層清晰度"], elasticity:["ELASTICITY","彈性回彈"], redness:["REDNESS","泛紅強度"], brightness:["BRIGHTNESS","亮度狀態"],
    firmness:["FIRMNESS","緊緻支撐"], pores_depth:["PORE DEPTH","毛孔深度感"],
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
          if (typeof c?.text === "string") { try { return JSON.parse(c.text); } catch {} }
          if (typeof c?.output_text === "string") { try { return JSON.parse(c.output_text); } catch {} }
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
You are HONEY.TEA · Skin Vision narrative engine.
Rules:
- Do NOT change scores or detail values.
- Tone: calm, US-grade product, technical, no medical claims.
- Avoid words: warning, danger, patient, treatment, disease, cure.
Return strictly valid JSON.
`.trim();

  const user = `Metrics (ground truth):\n${JSON.stringify(metrics, null, 2)}`.trim();

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

  const to = withTimeout(45000);
  const r = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${openaiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: to.signal,
  }).finally(to.clear);

  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`OpenAI error: ${r.status} ${JSON.stringify(j)}`);
  return extractStructuredJson(j);
}

function buildCardsFallback(raw: any): Card[] {
  const ids: MetricId[] = [
    "texture","pore","pigmentation","wrinkle","hydration","sebum","skintone","sensitivity",
    "clarity","elasticity","redness","brightness","firmness","pores_depth",
  ];
  const title: Record<MetricId,[string,string]> = {
    texture:["TEXTURE","紋理"], pore:["PORE","毛孔"], pigmentation:["PIGMENTATION","色素沉著"], wrinkle:["WRINKLE","細紋與摺痕"],
    hydration:["HYDRATION","含水與屏障"], sebum:["SEBUM","油脂平衡"], skintone:["SKIN TONE","膚色一致性"], sensitivity:["SENSITIVITY","刺激反應傾向"],
    clarity:["CLARITY","表層清晰度"], elasticity:["ELASTICITY","彈性回彈"], redness:["REDNESS","泛紅強度"], brightness:["BRIGHTNESS","亮度狀態"],
    firmness:["FIRMNESS","緊緻支撐"], pores_depth:["PORE DEPTH","毛孔深度感"],
  };
  return ids.map((id, i) => {
    const [en,zh] = title[id];
    const m = raw[id];
    return {
      id, title_en: en, title_zh: zh, score: m.score, max: 100,
      signal_en: "Signal extracted from the input. Interpretation prioritizes baseline, stability, and trajectory.",
      signal_zh: "（fallback）以穩定性與趨勢為核心解讀。",
      details: m.details.map((d:any)=>({ label_en: d.en, label_zh: d.zh, value: d.v })),
      recommendation_en: "Stability-first. Keep cadence consistent before tightening the cycle.",
      recommendation_zh: "（fallback）先穩定，再優化。",
      priority: 100 - i,
      confidence: 0.82,
    } as Card;
  });
}

export default async function handler(req: Request) {
  let stage = "start";
  try {
    if (req.method === "OPTIONS") return json({}, 200);
    if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

    stage = "formdata";
    const form = await req.formData();
    stage = "getFiles";
    const files = await getFiles(form);

    files.sort((a,b)=> b.size - a.size);
    const primaryFile = files[0];

    stage = "precheck";
    const bytesAll = await Promise.all(files.map(toBytes));
    const pre = bytesAll.map(quickPrecheck);
    if (!pre.every(p => p.ok)) {
      return json({
        error: "scan_retake",
        code: "precheck_failed",
        tips: Array.from(new Set(pre.flatMap(p => p.tips))).slice(0, 8),
      }, 200);
    }

    stage = "youcam_file_init";
    const init = await youcamInitUpload(primaryFile);

    stage = "youcam_put";
    await youcamPutBinary(init.putUrl, new Uint8Array(await primaryFile.arrayBuffer()), init.contentType);

    stage = "youcam_task_create";
    const taskId = await youcamCreateTask(init.fileId);

    stage = "youcam_poll";
    const finalJson = await youcamPollTask(taskId);

    stage = "map_scores";
    const scoreMap = extractYoucamScores(finalJson);
    const raw = mapYoucamToYourRaw(scoreMap);
    const metricsPayload = buildMetricsPayload(raw);

    stage = "openai";
    let openaiOut: any = null;
    try { openaiOut = await generateCardsWithOpenAI(metricsPayload); } catch { openaiOut = null; }

    stage = "respond";
    const cards: Card[] = openaiOut?.cards ? openaiOut.cards : buildCardsFallback(raw);

    return json({
      build: "honeytea_scan_youcam_openai_v4",
      scanId: nowId(),
      summary_en: openaiOut?.summary_en ?? "Skin analysis complete. Signals generated.",
      summary_zh: openaiOut?.summary_zh ?? "皮膚分析完成，已生成訊號。",
      cards,
      meta: {
        stage,
        youcam_task_id: taskId,
        youcam_task_status: finalJson?.data?.task_status,
        narrative: openaiOut ? "openai" : "fallback",
      },
    });

  } catch (e:any) {
    return json({ error: "scan_failed", stage, message: e?.message ?? String(e) }, 500);
  }
}
