import os
from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from surprise import Dataset, Reader
from sklearn.metrics.pairwise import cosine_similarity

from services.model_manager import RecommendationModelManager, tracker
from database.db_manager import DatabaseManager

router = APIRouter(prefix="/movies/user", tags=["Recommendations"])
model_manager = RecommendationModelManager()
db = DatabaseManager()

API_KEY = os.getenv("MVT_API_KEY")
CACHE_MINUTES = 7 * 24 * 60  # 7 dni w minutach
REC_TYPE_CF = "collaborative_filtering"
REC_TYPE_CB = "content_based"


async def verify_api_key(header: str = Security(APIKeyHeader(name="X-API-Key", auto_error=False))):
    if not header:
        raise HTTPException(status_code=403, detail="Brak klucza API w nagłówku")
    safe_api_key = API_KEY or ""
    clean_header = header.strip()
    clean_api_key = safe_api_key.strip().strip('"').strip("'")

    if clean_header == clean_api_key and clean_api_key != "":
        return header
    raise HTTPException(status_code=403, detail="Niepoprawny klucz API")


def _compute_cf_recommendations(user_id: int, user_ratings, known_movie_ids: set[int], force: bool) -> dict:
    """Oblicza lub pobiera z cache rekomendacje Collaborative Filtering w oparciu o globalną macierz ocen."""
    if not force:
        cf_cached = db.get_cached_recommendations(user_id, REC_TYPE_CF)
        if cf_cached:
            tracker.log("cf", "CF", f"Pobrano {len(cf_cached)} rekomendacji z pamięci podręcznej D1 dla user_id={user_id}.")
            return {"source": "database_cache", "data": cf_cached}

    source = "forced-recalculation" if force else "computed"
    result = {"source": source, "data": []}

    if user_ratings is None or user_ratings.empty:
        result["message"] = (
            "Brak ocen do wymuszenia przeliczenia CF."
            if force
            else "Brak ocen użytkownika do wyliczenia profilu (CF)."
        )
        return result

    all_ratings = db.fetch_all_ratings()
    if all_ratings is None or all_ratings.empty:
        tracker.log("cf", "CF", f"Nie udało się pobrać globalnych ocen z bazy D1 dla user_id={user_id}.", level="error")
        result["message"] = "Nie udało się pobrać globalnych ocen z bazy D1 (CF)."
        return result

    unique_users = all_ratings["user_id"].nunique()
    if unique_users < 2:
        tracker.log(
            "cf",
            "CF",
            f"Za mało użytkowników z ocenami w bazie ({unique_users}) do wyliczenia globalnego modelu CF (wymaganych min. 2).",
        )
        result["message"] = "Za mało użytkowników z ocenami w bazie do wyliczenia modelu CF (wymaganych min. 2)."
        return result

    target_user_id = int(user_id)
    if target_user_id not in set(int(u) for u in all_ratings["user_id"].unique()):
        tracker.log(
            "cf",
            "CF",
            f"Użytkownik user_id={user_id} nie jest obecny w globalnym zbiorze ocen D1.",
            level="warning",
        )
        result["message"] = "Brak ocen użytkownika w globalnym zbiorze ocen (CF)."
        return result

    # Predykcja wyłącznie dla filmów ocenionych przez innych użytkowników, których bieżący użytkownik nie zna.
    candidate_movie_ids = [
        int(m_id) for m_id in all_ratings["movie_id"].unique() if int(m_id) not in known_movie_ids
    ]
    if not candidate_movie_ids:
        tracker.log("cf", "CF", f"Brak nowych filmów ocenionych przez innych użytkowników dla user_id={user_id}.")
        result["message"] = "Brak nowych filmów ocenionych przez innych użytkowników do polecenia (CF)."
        return result

    data_signature = model_manager.compute_cf_signature(all_ratings)
    with model_manager._cf_lock:
        if force or model_manager.cf_model is None or model_manager.cf_data_signature != data_signature:
            df_cf = all_ratings[["user_id", "movie_id", "rating"]]
            reader = Reader(rating_scale=(1, 5))
            trainset = Dataset.load_from_df(df_cf, reader).build_full_trainset()
            model_manager.build_collaborative_filtering_model(
                trainset, user_id=target_user_id, data_signature=data_signature
            )
        else:
            tracker.log("cf", "CF", f"Użyto aktualnego globalnego modelu CF z pamięci dla user_id={user_id}.")
        cf_model = model_manager.cf_model

    if cf_model is None:
        result["message"] = "Brak modelu CF."
        return result

    scored = []
    for m_id in candidate_movie_ids:
        pred = cf_model.predict(target_user_id, m_id)
        if pred.details.get("was_impossible", False):
            continue
        scored.append((float(pred.est), m_id))

    # Sortowanie przed zaokrągleniem zapewnia deterministyczne i dokładne rozstrzyganie remisów.
    scored.sort(key=lambda item: (-item[0], item[1]))
    top_cf = [
        {
            "movie_id": m_id,
            "rating": round(est, 2),
            "confidence_interval": [0.0, 0.0],
        }
        for est, m_id in scored[:10]
    ]

    if top_cf:
        db.save_cached_recommendations(user_id, top_cf, CACHE_MINUTES, REC_TYPE_CF)
        tracker.record_count("cf", len(top_cf))
        prefix = "Wymuszono przeliczenie." if force else "Wygenerowano"
        tracker.log(
            "cf",
            "CF",
            f"{prefix} {len(top_cf)} rekomendacji (CF) dla user_id={user_id}. Top ID: {[r['movie_id'] for r in top_cf[:3]]}",
        )
        result["data"] = top_cf

    return result


def _compute_cb_recommendations(
    user_id: int, user_ratings, onboarding_movie_ids: set[int], known_movie_ids: set[int], force: bool
) -> dict:
    """Oblicza lub pobiera z cache rekomendacje Content-Based (TF-IDF + cosine similarity)."""
    if not force:
        cb_cached = db.get_cached_recommendations(user_id, REC_TYPE_CB)
        if cb_cached:
            tracker.log("cb", "CB", f"Pobrano {len(cb_cached)} rekomendacji z pamięci podręcznej D1 dla user_id={user_id}.")
            return {"source": "database_cache", "data": cb_cached}

    source = "forced-recalculation" if force else "computed"
    result = {"source": source, "data": []}

    good_movies = []
    if user_ratings is not None and not user_ratings.empty:
        good_movies = user_ratings[user_ratings["rating"] >= 4]["movie_id"].tolist()

    # FALLBACK ONBOARDINGU (COLD START)
    if not good_movies and onboarding_movie_ids:
        good_movies = list(onboarding_movie_ids)
        if not force:
            tracker.log("cb", "CB", f"Cold start: Użyto {len(good_movies)} filmów z onboardingu dla user_id={user_id}.")

    if not good_movies:
        result["message"] = "Brak pozytywnych ocen lub filmów startowych do profilowania CB"
        return result

    cb_signature = db.get_local_movies_db_signature()
    with model_manager._cb_lock:
        needs_rebuild = (
            model_manager.tfidf_matrix is None
            or model_manager.movie_indices is None
            or model_manager.movie_id_map is None
            or (cb_signature is not None and model_manager.cb_data_signature != cb_signature)
        )
        if needs_rebuild:
            movies_features_df = db.fetch_movies_features()
            if movies_features_df is not None and not movies_features_df.empty:
                model_manager.build_content_based_model(
                    movies_features_df, user_id=user_id, data_signature=cb_signature
                )
        else:
            tracker.log("cb", "CB", f"Użyto aktualnej macierzy TF-IDF z pamięci dla user_id={user_id}.")

        tfidf_matrix = model_manager.tfidf_matrix
        movie_indices = model_manager.movie_indices
        movie_id_map = model_manager.movie_id_map

    if tfidf_matrix is not None and movie_id_map is not None and movie_indices is not None:
        similar_scores = {}
        for m_id in good_movies:
            if m_id in movie_indices:
                idx = movie_indices[m_id]
                cosine_sim = cosine_similarity(tfidf_matrix[idx], tfidf_matrix).flatten()

                for sim_idx, score in enumerate(cosine_sim):
                    if score > 0.01:
                        sim_movie_id = int(movie_id_map[sim_idx])
                        if sim_movie_id not in known_movie_ids:
                            similar_scores[sim_movie_id] = similar_scores.get(sim_movie_id, 0) + score

        if similar_scores:
            sorted_sims = sorted(similar_scores.items(), key=lambda x: x[1], reverse=True)[:10]
            max_score = sorted_sims[0][1] if sorted_sims else 1
            cb_recs = []

            for m_id, score in sorted_sims:
                normalized_rating = 3.5 + (score / max_score) * 1.5
                cb_recs.append(
                    {
                        "movie_id": m_id,
                        "rating": round(normalized_rating, 2),
                        "confidence_interval": [0.0, 0.0],
                    }
                )

            db.save_cached_recommendations(user_id, cb_recs, CACHE_MINUTES, REC_TYPE_CB)
            tracker.record_count("cb", len(cb_recs))
            prefix = "Wymuszono przeliczenie." if force else "Wygenerowano"
            tracker.log(
                "cb",
                "CB",
                f"{prefix} {len(cb_recs)} rekomendacji (CB) dla user_id={user_id}. Top ID: {[r['movie_id'] for r in cb_recs[:3]]}",
            )
            result["data"] = cb_recs

    return result


def compute_recommendations(user_id: int, force: bool = False) -> dict:
    user_ratings = db.fetch_user_ratings(user_id)
    watched_movie_ids = set(db.fetch_watched_movies(user_id))
    onboarding_movie_ids = set(db.fetch_onboarding_movies(user_id))

    if (user_ratings is None or user_ratings.empty) and not onboarding_movie_ids:
        return {"status": "error", "message": "Brak ocen i filmów startowych użytkownika"}

    if user_ratings is not None and not user_ratings.empty:
        rated_movie_ids = set(int(m) for m in user_ratings["movie_id"].tolist())
    else:
        rated_movie_ids = set()

    # Zbiór wszystkich filmów, których nie chcemy już polecać
    known_movie_ids = rated_movie_ids.union(
        int(m) for m in watched_movie_ids
    ).union(
        int(m) for m in onboarding_movie_ids
    )

    return {
        "status": "success",
        "user_id": user_id,
        "collaborative": _compute_cf_recommendations(user_id, user_ratings, known_movie_ids, force),
        "content_based": _compute_cb_recommendations(
            user_id, user_ratings, onboarding_movie_ids, known_movie_ids, force
        ),
    }


@router.get("/{user_id}/recommendations", dependencies=[Depends(verify_api_key)])
def get_recommendations(user_id: int):
    return compute_recommendations(user_id, force=False)


@router.post("/{user_id}/recommendations/force-recalculate", dependencies=[Depends(verify_api_key)])
def force_recalculate(user_id: int):
    return compute_recommendations(user_id, force=True)
