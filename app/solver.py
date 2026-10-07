"""基于 OR-Tools CP-SAT 的频点协调求解器。

分三个优先级顺序求解（每阶段把上一阶段的最优值固定）：
  1) 最大化已分配台数；
  2) 最小化已分配设备的现用频点变更台数；
  3) 按设备 ID 升序对 (频点, 未分配哨兵) 序列做字典序最小化——
     未分配取“大于所有候选频点”的值 Fmax+1。
"""

from __future__ import annotations

import time
from itertools import combinations
from typing import Any, Dict, List, Optional, Tuple

from ortools.sat.python import cp_model


# ----------------------------- 工具 -----------------------------


def _in_forbidden(freq: int, bands: List[dict]) -> Optional[dict]:
    for b in bands:
        if b["low"] <= freq <= b["high"]:
            return b
    return None


def _ordered_triples(n: int):
    """所有互异三元组，源设备 i 任意，另两支取 j<k 去重对称性。"""
    for i in range(n):
        for j in range(n):
            if j == i:
                continue
            for k in range(j + 1, n):
                if k == i:
                    continue
                yield i, j, k


# ----------------------------- 锁定冲突预检 -----------------------------


def find_locked_conflicts(plan: Dict[str, Any]) -> List[Dict[str, Any]]:
    """锁定设备必须保留现用频点，故先静态检查它们与规则的冲突。"""
    conflicts: List[Dict[str, Any]] = []
    d = plan["minGap"]
    g = plan["imTolerance"]
    bands = plan.get("forbidden", [])
    locked = [m for m in plan["mics"] if m.get("locked")]

    # 锁定频点落入禁用闭区间（现用频点必须保留，禁用即冲突）
    for m in locked:
        band = _in_forbidden(m["current"], bands)
        if band is not None:
            conflicts.append(
                {
                    "devices": [m["id"]],
                    "rule": "禁用频点",
                    "detail": (
                        f"锁定设备 {m['id']} 必须保留的现用频点 {m['current']} kHz "
                        f"落在禁用闭区间 [{band['low']}, {band['high']}] 内"
                    ),
                }
            )

    # 两两最小频差
    for m1, m2 in combinations(locked, 2):
        diff = abs(m1["current"] - m2["current"])
        if diff < d:
            conflicts.append(
                {
                    "devices": [m1["id"], m2["id"]],
                    "rule": "最小频差",
                    "detail": (
                        f"锁定设备 {m1['id']}({m1['current']} kHz) 与 "
                        f"{m2['id']}({m2['current']} kHz) 频差为 {diff} kHz，"
                        f"小于最小频差 d = {d} kHz"
                    ),
                }
            )

    # 互调：任意互异 i,j,k，|2f_i - f_j - f_k| <= g
    for trio in combinations(locked, 3):
        for src in trio:
            others = [m for m in trio if m["id"] != src["id"]]
            val = 2 * src["current"] - others[0]["current"] - others[1]["current"]
            if abs(val) <= g:
                j, k = others
                conflicts.append(
                    {
                        "devices": [src["id"], j["id"], k["id"]],
                        "rule": "互调容差",
                        "detail": (
                            f"|2f_{src['id']} - f_{j['id']} - f_{k['id']}|"
                            f" = |2×{src['current']} - {j['current']} - "
                            f"{k['current']}| = {abs(val)} kHz ≤ g = {g} kHz"
                        ),
                    }
                )

    return conflicts


# ----------------------------- CP-SAT 模型 -----------------------------


class _Model:
    def __init__(self, plan: Dict[str, Any]):
        self.plan = plan
        self.mics = plan["mics"]
        self.n = len(self.mics)
        self.d = plan["minGap"]
        self.g = plan["imTolerance"]
        self.bands = plan.get("forbidden", [])
        self.fmax = max(f for m in self.mics for f in m["candidates"])
        self.sentinel = self.fmax + 1  # 未分配：大于所有候选频点

        self.allowed: List[List[int]] = [
            [f for f in m["candidates"] if _in_forbidden(f, self.bands) is None]
            for m in self.mics
        ]

        model = cp_model.CpModel()
        self.model = model

        self.x: List[Dict[int, Any]] = []
        self.a: List[Any] = []
        self.freq: List[Any] = []
        self.value: List[Any] = []
        self.changed: List[Any] = []

        for i, m in enumerate(self.mics):
            xi = {f: model.new_bool_var(f"x_{i}_{f}") for f in self.allowed[i]}
            self.x.append(xi)

            ai = model.new_bool_var(f"assigned_{i}")
            if xi:
                model.add(ai == sum(xi.values()))
            else:
                model.add(ai == 0)
            self.a.append(ai)

            fi = model.new_int_var(0, self.fmax, f"freq_{i}")
            model.add(fi == sum(f * var for f, var in xi.items()))
            self.freq.append(fi)

            # 已分配 -> 实际频点；未分配 -> 哨兵值
            vi = model.new_int_var(0, self.sentinel, f"value_{i}")
            model.add(vi == fi + self.sentinel * (1 - ai))
            self.value.append(vi)

            ci = model.new_bool_var(f"changed_{i}")
            cur = m.get("current")
            if cur is None:
                # 无现用频点，不存在“变更”
                model.add(ci == 0)
            elif cur in xi:
                # 仅统计已分配设备：未分配 -> 0；已分配且偏离现用 -> 1
                model.add(ci == 0).only_enforce_if(ai.negated())
                model.add(ci + xi[cur] == 1).only_enforce_if(ai)
            else:
                # 现用频点落入禁用区间不可使用：分配即变更
                model.add(ci == ai)
            self.changed.append(ci)

        self._add_locked()
        self._add_gap_constraints()
        self._add_im_constraints()

    def _add_locked(self) -> None:
        for i, m in enumerate(self.mics):
            if m.get("locked"):
                cur = m["current"]
                if cur in self.x[i]:
                    self.model.add(self.x[i][cur] == 1)

    def _add_gap_constraints(self) -> None:
        for i, j in combinations(range(self.n), 2):
            both = [self.a[i], self.a[j]]
            sep_lo = self.model.new_bool_var(f"gap_lo_{i}_{j}")
            sep_hi = self.model.new_bool_var(f"gap_hi_{i}_{j}")
            self.model.add(self.freq[i] - self.freq[j] >= self.d).only_enforce_if(
                both + [sep_lo]
            )
            self.model.add(self.freq[j] - self.freq[i] >= self.d).only_enforce_if(
                both + [sep_hi]
            )
            self.model.add(sep_lo + sep_hi <= 1)
            self.model.add(sep_lo + sep_hi == 1).only_enforce_if(both)

    def _add_im_constraints(self) -> None:
        for i, j, k in _ordered_triples(self.n):
            all_assigned = [self.a[i], self.a[j], self.a[k]]
            expr = 2 * self.freq[i] - self.freq[j] - self.freq[k]
            pos = self.model.new_bool_var(f"im_pos_{i}_{j}_{k}")
            neg = self.model.new_bool_var(f"im_neg_{i}_{j}_{k}")
            self.model.add(expr >= self.g + 1).only_enforce_if(
                all_assigned + [pos]
            )
            self.model.add(expr <= -self.g - 1).only_enforce_if(
                all_assigned + [neg]
            )
            self.model.add(pos + neg <= 1)
            self.model.add(pos + neg == 1).only_enforce_if(all_assigned)

    # -- 上阶段最优值固定 --
    def fix_count(self, count: int) -> None:
        self.model.add(sum(self.a) == count)

    def fix_changes(self, changes: int) -> None:
        self.model.add(sum(self.changed) == changes)

    def fix_value(self, idx: int, val: int) -> None:
        self.model.add(self.value[idx] == val)

    def add_hint(self, freqs: List[Optional[int]]) -> None:
        """freqs[i] 为频点或 None（未分配），作为 CP-SAT 热启动。"""
        hints = []
        for i, f in enumerate(freqs):
            chosen = False
            for cand, var in self.x[i].items():
                if f is not None and cand == f:
                    hints.append((var, 1))
                    chosen = True
                else:
                    hints.append((var, 0))
            if not chosen and f is not None and f not in self.x[i]:
                return  # 与禁用区间冲突的提示直接放弃
        for var, val in hints:
            self.model.add_hint(var, val)


def _extract(solver: cp_model.CpSolver, m: _Model) -> Tuple[List[Optional[int]], int, int]:
    freqs: List[Optional[int]] = []
    for i in range(m.n):
        if solver.value(m.a[i]):
            freqs.append(solver.value(m.freq[i]))
        else:
            freqs.append(None)
    count = sum(1 for f in freqs if f is not None)
    changes = sum(solver.value(v) for v in m.changed)
    return freqs, count, changes


# ----------------------------- 对外入口 -----------------------------


def solve(plan: Dict[str, Any]) -> Dict[str, Any]:
    conflicts = find_locked_conflicts(plan)
    if conflicts:
        return {"status": "conflict", "conflicts": conflicts}

    time_limit = float(plan["timeLimit"])
    deadline = time.monotonic() + time_limit
    started = time.monotonic()

    freqs: List[Optional[int]] = [None] * len(plan["mics"])
    best_count = 0
    best_changes = 0
    all_optimal = True
    phase_log: List[Dict[str, Any]] = []

    def run_phase(name: str, build_and_set, order: int) -> None:
        """构建一个新模型、设定目标并求解。"""
        nonlocal freqs, best_count, best_changes, all_optimal
        m = _Model(plan)
        build_and_set(m)
        m.add_hint(freqs)

        # 留出约 50ms 供 CP-SAT 收尾，保证整体不显著超出用户时限
        remaining = deadline - time.monotonic() - 0.05
        if remaining <= 0.0:
            all_optimal = False
            phase_log.append({"phase": name, "status": "TIME_LIMIT_REUSE",
                              "objective": None, "order": order})
            return

        solver = cp_model.CpSolver()
        solver.parameters.max_time_in_seconds = max(0.01, remaining)
        solver.parameters.num_search_workers = 8
        status = solver.solve(m.model)
        status_name = solver.StatusName(status)

        objective = None
        if status in (cp_model.OPTIMAL, cp_model.FEASIBLE):
            freqs, best_count, best_changes = _extract(solver, m)
            if status != cp_model.OPTIMAL:
                all_optimal = False
            if name == "max-assigned":
                objective = -best_count
            elif name == "min-changes":
                objective = best_changes
            else:
                objective = solver.objective_value
        elif status == cp_model.INFEASIBLE:
            # 理论上不会发生：上阶段解本身可行
            raise RuntimeError(f"阶段 {name} 判定不可行，请检查约束建模")
        else:
            # UNKNOWN / MODEL_INVALID 等：沿用热启动解，标记未证最优
            all_optimal = False
        phase_log.append(
            {
                "phase": name,
                "status": status_name,
                "objective": objective,
                "order": order,
            }
        )

    # 阶段 1：最大化已分配台数
    run_phase(
        "max-assigned",
        lambda m: m.model.minimize(
            -sum(m.a)
        ),
        1,
    )
    count_so_far = best_count

    # 阶段 2：最小化现用频点变更台数
    def phase2(m: _Model):
        m.fix_count(count_so_far)
        m.model.minimize(sum(m.changed))

    run_phase("min-changes", phase2, 2)

    # 阶段 3：按设备 ID 升序逐位字典序最小化
    for i in range(len(plan["mics"])):
        fixed_count = count_so_far
        fixed_changes = best_changes
        prefix = [(idx, f) for idx, f in enumerate(freqs[:i])]

        def phase3(m: _Model, i=i, fixed_count=fixed_count,
                   fixed_changes=fixed_changes, prefix=prefix):
            m.fix_count(fixed_count)
            m.fix_changes(fixed_changes)
            for idx, f in prefix:
                m.fix_value(idx, f if f is not None else m.sentinel)
            m.model.minimize(m.value[i])

        run_phase(f"lex-value-{plan['mics'][i]['id']}", phase3, 3)

    elapsed_ms = int((time.monotonic() - started) * 1000)

    mics = plan["mics"]
    assignment = []
    for i, mic in enumerate(mics):
        f = freqs[i]
        cur = mic.get("current")
        assignment.append(
            {
                "id": mic["id"],
                "locked": bool(mic.get("locked")),
                "current": cur,
                "assigned": f is not None,
                "frequency": f,
                "changed": f is not None and cur is not None and f != cur,
            }
        )

    return {
        "status": "optimal" if all_optimal else "feasible",
        "optimal": all_optimal,
        "assignedCount": best_count,
        "changeCount": best_changes,
        "solveTimeMs": elapsed_ms,
        "timeLimitSec": plan["timeLimit"],
        "phases": phase_log,
        "assignment": assignment,
        "conflicts": [],
    }
