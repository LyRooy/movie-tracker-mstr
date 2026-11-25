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

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// POST - Przenosi wybrane filmy z onboardingu do obejrzanych oraz opcjonalnie zapisuje ich oceny i recenzje
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
    let normalizedItems = [];

    if (Array.isArray(body.items)) {
      normalizedItems = body.items
        .map((it) => {
          const movieId = parseInt(it?.movieId, 10);
          if (!Number.isInteger(movieId) || movieId <= 0) return null;
          const rawRating = it?.rating != null ? parseInt(it.rating, 10) : null;
          const rating = Number.isInteger(rawRating) && rawRating >= 1 && rawRating <= 5 ? rawRating : null;
          const review = typeof it?.review === 'string' ? it.review.trim().slice(0, 2000) : '';
          return { movieId, rating, review };
        })
        .filter(Boolean);
    } else if (Array.isArray(body.movieIds)) {
      normalizedItems = body.movieIds
        .map((id) => parseInt(id, 10))
        .filter((id) => Number.isInteger(id) && id > 0)
        .map((movieId) => ({ movieId, rating: null, review: '' }));
    }

    if (normalizedItems.length === 0) {
      return new Response(JSON.stringify({ success: true, watchedCount: 0, ratedCount: 0, message: 'Brak filmów' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      });
    }

    const statements = [];

    // Dodajemy filmy z onboardingu do tabeli watched (bez usuwania ich z user_onboarding_movies,
    // aby silnik rekomendacji zachowal sygnal cold-start przed pierwsza ocena)
    const insertWatchedStmt = env.db.prepare(
      `INSERT OR IGNORE INTO watched (user_id, movie_id, watched_date, status) 
       VALUES (?, ?, date('now'), 'watched')`
    );
    const deleteReviewStmt = env.db.prepare(
      `DELETE FROM reviews WHERE user_id = ? AND movie_id = ?`
    );
    const insertReviewStmt = env.db.prepare(
      `INSERT INTO reviews (user_id, movie_id, content, rating) VALUES (?, ?, ?, ?)`
    );

    let ratedCount = 0;
    for (const item of normalizedItems) {
      statements.push(insertWatchedStmt.bind(userId, item.movieId));
      if (item.rating !== null) {
        ratedCount++;
        statements.push(deleteReviewStmt.bind(userId, item.movieId));
        statements.push(insertReviewStmt.bind(userId, item.movieId, item.review || '', item.rating));
      }
    }

    await env.db.batch(statements);

    return new Response(
      JSON.stringify({
        success: true,
        watchedCount: normalizedItems.length,
        ratedCount,
      }),
      {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      }
    );
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
