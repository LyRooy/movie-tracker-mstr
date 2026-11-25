// Endpoint do ustawiania ulubionych filmów nowego użytkownika (onboarding)
//
// SCHEMAT BAZY DANYCH:
//   ALTER TABLE users ADD COLUMN favorites_selected INTEGER DEFAULT 0;
//   ALTER TABLE users ADD COLUMN favorite_kaggle_ids TEXT DEFAULT NULL;
//
//   favorite_kaggle_ids - JSON-owa tablica ID filmów z datasetu Kaggle,
//   np. '[tt1234567, tt7654321]'. Do dodania gdy dataset zostanie
//   zaimportowany do bazy.

// Pomocnicza funkcja dekodowania tokenu
async function getUserIdFromRequest(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token));
    if (payload.exp < Date.now()) return null;
    return payload.userId;
  } catch {
    return null;
  }
}

// Do dodania: migracja bazy danych
// ALTER TABLE users ADD COLUMN favorites_selected INTEGER DEFAULT 0;
// ALTER TABLE users ADD COLUMN favorite_kaggle_ids TEXT DEFAULT NULL;
//   favorite_kaggle_ids - JSON array ID filmów z datasetu Kaggle, np. '["tt1234567","tt7654321"]'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function resolvePoster(row) {
  let poster = row?.poster_path || row?.poster_url || '';
  if (!poster) return null;
  if (poster.startsWith('http://')) {
    return poster.replace('http://', 'https://');
  }
  if (!poster.startsWith('http')) {
    return `https://image.tmdb.org/t/p/w200${poster}`;
  }
  return poster;
}

// GET - zwróć losową listę filmów lub wyniki wyszukiwania po tytule (?q=...)
export async function onRequestGet(context) {
  const { request, env } = context;

  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  const url = new URL(request.url);
  const query = (url.searchParams.get('q') || '').trim();

  let rowsResult;
  if (query.length >= 2) {
    const pattern = `%${query.toLowerCase()}%`;
    rowsResult = await env.db.prepare(`
      SELECT id, title, poster_path, poster_url, media_type, release_date
      FROM movies
      WHERE LOWER(title) LIKE ? OR LOWER(IFNULL(original_title, '')) LIKE ?
      ORDER BY popularity DESC
      LIMIT 30
    `).bind(pattern, pattern).all();
  } else {
    rowsResult = await env.db.prepare(`
      WITH pool AS (
        SELECT id, title, poster_path, poster_url, media_type, release_date
        FROM movies
        WHERE media_type = 'movie'
          AND ((poster_url IS NOT NULL AND poster_url != '') OR (poster_path IS NOT NULL AND poster_path != ''))
        ORDER BY popularity DESC
        LIMIT 150
      )
      SELECT id, title, poster_path, poster_url, media_type, release_date
      FROM pool
      ORDER BY RANDOM()
      LIMIT 30
    `).all();
  }

  const movies = (rowsResult.results || []).map((row) => ({
    id: row.id,
    title: row.title,
    poster_url: resolvePoster(row),
    media_type: row.media_type,
    release_date: row.release_date || null,
  }));

  return new Response(JSON.stringify(movies), {
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

// POST - zapisz zaznaczone ID filmów z Kaggle i oznacz favorites_selected = 1
export async function onRequestPost(context) {
  const { request, env } = context;

  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }

  try {
    const body = await request.json();
    const movieIds = Array.isArray(body.movieIds) ? body.movieIds : [];
    const skipped = body.skipped === true;

    // Przygotuj zapytania do wykonania w jednym batchu
    const statements = [];
    statements.push(
      env.db.prepare('UPDATE users SET favorites_selected = 1 WHERE id = ?').bind(userId)
    );

    if (movieIds.length > 0) {
      const insertStmt = env.db.prepare(
        'INSERT OR IGNORE INTO user_onboarding_movies (user_id, movie_id) VALUES (?, ?)'
      );
      for (const movieId of movieIds) {
        statements.push(insertStmt.bind(userId, movieId));
      }
    }

    await env.db.batch(statements);

    return new Response(JSON.stringify({ success: true, skipped }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: corsHeaders });
}

