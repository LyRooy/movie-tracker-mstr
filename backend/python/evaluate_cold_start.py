"""Skrypt ewaluacji offline problemu zimnego startu (User Cold Start) na realnych danych z D1.

Uruchomienie wewnątrz kontenera Python:
    docker exec -it python python evaluate_cold_start.py --exclude-users 1

Skrypt działa wyłącznie w trybie odczytu (nie zapisuje niczego do D1 ani nie nadpisuje modeli .pkl).
Wyniki (CSV i JSON) trafiają domyślnie do /app/survey_results/cold_start_eval/.
"""

import argparse
import csv
import json
import os
import sqlite3
import statistics
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
from sklearn.feature_extraction.text import TfidfVectorizer
from sklearn.metrics.pairwise import cosine_similarity
from surprise import Dataset, Reader, SVD

# Upewnij się, że katalog główny aplikacji (/app) jest na sys.path
APP_DIR = Path(__file__).resolve().parent
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))

from database.db_manager import DatabaseManager
from services.llm_recommender import LLMVectorRecommender
from services.model_manager import RecommendationModelManager

MODELS = [
    "collaborative_filtering",
    "content_based",
    "llm_querec",
    "hybrid_querec",
]

MODEL_SHORT = {
    "collaborative_filtering": "CF (SVD)",
    "content_based": "CB (TF-IDF)",
    "llm_querec": "LLM (QueRec)",
    "hybrid_querec": "HYBRID (CF+LLM)",
}

STAGE_NAMES = [
    "0_no_onboarding",
    "1_onboarding_only",
    "2_k3_ratings",
    "3_k6_ratings",
    "4_full_profile",
]


def round_or_none(value: float | None, digits: int = 4) -> float | None:
    if value is None or not np.isfinite(value):
        return None
    return round(float(value), digits)


def mean_or_none(values: list[float], digits: int = 4) -> float | None:
    clean = [float(v) for v in values if v is not None and np.isfinite(v)]
    if not clean:
        return None
    return round(sum(clean) / len(clean), digits)


def median_or_none(values: list[float], digits: int = 4) -> float | None:
    clean = [float(v) for v in values if v is not None and np.isfinite(v)]
    if not clean:
        return None
    return round(float(statistics.median(clean)), digits)


def parse_genres(raw_genre: str | None) -> set[str]:
    if not raw_genre:
        return set()
    return {
        part.strip().lower()
        for part in str(raw_genre).replace("|", ",").replace(";", ",").split(",")
        if part.strip()
    }


def genre_jaccard(rec_genres_list: list[set[str]], test_genres_list: list[set[str]]) -> float | None:
    if not rec_genres_list or not test_genres_list:
        return None
    scores = []
    for rg in rec_genres_list:
        if not rg:
            continue
        best = 0.0
        for tg in test_genres_list:
            if not tg:
                continue
            union_size = len(rg | tg)
            if union_size > 0:
                best = max(best, len(rg & tg) / union_size)
        scores.append(best)
    return mean_or_none(scores)


def semantic_similarity_stats(
    llm_rec: LLMVectorRecommender | None,
    rec_ids: list[int],
    test_ids: list[int],
) -> tuple[float | None, float | None]:
    """Oblicza średnie i maksymalne podobieństwo kosinusowe (embeddinggemma) do ukrytych filmów testowych."""
    if llm_rec is None or llm_rec.embeddings is None or not rec_ids or not test_ids:
        return None, None

    rec_rows = [llm_rec.id_to_row[mid] for mid in rec_ids if mid in llm_rec.id_to_row]
    test_rows = [llm_rec.id_to_row[mid] for mid in test_ids if mid in llm_rec.id_to_row]
    if not rec_rows or not test_rows:
        return None, None

    rec_vecs = llm_rec.embeddings[np.asarray(rec_rows, dtype=np.int64)].astype(np.float32)
    test_vecs = llm_rec.embeddings[np.asarray(test_rows, dtype=np.int64)].astype(np.float32)
    sim_matrix = rec_vecs @ test_vecs.T  # wektory są już znormalizowane L2
    best_per_rec = sim_matrix.max(axis=1)
    return round_or_none(float(np.mean(best_per_rec))), round_or_none(float(np.max(sim_matrix)))


def fetch_d1_snapshot(db: DatabaseManager) -> dict:
    """Pobiera pełny zrzut danych użytkowników z D1 bez żadnych zapisów."""
    users_res = db._execute_d1(
        "SELECT id, nickname, role, IFNULL(favorites_selected, 0) AS favorites_selected, created_at FROM users ORDER BY id ASC"
    )
    reviews_res = db._execute_d1(
        "SELECT id, user_id, movie_id, rating, IFNULL(content, '') AS content, COALESCE(updated_at, created_at) AS ts, created_at "
        "FROM reviews WHERE rating IS NOT NULL ORDER BY created_at ASC, id ASC"
    )
    watched_res = db._execute_d1(
        "SELECT user_id, movie_id, IFNULL(status, 'watched') AS status, watched_date "
        "FROM watched ORDER BY watched_date ASC, id ASC"
    )
    onboard_res = db._execute_d1(
        "SELECT user_id, movie_id, created_at FROM user_onboarding_movies ORDER BY created_at ASC, id ASC"
    )

    if any(r is None for r in (users_res, reviews_res, watched_res, onboard_res)):
        raise RuntimeError("Nie udało się pobrać danych z Cloudflare D1 (sprawdź zmienne ACCOUNT_ID, DATABASE_ID, API_TOKEN).")

    users = db._extract_rows(users_res)
    reviews = db._extract_rows(reviews_res)
    watched = db._extract_rows(watched_res)
    onboarding = db._extract_rows(onboard_res)

    return {
        "users": users,
        "reviews": reviews,
        "watched": watched,
        "onboarding": onboarding,
    }


def get_local_catalog_count(db: DatabaseManager) -> int:
    if not os.path.exists(db.local_db_path):
        return 0
    conn = sqlite3.connect(db.local_db_path)
    try:
        row = conn.execute("SELECT COUNT(*) FROM movies").fetchone()
        return int(row[0]) if row else 0
    finally:
        conn.close()


def ensure_cb_in_memory(db: DatabaseManager, model_manager: RecommendationModelManager):
    """Ładuje CB z pamięci/dysku lub buduje TF-IDF wyłącznie w RAM bez zapisywania .pkl."""
    if (
        model_manager.tfidf_matrix is not None
        and model_manager.movie_indices is not None
        and model_manager.movie_id_map is not None
    ):
        return (
            model_manager.tfidf_matrix,
            model_manager.movie_indices,
            model_manager.movie_id_map,
        )

    print("Buduję tymczasową macierz TF-IDF w RAM (brak zapisu na dysk)...")
    movies_df = db.fetch_movies_features()
    if movies_df is None or movies_df.empty:
        raise RuntimeError("Nie udało się wczytać cech filmów z lokalnej bazy movies.db.")

    combined = (
        movies_df["genres"]
        + " "
        + movies_df["genres"]
        + " "
        + movies_df["director"]
        + " "
        + movies_df["cast_members"]
        + " "
        + movies_df["overview"]
    ).fillna("")
    tfidf = TfidfVectorizer(stop_words="english")
    tfidf_matrix = tfidf.fit_transform(combined)
    movie_indices = pd.Series(movies_df.index, index=movies_df["id"]).drop_duplicates()
    movie_id_map = movies_df["id"].values
    return tfidf_matrix, movie_indices, movie_id_map


def predict_cf_stage(
    target_user_id: int,
    stage_ratings_df: pd.DataFrame,
    other_users_ratings_df: pd.DataFrame,
    exclude_ids: set[int],
    top_k: int,
) -> tuple[list[int], dict[int, float], float]:
    """Trenuje SVD w RAM na ocenach innych użytkowników + bieżącym etapie użytkownika docelowego."""
    t0 = time.perf_counter()
    if stage_ratings_df is None or stage_ratings_df.empty or other_users_ratings_df.empty:
        return [], {}, round((time.perf_counter() - t0) * 1000, 2)

    combined_df = pd.concat(
        [
            other_users_ratings_df[["user_id", "movie_id", "rating"]],
            stage_ratings_df[["user_id", "movie_id", "rating"]],
        ],
        ignore_index=True,
    )
    if combined_df["user_id"].nunique() < 2:
        return [], {}, round((time.perf_counter() - t0) * 1000, 2)

    candidate_ids = [
        int(mid)
        for mid in other_users_ratings_df["movie_id"].unique()
        if int(mid) not in exclude_ids
    ]
    if not candidate_ids:
        return [], {}, round((time.perf_counter() - t0) * 1000, 2)

    reader = Reader(rating_scale=(1, 5))
    trainset = Dataset.load_from_df(combined_df, reader).build_full_trainset()
    svd = SVD(n_factors=100, n_epochs=20, random_state=42)
    svd.fit(trainset)

    scored = []
    for mid in candidate_ids:
        pred = svd.predict(target_user_id, mid)
        if not pred.details.get("was_impossible", False):
            scored.append((float(pred.est), mid))

    scored.sort(key=lambda item: (-item[0], item[1]))
    all_scores = {mid: est for est, mid in scored}
    top_ids = [mid for _, mid in scored[:top_k]]
    duration_ms = round((time.perf_counter() - t0) * 1000, 2)
    return top_ids, all_scores, duration_ms


def predict_cb_stage(
    stage_ratings_df: pd.DataFrame,
    onboarding_ids: set[int],
    exclude_ids: set[int],
    tfidf_matrix,
    movie_indices,
    movie_id_map,
    top_k: int,
) -> tuple[list[int], float]:
    """Oblicza rekomendacje Content-Based dla bieżącego etapu Cold Start."""
    t0 = time.perf_counter()
    good_movies = []
    if stage_ratings_df is not None and not stage_ratings_df.empty:
        good_movies = stage_ratings_df[stage_ratings_df["rating"] >= 4]["movie_id"].tolist()
    if not good_movies and onboarding_ids:
        good_movies = list(onboarding_ids)
    if not good_movies:
        return [], round((time.perf_counter() - t0) * 1000, 2)

    similar_scores: dict[int, float] = {}
    for mid in good_movies:
        if mid in movie_indices:
            idx = movie_indices[mid]
            cos_sim = cosine_similarity(tfidf_matrix[idx], tfidf_matrix).flatten()
            for sim_idx, score in enumerate(cos_sim):
                if score > 0.01:
                    sim_mid = int(movie_id_map[sim_idx])
                    if sim_mid not in exclude_ids:
                        similar_scores[sim_mid] = similar_scores.get(sim_mid, 0.0) + float(score)

    if not similar_scores:
        return [], round((time.perf_counter() - t0) * 1000, 2)

    sorted_sims = sorted(similar_scores.items(), key=lambda x: (-x[1], x[0]))[:top_k]
    top_ids = [mid for mid, _ in sorted_sims]
    return top_ids, round((time.perf_counter() - t0) * 1000, 2)


def predict_llm_and_hybrid_stage(
    user_id: int,
    stage_ratings_df: pd.DataFrame,
    onboarding_ids: set[int],
    exclude_ids: set[int],
    cf_scores: dict[int, float],
    llm_rec: LLMVectorRecommender | None,
    movies_by_id: dict[int, dict],
    top_k: int,
    skip_llm_chat: bool,
) -> tuple[list[int], float, list[int], float]:
    """Oblicza rekomendacje LLM (QueRec) oraz fuzji Hybrid (CF + LLM) dla bieżącego etapu."""
    if llm_rec is None or llm_rec.embeddings is None:
        return [], 0.0, [], 0.0
    if (stage_ratings_df is None or stage_ratings_df.empty) and not onboarding_ids:
        return [], 0.0, [], 0.0

    t_llm = time.perf_counter()
    if skip_llm_chat:
        queries = llm_rec._build_fallback_queries(
            stage_ratings_df, onboarding_ids, movies_by_id, watched_details=[]
        )
    else:
        queries, _ = llm_rec.generate_user_queries(
            stage_ratings_df, [], onboarding_ids, movies_by_id, user_id=user_id
        )

    query_vecs = llm_rec.embed_queries(queries)
    llm_candidates = llm_rec.search_by_query_vectors(
        query_vecs, exclude_ids=exclude_ids, top_k=100
    )
    llm_ids = [mid for _, mid in llm_candidates[:top_k]]
    llm_ms = round((time.perf_counter() - t_llm) * 1000, 2)

    t_hyb = time.perf_counter()
    llm_scores_map = {mid: score for score, mid in llm_candidates}
    hybrid_recs = llm_rec.fuse_cf_and_llm(cf_scores, llm_scores_map, query_vecs, top_k=top_k)
    hybrid_ids = [int(item["movie_id"]) for item in hybrid_recs]
    hyb_ms = round((time.perf_counter() - t_hyb) * 1000, 2)

    return llm_ids, llm_ms, hybrid_ids, hyb_ms


def build_eligibility_splits(
    reviews: list[dict],
    onboarding_rows: list[dict],
    excluded_users: set[int],
    min_ratings: int,
    test_ratio: float,
) -> tuple[pd.DataFrame, dict[int, dict]]:
    """Dzieli chronologicznie oceny każdego użytkownika na profil treningowy i zbiór testowy."""
    df_reviews = pd.DataFrame(reviews)
    if df_reviews.empty:
        return pd.DataFrame(columns=["user_id", "movie_id", "rating", "content"]), {}

    df_reviews["user_id"] = pd.to_numeric(df_reviews["user_id"], errors="coerce")
    df_reviews["movie_id"] = pd.to_numeric(df_reviews["movie_id"], errors="coerce")
    df_reviews["rating"] = pd.to_numeric(df_reviews["rating"], errors="coerce")
    df_reviews["id"] = pd.to_numeric(df_reviews["id"], errors="coerce").fillna(0).astype(int)
    df_reviews = df_reviews.dropna(subset=["user_id", "movie_id", "rating"]).copy()
    df_reviews["user_id"] = df_reviews["user_id"].astype(int)
    df_reviews["movie_id"] = df_reviews["movie_id"].astype(int)
    df_reviews["rating"] = df_reviews["rating"].astype(float)

    # Gdy ten sam użytkownik ocenił film ponownie, zachowujemy ostatnią chronologicznie ocenę
    df_reviews = df_reviews.sort_values(by=["created_at", "id"], ascending=True)
    df_reviews = df_reviews.drop_duplicates(subset=["user_id", "movie_id"], keep="last").reset_index(drop=True)

    onboarding_by_user: dict[int, list[int]] = {}
    for row in onboarding_rows:
        uid = int(row["user_id"])
        mid = int(row["movie_id"])
        onboarding_by_user.setdefault(uid, [])
        if mid not in onboarding_by_user[uid]:
            onboarding_by_user[uid].append(mid)

    eligible: dict[int, dict] = {}
    for uid, user_df in df_reviews.groupby("user_id"):
        uid = int(uid)
        if uid in excluded_users:
            continue
        user_df = user_df.sort_values(by=["created_at", "id"], ascending=True).reset_index(drop=True)
        if len(user_df) < min_ratings:
            continue

        pos_df = user_df[user_df["rating"] >= 4.0]
        if len(pos_df) < 3:
            continue

        n_test = max(2, min(5, int(round(len(pos_df) * test_ratio))))
        if len(user_df) - n_test < 3:
            n_test = min(2, len(pos_df) - 1)
        if len(user_df) - n_test < 3 or n_test < 1:
            continue

        test_liked_ids = [int(m) for m in pos_df.iloc[-n_test:]["movie_id"].tolist()]
        test_set = set(test_liked_ids)
        train_df = user_df[~user_df["movie_id"].isin(test_set)].reset_index(drop=True)
        if len(train_df) < 3:
            continue

        raw_onboard = [mid for mid in onboarding_by_user.get(uid, []) if mid not in test_set]
        # Fallback gdy tester pominął onboarding: symulujemy 3 pierwsze pozytywne/znane wybory bez ocen gwiazdkowych
        if not raw_onboard:
            raw_onboard = [int(m) for m in train_df.head(3)["movie_id"].tolist()]

        eligible[uid] = {
            "train_df": train_df,
            "test_liked_ids": test_liked_ids,
            "onboarding_ids": set(raw_onboard),
            "full_ratings_count": len(user_df),
        }

    return df_reviews, eligible


def write_csv(path: Path, header: list[str], rows: list[list]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(header)
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(
        description="Ewaluacja offline krzywej Cold Start na rzeczywistych danych z MovieTracker."
    )
    parser.add_argument("--top-k", type=int, default=10, help="Liczba rekomendacji Top-K na model (domyślnie 10).")
    parser.add_argument("--min-ratings", type=int, default=6, help="Min. liczba ocen użytkownika do podziału hold-out (domyślnie 6).")
    parser.add_argument("--test-ratio", type=float, default=0.3, help="Ułamek najnowszych pozytywnych ocen w zbiorze testowym (domyślnie 0.3).")
    parser.add_argument("--exclude-users", type=str, default="", help="Lista ID użytkowników do pominięcia po przecinku, np. '1'.")
    parser.add_argument(
        "--output-dir",
        type=str,
        default=str(APP_DIR / "survey_results" / "cold_start_eval"),
        help="Katalog docelowy dla plików CSV/JSON.",
    )
    parser.add_argument("--no-llm", action="store_true", help="Pomiń silniki LLM i HYBRID.")
    parser.add_argument("--skip-llm-chat", action="store_true", help="Nie odpytuj Qwena - użyj szybkiego fallbacku metadanych + wektory.")
    args = parser.parse_args()

    excluded_users = {
        int(x.strip())
        for x in (args.exclude_users or "").split(",")
        if x.strip().isdigit()
    }
    output_dir = Path(args.output_dir)

    print("1/4 Pobieranie zrzutu danych z Cloudflare D1 (tryb tylko do odczytu)...")
    db = DatabaseManager()
    snapshot = fetch_d1_snapshot(db)
    catalog_count = get_local_catalog_count(db)

    users = snapshot["users"]
    reviews = snapshot["reviews"]
    onboarding_rows = snapshot["onboarding"]

    active_users = [u for u in users if int(u["id"]) not in excluded_users]
    onboard_completed = sum(1 for u in active_users if int(u.get("favorites_selected") or 0) == 1)
    active_user_ids = {int(u["id"]) for u in active_users}
    reviews_active = [r for r in reviews if int(r["user_id"]) in active_user_ids]
    reviews_with_text = sum(1 for r in reviews_active if str(r.get("content") or "").strip())
    onboard_active = [o for o in onboarding_rows if int(o["user_id"]) in active_user_ids]

    global_stats = {
        "evaluated_at_utc": datetime.now(timezone.utc).isoformat(),
        "catalog_movies_count": catalog_count,
        "excluded_user_ids": sorted(excluded_users),
        "total_users": len(active_users),
        "onboarding_completed_users": onboard_completed,
        "onboarding_completion_pct": round((onboard_completed / len(active_users)) * 100, 2) if active_users else 0.0,
        "total_onboarding_selections": len(onboard_active),
        "avg_onboarding_movies_per_user": round(len(onboard_active) / len(active_users), 2) if active_users else 0.0,
        "total_ratings": len(reviews_active),
        "ratings_with_text_review": reviews_with_text,
        "matrix_density_pct": round((len(reviews_active) / (len(active_users) * catalog_count)) * 100, 6)
        if active_users and catalog_count
        else 0.0,
    }

    print("2/4 Przygotowanie podziału chronologicznego hold-out oraz modeli CB i LLM...")
    df_all_reviews, eligible_users = build_eligibility_splits(
        reviews,
        onboarding_rows,
        excluded_users=excluded_users,
        min_ratings=args.min_ratings,
        test_ratio=args.test_ratio,
    )

    if not eligible_users:
        print(
            f"Brak użytkowników spełniających kryteria ewaluacji (min_ratings={args.min_ratings}, min. 3 pozytywne oceny >= 4)."
        )
        output_dir.mkdir(parents=True, exist_ok=True)
        with open(output_dir / "cold_start_report.json", "w", encoding="utf-8") as f:
            json.dump({"global_stats": global_stats, "eligible_users_count": 0, "summary": []}, f, ensure_ascii=False, indent=2)
        return

    model_manager = RecommendationModelManager()
    tfidf_matrix, movie_indices, movie_id_map = ensure_cb_in_memory(db, model_manager)

    llm_rec = None if args.no_llm else LLMVectorRecommender()
    active_models = ["collaborative_filtering", "content_based"]
    if llm_rec is not None and llm_rec.embeddings is not None:
        active_models.extend(["llm_querec", "hybrid_querec"])
    elif not args.no_llm:
        print("UWAGA: Brak lokalnego indeksu wektorowego - pominięto modele LLM i HYBRID.")

    # Zbieramy wszystkie potrzebne metadane filmów jednym zapytaniem SQLite
    needed_movie_ids = set(df_all_reviews["movie_id"].tolist())
    for info in eligible_users.values():
        needed_movie_ids.update(info["onboarding_ids"])
    movies_by_id = db.fetch_movies_by_ids(list(needed_movie_ids))

    print(f"3/4 Uruchamiam symulację Cold Start dla {len(eligible_users)} użytkowników (Top-{args.top_k})...")
    per_user_records = []
    stage_rec_sets: dict[tuple[str, str], set[int]] = {}
    cf_llm_overlaps_by_stage: dict[str, list[float]] = {s: [] for s in STAGE_NAMES}

    for uid, info in sorted(eligible_users.items()):
        train_df: pd.DataFrame = info["train_df"]
        test_liked_ids: list[int] = info["test_liked_ids"]
        onboarding_ids: set[int] = info["onboarding_ids"]
        test_set = set(test_liked_ids)

        # Inni użytkownicy dla CF (z wyłączeniem wykluczonych ID)
        other_ratings_df = df_all_reviews[
            (df_all_reviews["user_id"] != uid) & (~df_all_reviews["user_id"].isin(excluded_users))
        ].copy()

        # Metadane ukrytych filmów testowych (do metryk semantycznych i gatunkowych)
        test_meta = db.fetch_movies_by_ids(test_liked_ids)
        test_genres = [parse_genres(test_meta[m].get("genres")) for m in test_liked_ids if m in test_meta]

        stage_specs = [
            ("0_no_onboarding", train_df.iloc[0:0], set()),
            ("1_onboarding_only", train_df.iloc[0:0], set(onboarding_ids)),
            ("2_k3_ratings", train_df.head(3).copy(), set(onboarding_ids)),
        ]
        if len(train_df) >= 6:
            stage_specs.append(("3_k6_ratings", train_df.head(6).copy(), set(onboarding_ids)))
        stage_specs.append(("4_full_profile", train_df.copy(), set(onboarding_ids)))

        for stage_name, stage_df, stage_onboard in stage_specs:
            stage_rating_ids = set(int(m) for m in stage_df["movie_id"].tolist()) if not stage_df.empty else set()
            exclude_ids = stage_rating_ids.union(stage_onboard)

            # 1. CF
            cf_ids, cf_scores, cf_ms = predict_cf_stage(
                uid, stage_df, other_ratings_df, exclude_ids=exclude_ids, top_k=args.top_k
            )

            # 2. CB
            cb_ids, cb_ms = predict_cb_stage(
                stage_df,
                stage_onboard,
                exclude_ids=exclude_ids,
                tfidf_matrix=tfidf_matrix,
                movie_indices=movie_indices,
                movie_id_map=movie_id_map,
                top_k=args.top_k,
            )

            # 3. LLM + HYBRID
            if "llm_querec" in active_models:
                llm_ids, llm_ms, hyb_ids, hyb_ms = predict_llm_and_hybrid_stage(
                    uid,
                    stage_df,
                    stage_onboard,
                    exclude_ids=exclude_ids,
                    cf_scores=cf_scores,
                    llm_rec=llm_rec,
                    movies_by_id=movies_by_id,
                    top_k=args.top_k,
                    skip_llm_chat=args.skip_llm_chat,
                )
            else:
                llm_ids, llm_ms, hyb_ids, hyb_ms = [], 0.0, [], 0.0

            # Overlap CF vs LLM na etapie
            if cf_ids and llm_ids:
                cf_set, llm_set = set(cf_ids), set(llm_ids)
                denom = min(len(cf_set), len(llm_set))
                if denom > 0:
                    cf_llm_overlaps_by_stage[stage_name].append((len(cf_set & llm_set) / denom) * 100.0)

            model_outputs = {
                "collaborative_filtering": (cf_ids, cf_ms),
                "content_based": (cb_ids, cb_ms),
                "llm_querec": (llm_ids, llm_ms),
                "hybrid_querec": (hyb_ids, hyb_ms),
            }

            all_rec_ids = set()
            for r_ids, _ in model_outputs.values():
                all_rec_ids.update(r_ids)
            rec_meta = db.fetch_movies_by_ids(list(all_rec_ids)) if all_rec_ids else {}

            for model_name in active_models:
                rec_ids, latency_ms = model_outputs[model_name]
                stage_rec_sets.setdefault((stage_name, model_name), set()).update(rec_ids)

                hits = len(set(rec_ids) & test_set)
                hit_at_k = 1 if hits > 0 else 0
                recall_at_k = (hits / len(test_set)) if test_set else None

                sem_mean, sem_max = semantic_similarity_stats(llm_rec, rec_ids, test_liked_ids)
                rec_genres = [parse_genres(rec_meta[m].get("genres")) for m in rec_ids if m in rec_meta]
                g_jacc = genre_jaccard(rec_genres, test_genres)

                pops = [
                    float(rec_meta[m]["popularity"])
                    for m in rec_ids
                    if m in rec_meta and rec_meta[m].get("popularity") is not None
                ]

                per_user_records.append(
                    {
                        "user_id": uid,
                        "stage": stage_name,
                        "train_ratings_count": len(stage_df),
                        "onboarding_count": len(stage_onboard),
                        "test_liked_count": len(test_liked_ids),
                        "model": model_name,
                        "has_recs": 1 if rec_ids else 0,
                        "recs_count": len(rec_ids),
                        "hits_count": hits,
                        "hit_at_k": hit_at_k,
                        "recall_at_k": round_or_none(recall_at_k),
                        "semantic_sim_mean": sem_mean,
                        "semantic_sim_max": sem_max,
                        "genre_jaccard_mean": g_jacc,
                        "avg_popularity": mean_or_none(pops, digits=2),
                        "median_popularity": median_or_none(pops, digits=2),
                        "latency_ms": latency_ms,
                    }
                )

    # Agregacja końcowa per (stage, model)
    summary_rows = []
    for stage_name in STAGE_NAMES:
        for model_name in active_models:
            subset = [
                r
                for r in per_user_records
                if r["stage"] == stage_name and r["model"] == model_name
            ]
            if not subset:
                continue
            n_users = len(subset)
            with_recs = [r for r in subset if r["has_recs"] == 1]
            cov_pct = round((len(with_recs) / n_users) * 100.0, 2)
            cat_cov = len(stage_rec_sets.get((stage_name, model_name), set()))

            summary_rows.append(
                {
                    "stage": stage_name,
                    "model": model_name,
                    "model_label": MODEL_SHORT.get(model_name, model_name),
                    "evaluated_users": n_users,
                    "users_with_recs": len(with_recs),
                    "user_coverage_pct": cov_pct,
                    "avg_recs_count": mean_or_none([r["recs_count"] for r in subset], digits=2),
                    "catalog_coverage_unique": cat_cov,
                    "hit_rate_at_k_pct": mean_or_none([r["hit_at_k"] * 100.0 for r in subset], digits=2),
                    "recall_at_k_mean": mean_or_none([r["recall_at_k"] for r in subset], digits=4),
                    "semantic_sim_mean": mean_or_none([r["semantic_sim_mean"] for r in with_recs], digits=4),
                    "semantic_sim_max_mean": mean_or_none([r["semantic_sim_max"] for r in with_recs], digits=4),
                    "genre_jaccard_mean": mean_or_none([r["genre_jaccard_mean"] for r in with_recs], digits=4),
                    "avg_popularity": mean_or_none([r["avg_popularity"] for r in with_recs], digits=2),
                    "median_popularity": mean_or_none([r["median_popularity"] for r in with_recs], digits=2),
                    "latency_mean_ms": mean_or_none([r["latency_ms"] for r in with_recs], digits=2),
                    "cf_llm_overlap_pct": mean_or_none(cf_llm_overlaps_by_stage.get(stage_name, []), digits=2),
                }
            )

    print("4/4 Zapisywanie wyników CSV i JSON...")
    output_dir.mkdir(parents=True, exist_ok=True)

    summary_header = [
        "stage", "model", "model_label", "evaluated_users", "users_with_recs",
        "user_coverage_pct", "avg_recs_count", "catalog_coverage_unique",
        "hit_rate_at_k_pct", "recall_at_k_mean", "semantic_sim_mean",
        "semantic_sim_max_mean", "genre_jaccard_mean", "avg_popularity",
        "median_popularity", "latency_mean_ms", "cf_llm_overlap_pct",
    ]
    write_csv(
        output_dir / "cold_start_summary.csv",
        summary_header,
        [[row.get(col) if row.get(col) is not None else "" for col in summary_header] for row in summary_rows],
    )

    per_user_header = [
        "user_id", "stage", "train_ratings_count", "onboarding_count", "test_liked_count",
        "model", "has_recs", "recs_count", "hits_count", "hit_at_k", "recall_at_k",
        "semantic_sim_mean", "semantic_sim_max", "genre_jaccard_mean",
        "avg_popularity", "median_popularity", "latency_ms",
    ]
    write_csv(
        output_dir / "cold_start_per_user.csv",
        per_user_header,
        [[row.get(col) if row.get(col) is not None else "" for col in per_user_header] for row in per_user_records],
    )

    report_payload = {
        "global_stats": global_stats,
        "params": vars(args),
        "eligible_users_count": len(eligible_users),
        "eligible_user_ids": sorted(eligible_users.keys()),
        "summary": summary_rows,
    }
    with open(output_dir / "cold_start_report.json", "w", encoding="utf-8") as f:
        json.dump(report_payload, f, ensure_ascii=False, indent=2)

    print("\n=== STATYSTYKI GLOBALNE (ONBOARDING I RZADKOSC) ===")
    for k, v in global_stats.items():
        print(f"  {k}: {v}")

    print("\n=== KRZYWA COLD START (PODSUMOWANIE) ===")
    for row in summary_rows:
        print(
            f"[{row['stage']:17}] {row['model_label']:16} | "
            f"Cov={row['user_coverage_pct']}% | "
            f"Cat={row['catalog_coverage_unique']} | "
            f"Hit@{args.top_k}={row['hit_rate_at_k_pct']}% | "
            f"SemSim={row['semantic_sim_mean']} | "
            f"GenreJacc={row['genre_jaccard_mean']} | "
            f"PopMed={row['median_popularity']} | "
            f"Lat={row['latency_mean_ms']}ms"
        )
    print(f"\nZapisano raporty w: {output_dir}")


if __name__ == "__main__":
    main()
