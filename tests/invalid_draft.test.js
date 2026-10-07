/* 候选频点非法草稿的前端逻辑测试（Node 运行，迷你 DOM 支持事件触发）。
 *
 * 运行：node tests/invalid_draft.test.js
 *
 * 修复前：在合法列表后键入非法词（如“ x”）且未失焦时，parseCandidates 静默
 * 丢弃非法词，plan 与指纹不变——旧结果不撤下、在途求解不作废、迟到响应可
 * 回填；失焦重绘还会抹去非法词，求解/保存悄悄提交旧列表。
 *
 * 修复后应满足：
 *   1. 非法词暂存：candInvalid 记录非法词、candText 保留文本框原文；
 *   2. 键入即撤下：任一草稿改动（含非法词）立即撤下旧结果、作废在途求解；
 *   3. 即时反馈：文本框标红并提示无法识别的原文词；
 *   4. 失焦不抹去：change 重绘后非法原文与提示仍在；
 *   5. 改正前拦截：求解与保存均不发请求并提示校验错误；
 *   6. 改正即恢复：合法列表未失焦提交，求解/保存提交改正后的新列表。
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

  // 0. 解析：合法词与非法词分离；重复合法词去重进入 values（重复值另记入
  //    dups 并拦截求解/保存，见 tests/duplicate_draft.test.js）
  const parsed = parseCandidates("520 x 3.5 0 -4 540 520");
  t("parseCandidates：合法/非法词分离，重复合法词仍去重",
    JSON.stringify(parsed.values) === "[520,540]" &&
    JSON.stringify(parsed.invalid) === '["x","3.5","0","-4"]' &&
    JSON.stringify(parsed.dups) === "[520]");

  // 通过界面控件录入合法方案（模拟用户键入，只触发 input，不触发 change）
  $el("#planName").value = "非法草稿测试";
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

  // 求解上屏，制造“已有有效结果”的状态
  globalThis.__fetchImpl = () => okJson(SOLVE_OK);
  await solvePlan();
  t("前置：求解成功，结果上屏",
    state.result !== null && $el("#resultPanel").hidden === false);

  // 1. 合法列表后键入非法别致的词（未失焦）-> 旧结果立即撤下，非法词暂存
  const fpBefore = planFingerprint();
  candA.value = "520, 540 x";
  candA.dispatch("input"); // 只触发 input，未触发 change（未失焦）
  t("非法词键入未失焦：旧结果立即撤下",
    state.result === null && $el("#resultPanel").hidden === true);
  t("非法词键入未失焦：指纹随草稿改动",
    planFingerprint() !== fpBefore);
  t("非法词暂存：candInvalid 记录非法词",
    JSON.stringify(plan.mics[0].candInvalid) === '["x"]');
  t("非法词暂存：文本框原文保留在 candText",
    plan.mics[0].candText === "520, 540 x");
  t("非法词键入未失焦：合法候选仍键入即提交",
    JSON.stringify(plan.mics[0].candidates) === "[520,540]");
  t("非法词键入未失焦：文本框标红并即时提示",
    candA.className.includes("invalid") &&
    cardA.querySelector(".cand-err").textContent.includes("“x”"));

  // 改正回合法草稿，准备求解期间场景
  candA.value = "520, 540";
  candA.dispatch("input");
  t("改正后：非法状态立即清除",
    plan.mics[0].candInvalid.length === 0 && plan.mics[0].candText === null &&
    !candA.className.includes("invalid") &&
    cardA.querySelector(".cand-err").textContent === "");

  // 2. 在途求解时键入非法词 -> 求解立即作废，迟到响应不上屏
  const d1 = __deferred();
  globalThis.__fetchImpl = () => d1.p;
  const p1 = solvePlan();
  candA.value = "520, 540 y";
  candA.dispatch("input");
  t("在途求解时键入非法词：求解按钮立即复位",
    $el("#btnSolve").disabled === false);
  d1.resolve({ ok: true, json: async () => SOLVE_OK });
  await p1;
  t("在途求解时键入非法词：迟到成功响应不上屏",
    state.result === null && $el("#resultPanel").hidden === true);

  // 3. 非法词未改正 -> 求解与保存均被拦截（不发请求，提示校验错误）
  const calls = [];
  globalThis.__fetchImpl = (url) => { calls.push(url); return okJson({}); };
  await solvePlan();
  t("非法词未改正：求解被拦截（未发请求）", calls.length === 0);
  t("非法词未改正：求解提示非法词校验错误",
    $el("#toast").textContent.includes("无法识别"));
  await savePlan();
  t("非法词未改正：保存被拦截（未发请求）", calls.length === 0);
  t("非法词未改正：保存提示非法词校验错误",
    $el("#toast").textContent.includes("无法识别"));

  // 4. 失焦重绘 -> 非法原文与校验提示保留，不被抹去
  candA.dispatch("change");
  t("失焦重绘：非法原文保留在 plan",
    plan.mics[0].candText === "520, 540 y" &&
    JSON.stringify(plan.mics[0].candInvalid) === '["y"]');
  const cardHtml = $el("#mics").children[0].innerHTML;
  t("失焦重绘：文本框回显非法原文且提示仍在",
    cardHtml.includes("520, 540 y") && cardHtml.includes("无法识别"));

  // 5. 改正非法词（未失焦）-> 合法列表立即提交，求解/保存提交新列表
  const candA2 = $el("#mics").children[0].querySelector('[data-k="candidates"]');
  candA2.value = "530, 550";
  candA2.dispatch("input");
  t("改正非法词未失焦：合法列表立即提交",
    JSON.stringify(plan.mics[0].candidates) === "[530,550]" &&
    plan.mics[0].candInvalid.length === 0 && plan.mics[0].candText === null);
  let solveBody = null;
  globalThis.__fetchImpl = (url, opts) => {
    solveBody = opts.body;
    return okJson(SOLVE_OK);
  };
  await solvePlan();
  t("改正后求解：提交改正后的新列表",
    solveBody.includes("530") && solveBody.includes("550") &&
    !solveBody.includes("520"));
  t("改正后求解：结果重新上屏",
    state.result !== null && $el("#resultPanel").hidden === false);
  let savedBody = null;
  globalThis.__fetchImpl = (url, opts) => {
    savedBody = opts.body;
    return okJson({ id: 7, name: "非法草稿测试" });
  };
  await savePlan();
  t("改正后保存：提交改正后的新列表",
    savedBody.includes("530") && savedBody.includes("550") &&
    !savedBody.includes("520"));

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
