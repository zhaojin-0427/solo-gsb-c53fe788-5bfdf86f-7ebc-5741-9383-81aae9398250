"""无线话筒频点协调台 —— FastAPI 后端。

约束：
  * 锁定设备保留现用频点；
  * 任意两支已分配设备频差 >= d；
  * 任意互异三支 i,j,k 满足 |2*f_i - f_j - f_k| > g；
  * 禁用闭区间内的频点不得使用。

目标（按优先级）：
  1. 最大化已分配台数；
  2. 最小化已分配设备的现用频点变更台数；
  3. 按设备 ID 升序取频点序列最小（未分配视为大于所有候选频点）。
"""

from __future__ import annotations

import json
import sqlite3
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import List, Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from .solver import solve

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = Path(__file__).resolve().parent.parent / "data"
DATA_DIR.mkdir(exist_ok=True)
DB_PATH = DATA_DIR / "plans.db"

_lock = threading.Lock()


def get_db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    with get_db() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS plans (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now')),
                content TEXT NOT NULL
            )
            """
        )


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(title="无线话筒频点协调台", lifespan=lifespan)


# ----------------------------- 数据模型 -----------------------------


class ForbiddenBand(BaseModel):
    low: int = Field(..., description="禁用闭区间下限（含），正整数 kHz")
    high: int = Field(..., description="禁用闭区间上限（含），正整数 kHz")


class MicInput(BaseModel):
    id: str = Field(..., min_length=1, description="设备 ID，如 A、B、1")
    candidates: List[int] = Field(..., min_length=1, max_length=12)
    current: Optional[int] = Field(None, description="现用频点（须在候选中）")
    locked: bool = False

    @field_validator("id")
    @classmethod
    def _id_no_blank(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("设备 ID 不能为空")
        return v

    @field_validator("candidates")
    @classmethod
    def _candidates_valid(cls, v: List[int]) -> List[int]:
        if any(f <= 0 for f in v):
            raise ValueError("候选频点须为正整数 kHz")
        if len(set(v)) != len(v):
            raise ValueError("候选频点必须互异")
        return v


class PlanInput(BaseModel):
    name: str = Field(..., min_length=1)
    min_gap: int = Field(..., alias="minGap", ge=1, description="最小频差 d（正整数）")
    im_tolerance: int = Field(
        ..., alias="imTolerance", ge=0, description="互调容差 g（非负整数）"
    )
    time_limit: int = Field(
        ..., alias="timeLimit", ge=1, description="求解时限（正整数秒）"
    )
    forbidden: List[ForbiddenBand] = Field(default_factory=list)
    mics: List[MicInput] = Field(..., min_length=2, max_length=8)

    model_config = {"populate_by_name": True}

    @field_validator("name")
    @classmethod
    def _name_strip(cls, v: str) -> str:
        v = v.strip()
        if not v:
            raise ValueError("方案名称不能为空")
        return v

    @field_validator("forbidden")
    @classmethod
    def _bands_valid(cls, v: List[ForbiddenBand]) -> List[ForbiddenBand]:
        for b in v:
            if b.low <= 0 or b.high <= 0:
                raise ValueError("禁用区间频点须为正整数")
            if b.low > b.high:
                raise ValueError("禁用区间下限不能大于上限")
        return v

    @field_validator("mics")
    @classmethod
    def _mic_rules(cls, v: List[MicInput]) -> List[MicInput]:
        ids = [m.id for m in v]
        if len(set(ids)) != len(ids):
            raise ValueError("设备 ID 不得重复")
        for m in v:
            if m.current is not None and m.current not in m.candidates:
                raise ValueError(f"设备 {m.id} 的现用频点不在候选频点中")
            if m.locked and m.current is None:
                raise ValueError(f"锁定设备 {m.id} 必须填写现用频点")
        return v


# ----------------------------- 求解接口 -----------------------------


@app.post("/api/solve")
def solve_plan(plan: PlanInput):
    payload = plan.model_dump(by_alias=True)
    try:
        result = solve(payload)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return result


# ----------------------------- 方案存取 -----------------------------


def _row_to_plan(row: sqlite3.Row) -> dict:
    content = json.loads(row["content"])
    return {
        "id": row["id"],
        "name": row["name"],
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
        "plan": content,
    }


@app.get("/api/plans")
def list_plans():
    with get_db() as conn:
        rows = conn.execute(
            "SELECT id, name, created_at, updated_at FROM plans "
            "ORDER BY updated_at DESC, id DESC"
        ).fetchall()
    return [
        {
            "id": r["id"],
            "name": r["name"],
            "createdAt": r["created_at"],
            "updatedAt": r["updated_at"],
        }
        for r in rows
    ]


@app.post("/api/plans")
def create_plan(body: PlanInput):
    content = json.dumps(body.model_dump(by_alias=True), ensure_ascii=False)
    with _lock, get_db() as conn:
        cur = conn.execute(
            "INSERT INTO plans (name, content) VALUES (?, ?)",
            (body.name, content),
        )
        plan_id = cur.lastrowid
        row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
    return _row_to_plan(row)


@app.get("/api/plans/{plan_id}")
def get_plan(plan_id: int):
    with get_db() as conn:
        row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="方案不存在")
    return _row_to_plan(row)


@app.put("/api/plans/{plan_id}")
def update_plan(plan_id: int, body: PlanInput):
    content = json.dumps(body.model_dump(by_alias=True), ensure_ascii=False)
    with _lock, get_db() as conn:
        exists = conn.execute(
            "SELECT 1 FROM plans WHERE id = ?", (plan_id,)
        ).fetchone()
        if exists is None:
            raise HTTPException(status_code=404, detail="方案不存在")
        conn.execute(
            "UPDATE plans SET name = ?, content = ?, "
            "updated_at = datetime('now') WHERE id = ?",
            (body.name, content, plan_id),
        )
        row = conn.execute("SELECT * FROM plans WHERE id = ?", (plan_id,)).fetchone()
    return _row_to_plan(row)


@app.delete("/api/plans/{plan_id}")
def delete_plan(plan_id: int):
    with _lock, get_db() as conn:
        cur = conn.execute("DELETE FROM plans WHERE id = ?", (plan_id,))
    if cur.rowcount == 0:
        raise HTTPException(status_code=404, detail="方案不存在")
    return {"ok": True}


# ----------------------------- 静态页面 -----------------------------


@app.get("/")
def index():
    return FileResponse(BASE_DIR / "static" / "index.html")


app.mount("/static", StaticFiles(directory=BASE_DIR / "static"), name="static")
