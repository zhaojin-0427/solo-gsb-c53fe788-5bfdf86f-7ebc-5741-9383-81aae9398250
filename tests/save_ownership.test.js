/* 保存响应归属规则的前端逻辑测试（Node 运行，DOM 以桩代替）。
 *
 * 运行：node tests/save_ownership.test.js
 *
 * 修复前：savePlan 的响应（无论多晚到达）无条件回写当前页——保存 A 尚未
 * 返回便打开/新建 B 时，迟到的 A 响应会把 B 的编辑页绑到 A 的 ID 并覆盖
 * 名称，后续保存将 PUT 覆盖 A；连续保存时较早响应也会回退较新的绑定。
 *
 * 修复后应满足：
 *   1. 保存 A 未返回便打开 B：迟到的 A 成功响应不把 B 绑到 A，不覆盖名称，
 *      不弹成功提示；后续保存覆盖 B（PUT /api/plans/B）而非 A；
 *   2. 保存期间新建方案：旧成功响应不绑定新页面、不覆盖名称、不弹提示；
 *   3. 保存期间打开另一方案：旧失败响应不对当前页报错；
 *   4. 同一方案等待期继续编辑：成功创建的 ID 仍写回（后续保存覆盖同一
 *      方案），但旧名称不得覆盖新草稿；
 *   5. 连续保存：较早响应不得回退较新的绑定（无论到达先后）；
 *   6. 正常保存：绑定 ID、回写名称、弹出提示，且不误删有效协调结果；
 *   7. 当前保存失败：照常报错；
 *   8. 打开等待期内保存旧页：B 落地后 A 的迟到回执只留服务端结果——
 *      不抢绑定、不覆盖名称、不弹提示，后续保存覆盖 B；
 *   9. 打开等待期内保存旧页、打开失败：保留 A 的编辑内容与原有绑定，
 *      等待期内发出的保存回执仍正常落地；
 *  10. 同一新方案连发两次 POST：较早成功、较新失败时回收已创建 ID，
 *      后续保存覆盖同一方案（PUT），不重复新建（两种到达顺序）。
 */
"use strict";

const fs = require("fs");
const path = require("path");

// --------------------------- DOM 桩 ---------------------------

const elements = {};

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
global.window = { devicePixelRatio: 1, addEventListener() {} };
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

// --------------------------- 加载被测代码并驱动 ---------------------------

const src = fs.readFileSync(
  path.join(__dirname, "..", "app", "static", "app.js"),
  "utf8"
);

// 驱动代码与被测代码同一 eval 作用域，可直接访问其顶层绑定
// （state / plan / savePlan / loadPlan / newPlan / solvePlan / onPlanEdited ...）
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
  const PLAN_B_REC = {
    id: 9, name: "乙方案",
    plan: {
      name: "乙方案", minGap: 5, imTolerance: 0, timeLimit: 10, forbidden: [],
      mics: [
        { id: "C", candidates: [600, 610], current: null, locked: false },
        { id: "D", candidates: [620, 630], current: null, locked: false },
      ],
    },
  };
  const setValidPlan = (name) => {
    $el("#planName").value = name;
    $el("#minGap").value = "5";
    $el("#imTolerance").value = "0";
    $el("#timeLimit").value = "10";
    plan.mics = VALID_MICS.map((m) => ({ ...m, candidates: [...m.candidates] }));
  };
  const unexpected = (url) => Promise.reject(new Error("unexpected " + url));

  // 1. 保存 A 未返回便打开 B：迟到的 A 成功响应不把 B 绑到 A
  newPlan(false);
  setValidPlan("方案甲");
  const dSaveA = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts.method === "POST") return dSaveA.p;
    if (url === "/api/plans/9") return okJson(PLAN_B_REC);
    return unexpected(url);
  };
  const pSaveA = savePlan();   // POST 保存 A 在途
  await loadPlan(9);           // 发起即切换上下文：打开 B
  t("打开 B 落地：当前页为 B",
    state.planId === 9 && plan.name === "乙方案");
  $el("#toast").textContent = "";
  dSaveA.resolve({ ok: true, json: async () => ({ id: 3, name: "方案甲" }) });
  await pSaveA;
  t("迟到的 A 成功响应：B 的绑定不被抢（不绑到 A）",
    state.planId === 9);
  t("迟到的 A 成功响应：名称框不被旧名覆盖",
    $el("#planName").value === "乙方案");
  t("迟到的 A 成功响应：不弹保存成功提示",
    !$el("#toast").textContent.includes("已保存"));
  // 后续保存必须覆盖 B（PUT /api/plans/9），不得落到 A（POST 或 PUT /3）
  let putUrl = null, putMethod = null;
  globalThis.__fetchImpl = (url, opts) => {
    putUrl = url; putMethod = opts.method;
    return okJson({ id: 9, name: "乙方案" });
  };
  await savePlan();
  t("后续保存覆盖 B 而非 A",
    putUrl === "/api/plans/9" && putMethod === "PUT");

  // 2. 保存期间新建方案：旧成功响应不绑定新页面
  newPlan(false);
  setValidPlan("方案X");
  const dSaveX = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts.method === "POST") return dSaveX.p;
    return unexpected(url);
  };
  const pSaveX = savePlan();
  newPlan(false); // 新建：清空并切换上下文
  $el("#toast").textContent = "";
  dSaveX.resolve({ ok: true, json: async () => ({ id: 4, name: "方案X" }) });
  await pSaveX;
  t("保存期间新建：新页面不被绑到旧方案", state.planId === null);
  t("保存期间新建：名称框不被旧名覆盖",
    $el("#planName").value !== "方案X");
  t("保存期间新建：不弹保存成功提示",
    !$el("#toast").textContent.includes("已保存"));

  // 3. 保存期间打开另一方案：旧失败响应不对当前页报错
  newPlan(false);
  setValidPlan("方案Y");
  const dSaveY = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts.method === "POST") return dSaveY.p;
    if (url === "/api/plans/9") return okJson(PLAN_B_REC);
    return unexpected(url);
  };
  const pSaveY = savePlan();
  await loadPlan(9);
  $el("#toast").textContent = "";
  dSaveY.resolve({
    ok: false, status: 500, json: async () => ({ detail: "服务器错误" }),
  });
  await pSaveY;
  t("保存期间打开另一方案：旧失败响应不报错",
    !$el("#toast").textContent.includes("保存失败"));
  t("保存期间打开另一方案：当前绑定不受影响", state.planId === 9);

  // 4. 同一方案等待期继续编辑：ID 写回，旧名称不覆盖新草稿
  newPlan(false);
  setValidPlan("初名");
  const dSaveE = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts.method === "POST") return dSaveE.p;
    return unexpected(url);
  };
  const pSaveE = savePlan();
  // 等待期内继续编辑：改名 + 改候选频点（不切换方案上下文）
  $el("#planName").value = "新名";
  plan.mics[0].candidates = [521, 541];
  onPlanEdited();
  dSaveE.resolve({ ok: true, json: async () => ({ id: 7, name: "初名" }) });
  await pSaveE;
  t("等待期继续编辑：成功创建的 ID 仍写回（供后续覆盖保存）",
    state.planId === 7);
  t("等待期继续编辑：旧名称不覆盖新草稿",
    $el("#planName").value === "新名");
  let url2 = null, method2 = null;
  globalThis.__fetchImpl = (url, opts) => {
    url2 = url; method2 = opts.method;
    return okJson({ id: 7, name: "新名" });
  };
  await savePlan();
  t("后续保存覆盖同一方案（PUT 新建所得的 ID），不重复新建",
    url2 === "/api/plans/7" && method2 === "PUT");

  // 5. 连续保存：较早响应不得回退较新的绑定
  newPlan(false);
  setValidPlan("连保");
  const d1 = __deferred(), d2 = __deferred();
  let postCount = 0;
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts.method === "POST") {
      postCount++;
      return postCount === 1 ? d1.p : d2.p;
    }
    return unexpected(url);
  };
  const p1 = savePlan();
  const p2 = savePlan();
  d2.resolve({ ok: true, json: async () => ({ id: 20, name: "连保" }) });
  await p2;
  t("连续保存：较新响应先落地并绑定", state.planId === 20);
  d1.resolve({ ok: true, json: async () => ({ id: 19, name: "连保" }) });
  await p1;
  t("连续保存：较晚到达的较早响应不得回退绑定", state.planId === 20);
  // 另一到达顺序：较早响应先回来（新请求在途）同样不得绑定
  newPlan(false);
  setValidPlan("连保2");
  postCount = 0;
  const d3 = __deferred(), d4 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts.method === "POST") {
      postCount++;
      return postCount === 1 ? d3.p : d4.p;
    }
    return unexpected(url);
  };
  const p3 = savePlan();
  const p4 = savePlan();
  d3.resolve({ ok: true, json: async () => ({ id: 21, name: "连保2" }) });
  await p3;
  t("连续保存：较早响应先到（新请求在途）不绑定",
    state.planId === null);
  d4.resolve({ ok: true, json: async () => ({ id: 22, name: "连保2" }) });
  await p4;
  t("连续保存：较新响应落地后绑定", state.planId === 22);

  // 6. 正常保存：绑定 ID、回写名称、弹出提示，不误删有效协调结果
  newPlan(false);
  setValidPlan("测试方案");
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/solve") return okJson(SOLVE_OK);
    if (url === "/api/plans" && opts.method === "POST")
      return okJson({ id: 30, name: "测试方案" });
    return unexpected(url);
  };
  await solvePlan();
  t("求解成功：结果上屏",
    state.result !== null && $el("#resultPanel").hidden === false);
  $el("#toast").textContent = "";
  await savePlan();
  t("正常保存：绑定新 ID", state.planId === 30);
  t("正常保存：名称回写", $el("#planName").value === "测试方案");
  t("正常保存：弹出成功提示", $el("#toast").textContent.includes("已保存"));
  t("正常保存：不误删有效协调结果",
    state.result !== null && $el("#resultPanel").hidden === false);

  // 7. 当前保存失败：照常报错
  globalThis.__fetchImpl = () => Promise.resolve({
    ok: false, status: 500, json: async () => ({ detail: "磁盘满" }),
  });
  $el("#toast").textContent = "";
  await savePlan();
  t("当前保存失败：照常报错",
    $el("#toast").textContent.includes("保存失败"));

  // 8. 打开等待期内保存旧页：B 落地后，A 的迟到回执只留服务端结果
  newPlan(false);
  setValidPlan("方案A");
  const dLoadB = __deferred();
  const dSaveA2 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/9" && !opts) return dLoadB.p; // GET 打开 B
    if (url === "/api/plans" && (opts || {}).method === "POST") return dSaveA2.p;
    return unexpected(url);
  };
  const pLoadB = loadPlan(9);   // 发起打开 B（GET 在途）
  const pSaveA2 = savePlan();   // 等待期内保存旧页 A（POST 在途）
  dLoadB.resolve({ ok: true, json: async () => PLAN_B_REC });
  await pLoadB;
  t("打开等待期内保存旧页：B 正常落地",
    state.planId === 9 && plan.name === "乙方案");
  $el("#toast").textContent = "";
  dSaveA2.resolve({ ok: true, json: async () => ({ id: 3, name: "方案A" }) });
  await pSaveA2;
  t("等待期保存的迟到回执：不把 B 绑到 A", state.planId === 9);
  t("等待期保存的迟到回执：名称框不被旧名覆盖",
    $el("#planName").value === "乙方案");
  t("等待期保存的迟到回执：不弹保存成功提示",
    !$el("#toast").textContent.includes("已保存"));
  let url8 = null, method8 = null;
  globalThis.__fetchImpl = (url, opts) => {
    url8 = url; method8 = (opts || {}).method;
    return okJson({ id: 9, name: "乙方案" });
  };
  await savePlan();
  t("等待期保存后：后续保存覆盖 B 而非 A",
    url8 === "/api/plans/9" && method8 === "PUT");

  // 9. 打开等待期内保存旧页、打开失败：保留 A 的编辑与绑定，等待期保存仍落地
  newPlan(false);
  setValidPlan("方案A9");
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && (opts || {}).method === "POST")
      return okJson({ id: 40, name: "方案A9" });
    return unexpected(url);
  };
  await savePlan();
  t("前置：A 已保存并绑定 #40", state.planId === 40);
  const dLoadF = __deferred();
  const dSaveA9 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/9" && !opts) return dLoadF.p; // GET 打开 B
    if (url === "/api/plans/40" && (opts || {}).method === "PUT") return dSaveA9.p;
    return unexpected(url);
  };
  const pLoadF = loadPlan(9);   // 发起打开 B（GET 在途）
  const pSaveA9 = savePlan();   // 等待期内保存旧页 A（PUT /40 在途）
  dLoadF.resolve({ ok: false, status: 500, json: async () => ({}) });
  await pLoadF;
  t("打开失败：保留 A 的编辑内容与原有绑定",
    state.planId === 40 && plan.name === "方案A9");
  t("打开失败：弹出错误提示",
    $el("#toast").textContent.includes("打开失败"));
  $el("#toast").textContent = "";
  dSaveA9.resolve({ ok: true, json: async () => ({ id: 40, name: "方案A9" }) });
  await pSaveA9;
  t("打开失败：等待期发出的保存回执仍正常落地",
    state.planId === 40 && $el("#toast").textContent.includes("已保存"));

  // 10. 同一新方案连发两次 POST：较早成功、较新失败——回收已创建 ID
  // 顺序一：较早成功先到（较新在途）→ 暂不绑定；较新失败 → 回收该 ID
  newPlan(false);
  setValidPlan("连保3");
  let postN = 0;
  const e1 = __deferred(), e2 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && (opts || {}).method === "POST") {
      postN++;
      return postN === 1 ? e1.p : e2.p;
    }
    return unexpected(url);
  };
  const q1 = savePlan();
  const q2 = savePlan();
  e1.resolve({ ok: true, json: async () => ({ id: 50, name: "连保3" }) });
  await q1;
  t("较早成功先到（较新在途）：暂不绑定", state.planId === null);
  $el("#toast").textContent = "";
  e2.resolve({ ok: false, status: 500, json: async () => ({ detail: "冲突" }) });
  await q2;
  t("较新保存失败：照常报错",
    $el("#toast").textContent.includes("保存失败"));
  t("较新保存失败：回收较早创建的 ID", state.planId === 50);
  let url10 = null, method10 = null;
  globalThis.__fetchImpl = (url, opts) => {
    url10 = url; method10 = (opts || {}).method;
    return okJson({ id: 50, name: "连保3" });
  };
  await savePlan();
  t("回收后保存覆盖同一方案（PUT），不重复新建",
    url10 === "/api/plans/50" && method10 === "PUT");
  // 顺序二：较新失败先到，较早成功后到 → 成功回执直接采用已创建 ID
  newPlan(false);
  setValidPlan("连保4");
  postN = 0;
  const e3 = __deferred(), e4 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && (opts || {}).method === "POST") {
      postN++;
      return postN === 1 ? e3.p : e4.p;
    }
    return unexpected(url);
  };
  const q3 = savePlan();
  const q4 = savePlan();
  e4.resolve({ ok: false, status: 500, json: async () => ({ detail: "冲突" }) });
  await q4;
  t("较新失败先到：报错且暂无绑定",
    state.planId === null && $el("#toast").textContent.includes("保存失败"));
  e3.resolve({ ok: true, json: async () => ({ id: 51, name: "连保4" }) });
  await q3;
  t("较早成功后到（较新已失败）：直接采用已创建 ID", state.planId === 51);
  let url11 = null, method11 = null;
  globalThis.__fetchImpl = (url, opts) => {
    url11 = url; method11 = (opts || {}).method;
    return okJson({ id: 51, name: "连保4" });
  };
  await savePlan();
  t("采用后保存覆盖同一方案（PUT），不重复新建",
    url11 === "/api/plans/51" && method11 === "PUT");

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
