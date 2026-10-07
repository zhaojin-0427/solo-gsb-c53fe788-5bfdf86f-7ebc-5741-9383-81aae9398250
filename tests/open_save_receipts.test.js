/* 打开与连续保存的回执归属回归测试（Node 运行，DOM 以桩代替）。
 *
 * 运行：node tests/open_save_receipts.test.js
 *
 * 修复前：
 *   A. loadPlan 在打开请求发起时递增 saveSeq，savePlan 随后再递增——
 *      打开 B 的 GET 待返回时保存旧页 A，B 先落地而 A 的 POST/PUT 后到，
 *      序号判断认为 A 的回执“仍是最新”，把 A 的 ID 绑到 B 的页面，
 *      后续保存误写 A；
 *   B. 同一新方案连发两次 POST，较早成功、较新失败时，序号判断把较早
 *      成功回执当作过期响应丢弃，已创建 ID 丢失，后续保存重复新建。
 *
 * 修复后应满足：
 *   1. 打开等待期保存旧页，B 先落地：旧页回执只留服务端结果——不抢绑、
 *      不覆盖名称、不弹提示；后续保存覆盖 B 而非 A；
 *   2. 打开等待期保存旧页，B 打开失败：保留当前编辑内容与原有绑定，
 *      旧页保存回执照常落地（绑定/回写名称/提示）；
 *   3. 打开等待期保存未绑定新页（POST），B 落地后回执到达：不绑定，
 *      后续保存覆盖 B，不落到旧回执创建的 ID；
 *   4. 同一新方案连发两次 POST：较新失败先到、较早成功后到——较早
 *      成功 ID 仍绑定，后续保存覆盖该 ID（PUT），不重复新建；
 *   5. 同一新方案连发两次 POST：较早成功先到（较新在途）暂不绑定，
 *      较新失败后到——补绑较早成功 ID，后续保存覆盖该 ID；
 *   6. 较新绑定已落地：旧失败回执不报错、不回退绑定；
 *   7. 正常打开-编辑-保存覆盖流程不受影响。
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
const driver = `
;(async function __drive__() {
  const results = [];
  const t = (name, cond) => {
    results.push([name, !!cond]);
    console.log((cond ? "PASS" : "FAIL") + "  " + name);
  };
  const $el = (sel) => document.querySelector(sel);
  const okJson = (data) => Promise.resolve({ ok: true, json: async () => data });
  const errJson = (status, detail) =>
    Promise.resolve({ ok: false, status, json: async () => ({ detail }) });
  const VALID_MICS = [
    { id: "A", candidates: [520, 540], current: null, locked: false },
    { id: "B", candidates: [525, 545], current: null, locked: false },
  ];
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
  // 让当前页绑定到已保存方案 A（id 5）
  const bindPlanA = async () => {
    newPlan(false);
    setValidPlan("甲方案");
    globalThis.__fetchImpl = (url, opts) => {
      if (url === "/api/plans" && opts.method === "POST")
        return okJson({ id: 5, name: "甲方案" });
      return unexpected(url);
    };
    await savePlan();
  };

  // 1. 打开等待期保存旧页 A（PUT），B 先落地，A 的回执后到
  await bindPlanA();
  const dGetB1 = __deferred();
  const dPutA1 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/9") return dGetB1.p;
    if (url === "/api/plans/5" && opts.method === "PUT") return dPutA1.p;
    return unexpected(url);
  };
  const pLoad1 = loadPlan(9);       // 发起打开 B（GET 在途）
  const pSaveA1 = savePlan();       // 等待期内保存旧页 A（PUT 在途）
  dGetB1.resolve({ ok: true, json: async () => PLAN_B_REC });
  await pLoad1;                     // B 先落地
  t("打开等待期保存旧页：B 先落地，当前页为 B",
    state.planId === 9 && plan.name === "乙方案");
  $el("#toast").textContent = "";
  dPutA1.resolve({ ok: true, json: async () => ({ id: 5, name: "甲方案" }) });
  await pSaveA1;                    // A 的回执后到
  t("B 落地后旧页回执：不抢绑（仍绑定 B）", state.planId === 9);
  t("B 落地后旧页回执：名称框不被旧名覆盖",
    $el("#planName").value === "乙方案");
  t("B 落地后旧页回执：不弹保存成功提示",
    !$el("#toast").textContent.includes("已保存"));
  let url1 = null, method1 = null;
  globalThis.__fetchImpl = (url, opts) => {
    url1 = url; method1 = opts.method;
    return okJson({ id: 9, name: "乙方案" });
  };
  await savePlan();
  t("B 落地后旧页回执：后续保存覆盖 B 而非 A",
    url1 === "/api/plans/9" && method1 === "PUT");

  // 2. 打开等待期保存旧页 A，B 打开失败：A 的回执照常落地
  await bindPlanA();
  const dGetB2 = __deferred();
  const dPutA2 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/404") return dGetB2.p;
    if (url === "/api/plans/5" && opts.method === "PUT") return dPutA2.p;
    return unexpected(url);
  };
  plan.mics[0].candidates = [521, 541]; // 打开前留下编辑痕迹
  onPlanEdited();
  const pLoad2 = loadPlan(404);
  const pSaveA2 = savePlan();
  dGetB2.resolve({ ok: false, status: 404, json: async () => ({}) });
  await pLoad2;                     // B 打开失败
  t("打开失败：保留当前编辑内容与原有绑定",
    state.planId === 5 && plan.mics[0].candidates[0] === 521);
  t("打开失败：弹出错误提示",
    $el("#toast").textContent.includes("打开失败"));
  $el("#toast").textContent = "";
  dPutA2.resolve({ ok: true, json: async () => ({ id: 5, name: "甲方案" }) });
  await pSaveA2;                    // A 的保存回执到达：页面未切换，照常落地
  t("打开失败后旧页回执：绑定保持 A", state.planId === 5);
  t("打开失败后旧页回执：照常提示保存成功",
    $el("#toast").textContent.includes("已保存"));
  let url2 = null, method2 = null;
  globalThis.__fetchImpl = (url, opts) => {
    url2 = url; method2 = opts.method;
    return okJson({ id: 5, name: "甲方案" });
  };
  await savePlan();
  t("打开失败后：后续保存仍覆盖 A",
    url2 === "/api/plans/5" && method2 === "PUT");

  // 3. 打开等待期保存未绑定新页（POST），B 落地后回执到达：不绑定
  newPlan(false);
  setValidPlan("未保存页");
  const dGetB3 = __deferred();
  const dPost3 = __deferred();
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans/9") return dGetB3.p;
    if (url === "/api/plans" && opts.method === "POST") return dPost3.p;
    return unexpected(url);
  };
  const pLoad3 = loadPlan(9);
  const pSave3 = savePlan();        // POST 创建旧页方案（在途）
  dGetB3.resolve({ ok: true, json: async () => PLAN_B_REC });
  await pLoad3;
  $el("#toast").textContent = "";
  dPost3.resolve({ ok: true, json: async () => ({ id: 12, name: "未保存页" }) });
  await pSave3;
  t("POST 回执晚于打开落地：不绑定旧页创建的 ID", state.planId === 9);
  t("POST 回执晚于打开落地：不弹保存成功提示",
    !$el("#toast").textContent.includes("已保存"));
  let url3 = null, method3 = null;
  globalThis.__fetchImpl = (url, opts) => {
    url3 = url; method3 = opts.method;
    return okJson({ id: 9, name: "乙方案" });
  };
  await savePlan();
  t("POST 回执晚于打开落地：后续保存覆盖 B，不落到旧回执的 ID",
    url3 === "/api/plans/9" && method3 === "PUT");

  // 4. 同一新方案连发两次 POST：较新失败先到、较早成功后到
  newPlan(false);
  setValidPlan("连发");
  const d41 = __deferred(), d42 = __deferred();
  let postCount4 = 0;
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts.method === "POST") {
      postCount4++;
      return postCount4 === 1 ? d41.p : d42.p;
    }
    return unexpected(url);
  };
  const p41 = savePlan();
  const p42 = savePlan();
  $el("#toast").textContent = "";
  d42.resolve({ ok: false, status: 500, json: async () => ({ detail: "冲突" }) });
  await p42;                        // 较新保存失败先到
  t("连发 POST 较新失败：照常报错",
    $el("#toast").textContent.includes("保存失败"));
  d41.resolve({ ok: true, json: async () => ({ id: 19, name: "连发" }) });
  await p41;                        // 较早成功后到：ID 不得被丢弃
  t("连发 POST 较新失败：较早成功 ID 仍绑定", state.planId === 19);
  let url4 = null, method4 = null;
  globalThis.__fetchImpl = (url, opts) => {
    url4 = url; method4 = opts.method;
    return okJson({ id: 19, name: "连发" });
  };
  await savePlan();
  t("连发 POST 较新失败：后续保存覆盖已创建 ID，不重复新建",
    url4 === "/api/plans/19" && method4 === "PUT");

  // 5. 同一新方案连发两次 POST：较早成功先到（较新在途），较新失败后到
  newPlan(false);
  setValidPlan("连发2");
  const d51 = __deferred(), d52 = __deferred();
  let postCount5 = 0;
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts.method === "POST") {
      postCount5++;
      return postCount5 === 1 ? d51.p : d52.p;
    }
    return unexpected(url);
  };
  const p51 = savePlan();
  const p52 = savePlan();
  d51.resolve({ ok: true, json: async () => ({ id: 21, name: "连发2" }) });
  await p51;                        // 较早成功先到，较新在途：暂不绑定
  t("连发 POST 较早成功先到（较新在途）：暂不绑定",
    state.planId === null);
  $el("#toast").textContent = "";
  d52.resolve({ ok: false, status: 500, json: async () => ({ detail: "超时" }) });
  await p52;                        // 较新失败：补绑较早成功 ID
  t("连发 POST 较新失败：补绑较早成功 ID", state.planId === 21);
  t("连发 POST 较新失败：照常报错",
    $el("#toast").textContent.includes("保存失败"));
  let url5 = null, method5 = null;
  globalThis.__fetchImpl = (url, opts) => {
    url5 = url; method5 = opts.method;
    return okJson({ id: 21, name: "连发2" });
  };
  await savePlan();
  t("连发 POST 较新失败：后续保存覆盖补绑的 ID，不重复新建",
    url5 === "/api/plans/21" && method5 === "PUT");

  // 6. 较新绑定已落地：旧失败回执不报错、不回退绑定
  newPlan(false);
  setValidPlan("连保3");
  const d61 = __deferred(), d62 = __deferred();
  let postCount6 = 0;
  globalThis.__fetchImpl = (url, opts) => {
    if (url === "/api/plans" && opts.method === "POST") {
      postCount6++;
      return postCount6 === 1 ? d61.p : d62.p;
    }
    return unexpected(url);
  };
  const p61 = savePlan();
  const p62 = savePlan();
  d62.resolve({ ok: true, json: async () => ({ id: 30, name: "连保3" }) });
  await p62;                        // 较新成功先落地
  t("较新绑定已落地", state.planId === 30);
  $el("#toast").textContent = "";
  d61.resolve({ ok: false, status: 500, json: async () => ({ detail: "旧失败" }) });
  await p61;                        // 旧失败回执后到
  t("旧失败回执：不回退较新绑定", state.planId === 30);
  t("旧失败回执：不向当前页报错",
    !$el("#toast").textContent.includes("保存失败"));

  // 7. 正常打开-编辑-保存覆盖流程
  globalThis.__fetchImpl = (url) => {
    if (url === "/api/plans/9") return okJson(PLAN_B_REC);
    return unexpected(url);
  };
  await loadPlan(9);
  t("正常打开：切换到 B", state.planId === 9 && plan.name === "乙方案");
  $el("#planName").value = "乙方案改";
  plan.mics[0].candidates = [601, 611];
  onPlanEdited();
  let url7 = null, method7 = null, body7 = null;
  globalThis.__fetchImpl = (url, opts) => {
    url7 = url; method7 = opts.method; body7 = opts.body;
    return okJson({ id: 9, name: "乙方案改" });
  };
  await savePlan();
  t("正常覆盖保存：PUT 到当前方案",
    url7 === "/api/plans/9" && method7 === "PUT");
  t("正常覆盖保存：提交编辑后的内容",
    body7.includes("601") && body7.includes("乙方案改"));
  t("正常覆盖保存：绑定保持", state.planId === 9);

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
