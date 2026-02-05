// app/api/scan/route.ts
// HONEY.TEA — Skin Vision Scan API (Official Spec Compliance)
// ✅ YouCam Spec: v2.0 Init -> S3 Upload (w/ Content-Length) -> Task (HD Only) -> Poll
// ✅ Coze Spec: v3 Non-streaming (Chat -> Retrieve -> List)
// ✅ Logic: Passes raw YouCam data to Coze to generate the "High-End Analysis" JSON

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

// --- Config ---
const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";
const COZE_BASE = "https://api.coze.com/v3/chat";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --- 1. YouCam Workflow (Strict Spec) ---
async function youcamWorkflow(file: File) {
    const apiKey = mustEnv("YOUCAM_API_KEY");
    
    // A. Init (取得上傳連結)
    console.log("[YouCam] Step 1: Init Upload...");
    const initRes = await fetch(`${YOUCAM_BASE}/file/skin-analysis`, {
        method: "POST", 
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ content_type: file.type, file_name: "scan.jpg", file_size: file.size }] })
    });
    const initData = await initRes.json();
    if (!initRes.ok) throw new Error(`YouCam Init Failed: ${JSON.stringify(initData)}`);
    
    const { file_id, requests } = initData.data.files[0];
    const uploadUrl = requests[0].url;

    // B. Upload to S3 (必須帶 Content-Length)
    console.log("[YouCam] Step 2: Uploading binary...");
    const bytes = await file.arrayBuffer();
    const uploadRes = await fetch(uploadUrl, { 
        method: "PUT", 
        headers: { 
            "Content-Type": file.type,
            "Content-Length": String(file.size) // ⚠️ 官方文件強調必須要有
        }, 
        body: bytes 
    });
    if (!uploadRes.ok) throw new Error("S3 Upload Failed");

    // C. Start Task (HD Metrics Only)
    // 根據官方文件：HD 與 SD 不能混用。我們全選 HD。
    console.log("[YouCam] Step 3: Starting Analysis...");
    const hdActions = [
        "hd_texture", "hd_pore", "hd_wrinkle", "hd_redness", "hd_oiliness", 
        "hd_age_spot", "hd_radiance", "hd_moisture", "hd_firmness", 
        "hd_acne", "hd_dark_circle", "hd_eye_bag"
    ];

    const taskRes = await fetch(`${YOUCAM_BASE}/task/skin-analysis`, {
        method: "POST", 
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ 
            src_file_id: file_id, 
            dst_actions: hdActions,
            miniserver_args: { "enable_mask_overlay": false },
            format: "json" 
        })
    });
    const taskData = await taskRes.json();
    if (!taskRes.ok) throw new Error(`YouCam Task Failed: ${JSON.stringify(taskData)}`);
    const taskId = taskData.data.task_id;

    // D. Poll (輪詢直到成功)
    for (let i = 0; i < 40; i++) {
        await sleep(1500);
        const pollRes = await fetch(`${YOUCAM_BASE}/task/skin-analysis/${taskId}`, { 
            headers: { Authorization: `Bearer ${apiKey}` } 
        });
        const pollData = await pollRes.json();
        const status = pollData?.data?.task_status;
        console.log(`[YouCam] Poll ${i}: ${status}`);

        if (status === "success") {
            // 轉成簡單的 Map 方便後續處理
            const map = new Map<string, number>();
            pollData.data.results.output.forEach((x: any) => map.set(String(x.type), Number(x.ui_score || 0)));
            return { map, taskId };
        }
        if (status === "error") throw new Error("YouCam Analysis Error: " + JSON.stringify(pollData));
    }
    throw new Error("YouCam Timeout");
}

// --- 2. Coze Workflow (High-End Report) ---
async function generateReportWithCoze(rawMetrics: any, scanId: string) {
    const token = mustEnv("COZE_API_TOKEN");
    const botId = mustEnv("COZE_BOT_ID");
    const userId = `ht_${Math.random().toString(36).slice(2)}`;

    // 這是你剛剛給我的「高端皮膚分析」完整 Prompt 結構
    const prompt = `
[SYSTEM_DIRECTIVE]
You are HONEY.TEA · VISION CORE AI.
Input Data: ${JSON.stringify(rawMetrics)}
Scan ID: ${scanId}

[TASK]
Analyze the 14 raw metrics and generate a JSON report following this EXACT structure.
Do not output markdown. Only raw JSON.

[OUTPUT SCHEMA]
{
  "skin_health_index": {
    "score": (Integer 0-100),
    "verdict_en": "String (e.g. CALIBRATION REQUIRED)",
    "verdict_zh": "String (e.g. 需要校準)",
    "alert": "String (Alert message)"
  },
  "zones": [
    { "id": "t_zone", "name_en": "T-Zone", "name_zh": "T 字部位", "metrics": {"pore": int, "oiliness": int, "acne": int}, "summary_zh": "String" },
    { "id": "cheeks", "name_en": "Cheeks", "name_zh": "臉頰", "metrics": {"texture": int, "radiance": int, "age_spot": int}, "summary_zh": "String" },
    { "id": "eye_zone", "name_en": "Eye Zone", "name_zh": "眼周", "metrics": {"dark_circle": int, "eye_bag": int}, "summary_zh": "String" },
    { "id": "forehead", "name_en": "Forehead", "name_zh": "額頭", "metrics": {"wrinkle": int, "texture": int, "oiliness": int}, "summary_zh": "String" },
    { "id": "nasolabial", "name_en": "Nasolabial", "name_zh": "法令紋區", "metrics": {"wrinkle": int, "firmness": int, "elasticity": int}, "summary_zh": "String" },
    { "id": "chin", "name_en": "Chin", "name_zh": "下巴", "metrics": {"acne": int, "pore": int, "oiliness": int}, "summary_zh": "String" }
  ],
  "cards": [
    // Generate 9 cards: texture, pore, hydration, sebum, pigmentation, sensitivity, wrinkle, firmness, eye_zone
    {
      "id": "texture",
      "title_en": "TEXTURE MATRIX",
      "title_zh": "紋理結構矩陣",
      "score": (Integer),
      "signal_en": "String",
      "signal_zh": "String",
      "front_zh": "String (Short summary)",
      "front_en": "String",
      "deep": {
        "system_analysis": "String (Deep analysis text)",
        "data_interpretation": [{ "label_zh": "String", "label_en": "String", "value": int, "explanation": "String" }],
        "system_recommendation": "String (Advice)",
        "optimization_forecast": "String (Prediction)"
      }
    }
    // ... Repeat for all 9 cards ...
  ],
  "raw_data_matrix": [
     { "id": "hd_texture", "name_zh": "紋理", "score": int },
     // ... list all 14 metrics
  ],
  "actions": [
    { "domain": "barrier", "action_zh": "String", "action_en": "String" },
    { "domain": "rhythm", "action_zh": "String", "action_en": "String" },
    { "domain": "protection", "action_zh": "String", "action_en": "String" }
  ],
  "forecast": {
    "summary_zh": "String",
    "summary_en": "String"
  }
}
`.trim();

    // A. Chat (Non-streaming, auto_save_history=true)
    console.log("[Coze] Step 1: Sending Data...");
    const startRes = await fetch(COZE_BASE, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            bot_id: botId, user_id: userId, stream: false, auto_save_history: true,
            additional_messages: [{ role: "user", content: prompt, content_type: "text" }]
        })
    });
    
    if (!startRes.ok) throw new Error(`Coze Start Failed: ${startRes.status}`);
    const startData = await startRes.json();
    if (startData.code !== 0) throw new Error(`Coze Error: ${JSON.stringify(startData)}`);

    const { conversation_id, id: chat_id } = startData.data;

    // B. Poll (等待完成)
    console.log("[Coze] Step 2: Thinking...");
    let status = "created";
    for (let i = 0; i < 30; i++) { 
        await sleep(2000);
        const pollRes = await fetch(`${COZE_BASE}/retrieve?conversation_id=${conversation_id}&chat_id=${chat_id}`, {
            headers: { Authorization: `Bearer ${token}` }
        });
        const pollData = await pollRes.json();
        status = pollData.data.status;
        if (status === "completed") break;
        if (status === "failed" || status === "canceled") throw new Error("Coze Failed");
    }

    // C. List Messages (取得結果)
    console.log("[Coze] Step 3: Fetching Report...");
    const listRes = await fetch(`${COZE_BASE}/message/list?conversation_id=${conversation_id}&chat_id=${chat_id}`, {
        headers: { Authorization: `Bearer ${token}` }
    });
    const listData = await listRes.json();
    const answer = listData.data.find((m: any) => m.role === "assistant" && m.type === "answer");
    if (!answer) throw new Error("Coze returned empty");

    // 清理 JSON 字串
    const rawJSON = answer.content.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/```$/g, "").trim();
    return JSON.parse(rawJSON);
}

// --- Main Handler ---
export async function POST(req: Request) {
    const origin = req.headers.get("origin") || "";
    const cors = {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    try {
        const formData = await req.formData();
        const file = formData.get("image1") as File;
        if (!file) throw new Error("No image uploaded");

        // 1. YouCam 分析
        const { map, taskId } = await youcamWorkflow(file);
        
        // 2. 整理原始數據 (將 Map 轉為 Object)
        const rawMetrics = Object.fromEntries(map);
        const scanId = `scan_${Date.now()}`;

        // 3. Coze 生成報告
        const report = await generateReportWithCoze(rawMetrics, scanId);

        return NextResponse.json({
            scanId,
            ...report, // 包含 skin_health_index, zones, cards...
            meta: { youcam_task_id: taskId }
        }, { headers: cors });

    } catch (e: any) {
        console.error("Scan Error:", e);
        // 錯誤處理 (保留 YouCam 特定錯誤提示)
        let retakeCode = null, tips: string[] = [];
        const msg = String(e.message || e);
        if (msg.includes("error_src_face_too_small")) { retakeCode = "error_src_face_too_small"; tips = ["靠近一點"]; }
        else if (msg.includes("error_lighting_dark")) { retakeCode = "error_lighting_dark"; tips = ["光線太暗"]; }
        
        if (retakeCode) {
            return NextResponse.json({ error: "scan_retake", code: retakeCode, tips }, { status: 200, headers: cors });
        }
        return NextResponse.json({ error: "scan_failed", message: msg }, { status: 500, headers: cors });
    }
}

export async function OPTIONS(req: Request) {
    const origin = req.headers.get("origin") || "";
    return new NextResponse(null, {
        status: 204,
        headers: {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "POST, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization",
        }
    });
}
