/* 控件草稿“键入即提交”的前端逻辑测试（Node 运行，迷你 DOM 支持事件触发）。
 *
 * 运行：node tests/draft_commit.test.js
 *
 * 与 result_ownership.test.js 的区别：那里的 DOM 桩不触发事件，只能直接改
 * plan 验证归属规则；这里模拟真实控件事件——候选频点文本框与禁用区间上下限
 * 键入（input）后尚未失焦（未触发 change），验证：
 *   1. 键入即提交：草稿立即写入 plan，不等失焦；
 *   2. 键入即撤下：旧结果立即从结果表与频谱撤下；
 *   3. 键入即作废：在途求解立即失效，迟到响应不上屏，按钮立即复位；
 *   4. 提交一致性：未失焦直接求解/保存，提交的是键入后的新值而非旧值；
 *   5. 失焦规整：change 时仍照常清理失效现用频点并重建卡片。
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

  // 通过界面控件录入（模拟用户键入，只触发 input，不触发 change）
  $el("#planName").value = "草稿测试";
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

  // 1. 键入即提交：草稿立即写入 plan，不等失焦
  t("键入即提交：候选频点立即写入 plan",
    JSON.stringify(plan.mics[0].candidates) === "[520,540]" &&
    JSON.stringify(plan.mics[1].candidates) === "[525,545]");

  // 求解上屏
  globalThis.__fetchImpl = () => okJson(SOLVE_OK);
  await solvePlan();
  t("求解成功：结果上屏",
    state.result !== null && $el("#resultPanel").hidden === false);

  // 2. 键入未失焦 -> 旧结果立即撤下，plan 已是新值
  candA.value = "521, 541";
  candA.dispatch("input"); // 只触发 input，未触发 change（未失焦）
  t("候选频点键入未失焦：plan 立即是新值",
    JSON.stringify(plan.mics[0].candidates) === "[521,541]");
  t("候选频点键入未失焦：旧结果立即撤下",
    state.result === null && $el("#resultPanel").hidden === true);

  // 3. 求解期间键入 -> 在途求解立即作废，迟到响应不上屏
  const d1 = __deferred();
  let solveBody = null;
  globalThis.__fetchImpl = (url, opts) => {
    solveBody = opts.body;
    return d1.p;
  };
  const p1 = solvePlan(); // 提交时界面为 521/541
  candA.value = "522, 542";
  candA.dispatch("input");
  t("求解期间键入：求解按钮立即复位",
    $el("#btnSolve").disabled === false);
  d1.resolve({ ok: true, json: async () => SOLVE_OK });
  await p1;
  t("求解期间键入：迟到成功响应不上屏",
    state.result === null && $el("#resultPanel").hidden === true);
  t("求解提交的是提交时刻的界面值",
    solveBody.includes("521") && solveBody.includes("541") &&
    !solveBody.includes("522"));

  // 4. 未失焦直接求解/保存 -> 提交键入后的新值，不用旧值
  globalThis.__fetchImpl = (url, opts) => {
    solveBody = opts.body;
    return okJson(SOLVE_OK);
  };
  await solvePlan(); // candA 仍为 "522, 542"，始终未失焦
  t("未失焦直接求解：提交键入后的新值",
    solveBody.includes("522") && solveBody.includes("542"));
  t("求解成功：结果重新上屏", state.result !== null);

  // 禁用区间上下限键入
  $el("#btnAddBand").dispatch("click"); // 默认追加 500~510
  t("添加禁用区间：旧结果立即撤下", state.result === null);
  const chip = $el("#bands").children[0];
  const [lo, hi] = chip.querySelectorAll("input");
  lo.value = "535";
  lo.dispatch("input");
  hi.value = "545";
  hi.dispatch("input");
  t("禁用区间键入未失焦：plan 立即更新",
    plan.forbidden[0].low === 535 && plan.forbidden[0].high === 545);

  let savedBody = null;
  globalThis.__fetchImpl = (url, opts) => {
    savedBody = opts.body;
    return okJson({ id: 1, name: "草稿测试" });
  };
  await savePlan(); // 上下限均未失焦
  t("未失焦直接保存：提交键入后的新值",
    savedBody.includes("535") && savedBody.includes("545") &&
    !savedBody.includes("500"));

  // 5. 失焦规整：change 时清理失效现用频点
  plan.mics[0].current = 522; // 现用频点在候选中
  candA.value = "600, 610";   // 键入不含 522 的新候选
  candA.dispatch("input");
  t("键入过程：现用频点暂不清理（等失焦规整）",
    plan.mics[0].current === 522);
  candA.dispatch("change");
  t("失焦规整：失效现用频点被清理",
    plan.mics[0].current === null);

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
