/* 候选频点“重复值”草稿的前端逻辑测试（Node 运行，迷你 DOM 支持事件触发）。
 *
 * 运行：node tests/duplicate_draft.test.js
 *
 * 修复前：在合法列表（如“520, 540”）后再次键入 520 且未失焦时，
 * parseCandidates 静默去重，commitCandDraft 写入相同的候选集与空
 * candInvalid——planFingerprint 不变，旧表格与频谱不撤下，在途响应可回填；
 * 求解/保存沿用去重后的列表，失焦重绘还会抹掉重复原文。
 *
 * 修复后应满足：
 *   1. 按频点数值识别重复（520 与 0520 同为 520），记入 candDups，与
 *      无法识别词（candInvalid）平行区分；
 *   2. 键入重复即撤下旧结果、作废在途求解（指纹含 candDups）；
 *   3. 即时反馈：文本框标红并提示“重复频点：520 kHz”，不误报“无法识别”；
 *   4. 失焦重绘不抹去重复原文与提示；
 *   5. 改正前求解与保存均被拦截；合法候选与现用频点不被误改；
 *   6. 改正后合法列表未失焦即可提交，API 请求体格式不变；
 *   7. 非法词反馈与现用频点失配校验保持有效。
 */
"use strict";

const fs = require("fs");
const path = require("path");

// --------------------------- 迷你 DOM（支持事件） ---------------------------

function makeCtx() {
  return new Proxy(
    {},
    {
      get: (target, prop) => {
        if (!(prop in target)) target[prop] = () => {};
        return target[prop];
      },
      set: (target, prop, v) => {
        target[prop] = v;
        return true;
      },
    }
  );
}

class El {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.listeners = {};
    this._bySel = {};
    this._innerHTML = "";
    this.value = "";
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.checked = false;
    this.style = {};
    this.clientWidth = 1100;
    this.width = 1100;
    this.height = 320;
  }

  set innerHTML(v) {
    this._innerHTML = v;
    if (v === "") this.children = []; // 模拟重建：清空子节点
  }
  get innerHTML() {
    return this._innerHTML;
  }

  addEventListener(type, fn) {
    (this.listeners[type] = this.listeners[type] || []).push(fn);
  }

  dispatch(type, extra = {}) {
    const ev = { target: this, stopPropagation() {}, ...extra };
    (this.listeners[type] || []).forEach((f) => f(ev));
  }

  // 同一元素的同一选择器返回同一替身，模拟浏览器中稳定的子节点引用
  querySelector(sel) {
    if (!this._bySel[sel]) this._bySel[sel] = new El(sel);
    return this._bySel[sel];
  }

  querySelectorAll(sel) {
    if (!this._bySel["all:" + sel]) {
      this._bySel["all:" + sel] = [new El(sel + "#0"), new El(sel + "#1")];
    }
    return this._bySel["all:" + sel];
  }

  appendChild(c) {
    this.children.push(c);
  }

  scrollIntoView() {}

  getContext() {
    return makeCtx();
  }
}

const byId = {};
global.document = {
  querySelector(sel) {
    if (!byId[sel]) byId[sel] = new El(sel);
    return byId[sel];
  },
  createElement: (tag) => new El(tag),
  addEventListener() {},
  body: new El("body"),
};
global.window = {
  devicePixelRatio: 1,
  addEventListener() {},
};
global.confirm = () => true;

globalThis.__fetchImpl = () => Promise.reject(new Error("fetch 未 mock"));
global.fetch = (...args) => globalThis.__fetchImpl(...args);

globalThis.__deferred = () => {
  let resolve, reject;
  const p = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { p, resolve, reject };
};

// --------------------------- 加载被测代码并驱动 ---------------------------

const src = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "app.js"),
  "utf8"
);

const driver = `
;(async function __drive__() {
  const results = [];
  const t = (name, cond) => {
    results.push([name, !!cond]);
    console.log((cond ? "PASS" : "FAIL") + "  " + name);
  };
  const $el = (sel) => document.querySelector(sel);
  const okJson = (data) => Promise.resolve({ ok: true, json: async () => data });
  const SOLVE_OK = {
    status: "optimal", optimal: true, assignedCount: 2, changeCount: 0,
    solveTimeMs: 5, timeLimitSec: 10, phases: [],
    assignment: [
      { id: "A", locked: false, current: null, assigned: true, frequency: 520, changed: false },
      { id: "B", locked: false, current: null, assigned: true, frequency: 545, changed: false },
    ],
    conflicts: [],
  };

  // 0. 解析：按频点数值识别重复（0520 与 520 同值），与无法识别词区分
  const p0 = parseCandidates("520 540 520 0520 540");
  t("parseCandidates：按数值识别重复，合法列表仍去重",
    JSON.stringify(p0.values) === "[520,540]" &&
    JSON.stringify(p0.dups) === "[520,540]" &&
    JSON.stringify(p0.invalid) === "[]");
  const p0b = parseCandidates("520 540");
  t("parseCandidates：互异列表不误报重复",
    JSON.stringify(p0b.values) === "[520,540]" && p0b.dups.length === 0);
  const p0c = parseCandidates("520 abc 520");
  t("parseCandidates：重复值与无法识别词平行区分",
    JSON.stringify(p0c.values) === "[520]" &&
    JSON.stringify(p0c.dups) === "[520]" &&
    JSON.stringify(p0c.invalid) === '["abc"]');

  // 通过界面控件录入合法方案（模拟用户键入，只触发 input，不触发 change）
  $el("#planName").value = "重复草稿测试";
  $el("#minGap").value = "5";
  $el("#imTolerance").value = "0";
  $el("#timeLimit").value = "10";
  const cardA = $el("#mics").children[0];
  const cardB = $el("#mics").children[1];
  const candA = cardA.querySelector('[data-k="candidates"]');
  const candB = cardB.querySelector('[data-k="candidates"]');
  candA.value = "520, 540";
  candA.dispatch("input");
  candB.value = "525 545";
  candB.dispatch("input");
  t("合法列表键入：不产生重复标记",
    plan.mics[0].candDups.length === 0 && plan.mics[0].candText === null);

  // 求解上屏，制造“已有有效结果”的状态
  globalThis.__fetchImpl = () => okJson(SOLVE_OK);
  await solvePlan();
  t("前置：求解成功，结果上屏",
    state.result !== null && $el("#resultPanel").hidden === false);

  // 1. 合法列表后再次键入 520（未失焦）-> 旧结果立即撤下，重复值暂存
  const fpBefore = planFingerprint();
  candA.value = "520, 540, 520";
  candA.dispatch("input"); // 只触发 input，未触发 change（未失焦）
  t("重复键入未失焦：旧结果立即撤下",
    state.result === null && $el("#resultPanel").hidden === true);
  t("重复键入未失焦：指纹随草稿改动",
    planFingerprint() !== fpBefore);
  t("重复值暂存：candDups 记录重复频点数值",
    JSON.stringify(plan.mics[0].candDups) === "[520]");
  t("重复值暂存：文本框原文保留在 candText",
    plan.mics[0].candText === "520, 540, 520");
  t("重复键入未失焦：合法候选不被误改",
    JSON.stringify(plan.mics[0].candidates) === "[520,540]");
  t("重复键入未失焦：文本框标红并即时提示重复频点",
    candA.className.includes("invalid") &&
    cardA.querySelector(".cand-err").textContent.includes("重复频点") &&
    cardA.querySelector(".cand-err").textContent.includes("520"));
  t("重复提示与无法识别区分：不误报无法识别",
    !cardA.querySelector(".cand-err").textContent.includes("无法识别"));

  // 改正回合法草稿，准备在途求解场景
  candA.value = "520, 540";
  candA.dispatch("input");
  t("改正后：重复状态立即清除",
    plan.mics[0].candDups.length === 0 && plan.mics[0].candText === null &&
    !candA.className.includes("invalid") &&
    cardA.querySelector(".cand-err").textContent === "");

  // 2. 在途求解时键入重复值 -> 求解立即作废，迟到响应不上屏
  const d1 = __deferred();
  globalThis.__fetchImpl = () => d1.p;
  const p1 = solvePlan();
  candA.value = "520, 540, 520";
  candA.dispatch("input");
  t("在途求解时键入重复值：求解按钮立即复位",
    $el("#btnSolve").disabled === false);
  d1.resolve({ ok: true, json: async () => SOLVE_OK });
  await p1;
  t("在途求解时键入重复值：迟到成功响应不上屏",
    state.result === null && $el("#resultPanel").hidden === true);

  // 3. 重复值未改正 -> 求解与保存均被拦截（不发请求，提示重复频点）
  let calls = [];
  globalThis.__fetchImpl = (url) => { calls.push(url); return okJson({}); };
  await solvePlan();
  t("重复值未改正：求解被拦截（未发请求）", calls.length === 0);
  t("重复值未改正：求解提示重复频点",
    $el("#toast").textContent.includes("重复频点"));
  await savePlan();
  t("重复值未改正：保存被拦截（未发请求）", calls.length === 0);
  t("重复值未改正：保存提示重复频点",
    $el("#toast").textContent.includes("重复频点"));

  // 4. 失焦重绘 -> 重复原文与校验提示保留，不被抹去
  candA.dispatch("change");
  t("失焦重绘：重复原文保留在 plan",
    plan.mics[0].candText === "520, 540, 520" &&
    JSON.stringify(plan.mics[0].candDups) === "[520]");
  const cardHtml = $el("#mics").children[0].innerHTML;
  t("失焦重绘：文本框回显重复原文且提示仍在",
    cardHtml.includes("520, 540, 520") && cardHtml.includes("重复频点"));

  // 5. 现用频点不被误改；失配校验保持有效
  const selA = $el("#mics").children[0].querySelector('[data-k="current"]');
  selA.value = "520";
  selA.dispatch("change");
  t("设定现用频点 520（在去重后候选中）", plan.mics[0].current === 520);
  const candA3 = $el("#mics").children[0].querySelector('[data-k="candidates"]');
  candA3.value = "520, 540, 520";
  candA3.dispatch("input");
  candA3.dispatch("change"); // 失焦规整：现用频点仍在候选中，不得清理
  t("重复草稿失焦规整：现用频点不被误改", plan.mics[0].current === 520);
  const candA4 = $el("#mics").children[0].querySelector('[data-k="candidates"]');
  candA4.value = "540, 560"; // 改正重复，但不再含现用频点 520
  candA4.dispatch("input");
  calls = [];
  await solvePlan();
  t("现用频点失配校验保持有效：求解被拦截",
    calls.length === 0 && $el("#toast").textContent.includes("不在候选频点中"));
  const selA2 = $el("#mics").children[0].querySelector('[data-k="current"]');
  selA2.value = "";
  selA2.dispatch("change"); // 清空现用频点，恢复合法状态
  t("清空现用频点", plan.mics[0].current === null);

  // 6. 非法词与重复值并存 -> 两类提示同时给出，求解仍被拦截
  const candA5 = $el("#mics").children[0].querySelector('[data-k="candidates"]');
  candA5.value = "540, 560, 540, abc";
  candA5.dispatch("input");
  t("混合草稿：非法词与重复值分别暂存",
    JSON.stringify(plan.mics[0].candInvalid) === '["abc"]' &&
    JSON.stringify(plan.mics[0].candDups) === "[540]");
  const mixedErr = $el("#mics").children[0].querySelector(".cand-err").textContent;
  t("混合草稿：提示同时含无法识别与重复频点",
    mixedErr.includes("无法识别") && mixedErr.includes("重复频点"));
  calls = [];
  await solvePlan();
  t("混合草稿：求解仍被拦截（未发请求）", calls.length === 0);

  // 7. 改正（未失焦）-> 合法列表立即提交，求解/保存提交新列表，API 格式不变
  const candA6 = $el("#mics").children[0].querySelector('[data-k="candidates"]');
  candA6.value = "530, 550";
  candA6.dispatch("input");
  t("改正未失焦：合法列表立即提交，重复/非法状态清除",
    JSON.stringify(plan.mics[0].candidates) === "[530,550]" &&
    plan.mics[0].candDups.length === 0 &&
    plan.mics[0].candInvalid.length === 0 &&
    plan.mics[0].candText === null);
  let solveBody = null;
  globalThis.__fetchImpl = (url, opts) => {
    solveBody = opts.body;
    return okJson(SOLVE_OK);
  };
  await solvePlan();
  const solved = JSON.parse(solveBody);
  t("改正后求解：提交改正后的新列表",
    JSON.stringify(solved.mics[0].candidates) === "[530,550]");
  t("改正后求解：API 请求体格式不变（仅 id/candidates/current/locked）",
    Object.keys(solved.mics[0]).sort().join(",") === "candidates,current,id,locked");
  t("改正后求解：结果重新上屏",
    state.result !== null && $el("#resultPanel").hidden === false);
  let savedBody = null;
  globalThis.__fetchImpl = (url, opts) => {
    savedBody = opts.body;
    return okJson({ id: 8, name: "重复草稿测试" });
  };
  await savePlan();
  t("改正后保存：提交改正后的新列表",
    JSON.stringify(JSON.parse(savedBody).mics[0].candidates) === "[530,550]");

  const failed = results.filter(([, ok]) => !ok).length;
  console.log("\\n" + (results.length - failed) + "/" + results.length + " 通过");
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error("驱动异常：", e);
  process.exit(1);
});
`;

try {
  // eslint-disable-next-line no-eval
  eval(src + "\n" + driver);
} catch (e) {
  console.error("加载被测代码失败：", e);
  process.exit(1);
}
