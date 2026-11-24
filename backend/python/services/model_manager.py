import hashlib
import os
import pickle
import threading
import time
from pathlib import Path
import pandas as pd
from surprise import SVD
from sklearn.feature_extraction.text import TfidfVectorizer

class ProgressTracker:
    def __init__(self):
        self._lock = threading.Lock()
        # klucze: "cf" / "cb" / "llm" — inicjalizowane od razu, żeby /admin/ws nie
        # rzucał KeyError zanim jakikolwiek model zacznie sie budować.
        self.models = {
            "cf": {"status": "not_started", "events": [], "logs": [], "count": None},
            "cb": {"status": "not_started", "events": [], "logs": [], "count": None},
            "llm": {"status": "not_started", "events": [], "logs": [], "count": None},
        }

    def record_count(self, key, count):
        with self._lock:
            self.models[key]["count"] = count

    def _model(self, key):
        if key not in self.models:
            self.models[key] = {"status": "not_started", "events": [], "logs": []}
        return self.models[key]

    def start(self, key, name, desc):
        with self._lock:
            m = self._model(key)
            m["count"] = 0
            if m["status"] != "running":
                m["status"] = "running"
                m["events"].append({"t": round(time.time()*1000), "level": "info", "event": "building", "model": key, "name": name, "message": desc})

    def finish(self, key, name, ok=True, message=None):
        with self._lock:
            m = self._model(key)
            status = "ready" if ok else "error"
            if m["status"] != status:
                m["status"] = status
                m["events"].append({"t": round(time.time()*1000), "level": "info", "event": "built", "model": key, "name": name, "ok": ok, "message": message or (f"Zbudowano model {name}" if ok else f"Błąd budowania modelu {name}")})

    def log(self, key, name, message, level="info"):
        with self._lock:
            m = self._model(key)
            m["logs"].append({"t": round(time.time()*1000), "level": level, "model": key, "name": name, "message": message})

    def snapshot(self, key):
        with self._lock:
            return {
                "status": self._model(key)["status"],
                "events": list(self._model(key)["events"]),
                "logs": list(self._model(key)["logs"]),
                "count": self._model(key).get("count"),
            }


tracker = ProgressTracker()

class RecommendationModelManager:
    
    def __init__(self, models_dir=None):
        self._cf_lock = threading.RLock()
        self._cb_lock = threading.RLock()
        self.cf_model = None
        self.cf_data_signature = None
        self.tfidf_matrix = None
        self.movie_indices = None
        self.movie_id_map = None # Błyskawiczne mapowanie ID bez odpytywania bazy
        self.cb_data_signature = None

        self.models_dir = Path(models_dir) if models_dir is not None else Path(__file__).resolve().parent.parent / "models"
        self.models_dir.mkdir(parents=True, exist_ok=True)
        self.cf_model_path = self.models_dir / "cf_model.pkl"
        self.cb_model_path = self.models_dir / "cb_model.pkl"
        self.load_cf_model()
        self.load_cb_model()

    def _atomic_write_pickle(self, path: Path, payload: dict, key: str, label: str) -> bool:
        """Zapisuje słownik z modelem atomowo do pliku .pkl (poprzez plik tymczasowy)."""
        self.models_dir.mkdir(parents=True, exist_ok=True)
        tmp_path = path.with_suffix(".pkl.tmp")
        try:
            with open(tmp_path, "wb") as f:
                pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
            os.replace(tmp_path, path)
            tracker.log(key, key.upper(), f"Zapisano {label} na dysku: {path.name}")
            return True
        except Exception as e:
            if tmp_path.exists():
                try:
                    tmp_path.unlink()
                except OSError:
                    pass
            tracker.log(key, key.upper(), f"Błąd zapisu {label} na dysk: {e}", level="error")
            print(f"Błąd zapisu {label} na dysk: {e}")
            return False

    def _read_pickle(self, path: Path, key: str, label: str):
        """Wczytuje słownik z modelem z pliku .pkl; w razie błędu zwraca None."""
        if not path.exists():
            return None
        try:
            with open(path, "rb") as f:
                payload = pickle.load(f)
            if not isinstance(payload, dict):
                raise ValueError(f"Nieprawidłowy format pliku {label}.")
            return payload
        except Exception as e:
            tracker.log(key, key.upper(), f"Nie udało się wczytać {label} z dysku ({path.name}): {e}", level="warning")
            print(f"Błąd odczytu {label} z dysku: {e}")
            return None

    def save_cf_model(self, trainset=None) -> bool:
        """Zapisuje globalny model CF i sygnaturę danych atomowo na dysk."""
        with self._cf_lock:
            if self.cf_model is None:
                return False
            payload = {
                "model": self.cf_model,
                "data_signature": self.cf_data_signature,
                "saved_at": time.time(),
                "n_users": getattr(trainset, "n_users", None),
                "n_items": getattr(trainset, "n_items", None),
                "n_ratings": getattr(trainset, "n_ratings", None),
            }
            return self._atomic_write_pickle(self.cf_model_path, payload, "cf", "model CF")

    def load_cf_model(self) -> bool:
        """Wczytuje globalny model CF z dysku przy starcie aplikacji."""
        with self._cf_lock:
            payload = self._read_pickle(self.cf_model_path, "cf", "modelu CF")
            if payload is None or payload.get("model") is None:
                if self.cf_model_path.exists():
                    self.cf_model = None
                    self.cf_data_signature = None
                return False

            self.cf_model = payload["model"]
            self.cf_data_signature = payload.get("data_signature")

            stats_parts = []
            if payload.get("n_users") is not None:
                stats_parts.append(f"{payload['n_users']} użytkowników")
            if payload.get("n_items") is not None:
                stats_parts.append(f"{payload['n_items']} filmów")
            if payload.get("n_ratings") is not None:
                stats_parts.append(f"{payload['n_ratings']} ocen")
            stats_suffix = f" ({', '.join(stats_parts)})" if stats_parts else ""

            tracker.log("cf", "CF", f"Wczytano model CF z dysku: {self.cf_model_path.name}{stats_suffix}")
            tracker.finish("cf", "CF", ok=True, message=f"Wczytano model CF z dysku{stats_suffix}")
            print(f"Wczytano model CF z dysku: {self.cf_model_path}{stats_suffix}.")
            return True

    def save_cb_model(self) -> bool:
        """Zapisuje globalną macierz TF-IDF oraz mapowania ID atomowo na dysk."""
        with self._cb_lock:
            if self.tfidf_matrix is None or self.movie_indices is None or self.movie_id_map is None:
                return False
            payload = {
                "tfidf_matrix": self.tfidf_matrix,
                "movie_indices": self.movie_indices,
                "movie_id_map": self.movie_id_map,
                "data_signature": self.cb_data_signature,
                "saved_at": time.time(),
            }
            return self._atomic_write_pickle(self.cb_model_path, payload, "cb", "model CB (TF-IDF)")

    def load_cb_model(self) -> bool:
        """Wczytuje globalną macierz TF-IDF z dysku przy starcie aplikacji."""
        with self._cb_lock:
            payload = self._read_pickle(self.cb_model_path, "cb", "modelu CB (TF-IDF)")
            if (
                payload is None
                or payload.get("tfidf_matrix") is None
                or payload.get("movie_indices") is None
                or payload.get("movie_id_map") is None
            ):
                if self.cb_model_path.exists():
                    self.tfidf_matrix = None
                    self.movie_indices = None
                    self.movie_id_map = None
                    self.cb_data_signature = None
                return False

            self.tfidf_matrix = payload["tfidf_matrix"]
            self.movie_indices = payload["movie_indices"]
            self.movie_id_map = payload["movie_id_map"]
            self.cb_data_signature = payload.get("data_signature")

            shape = getattr(self.tfidf_matrix, "shape", None)
            shape_suffix = f" ({shape[0]} filmów x {shape[1]} wymiarów)" if shape and len(shape) >= 2 else ""

            tracker.log("cb", "CB", f"Wczytano model CB z dysku: {self.cb_model_path.name}{shape_suffix}")
            tracker.finish("cb", "CB", ok=True, message=f"Wczytano model CB z dysku{shape_suffix}")
            print(f"Wczytano model CB z dysku: {self.cb_model_path}{shape_suffix}.")
            return True

    @staticmethod
    def compute_cf_signature(ratings_df) -> str:
        """Zwraca deterministyczny skrót SHA-256 zbioru (user_id, movie_id, rating) do wykrywania zmian."""
        if ratings_df is None or ratings_df.empty:
            return hashlib.sha256(b"").hexdigest()
        sorted_df = ratings_df.sort_values(by=["user_id", "movie_id"])
        serialized = ";".join(
            f"{int(u)}:{int(m)}:{float(r):.4f}"
            for u, m, r in zip(sorted_df["user_id"], sorted_df["movie_id"], sorted_df["rating"])
        )
        return hashlib.sha256(serialized.encode("utf-8")).hexdigest()

    def build_collaborative_filtering_model(self, trainset, user_id=None, data_signature=None) -> bool:
        trigger_info = f"wyzwalacz: user_id={user_id}, " if user_id is not None else ""
        dataset_info = f"{trainset.n_users} użytkowników, {trainset.n_items} filmów, {trainset.n_ratings} ocen"
        with self._cf_lock:
            tracker.start("cf", "CF", f"Budowanie globalnego modelu Collaborative Filtering ({trigger_info}{dataset_info})")
            try:
                svd = SVD(n_factors=100, n_epochs=20, random_state=42)
                svd.fit(trainset)
                self.cf_model = svd
                self.cf_data_signature = data_signature
                self.save_cf_model(trainset=trainset)
                tracker.log("cf", "CF", f"SVD(n_factors=100, n_epochs=20, random_state=42) | {dataset_info} | {trigger_info.rstrip(', ')}")
                tracker.finish("cf", "CF", ok=True, message=f"Globalny model CF gotowy ({dataset_info})")
                print(f"Globalny model CF (SVD) zbudowany poprawnie: {dataset_info}.")
                return True
            except Exception as e:
                tracker.log("cf", "CF", f"Błąd: {e} | {trigger_info}{dataset_info}", level="error")
                tracker.finish("cf", "CF", ok=False, message=f"Błąd budowania globalnego modelu CF ({trigger_info.rstrip(', ')})")
                print(f"Błąd budowania modelu CF: {e}")
                return False

    def build_content_based_model(self, movies_df, user_id=None, data_signature=None) -> bool:
        trigger_info = f"wyzwalacz: user_id={user_id}" if user_id is not None else "inicjalizacja"
        with self._cb_lock:
            tracker.start("cb", "CB", f"Budowanie modelu Content-Based ({trigger_info})")
            try:
                print("Budowanie macierzy rzadkiej TF-IDF dla Content-Based...")
                tracker.log("cb", "CB", f"Łączenie cech: genres, director, cast, overview | {trigger_info}")

                combined_features = (
                    movies_df['genres'] + " " +
                    movies_df['genres'] + " " +
                    movies_df['director'] + " " +
                    movies_df['cast_members'] + " " +
                    movies_df['overview']
                ).fillna('')

                tfidf = TfidfVectorizer(stop_words='english')
                tfidf_matrix = tfidf.fit_transform(combined_features)
                movie_indices = pd.Series(movies_df.index, index=movies_df['id']).drop_duplicates()
                movie_id_map = movies_df['id'].values

                self.tfidf_matrix = tfidf_matrix
                self.movie_indices = movie_indices
                self.movie_id_map = movie_id_map
                self.cb_data_signature = data_signature
                self.save_cb_model()

                tracker.log("cb", "CB", f"Macierz TF-IDF: {self.tfidf_matrix.shape[0]} filmów x {self.tfidf_matrix.shape[1]} wymiarów | {trigger_info}")
                tracker.log("cb", "CB", f"Zmapowano {len(self.movie_id_map)} filmów | {trigger_info}")
                tracker.finish("cb", "CB", ok=True, message=f"Model CB gotowy ({trigger_info})")
                print("Model CB (TF-IDF) zbudowany poprawnie.")
                return True

            except Exception as e:
                tracker.log("cb", "CB", f"Błąd: {e} | {trigger_info}", level="error")
                tracker.finish("cb", "CB", ok=False, message=f"Błąd budowania modelu CB ({trigger_info})")
                print(f"Błąd budowania modelu CB: {e}")
                return False
