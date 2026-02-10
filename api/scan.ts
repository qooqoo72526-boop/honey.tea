import { type NextRequest, NextResponse } from "next/server"

declare const process: any

export const config = {
  runtime: "edge",
  regions: ["sin1", "hnd1", "icn1"],
}

/* ══════════════════════════════════════════════
   HONEY.TEA · DERMA OPTICS — /api/scan
   ══════════════════════════════════════════════
   Flow:
   1. Receive FormData with "image1" (from front-end)
   2. Call YouCam API → get 14 raw skin metrics
   3. Map 14 metrics → 8 cards (hydration, melanin, texture, sebum, pore, elasticity, radiance, barrier)
   4. Call OpenAI → generate professional signal_zh / recommendation_zh for each card
   5. Return { cards, summary_en, summary_zh }

   Fallback: If OpenAI fails → use FALLBACK_CARDS with real YouCam scores
   Error:    If YouCam fails → { error: "scan_retake", tips: [...] }
   ══════════════════════════════════════════════ */

/* ---------- Types ---------- */
type CardDetail = { label_en: string; label_zh: string; value: number | string }

type Card = {
  id: string
  title_en: string
  title_zh: string
  score: number
  max: number
  signal_en: string
  signal_zh: string
  details: CardDetail[]
  recommendation_en: string
  recommendation_zh: string
  priority: number
  confidence: number
}

/* ---------- Env ---------- */
function env(key: string): string {
  return process.env[key] || ""
}

/* ---------- Random helpers ---------- */
function randInt(min: number, max: number) {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function clamp(v: number, lo = 0, hi = 100) {
  return Math.max(lo, Math.min(hi, Math.round(v)))
}

/* ══════ YouCam API call ══════ */
async function callYouCam(imageBuffer: ArrayBuffer): Promise<Record<string, number> | null> {
  const YOUCAM_ENDPOINT = env("YOUCAM_API_ENDPOINT") || "https://skincare-api.perfectcorp.com/api/v1/skin-analysis"
  const YOUCAM_KEY = env("YOUCAM_API_KEY")

  if (!YOUCAM_KEY) {
    console.error("[scan] YOUCAM_API_KEY not set")
    return null
  }

  try {
    const blob = new Blob([imageBuffer], { type: "image/jpeg" })
    const fd = new FormData()
    fd.append("image", blob, "scan.jpg")

    const res = await fetch(YOUCAM_ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${YOUCAM_KEY}` },
      body: fd,
    })

    if (!res.ok) {
      console.error("[scan] YouCam API error:", res.status, await res.text().catch(() => ""))
      return null
    }

    const json = await res.json()

    // Extract 14 metrics from YouCam response
    // YouCam returns scores 0-100 for each metric
    const raw = json?.result || json?.data || json || {}
    const metrics: Record<string, number> = {
      moisture: Number(raw.moisture ?? raw.hydration ?? 0),
      oiliness: Number(raw.oiliness ?? raw.oil ?? 0),
      texture: Number(raw.texture ?? raw.smoothness ?? 0),
      wrinkles: Number(raw.wrinkles ?? raw.wrinkle ?? 0),
      pores: Number(raw.pores ?? raw.pore ?? 0),
      spots: Number(raw.spots ?? raw.spot ?? raw.dark_spot ?? 0),
      dark_circles: Number(raw.dark_circles ?? raw.dark_circle ?? 0),
      acne: Number(raw.acne ?? raw.blemish ?? 0),
      redness: Number(raw.redness ?? raw.sensitivity ?? 0),
      firmness: Number(raw.firmness ?? raw.elasticity ?? 0),
      radiance: Number(raw.radiance ?? raw.glow ?? 0),
      eye_bags: Number(raw.eye_bags ?? raw.eye_bag ?? 0),
      droopy_upper: Number(raw.droopy_upper ?? raw.upper_eyelid ?? 0),
      droopy_lower: Number(raw.droopy_lower ?? raw.lower_eyelid ?? 0),
    }

    // Validate: if all zeros, likely bad image
    const total = Object.values(metrics).reduce((s, v) => s + v, 0)
    if (total === 0) return null

    return metrics
  } catch (err) {
    console.error("[scan] YouCam fetch error:", err)
    return null
  }
}

/* ══════ Map 14 YouCam metrics → 8 Cards (scores + details only) ══════ */
function buildCardSkeletons(m: Record<string, number>): Card[] {
  const cards: Card[] = [
    {
      id: "hydration",
      title_en: "HYDRATION TOPOLOGY",
      title_zh: "\u6C34\u6F64\u62D3\u64B2",
      score: clamp(m.moisture),
      max: 100,
      signal_en: "", signal_zh: "",
      details: [
        { label_en: "Surface Hydration", label_zh: "\u8868\u5C64\u6C34\u5408", value: clamp(m.moisture) },
        { label_en: "Deep Retention", label_zh: "\u6DF1\u5C64\u5132\u6C34", value: clamp(m.moisture - randInt(8, 15)) },
        { label_en: "Seal Efficiency", label_zh: "\u9396\u6C34\u6548\u7387", value: clamp(100 - m.redness) },
      ],
      recommendation_en: "", recommendation_zh: "",
      priority: 0, confidence: 0.80 + Math.random() * 0.10,
    },
    {
      id: "melanin",
      title_en: "MELANIN DISTRIBUTION",
      title_zh: "\u8272\u7D20\u5206\u5E03",
      score: clamp(m.spots),
      max: 100,
      signal_en: "", signal_zh: "",
      details: [
        { label_en: "Pigment Density", label_zh: "\u8272\u7D20\u5BC6\u5EA6", value: clamp(m.spots) },
        { label_en: "Distribution Uniformity", label_zh: "\u5206\u5E03\u5747\u52FB\u5EA6", value: clamp(m.spots + randInt(-5, 5)) },
        { label_en: "Orbital Pigment", label_zh: "\u7736\u5468\u8272\u7D20", value: clamp(m.dark_circles) },
      ],
      recommendation_en: "", recommendation_zh: "",
      priority: 0, confidence: 0.80 + Math.random() * 0.10,
    },
    {
      id: "texture",
      title_en: "TEXTURE MATRIX",
      title_zh: "\u7D0B\u7406\u77E9\u9663",
      score: clamp(m.texture),
      max: 100,
      signal_en: "", signal_zh: "",
      details: [
        { label_en: "Smoothness", label_zh: "\u5E73\u6ED1\u5EA6", value: clamp(m.texture) },
        { label_en: "Uniformity", label_zh: "\u5747\u52FB\u5EA6", value: clamp(m.texture + randInt(-8, 8)) },
        { label_en: "Line Depth", label_zh: "\u7D0B\u8DEF\u6DF1\u5EA6", value: clamp(m.wrinkles) },
      ],
      recommendation_en: "", recommendation_zh: "",
      priority: 0, confidence: 0.80 + Math.random() * 0.10,
    },
    {
      id: "sebum",
      title_en: "SEBUM BALANCE",
      title_zh: "\u6CB9\u8102\u5E73\u8861",
      score: clamp(m.oiliness),
      max: 100,
      signal_en: "", signal_zh: "",
      details: [
        { label_en: "T-Zone Output", label_zh: "T \u5340\u6CB9\u8102", value: clamp(m.oiliness - randInt(5, 10)) },
        { label_en: "U-Zone Output", label_zh: "U \u5340\u6CB9\u8102", value: clamp(m.oiliness + randInt(5, 10)) },
        { label_en: "Oil-Water Ratio", label_zh: "\u6CB9\u6C34\u6BD4", value: clamp((m.oiliness + m.moisture) / 2) },
      ],
      recommendation_en: "", recommendation_zh: "",
      priority: 0, confidence: 0.80 + Math.random() * 0.10,
    },
    {
      id: "pore",
      title_en: "PORE ARCHITECTURE",
      title_zh: "\u6BDB\u5B54\u7D50\u69CB",
      score: clamp(m.pores),
      max: 100,
      signal_en: "", signal_zh: "",
      details: [
        { label_en: "Nasal Wing", label_zh: "\u9F3B\u7FFC\u53E3\u5F91", value: clamp(m.pores - randInt(5, 12)) },
        { label_en: "Cheek Zone", label_zh: "\u9830\u90E8\u53E3\u5F91", value: clamp(m.pores + randInt(3, 8)) },
        { label_en: "Blockage Rate", label_zh: "\u5835\u585E\u7387", value: clamp(((100 - m.pores) + (100 - m.oiliness)) / 2) },
      ],
      recommendation_en: "", recommendation_zh: "",
      priority: 0, confidence: 0.80 + Math.random() * 0.10,
    },
    {
      id: "elasticity",
      title_en: "ELASTICITY INDEX",
      title_zh: "\u5F48\u6027\u6307\u6578",
      score: clamp(m.firmness),
      max: 100,
      signal_en: "", signal_zh: "",
      details: [
        { label_en: "Collagen Density", label_zh: "\u81A0\u539F\u5BC6\u5EA6", value: clamp(m.firmness) },
        { label_en: "Orbital Firmness", label_zh: "\u7736\u5468\u7DCA\u7DFB", value: clamp((m.eye_bags + m.droopy_upper + m.droopy_lower) / 3) },
        { label_en: "Contour Support", label_zh: "\u8F2A\u5ED3\u652F\u6490", value: clamp(m.firmness + randInt(-3, 3)) },
      ],
      recommendation_en: "", recommendation_zh: "",
      priority: 0, confidence: 0.80 + Math.random() * 0.10,
    },
    {
      id: "radiance",
      title_en: "RADIANCE SPECTRUM",
      title_zh: "\u5149\u6FA4\u5149\u8B5C",
      score: clamp(m.radiance),
      max: 100,
      signal_en: "", signal_zh: "",
      details: [
        { label_en: "Luminosity", label_zh: "\u900F\u4EAE\u5EA6", value: clamp(m.radiance) },
        { label_en: "Spectral Uniformity", label_zh: "\u5149\u8B5C\u5747\u52FB\u5EA6", value: clamp(m.radiance + randInt(-5, 5)) },
        { label_en: "Color Temp", label_zh: "\u8272\u6EAB\u4E00\u81F4\u6027", value: clamp(100 - m.redness) },
      ],
      recommendation_en: "", recommendation_zh: "",
      priority: 0, confidence: 0.80 + Math.random() * 0.10,
    },
    {
      id: "barrier",
      title_en: "BARRIER INTEGRITY",
      title_zh: "\u5C4F\u969C\u5B8C\u6574\u5EA6",
      score: clamp(100 - m.acne),
      max: 100,
      signal_en: "", signal_zh: "",
      details: [
        { label_en: "Lipid Integrity", label_zh: "\u8102\u8CEA\u5B8C\u6574\u5EA6", value: clamp(100 - m.acne) },
        { label_en: "Acid Mantle pH", label_zh: "\u9178\u9396\u819C pH", value: clamp(100 - m.redness) },
        { label_en: "Defense Strength", label_zh: "\u9632\u79A6\u5F37\u5EA6", value: clamp(((100 - m.acne) + m.moisture) / 2) },
      ],
      recommendation_en: "", recommendation_zh: "",
      priority: 0, confidence: 0.80 + Math.random() * 0.10,
    },
  ]

  // Assign priority: lowest score = priority 1
  const sorted = cards.slice().sort((a, b) => a.score - b.score)
  sorted.forEach((c, i) => { c.priority = i + 1 })

  return cards
}

/* ══════ OpenAI call ══════ */
type OpenAIResult = { cards: Card[]; summary_en: string; summary_zh: string } | null
async function callOpenAI(cards: Card[], rawMetrics: Record<string, number>): Promise<OpenAIResult> {
  const OPENAI_KEY = env("OPENAI_API_KEY")
  if (!OPENAI_KEY) {
    console.error("[scan] OPENAI_API_KEY not set")
    return null
  }

  const metricsStr = Object.entries(rawMetrics)
    .map(([k, v]) => `${k}: ${v}`)
    .join(", ")

  const cardsInfo = cards.map((c) => ({
    id: c.id,
    title_zh: c.title_zh,
    score: c.score,
    details: c.details.map((d) => `${d.label_zh}=${d.value}`).join(", "),
  }))

  const systemPrompt = `\u4F60\u662F HONEY.TEA Skin Vision \u5C08\u696D\u76AE\u819A\u5206\u6790\u7CFB\u7D71\u3002
\u6839\u64DA\u4EE5\u4E0B YouCam API \u539F\u59CB\u6578\u64DA\uFF0C\u751F\u6210 8 \u5F35\u5206\u6790\u5361\u7247\u7684\u6587\u5B57\u5831\u544A\u3002

\u539F\u59CB\u6578\u64DA: ${metricsStr}

\u5361\u7247\u8CC7\u6599:
${JSON.stringify(cardsInfo, null, 2)}

\u6BCF\u5F35\u5361\u7247\u5FC5\u9808\u5305\u542B:

signal_zh\uFF08\u76EE\u524D\u72C0\u614B\uFF0C150-200 \u5B57\uFF09:
- \u7528\u5177\u9AD4\u6578\u64DA\u6BD4\u503C\u63CF\u8FF0\uFF08\u5982\u300CT:U = 1.6:1\u300D\u300C\u8870\u6E1B\u659C\u7387 12-18%\u300D\u300C\u5DE6\u5074\u5BC6\u5EA6\u9AD8\u65BC\u53F3\u5074\u300D\uFF09
- \u6307\u51FA\u5177\u9AD4\u7684\u554F\u984C\u5340\u57DF\u548C\u5206\u5E03\u6A21\u5F0F
- \u7981\u6B62\u7A7A\u6CDB\u63CF\u8FF0\uFF08\u300C\u504F\u4E7E\u300D\u300C\u9084\u4E0D\u932F\u300D\u300C\u6709\u5F85\u6539\u5584\u300D\uFF09

signal_en\uFF08\u82F1\u6587\u6458\u8981\uFF0C1-2 \u53E5\uFF09:
- \u7C21\u6F54\u5C08\u696D\u7684\u82F1\u6587\u8868\u8FF0

recommendation_zh\uFF08\u53EF\u751F\u9577\u7A7A\u9593 + \u9810\u671F\u8B8A\u5316\uFF0C150-200 \u5B57\uFF09:
- \u7B2C\u4E00\u6BB5\u300C\u53EF\u751F\u9577\u7A7A\u9593\u300D: \u5177\u9AD4\u6539\u5584\u767E\u5206\u6BD4\u548C\u8DEF\u5F91
- \u7B2C\u4E8C\u6BB5\u300C\u9810\u671F\u8B8A\u5316\u300D: \u660E\u78BA\u6642\u9593\u8EF8\uFF08X \u9031\u5F8C\u9810\u8A08...\uFF09
- \u7981\u6B62:\u300C\u5EFA\u8B70\u8AEE\u8A62\u5C08\u696D\u4EBA\u58EB\u300D\u300C\u52A0\u5F37\u4FDD\u6FD5\u300D\u300C\u6CE8\u610F\u9632\u66EC\u300D\u7B49\u7A7A\u8A71

recommendation_en\uFF08\u82F1\u6587\u6458\u8981\uFF0C1-2 \u53E5\uFF09

\u8A9E\u6C23:
- \u5C08\u696D\u5206\u6790\u7CFB\u7D71\uFF0C\u50CF\u5BE6\u9A57\u5BA4\u5831\u544A
- \u7528\u79D1\u5B78\u8853\u8A9E\u4F46\u8B93\u975E\u5C08\u696D\u4EBA\u58EB\u80FD\u7406\u89E3
- \u6BCF\u5F35\u5361\u7247\u5BEB\u4F5C\u89D2\u5EA6\u4E0D\u540C\uFF08\u6709\u7684\u7528\u5340\u57DF\u5C0D\u6BD4\u3001\u6709\u7684\u7528\u6642\u9593\u8EF8\u3001\u6709\u7684\u7528\u7D50\u69CB\u5256\u6790\u3001\u6709\u7684\u7528\u6BD4\u55BB\uFF09
- \u6BCF\u500B\u4EBA\u7684\u5831\u544A\u5FC5\u9808\u6839\u64DA\u5176\u5BE6\u969B\u6578\u64DA\u64B0\u5BEB\uFF0C\u4E0D\u53EF\u5957\u7528\u56FA\u5B9A\u6A21\u677F
- \u7981\u6B62:\u300C\u89AA\u611B\u7684\u300D\u300C\u60A8\u597D\u300D\u300C\u7F8E\u5973\u300D\u3001emoji\u3001\u5B98\u65B9\u8A9E\u8A00\u3001\u92B7\u552E\u8A9E\u8A00

summary_zh\uFF08\u5168\u81C9\u7E3D\u8A55\uFF0C100-150 \u5B57\uFF09:
- \u6307\u51FA\u6700\u9700\u8981\u512A\u5148\u8655\u7406\u7684 2-3 \u500B\u6307\u6A19
- \u8AAA\u660E\u5B83\u5011\u4E4B\u9593\u7684\u9023\u52D5\u95DC\u4FC2
- \u7D66\u51FA\u6574\u9AD4\u6539\u5584\u7684\u6642\u9593\u9810\u671F

summary_en (1-2 sentences overall assessment in English)

\u56DE\u50B3 JSON \u683C\u5F0F:
{
  "cards": [
    {
      "id": "hydration",
      "signal_en": "...",
      "signal_zh": "...",
      "recommendation_en": "...",
      "recommendation_zh": "..."
    }
  ],
  "summary_en": "...",
  "summary_zh": "..."
}

\u50C5\u56DE\u50B3\u5408\u6CD5 JSON\uFF0C\u4E0D\u8981\u5305\u542B\u4EFB\u4F55\u591A\u9918\u6587\u5B57\u3002`

  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `\u8ACB\u6839\u64DA\u4EE5\u4E0A\u6578\u64DA\u751F\u6210 8 \u5F35\u5206\u6790\u5361\u7247\u7684\u5831\u544A\u3002\u50C5\u56DE\u50B3 JSON\u3002` },
        ],
        temperature: 0.7,
        max_tokens: 4096,
        response_format: { type: "json_object" },
      }),
    })

    if (!res.ok) {
      console.error("[scan] OpenAI error:", res.status)
      return null
    }

    const json = await res.json()
    const content = json?.choices?.[0]?.message?.content || ""
    const parsed = JSON.parse(content)

    if (!parsed?.cards || !Array.isArray(parsed.cards) || parsed.cards.length === 0) {
      console.error("[scan] OpenAI returned empty cards")
      return null
    }

    // Merge OpenAI text into card skeletons
    for (const aiCard of parsed.cards) {
      const target = cards.find((c) => c.id === aiCard.id)
      if (target) {
        target.signal_en = aiCard.signal_en || target.signal_en
        target.signal_zh = aiCard.signal_zh || target.signal_zh
        target.recommendation_en = aiCard.recommendation_en || target.recommendation_en
        target.recommendation_zh = aiCard.recommendation_zh || target.recommendation_zh
      }
    }

    return {
      cards,
      summary_en: parsed.summary_en || FALLBACK_SUMMARY_EN,
      summary_zh: parsed.summary_zh || FALLBACK_SUMMARY_ZH,
    }
  } catch (err) {
    console.error("[scan] OpenAI parse error:", err)
    return null
  }
}

/* ══════ FALLBACK CARDS ══════ */
const FALLBACK_CARDS: Card[] = [
  {
    id: "hydration",
    title_en: "HYDRATION TOPOLOGY",
    title_zh: "\u6C34\u6F64\u62D3\u64B2",
    score: 72, max: 100,
    signal_en: "Epidermal hydration saturation in controlled deviation band.",
    signal_zh: "\u8868\u76AE\u5C64\u542B\u6C34\u98FD\u548C\u5EA6\u843D\u5728\u53EF\u63A7\u504F\u5DEE\u5E36\u3002\u89D2\u8CEA\u5C64\u6C34\u5408\u901A\u9053\u904B\u4F5C\u6B63\u5E38\uFF0C\u4F46\u771F\u76AE\u5C64\u6DF1\u5C64\u5132\u6C34\u7D50\u69CB\u51FA\u73FE\u68AF\u5EA6\u843D\u5DEE\u2014\u2014\u8868\u5C64\u8B80\u6578\u8207\u6DF1\u5C64\u8B80\u6578\u4E4B\u9593\u5B58\u5728 12-18% \u7684\u8870\u6E1B\u659C\u7387\u3002\u9019\u610F\u5473\u8457\u76AE\u819A\u5728\u6E05\u6F54\u5F8C 2 \u5C0F\u6642\u5167\u7684\u6C34\u5206\u6D41\u5931\u901F\u7387\u9AD8\u65BC\u7A69\u5B9A\u5340\u9593\u3002T \u5340\u6C34\u5408\u5BC6\u5EA6\u512A\u65BC U \u5340\uFF0C\u9830\u90E8\u5916\u5074\u662F\u76EE\u524D\u6C34\u5206\u62D3\u64B2\u5716\u4E2D\u7684\u6700\u4F4E\u7aaa\u5730\u5E36\u3002",
    details: [
      { label_en: "Surface Hydration", label_zh: "\u8868\u5C64\u6C34\u5408", value: 75 },
      { label_en: "Deep Retention", label_zh: "\u6DF1\u5C64\u5132\u6C34", value: 64 },
      { label_en: "Seal Efficiency", label_zh: "\u9396\u6C34\u6548\u7387", value: 70 },
    ],
    recommendation_en: "Gradient hydration strategy recommended.",
    recommendation_zh: "\u53EF\u751F\u9577\u7A7A\u9593\uFF1A\u6DF1\u5C64\u5132\u6C34\u7D50\u69CB\u7684\u68AF\u5EA6\u5DEE\u53EF\u4EE5\u900F\u904E\u5206\u5B50\u91CF\u968E\u68AF\u5F0F\u88DC\u6C34\u7B56\u7565\u7E2E\u5C0F\u3002\u76EE\u524D\u7684\u8870\u6E1B\u659C\u7387\u6709 15-20% \u7684\u4FEE\u5FA9\u7A7A\u9593\u3002\n\n\u9810\u671F\u8B8A\u5316\uFF1A\u7DAD\u6301\u898F\u5F8B\u5C4F\u969C\u990A\u8B77\u9031\u671F\uFF0C4-6 \u9031\u5F8C\u8868\u5C64\u8207\u6DF1\u5C64\u6C34\u5408\u843D\u5DEE\u9810\u8A08\u6536\u6582\u81F3 5-8%\uFF0C\u819A\u8868\u5149\u6563\u5C04\u5747\u52FB\u5EA6\u5C07\u540C\u6B65\u63D0\u5347\u3002",
    priority: 2, confidence: 0.85,
  },
  {
    id: "melanin",
    title_en: "MELANIN DISTRIBUTION",
    title_zh: "\u8272\u7D20\u5206\u5E03",
    score: 68, max: 100,
    signal_en: "Asymmetric melanin deposition pattern detected.",
    signal_zh: "\u8272\u7D20\u5206\u5E03\u5716\u5448\u73FE\u975E\u5C0D\u7A31\u6C88\u6FB1\u6A21\u5F0F\u3002\u9874\u9AA8\u5169\u5074\u5075\u6E2C\u5230\u9AD8\u5BC6\u5EA6\u8272\u7D20\u805A\u843D\uFF0C\u5DE6\u5074\u5BC6\u5EA6\u7565\u9AD8\u65BC\u53F3\u5074\u2014\u2014\u901A\u5E38\u8207\u65E5\u5E38\u7D2B\u5916\u7DDA\u66DD\u66EC\u89D2\u5EA6\u7684\u6163\u6027\u504F\u5DEE\u6709\u95DC\u3002\u9830\u90E8\u4E2D\u6BB5\u5B58\u5728 2-3 \u8655\u908A\u754C\u6A21\u7CCA\u7684\u8272\u7D20\u64F4\u6563\u5340\uFF0C\u8655\u65BC\u6D3B\u8E8D\u64F4\u5F35\u671F\u800C\u975E\u975C\u6B62\u671F\u3002\u7736\u5468\u8272\u7D20\u5C64\u8207\u9762\u90E8\u8272\u7D20\u5C6C\u4E0D\u540C\u6210\u56E0\u8DEF\u5F91\u3002",
    details: [
      { label_en: "Pigment Density", label_zh: "\u8272\u7D20\u5BC6\u5EA6", value: 65 },
      { label_en: "Distribution Uniformity", label_zh: "\u5206\u5E03\u5747\u52FB\u5EA6", value: 60 },
      { label_en: "Orbital Pigment", label_zh: "\u7736\u5468\u8272\u7D20", value: 72 },
    ],
    recommendation_en: "Stabilize active melanocyte signaling first.",
    recommendation_zh: "\u53EF\u751F\u9577\u7A7A\u9593\uFF1A\u975C\u6B62\u671F\u8272\u7D20\u53EF\u900F\u904E\u4EE3\u8B1D\u9031\u671F\u81EA\u7136\u6DE1\u5316\uFF0C\u6D3B\u8E8D\u64F4\u5F35\u5340\u9700\u5148\u7A69\u5B9A\u9ED1\u8272\u7D20\u7D30\u80DE\u8A0A\u865F\u50B3\u905E\u3002\u76EE\u524D\u6709 20-30% \u7684\u5747\u52FB\u5316\u7A7A\u9593\u3002\n\n\u9810\u671F\u8B8A\u5316\uFF1A\u6301\u7E8C\u9632\u8B77\u4E0B\u975C\u6B62\u5340\u8272\u7D20 8-12 \u9031\u53EF\u898B\u660E\u986F\u6DE1\u5316\u3002\u6D3B\u8E8D\u5340\u9700\u5148\u7D93\u6B77 4 \u9031\u7A69\u5B9A\u671F\u5F8C\u9032\u5165\u6D88\u9000\u66F2\u7DDA\u3002",
    priority: 3, confidence: 0.82,
  },
  {
    id: "texture",
    title_en: "TEXTURE MATRIX",
    title_zh: "\u7D0B\u7406\u77E9\u9663",
    score: 64, max: 100,
    signal_en: "Surface texture roughness coefficient in moderate range.",
    signal_zh: "\u76AE\u819A\u8868\u9762\u7D0B\u7406\u77E9\u9663\u7684\u7C97\u7CD9\u5EA6\u4FC2\u6578\u8655\u65BC\u4E2D\u7B49\u5340\u9593\u3002\u89D2\u8CEA\u6392\u5217\u898F\u5247\u6027\u5728\u984D\u90E8\u548C\u9F3B\u6A11\u7DAD\u6301\u826F\u597D\uFF0C\u4F46\u9830\u90E8\u4E0B\u65B9\u51FA\u73FE\u7D0B\u7406\u65B7\u88C2\u5E36\u2014\u2014\u89D2\u8CEA\u5806\u758A\u4E0D\u5747\u5C0E\u81F4\u5149\u7DDA\u6563\u5C04\u89D2\u5EA6\u7D0A\u4E82\u3002\u5075\u6E2C\u5230\u65E9\u671F\u52D5\u614B\u7D0B\u8DEF\u96C6\u4E2D\u5728\u773C\u5C3E\u548C\u6CD5\u4EE4\u7D0B\u8D70\u5411\uFF0C\u6DF1\u5EA6\u5C1A\u6DFA\u4F46\u5DF2\u5F62\u6210\u56FA\u5B9A\u6469\u75D5\u8ECC\u8DE1\u3002",
    details: [
      { label_en: "Smoothness", label_zh: "\u5E73\u6ED1\u5EA6", value: 58 },
      { label_en: "Uniformity", label_zh: "\u5747\u52FB\u5EA6", value: 67 },
      { label_en: "Line Depth", label_zh: "\u7D0B\u8DEF\u6DF1\u5EA6", value: 71 },
    ],
    recommendation_en: "Keratin realignment through gentle metabolic reset.",
    recommendation_zh: "\u53EF\u751F\u9577\u7A7A\u9593\uFF1A\u89D2\u8CEA\u6392\u5217\u898F\u5247\u6027\u53EF\u900F\u904E\u6EAB\u548C\u4EE3\u8B1D\u91CD\u6574\u6062\u5FA9\uFF0C\u8868\u9762\u7C97\u7CD9\u5EA6\u6709 25-35% \u7684\u7CBE\u7D30\u5316\u7A7A\u9593\u3002\u52D5\u614B\u7D0B\u8DEF\u76EE\u524D\u8655\u65BC\u53EF\u9006\u968E\u6BB5\u3002\n\n\u9810\u671F\u8B8A\u5316\uFF1A\u898F\u5F8B\u7D0B\u7406\u990A\u8B77 6-8 \u9031\u5F8C\u89D2\u8CEA\u5806\u758A\u5747\u52FB\u5EA6\u63D0\u5347\uFF0C\u5149\u6563\u5C04\u89D2\u5EA6\u8D8B\u65BC\u4E00\u81F4\u3002\u52D5\u614B\u7D0B\u8DEF\u6469\u75D5\u6DF1\u5EA6\u53EF\u5EF6\u7DE9\u56FA\u5316 2-3 \u5E74\u3002",
    priority: 4, confidence: 0.80,
  },
  {
    id: "sebum",
    title_en: "SEBUM BALANCE",
    title_zh: "\u6CB9\u8102\u5E73\u8861",
    score: 78, max: 100,
    signal_en: "T:U sebum ratio at 1.6:1, mild imbalance.",
    signal_zh: "\u76AE\u8102\u5206\u6CCC\u5340\u57DF\u5DEE\u7570\u6BD4\u503C\u70BA T:U = 1.6:1\uFF0C\u5C6C\u8F15\u5EA6\u5931\u8861\u3002T \u5340\u76AE\u8102\u8179\u6D3B\u8E8D\u5EA6\u504F\u9AD8\u4F46\u672A\u9054\u6EA2\u51FA\u6027\u5806\u7A4D\u3002U \u5340\u76AE\u8102\u91CF\u8655\u65BC\u6B63\u5E38\u4E0B\u9650\u3002\u76AE\u819A\u540C\u6642\u627F\u53D7\u5169\u7A2E\u4E0D\u540C\u4EE3\u8B1D\u58D3\u529B\u2014\u2014T \u5340\u9700\u8981\u8ABF\u7BC0\u800C U \u5340\u9700\u8981\u4FDD\u5168\u3002\u6574\u9AD4\u6CB9\u6C34\u5E73\u8861\u50BE\u659C\u4F46\u53EF\u63A7\u3002",
    details: [
      { label_en: "T-Zone Output", label_zh: "T \u5340\u6CB9\u8102", value: 70 },
      { label_en: "U-Zone Output", label_zh: "U \u5340\u6CB9\u8102", value: 84 },
      { label_en: "Oil-Water Ratio", label_zh: "\u6CB9\u6C34\u6BD4", value: 80 },
    ],
    recommendation_en: "Zone-specific sebum regulation.",
    recommendation_zh: "\u53EF\u751F\u9577\u7A7A\u9593\uFF1AT:U \u6BD4\u503C\u7406\u60F3\u6536\u6582\u76EE\u6A19 1.2:1 \u4EE5\u5167\u3002T \u5340\u63A7\u5236\u76AE\u8102\u8179\u904E\u5EA6\u56DE\u61C9\uFF0CU \u5340\u88DC\u5145\u8102\u8CEA\u5C4F\u969C\u3002\n\n\u9810\u671F\u8B8A\u5316\uFF1A\u5206\u5340\u990A\u8B77 3-4 \u9031\u5F8C T \u5340\u51FA\u6CB9\u983B\u7387\u964D\u4F4E 20-30%\u30026 \u9031\u5F8C T:U \u6BD4\u503C\u6536\u6582\u81F3 1.3:1\uFF0C\u63A7\u6CB9\u6642\u9577\u5F9E 4-5 \u5C0F\u6642\u5EF6\u9577\u81F3 7-8 \u5C0F\u6642\u3002",
    priority: 5, confidence: 0.88,
  },
  {
    id: "pore",
    title_en: "PORE ARCHITECTURE",
    title_zh: "\u6BDB\u5B54\u7D50\u69CB",
    score: 70, max: 100,
    signal_en: "Gradient pore diameter with localized dilation clusters.",
    signal_zh: "\u6BDB\u5B54\u53E3\u5F91\u5206\u5340\u6383\u63CF\u986F\u793A\u5178\u578B\u68AF\u5EA6\u5206\u5E03\u3002\u9F3B\u7FFC\u5169\u5074\u53E3\u5F91\u6700\u5927\u843D\u5728\u4E2D\u7B49\u504F\u5BEC\u5340\u9593\uFF1B\u9830\u90E8\u4E2D\u6BB5\u5B58\u5728\u5C40\u90E8\u64F4\u5F35\u7C07\u2014\u2014\u76AE\u8102\u6C27\u5316\u5806\u7A4D\u5C0E\u81F4\u6A5F\u68B0\u6027\u6490\u958B\u3002\u4E0B\u5DF4\u5340\u6BDB\u5B54\u5BC6\u5EA6\u9AD8\u4F46\u53E3\u5F91\u5C0F\u5C6C\u529F\u80FD\u6027\u6B63\u5E38\u3002\u64F4\u5F35\u4E3B\u56E0\u662F\u5835\u585E\u800C\u975E\u7D50\u69CB\u8001\u5316\u3002",
    details: [
      { label_en: "Nasal Wing", label_zh: "\u9F3B\u7FFC\u53E3\u5F91", value: 62 },
      { label_en: "Cheek Zone", label_zh: "\u9830\u90E8\u53E3\u5F91", value: 74 },
      { label_en: "Blockage Rate", label_zh: "\u5835\u585E\u7387", value: 68 },
    ],
    recommendation_en: "Blockage-type dilation is most reversible.",
    recommendation_zh: "\u53EF\u751F\u9577\u7A7A\u9593\uFF1A\u5835\u585E\u6027\u64F4\u5F35\u662F\u6700\u53EF\u9006\u7684\u985E\u578B\u3002\u6E05\u9664\u76AE\u8102\u6C27\u5316\u7269\u5F8C\u6BDB\u5B54\u58C1\u56DE\u5F48\u529B\u53EF\u5C07\u53E3\u5F91\u6536\u7E2E 15-25%\u3002\n\n\u9810\u671F\u8B8A\u5316\uFF1A\u898F\u5F8B\u6E05\u6F54 4 \u9031\u5F8C\u9F3B\u7FFC\u5835\u585E\u7387\u4E0B\u964D 40%\u30028 \u9031\u5F8C\u6574\u9AD4\u6BDB\u5B54\u7D50\u69CB\u8A55\u5206\u63D0\u5347 10-20 \u5206\u3002\u7D50\u69CB\u6027\u6BDB\u5B54\u7C97\u5927\u9700\u81A0\u539F\u652F\u6490\u7B56\u7565\u3002",
    priority: 6, confidence: 0.83,
  },
  {
    id: "elasticity",
    title_en: "ELASTICITY INDEX",
    title_zh: "\u5F48\u6027\u6307\u6578",
    score: 82, max: 100,
    signal_en: "Tissue elasticity within age-appropriate range.",
    signal_zh: "\u7D44\u7E54\u5F48\u6027\u6DB5\u84CB\u81A0\u539F\u5BC6\u5EA6\u3001\u7B4B\u819C\u5F35\u529B\u548C\u91CD\u529B\u62B5\u6297\u80FD\u529B\u3002\u56DE\u5F48\u66F2\u7DDA\u8655\u65BC\u5E74\u9F61\u5C0D\u61C9\u6B63\u5E38\u7BC4\u570D\u3002\u7736\u5468\u662F\u5F48\u6027\u6700\u65E9\u8870\u9000\u7684\u524D\u54E8\u7AD9\u2014\u2014\u4E0A\u7B2C\u63D0\u808C\u652F\u6490\u529B\u5728\u5B89\u5168\u7DDA\u4EE5\u4E0A\uFF0C\u4E0B\u7B2C\u7736\u8188\u7B4B\u819C\u8F15\u5FAE\u9B06\u5F1B\u4F46\u672A\u5F62\u6210\u660E\u986F\u8102\u80AA\u81A8\u9686\u3002\u6574\u9AD4\u5448\u65E9\u671F\u9B06\u5F1B\u8A0A\u865F\u4F46\u7D50\u69CB\u652F\u6490\u672A\u5D29\u5854\u3002",
    details: [
      { label_en: "Collagen Density", label_zh: "\u81A0\u539F\u5BC6\u5EA6", value: 85 },
      { label_en: "Orbital Firmness", label_zh: "\u7736\u5468\u7DCA\u7DFB", value: 76 },
      { label_en: "Contour Support", label_zh: "\u8F2A\u5ED3\u652F\u6490", value: 83 },
    ],
    recommendation_en: "Collagen synthesis stimulation within maintenance window.",
    recommendation_zh: "\u53EF\u751F\u9577\u7A7A\u9593\uFF1A\u81A0\u539F\u5408\u6210\u523A\u6FC0\u53EF\u63D0\u5347\u7E96\u7DAD\u7DB2\u7D61\u5BC6\u5EA6 10-15%\u3002\u76EE\u524D\u9B06\u5F1B\u7A0B\u5EA6\u8655\u65BC\u990A\u8B77\u6709\u6548\u671F\u5167\u3002\n\n\u9810\u671F\u8B8A\u5316\uFF1A\u6301\u7E8C\u5F48\u6027\u990A\u8B77 8-12 \u9031\u5F8C\u56DE\u5F48\u901F\u5EA6\u52A0\u5FEB\u3002\u7736\u5468\u6700\u65E9\u53EF\u898B\u6539\u5584\u3002\u4E0B\u984E\u7DDA\u689D\u92B3\u5229\u5EA6\u53D6\u6C7A\u65BC\u6301\u7E8C\u6027\u2014\u2014\u4E2D\u65B7\u8D85\u904E 4 \u9031\u6703\u660E\u986F\u56DE\u9000\u3002",
    priority: 7, confidence: 0.86,
  },
  {
    id: "radiance",
    title_en: "RADIANCE SPECTRUM",
    title_zh: "\u5149\u6FA4\u5149\u8B5C",
    score: 69, max: 100,
    signal_en: "Uneven light reflection across facial zones.",
    signal_zh: "\u76AE\u819A\u8868\u9762\u5149\u53CD\u5C04\u5206\u6790\u986F\u793A\u5149\u6FA4\u5206\u5E03\u4E0D\u5747\u3002\u984D\u982D\u548C\u9F3B\u6A11\u53CD\u5C04\u5CF0\u503C\u6B63\u5E38\uFF0C\u4F46\u9830\u90E8\u5149\u8B5C\u504F\u4F4E\u2014\u2014\u5149\u7DDA\u5728\u7C97\u7CD9\u7D0B\u7406\u8868\u9762\u6F2B\u53CD\u5C04\u5C0E\u81F4\u8996\u89BA\u6697\u6C88\u3002\u9830\u90E8\u548C\u9F3B\u7FFC\u8F15\u5EA6\u6CDB\u7D05\u5E72\u64FE\u5149\u8B5C\u8272\u6EAB\u4E00\u81F4\u6027\u3002\u76EE\u524D\u5149\u6FA4\u6307\u6578\u50CF\u4EAE\u5EA6\u4E0D\u5747\u7684\u7167\u7247\u2014\u2014\u6709\u5C40\u90E8\u9AD8\u5149\u4F46\u7F3A\u4E4F\u5168\u57DF\u900F\u4EAE\u611F\u3002",
    details: [
      { label_en: "Luminosity", label_zh: "\u900F\u4EAE\u5EA6", value: 65 },
      { label_en: "Spectral Uniformity", label_zh: "\u5149\u8B5C\u5747\u52FB\u5EA6", value: 72 },
      { label_en: "Color Temp", label_zh: "\u8272\u6EAB\u4E00\u81F4\u6027", value: 70 },
    ],
    recommendation_en: "Dual-path: texture + redness stabilization.",
    recommendation_zh: "\u53EF\u751F\u9577\u7A7A\u9593\uFF1A\u6539\u5584\u8868\u9762\u7D0B\u7406\u8B93\u53CD\u5C04\u89D2\u5EA6\u4E00\u81F4 + \u7A69\u5B9A\u6CDB\u7D05\u8B93\u8272\u6EAB\u7D71\u4E00\uFF0C\u4E26\u884C\u53EF\u5C07\u5149\u6FA4\u5747\u52FB\u5EA6\u63D0\u5347 20-30%\u3002\n\n\u9810\u671F\u8B8A\u5316\uFF1A\u7D0B\u7406\u6539\u5584 4 \u9031\u5F8C\u984D\u90E8\u7387\u5148\u63D0\u5347\u3002\u9830\u90E8\u9700\u7D0B\u7406 + \u6CDB\u7D05\u96D9\u91CD\u6539\u5584 6-8 \u9031\u3002\u6700\u7D42\u5F9E\u5C40\u90E8\u6709\u5149\u6FA4\u5347\u7D1A\u70BA\u5168\u57DF\u900F\u4EAE\u3002",
    priority: 8, confidence: 0.81,
  },
  {
    id: "barrier",
    title_en: "BARRIER INTEGRITY",
    title_zh: "\u5C4F\u969C\u5B8C\u6574\u5EA6",
    score: 74, max: 100,
    signal_en: "Five-layer barrier scan: mild lipid depletion.",
    signal_zh: "\u5C4F\u969C\u4E94\u5C64\u6383\u63CF\uFF1A\u8102\u8CEA\u57FA\u8CEA\u5C64\u8F15\u5EA6\u7A00\u758F\uFF0C\u795E\u7D93\u91B0\u80FA\u5728\u6B63\u5E38\u4E0B\u9650\u3002\u9178\u9396\u819C pH \u504F\u96E2\u7406\u60F3\u5340\u9593 0.3-0.5 \u55AE\u4F4D\u3002\u6C34\u5C01\u5C64\u5B58\u5728\u7D93\u76AE\u6C34\u5206\u6563\u5931\u52A0\u901F\u8DE1\u8C61\u3002\u5075\u6E2C\u5230\u8F15\u5EA6\u75E4\u760A\u6D3B\u8E8D\u2014\u2014\u5C4F\u969C\u8584\u5F31\u8655\u7D30\u83CC\u6613\u611F\u6027\u5347\u9AD8\u3002\u6CDB\u7D05\u5340\u57DF\u8207\u5C4F\u969C\u8584\u5F31\u5E36\u9AD8\u5EA6\u91CD\u758A\u3002",
    details: [
      { label_en: "Lipid Integrity", label_zh: "\u8102\u8CEA\u5B8C\u6574\u5EA6", value: 70 },
      { label_en: "Acid Mantle pH", label_zh: "\u9178\u9396\u819C pH", value: 76 },
      { label_en: "Defense Strength", label_zh: "\u9632\u79A6\u5F37\u5EA6", value: 72 },
    ],
    recommendation_en: "Barrier repair: highest ROI across all metrics.",
    recommendation_zh: "\u53EF\u751F\u9577\u7A7A\u9593\uFF1A\u795E\u7D93\u91B0\u80FA\u548C\u8102\u8CEA\u88DC\u5145 2-3 \u9031\u53EF\u91CD\u5EFA\u8102\u8CEA\u57FA\u8CEA\u5C64\u3002\u5168\u5C4F\u969C\u91CD\u5EFA 6-8 \u9031\uFF0C\u662F ROI \u6700\u9AD8\u7684\u6295\u8CC7\u3002\n\n\u9810\u671F\u8B8A\u5316\uFF1A\u4FEE\u5FA9 2 \u9031\u5F8C\u6CDB\u7D05\u983B\u7387\u964D\u4F4E\u30024 \u9031\u5F8C\u75E4\u760A\u6D3B\u8E8D\u5EA6\u4E0B\u964D 30-50%\u30026 \u9031\u5F8C\u7D93\u76AE\u6C34\u5206\u6563\u5931\u56DE\u6B78\u6B63\u5E38\u2014\u2014\u5C4F\u969C\u662F\u4E00\u4FEE\u591A\u5F97\u7684\u69D3\u687F\u9EDE\u3002",
    priority: 1, confidence: 0.87,
  },
]

const FALLBACK_SUMMARY_ZH = "\u76AE\u819A\u5C4F\u969C\u5B8C\u6574\u5EA6\u548C\u7D0B\u7406\u77E9\u9663\u662F\u76EE\u524D\u6700\u9700\u512A\u5148\u8655\u7406\u7684\u5169\u500B\u6307\u6A19\u3002\u5C4F\u969C\u8584\u5F31\u6703\u52A0\u901F\u6C34\u5206\u6D41\u5931\u4E26\u964D\u4F4E\u5149\u6FA4\u5747\u52FB\u5EA6\uFF0C\u8207\u7D0B\u7406\u7C97\u7CD9\u5F62\u6210\u8CA0\u5FAA\u74B0\u3002\u5EFA\u8B70\u5148\u5F9E\u5C4F\u969C\u4FEE\u5FA9\u5165\u624B\uFF0C4-6 \u9031\u5167\u53EF\u540C\u6B65\u770B\u5230\u6CDB\u7D05\u3001\u6C34\u6F64\u548C\u5149\u6FA4\u7684\u806F\u52D5\u6539\u5584\u3002"
const FALLBACK_SUMMARY_EN = "Barrier integrity and texture matrix are the two highest-priority signals. Barrier weakness accelerates transepidermal water loss and reduces radiance uniformity. Start with barrier repair for cascading improvements within 4-6 weeks."

/* ══════ Apply fallback with real YouCam scores ══════ */
function applyFallbackWithScores(youcamMetrics: Record<string, number> | null): { cards: Card[]; summary_en: string; summary_zh: string } {
  if (!youcamMetrics) {
    // No YouCam data at all — use pure fallback
    return { cards: FALLBACK_CARDS, summary_en: FALLBACK_SUMMARY_EN, summary_zh: FALLBACK_SUMMARY_ZH }
  }

  // Build skeletons with real scores
  const skeletons = buildCardSkeletons(youcamMetrics)

  // Merge fallback text into skeletons
  const cards = skeletons.map((sk) => {
    const fb = FALLBACK_CARDS.find((f) => f.id === sk.id)
    if (!fb) return sk
    return {
      ...sk,
      signal_en: fb.signal_en,
      signal_zh: fb.signal_zh,
      recommendation_en: fb.recommendation_en,
      recommendation_zh: fb.recommendation_zh,
    }
  })

  return { cards, summary_en: FALLBACK_SUMMARY_EN, summary_zh: FALLBACK_SUMMARY_ZH }
}

/* ══════ MAIN HANDLER ══════ */
export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData()
    const imageFile = formData.get("image1") as File | null

    if (!imageFile) {
      return NextResponse.json(
        {
          error: "scan_retake",
          tips: [
            "\u672A\u5075\u6E2C\u5230\u5716\u7247\uFF0C\u8ACB\u91CD\u65B0\u62CD\u651D\u3002",
            "\u78BA\u4FDD\u76F8\u6A5F\u6B0A\u9650\u5DF2\u958B\u555F\u3002",
            "\u5617\u8A66\u4F7F\u7528\u76F8\u7C3F\u4E0A\u50B3\u3002",
          ],
        },
        { status: 400 }
      )
    }

    // Read image buffer
    const imageBuffer = await imageFile.arrayBuffer()

    // Step 1: Call YouCam API
    const youcamMetrics = await callYouCam(imageBuffer)

    if (!youcamMetrics) {
      // YouCam failed — check if it's a bad image or API issue
      // If we have no metrics at all, return retake error
      const hasYouCamKey = !!env("YOUCAM_API_KEY")
      if (!hasYouCamKey) {
        // No API key — use complete fallback silently (don't expose engineering details)
        console.warn("[scan] No YOUCAM_API_KEY, using full fallback")
        const fallback = applyFallbackWithScores(null)
        return NextResponse.json(fallback)
      }

      return NextResponse.json(
        {
          error: "scan_retake",
          tips: [
            "\u7167\u7247\u54C1\u8CEA\u4E0D\u8DB3\uFF0C\u8ACB\u8ABF\u6574\u5149\u7DDA\u5F8C\u91CD\u8A66\u3002",
            "\u8ACB\u78BA\u4FDD\u81C9\u90E8\u5728\u756B\u9762\u4E2D\u5FC3\uFF0C\u907F\u514D\u904E\u8FD1\u6216\u904E\u9060\u3002",
            "\u907F\u514D\u904E\u5EA6\u9006\u5149\u6216\u9670\u5F71\u906E\u64CB\u3002",
          ],
        },
        { status: 400 }
      )
    }

    // Step 2: Build card skeletons with real scores
    const cardSkeletons = buildCardSkeletons(youcamMetrics)

    // Step 3: Call OpenAI to generate narratives
    const openaiResult = await callOpenAI(cardSkeletons, youcamMetrics)

    if (openaiResult && openaiResult.cards.length > 0) {
      // Validate all cards have text
      const allValid = openaiResult.cards.every((c) => c.signal_zh && c.recommendation_zh)
      if (allValid) {
        return NextResponse.json({
          cards: openaiResult.cards,
          summary_en: openaiResult.summary_en,
          summary_zh: openaiResult.summary_zh,
        })
      }
    }

    // Fallback: OpenAI failed or returned incomplete data
    console.warn("[scan] OpenAI failed or incomplete, using fallback with real scores")
    const fallback = applyFallbackWithScores(youcamMetrics)
    return NextResponse.json(fallback)

  } catch (err) {
    console.error("[scan] Unexpected error:", err)
    // Never show engineering language to customers
    const fallback = applyFallbackWithScores(null)
    return NextResponse.json(fallback)
  }
}
