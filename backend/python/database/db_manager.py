import os
import time
import requests
import sqlite3
import pandas as pd

class DatabaseManager:
    def __init__(self):
        self.account_id = os.getenv("ACCOUNT_ID")
        self.database_id = os.getenv("DATABASE_ID")
        self.api_token = os.getenv("API_TOKEN")
        
        self.endpoint = f"https://api.cloudflare.com/client/v4/accounts/{self.account_id}/d1/database/{self.database_id}/query"
        self.headers = {"Authorization": f"Bearer {self.api_token}", "Content-Type": "application/json"}
        
        self.local_db_path = "/app/movies.db"

    @staticmethod
    def _has_d1_overload_error(res_json) -> bool:
        if not isinstance(res_json, dict):
            return False
        return any(
            isinstance(err, dict) and err.get("code") == 7429
            for err in (res_json.get("errors") or [])
        )

    @staticmethod
    def _compute_retry_delay(res, attempt: int, base_delay: float) -> float:
        retry_after = None
        if res is not None and getattr(res, "headers", None) is not None:
            raw = res.headers.get("Retry-After")
            if isinstance(raw, (int, float, str)):
                try:
                    retry_after = max(0.5, min(15.0, float(raw)))
                except ValueError:
                    retry_after = None
        return retry_after if retry_after is not None else base_delay * (attempt + 1)

    @staticmethod
    def _extract_rows(res_json) -> list:
        if not isinstance(res_json, dict):
            return []
        data = res_json.get("result") or []
        if not data:
            return []
        if isinstance(data[0], dict) and "results" in data[0]:
            return data[0].get("results") or []
        return data

    def _execute_d1(
        self,
        sql: str,
        params=None,
        max_retries: int = 3,
        base_delay: float = 2.0,
        debug_label: str | None = None,
    ):
        """Wykonuje zapytanie D1 z automatycznym ponawianiem przy przeciążeniu (429/7429) i błędach 5xx."""
        payload = {"sql": sql}
        if params is not None:
            payload["params"] = params

        for attempt in range(max_retries + 1):
            res = None
            res_json = None
            try:
                res = requests.post(self.endpoint, json=payload, headers=self.headers, timeout=30)
                try:
                    res_json = res.json()
                except Exception:
                    res_json = None
            except requests.RequestException as e:
                if attempt < max_retries:
                    delay = base_delay * (attempt + 1)
                    print(f"D1 błąd sieci ({e}), ponawiam próbę {attempt + 1}/{max_retries} za {delay:.1f}s...")
                    time.sleep(delay)
                    continue
                print(f"BŁĄD D1 (sieć): {e}")
                return None

            is_retryable = (
                res.status_code in (429, 500, 502, 503, 504)
                or self._has_d1_overload_error(res_json)
            )
            if is_retryable and attempt < max_retries:
                delay = self._compute_retry_delay(res, attempt, base_delay)
                print(
                    f"D1 tymczasowo przeciążone/błąd ({res.status_code}), "
                    f"ponawiam próbę {attempt + 1}/{max_retries} za {delay:.1f}s..."
                )
                time.sleep(delay)
                continue

            if debug_label:
                print(f"DEBUG {debug_label} D1 Status: {res.status_code} | Body: {res.text}")

            if res.status_code != 200 or not isinstance(res_json, dict) or res_json.get("success") is False:
                if not debug_label:
                    print(f"BŁĄD D1 Status: {res.status_code} | Body: {res.text}")
                return None

            statements = res_json.get("result") or []
            if any(isinstance(stmt, dict) and stmt.get("success") is False for stmt in statements):
                if not debug_label:
                    print(f"BŁĄD D1 (statement): {res.text}")
                return None

            return res_json

        return None

    def fetch_user_ratings(self, user_id: int):
        sql_query = (
            "SELECT rating, movie_id, IFNULL(content, '') AS content, created_at "
            "FROM reviews "
            "WHERE user_id = ? "
            "ORDER BY COALESCE(updated_at, created_at) DESC, id DESC"
        )
        res_json = self._execute_d1(sql_query, params=[user_id], debug_label="FETCH")
        if res_json is not None:
            rows = self._extract_rows(res_json)
            return pd.DataFrame(rows, columns=["rating", "movie_id", "content", "created_at"])
        return None

    def fetch_all_ratings(self, batch_size: int = 10000):
        sql_query = (
            "SELECT user_id, movie_id, rating "
            "FROM reviews "
            "WHERE rating IS NOT NULL "
            "ORDER BY COALESCE(updated_at, created_at) DESC, id DESC "
            "LIMIT ? OFFSET ?"
        )
        all_rows = []
        offset = 0

        while True:
            res_json = self._execute_d1(sql_query, params=[batch_size, offset])
            if res_json is None:
                return None

            rows = self._extract_rows(res_json)
            if not rows:
                break

            all_rows.extend(rows)
            if len(rows) < batch_size:
                break
            offset += batch_size

        if not all_rows:
            return pd.DataFrame(columns=["user_id", "movie_id", "rating"])

        df = pd.DataFrame(all_rows)[["user_id", "movie_id", "rating"]]
        for col in ("user_id", "movie_id", "rating"):
            df[col] = pd.to_numeric(df[col], errors="coerce")

        df = df.dropna(subset=["user_id", "movie_id", "rating"])
        df["user_id"] = df["user_id"].astype(int)
        df["movie_id"] = df["movie_id"].astype(int)
        df["rating"] = df["rating"].astype(float)

        # Tabela reviews nie ma UNIQUE(user_id, movie_id), więc zachowujemy najnowszą ocenę dla pary.
        df = df.drop_duplicates(subset=["user_id", "movie_id"], keep="first").reset_index(drop=True)
        return df

    def fetch_watched_movies(self, user_id: int):
        sql_query = "SELECT movie_id FROM watched WHERE user_id = ?"
        res_json = self._execute_d1(sql_query, params=[user_id])
        if res_json is not None:
            rows = self._extract_rows(res_json)
            return [r["movie_id"] for r in rows] if rows else []
        return []

    def fetch_watched_detailed(self, user_id: int) -> list[dict]:
        """Pobiera historię obejrzeń użytkownika z datą i statusem."""
        sql_query = (
            "SELECT movie_id, IFNULL(status, 'watched') AS status, watched_date "
            "FROM watched WHERE user_id = ? ORDER BY watched_date DESC, id DESC"
        )
        res_json = self._execute_d1(sql_query, params=[user_id])
        if res_json is not None:
            rows = self._extract_rows(res_json)
            return [
                {
                    "movie_id": int(r["movie_id"]),
                    "status": r.get("status") or "watched",
                    "watched_date": r.get("watched_date"),
                }
                for r in rows
                if r.get("movie_id") is not None
            ]
        return []

    def fetch_onboarding_movies(self, user_id: int):
        sql_query = "SELECT movie_id FROM user_onboarding_movies WHERE user_id = ?"
        res_json = self._execute_d1(sql_query, params=[user_id])
        if res_json is not None:
            rows = self._extract_rows(res_json)
            return [r["movie_id"] for r in rows] if rows else []
        return []

    def get_cached_recommendations(self, user_id: int, rec_type: str):
        sql_query = (
            "SELECT movie_id, predicted_rating, confidence_lower, confidence_upper, rank, updated_at "
            "FROM user_recommendations "
            "WHERE user_id = ? AND recommendation_type = ? "
            "ORDER BY rank ASC, predicted_rating DESC"
        )
        res_json = self._execute_d1(sql_query, params=[user_id, rec_type])
        if res_json is not None:
            rows = self._extract_rows(res_json)
            return [
                {
                    "movie_id": r["movie_id"],
                    "rating": r["predicted_rating"],
                    "confidence_interval": [r["confidence_lower"], r["confidence_upper"]],
                    "rank": r.get("rank"),
                    "updated_at": r.get("updated_at"),
                }
                for r in rows
            ] if rows else None
        return None

    def save_cached_recommendations(self, user_id: int, recs: list, rec_type: str) -> bool:
        if not recs:
            return False
        uid = int(user_id)
        safe_rec_type = str(rec_type).replace("'", "''")

        delete_query = (
            f"DELETE FROM user_recommendations "
            f"WHERE user_id = {uid} AND recommendation_type = '{safe_rec_type}';\n"
        )
        insert_header = (
            "INSERT OR REPLACE INTO user_recommendations "
            "(user_id, movie_id, rank, predicted_rating, confidence_lower, confidence_upper, recommendation_type, updated_at) VALUES "
        )
        values = [
            f"({uid}, {int(r['movie_id'])}, {rank}, {float(r['rating'])}, "
            f"{float(r['confidence_interval'][0])}, {float(r['confidence_interval'][1])}, "
            f"'{safe_rec_type}', strftime('%Y-%m-%d %H:%M:%f', 'now'))"
            for rank, r in enumerate(recs, start=1)
        ]
        sql = delete_query + insert_header + ",\n".join(values) + ";"
        res_json = self._execute_d1(sql, debug_label="SAVE")
        return res_json is not None

    def fetch_users(self):
        sql_query = "SELECT id, nickname FROM users ORDER BY id"
        res_json = self._execute_d1(sql_query)
        if res_json is not None:
            rows = self._extract_rows(res_json)
            return [{"user_id": r["id"], "nickname": r["nickname"]} for r in rows] if rows else []
        return []

    def get_local_movies_db_signature(self):
        """Zwraca lekką sygnaturę pliku lokalnej bazy movies.db (rozmiar + mtime_ns)."""
        if not os.path.exists(self.local_db_path):
            return None
        try:
            st = os.stat(self.local_db_path)
            return f"{st.st_size}:{st.st_mtime_ns}"
        except OSError:
            return None

    def fetch_movies_by_ids(self, movie_ids: list[int]) -> dict[int, dict]:
        """Pobiera metadane wybranych filmów/seriali z lokalnej bazy movies.db."""
        unique_ids = list({int(m) for m in movie_ids if m is not None})
        if not unique_ids or not os.path.exists(self.local_db_path):
            return {}

        result: dict[int, dict] = {}
        try:
            conn = sqlite3.connect(self.local_db_path)
            conn.row_factory = sqlite3.Row
            try:
                for start in range(0, len(unique_ids), 500):
                    chunk = unique_ids[start:start + 500]
                    placeholders = ",".join("?" for _ in chunk)
                    rows = conn.execute(
                        f"""
                        SELECT
                            id,
                            title,
                            release_date,
                            media_type,
                            COALESCE(NULLIF(genres, ''), genre, '') AS genres,
                            IFNULL(director, '') AS director,
                            IFNULL("cast", '') AS cast_members,
                            IFNULL(tagline, '') AS tagline,
                            COALESCE(NULLIF(overview, ''), description, '') AS overview
                        FROM movies
                        WHERE id IN ({placeholders})
                        """,
                        chunk,
                    ).fetchall()
                    for row in rows:
                        result[int(row["id"])] = dict(row)
            finally:
                conn.close()
        except Exception as e:
            print(f"Błąd odczytu metadanych filmów po ID: {e}")
        return result

    def fetch_movies_metadata(self):
        if not os.path.exists(self.local_db_path):
            print("BŁĄD: Brak pliku lokalnej bazy danych!")
            return None
        try:
            conn = sqlite3.connect(self.local_db_path)
            df = pd.read_sql_query("SELECT id, title, genre, overview, \"cast\" FROM movies", conn)
            conn.close()
            return df
        except Exception as e:
            print(f"Błąd odczytu z lokalnej bazy: {e}")
            return None
        
    def fetch_movies_features(self):
        try:
            conn = sqlite3.connect(self.local_db_path)
            # Pobieramy cechy; funkcja IFNULL zabezpiecza przed pustymi polami (NaN)
            query = """
            SELECT id, 
                   IFNULL(genres, '') AS genres, 
                   IFNULL("cast", '') AS cast_members, 
                   IFNULL(director, '') AS director, 
                   IFNULL(overview, '') AS overview 
            FROM movies
            """
            df = pd.read_sql_query(query, conn)
            conn.close()
            return df
        except Exception as e:
            print(f"Błąd odczytu cech: {e}")
            return None
