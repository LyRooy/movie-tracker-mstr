"""Buduje i testuje lokalny indeks wektorowy filmów z movies.db przy użyciu lokalnej Ollamy."""

import argparse
import json
import os
import sqlite3
import sys
import time
from pathlib import Path

import numpy as np
import requests
from numpy.lib.format import open_memmap

DEFAULT_DB_PATH = Path(__file__).resolve().parent / "movies.db"
DEFAULT_OUTPUT_DIR = Path(__file__).resolve().parent / "models"
DEFAULT_OLLAMA_URL = os.getenv("OLLAMA_BASE_URL", "http://192.168.0.109:11434/v1")
DEFAULT_EMBED_MODEL = os.getenv("OLLAMA_EMBED_MODEL", "embeddinggemma-2:latest")
MAX_DOC_CHARS = 1500
CHECKPOINT_EVERY_BATCHES = 20


def normalize_v1_url(url: str) -> str:
    """Normalizuje bazowy adres Ollamy do postaci zakończonej na /v1."""
    clean = url.strip().rstrip("/")
    if not clean.endswith("/v1"):
        clean = f"{clean}/v1"
    return clean


def get_db_signature(db_path: Path) -> str:
    st = db_path.stat()
    return f"{st.st_size}:{st.st_mtime_ns}"


def check_ollama_model(session: requests.Session, v1_url: str, requested_model: str) -> str:
    """Sprawdza połączenie z Ollamą i dopasowuje nazwę zainstalowanego modelu embeddingowego."""
    try:
        res = session.get(f"{v1_url}/models", timeout=15)
        res.raise_for_status()
        data = res.json()
    except Exception as e:
        raise RuntimeError(f"Nie można połączyć się z Ollamą pod adresem {v1_url}: {e}") from e

    available = [
        item["id"]
        for item in (data.get("data") or [])
        if isinstance(item, dict) and item.get("id")
    ]
    if not available:
        raise RuntimeError(f"Ollama pod adresem {v1_url} nie zwróciła żadnych modeli.")

    if requested_model in available:
        return requested_model
    if f"{requested_model}:latest" in available:
        return f"{requested_model}:latest"

    req_base = requested_model.split(":")[0]
    for model_id in available:
        if model_id.split(":")[0] == req_base:
            return model_id

    available_str = ", ".join(available)
    raise RuntimeError(
        f"Nie znaleziono modelu '{requested_model}' w Ollamie ({v1_url}). "
        f"Dostępne modele: {available_str}"
    )


def format_movie_document(row: dict) -> str:
    """Formatuje metadane filmu/serialu w tekst dokumentu pod model EmbeddingGemma."""
    title = (row.get("title") or "").strip() or "Untitled"
    orig_title = (row.get("original_title") or "").strip()
    media_type = "TV series" if row.get("media_type") == "series" else "Movie"

    release_date = (row.get("release_date") or "").strip()
    year = release_date[:4] if len(release_date) >= 4 and release_date[:4].isdigit() else ""

    genres = (row.get("genres") or "").strip()
    director = (row.get("director") or "").strip()
    cast_raw = (row.get("cast_members") or "").strip()
    cast_top = ", ".join(c.strip() for c in cast_raw.split(",")[:5] if c.strip())
    tagline = (row.get("tagline") or "").strip()
    overview = (row.get("overview") or "").strip()

    header = f"{media_type} ({year})" if year else media_type
    parts = [header]
    if orig_title and orig_title.lower() != title.lower():
        parts.append(f"Original title: {orig_title}")
    if genres:
        parts.append(f"Genres: {genres}")
    if director:
        parts.append(f"Director: {director}")
    if cast_top:
        parts.append(f"Cast: {cast_top}")
    if tagline:
        parts.append(f"Tagline: {tagline}")
    if overview:
        parts.append(f"Overview: {overview}")

    body = " | ".join(parts)
    doc = f"title: {title} | text: {body}"
    return doc[:MAX_DOC_CHARS]


def format_query_text(query: str, model: str) -> str:
    clean = query.strip()
    if "embeddinggemma" in model.lower():
        return f"task: search result | query: {clean}"
    return clean


def l2_normalize(vectors: np.ndarray) -> np.ndarray:
    """Normalizuje wektory (1D lub 2D) do jednostkowej długości L2 w float32."""
    arr = np.asarray(vectors, dtype=np.float32)
    norms = np.linalg.norm(arr, axis=-1, keepdims=True)
    norms = np.where(norms == 0.0, 1.0, norms)
    return arr / norms


def embed_batch(
    session: requests.Session,
    v1_url: str,
    model: str,
    texts: list[str],
    max_retries: int = 3,
) -> np.ndarray:
    """Pobiera embeddingi paczki tekstów z automatycznym retry oraz dzieleniem paczki w razie błędu."""
    payload = {"model": model, "input": texts}
    last_error = None

    for attempt in range(max_retries + 1):
        try:
            res = session.post(f"{v1_url}/embeddings", json=payload, timeout=120)
            if res.status_code == 200:
                items = res.json().get("data") or []
                if len(items) != len(texts):
                    raise ValueError(
                        f"Ollama zwróciła {len(items)} wektorów dla {len(texts)} tekstów."
                    )
                items.sort(key=lambda item: item.get("index", 0))
                return np.asarray([item["embedding"] for item in items], dtype=np.float32)

            if res.status_code == 400 and len(texts) > 1:
                break

            last_error = RuntimeError(f"HTTP {res.status_code}: {res.text[:300]}")
        except requests.RequestException as e:
            last_error = e

        if attempt < max_retries:
            delay = min(10.0, 1.5 * (attempt + 1))
            time.sleep(delay)

    if len(texts) > 1:
        mid = len(texts) // 2
        left = embed_batch(session, v1_url, model, texts[:mid], max_retries=max_retries)
        right = embed_batch(session, v1_url, model, texts[mid:], max_retries=max_retries)
        return np.vstack([left, right])

    # Ostatnia szansa dla pojedynczego zbyt długiego tekstu.
    if len(texts) == 1 and len(texts[0]) > 400:
        return embed_batch(session, v1_url, model, [texts[0][:400]], max_retries=1)

    raise RuntimeError(f"Nie udało się wyliczyć embeddingu: {last_error}")


def write_json_atomic(path: Path, data: dict) -> None:
    tmp_path = path.with_suffix(".json.tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp_path, path)


def write_npy_atomic(path: Path, array: np.ndarray) -> None:
    tmp_path = path.with_suffix(".npy.tmp")
    with open(tmp_path, "wb") as f:
        np.save(f, array)
    os.replace(tmp_path, path)


def load_movies_rows(db_path: Path, limit: int | None = None) -> list[dict]:
    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        sql = """
            SELECT
                id,
                title,
                original_title,
                release_date,
                media_type,
                COALESCE(NULLIF(genres, ''), genre, '') AS genres,
                director,
                "cast" AS cast_members,
                tagline,
                COALESCE(NULLIF(overview, ''), description, '') AS overview
            FROM movies
            ORDER BY id ASC
        """
        params: tuple = ()
        if limit is not None:
            sql += " LIMIT ?"
            params = (int(limit),)
        rows = conn.execute(sql, params).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def format_eta(seconds: float) -> str:
    if seconds < 0 or not np.isfinite(seconds):
        return "--:--"
    secs = int(seconds)
    hours, rem = divmod(secs, 3600)
    mins, secs = divmod(rem, 60)
    if hours > 0:
        return f"{hours}h {mins:02d}m {secs:02d}s"
    return f"{mins:02d}m {secs:02d}s"


def build_index(args: argparse.Namespace) -> None:
    db_path = Path(args.db)
    if not db_path.exists():
        raise FileNotFoundError(f"Nie znaleziono bazy danych: {db_path}")

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)
    embeddings_path = output_dir / "movie_embeddings.npy"
    ids_path = output_dir / "movie_embedding_ids.npy"
    meta_path = output_dir / "embeddings_meta.json"

    v1_url = normalize_v1_url(args.ollama_url)
    session = requests.Session()
    resolved_model = check_ollama_model(session, v1_url, args.model)
    print(f"Połączono z Ollamą ({v1_url}), model: {resolved_model}")

    db_signature = get_db_signature(db_path)
    print(f"Wczytywanie filmów z {db_path}...")
    rows = load_movies_rows(db_path, limit=args.limit)
    total_movies = len(rows)
    if total_movies == 0:
        raise RuntimeError("Baza movies.db nie zawiera żadnych filmów.")

    movie_ids = np.asarray([int(r["id"]) for r in rows], dtype=np.int64)
    start_idx = 0
    dim = None
    mmap = None

    if not args.reset and meta_path.exists() and embeddings_path.exists() and ids_path.exists():
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                meta = json.load(f)
            existing_ids = np.load(str(ids_path))
            same_config = (
                meta.get("model") == resolved_model
                and meta.get("total_movies") == total_movies
                and meta.get("db_signature") == db_signature
                and meta.get("limit") == args.limit
                and np.array_equal(existing_ids, movie_ids)
            )
            if same_config:
                dim = int(meta["dim"])
                completed_count = int(meta.get("completed_count", 0))
                if meta.get("completed") and completed_count == total_movies:
                    print(
                        f"Indeks wektorowy jest już kompletny ({total_movies} x {dim}) w {output_dir}. "
                        "Użyj --reset, aby przeliczyć go od nowa."
                    )
                    return
                mmap = open_memmap(str(embeddings_path), mode="r+", dtype=np.float16, shape=(total_movies, dim))
                start_idx = completed_count
                print(f"Wznawianie indeksowania od pozycji {start_idx}/{total_movies} (wymiar: {dim})...")
        except Exception as e:
            print(f"Nie można wznowić istniejącego indeksu ({e}) — budowanie od zera.")
            start_idx = 0
            mmap = None

    if mmap is None:
        write_npy_atomic(ids_path, movie_ids)

    batch_size = max(1, int(args.batch_size))
    processed_this_run = 0
    run_started = time.perf_counter()
    current_completed = start_idx

    def save_checkpoint(completed_flag: bool) -> None:
        if mmap is None or dim is None:
            return
        mmap.flush()
        write_json_atomic(
            meta_path,
            {
                "model": resolved_model,
                "dim": dim,
                "dtype": "float16",
                "normalized": True,
                "total_movies": total_movies,
                "completed_count": current_completed,
                "completed": completed_flag,
                "db_signature": db_signature,
                "limit": args.limit,
                "updated_at": time.time(),
            },
        )

    try:
        for batch_num, batch_start in enumerate(range(start_idx, total_movies, batch_size), start=1):
            batch_end = min(total_movies, batch_start + batch_size)
            texts = [format_movie_document(rows[i]) for i in range(batch_start, batch_end)]

            vecs = embed_batch(session, v1_url, resolved_model, texts)
            norm_vecs = l2_normalize(vecs).astype(np.float16)

            if mmap is None:
                dim = int(norm_vecs.shape[1])
                mmap = open_memmap(
                    str(embeddings_path),
                    mode="w+",
                    dtype=np.float16,
                    shape=(total_movies, dim),
                )
                write_json_atomic(
                    meta_path,
                    {
                        "model": resolved_model,
                        "dim": dim,
                        "dtype": "float16",
                        "normalized": True,
                        "total_movies": total_movies,
                        "completed_count": 0,
                        "completed": False,
                        "db_signature": db_signature,
                        "limit": args.limit,
                        "updated_at": time.time(),
                    },
                )

            mmap[batch_start:batch_end] = norm_vecs
            current_completed = batch_end
            processed_this_run += batch_end - batch_start

            if batch_num % CHECKPOINT_EVERY_BATCHES == 0 or batch_end == total_movies:
                save_checkpoint(completed_flag=(batch_end == total_movies))

            elapsed = max(1e-6, time.perf_counter() - run_started)
            speed = processed_this_run / elapsed
            remaining = total_movies - current_completed
            eta = format_eta(remaining / speed if speed > 0 else float("inf"))
            pct = (current_completed / total_movies) * 100.0
            print(
                f"[{current_completed:,}/{total_movies:,} | {pct:5.1f}%] "
                f"{speed:6.1f} filmów/s | ETA: {eta}"
            )
    except KeyboardInterrupt:
        print("\nPrzerwano przez użytkownika — zapisywanie postępu...")
        save_checkpoint(completed_flag=False)
        print(f"Zapisano punkt kontrolny na {current_completed:,}/{total_movies:,}.")
        sys.exit(130)

    print(f"\nGotowe! Zindeksowano {current_completed:,} filmów (wymiar {dim}) w {output_dir}.")


def search_index(args: argparse.Namespace) -> None:
    output_dir = Path(args.output_dir)
    embeddings_path = output_dir / "movie_embeddings.npy"
    ids_path = output_dir / "movie_embedding_ids.npy"
    meta_path = output_dir / "embeddings_meta.json"
    db_path = Path(args.db)

    if not meta_path.exists() or not embeddings_path.exists() or not ids_path.exists():
        raise FileNotFoundError(
            f"Brak gotowego indeksu w {output_dir}. Najpierw uruchom skrypt bez --search."
        )

    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    active_count = int(meta.get("completed_count") or meta["total_movies"])
    if active_count <= 0:
        raise RuntimeError("Indeks jest pusty (0 zindeksowanych filmów).")

    embed_model = meta.get("model") or args.model
    v1_url = normalize_v1_url(args.ollama_url)
    session = requests.Session()
    resolved_model = check_ollama_model(session, v1_url, embed_model)

    t0 = time.perf_counter()
    query_text = format_query_text(args.search, resolved_model)
    query_vec = l2_normalize(embed_batch(session, v1_url, resolved_model, [query_text])[0])

    embeddings = np.load(str(embeddings_path), mmap_mode="r")
    movie_ids = np.load(str(ids_path))

    scores = np.empty(active_count, dtype=np.float32)
    chunk_size = 50000
    for start in range(0, active_count, chunk_size):
        end = min(active_count, start + chunk_size)
        scores[start:end] = embeddings[start:end].astype(np.float32) @ query_vec

    top_k = min(max(1, int(args.top_k)), active_count)
    top_idx = np.argpartition(scores, -top_k)[-top_k:]
    top_idx = top_idx[np.argsort(scores[top_idx])[::-1]]

    elapsed_ms = (time.perf_counter() - t0) * 1000.0
    selected_ids = [int(movie_ids[i]) for i in top_idx]

    conn = sqlite3.connect(str(db_path))
    conn.row_factory = sqlite3.Row
    try:
        placeholders = ",".join("?" for _ in selected_ids)
        rows = conn.execute(
            f"""
            SELECT id, title, release_date, COALESCE(NULLIF(genres, ''), genre, '') AS genres, director
            FROM movies
            WHERE id IN ({placeholders})
            """,
            selected_ids,
        ).fetchall()
        by_id = {int(r["id"]): dict(r) for r in rows}
    finally:
        conn.close()

    print(f"\nZapytanie: {args.search!r} (czas: {elapsed_ms:.1f} ms, zindeksowano: {active_count:,})\n")
    for rank, idx in enumerate(top_idx, start=1):
        m_id = int(movie_ids[idx])
        score = float(scores[idx])
        info = by_id.get(m_id, {})
        year = (info.get("release_date") or "")[:4] or "----"
        title = info.get("title") or f"ID {m_id}"
        genres = info.get("genres") or "-"
        director = info.get("director") or "-"
        print(f"{rank:2d}. [{score:.4f}] {title} ({year}) | {genres} | reż. {director} [id={m_id}]")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Indekser wektorowy filmów z movies.db przez Ollamę")
    parser.add_argument("--db", default=str(DEFAULT_DB_PATH), help="Ścieżka do pliku movies.db")
    parser.add_argument("--output-dir", default=str(DEFAULT_OUTPUT_DIR), help="Katalog docelowy na indeks")
    parser.add_argument("--ollama-url", default=DEFAULT_OLLAMA_URL, help="Adres API Ollamy (np. http://192.168.0.109:11434/v1)")
    parser.add_argument("--model", default=DEFAULT_EMBED_MODEL, help="Nazwa modelu embeddingowego w Ollamie")
    parser.add_argument("--batch-size", type=int, default=64, help="Liczba filmów w jednym zapytaniu do Ollamy")
    parser.add_argument("--limit", type=int, default=None, help="Opcjonalny limit filmów (np. do szybkiego testu)")
    parser.add_argument("--reset", action="store_true", help="Wymuś budowanie indeksu od zera")
    parser.add_argument("--search", type=str, default=None, help="Tryb testowego wyszukiwania semantycznego")
    parser.add_argument("--top-k", type=int, default=10, help="Liczba wyników w trybie --search")
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if args.search:
        search_index(args)
    else:
        build_index(args)


if __name__ == "__main__":
    main()
