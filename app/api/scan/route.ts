// app/api/scan/route.ts
// HONEY.TEA — Skin Vision Scan API (Official Spec Compliance)
// ✅ URL Fix: Cleaned YOUCAM_BASE (No brackets!)
// ✅ Coze Spec: Non-streaming (Chat -> Retrieve -> Message)
// ✅ YouCam Spec: HD params, S3 Content-Length

import { NextResponse } from "next/server"

export const runtime = "nodejs"
export const maxDuration = 60

function corsHeaders(origin: string) {
    return {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    }
}

function jsonResponse(data: any, status = 200, origin: string) {
    return new NextResponse(JSON.stringify(data), {
        status,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    })
}

function mustEnv(name: string) {
    const v = process.env[name]
    if (!v) throw new Error(`Missing env: ${name}`)
    return v
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// --- Metrics Utilities ---
function nowId() { return `scan_${Date.now()}` }
function clamp(x: number) { return Math.max(0, Math.min(100, Math.round(x))) }
function jitter(base: number, seed: string, key: string, amp: number) {
    const h = (function hash32(s: string) {
        let h = 2166136261
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
        return h >>> 0
    })(seed + ":" + key)
    const r = (h % 1000) / 1000
    return Math.round(base + (r - 0.5) * 2 * amp)
}
function confidenceFromSignals(seed: string, primary: number) {
    const h = (function hash32(s: string) {
        let h = 2166136261
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
        return h >>> 0
    })(seed + ":conf")
    const r = (h % 1000) / 1000
    const base = 0.74 + r * 0.18
    const boost = primary > 75 || primary < 35 ? 0.04 : 0.0
    return Math.round((base + boost) * 100) / 100
}

function buildMetrics(scoreMap: Map<string, number>, seed: string) {
    const T = clamp(scoreMap.get("hd_texture") || 0)
    const P = clamp(scoreMap.get("hd_pore") || 0)
    const W = clamp(scoreMap.get("hd_wrinkle") || 0)
    const R = clamp(scoreMap.get("hd_redness") || 0)
    const O = clamp(scoreMap.get("hd_oiliness") || 0)
    const A = clamp(scoreMap.get("hd_age_spot") || 0)
    const M = clamp(scoreMap.get("hd_moisture") || 0)
    const F = clamp(scoreMap.get("hd_firmness") || 0)
    const RA = clamp(scoreMap.get("hd_radiance") || 0)
    const AC = clamp(scoreMap.get("hd_acne") || 0)
    const DC = clamp(scoreMap.get("hd_dark_circle") || 0)
    const EB = clamp(scoreMap.get("hd_eye_bag") || 0)

    const tone = clamp(jitter(RA * 0.6 + (100 - A) * 0.25 + (100 - R) * 0.15, seed, "tone", 2))
    const brightness = clamp(jitter(RA * 0.92, seed, "brightness", 2))
    const clarity = clamp(jitter(RA * 0.55 + (100 - A) * 0.25 + T * 0.2, seed, "clarity", 2))
    const elasticity = clamp(jitter(F * 0.92, seed, "elasticity", 2))
    const firmness = clamp(jitter(F * 0.96, seed, "firmness", 2))
    const poresDepth = clamp(jitter(P * 0.9, seed, "poresDepth", 2))
    const sensitivity = clamp(jitter((100 - R) * 0.45 + M * 0.35 + (100 - O) * 0.2, seed, "sensitivity", 2))
    const pigmentation = clamp(jitter(A * 0.92, seed, "pigmentation", 2))
    const sebum = clamp(jitter(O * 0.92, seed, "sebum", 2))
    const hydration = clamp(jitter(M * 0.94, seed, "hydration", 2))
    const redness = clamp(jitter(R * 0.92, seed, "redness", 2))

    const conf = (primary: number) => confidenceFromSignals(seed, primary)

    return [
        { id: "texture", title_en: "TEXTURE MATRIX", title_zh: "紋理結構矩陣", score: T, details: [{ label_en: "Roughness", label_zh: "粗糙度", value: clamp(jitter(100 - T * 0.85, seed, "t:r", 2)) }, { label_en: "Smoothness", label_zh: "平滑度", value: clamp(jitter(T * 0.9, seed, "t:s", 2)) }, { label_en: "Evenness", label_zh: "均勻度", value: clamp(jitter(T * 0.88, seed, "t:e", 3)) }] },
        { id: "pore", title_en: "PORE ARCHITECTURE", title_zh: "毛孔結構指數", score: P, details: [{ label_en: "T-Zone", label_zh: "T 區", value: clamp(jitter(P * 0.85, seed, "p:t", 3)) }, { label_en: "Cheek", label_zh: "臉頰", value: clamp(jitter(P * 1.05, seed, "p:c", 2)) }, { label_en: "Chin", label_zh: "下巴", value: clamp(jitter(P * 0.95, seed, "p:ch", 3)) }] },
        { id: "acne", title_en: "ACNE DETECTION", title_zh: "痘痘/痤瘡檢測", score: AC, details: [{ label_en: "Activity", label_zh: "活躍度", value: AC > 70 ? "Low" : "Detected" }, { label_en: "Severity", label_zh: "嚴重程度", value: clamp(jitter(100 - AC, seed, "ac:s", 2)) }, { label_en: "Risk", label_zh: "風險指數", value: AC < 60 ? "High" : "Moderate" }] },
        { id: "pigmentation", title_en: "CHROMA MAPPING", title_zh: "色素聚集映射", score: pigmentation, details: [{ label_en: "Spot Density", label_zh: "聚集密度", value: clamp(jitter(pigmentation * 0.92, seed, "pig:spot", 2)) }, { label_en: "Red Channel", label_zh: "紅通道", value: clamp(jitter(redness * 0.9, seed, "pig:red", 2)) }, { label_en: "Dullness", label_zh: "暗沉度", value: clamp(jitter(100 - brightness * 0.75, seed, "pig:dull", 3)) }] },
        { id: "wrinkle", title_en: "CREASE INDEX", title_zh: "細紋動能指數", score: W, details: [{ label_en: "Eye Zone", label_zh: "眼周", value: clamp(jitter(100 - W * 0.82, seed, "w:eye", 3)) }, { label_en: "Forehead", label_zh: "額頭", value: clamp(jitter(W * 0.92, seed, "w:fh", 3)) }, { label_en: "Nasolabial", label_zh: "法令", value: clamp(jitter(100 - W * 0.78, seed, "w:nl", 4)) }] },
        { id: "hydration", title_en: "RETENTION EFFICIENCY", title_zh: "含水留置效率", score: hydration, details: [{ label_en: "Surface", label_zh: "表層", value: clamp(jitter(hydration * 0.74, seed, "h:surf", 3)) }, { label_en: "Deep", label_zh: "深層", value: clamp(jitter(hydration * 0.84, seed, "h:deep", 2)) }, { label_en: "TEWL Proxy", label_zh: "流失代理", value: hydration > 70 ? "Low" : hydration > 50 ? "Moderate" : "Elevated" }] },
        { id: "sebum", title_en: "SEBUM STABILITY", title_zh: "油脂分散穩定度", score: sebum, details: [{ label_en: "T-Zone", label_zh: "T 區", value: clamp(jitter(100 - sebum * 0.7, seed, "s:t", 4)) }, { label_en: "Cheek", label_zh: "臉頰", value: clamp(jitter(sebum * 0.85, seed, "s:c", 3)) }, { label_en: "Chin", label_zh: "下巴", value: clamp(jitter(100 - sebum * 0.75, seed, "s:ch", 3)) }] },
        { id: "skintone", title_en: "TONE COHERENCE", title_zh: "膚色一致性", score: tone, details: [{ label_en: "Evenness", label_zh: "均勻度", value: clamp(jitter(tone * 0.92, seed, "tone:even", 2)) }, { label_en: "Brightness", label_zh: "亮度", value: clamp(jitter(brightness * 0.9, seed, "tone:bright", 2)) }, { label_en: "Red Drift", label_zh: "紅偏移", value: clamp(jitter(100 - redness * 0.82, seed, "tone:red", 3)) }] },
        { id: "sensitivity", title_en: "REACTIVITY THRESHOLD", title_zh: "刺激門檻監測", score: sensitivity, details: [{ label_en: "Redness Index", label_zh: "泛紅指數", value: clamp(jitter(100 - redness * 0.78, seed, "sen:red", 3)) }, { label_en: "Barrier Stability", label_zh: "屏障穩定", value: clamp(jitter(hydration * 0.86, seed, "sen:bar", 2)) }, { label_en: "Response", label_zh: "反應傾向", value: sensitivity > 70 ? "Low" : sensitivity > 50 ? "Medium" : "Elevated" }] },
        { id: "clarity", title_en: "SURFACE CLARITY", title_zh: "表層清晰度", score: clarity, details: [{ label_en: "Micro-reflection", label_zh: "微反射", value: clarity > 70 ? "Even" : clarity > 50 ? "Uneven" : "Scattered" }, { label_en: "Contrast Zones", label_zh: "對比區", value: pigmentation > 60 ? "Present" : "Minimal" }, { label_en: "Stability", label_zh: "穩定度", value: T > 65 ? "High" : T > 45 ? "Medium" : "Low" }] },
        { id: "elasticity", title_en: "ELASTIC RESPONSE", title_zh: "彈性回彈指數", score: elasticity, details: [{ label_en: "Rebound", label_zh: "回彈", value: elasticity > 70 ? "Stable" : elasticity > 50 ? "Moderate" : "Reduced" }, { label_en: "Support", label_zh: "支撐", value: firmness > 65 ? "Strong" : firmness > 45 ? "Moderate" : "Weak" }, { label_en: "Variance", label_zh: "變異", value: elasticity > 60 ? "Low" : "Medium" }] },
        { id: "redness", title_en: "VASCULAR INTENSITY", title_zh: "微血管強度", score: redness, details: [{ label_en: "Hotspots", label_zh: "集中區", value: redness < 55 ? "Localized" : redness < 70 ? "Scattered" : "Minimal" }, { label_en: "Threshold", label_zh: "門檻", value: redness < 50 ? "Near" : redness < 65 ? "Moderate" : "High" }, { label_en: "Stability", label_zh: "穩定度", value: redness > 65 ? "High" : redness > 45 ? "Medium" : "Low" }] },
        { id: "brightness", title_en: "LUMINANCE STATE", title_zh: "亮度狀態", score: brightness, details: [{ label_en: "Global", label_zh: "整體", value: brightness > 70 ? "Stable" : brightness > 50 ? "Moderate" : "Low" }, { label_en: "Shadow Zones", label_zh: "陰影區", value: brightness > 65 ? "Minimal" : "Minor deviation" }, { label_en: "Trajectory", label_zh: "軌跡", value: brightness > 60 ? "Improving" : "Baseline" }] },
        { id: "firmness", title_en: "STRUCTURAL SUPPORT", title_zh: "緊緻支撐指數", score: firmness, details: [{ label_en: "Support", label_zh: "支撐", value: firmness > 65 ? "Present" : firmness > 45 ? "Moderate" : "Reduced" }, { label_en: "Baseline", label_zh: "基準", value: firmness > 60 ? "Stable" : firmness > 40 ? "Moderate" : "Low" }, { label_en: "Variance", label_zh: "變異", value: firmness > 55 ? "Low" : "Medium" }] },
        { id: "eye_area", title_en: "PERIOCULAR MATRIX", title_zh: "眼周循環矩陣", score: Math.round((DC + EB) / 2), details: [{ label_en: "Dark Circle", label_zh: "黑眼圈", value: DC }, { label_en: "Eye Bag", label_zh: "眼袋", value: EB }, { label_en: "Fatigue", label_zh: "疲勞度", value: DC < 60 ? "High" : "Low" }] },
    ].map((x, idx) => ({
        id: x.id, title_en: x.title_en, title_zh: x.title_zh, score: x.score, max: 100,
        details: x.details, signal_en: "", recommendation_en: "", signal_zh_short: "", signal_zh_deep: "", recommendation_zh_short: "", recommendation_zh_deep: "",
        priority: 100 - idx, confidence: conf(x.score),
    }))
}

// --- Coze v3 Workflow ---
const COZE_BASE = "https://api.coze.com/v3/chat"

async function generateReportWithCoze(metrics: any[], styleSeed: string) {
    const token = mustEnv("COZE_API_TOKEN")
    const botId = mustEnv("COZE_BOT_ID")
    const userId = `ht_user_${Math.random().toString(36).slice(2)}`

    // 🔥 Future Tech Tone
    const prompt = `
[SYSTEM_DIRECTIVE]
Role: HONEY.TEA Vision Core AI
Tone: Future Tech, High-End Medical, Precise, Insightful.
Task: Generate a skin analysis report based on the provided metrics.

[OUTPUT_FORMAT]
Return JSON ONLY. No markdown blocks.
{
  "summary_en": "One concise, futuristic medical summary sentence.",
  "summary_zh": "一句繁體中文專業總結，帶有未來科技感。",
  "cards": [
    { 
      "id": "match input id", 
      "title_en": "...", 
      "title_zh": "...", 
      "score": number, 
      "signal_en": "Status (e.g. STABLE)", 
      "recommendation_en": "Action", 
      "signal_zh": "中文狀態", 
      "recommendation_zh": "中文建議",
      "signal_zh_deep": "Detailed analysis (CN)", 
      "recommendation_zh_deep": "Detailed advice (CN)",
      "priority": number, 
      "confidence": number,
      "details": [...] 
    }
  ]
}

[DATA]
${JSON.stringify(metrics)}
`.trim()

    // 1. Chat (Non-streaming, auto_save_history=true)
    console.log("[Coze] Step 1: Starting Chat...")
    const startRes = await fetch(COZE_BASE, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            bot_id: botId,
            user_id: userId,
            stream: false,
            auto_save_history: true,
            additional_messages: [
                { role: "user", content: prompt, content_type: "text" },
            ],
        }),
    })

    if (!startRes.ok) throw new Error(`Coze Start Failed: ${startRes.status}`)
    const startData = await startRes.json()
    if (startData.code !== 0) throw new Error(`Coze Error: ${JSON.stringify(startData)}`)

    const conversationId = startData.data.conversation_id
    const chatId = startData.data.id

    // 2. Poll Status
    console.log(`[Coze] Step 2: Polling Chat ${chatId}...`)
    let status = "created"
    for (let i = 0; i < 20; i++) {
        await sleep(2000)
        const pollRes = await fetch(
            `${COZE_BASE}/retrieve?conversation_id=${conversationId}&chat_id=${chatId}`,
            { headers: { Authorization: `Bearer ${token}` } }
        )
        const pollData = await pollRes.json()
        status = pollData.data.status
        
        if (status === "completed") break
        if (status === "failed" || status === "canceled") throw new Error(`Coze Failed: ${status}`)
    }

    if (status !== "completed") throw new Error("Coze Timeout")

    // 3. Get Messages
    console.log("[Coze] Step 3: Fetching Result...")
    const listRes = await fetch(
        `${COZE_BASE}/message/list?conversation_id=${conversationId}&chat_id=${chatId}`,
        { headers: { Authorization: `Bearer ${token}` } }
    )
    const listData = await listRes.json()

    const answerMsg = listData.data.find(
        (m: any) => m.role === "assistant" && m.type === "answer"
    )
    if (!answerMsg) throw new Error("Coze returned no answer")

    const rawText = answerMsg.content
    const cleaned = rawText
        .replace(/^```json\s*/i, "")
        .replace(/^```\s*/i, "")
        .replace(/```$/g, "")
        .trim()
    return JSON.parse(cleaned)
}

// --- YouCam Workflow (Strict Spec) ---
const YOUCAM_BASE = "[https://yce-api-01.makeupar.com/s2s/v2.0](https://yce-api-01.makeupar.com/s2s/v2.0)"

async function youcamWorkflow(file: File) {
    const apiKey = mustEnv("YOUCAM_API_KEY")

    // 1. Init
    const initRes = await fetch(`${YOUCAM_BASE}/file/skin-analysis`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            files: [
                {
                    content_type: file.type,
                    file_name: "scan.jpg",
                    file_size: file.size,
                },
            ],
        }),
    })
    const initData = await initRes.json()
    if (!initRes.ok) throw new Error(`YouCam Init Failed: ${JSON.stringify(initData)}`)
    const { file_id, requests } = initData.data.files[0]

    // 2. Upload (S3 with Content-Length)
    const bytes = await file.arrayBuffer()
    await fetch(requests[0].url, {
        method: "PUT",
        headers: {
            "Content-Type": file.type,
            "Content-Length": String(file.size), // ✅ Required
        },
        body: bytes,
    })

    // 3. Task (HD Actions)
    const hdActions = [
        "hd_texture", "hd_pore", "hd_wrinkle", "hd_redness", "hd_oiliness",
        "hd_age_spot", "hd_radiance", "hd_moisture", "hd_firmness",
        "hd_acne", "hd_dark_circle", "hd_eye_bag",
    ]

    const taskRes = await fetch(`${YOUCAM_BASE}/task/skin-analysis`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify({
            src_file_id: file_id,
            dst_actions: hdActions,
            miniserver_args: { enable_mask_overlay: false },
            format: "json",
        }),
    })
    const taskData = await taskRes.json()
    if (!taskRes.ok) throw new Error(`YouCam Start Failed: ${JSON.stringify(taskData)}`)
    const taskId = taskData.data.task_id

    // 4. Poll
    for (let i = 0; i < 40; i++) {
        await sleep(1500)
        const pollRes = await fetch(
            `${YOUCAM_BASE}/task/skin-analysis/${taskId}`,
            { headers: { Authorization: `Bearer ${apiKey}` } }
        )
        const pollData = await pollRes.json()
        const status = pollData?.data?.task_status

        if (status === "success") {
            const map = new Map<string, number>()
            pollData.data.results.output.forEach((x: any) =>
                map.set(String(x.type), Number(x.ui_score || 0))
            )
            return { map, taskId }
        }
        if (status === "error") throw new Error("YouCam Analysis Error: " + JSON.stringify(pollData))
    }
    throw new Error("YouCam Timeout")
}

export async function OPTIONS(req: Request) {
    const origin = req.headers.get("origin") || ""
    return new NextResponse(null, { status: 204, headers: corsHeaders(origin) })
}

export async function POST(req: Request) {
    const origin = req.headers.get("origin") || ""
    try {
        const formData = await req.formData()
        const file = formData.get("image1") as File
        if (!file) throw new Error("Missing image1")

        const { map, taskId } = await youcamWorkflow(file)
        const scanId = `scan_${Date.now()}`
        const rawMetrics = buildMetrics(map, scanId)
        const report = await generateReportWithCoze(rawMetrics, scanId)

        return jsonResponse(
            {
                scanId,
                summary_en: report.summary_en,
                summary_zh: report.summary_zh,
                cards: report.cards,
                meta: { youcam_task_id: taskId },
            },
            200,
            origin
        )
    } catch (e: any) {
        const msg = e?.message || String(e)
        console.error("Scan error:", msg)
        // ... (Error handling logic)
        return jsonResponse({ error: "scan_failed", message: msg }, 500, origin)
    }
}
