// app/api/scan/route.ts
// HONEY.TEA — MVP Connection Test (YouCam Only)
// 🎯 Goal: Verify YouCam v2.0 Connectivity & S3 Upload
// ⚠️ Coze is DISABLED for this test.

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 60;

const YOUCAM_BASE = "https://yce-api-01.makeupar.com/s2s/v2.0";

function mustEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function youcamWorkflow(file: File) {
    const apiKey = mustEnv("YOUCAM_API_KEY");
    
    // 1. Init
    console.log("[Test] 1. Init Upload...");
    const initRes = await fetch(`${YOUCAM_BASE}/file/skin-analysis`, {
        method: "POST", 
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ files: [{ content_type: file.type, file_name: "scan.jpg", file_size: file.size }] })
    });
    
    if (!initRes.ok) {
        const err = await initRes.text();
        throw new Error(`Init Failed: ${err}`);
    }
    const initData = await initRes.json();
    const { file_id, requests } = initData.data.files[0];
    console.log("[Test] File ID:", file_id);

    // 2. Upload
    console.log("[Test] 2. Uploading to S3...");
    const bytes = await file.arrayBuffer();
    const uploadRes = await fetch(requests[0].url, { 
        method: "PUT", 
        headers: { 
            "Content-Type": file.type,
            "Content-Length": String(file.size) 
        }, 
        body: bytes 
    });
    
    if (!uploadRes.ok) throw new Error(`S3 Upload Failed: ${uploadRes.status}`);
    console.log("[Test] Upload Success");

    // 3. Task
    console.log("[Test] 3. Starting Task...");
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
    
    if (!taskRes.ok) {
        const err = await taskRes.text();
        throw new Error(`Task Start Failed: ${err}`);
    }
    const taskData = await taskRes.json();
    const taskId = taskData.data.task_id;
    console.log("[Test] Task ID:", taskId);

    // 4. Poll
    console.log("[Test] 4. Polling...");
    for (let i = 0; i < 40; i++) {
        await sleep(1500);
        const pollRes = await fetch(`${YOUCAM_BASE}/task/skin-analysis/${taskId}`, { 
            headers: { Authorization: `Bearer ${apiKey}` } 
        });
        const pollData = await pollRes.json();
        const status = pollData?.data?.task_status;
        console.log(`[Test] Poll ${i}: ${status}`);

        if (status === "success") {
            return pollData.data.results.output; // 直接回傳原始數據陣列
        }
        if (status === "error") throw new Error(`YouCam Error: ${JSON.stringify(pollData)}`);
    }
    throw new Error("YouCam Timeout");
}

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
        if (!file) throw new Error("No image");

        // 只跑 YouCam，不跑 Coze
        const rawOutput = await youcamWorkflow(file);

        // 回傳原始數據，證明連線成功
        return NextResponse.json({
            status: "success",
            message: "YouCam Connection Verified",
            raw_data: rawOutput
        }, { headers: cors });

    } catch (e: any) {
        console.error("[Test Error]", e);
        return NextResponse.json({ 
            status: "error", 
            message: String(e.message || e) 
        }, { status: 500, headers: cors });
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
