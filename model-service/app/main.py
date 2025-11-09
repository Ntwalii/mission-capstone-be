# app/main.py
import os
import json
import logging
from typing import List, Optional, Dict, Any, Tuple

import numpy as np
import pandas as pd
import joblib
import psycopg2
from psycopg2.extras import execute_values

from fastapi import FastAPI, HTTPException, Query, Body
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import hashlib

# --------------------------------------------------------------
# .env (optional)
# --------------------------------------------------------------
try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:
    pass

# --------------------------------------------------------------
# Config / env
# --------------------------------------------------------------
PG_DSN = os.getenv("PG_DSN")
MODEL_PATH = os.getenv("MODEL_PATH", "models/model.pkl")
META_PATH = os.getenv("META_PATH", "models/model.meta.json")
DEFAULT_REPORTER = os.getenv("REPORTER_DEFAULT", "RWA")
MODEL_ID = int(os.getenv("MODEL_ID", "7"))
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO").upper()

logging.basicConfig(
    level=LOG_LEVEL,
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
log = logging.getLogger("trade-ml")

# --------------------------------------------------------------
# FastAPI app
# --------------------------------------------------------------
app = FastAPI(title="Trade ML Service", version="1.3.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=True,
)

# --------------------------------------------------------------
# DB helpers
# --------------------------------------------------------------
def pg_conn():
    if not PG_DSN:
        raise HTTPException(status_code=500, detail="PG_DSN not configured")
    return psycopg2.connect(PG_DSN)


def df_from_db(sql: str, params: Tuple = ()) -> pd.DataFrame:
    with pg_conn() as conn, conn.cursor() as cur:
        cur.execute(sql, params)
        cols = [d[0] for d in cur.description]
        rows = cur.fetchall()
    return pd.DataFrame(rows, columns=cols)

# --------------------------------------------------------------
# Deterministic “banded” randomness (15–28%)
# --------------------------------------------------------------
def _seeded_rand(key: str) -> float:
    h = hashlib.sha256(str(key).encode("utf-8")).digest()
    # use first 6 bytes for a stable integer, scale to 0..1
    n = int.from_bytes(h[:6], "big")
    return (n % 1_000_000) / 1_000_000.0

def banded_pct(key: str, min_v: float = 15.0, max_v: float = 28.0, dp: int = 1) -> float:
    r = _seeded_rand(key)
    v = min_v + r * (max_v - min_v)
    return round(v, dp)

def clamp(v: float, lo: float, hi: float) -> float:
    return max(lo, min(hi, v))

# --------------------------------------------------------------
# Model loading
# --------------------------------------------------------------
try:
    MODEL = joblib.load(MODEL_PATH)
    log.info(f"Model loaded from {MODEL_PATH}")
except Exception as e:
    log.error(f"Failed to load model: {e}")
    MODEL = None

try:
    with open(META_PATH, "r") as f:
        META = json.load(f)
except Exception as e:
    log.error(f"Failed to load meta: {e}")
    META = {}

# Force handle_unknown='ignore' on loaded OHE
def _fix_ohe(model):
    from sklearn.preprocessing import OneHotEncoder
    try:
        for step in model.named_steps.values():
            if hasattr(step, 'transformers'):
                for name, transformer, cols in step.transformers:
                    if isinstance(transformer, OneHotEncoder):
                        transformer.handle_unknown = 'ignore'
                    elif isinstance(transformer, (list, tuple)):
                        for t in transformer:
                            if isinstance(t, OneHotEncoder):
                                t.handle_unknown = 'ignore'
    except Exception:
        pass

_fix_ohe(MODEL)

XCOLS: List[str] = META.get("XCOLS", [])
TRAIN_GROUP_KEYS: List[str] = META.get(
    "group_keys", ["Product Code", "Trade Flow Code", "Partner ISO3"]
)
CONFIG_SNAPSHOT: Dict[str, Any] = META.get("config", {})
log.info(
    f"Model ready: {MODEL is not None}, XCOLS={len(XCOLS)}, group_keys={TRAIN_GROUP_KEYS}"
)

# --------------------------------------------------------------
# Key normalisation
# --------------------------------------------------------------
_PRETTY2RAW = {
    "Product Code": "product_code",
    "Trade Flow Code": "trade_flow_code",
    "Partner ISO3": "partner_iso3",
}
_RAW2PRETTY = {v: k for k, v in _PRETTY2RAW.items()}


def _normalize_keys(keys: List[str]) -> List[str]:
    out = []
    for k in keys:
        if isinstance(k, str):
            k2 = k.strip()
            if k2 and k2.lower() != "string":
                out.append(_PRETTY2RAW.get(k2, k2))
    return out


def _resolve_group_keys(user_keys: Optional[List[str]]) -> List[str]:
    trained_raw = _normalize_keys(TRAIN_GROUP_KEYS)
    if not user_keys:
        return TRAIN_GROUP_KEYS
    req_raw = _normalize_keys(user_keys)
    if not req_raw:
        return TRAIN_GROUP_KEYS
    if set(req_raw) == set(trained_raw):
        return TRAIN_GROUP_KEYS
    raise HTTPException(
        status_code=400,
        detail=f"group_keys mismatch. Provided {user_keys}, model trained on {TRAIN_GROUP_KEYS}.",
    )

# --------------------------------------------------------------
# Reporter resolution
# --------------------------------------------------------------
def resolve_reporter_id(
    year_from: int, year_to: int, reporter_iso3: Optional[str]
) -> Optional[int]:
    if reporter_iso3:
        df = df_from_db(
            "SELECT id FROM core.trade_partners WHERE UPPER(iso3)=UPPER(%s) LIMIT 1",
            (reporter_iso3,),
        )
        if not df.empty:
            return int(df.iloc[0]["id"])

    df = df_from_db(
        """
        SELECT reporter_id, COUNT(*) AS n
        FROM core.trade_data
        WHERE period_year BETWEEN %s AND %s AND reporter_id IS NOT NULL
        GROUP BY reporter_id ORDER BY n DESC LIMIT 1
        """,
        (year_from, year_to),
    )
    if not df.empty and df.iloc[0]["reporter_id"] is not None:
        return int(df.iloc[0]["reporter_id"])

    df = df_from_db(
        """
        SELECT reporter_id, COUNT(*) AS n
        FROM core.trade_data
        WHERE reporter_id IS NOT NULL
        GROUP BY reporter_id ORDER BY n DESC LIMIT 1
        """
    )
    if not df.empty and df.iloc[0]["reporter_id"] is not None:
        return int(df.iloc[0]["reporter_id"])
    return None

# --------------------------------------------------------------
# Data pulls
# --------------------------------------------------------------
BASE_SELECT = """
SELECT
  c.code             AS product_code,
  td.trade_flow_code AS trade_flow_code,
  tp.iso3            AS partner_iso3,
  td.period_year     AS year,
  SUM(td.value_usd)  AS tradevalue
FROM core.trade_data td
LEFT JOIN core.trade_partners tp ON tp.id = td.partner_id
LEFT JOIN core.commodities c ON c.id = td.commodity_id
WHERE td.reporter_id = %s
  AND td.period_year BETWEEN %s AND %s
  AND td.trade_flow_code IN (1,2)
GROUP BY 1,2,3,4
"""

def pull_panel(reporter_id: int, year_from: int, year_to: int) -> pd.DataFrame:
    df = df_from_db(BASE_SELECT, (reporter_id, year_from, year_to))
    if df.empty:
        return df
    df["year"] = pd.to_numeric(df["year"], errors="coerce").astype("Int64")
    df["tradevalue"] = pd.to_numeric(df["tradevalue"], errors="coerce").fillna(0.0)
    df["product_code"] = df["product_code"].astype("object")
    df["partner_iso3"] = df["partner_iso3"].astype("object")
    return df

def pull_panel_by_category(
    reporter_id: int,
    year_from: int,
    year_to: int,
    category_ilike: str,
    trade_flow_code: int = 2,
) -> pd.DataFrame:
    df = df_from_db(
        """
        SELECT
          c.code             AS product_code,
          td.trade_flow_code AS trade_flow_code,
          tp.iso3            AS partner_iso3,
          td.period_year     AS year,
          SUM(td.value_usd)  AS tradevalue
        FROM core.trade_data td
        JOIN core.commodities c     ON c.id  = td.commodity_id
        LEFT JOIN core.trade_partners tp ON tp.id = td.partner_id
        WHERE td.reporter_id = %s
          AND td.period_year BETWEEN %s AND %s
          AND td.trade_flow_code = %s
          AND c.category ILIKE %s
        GROUP BY 1,2,3,4
        """,
        (reporter_id, year_from, year_to, trade_flow_code, category_ilike),
    )
    if df.empty:
        return df
    df["year"] = pd.to_numeric(df["year"], errors="coerce").astype("Int64")
    df["tradevalue"] = pd.to_numeric(df["tradevalue"], errors="coerce").fillna(0.0)
    df["product_code"] = df["product_code"].astype("object")
    df["partner_iso3"] = df["partner_iso3"].astype("object")
    return df

# --------------------------------------------------------------
# Feature engineering (same logic you already use)
# --------------------------------------------------------------
def build_panel_and_features(df: pd.DataFrame, group_keys: List[str]):
    pretty2raw = _PRETTY2RAW
    gkeys = [pretty2raw.get(g, g) for g in group_keys]

    key_cols = gkeys + ["year"]
    panel = (
        df.groupby(key_cols, dropna=False)["tradevalue"]
        .sum()
        .reset_index()
        .sort_values("year")
    )

    all_years = sorted(panel["year"].dropna().unique().tolist())

    def expand(g):
        idx = pd.Index(all_years, name="year")
        g2 = g.set_index("year").reindex(idx)
        g2["tradevalue"] = g2["tradevalue"].fillna(0.0)
        for k in gkeys:
            g2[k] = g[k].iloc[0]
        return g2.reset_index()

    panel_full = (
        panel.groupby(gkeys, group_keys=False).apply(expand).reset_index(drop=True)
    )

    def add_features(g):
        g = g.sort_values("year").copy()
        g["log_y"] = np.log1p(g["tradevalue"].clip(lower=0))
        for L in (1, 2):
            g[f"lag_{L}"] = g["log_y"].shift(L)
        g["roll2_mean"] = g["log_y"].shift(1).rolling(2).mean()
        g["roll2_std"] = g["log_y"].shift(1).rolling(2).std()
        g["YoY_pct"] = (
            g["tradevalue"]
            .pct_change()
            .replace([np.inf, -np.inf], np.nan)
            .clip(-5, 5)
        )
        g["year_index"] = (g["year"] - g["year"].min()).astype(float)
        return g

    fe = (
        panel_full.groupby(gkeys, group_keys=False).apply(add_features).reset_index(drop=True)
    )
    trainable = fe.dropna(
        subset=["lag_1", "lag_2", "roll2_mean", "roll2_std"], how="any"
    )
    return gkeys, panel_full, fe, trainable

def _prepare_X_for_model(X: pd.DataFrame) -> pd.DataFrame:
    X = X.copy()
    for col in X.columns:
        if col in XCOLS:
            if X[col].dtype == "object" or pd.api.types.is_string_dtype(X[col]):
                X[col] = X[col].fillna("__NA__").astype(str)
            else:
                X[col] = pd.to_numeric(X[col], errors="coerce")
    X = X.replace([np.inf, -np.inf], np.nan)
    return X

# --------------------------------------------------------------
# Metrics helper
# --------------------------------------------------------------
def smape_percent(y_true: np.ndarray, y_pred: np.ndarray) -> float:
    y_true = np.asarray(y_true, float)
    y_pred = np.asarray(y_pred, float)
    denom = np.abs(y_true) + np.abs(y_pred) + 1e-9
    return float(np.mean(200.0 * np.abs(y_pred - y_true) / denom))

# --------------------------------------------------------------
# Pydantic schemas
# --------------------------------------------------------------
class Filters(BaseModel):
    reporter_iso3: Optional[str] = DEFAULT_REPORTER
    product_codes: Optional[List[str]] = None
    trade_flow_codes: Optional[List[int]] = None
    partners: Optional[List[str]] = None

class ForecastRequest(BaseModel):
    horizon_years: int = Field(3, ge=1, le=5)
    group_keys: Optional[List[str]] = None
    filters: Filters = Filters()
    write_to_db: bool = True

class AnomalyWindow(BaseModel):
    start_year: int
    end_year: int

class AnomalyRequest(BaseModel):
    group_keys: Optional[List[str]] = None
    window: AnomalyWindow
    filters: Filters = Filters()
    write_to_db: bool = True

class PredictItem(BaseModel):
    product_code: str
    trade_flow_code: int = 2
    partner_iso3: str
    year: int

# --------------------------------------------------------------
# Health
# --------------------------------------------------------------
@app.get("/healthz")
def healthz():
    return {
        "ok": MODEL is not None,
        "model_path": MODEL_PATH,
        "meta_path": META_PATH,
        "model_id": MODEL_ID,
        "trained_group_keys": TRAIN_GROUP_KEYS,
        "xcols_count": len(XCOLS),
    }

# -----------------------------------------------------------------
# NEW: /agri-products  (mirrors the Node mock; growth 15–28%)
# -----------------------------------------------------------------
@app.get("/agri-products")
def agri_products(
    year: Optional[int] = None,
    limit: int = Query(4, ge=1, le=50),
    reporter_iso3: Optional[str] = DEFAULT_REPORTER,
):
    start_year = int(CONFIG_SNAPSHOT.get("data_year_start", 2018))
    end_year = int(CONFIG_SNAPSHOT.get("data_year_end", 2022))
    cur_year = int(year or end_year)
    rid = resolve_reporter_id(start_year, end_year, reporter_iso3)
    if not rid:
        return []

    df = pull_panel(rid, cur_year - 3, cur_year)
    if df.empty:
        return []

    # keep exports only
    df = df[df["trade_flow_code"] == 2]

    # current year by product
    cur = (
        df[df["year"] == cur_year]
        .groupby("product_code", dropna=False)["tradevalue"]
        .sum()
        .reset_index(name="cur")
    )

    # previous 3 years
    hist = (
        df[df["year"].between(cur_year - 3, cur_year - 1)]
        .groupby(["product_code", "year"], dropna=False)["tradevalue"]
        .sum()
        .reset_index()
    )

    # median of history
    med = (
        hist.groupby("product_code", dropna=False)["tradevalue"]
        .median()
        .reset_index(name="med_prev")
    )

    merged = cur.merge(med, on="product_code", how="left").fillna({"med_prev": 0.0})
    # filter min thresholds, like Node version
    merged = merged[(merged["cur"] >= 5_000_000) & (merged["med_prev"] >= 5_000_000)]

    out = []
    for _, r in merged.iterrows():
        code = str(r["product_code"])
        g = banded_pct(f"{code}-{cur_year}-growth", 15, 28, 1)
        out.append({
            "product_code": code,
            "current_value_usd": int(round(float(r["cur"]))),
            "growth_pct": g,
        })

    out.sort(key=lambda x: x["growth_pct"], reverse=True)
    return out[:limit]

# -----------------------------------------------------------------
# NEW: /markets  (horizon-compounded growth; sorts by projected value)
# -----------------------------------------------------------------
@app.get("/markets")
def markets(
    year: Optional[int] = None,
    limit: int = Query(4, ge=1, le=50),
    horizon: int = Query(1, ge=1, le=3),
    includeNegative: bool = Query(False),
    reporter_iso3: Optional[str] = DEFAULT_REPORTER,
):
    start_year = int(CONFIG_SNAPSHOT.get("data_year_start", 2018))
    end_year = int(CONFIG_SNAPSHOT.get("data_year_end", 2022))
    cur_year = int(year or end_year)
    rid = resolve_reporter_id(start_year, end_year, reporter_iso3)
    if not rid:
        return []

    df = pull_panel(rid, cur_year - 3, cur_year)
    if df.empty:
        return []

    df = df[df["trade_flow_code"] == 2]

    # current year by partner
    cur = (
        df[df["year"] == cur_year]
        .groupby("partner_iso3", dropna=False)["tradevalue"]
        .sum()
        .reset_index(name="cur")
    )

    # prev 3y by partner
    hist = (
        df[df["year"].between(cur_year - 3, cur_year - 1)]
        .groupby(["partner_iso3", "year"], dropna=False)["tradevalue"]
        .sum()
        .reset_index()
    )
    med = (
        hist.groupby("partner_iso3", dropna=False)["tradevalue"]
        .median()
        .reset_index(name="med_prev")
    )

    merged = cur.merge(med, on="partner_iso3", how="left").fillna({"med_prev": 0.0})

    records = []
    for _, r in merged.iterrows():
        iso3 = str(r["partner_iso3"] or "").upper()
        cur_v = float(r["cur"] or 0)
        prev_med = float(r["med_prev"] or 0)
        if prev_med < 5_000_000 or cur_v < 5_000_000:
            continue

        # annual growth 15–28%, then compound by horizon
        g_annual = banded_pct(f"{iso3}-{cur_year}-market-annual", 15, 28, 1) / 100.0
        compounded = (1.0 + g_annual) ** horizon - 1.0
        compounded_pct = round(compounded * 100.0, 1)
        projected = int(round(cur_v * (1.0 + g_annual) ** horizon))

        if not includeNegative and compounded_pct <= 0:
            continue

        records.append({
            "partner_iso3": iso3,
            "current_value_usd": int(round(cur_v)),
            "projected_value_usd": projected,
            "growth_pct": compounded_pct,
        })

    records.sort(key=lambda x: x["projected_value_usd"], reverse=True)
    return records[:limit]

# -----------------------------------------------------------------
# NEW: /insights  (simple mock, 76% confidence)
# -----------------------------------------------------------------
@app.get("/insights")
def insights(
    product_code: str = Query("", alias="product_code"),
    partner_iso3: str = Query("", alias="partner_iso3"),
    year: Optional[int] = None,
    category: Optional[str] = None,
    limit: int = Query(3, ge=1, le=25),
    seed: str = "",
):
    cats = ["growth", "risk", "share", "anomaly"]
    out = []
    for i in range(limit):
        if category in cats:
            cat = category
        else:
            idx = int(_seeded_rand(f"{seed}|{product_code}|{partner_iso3}|{year}|{i}") * len(cats))
            cat = cats[idx]

        if cat == "growth":
            pct = banded_pct(f"{seed}|{product_code}|{partner_iso3}|{year}|growth|{i}", 15, 28, 1)
        elif cat == "share":
            pct = round(1.0 + _seeded_rand(f"{seed}|share|{i}") * (35.0 - 1.0), 1)
        elif cat == "risk":
            pct = round(5.0 + _seeded_rand(f"{seed}|risk|{i}") * (40.0 - 5.0), 1)
        else:
            pct = round(0.5 + _seeded_rand(f"{seed}|anom|{i}") * (10.0 - 0.5), 1)

        out.append({
            "insight": f"{clamp(pct, 0.0, 100.0)}%",
            "confidence": 76,
            "category": cat,
        })
    return out

# -----------------------------------------------------------------
# /predict  (unchanged core – uses your model)
# -----------------------------------------------------------------
@app.post("/predict")
def predict(items: List[PredictItem] = Body(...)):
    if MODEL is None or not XCOLS:
        raise HTTPException(status_code=500, detail="Model not loaded or XCOLS missing")

    start_year = int(CONFIG_SNAPSHOT.get("data_year_start", 2018))
    end_year = int(CONFIG_SNAPSHOT.get("data_year_end", 2022))
    rid = resolve_reporter_id(start_year, end_year, DEFAULT_REPORTER)

    raw = pull_panel(rid, start_year, end_year)
    if raw.empty:
        return []

    gkeys, panel_full, fe, _ = build_panel_and_features(raw, TRAIN_GROUP_KEYS)

    wanted = []
    for it in items:
        mask = (
            (fe["product_code"].astype(str) == it.product_code)
            & (fe["partner_iso3"].astype(str).str.upper() == it.partner_iso3.upper())
            & (fe["trade_flow_code"].astype(int) == int(it.trade_flow_code))
        )
        g = fe.loc[mask].sort_values("year")
        if g.empty:
            continue
        base_min = int(g["year"].min())
        last = g.iloc[-1:].copy()
        last["year"] = int(it.year)
        last["year_index"] = float(int(it.year) - base_min)
        wanted.append(last)

    if not wanted:
        return []

    X = pd.concat(wanted, ignore_index=True).reindex(columns=XCOLS, fill_value=np.nan)
    X = _prepare_X_for_model(X)

    try:
        yhat_log = MODEL.predict(X)
    except Exception as e:
        log.warning(f"Predict failed ({e}), re-patching...")
        yhat_log = MODEL.predict(X)

    preds = np.expm1(np.maximum(0.0, yhat_log))

    out = []
    for i, it in enumerate(items):
        mask_panel = (
            (panel_full["product_code"].astype(str) == it.product_code)
            & (panel_full["partner_iso3"].astype(str).str.upper() == it.partner_iso3.upper())
            & (panel_full["trade_flow_code"].astype(int) == int(it.trade_flow_code))
        )
        latest_year = (
            int(panel_full.loc[mask_panel, "year"].max()) if mask_panel.any() else None
        )
        current_val = (
            float(
                panel_full.loc[
                    mask_panel & (panel_full["year"] == latest_year), "tradevalue"
                ].sum()
            )
            if latest_year
            else 0.0
        )
        pred = float(preds[i])
        growth = (
            None
            if current_val <= 0
            else round(100.0 * (pred - current_val) / current_val, 1)
        )

        out.append(
            {
                "product_code": it.product_code,
                "partner_iso3": it.partner_iso3.upper(),
                "year": int(it.year),
                "predicted_value_usd": pred,
                "current_value_usd": current_val,
                "growth_pct": growth,
            }
        )
    return out

# -----------------------------------------------------------------
# /forecast  (unchanged core – your model)
# -----------------------------------------------------------------
@app.post("/forecast")
def forecast(req: ForecastRequest):
    if MODEL is None or not XCOLS:
        raise HTTPException(status_code=500, detail="Model not loaded or XCOLS missing")

    group_keys = _resolve_group_keys(req.group_keys)
    start_year = int(CONFIG_SNAPSHOT.get("data_year_start", 2018))
    end_year = int(CONFIG_SNAPSHOT.get("data_year_end", 2022))
    rid = resolve_reporter_id(start_year, end_year, req.filters.reporter_iso3)

    raw = pull_panel(rid, start_year, end_year)
    if req.filters.product_codes:
        raw = raw[raw["product_code"].isin(req.filters.product_codes)]
    if req.filters.trade_flow_codes:
        raw = raw[raw["trade_flow_code"].isin(req.filters.trade_flow_codes)]
    if req.filters.partners:
        raw = raw[raw["partner_iso3"].isin(req.filters.partners)]

    if raw.empty:
        return {"model_id": MODEL_ID, "forecasts": []}

    gkeys, panel_full, fe, _ = build_panel_and_features(raw, group_keys)

    last_year = int(panel_full["year"].max())
    future_years = [last_year + i for i in range(1, req.horizon_years + 1)]

    futures = []
    for _, g in fe.groupby(
        [_PRETTY2RAW.get(k, k) for k in group_keys], group_keys=False
    ):
        g = g.sort_values("year")
        base_min = int(g["year"].min())
        last = g.iloc[-1:].copy()
        for fy in future_years:
            r = last.copy()
            r["year"] = fy
            r["year_index"] = float(fy - base_min)
            futures.append(r)

    future_df = pd.concat(futures, ignore_index=True) if futures else pd.DataFrame()
    if future_df.empty:
        return {"model_id": MODEL_ID, "forecasts": []}

    X = future_df.reindex(columns=XCOLS, fill_value=np.nan)
    X = _prepare_X_for_model(X)

    try:
        yhat_log = MODEL.predict(X)
    except Exception:
        yhat_log = MODEL.predict(X)

    future_df["value_pred_usd"] = np.expm1(np.maximum(0.0, yhat_log))

    gkeys_raw = [_PRETTY2RAW.get(k, k) for k in group_keys]
    rows = []
    for _, r in future_df.iterrows():
        row = {
            "year": int(r["year"]),
            "value_pred_usd": float(r["value_pred_usd"]),
        }
        for k in gkeys_raw:
            if k == "trade_flow_code":
                row[k] = int(r[k]) if pd.notna(r[k]) else None
            else:
                row[k] = None if pd.isna(r[k]) else str(r[k])
        rows.append(row)

    return {"model_id": MODEL_ID, "forecasts": rows}

# -----------------------------------------------------------------
# /anomalies  (unchanged)
# -----------------------------------------------------------------
@app.post("/anomalies")
def anomalies(req: AnomalyRequest):
    if MODEL is None or not XCOLS:
        raise HTTPException(status_code=500, detail="Model not loaded or XCOLS missing")

    group_keys = _resolve_group_keys(req.group_keys)
    start_year = int(req.window.start_year)
    end_year = int(req.window.end_year)
    if end_year < start_year:
        raise HTTPException(status_code=400, detail="end_year must be >= start_year")

    rid = resolve_reporter_id(start_year, end_year, req.filters.reporter_iso3)
    if not rid:
        raise HTTPException(status_code=400, detail="Unable to resolve reporter_id")

    raw = pull_panel(rid, start_year, end_year)
    if raw.empty:
        return {"anomalies": []}

    gkeys, panel_full, fe, _ = build_panel_and_features(raw, group_keys)

    fe_ready = fe.dropna(
        subset=["lag_1", "lag_2", "roll2_mean", "roll2_std"], how="any"
    ).copy()
    X = fe_ready.reindex(columns=XCOLS, fill_value=np.nan)
    X = _prepare_X_for_model(X)

    try:
        yhat_log = MODEL.predict(X)
    except Exception:
        yhat_log = MODEL.predict(X)

    fe_ready["expected"] = np.expm1(np.maximum(0.0, yhat_log))

    merged = fe_ready.merge(
        panel_full[gkeys + ["year", "tradevalue"]], on=gkeys + ["year"], how="left"
    )
    merged["residual"] = merged["tradevalue"] - merged["expected"]

    def mad_z(arr):
        arr = np.asarray(arr, float)
        med = np.nanmedian(arr)
        mad = np.nanmedian(np.abs(arr - med)) + 1e-6
        return 0.6745 * (arr - med) / mad

    merged["mad_z"] = merged.groupby(gkeys, group_keys=False)["residual"].transform(
        lambda s: mad_z(s.values)
    )
    MAD_Z = float(CONFIG_SNAPSHOT.get("mad_z_threshold", 3.5))
    merged["stl_flag"] = merged["mad_z"].abs() >= MAD_Z

    from sklearn.ensemble import IsolationForest
    feats = merged[["residual"]].copy().fillna(0.0)
    iso = IsolationForest(
        contamination=float(CONFIG_SNAPSHOT.get("iso_contamination", 0.03)),
        random_state=42,
    )
    merged["iso_flag"] = iso.fit_predict(feats) == -1
    merged["is_anomaly"] = merged[["stl_flag", "iso_flag"]].any(axis=1)

    rows = []
    for _, r in merged.iterrows():
        out = {
            "year": int(r["year"]),
            "actual_value_usd": float(r["tradevalue"]),
            "expected_value_usd": (
                None if pd.isna(r["expected"]) else float(r["expected"])
            ),
            "residual": None if pd.isna(r["residual"]) else float(r["residual"]),
            "deviation_pct": (
                None
                if (pd.isna(r["expected"]) or r["expected"] == 0)
                else float(100.0 * r["residual"] / r["expected"])
            ),
            "stl_flag": bool(r["stl_flag"]),
            "iso_flag": bool(r["iso_flag"]),
            "is_anomaly": bool(r["is_anomaly"]),
        }
        for k in gkeys:
            out[k] = (
                None
                if pd.isna(r[k])
                else (str(r[k]) if k != "trade_flow_code" else int(r[k]))
            )
        rows.append(out)

    return {"anomalies": rows}

# -----------------------------------------------------------------
# /model/insights  (unchanged)
# -----------------------------------------------------------------
@app.get("/model/insights")
def model_insights(
    sector: str = Query("Agriculture"),
    horizon: int = Query(2, ge=1, le=3),
    reporter_iso3: Optional[str] = DEFAULT_REPORTER,
):
    if MODEL is None or not XCOLS:
        raise HTTPException(status_code=500, detail="Model not loaded or XCOLS missing")

    start_year = int(CONFIG_SNAPSHOT.get("data_year_start", 2018))
    end_year = int(CONFIG_SNAPSHOT.get("data_year_end", 2022))
    rid = resolve_reporter_id(start_year, end_year, reporter_iso3)
    if not rid:
        raise HTTPException(status_code=400, detail="Unable to resolve reporter_id")

    raw = pull_panel_by_category(
        rid, start_year, end_year, sector, trade_flow_code=2
    )
    if raw.empty:
        return {
            "sector": sector,
            "baseline_year": end_year,
            "current_exports_usd": 0.0,
            "forecast": {},
            "model_confidence": 0.0,
            "smape_pct": None,
            "confidence_label": "Low",
        }

    group_keys = TRAIN_GROUP_KEYS
    gkeys, panel_full, fe, _ = build_panel_and_features(raw, group_keys)

    latest_year = int(panel_full["year"].max())

    fe_ready = fe.dropna(
        subset=["lag_1", "lag_2", "roll2_mean", "roll2_std"], how="any"
    ).copy()
    X_hist = fe_ready.reindex(columns=XCOLS, fill_value=np.nan)
    X_hist = _prepare_X_for_model(X_hist)

    try:
        yhat_log_hist = MODEL.predict(X_hist)
    except Exception:
        yhat_log_hist = MODEL.predict(X_hist)

    fe_ready["expected"] = np.expm1(np.maximum(0.0, yhat_log_hist))

    hist_eval = fe_ready.merge(
        panel_full[[_PRETTY2RAW.get(k, k) for k in group_keys] + ["year", "tradevalue"]],
        on=[_PRETTY2RAW.get(k, k) for k in group_keys] + ["year"],
        how="left",
        validate="many_to_one",
    )
    latest_rows = hist_eval[hist_eval["year"] == latest_year]
    current_exports = (
        float(latest_rows["tradevalue"].sum()) if not latest_rows.empty else 0.0
    )

    smape = None
    if not latest_rows.empty:
        smape = smape_percent(
            latest_rows["tradevalue"].values, latest_rows["expected"].values
        )
        model_conf = max(0.0, 1.0 - (smape / 200.0))
    else:
        model_conf = 0.0

    conf_label = "High" if model_conf >= 0.75 else ("Medium" if model_conf >= 0.5 else "Low")

    future_years = [latest_year + k for k in range(1, horizon + 1)]
    futures = []
    for _, g in fe.groupby(
        [_PRETTY2RAW.get(k, k) for k in group_keys], group_keys=False
    ):
        g = g.sort_values("year")
        base_min = int(g["year"].min())
        last = g.iloc[-1:].copy()
        for fy in future_years:
            r = last.copy()
            r["year"] = fy
            r["year_index"] = float(fy - base_min)
            futures.append(r)

    forecast_block = {}
    if futures:
        future_df = pd.concat(futures, ignore_index=True)
        X_future = future_df.reindex(columns=XCOLS, fill_value=np.nan)
        X_future = _prepare_X_for_model(X_future)

        try:
            yhat_log_future = MODEL.predict(X_future)
        except Exception:
            yhat_log_future = MODEL.predict(X_future)

        future_df["pred"] = np.expm1(np.maximum(0.0, yhat_log_future))
        for k, fy in enumerate(future_years, start=1):
            total_pred = float(future_df.loc[future_df["year"] == fy, "pred"].sum())
            growth_pct = (
                None
                if current_exports <= 0
                else round(100.0 * (total_pred - current_exports) / current_exports, 1)
            )
            forecast_block[f"y_plus_{k}"] = total_pred
            forecast_block[f"growth_{k}y_pct"] = growth_pct

    return {
        "sector": sector,
        "baseline_year": latest_year,
        "current_exports_usd": current_exports,
        "forecast": forecast_block,
        "model_confidence": round(model_conf, 3),
        "smape_pct": None if smape is None else round(smape, 2),
        "confidence_label": conf_label,
    }

# -----------------------------------------------------------------
# Other utility endpoints (unchanged)
# -----------------------------------------------------------------
@app.get("/commodities")
def list_commodities(limit: int = Query(50, ge=1, le=200), category: Optional[str] = None):
    if category:
        df = df_from_db(
            "SELECT id, code, COALESCE(NULLIF(name,''), code) AS name FROM core.commodities WHERE category ILIKE %s ORDER BY name ASC LIMIT %s",
            (category, limit),
        )
    else:
        df = df_from_db(
            "SELECT id, code, COALESCE(NULLIF(name,''), code) AS name FROM core.commodities ORDER BY name ASC LIMIT %s",
            (limit,),
        )
    return df.to_dict(orient="records")

@app.get("/countries")
def list_countries(
    withData: bool = Query(False),
    year: Optional[int] = None,
    trade_flow: str = Query("Export", regex="^(Export|Import)$"),
):
    if not withData:
        df = df_from_db("SELECT id, name, iso3 FROM core.trade_partners ORDER BY name ASC")
        return df.to_dict(orient="records")

    if year is None:
        raise HTTPException(status_code=400, detail="year is required when withData=true")

    flow = 2 if trade_flow.lower() == "export" else 1
    df = df_from_db(
        """
        SELECT DISTINCT tp.id, tp.name, tp.iso3
        FROM core.trade_data td
        JOIN core.trade_partners tp ON tp.id = td.partner_id
        WHERE td.period_year = %s
          AND td.trade_flow_code = %s
          AND tp.iso3 IS NOT NULL
          AND tp.name IS NOT NULL
        ORDER BY tp.name ASC
        """,
        (year, flow),
    )
    return df.to_dict(orient="records")

@app.get("/top-exports")
def top_exports(
    year: int,
    limit: int = Query(4, ge=1, le=50),
    category: Optional[str] = "Agriculture",
):
    flow_export = 2
    if category:
        rows = df_from_db(
            """
            SELECT c.id as commodityId, c.name as productName, c.category,
                   SUM(CASE WHEN td.period_year=%s THEN td.value_usd ELSE 0 END) AS cur,
                   SUM(CASE WHEN td.period_year=%s THEN td.value_usd ELSE 0 END) AS prev
            FROM core.trade_data td
            JOIN core.commodities c ON c.id=td.commodity_id
            WHERE td.trade_flow_code=%s
              AND c.category ILIKE %s
              AND td.period_year IN (%s, %s)
            GROUP BY c.id, c.name, c.category
            ORDER BY cur DESC
            LIMIT %s
            """,
            (year, year - 1, flow_export, category, year, year - 1, limit),
        )
    else:
        rows = df_from_db(
            """
            SELECT c.id as commodityId, c.name as productName, c.category,
                   SUM(CASE WHEN td.period_year=%s THEN td.value_usd ELSE 0 END) AS cur,
                   SUM(CASE WHEN td.period_year=%s THEN td.value_usd ELSE 0 END) AS prev
            FROM core.trade_data td
            JOIN core.commodities c ON c.id=td.commodity_id
            WHERE td.trade_flow_code=%s
              AND td.period_year IN (%s, %s)
            GROUP BY c.id, c.name, c.category
            ORDER BY cur DESC
            LIMIT %s
            """,
            (year, year - 1, flow_export, year, year - 1, limit),
        )

    out = []
    for i, r in rows.iterrows():
        cur = float(r["cur"] or 0)
        prev = float(r["prev"] or 0)
        growth = None if prev <= 0 else round(100.0 * (cur - prev) / prev, 1)
        out.append(
            {
                "rank": i + 1,
                "commodityId": int(r["commodityid"]),
                "productName": r["productname"],
                "category": r.get("category"),
                "value": cur,
                "valueFormatted": f"${round(cur/1e6):,}M",
                "growthPct": growth,
            }
        )
    return out

@app.get("/market-opportunities")
def market_opportunities(
    year: int,
    sector: Optional[str] = "Agriculture",
    limit: int = Query(3, ge=1, le=50),
    reporter_iso3: Optional[str] = DEFAULT_REPORTER,
):
    start_year = int(CONFIG_SNAPSHOT.get("data_year_start", 2018))
    end_year = int(CONFIG_SNAPSHOT.get("data_year_end", 2022))
    rid = resolve_reporter_id(start_year, end_year, reporter_iso3)
    if not rid:
        raise HTTPException(status_code=400, detail="Unable to resolve reporter_id")

    if sector:
        df = pull_panel_by_category(rid, year, year, sector, trade_flow_code=2)
    else:
        df = pull_panel(rid, year, year)
        df = df[df["trade_flow_code"] == 2]

    if df.empty:
        return []

    g = (
        df.groupby(["partner_iso3"], dropna=False)["tradevalue"]
        .sum()
        .reset_index()
        .sort_values("tradevalue", ascending=False)
        .head(limit)
    )

    nm = (
        df_from_db("SELECT iso3, name FROM core.trade_partners")
        .set_index("iso3")["name"]
        .to_dict()
    )

    out = []
    for _, r in g.iterrows():
        iso3 = str(r["partner_iso3"] or "").upper()
        out.append(
            {
                "partnerId": 0,
                "partnerName": nm.get(iso3, iso3),
                "iso3": iso3,
                "marketSize": float(r["tradevalue"]),
                "growthPct": None,
                "badge": "Growing",
            }
        )
    return out
