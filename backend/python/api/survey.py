import csv
import json
import os
import statistics
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, Field

API_KEY = os.getenv("MVT_API_KEY")

SURVEY_DIR = Path(__file__).resolve().parent.parent / "survey_results"
SUBMISSIONS_DIR = SURVEY_DIR / "submissions"
LATENCY_CSV_PATH = SURVEY_DIR / "latency_log.csv"

_survey_lock = threading.Lock()
_latency_lock = threading.Lock()


async def verify_survey_api_key(
    header: str = Security(APIKeyHeader(name="X-API-Key", auto_error=False)),
):
    if not header:
        raise HTTPException(status_code=403, detail="Brak klucza API w nagłówku")
    safe_api_key = API_KEY or ""
    if header.strip() == safe_api_key.strip().strip('"').strip("'") and safe_api_key != "":
        return header
    raise HTTPException(status_code=403, detail="Niepoprawny klucz API")


def record_latency(
    user_id: int,
    model: str,
    source: str,
    duration_ms: float,
    items_count: int = 0,
) -> None:
    """Dopisuje pojedynczy pomiar czasu generowania rekomendacji do pliku CSV na serwerze."""
    try:
        SURVEY_DIR.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(timezone.utc).isoformat()
        with _latency_lock:
            needs_header = not LATENCY_CSV_PATH.exists() or LATENCY_CSV_PATH.stat().st_size == 0
            with open(LATENCY_CSV_PATH, "a", encoding="utf-8", newline="") as f:
                writer = csv.writer(f)
                if needs_header:
                    writer.writerow(["timestamp", "user_id", "model", "source", "duration_ms", "items_count"])
                writer.writerow([ts, int(user_id), str(model), str(source), round(float(duration_ms), 2), int(items_count)])
    except Exception as exc:
        print(f"[survey] Nie udało się zapisać pomiaru latency_log.csv: {exc}")


def _atomic_write_text(target_path: Path, text: str, encoding: str = "utf-8") -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.with_suffix(target_path.suffix + ".tmp")
    with open(tmp_path, "w", encoding=encoding, newline="") as f:
        f.write(text)
    os.replace(tmp_path, target_path)


def _atomic_write_csv(target_path: Path, header: list[str], rows: list[list]) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.with_suffix(".csv.tmp")
    with open(tmp_path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)
    os.replace(tmp_path, target_path)


def _rebuild_csvs() -> int:
    """Przebudowuje zbiorcze pliki CSV na podstawie wszystkich plików JSON w submissions/."""
    SUBMISSIONS_DIR.mkdir(parents=True, exist_ok=True)
    records = []
    for json_file in sorted(SUBMISSIONS_DIR.glob("user_*.json")):
        try:
            with open(json_file, "r", encoding="utf-8") as f:
                records.append(json.load(f))
        except Exception as exc:
            print(f"[survey] Pominięto uszkodzony plik {json_file.name}: {exc}")

    records.sort(key=lambda r: (str(r.get("submitted_at") or ""), int(r.get("user_id") or 0)))

    sub_rows = []
    set_rows = []
    fb_rows = []

    for rec in records:
        uid = rec.get("user_id")
        nick = rec.get("nickname") or ""
        email = rec.get("email") or ""
        submitted_at = rec.get("submitted_at") or ""

        sub_rows.append([
            uid,
            nick,
            email,
            rec.get("winner_label") or "",
            rec.get("winner_model") or "",
            1 if rec.get("ask_ai_used", True) else 0,
            rec.get("ask_ai_rating") if rec.get("ask_ai_rating") is not None else "",
            rec.get("ask_ai_comment") or "",
            rec.get("general_comment") or "",
            json.dumps(rec.get("blind_mapping") or {}, ensure_ascii=False),
            submitted_at,
        ])

        for sr in rec.get("set_ratings") or []:
            set_rows.append([
                uid,
                nick,
                sr.get("set_label") or "",
                sr.get("recommendation_type") or "",
                sr.get("relevance_rating"),
                sr.get("novelty_rating"),
                sr.get("diversity_rating"),
                sr.get("items_shown", 0),
                sr.get("thumbs_up_count", 0),
                sr.get("thumbs_down_count", 0),
                sr.get("precision_at_k") if sr.get("precision_at_k") is not None else "",
                submitted_at,
            ])

        for fb in rec.get("movie_feedback") or []:
            fb_rows.append([
                uid,
                nick,
                fb.get("set_label") or "",
                fb.get("recommendation_type") or "",
                fb.get("movie_id"),
                fb.get("rank") if fb.get("rank") is not None else "",
                1 if fb.get("is_relevant") else 0,
                submitted_at,
            ])

    _atomic_write_csv(
        SURVEY_DIR / "survey_submissions.csv",
        [
            "user_id", "nickname", "email", "winner_label", "winner_model",
            "ask_ai_used", "ask_ai_rating", "ask_ai_comment", "general_comment",
            "blind_mapping_json", "submitted_at",
        ],
        sub_rows,
    )
    _atomic_write_csv(
        SURVEY_DIR / "survey_set_ratings.csv",
        [
            "user_id", "nickname", "set_label", "recommendation_type",
            "relevance_rating", "novelty_rating", "diversity_rating",
            "items_shown", "thumbs_up_count", "thumbs_down_count",
            "precision_at_k", "submitted_at",
        ],
        set_rows,
    )
    _atomic_write_csv(
        SURVEY_DIR / "recommendation_feedback.csv",
        [
            "user_id", "nickname", "set_label", "recommendation_type",
            "movie_id", "rank", "is_relevant", "submitted_at",
        ],
        fb_rows,
    )
    return len(records)


class MovieFeedbackItem(BaseModel):
    movie_id: int
    recommendation_type: str
    set_label: str
    rank: Optional[int] = None
    is_relevant: int = Field(..., ge=0, le=1)


class SetRatingItem(BaseModel):
    set_label: str
    recommendation_type: str
    relevance_rating: int = Field(..., ge=1, le=5)
    novelty_rating: int = Field(..., ge=1, le=5)
    diversity_rating: int = Field(..., ge=1, le=5)
    items_shown: int = 0
    thumbs_up_count: int = 0
    thumbs_down_count: int = 0
    precision_at_k: Optional[float] = None


class SurveyBackupPayload(BaseModel):
    user_id: int
    nickname: Optional[str] = None
    email: Optional[str] = None
    blind_mapping: dict[str, str]
    winner_label: str
    winner_model: str
    ask_ai_used: bool = True
    ask_ai_rating: Optional[int] = Field(None, ge=1, le=5)
    ask_ai_comment: Optional[str] = None
    general_comment: Optional[str] = None
    submitted_at: str
    set_ratings: list[SetRatingItem]
    movie_feedback: list[MovieFeedbackItem]
    overwrite: bool = False


class SurveySyncPayload(BaseModel):
    submissions: list[SurveyBackupPayload]


router = APIRouter(prefix="/survey", tags=["Survey"])


@router.post("/backup", dependencies=[Depends(verify_survey_api_key)])
def backup_survey_submission(payload: SurveyBackupPayload):
    """Zapisuje wynik ankiety użytkownika do pliku JSON i aktualizuje zbiorcze pliki CSV na serwerze."""
    target_path = SUBMISSIONS_DIR / f"user_{payload.user_id}.json"
    with _survey_lock:
        if target_path.exists() and not payload.overwrite:
            raise HTTPException(
                status_code=409,
                detail=f"Kopia ankiety dla user_id={payload.user_id} już istnieje na serwerze.",
            )
        data = payload.model_dump()
        data.pop("overwrite", None)
        _atomic_write_text(target_path, json.dumps(data, ensure_ascii=False, indent=2))
        total = _rebuild_csvs()
    return {"status": "saved", "user_id": payload.user_id, "total_submissions": total}


@router.post("/sync", dependencies=[Depends(verify_survey_api_key)])
def sync_survey_submissions(payload: SurveySyncPayload):
    """Synchronizuje pełny stan ankiet z bazy D1 do plików JSON i CSV na serwerze."""
    with _survey_lock:
        SUBMISSIONS_DIR.mkdir(parents=True, exist_ok=True)
        for item in payload.submissions:
            data = item.model_dump()
            data.pop("overwrite", None)
            target_path = SUBMISSIONS_DIR / f"user_{item.user_id}.json"
            _atomic_write_text(target_path, json.dumps(data, ensure_ascii=False, indent=2))
        total = _rebuild_csvs()
    return {"status": "synced", "synced_count": len(payload.submissions), "total_submissions": total}


@router.delete("/backup/{user_id}", dependencies=[Depends(verify_survey_api_key)])
def delete_survey_backup(user_id: int):
    """Usuwa kopię ankiety użytkownika (przy resecie przez administratora) i odbudowuje pliki CSV."""
    target_path = SUBMISSIONS_DIR / f"user_{user_id}.json"
    with _survey_lock:
        existed = target_path.exists()
        if existed:
            target_path.unlink()
        total = _rebuild_csvs()
    return {"status": "deleted", "existed": existed, "user_id": user_id, "total_submissions": total}


@router.get("/latency-stats", dependencies=[Depends(verify_survey_api_key)])
def get_latency_stats():
    """Zwraca zbiorcze statystyki czasu generowania (latency) per model z pliku latency_log.csv."""
    if not LATENCY_CSV_PATH.exists():
        return {"total_measurements": 0, "models": {}}

    grouped: dict[str, list[float]] = {}
    with _latency_lock:
        with open(LATENCY_CSV_PATH, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                model = (row.get("model") or "").strip()
                if not model:
                    continue
                try:
                    val = float(row.get("duration_ms") or 0.0)
                except ValueError:
                    continue
                grouped.setdefault(model, []).append(val)

    summary = {}
    for model, vals in grouped.items():
        summary[model] = {
            "count": len(vals),
            "mean_ms": round(statistics.mean(vals), 2),
            "median_ms": round(statistics.median(vals), 2),
            "min_ms": round(min(vals), 2),
            "max_ms": round(max(vals), 2),
        }

    return {
        "total_measurements": sum(len(v) for v in grouped.values()),
        "models": summary,
    }
