/* 结果归属规则的前端逻辑测试（Node 运行，DOM 以桩代替）。
 *
 * 运行：node tests/result_ownership.test.js
 *
 * 覆盖场景：
 *   1. 求解成功且输入未变   -> 结果上屏；
 *   2. 求解后编辑输入       -> 旧结果立即撤下；
 *   3. 求解期间编辑输入     -> 在途求解立即作废、按钮立即复位，过期成功响应被丢弃；
 *   4. 求解期间新建方案     -> 旧成功响应不回填；
 *   5. 求解期间打开另一方案 -> 旧失败响应不报错；
 *   6. 未改输入的保存       -> 不误删有效结果；
 *   7. 冲突/可行/最优结果   -> 如实上屏；
 *   8. 窗口缩放             -> 仅重绘仍属于当前输入的结果；
 *   9. 打开请求等待期       -> 旧求解响应不上屏，打开落地后切换为新方案；
 *  10. 打开失败             -> 保留当前编辑内容并报错；
 *  11. 连开两方案           -> 后发起的落地，先到的过期响应被丢弃。
 */
"use strict";

const fs = require("fs");
const path = require("path");

// --------------------------- DOM 桩 ---------------------------

const elements = {};
const winListeners = {};

function makeCtx() {
  // 画布 2D 上下文：任何方法调用都是空操作，属性可写
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

function makeEl(id) {
  return {
    id,
    hidden: false,
    disabled: false,
    checked: false,
    textContent: "",
    innerHTML: "",
    value: "",
    className: "",
    style: {},
    clientWidth: 1100,
    width: 1100,
    height: 320,
    addEventListener() {},
    querySelector(sel) {
      return makeEl(id + " " + sel);
    },
    querySelectorAll() {
      return [makeEl(id + "/q1"), makeEl(id + "/q2")];
    },
    appendChild() {},
    scrollIntoView() {},
    getContext() {
      return makeCtx();
    },
  };
}

global.document = {
  querySelector(sel) {
    if (!elements[sel]) elements[sel] = makeEl(sel);
    return elements[sel];
  },
  createElement: (tag) => makeEl("<" + tag + ">"),
  addEventListener() {},
  body: { appendChild() {} },
};
global.window = {
  devicePixelRatio: 1,
  addEventListener(type, fn) {
    (winListeners[type] = winListeners[type] || []).push(fn);
  },
};
global.confirm = () => true;

// 可控 fetch：被测代码内 fetch(...) 解析到全局，驱动用 __fetchImpl 换实现
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
globalThis.__fireResize = () =>
  (winListeners.resize || []).forEach((f) => f());

// --------------------------- 加载被测代码并驱动 ---------------------------

const src = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "app.js"),
  "utf8"
);

// 驱动代码与被测代码同一 eval 作用域，可直接访问其顶层绑定
// （state / plan / solvePlan / savePlan / loadPlan / newPlan /
//   onPlanEdited / drawSpectrum ...）
const driver = `
;(async function __drive__() {
  const results = [];
  const t = (name, cond) => {
    results.push([name, !!cond]);
    console.log((cond ? "PASS" : "FAIL") + "  " + name);
  };
  const $el = (sel) => document.querySelector(sel);
  const okJson = (data) => Promise.resolve({ ok: true, json: async () => data });
  const VALID_MICS = [
    { id: "A", candidates: [520, 540], current: null, locked: false },
    { id: "B", candidates: [525, 545], current: null, locked: false },
  ];
  const SOLVE_OK = {
    status: "optimal", optimal: true, assignedCount: 2, changeCount: 0,
    solveTimeMs: 5, timeLimitSec: 10, phases: [],
    assignment: [
      { id: "A", locked: false, current: null, assigned: true, frequency: 520, changed: false },
      { id: "B", locked: false, current: null, assigned: true, frequency: 545, changed: false },
    ],
    conflicts: [],
  };
  const setValidPlan = () => {
    $el("#planName").value = "测试方案";
    $el("#minGap").value = "5";
    $el("#imTolerance").value = "0";
    $el("#timeLimit").value = "10";
    plan.mics = VALID_MICS.map((m) => ({ ...m, candidates: [...m.candidates] }));
  };

  // 1. 求解成功且输入未变 -> 上屏
  setValidPlan();
  globalThis.__fetchImpl = () => okJson(SOLVE_OK);
  await solvePlan();
  t("求解成功且输入未变：结果上屏",
    state.result !== null && $el("#resultPanel").hidden === false);

  // 2. 求解后编辑输入 -> 立即撤下
  plan.mics[0].id = "A2";
  onPlanEdited();
  t("求解后改设备 ID：旧结果立即撤下",
    state.result === null && $el("#resultPanel").hidden === true);
  plan.mics[0].id = "A";

  // 3. 求解期间编辑输入 -> 在途求解立即作废，过期成功响应被丢弃
  const d1 = __deferred();
  globalThis.__fetchImpl = () => d1.p;
  const p1 = solvePlan();
  plan.mics[0].candidates = [521, 541];
  onPlanEdited();
  t("求解期间编辑：求解按钮立即复位（不必等迟到响应）",
    $el("#btnSolve").disabled === false);
  d1.resolve({ ok: true, json: async () => SOLVE_OK });
  await p1;
  t("求解期间改候选频点：过期成功响应不上屏",
    state.result === null && $el("#resultPanel").hidden === true);
  t("求解期间编辑：响应落地后按钮仍保持可用",
    $el("#btnSolve").disabled === false);

  // 4. 求解期间新建方案 -> 旧成功响应不回填
  plan.mics[0].candidates = [520, 540];
  const d2 = __deferred();
  globalThis.__fetchImpl = () => d2.p;
  const p2 = solvePlan();
  newPlan(false);
  d2.resolve({ ok: true, json: async () => SOLVE_OK });
  await p2;
  t("求解期间新建方案：旧成功响应不回填",
    state.result === null && $el("#resultPanel").hidden === true);
  t("新建方案后：求解按钮可用", $el("#btnSolve").disabled === false);

  // 5. 求解期间打开另一方案 -> 旧失败响应不报错
  setValidPlan();
  const d3 = __deferred();
  globalThis.__fetchImpl = (url) => {
    if (url === "/api/solve") return d3.p;
    if (url === "/api/plans/9") {
      return okJson({
        id: 9, name: "别方案",
        plan: {
          name: "别方案", minGap: 5, imTolerance: 0, timeLimit: 10,
          forbidden: [],
          mics: [
            { id: "C", candidates: [600, 610], current: null, locked: false },
            { id: "D", candidates: [620, 630], current: null, locked: false },
          ],
        },
      });
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  const p3 = solvePlan();
  await loadPlan(9);
  d3.reject(new Error("网络错误"));
  await p3;
  t("求解期间打开另一方案：旧失败响应不报错",
    !$el("#toast").textContent.includes("求解失败"));
  t("打开另一方案后：无结果残留",
    state.result === null && $el("#resultPanel").hidden === true);

  // 6. 未改输入的保存 -> 不误删有效结果
  const SOLVE_OK_2 = {
    ...SOLVE_OK,
    assignment: [
      { id: "C", locked: false, current: null, assigned: true, frequency: 600, changed: false },
      { id: "D", locked: false, current: null, assigned: true, frequency: 620, changed: false },
    ],
  };
  globalThis.__fetchImpl = (url) => {
    if (url === "/api/solve") return okJson(SOLVE_OK_2);
    if (url.startsWith("/api/plans")) return okJson({ id: 9, name: "别方案" });
    return Promise.reject(new Error("unexpected " + url));
  };
  await solvePlan();
  t("重新求解：结果上屏", state.result !== null);
  await savePlan();
  t("未改输入的保存：不误删有效结果",
    state.result !== null && $el("#resultPanel").hidden === false);

  // 7. 冲突结果如实上屏
  const CONFLICT = {
    status: "conflict",
    conflicts: [{ devices: ["C"], rule: "禁用频点", detail: "锁定设备 C 落入禁用区间" }],
  };
  globalThis.__fetchImpl = () => okJson(CONFLICT);
  await solvePlan();
  t("冲突结果如实上屏",
    state.result !== null && state.result.data.status === "conflict" &&
    $el("#resultPanel").hidden === false);

  // 7b. 可行解（未证最优）如实上屏
  const FEASIBLE = { ...SOLVE_OK_2, status: "feasible", optimal: false };
  globalThis.__fetchImpl = () => okJson(FEASIBLE);
  await solvePlan();
  t("可行解（未证最优）如实上屏",
    state.result !== null && state.result.data.optimal === false &&
    $el("#resultPanel").hidden === false);

  // 8. 窗口缩放：仅重绘仍属于当前输入的结果
  globalThis.__fetchImpl = () => okJson(SOLVE_OK_2);
  await solvePlan();
  t("冲突后重新求解：最优结果照常上屏",
    state.result !== null && state.result.data.status === "optimal");
  let drew = 0;
  drawSpectrum = () => { drew++; };
  __fireResize();
  t("结果有效时缩放：重绘频谱", drew === 1);
  plan.mics[0].id = "C9";
  onPlanEdited();
  __fireResize();
  t("输入失效后缩放：撤下且不再混绘",
    drew === 1 && state.result === null && $el("#resultPanel").hidden === true);

  // 9. 打开请求等待期：旧求解响应不上屏，打开落地后切换为新方案
  setValidPlan();
  const dSolve9 = __deferred();
  const dLoad9 = __deferred();
  globalThis.__fetchImpl = (url) => {
    if (url === "/api/solve") return dSolve9.p;
    if (url === "/api/plans/10") return dLoad9.p;
    return Promise.reject(new Error("unexpected " + url));
  };
  const pSolve9 = solvePlan();
  const pLoad9 = loadPlan(10); // 发起即作废旧求解，不等 GET 返回
  dSolve9.resolve({ ok: true, json: async () => SOLVE_OK });
  await pSolve9;
  t("打开等待期：旧求解成功响应不上屏",
    state.result === null && $el("#resultPanel").hidden === true);
  dLoad9.resolve({
    ok: true,
    json: async () => ({
      id: 10, name: "方案十",
      plan: {
        name: "方案十", minGap: 5, imTolerance: 0, timeLimit: 10,
        forbidden: [],
        mics: [
          { id: "E", candidates: [700, 710], current: null, locked: false },
          { id: "F", candidates: [720, 730], current: null, locked: false },
        ],
      },
    }),
  });
  await pLoad9;
  t("打开落地：切换为新方案",
    state.planId === 10 && plan.mics[0].id === "E");

  // 10. 打开失败：保留当前编辑内容并报错
  plan.mics[0].id = "E9";
  globalThis.__fetchImpl = (url) => {
    if (url === "/api/plans/404") {
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    }
    return Promise.reject(new Error("unexpected " + url));
  };
  await loadPlan(404);
  t("打开失败：保留当前编辑内容",
    plan.mics[0].id === "E9" && state.planId === 10);
  t("打开失败：弹出错误提示",
    $el("#toast").textContent.includes("打开失败"));

  // 11. 连开两方案：后发起的落地，先到的过期响应被丢弃
  const PLAN_REC = (id, name, mics) => ({
    id, name,
    plan: { name, minGap: 5, imTolerance: 0, timeLimit: 10, forbidden: [], mics },
  });
  const dA11 = __deferred();
  const dB11 = __deferred();
  globalThis.__fetchImpl = (url) => {
    if (url === "/api/plans/20") return dA11.p;
    if (url === "/api/plans/21") return dB11.p;
    return Promise.reject(new Error("unexpected " + url));
  };
  const pA11 = loadPlan(20);
  const pB11 = loadPlan(21);
  dB11.resolve({
    ok: true,
    json: async () => PLAN_REC(21, "乙方案", [
      { id: "G", candidates: [800, 810], current: null, locked: false },
      { id: "H", candidates: [820, 830], current: null, locked: false },
    ]),
  });
  await pB11;
  t("连开两方案：后发起的请求落地",
    state.planId === 21 && plan.name === "乙方案");
  dA11.resolve({
    ok: true,
    json: async () => PLAN_REC(20, "甲方案", [
      { id: "I", candidates: [900, 910], current: null, locked: false },
      { id: "J", candidates: [920, 930], current: null, locked: false },
    ]),
  });
  await pA11;
  t("连开两方案：先到的过期响应被丢弃",
    state.planId === 21 && plan.name === "乙方案");

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
