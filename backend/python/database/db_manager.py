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

    def fetch_user_ratings(self, user_id: int):
        sql_query = "SELECT rating, movie_id FROM reviews WHERE user_id = ? ORDER BY created_at DESC"
        payload = {"sql": sql_query, "params": [user_id]}
        
        res = requests.post(self.endpoint, json=payload, headers=self.headers)
        
        # Debug, abyśmy widzieli co Cloudflare faktycznie odpowiada
        print(f"DEBUG FETCH D1 Status: {res.status_code} | Body: {res.text}")
        
        if res.status_code == 200:
            data = res.json().get("result", [])
            rows = data[0].get('results', []) if data and 'results' in data[0] else data
            return pd.DataFrame(rows, columns=["rating", "movie_id"])
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
            payload = {"sql": sql_query, "params": [batch_size, offset]}
            try:
                res = requests.post(self.endpoint, json=payload, headers=self.headers)
            except Exception as e:
                print(f"BŁĄD FETCH ALL D1 (sieć): {e}")
                return None

            if res.status_code != 200:
                print(f"BŁĄD FETCH ALL D1 Status: {res.status_code} | Body: {res.text}")
                return None

            try:
                res_json = res.json()
            except Exception as e:
                print(f"BŁĄD FETCH ALL D1 (JSON): {e}")
                return None

            if res_json.get("success") is False:
                print(f"BŁĄD FETCH ALL D1 Body: {res.text}")
                return None

            data = res_json.get("result", [])
            rows = data[0].get('results', []) if data and 'results' in data[0] else data
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
        payload = {"sql": sql_query, "params": [user_id]}
        
        res = requests.post(self.endpoint, json=payload, headers=self.headers)
        if res.status_code == 200:
            data = res.json().get("result", [])
            rows = data[0].get('results', []) if data and 'results' in data[0] else data
            return [r["movie_id"] for r in rows] if rows else []
        return []

    def fetch_onboarding_movies(self, user_id: int):
        sql_query = "SELECT movie_id FROM user_onboarding_movies WHERE user_id = ?"
        payload = {"sql": sql_query, "params": [user_id]}
        
        res = requests.post(self.endpoint, json=payload, headers=self.headers)
        if res.status_code == 200:
            data = res.json().get("result", [])
            rows = data[0].get('results', []) if data and 'results' in data[0] else data
            return [r["movie_id"] for r in rows] if rows else []
        return []

    def get_cached_recommendations(self, user_id: int, rec_type: str):
        sql_query = "SELECT movie_id, predicted_rating, confidence_lower, confidence_upper FROM user_recommendations WHERE user_id = ? AND recommendation_type = ? AND expires_at > ? ORDER BY predicted_rating DESC"
        payload = {"sql": sql_query, "params": [user_id, rec_type, str(int(time.time()))]}
        
        res = requests.post(self.endpoint, json=payload, headers=self.headers)
        if res.status_code == 200:
            data = res.json().get("result", [])
            rows = data[0].get('results', []) if data else []
            return [{"movie_id": r["movie_id"], "rating": r["predicted_rating"], "confidence_interval": [r["confidence_lower"], r["confidence_upper"]]} for r in rows] if rows else None
        return None

    def save_cached_recommendations(self, user_id: int, recs: list, minutes: int, rec_type: str):
        if not recs:
            return
        expires_at = str(int(time.time()) + (minutes * 60))
        base_query = "INSERT OR REPLACE INTO user_recommendations (user_id, movie_id, predicted_rating, confidence_lower, confidence_upper, recommendation_type, expires_at) VALUES "
        values = [f"({user_id}, {r['movie_id']}, {r['rating']}, {r['confidence_interval'][0]}, {r['confidence_interval'][1]}, '{rec_type}', '{expires_at}')" for r in recs]
        
        payload = {"sql": base_query + ",\n".join(values) + ";"}
        res = requests.post(self.endpoint, json=payload, headers=self.headers)
        
        print(f"DEBUG SAVE D1 Status: {res.status_code} | Body: {res.text}")

    def fetch_users(self):
        sql_query = "SELECT id, nickname FROM users ORDER BY id"
        payload = {"sql": sql_query}
        res = requests.post(self.endpoint, json=payload, headers=self.headers)
        if res.status_code == 200:
            data = res.json().get("result", [])
            rows = data[0].get('results', []) if data else []
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
