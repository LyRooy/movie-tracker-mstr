import os
from fastapi import APIRouter, Depends, HTTPException, Security
from fastapi.security.api_key import APIKeyHeader
from pydantic import BaseModel, Field
from surprise import Dataset, Reader
from sklearn.metrics.pairwise import cosine_similarity

from services.model_manager import RecommendationModelManager, tracker
from services.llm_recommender import LLMVectorRecommender
from database.db_manager import DatabaseManager

router = APIRouter(prefix="/movies/user", tags=["Recommendations"])
model_manager = RecommendationModelManager()
llm_recommender = LLMVectorRecommender()
db = DatabaseManager()

API_KEY = os.getenv("MVT_API_KEY")
REC_TYPE_CF = "collaborative_filtering"
REC_TYPE_CB = "content_based"
REC_TYPE_LLM = "llm_querec"
REC_TYPE_HYBRID = "hybrid_querec"


async def verify_api_key(header: str = Security(APIKeyHeader(name="X-API-Key", auto_error=False))):
    if not header:
        raise HTTPException(status_code=403, detail="Brak klucza API w nagłówku")
    safe_api_key = API_KEY or ""
    clean_header = header.strip()
    clean_api_key = safe_api_key.strip().strip('"').strip("'")

    if clean_header == clean_api_key and clean_api_key != "":
        return header
    raise HTTPException(status_code=403, detail="Niepoprawny klucz API")


def _persist_recommendations(
    user_id: int,
    recs: list,
    rec_type: str,
    key: str,
    label: str,
    force: bool,
    result: dict,
    record_count: bool = True,
):
    """Zapisuje rekomendacje do D1, aktualizuje licznik i loguje wynik lub ostrzeżenie."""
    saved = db.save_cached_recommendations(user_id, recs, rec_type)
    if record_count:
        tracker.record_count(key, len(recs))
    result["data"] = recs
    if saved:
        prefix = "Wymuszono przeliczenie." if force else "Wygenerowano"
        tracker.log(
            key,
            label,
            f"{prefix} {len(recs)} rekomendacji ({label}) dla user_id={user_id}. Top ID: {[r['movie_id'] for r in recs[:3]]}",
        )
    else:
        tracker.log(
            key,
            label,
            f"Wygenerowano {len(recs)} rekomendacji ({label}) dla user_id={user_id}, ale zapis do D1 nie powiódł się.",
            level="warning",
        )
        result["cache_warning"] = "Nie udało się zapisać rekomendacji do bazy D1."


def _compute_cf_recommendations(
    user_id: int, user_ratings, known_movie_ids: set[int], force: bool
) -> tuple[dict, dict[int, float]]:
    """Oblicza lub pobiera z cache rekomendacje Collaborative Filtering w oparciu o globalną macierz ocen."""
    if not force:
        cf_cached = db.get_cached_recommendations(user_id, REC_TYPE_CF)
        if cf_cached:
            tracker.log("cf", "CF", f"Pobrano {len(cf_cached)} rekomendacji z pamięci podręcznej D1 dla user_id={user_id}.")
            cached_scores = {int(r["movie_id"]): float(r["rating"]) for r in cf_cached}
            return {"source": "database_cache", "data": cf_cached}, cached_scores

    source = "forced-recalculation" if force else "computed"
    result = {"source": source, "data": []}

    if user_ratings is None or user_ratings.empty:
        result["message"] = (
            "Brak ocen do wymuszenia przeliczenia CF."
            if force
            else "Brak ocen użytkownika do wyliczenia profilu (CF)."
        )
        return result, {}

    all_ratings = db.fetch_all_ratings()
    if all_ratings is None or all_ratings.empty:
        tracker.log("cf", "CF", f"Nie udało się pobrać globalnych ocen z bazy D1 dla user_id={user_id}.", level="error")
        result["message"] = "Nie udało się pobrać globalnych ocen z bazy D1 (CF)."
        return result, {}

    unique_users = all_ratings["user_id"].nunique()
    if unique_users < 2:
        tracker.log(
            "cf",
            "CF",
            f"Za mało użytkowników z ocenami w bazie ({unique_users}) do wyliczenia globalnego modelu CF (wymaganych min. 2).",
        )
        result["message"] = "Za mało użytkowników z ocenami w bazie do wyliczenia modelu CF (wymaganych min. 2)."
        return result, {}

    target_user_id = int(user_id)
    if target_user_id not in set(int(u) for u in all_ratings["user_id"].unique()):
        tracker.log(
            "cf",
            "CF",
            f"Użytkownik user_id={user_id} nie jest obecny w globalnym zbiorze ocen D1.",
            level="warning",
        )
        result["message"] = "Brak ocen użytkownika w globalnym zbiorze ocen (CF)."
        return result, {}

    # Predykcja wyłącznie dla filmów ocenionych przez innych użytkowników, których bieżący użytkownik nie zna.
    candidate_movie_ids = [
        int(m_id) for m_id in all_ratings["movie_id"].unique() if int(m_id) not in known_movie_ids
    ]
    if not candidate_movie_ids:
        tracker.log("cf", "CF", f"Brak nowych filmów ocenionych przez innych użytkowników dla user_id={user_id}.")
        result["message"] = "Brak nowych filmów ocenionych przez innych użytkowników do polecenia (CF)."
        return result, {}

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
        return result, {}

    scored = []
    for m_id in candidate_movie_ids:
        pred = cf_model.predict(target_user_id, m_id)
        if pred.details.get("was_impossible", False):
            continue
        scored.append((float(pred.est), m_id))

    # Sortowanie przed zaokrągleniem zapewnia deterministyczne i dokładne rozstrzyganie remisów.
    scored.sort(key=lambda item: (-item[0], item[1]))
    cf_all_scores = {m_id: est for est, m_id in scored}
    top_cf = [
        {
            "movie_id": m_id,
            "rating": round(est, 2),
            "confidence_interval": [0.0, 0.0],
        }
        for est, m_id in scored[:10]
    ]

    if top_cf:
        _persist_recommendations(user_id, top_cf, REC_TYPE_CF, "cf", "CF", force, result)

    return result, cf_all_scores


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

            _persist_recommendations(user_id, cb_recs, REC_TYPE_CB, "cb", "CB", force, result)

    return result


def _compute_llm_and_hybrid_recommendations(
    user_id: int,
    user_ratings,
    watched_details: list[dict],
    onboarding_movie_ids: set[int],
    known_movie_ids: set[int],
    cf_scores: dict[int, float],
    force: bool,
) -> tuple[dict, dict]:
    """Oblicza lub pobiera z cache rekomendacje LLM (llm_querec) oraz fuzję CF + LLM (hybrid_querec)."""
    llm_cached = None if force else db.get_cached_recommendations(user_id, REC_TYPE_LLM)
    hybrid_cached = None if force else db.get_cached_recommendations(user_id, REC_TYPE_HYBRID)

    if llm_cached and hybrid_cached:
        tracker.log("llm", "LLM", f"Pobrano {len(llm_cached)} rekomendacji LLM i {len(hybrid_cached)} Hybrid z D1 dla user_id={user_id}.")
        return (
            {"source": "database_cache", "data": llm_cached},
            {"source": "database_cache", "data": hybrid_cached},
        )

    source = "forced-recalculation" if force else "computed"
    llm_result = {"source": "database_cache", "data": llm_cached} if llm_cached else {"source": source, "data": []}
    hybrid_result = {"source": "database_cache", "data": hybrid_cached} if hybrid_cached else {"source": source, "data": []}

    if llm_recommender.embeddings is None:
        llm_recommender.load_index()
    if llm_recommender.embeddings is None:
        msg = "Brak lokalnego indeksu wektorowego filmów."
        tracker.log("llm", "LLM", f"{msg} (user_id={user_id})", level="warning")
        if not llm_cached:
            llm_result["message"] = msg
        if not hybrid_cached:
            hybrid_result["message"] = msg
        return llm_result, hybrid_result

    profile_movie_ids: list[int] = []
    if user_ratings is not None and not user_ratings.empty:
        profile_movie_ids.extend(int(m) for m in user_ratings["movie_id"].tolist())
    profile_movie_ids.extend(int(w["movie_id"]) for w in (watched_details or [])[:10])
    profile_movie_ids.extend(int(m) for m in onboarding_movie_ids)
    movies_by_id = db.fetch_movies_by_ids(profile_movie_ids)

    tracker.start("llm", "LLM", f"Generowanie rekomendacji LLM i Hybrid (user_id={user_id})")
    try:
        queries, query_source = llm_recommender.generate_user_queries(
            user_ratings, watched_details, onboarding_movie_ids, movies_by_id, user_id=user_id
        )
        tracker.log("llm", "LLM", f"Zapytania ({query_source}): {queries} | user_id={user_id}")

        query_vecs = llm_recommender.embed_queries(queries)
        llm_candidates = llm_recommender.search_by_query_vectors(
            query_vecs, exclude_ids=known_movie_ids, top_k=100
        )
        llm_scores_map = {m_id: score for score, m_id in llm_candidates}

        if not llm_cached:
            if llm_candidates:
                top_llm_raw = llm_candidates[:10]
                max_score = max(0.0, top_llm_raw[0][0]) or 1.0
                llm_recs = [
                    {
                        "movie_id": m_id,
                        "rating": round(3.5 + (max(0.0, score) / max_score) * 1.5, 2),
                        "confidence_interval": [0.0, 0.0],
                    }
                    for score, m_id in top_llm_raw
                ]
                _persist_recommendations(user_id, llm_recs, REC_TYPE_LLM, "llm", "LLM", force, llm_result)
            else:
                llm_result["message"] = "Brak pasujących filmów w indeksie wektorowym."
        else:
            tracker.record_count("llm", len(llm_cached))

        if not hybrid_cached:
            hybrid_recs = llm_recommender.fuse_cf_and_llm(
                cf_scores, llm_scores_map, query_vecs, top_k=10
            )
            if hybrid_recs:
                _persist_recommendations(
                    user_id,
                    hybrid_recs,
                    REC_TYPE_HYBRID,
                    "llm",
                    "HYBRID",
                    force,
                    hybrid_result,
                    record_count=False,
                )
            else:
                hybrid_result["message"] = "Brak kandydatów do fuzji CF + LLM."

        tracker.finish("llm", "LLM", ok=True, message=f"LLM + Hybrid gotowe (user_id={user_id})")
    except Exception as e:
        tracker.log("llm", "LLM", f"Błąd LLM/Hybrid: {e} | user_id={user_id}", level="error")
        tracker.finish("llm", "LLM", ok=False, message=f"Błąd LLM/Hybrid (user_id={user_id})")
        if not llm_cached:
            llm_result["message"] = f"Błąd silnika LLM: {e}"
        if not hybrid_cached:
            hybrid_result["message"] = f"Błąd modelu hybrydowego: {e}"

    return llm_result, hybrid_result


def compute_recommendations(user_id: int, force: bool = False) -> dict:
    user_ratings = db.fetch_user_ratings(user_id)
    watched_details = db.fetch_watched_detailed(user_id)
    watched_movie_ids = {int(w["movie_id"]) for w in watched_details}
    onboarding_movie_ids = set(db.fetch_onboarding_movies(user_id))

    if (user_ratings is None or user_ratings.empty) and not onboarding_movie_ids:
        return {"status": "error", "message": "Brak ocen i filmów startowych użytkownika"}

    if user_ratings is not None and not user_ratings.empty:
        rated_movie_ids = set(int(m) for m in user_ratings["movie_id"].tolist())
    else:
        rated_movie_ids = set()

    # Zbiór wszystkich filmów, których nie chcemy już polecać
    known_movie_ids = rated_movie_ids.union(watched_movie_ids).union(
        int(m) for m in onboarding_movie_ids
    )

    cf_result, cf_scores = _compute_cf_recommendations(user_id, user_ratings, known_movie_ids, force)
    cb_result = _compute_cb_recommendations(
        user_id, user_ratings, onboarding_movie_ids, known_movie_ids, force
    )
    llm_result, hybrid_result = _compute_llm_and_hybrid_recommendations(
        user_id, user_ratings, watched_details, onboarding_movie_ids, known_movie_ids, cf_scores, force
    )

    return {
        "status": "success",
        "user_id": user_id,
        "collaborative": cf_result,
        "content_based": cb_result,
        "llm_querec": llm_result,
        "hybrid_querec": hybrid_result,
    }


@router.get("/{user_id}/recommendations", dependencies=[Depends(verify_api_key)])
def get_recommendations(user_id: int):
    return compute_recommendations(user_id, force=False)


@router.post("/{user_id}/recommendations/force-recalculate", dependencies=[Depends(verify_api_key)])
def force_recalculate(user_id: int):
    return compute_recommendations(user_id, force=True)


class AskAIRequest(BaseModel):
    prompt: str = Field(..., min_length=2, max_length=500)
    limit: int = Field(8, ge=1, le=20)
    exclude_watched: bool = True
    include_explanations: bool = True


@router.post("/{user_id}/ask-ai", dependencies=[Depends(verify_api_key)])
def ask_ai(user_id: int, body: AskAIRequest):
    """Interaktywny tryb 'Zapytaj AI': filtry SQL z LLM + retrieval wektorowy wyłącznie na movies.db."""
    prompt = body.prompt.strip()
    if len(prompt) < 2:
        raise HTTPException(status_code=400, detail="Zapytanie jest zbyt krótkie.")

    if llm_recommender.embeddings is None:
        llm_recommender.load_index()
    if llm_recommender.embeddings is None:
        raise HTTPException(status_code=503, detail="Indeks wektorowy filmów jest niedostępny.")

    tracker.log("llm", "ASK-AI", f"Zapytaj AI (user_id={user_id}): {prompt!r}")

    parsed = llm_recommender.parse_ask_ai_prompt(prompt)
    filters = parsed.get("filters") or {}
    semantic_query = parsed.get("semantic_query") or prompt

    exclude_ids: set[int] = set()
    if body.exclude_watched:
        exclude_ids.update(int(m) for m in db.fetch_watched_movies(user_id))
        user_ratings = db.fetch_user_ratings(user_id)
        if user_ratings is not None and not user_ratings.empty:
            exclude_ids.update(int(m) for m in user_ratings["movie_id"].tolist())

    candidate_ids = db.filter_movie_ids_by_criteria(filters)
    query_vecs = llm_recommender.embed_queries([semantic_query])
    matches = llm_recommender.search_within_candidates(
        query_vecs, candidate_ids, exclude_ids=exclude_ids, top_k=body.limit
    )

    relaxed_filters = False
    if not matches and candidate_ids is not None:
        relaxed_filters = True
        matches = llm_recommender.search_within_candidates(
            query_vecs, None, exclude_ids=exclude_ids, top_k=body.limit
        )

    matched_ids = [mid for _, mid in matches]
    movies_by_id = db.fetch_movies_by_ids(matched_ids)
    hydrated_movies = [movies_by_id[mid] for mid in matched_ids if mid in movies_by_id]

    explanations: dict[int, str] = {}
    if body.include_explanations and hydrated_movies:
        explanations = llm_recommender.generate_ask_ai_explanations(prompt, hydrated_movies)

    results = []
    for score, mid in matches:
        movie = movies_by_id.get(mid)
        if not movie:
            continue
        poster = movie.get("poster_path") or movie.get("poster_url")
        if poster and not str(poster).startswith("http"):
            poster = f"https://image.tmdb.org/t/p/w200{poster}"
        elif not poster:
            title_q = str(movie.get("title") or "?").replace(" ", "+")
            poster = f"https://placehold.co/200x300/4CAF50/white/png?text={title_q}"

        results.append(
            {
                "id": mid,
                "title": movie.get("title"),
                "media_type": movie.get("media_type") or "movie",
                "release_date": movie.get("release_date"),
                "genre": movie.get("genres") or "",
                "overview": movie.get("overview") or "",
                "cast": movie.get("cast_members") or "",
                "director": movie.get("director") or "",
                "poster_path": movie.get("poster_path") or movie.get("poster_url"),
                "poster_url": poster,
                "imdb_rating": movie.get("imdb_rating"),
                "popularity": movie.get("popularity"),
                "match_score": round(max(0.0, float(score)), 4),
                "ai_reason": explanations.get(mid, ""),
            }
        )

    tracker.log(
        "llm",
        "ASK-AI",
        f"Zwrócono {len(results)} wyników dla user_id={user_id} | filtry={filters} | relaxed={relaxed_filters}",
    )

    return {
        "status": "success",
        "user_id": user_id,
        "prompt": prompt,
        "parsed_filters": filters,
        "semantic_query": semantic_query,
        "relaxed_filters": relaxed_filters,
        "count": len(results),
        "results": results,
    }
