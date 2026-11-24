"""Silnik rekomendacji oparty o LLM (Ollama) + lokalny indeks wektorowy oraz hybrydę CF + LLM."""

import json
import os
import re
import threading
from pathlib import Path

import numpy as np
import requests

from services.model_manager import tracker

DEFAULT_OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://192.168.0.109:11434/v1")
DEFAULT_CHAT_MODEL = os.getenv("OLLAMA_CHAT_MODEL", "Qwen-3.5-9B:latest")
DEFAULT_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma-2:latest")
DEFAULT_HYBRID_CF_WEIGHT = float(os.getenv("HYBRID_CF_WEIGHT", "0.5"))


def normalize_v1_url(url: str) -> str:
    """Normalizuje bazowy URL Ollamy do postaci zakończonej na /v1."""
    clean = (url or "").strip().rstrip("/")
    if not clean.endswith("/v1"):
        clean = f"{clean}/v1"
    return clean


def l2_normalize(vectors: np.ndarray) -> np.ndarray:
    """Normalizuje wektory (1D lub 2D) do jednostkowej długości L2 w float32."""
    arr = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=-1, keepdims=True)
    norms = np.where(norms == 0.0, 1.0, norms)
    return arr / norms


class LLMVectorRecommender:
    """Generuje zapytania rekomendacyjne przez Ollamę, przeszukuje indeks wektorowy i łączy wyniki z CF."""

    def __init__(
        self,
        models_dir: str | Path | None = None,
        ollama_url: str | None = None,
        chat_model: str | None = None,
        hybrid_cf_weight: float | None = None,
    ):
        self._lock = threading.RLock()
        self.models_dir = (
            Path(models_dir)
            if models_dir is not None
            else Path(__file__).resolve().parent.parent / "models"
        )
        self.v1_url = normalize_v1_url(ollama_url or DEFAULT_OLLAMA_URL)
        self.chat_model = chat_model or DEFAULT_CHAT_MODEL
        self.embed_model = DEFAULT_EMBED_MODEL
        self.hybrid_cf_weight = (
            float(hybrid_cf_weight) if hybrid_cf_weight is not None else DEFAULT_HYBRID_CF_WEIGHT
        )

        self.embeddings = None
        self.movie_ids = None
        self.active_count = 0
        self.dim = 0
        self.id_to_row: dict[int, int] = {}

        self.load_index()

    def load_index(self) -> bool:
        """Wczytuje indeks wektorowy (mmap) z dysku przy starcie lub przy pierwszym użyciu."""
        with self._lock:
            embeddings_path = self.models_dir / "movie_embeddings.npy"
            ids_path = self.models_dir / "movie_embedding_ids.npy"
            meta_path = self.models_dir / "embeddings_meta.json"

            if not (embeddings_path.exists() and ids_path.exists() and meta_path.exists()):
                return False

            try:
                with open(meta_path, "r", encoding="utf-8") as f:
                    meta = json.load(f)
                movie_ids = np.load(str(ids_path))
                embeddings = np.load(str(embeddings_path), mmap_mode="r")

                active_count = min(
                    int(meta.get("completed_count") or len(movie_ids)),
                    len(movie_ids),
                    embeddings.shape[0],
                )
                if active_count <= 0:
                    raise ValueError("Indeks wektorowy jest pusty.")

                self.embeddings = embeddings
                self.movie_ids = movie_ids
                self.active_count = active_count
                self.dim = int(embeddings.shape[1])
                self.embed_model = meta.get("model") or DEFAULT_EMBED_MODEL
                self.id_to_row = {
                    int(mid): idx for idx, mid in enumerate(movie_ids[:active_count])
                }

                tracker.log(
                    "llm",
                    "LLM",
                    f"Wczytano indeks wektorowy ({active_count} filmów x {self.dim}D, embed: {self.embed_model})",
                )
                tracker.finish(
                    "llm",
                    "LLM",
                    ok=True,
                    message=f"Indeks wektorowy gotowy ({active_count} filmów x {self.dim}D)",
                )
                print(
                    f"Wczytano indeks wektorowy: {active_count} filmów x {self.dim}D "
                    f"(model: {self.embed_model})."
                )
                return True
            except Exception as e:
                self.embeddings = None
                self.movie_ids = None
                self.active_count = 0
                self.dim = 0
                self.id_to_row = {}
                tracker.log("llm", "LLM", f"Błąd wczytywania indeksu wektorowego: {e}", level="warning")
                print(f"Błąd wczytywania indeksu wektorowego: {e}")
                return False

    @staticmethod
    def _format_movie_line(movie: dict, prefix: str = "") -> str:
        title = (movie.get("title") or "").strip() or f"ID {movie.get('id')}"
        release_date = (movie.get("release_date") or "").strip()
        year = release_date[:4] if len(release_date) >= 4 and release_date[:4].isdigit() else ""
        genres = (movie.get("genres") or "").strip()
        director = (movie.get("director") or "").strip()
        parts = [f"{title}" + (f" ({year})" if year else "")]
        if genres:
            parts.append(f"[{genres}]")
        if director:
            parts.append(f"dir. {director}")
        return f"{prefix}{' | '.join(parts)}"

    def build_user_profile_prompt(
        self,
        user_ratings,
        watched_details: list[dict],
        onboarding_ids: set[int],
        movies_by_id: dict[int, dict],
    ) -> str:
        """Buduje zwięzły profil preferencji użytkownika na bazie ocen, recenzji, obejrzeń i onboardingu."""
        liked_lines = []
        disliked_lines = []
        rated_ids: set[int] = set()

        if user_ratings is not None and not user_ratings.empty:
            cols = list(getattr(user_ratings, "columns", getattr(user_ratings, "_cols", [])))
            ratings_col = user_ratings["rating"].tolist()
            mids_col = user_ratings["movie_id"].tolist()
            contents_col = user_ratings["content"].tolist() if "content" in cols else [""] * len(mids_col)
            iter_rows = [
                {"rating": r, "movie_id": m, "content": c}
                for r, m, c in zip(ratings_col, mids_col, contents_col)
            ]

            for r in iter_rows:
                try:
                    m_id = int(r["movie_id"])
                    rating = float(r["rating"])
                except (TypeError, ValueError, KeyError):
                    continue
                rated_ids.add(m_id)
                movie = movies_by_id.get(m_id)
                if not movie:
                    continue
                review = str(r.get("content") or "").strip().replace("\n", " ")[:200]
                line = self._format_movie_line(movie, prefix=f"- ({rating:.0f}/5) ")
                if review:
                    line += f' — User review: "{review}"'
                if rating >= 4.0 and len(liked_lines) < 10:
                    liked_lines.append(line)
                elif rating <= 2.0 and len(disliked_lines) < 4:
                    disliked_lines.append(line)

        onboarding_lines = []
        for m_id in list(onboarding_ids):
            if int(m_id) in rated_ids:
                continue
            movie = movies_by_id.get(int(m_id))
            if movie and len(onboarding_lines) < 8:
                onboarding_lines.append(self._format_movie_line(movie, prefix="- "))

        watched_lines = []
        for item in watched_details or []:
            m_id = int(item["movie_id"])
            if m_id in rated_ids or m_id in onboarding_ids:
                continue
            if item.get("status") == "dropped":
                continue
            movie = movies_by_id.get(m_id)
            if movie and len(watched_lines) < 5:
                date_str = (item.get("watched_date") or "").strip()
                suffix = f" (watched {date_str})" if date_str else ""
                watched_lines.append(self._format_movie_line(movie, prefix="- ") + suffix)

        sections = []
        if liked_lines:
            sections.append("HIGHLY RATED BY USER:\n" + "\n".join(liked_lines))
        if onboarding_lines:
            sections.append("ONBOARDING FAVORITE MOVIES:\n" + "\n".join(onboarding_lines))
        if watched_lines:
            sections.append("RECENTLY WATCHED:\n" + "\n".join(watched_lines))
        if disliked_lines:
            sections.append("DISLIKED (AVOID SIMILAR THEMES):\n" + "\n".join(disliked_lines))

        return "\n\n".join(sections)

    @staticmethod
    def _parse_queries_from_text(text: str) -> list[str]:
        """Wyciąga listę zapytań z odpowiedzi LLM (odporne na bloki <think> i markdown)."""
        if not text:
            return []
        cleaned = re.sub(r"<think>.*?</think>", "", text, flags=re.DOTALL | re.IGNORECASE).strip()
        cleaned = re.sub(r"^```(?:json)?\s*|\s*```$", "", cleaned, flags=re.IGNORECASE).strip()

        candidates_to_try = [cleaned]
        obj_match = re.search(r"\{.*\}", cleaned, flags=re.DOTALL)
        if obj_match:
            candidates_to_try.append(obj_match.group(0))
        arr_match = re.search(r"\[.*\]", cleaned, flags=re.DOTALL)
        if arr_match:
            candidates_to_try.append(arr_match.group(0))

        for candidate in candidates_to_try:
            try:
                parsed = json.loads(candidate)
            except Exception:
                continue
            raw_list = parsed.get("queries") if isinstance(parsed, dict) else parsed
            if not isinstance(raw_list, list):
                continue
            unique_queries = []
            for item in raw_list:
                q = str(item).strip()
                if q and q not in unique_queries:
                    unique_queries.append(q)
            if unique_queries:
                return unique_queries[:5]

        return []

    def _build_fallback_queries(
        self,
        user_ratings,
        onboarding_ids: set[int],
        movies_by_id: dict[int, dict],
    ) -> list[str]:
        """Tworzy zapytania zastępcze z metadanych polubionych filmów, gdy chat LLM jest niedostępny."""
        seed_ids: list[int] = []
        if user_ratings is not None and not user_ratings.empty:
            for r, m in zip(user_ratings["rating"].tolist(), user_ratings["movie_id"].tolist()):
                if float(r) >= 4.0:
                    seed_ids.append(int(m))
        if not seed_ids:
            seed_ids = [int(m) for m in onboarding_ids]

        queries = []
        for m_id in seed_ids[:4]:
            movie = movies_by_id.get(m_id)
            if not movie:
                continue
            genres = (movie.get("genres") or "").strip()
            director = (movie.get("director") or "").strip()
            overview = (movie.get("overview") or "").strip()[:220]
            parts = [p for p in (genres, f"directed by {director}" if director else "", overview) if p]
            if parts:
                queries.append(" | ".join(parts))

        return queries[:4] or ["critically acclaimed drama thriller mystery"]

    def generate_user_queries(
        self,
        user_ratings,
        watched_details: list[dict],
        onboarding_ids: set[int],
        movies_by_id: dict[int, dict],
        user_id: int | None = None,
    ) -> tuple[list[str], str]:
        """Wywołuje Ollamę, aby wygenerować 3-5 semantycznych zapytań opisujących gust użytkownika."""
        profile_text = self.build_user_profile_prompt(
            user_ratings, watched_details, onboarding_ids, movies_by_id
        )
        if not profile_text:
            return self._build_fallback_queries(user_ratings, onboarding_ids, movies_by_id), "fallback"

        system_prompt = (
            "You are a movie recommendation query generator (QueRec). "
            "Analyze the user's liked movies, reviews (which may be in Polish or English), "
            "and dislikes. Generate 4 diverse, rich English semantic search queries describing "
            "specific themes, mood, genres, storytelling style, era, or filmmaking style of movies "
            "this user would love next. Do NOT mention specific movie titles from the user's history. "
            'Return ONLY valid JSON: {"queries": ["query 1", "query 2", "query 3", "query 4"]}.'
        )
        base_payload = {
            "model": self.chat_model,
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": profile_text},
            ],
            "temperature": 0.3,
            "max_tokens": 512,
        }

        for use_json_format in (True, False):
            payload = dict(base_payload)
            if use_json_format:
                payload["response_format"] = {"type": "json_object"}
            try:
                res = requests.post(
                    f"{self.v1_url}/chat/completions",
                    json=payload,
                    timeout=45,
                )
                if res.status_code == 400 and use_json_format:
                    continue
                if res.status_code != 200:
                    raise RuntimeError(f"HTTP {res.status_code}: {res.text[:200]}")

                content = (
                    (res.json().get("choices") or [{}])[0]
                    .get("message", {})
                    .get("content", "")
                )
                queries = self._parse_queries_from_text(content)
                if queries:
                    return queries, self.chat_model
                raise ValueError("Odpowiedź LLM nie zawierała poprawnej listy zapytań JSON.")
            except Exception as e:
                if use_json_format:
                    # Jeśli to błąd sieci/timeout lub brak odpowiedzi, nie ma sensu ponawiać bez json_object.
                    if not isinstance(e, ValueError):
                        tracker.log(
                            "llm",
                            "LLM",
                            f"Błąd połączenia z chatem Ollama ({self.chat_model}), używam zapytań zastępczych: {e}",
                            level="warning",
                        )
                        break
                else:
                    tracker.log(
                        "llm",
                        "LLM",
                        f"Nie udało się sparsować zapytań z {self.chat_model}, używam fallbacku: {e}",
                        level="warning",
                    )

        return self._build_fallback_queries(user_ratings, onboarding_ids, movies_by_id), "fallback"

    def embed_queries(self, queries: list[str]) -> np.ndarray:
        """Zamienia listę zapytań tekstowych na znormalizowane wektory przez endpoint embeddingów Ollamy."""
        formatted = [
            f"task: search result | query: {q.strip()}"
            if "embeddinggemma" in self.embed_model.lower()
            else q.strip()
            for q in queries
        ]
        res = requests.post(
            f"{self.v1_url}/embeddings",
            json={"model": self.embed_model, "input": formatted},
            timeout=30,
        )
        if res.status_code != 200:
            raise RuntimeError(f"Błąd embeddingów Ollamy (HTTP {res.status_code}): {res.text[:200]}")

        items = res.json().get("data") or []
        if len(items) != len(formatted):
            raise ValueError(f"Otrzymano {len(items)} wektorów dla {len(formatted)} zapytań.")
        items.sort(key=lambda item: item.get("index", 0))
        vecs = np.asarray([item["embedding"] for item in items], dtype=np.float32)
        return l2_normalize(vecs)

    def search_by_query_vectors(
        self, query_vecs: np.ndarray, exclude_ids: set[int], top_k: int = 100
    ) -> list[tuple[float, int]]:
        """Wyszukuje top_k najbliższych filmów w indeksie wektorowym z wykluczeniem znanych ID."""
        if self.embeddings is None or self.movie_ids is None or self.active_count <= 0:
            return []

        q_mat = np.asarray(query_vecs, dtype=np.float32)
        if q_mat.ndim == 1:
            q_mat = q_mat.reshape(1, -1)

        best_scores = np.empty(self.active_count, dtype=np.float32)
        chunk_size = 50000
        for start in range(0, self.active_count, chunk_size):
            end = min(self.active_count, start + chunk_size)
            sims = self.embeddings[start:end].astype(np.float32) @ q_mat.T
            best_scores[start:end] = sims.max(axis=1)

        exclude_rows = [self.id_to_row[int(mid)] for mid in exclude_ids if int(mid) in self.id_to_row]
        if exclude_rows:
            best_scores[exclude_rows] = -np.inf

        valid_count = int(np.sum(np.isfinite(best_scores)))
        if valid_count <= 0:
            return []

        k = min(max(1, int(top_k)), valid_count)
        top_idx = np.argpartition(best_scores, -k)[-k:]
        top_idx = top_idx[np.argsort(best_scores[top_idx])[::-1]]
        return [
            (float(best_scores[i]), int(self.movie_ids[i]))
            for i in top_idx
            if np.isfinite(best_scores[i])
        ]

    def score_movie_ids(self, query_vecs: np.ndarray, movie_ids: list[int]) -> dict[int, float]:
        """Wylicza dokładne maksymalne podobieństwo cosinusowe dla wskazanych movie_id."""
        if self.embeddings is None or not movie_ids:
            return {}
        q_mat = np.asarray(query_vecs, dtype=np.float32)
        if q_mat.ndim == 1:
            q_mat = q_mat.reshape(1, -1)

        found = [(int(mid), self.id_to_row[int(mid)]) for mid in movie_ids if int(mid) in self.id_to_row]
        if not found:
            return {}

        rows = np.asarray([row_idx for _, row_idx in found], dtype=np.int64)
        vecs = self.embeddings[rows].astype(np.float32)
        sims = (vecs @ q_mat.T).max(axis=1)
        return {mid: float(score) for (mid, _), score in zip(found, sims)}

    def fuse_cf_and_llm(
        self,
        cf_scores: dict[int, float],
        llm_scores: dict[int, float],
        query_vecs: np.ndarray | None,
        top_k: int = 10,
    ) -> list[dict]:
        """Równoległa fuzja znormalizowanych ocen z CF (SVD) i LLM (QueRec)."""
        if not cf_scores and not llm_scores:
            return []

        all_llm_scores = dict(llm_scores)
        if cf_scores and query_vecs is not None:
            missing_cf_ids = [mid for mid in cf_scores if mid not in all_llm_scores]
            if missing_cf_ids:
                all_llm_scores.update(self.score_movie_ids(query_vecs, missing_cf_ids))

        has_cf = bool(cf_scores)
        has_llm = bool(all_llm_scores)
        max_llm = max((max(0.0, s) for s in all_llm_scores.values()), default=0.0)
        if max_llm <= 0.0:
            max_llm = 1.0

        alpha = max(0.0, min(1.0, self.hybrid_cf_weight))
        candidate_ids = set(cf_scores.keys()) | set(all_llm_scores.keys())

        fused_list: list[tuple[float, int]] = []
        for mid in candidate_ids:
            cf_norm = (
                (max(1.0, min(5.0, float(cf_scores[mid]))) - 1.0) / 4.0
                if mid in cf_scores
                else 0.0
            )
            llm_norm = (
                max(0.0, float(all_llm_scores[mid])) / max_llm
                if mid in all_llm_scores
                else 0.0
            )

            if has_cf and has_llm:
                score = alpha * cf_norm + (1.0 - alpha) * llm_norm
            elif has_cf:
                score = cf_norm
            else:
                score = llm_norm

            if score > 0.0:
                fused_list.append((score, int(mid)))

        if not fused_list:
            return []

        fused_list.sort(key=lambda item: (-item[0], item[1]))
        top_fused = fused_list[:top_k]
        max_fused = top_fused[0][0] if top_fused[0][0] > 0 else 1.0

        return [
            {
                "movie_id": mid,
                "rating": round(3.5 + (score / max_fused) * 1.5, 2),
                "confidence_interval": [0.0, 0.0],
            }
            for score, mid in top_fused
        ]
