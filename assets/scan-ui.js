// scan-ui.js — Honey.Tea final frontend bridge

const state = {
  images: [],
};

function createOverlay() {
  const overlay = document.createElement("div");
  overlay.id = "scan-overlay";
  overlay.style.cssText = `
    position: fixed;
    inset: 0;
    background: rgba(5,8,15,0.92);
    backdrop-filter: blur(20px);
    z-index: 9999;
    display: flex;
    align-items: center;
    justify-content: center;
    color: #e6f0ff;
    font-family: Inter, system-ui;
  `;
  overlay.innerHTML = `
    <div style="width:420px">
      <h2 style="margin-bottom:12px">Capture 3 Angles</h2>
      <p style="opacity:.7;font-size:14px;margin-bottom:16px">
        Front · Left · Right<br/>
        Neutral light. No filters.
      </p>
      <input type="file" accept="image/*" capture="environment" />
      <div id="img-count" style="margin:12px 0">0 / 3</div>
      <button id="confirmScan" disabled>Analyze</button>
    </div>
  `;
  document.body.appendChild(overlay);

  const input = overlay.querySelector("input");
  const count = overlay.querySelector("#img-count");
  const btn = overlay.querySelector("#confirmScan");

  input.onchange = (e) => {
    const file = e.target.files[0];
    if (!file) return;
    state.images.push(file);
    count.textContent = `${state.images.length} / 3`;
    if (state.images.length === 3) btn.disabled = false;
  };

  btn.onclick = async () => {
    overlay.innerHTML = `<div>Analyzing…</div>`;
    await runScan();
    overlay.remove();
  };
}

async function runScan() {
  const form = new FormData();
  form.append("image1", state.images[0]);
  form.append("image2", state.images[1]);
  form.append("image3", state.images[2]);

  const res = await fetch("/api/scan", {
    method: "POST",
    body: form,
  });

  const data = await res.json();
  renderResult(data);
}

function renderResult(data) {
  const container = document.createElement("section");
  container.style.cssText = `
    padding:120px 0;
    background:#05080f;
    color:#e6f0ff;
  `;

  container.innerHTML = `
    <h2 style="text-align:center;margin-bottom:40px">
      Skin Analysis Report
    </h2>
    ${data.cards
      .map(
        (c) => `
      <div style="max-width:720px;margin:0 auto 60px">
        <h3>${c.title_en} / ${c.title_zh}</h3>
        <p>${c.signal_zh}</p>
        <ul>
          ${c.details
            .map((d) => `<li>${d.label_zh}：${d.value}</li>`)
            .join("")}
        </ul>
        <p>${c.recommendation_zh}</p>
      </div>
    `
      )
      .join("")}
  `;

  document.body.appendChild(container);
}

export function initScanUI() {
  // 抓所有 CTA（Framer 的按鈕一定有 button role）
  const buttons = Array.from(
    document.querySelectorAll('a, button, [role="button"]')
  );

  // 用「文字」判斷是哪一顆（Framer 穩定可抓）
  const beginBtn = buttons.find(b =>
    b.textContent?.toLowerCase().includes("begin")
  );

  const uploadBtn = buttons.find(b =>
    b.textContent?.toLowerCase().includes("upload")
  );

  if (!beginBtn || !uploadBtn) {
    console.error("❌ Scan buttons not found");
    return;
  }

  console.log("✅ Scan buttons linked");

  beginBtn.addEventListener("click", e => {
    e.preventDefault();
    startScanFlow();
  });

  uploadBtn.addEventListener("click", e => {
    e.preventDefault();
    openUploadFlow();
  });
}

