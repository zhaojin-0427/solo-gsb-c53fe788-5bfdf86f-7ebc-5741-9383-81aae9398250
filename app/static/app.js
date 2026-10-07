/* 无线话筒频点协调台 —— 原生 JS 前端 */
"use strict";

const state = {
  planId: null,
  // 展示中的结果：{ key, data }。key 为求解时刻的输入指纹，
  // 仅当 key 与当前输入指纹一致时结果才属于当前页面，否则一律撤下。
  result: null,
  // 请求归属序号：每次求解、每次方案切换（新建/打开/删除当前方案）以及
  // 输入编辑使在途求解失效时都递增；响应回来时序号不匹配即为过期请求，
  // 静默丢弃。
  solveSeq: 0,
  // 在途求解请求的输入指纹；null 表示当前无在途求解。输入一旦变化，
  // 不必等响应回来即可作废该请求并释放求解按钮。
  pendingKey: null,
  // 保存请求归属序号：每次保存递增；方案上下文切换（新建/打开/删除当前
  // 方案）同样递增。响应回来时序号不匹配即为过期保存：成功只保留服务端
  // 保存结果，不得把当前页面绑回旧方案；失败不对当前页报错。
  saveSeq: 0,
  planMenuOpen: false,
};

const $ = (sel) => document.querySelector(sel);

function toast(msg, isErr = false) {
  let el = $("#toast");
  if (!el) {
    el = document.createElement("div");
    el.id = "toast";
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.className = "show" + (isErr ? " err" : "");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (el.className = ""), 2600);
}

// --------------------------- 方案数据 ---------------------------

function defaultPlan() {
  return {
    name: "",
    minGap: 5,
    imTolerance: 0,
    timeLimit: 10,
    forbidden: [],
    mics: [blankMic("A"), blankMic("B")],
  };
}

function blankMic(id) {
  return {
    id,
    candidates: [],
    current: null,
    locked: false,
    // 候选草稿的两类“未改正”状态（平行区分，互不混同）：
    //   candInvalid —— 无法识别的原文词（非正整数内容，按原文词记录）；
    //   candDups    —— 按频点数值识别出的重复值（如再键入 520 或 0520）。
    // 任一非空时 candText 为文本框原文，失焦/重绘按原文回显，绝不静默丢弃；
    // 草稿全部合法（互异正整数）时两者为 []、candText 为 null。
    candInvalid: [],
    candDups: [],
    candText: null,
  };
}

let plan = defaultPlan();

// --------------------------- 渲染：话筒卡片 ---------------------------

function renderMics() {
  const wrap = $("#mics");
  wrap.innerHTML = "";
  plan.mics.forEach((mic, idx) => {
    // 含非法词或重复频点的草稿按原文回显（失焦/重绘不抹去），
    // 合法草稿规整为候选列表
    const invalid = candDraftDirty(mic);
    const draftText = invalid ? mic.candText : mic.candidates.join(", ");
    const card = document.createElement("div");
    card.className = "mic-card";
    card.innerHTML = `
      <div class="mic-head">
        <input class="id-input" data-k="id" value="${escapeHtml(mic.id)}"
               maxlength="10" title="设备 ID">
        <label class="lock-wrap">
          <input type="checkbox" data-k="locked" ${mic.locked ? "checked" : ""}>
          🔒 锁定
        </label>
        <span class="spacer"></span>
        <button class="btn btn-small btn-danger" data-act="del"
                ${plan.mics.length <= 2 ? "disabled" : ""}>删除</button>
      </div>
      <div class="mic-field">
        <div class="cap">候选频点（1～12 个互异正整数 kHz，用空格/逗号分隔）
          <span class="cand-count">${mic.candidates.length}/12</span>
        </div>
        <textarea class="cand-area${invalid ? " invalid" : ""}" data-k="candidates" rows="2"
          placeholder="例如：520 530 540 550">${escapeHtml(draftText)}</textarea>
        <div class="cand-err">${invalid ? escapeHtml(candErrText(mic)) : ""}</div>
      </div>
      <div class="mic-field">
        <div class="cap">现用频点（可选，须在候选中）</div>
        <div class="current-row">
          <select data-k="current">
            <option value="">— 无 —</option>
            ${[...mic.candidates]
              .sort((a, b) => a - b)
              .map(
                (f) =>
                  `<option value="${f}" ${mic.current === f ? "selected" : ""}>${f} kHz</option>`
              )
              .join("")}
          </select>
        </div>
      </div>`;

    card.querySelector('[data-k="id"]').addEventListener("input", (e) => {
      mic.id = e.target.value.trim();
      onPlanEdited();
    });

    card.querySelector('[data-k="locked"]').addEventListener("change", (e) => {
      mic.locked = e.target.checked;
      if (mic.locked && mic.current == null && mic.candidates.length) {
        // 锁定必须有现用频点：默认取最小候选
        mic.current = Math.min(...mic.candidates);
        renderMics();
      }
      onPlanEdited();
    });

    const candArea = card.querySelector('[data-k="candidates"]');
    const candErr = card.querySelector(".cand-err");
    // 键入即提交草稿（不等失焦）：合法词立即写入 plan，非法词与重复频点
    // 暂存草稿并即时给出校验反馈；指纹随任一草稿改动（含非法词与重复值）
    // 变化，旧结果立即撤下、在途求解立即失效
    candArea.addEventListener("input", () => {
      commitCandDraft(mic, candArea.value);
      const dirty = candDraftDirty(mic);
      card.querySelector(".cand-count").textContent =
        `${mic.candidates.length}/12`;
      candArea.className = "cand-area" + (dirty ? " invalid" : "");
      candErr.textContent = dirty ? candErrText(mic) : "";
      onPlanEdited();
    });
    // 失焦时规整：合法草稿规范化重写；未改正草稿（非法词/重复频点）按原文
    // 保留（不抹去），校验反馈继续显示；清理失效的现用频点并重建卡片
    // （刷新下拉框与计数）
    candArea.addEventListener("change", () => {
      commitCandDraft(mic, candArea.value);
      if (mic.current != null && !mic.candidates.includes(mic.current)) {
        mic.current = null;
      }
      renderMics();
      onPlanEdited();
    });

    card.querySelector('[data-k="current"]').addEventListener("change", (e) => {
      mic.current = e.target.value === "" ? null : parseInt(e.target.value, 10);
      onPlanEdited();
    });

    card.querySelector('[data-act="del"]').addEventListener("click", () => {
      if (plan.mics.length <= 2) return;
      plan.mics.splice(idx, 1);
      renderMics();
      onPlanEdited();
    });

    wrap.appendChild(card);
  });
}

// 解析候选频点草稿：合法词（互异正整数 kHz）进入 values；无法识别的词
// 原样记入 invalid；按数值重复出现的合法词记入 dups（唯一化，按首次重复
// 出现的顺序）——非法词与重复值都不得静默丢弃。
function parseCandidates(text) {
  const parts = text.split(/[\s,，、;；]+/).filter(Boolean);
  const values = [];
  const invalid = [];
  const dups = [];
  for (const p of parts) {
    const n = Number(p);
    if (Number.isInteger(n) && n > 0) {
      if (!values.includes(n)) values.push(n);
      else if (!dups.includes(n)) dups.push(n); // 数值重复：如 520 与 0520
    } else {
      invalid.push(p);
    }
  }
  return { values, invalid, dups, rawCount: parts.length };
}

// 草稿是否“未改正”：存在无法识别的词或重复频点。两类错误平行区分——
// 重复值是合法数值但违反互异要求，非法词则根本无法识别，提示须各自准确。
function candDraftDirty(mic) {
  return (mic.candInvalid || []).length > 0 || (mic.candDups || []).length > 0;
}

// 提交候选文本框草稿：合法词（去重后）立即写入 mic.candidates（键入即生效，
// 合法候选与现用频点不被误改）；非法词与重复频点连同文本框原文暂存于
// mic.candInvalid / mic.candDups / mic.candText，待用户改正。
function commitCandDraft(mic, text) {
  const parsed = parseCandidates(text);
  mic.candidates = parsed.values;
  mic.candInvalid = parsed.invalid;
  mic.candDups = parsed.dups;
  mic.candText = candDraftDirty(mic) ? text : null;
}

// 草稿校验提示：按类列出无法识别的原文词与重复的频点数值，
// 明确改正前不得求解/保存
function candErrText(mic) {
  const parts = [];
  if ((mic.candInvalid || []).length) {
    const bad = mic.candInvalid.map((t) => `“${t}”`).join("、");
    parts.push(`无法识别：${bad} —— 候选频点须为正整数 kHz`);
  }
  if ((mic.candDups || []).length) {
    const dup = mic.candDups.join("、");
    parts.push(`重复频点：${dup} kHz —— 候选频点须互异`);
  }
  return parts.join("；") + "，改正前不能求解或保存";
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

// --------------------------- 渲染：禁用区间 ---------------------------

function renderBands() {
  const wrap = $("#bands");
  wrap.innerHTML = "";
  plan.forbidden.forEach((b, idx) => {
    const chip = document.createElement("span");
    chip.className = "band-chip";
    chip.innerHTML = `
      <input type="number" min="1" step="1" value="${b.low}" title="下限（含）">
      <span>～</span>
      <input type="number" min="1" step="1" value="${b.high}" title="上限（含）">
      <span>kHz</span>
      <button class="btn btn-small btn-danger" data-act="delband">×</button>`;
    const [lo, hi] = chip.querySelectorAll("input");
    // 键入即提交（input 而非 change）：plan 立即与界面一致，
    // 旧结果与在途求解随指纹变化立即失效
    lo.addEventListener("input", () => {
      b.low = parseInt(lo.value, 10);
      onPlanEdited();
    });
    hi.addEventListener("input", () => {
      b.high = parseInt(hi.value, 10);
      onPlanEdited();
    });
    chip.querySelector('[data-act="delband"]').addEventListener("click", () => {
      plan.forbidden.splice(idx, 1);
      renderBands();
      onPlanEdited();
    });
    wrap.appendChild(chip);
  });
}

// --------------------------- 参数读取与校验 ---------------------------

function collectPlan() {
  plan.name = $("#planName").value.trim();
  plan.minGap = parseInt($("#minGap").value, 10);
  plan.imTolerance = parseInt($("#imTolerance").value, 10);
  plan.timeLimit = parseInt($("#timeLimit").value, 10);
  return plan;
}

// --------------------------- 结果归属规则 ---------------------------
//
// 结果只属于“产生它的那份输入”：
//   * 控件草稿键入（input 事件）即写回 plan，不等失焦——plan 始终与
//     界面一致，求解/保存不会悄悄使用与界面不符的旧值；
//   * 候选文本框的非法词与重复频点不静默丢弃：分别暂存于 mic.candInvalid /
//     mic.candDups（原文存 mic.candText）并计入指纹——即使合法候选未变，
//     任一草稿改动同样使旧结果与在途求解立即失效，改正前 validatePlan
//     拦截求解与保存；
//   * 求解时记录输入指纹 reqKey 与请求序号 reqId；
//   * 响应（无论成功/失败）回来时，reqId 仍是最新且当前输入指纹仍等于
//     reqKey，结果才允许上屏，否则静默丢弃；
//   * 任何输入变动都会改变指纹，onPlanEdited() 立即撤下失效结果，并作废
//     在途求解（递增 solveSeq），其迟到响应随之过期；
//   * 新建/打开/删除当前方案会递增 solveSeq 并清空结果；打开请求在发起
//     那一刻即切换上下文，等待期内到达的旧响应一律过期，读取失败保留
//     当前编辑内容。
//   * 保存响应同样按归属裁决：发起保存时记录请求序号、方案绑定、名称
//     草稿与输入指纹；响应回来时序号已过期（方案切换/新建，或又发起了
//     更新的保存）则一律不回写页面——成功只保留服务端保存结果，失败
//     不报错；仍是当前请求时，成功创建的 ID 写回 planId 供后续覆盖保存，
//     但仅当草稿（含名称）自发起起未变时才回写名称，旧名称不得覆盖新
//     草稿；连续保存的较早响应不得回退较新的绑定。
// 指纹只含影响求解与展示的字段（方案名称不影响协调结果，不计入）。

function planFingerprint() {
  collectPlan();
  const norm = {
    minGap: plan.minGap,
    imTolerance: plan.imTolerance,
    timeLimit: plan.timeLimit,
    forbidden: plan.forbidden
      .map((b) => [b.low, b.high])
      .sort((x, y) => x[0] - y[0] || x[1] - y[1]),
    mics: plan.mics.map((m) => [
      m.id,
      [...m.candidates].sort((a, b) => a - b),
      m.current,
      m.locked,
      m.candInvalid || [],
      m.candDups || [],
    ]),
  };
  return JSON.stringify(norm);
}

function invalidateResult() {
  state.result = null;
  $("#resultPanel").hidden = true;
  clearCanvas();
}

// 任何编辑动作后调用（控件键入即触发，不等失焦）：
//   * 展示中的结果若不再对应当前输入，立即撤下；
//   * 在途求解的输入已变化时，立即作废该请求并复位求解按钮——
//     迟到的响应随请求序号过期被静默丢弃，用户可立刻重新求解。
function onPlanEdited() {
  const fp = planFingerprint();
  if (state.result && state.result.key !== fp) {
    invalidateResult();
  }
  if (state.pendingKey !== null && state.pendingKey !== fp) {
    state.pendingKey = null;
    state.solveSeq++;
    setSolveBusy(false);
  }
}

function setSolveBusy(busy) {
  const btn = $("#btnSolve");
  btn.disabled = busy;
  btn.textContent = busy ? "求解中…" : "▶ 协调求解";
}

// 方案上下文切换（新建/打开/删除当前方案）：
// 作废旧求解与旧保存请求、撤下旧结果、复位求解按钮。
function switchPlanContext() {
  state.solveSeq++;
  state.saveSeq++;
  state.pendingKey = null;
  invalidateResult();
  setSolveBusy(false);
}

function validatePlan(p) {
  const errs = [];
  if (!p.name) errs.push("请填写方案名称");
  if (!Number.isInteger(p.minGap) || p.minGap < 1)
    errs.push("最小频差 d 须为正整数");
  if (!Number.isInteger(p.imTolerance) || p.imTolerance < 0)
    errs.push("互调容差 g 须为非负整数");
  if (!Number.isInteger(p.timeLimit) || p.timeLimit < 1)
    errs.push("求解时限须为正整数秒");

  for (const [i, b] of p.forbidden.entries()) {
    if (!Number.isInteger(b.low) || !Number.isInteger(b.high) || b.low < 1)
      errs.push(`禁用区间 #${i + 1} 频点须为正整数`);
    else if (b.low > b.high)
      errs.push(`禁用区间 #${i + 1} 下限（${b.low}）不能大于上限（${b.high}）`);
  }

  if (p.mics.length < 2 || p.mics.length > 8)
    errs.push("话筒数量须在 2～8 支之间");

  const ids = p.mics.map((m) => m.id);
  if (ids.some((id) => !id)) errs.push("每支话筒都必须填写设备 ID");
  if (new Set(ids).size !== ids.length) errs.push("设备 ID 不得重复");

  for (const m of p.mics) {
    if (candDraftDirty(m))
      errs.push(`设备 ${m.id || "?"}：${candErrText(m)}`);
    if (m.candidates.length < 1 || m.candidates.length > 12)
      errs.push(`设备 ${m.id || "?"} 候选频点须为 1～12 个互异正整数 kHz`);
    if (m.current != null && !m.candidates.includes(m.current))
      errs.push(`设备 ${m.id} 的现用频点 ${m.current} kHz 不在候选频点中`);
    if (m.locked && m.current == null)
      errs.push(`锁定设备 ${m.id} 必须填写现用频点`);
  }
  return errs;
}

// --------------------------- 求解 ---------------------------

async function solvePlan() {
  collectPlan();
  const errs = validatePlan(plan);
  if (errs.length) {
    toast(errs[0] + (errs.length > 1 ? ` 等 ${errs.length} 项错误` : ""), true);
    return;
  }
  const reqId = ++state.solveSeq;
  const reqKey = planFingerprint();
  state.pendingKey = reqKey;
  const payload = toApiPayload(plan);
  // 归属判定：仍是最后一次求解、且输入自提交起未变，响应才属于当前页面
  const isCurrent = () =>
    reqId === state.solveSeq && reqKey === planFingerprint();
  setSolveBusy(true);
  try {
    const resp = await fetch("/api/solve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!resp.ok) {
      const detail = await resp.json().catch(() => ({}));
      throw new Error(detail.detail || `HTTP ${resp.status}`);
    }
    const data = await resp.json();
    if (!isCurrent()) return; // 过期成功响应：不得重现结果
    state.result = { key: reqKey, data };
    renderResult(data);
  } catch (e) {
    if (!isCurrent()) return; // 过期失败响应：不得报错
    toast("求解失败：" + e.message, true);
  } finally {
    // 仅在仍是当前请求时收尾；过期请求的收尾不得干扰新上下文
    if (reqId === state.solveSeq) {
      state.pendingKey = null;
      setSolveBusy(false);
    }
  }
}

function toApiPayload(p) {
  return {
    name: p.name,
    minGap: p.minGap,
    imTolerance: p.imTolerance,
    timeLimit: p.timeLimit,
    forbidden: p.forbidden.map((b) => ({ low: b.low, high: b.high })),
    mics: p.mics.map((m) => ({
      id: m.id,
      candidates: [...m.candidates].sort((a, b) => a - b),
      current: m.current,
      locked: m.locked,
    })),
  };
}

// --------------------------- 结果渲染 ---------------------------

function renderResult(r) {
  const panel = $("#resultPanel");
  panel.hidden = false;

  const banner = $("#statusBanner");
  const conflictBox = $("#conflicts");
  const summary = $("#resultSummary");
  conflictBox.innerHTML = "";
  summary.innerHTML = "";

  if (r.status === "conflict") {
    banner.className = "banner conflict";
    banner.innerHTML =
      '<span class="big">⛔ 锁定集合冲突</span>' +
      "锁定设备必须保留现用频点，下列规则无法同时满足，未进行分配求解。";
    conflictBox.innerHTML = r.conflicts
      .map(
        (c) => `
      <div class="conflict-item">
        <span class="tag">${escapeHtml(c.rule)}</span>
        <span class="devs">[${c.devices.map(escapeHtml).join(", ")}]</span>
        <div>${escapeHtml(c.detail)}</div>
      </div>`
      )
      .join("");
    $("#resultTable").innerHTML = "";
    $("#phaseLog").textContent = "";
    clearCanvas();
    panel.scrollIntoView({ behavior: "smooth" });
    return;
  }

  if (r.optimal) {
    banner.className = "banner optimal";
    banner.innerHTML =
      '<span class="big">✅ 已证最优</span>' +
      `在 ${r.solveTimeMs} ms 内证明该方案满足全部优先级最优。`;
  } else {
    banner.className = "banner feasible";
    banner.innerHTML =
      '<span class="big">⚠️ 可行解（未证最优）</span>' +
      `已在求解时限（${r.timeLimitSec} 秒）内找到可行解，但未能证明其最优性；` +
      `可尝试延长求解时限。实际用时 ${r.solveTimeMs} ms。`;
  }

  summary.innerHTML = `
    <span>已分配 <b>${r.assignedCount}</b> / ${r.assignment.length} 支</span>
    <span>现用频点变更 <b>${r.changeCount}</b> 台</span>
    <span>最小频差 d = <b>${plan.minGap}</b> kHz</span>
    <span>互调容差 g = <b>${plan.imTolerance}</b> kHz</span>`;

  // 表格
  const rows = r.assignment
    .map(
      (a) => `
    <tr class="${a.assigned ? "assigned" : "unassigned"}">
      <td>${escapeHtml(a.id)} ${a.locked ? '<span class="locked-mark">🔒</span>' : ""}</td>
      <td>${a.current == null ? "—" : a.current + " kHz"}</td>
      <td class="freq-cell">${a.assigned ? a.frequency + " kHz" : "<i>未分配</i>"}</td>
      <td>${a.changed ? '<span class="changed-mark">✔ 变更</span>' : "—"}</td>
      <td>${a.assigned ? "✔" : "—"}</td>
    </tr>`
    )
    .join("");
  $("#resultTable").innerHTML = `
    <table>
      <thead><tr>
        <th>设备 ID</th><th>现用频点</th><th>协调频点</th><th>是否变更</th><th>已分配</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>`;

  $("#phaseLog").textContent = r.phases
    .map((p) => `[阶段${p.order}] ${p.phase}  →  ${p.status}${p.objective != null ? "  (目标值 " + p.objective + ")" : ""}`)
    .join("\n");

  drawSpectrum(plan, r);
  panel.scrollIntoView({ behavior: "smooth" });
}

// --------------------------- 频谱绘制 ---------------------------

function clearCanvas() {
  const cv = $("#spectrum");
  cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
}

function drawSpectrum(p, r) {
  const cv = $("#spectrum");
  const ctx = cv.getContext("2d");

  // 高分屏适配
  const dpr = window.devicePixelRatio || 1;
  const cssW = cv.clientWidth || 1100;
  const rowH = 34;
  const cssH = Math.max(200, 90 + r.assignment.length * rowH + 40);
  cv.style.height = cssH + "px";
  cv.width = Math.round(cssW * dpr);
  cv.height = Math.round(cssH * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  const W = cssW;
  const padL = 80, padR = 30, padT = 34, padB = 34;

  const allFreqs = p.mics.flatMap((m) => m.candidates);
  let fMin = Math.min(...allFreqs);
  let fMax = Math.max(...allFreqs);
  const span = Math.max(1, fMax - fMin);
  fMin -= span * 0.05 + 2;
  fMax += span * 0.05 + 2;

  const xOf = (f) => padL + ((f - fMin) / (fMax - fMin)) * (W - padL - padR);
  const plotW = W - padL - padR;

  ctx.clearRect(0, 0, W, cssH);

  // 禁用闭区间
  for (const b of p.forbidden) {
    const x1 = xOf(Math.max(b.low, fMin));
    const x2 = xOf(Math.min(b.high, fMax));
    if (x2 < padL || x1 > W - padR) continue;
    ctx.fillStyle = "rgba(255,90,90,0.16)";
    ctx.fillRect(x1, padT - 8, x2 - x1, cssH - padT - padB + 16);
    ctx.strokeStyle = "rgba(255,90,90,0.55)";
    ctx.setLineDash([4, 4]);
    ctx.strokeRect(x1, padT - 8, x2 - x1, cssH - padT - padB + 16);
    ctx.setLineDash([]);
    ctx.fillStyle = "rgba(255,120,120,0.9)";
    ctx.font = "10px sans-serif";
    ctx.fillText(`禁用 ${b.low}~${b.high}`, x1 + 4, padT + 4);
  }

  // 坐标轴与网格
  const gridStep = niceStep((fMax - fMin) / 8);
  ctx.strokeStyle = "rgba(147,161,184,0.18)";
  ctx.fillStyle = "#93a1b8";
  ctx.font = "11px sans-serif";
  ctx.textAlign = "center";
  const startTick = Math.ceil(fMin / gridStep) * gridStep;
  for (let f = startTick; f <= fMax; f += gridStep) {
    const x = xOf(f);
    ctx.beginPath();
    ctx.moveTo(x, padT);
    ctx.lineTo(x, cssH - padB);
    ctx.stroke();
    ctx.fillText(f + "", x, cssH - padB + 16);
  }
  ctx.textAlign = "left";
  ctx.fillText("频率 / kHz", padL, cssH - 6);

  // 图例
  const legend = [
    ["#7d8ca3", "候选"],
    ["#4f9cff", "现用"],
    ["#34c79a", "已分配"],
    ["#b48cff", "锁定"],
  ];
  let lx = W - padR - 220;
  legend.forEach(([color, name]) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(lx, 16, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#c6d2e4";
    ctx.font = "11px sans-serif";
    ctx.fillText(name, lx + 9, 20);
    lx += 58;
  });

  // 每支话筒一行
  const byId = Object.fromEntries(r.assignment.map((a) => [a.id, a]));
  p.mics.forEach((mic, i) => {
    const y = padT + 14 + i * rowH;
    const a = byId[mic.id];

    ctx.strokeStyle = "rgba(147,161,184,0.25)";
    ctx.beginPath();
    ctx.moveTo(padL, y);
    ctx.lineTo(W - padR, y);
    ctx.stroke();

    ctx.fillStyle = "#c6d2e4";
    ctx.font = "12px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText(mic.id + (mic.locked ? " 🔒" : ""), padL - 8, y + 4);
    ctx.textAlign = "center";

    // 候选刻度
    ctx.strokeStyle = "#7d8ca3";
    ctx.lineWidth = 1.5;
    for (const f of mic.candidates) {
      const x = xOf(f);
      ctx.beginPath();
      ctx.moveTo(x, y - 6);
      ctx.lineTo(x, y + 6);
      ctx.stroke();
    }

    // 现用：蓝色空心三角
    if (mic.current != null) {
      const x = xOf(mic.current);
      ctx.strokeStyle = "#4f9cff";
      ctx.fillStyle = "rgba(79,156,255,0.25)";
      ctx.beginPath();
      ctx.moveTo(x, y - 9);
      ctx.lineTo(x - 6, y + 4);
      ctx.lineTo(x + 6, y + 4);
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
    }

    // 已分配：大圆点 + 频点标注
    if (a && a.assigned) {
      const x = xOf(a.frequency);
      ctx.fillStyle = a.locked ? "#b48cff" : "#34c79a";
      ctx.beginPath();
      ctx.arc(x, y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0d1524";
      ctx.font = "bold 9px sans-serif";
      ctx.fillText(a.locked ? "L" : "✓", x, y + 3);
      ctx.fillStyle = a.locked ? "#d8c4ff" : "#8ff0d2";
      ctx.font = "bold 11px sans-serif";
      ctx.fillText(a.frequency + "", x, y - 12);
    } else {
      ctx.fillStyle = "#8a7a55";
      ctx.font = "11px sans-serif";
      ctx.fillText("未分配", W - padR - 30, y + 4);
    }
  });
}

function niceStep(raw) {
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  let f;
  if (n < 1.5) f = 1;
  else if (n < 3.5) f = 2;
  else if (n < 7.5) f = 5;
  else f = 10;
  return f * pow;
}

// --------------------------- 保存 / 打开 ---------------------------

async function savePlan() {
  collectPlan();
  const errs = validatePlan(plan);
  if (errs.length) {
    toast(errs[0] + (errs.length > 1 ? ` 等 ${errs.length} 项错误` : ""), true);
    return;
  }
  // 保存归属判定：记录发起时刻的请求序号、方案绑定、名称草稿与输入指纹
  const reqId = ++state.saveSeq;
  const reqPlanId = state.planId;
  const reqName = plan.name;
  const reqKey = planFingerprint();
  const payload = toApiPayload(plan);
  // 序号已过期（方案切换/新建，或又发起了更新的保存）的响应不得更新页面
  const isCurrent = () => reqId === state.saveSeq;
  // 草稿（含名称）自发起起未变，才允许把服务端名称回写到名称框
  const draftIntact = () =>
    reqKey === planFingerprint() && reqName === plan.name;
  try {
    let resp;
    if (reqPlanId) {
      resp = await fetch(`/api/plans/${reqPlanId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    } else {
      resp = await fetch("/api/plans", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
    }
    if (!resp.ok) {
      const d = await resp.json().catch(() => ({}));
      throw new Error(d.detail || `HTTP ${resp.status}`);
    }
    const saved = await resp.json();
    // 过期成功响应：服务端保存结果保留，但当前页面的方案绑定与名称草稿
    // 一律不动——迟到响应不得把切换后的页面绑回旧方案
    if (!isCurrent()) return;
    // 成功创建的 ID 仍写回：后续保存覆盖同一方案，而非重复新建
    state.planId = saved.id;
    // 等待期内草稿已变：旧名称不得覆盖新草稿
    if (draftIntact()) {
      $("#planName").value = saved.name;
    }
    toast(`方案「${saved.name}」已保存（#${saved.id}）`);
  } catch (e) {
    if (!isCurrent()) return; // 过期失败响应：不对当前页报错
    toast("保存失败：" + e.message, true);
  }
}

async function renderPlanMenu() {
  const menu = $("#planMenu");
  try {
    const resp = await fetch("/api/plans");
    const plans = await resp.json();
    menu.innerHTML = "";
    if (!plans.length) {
      const li = document.createElement("li");
      li.className = "empty";
      li.textContent = "（暂无已保存方案）";
      menu.appendChild(li);
    } else {
      for (const p of plans) {
        const li = document.createElement("li");
        li.innerHTML = `
          <span class="pname">${escapeHtml(p.name)}
            <div class="pmeta">#${p.id}　更新于 ${escapeHtml(p.updatedAt)}</div>
          </span>
          <button class="del" title="删除">🗑</button>`;
        li.querySelector(".pname").addEventListener("click", () => loadPlan(p.id));
        li.querySelector(".del").addEventListener("click", (e) => {
          e.stopPropagation();
          deletePlan(p.id);
        });
        menu.appendChild(li);
      }
    }
  } catch (e) {
    toast("读取方案列表失败：" + e.message, true);
  }
}

async function togglePlanMenu() {
  const menu = $("#planMenu");
  if (state.planMenuOpen) {
    menu.hidden = true;
    state.planMenuOpen = false;
    return;
  }
  await renderPlanMenu();
  menu.hidden = false;
  state.planMenuOpen = true;
}

async function loadPlan(id) {
  // 发起打开请求的那一刻即切换方案上下文：作废旧求解、撤下旧结果，
  // 等待期内到达的旧响应一律过期；读取失败也不会动当前编辑内容。
  switchPlanContext();
  const reqId = state.solveSeq;
  try {
    const resp = await fetch(`/api/plans/${id}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const rec = await resp.json();
    if (reqId !== state.solveSeq) return; // 过期成功响应：不得回填
    const d = rec.plan;
    plan = {
      name: d.name,
      minGap: d.minGap,
      imTolerance: d.imTolerance,
      timeLimit: d.timeLimit,
      forbidden: d.forbidden.map((b) => ({ ...b })),
      mics: d.mics.map((m) => ({
        id: m.id,
        candidates: [...m.candidates],
        current: m.current,
        locked: m.locked,
        candInvalid: [],
        candDups: [],
        candText: null,
      })),
    };
    state.planId = rec.id;
    syncFormFromPlan();
    $("#planMenu").hidden = true;
    state.planMenuOpen = false;
    toast(`已打开方案「${rec.name}」`);
  } catch (e) {
    if (reqId !== state.solveSeq) return; // 过期失败响应：不得报错
    toast("打开失败：" + e.message, true);
  }
}

async function deletePlan(id) {
  if (!confirm(`确认删除方案 #${id}？`)) return;
  const resp = await fetch(`/api/plans/${id}`, { method: "DELETE" });
  if (!resp.ok) {
    toast("删除失败", true);
    return;
  }
  if (state.planId === id) newPlan(false);
  await renderPlanMenu();
  toast("方案已删除");
}

function syncFormFromPlan() {
  $("#planName").value = plan.name;
  $("#minGap").value = plan.minGap;
  $("#imTolerance").value = plan.imTolerance;
  $("#timeLimit").value = plan.timeLimit;
  renderBands();
  renderMics();
}

function newPlan(confirmFlag = true) {
  if (confirmFlag && !confirm("新建将清空当前未保存的编辑，确定？")) return;
  plan = defaultPlan();
  state.planId = null;
  switchPlanContext();
  syncFormFromPlan();
}

// --------------------------- 初始化 ---------------------------

function init() {
  renderBands();
  renderMics();

  $("#minGap").addEventListener("input", () => {
    collectPlan();
    onPlanEdited();
  });
  $("#imTolerance").addEventListener("input", () => {
    collectPlan();
    onPlanEdited();
  });
  $("#timeLimit").addEventListener("input", () => {
    collectPlan();
    onPlanEdited();
  });
  $("#btnAddBand").addEventListener("click", () => {
    collectPlan();
    const base = plan.forbidden.length
      ? plan.forbidden[plan.forbidden.length - 1].high + 1
      : 500;
    plan.forbidden.push({ low: base, high: base + 10 });
    renderBands();
    onPlanEdited();
  });
  $("#btnAddMic").addEventListener("click", () => {
    collectPlan();
    if (plan.mics.length >= 8) {
      toast("最多支持 8 支话筒", true);
      return;
    }
    const used = new Set(plan.mics.map((m) => m.id));
    let id = "A";
    for (let i = 0; used.has(id); i++) {
      id = String.fromCharCode(65 + ((i + 1) % 26)) + (i >= 25 ? i + 1 : "");
    }
    plan.mics.push(blankMic(id));
    renderMics();
    onPlanEdited();
  });
  $("#btnSolve").addEventListener("click", solvePlan);
  $("#btnSave").addEventListener("click", savePlan);
  $("#btnOpen").addEventListener("click", togglePlanMenu);
  $("#btnNew").addEventListener("click", () => newPlan(true));
  document.addEventListener("click", (e) => {
    if (state.planMenuOpen &&
        !$("#planMenu").contains(e.target) &&
        e.target !== $("#btnOpen")) {
      $("#planMenu").hidden = true;
      state.planMenuOpen = false;
    }
  });
  window.addEventListener("resize", () => {
    // 缩放只重绘仍属于当前输入的结果；指纹不匹配时先撤下，避免新旧混绘。
    // 冲突结果没有 assignment（频谱已在展示时清空），不重绘。
    onPlanEdited();
    if (state.result && Array.isArray(state.result.data.assignment)) {
      drawSpectrum(plan, state.result.data);
    }
  });
}

init();
