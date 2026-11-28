// Endpoint API do wyszukiwania filmów w bazie danych D1

// Funkcja pomocnicza zapewniająca, że adresy URL plakatów używają HTTPS
function normalizePosterUrl(url) {
  if (!url) return null;
  if (url.startsWith('http://')) {
    return url.replace('http://', 'https://');
  }
  return url;
}

function resolvePoster(row) {
  const pathVal = row?.poster_path && typeof row.poster_path === 'string' ? row.poster_path.trim() : '';
  const urlVal = row?.poster_url && typeof row.poster_url === 'string' ? row.poster_url.trim() : '';
  const poster = pathVal || urlVal;
  if (!poster) return null;
  if (poster.startsWith('http://')) {
    return poster.replace('http://', 'https://');
  }
  if (!poster.startsWith('http')) {
    const normalizedPath = poster.startsWith('/') ? poster : `/${poster}`;
    return `https://image.tmdb.org/t/p/w200${normalizedPath}`;
  }
  return poster;
}

function escapeLike(str) {
  return String(str).replace(/[\\%_]/g, '\\$&');
}

function getGenreSearchTerms(genreFilter) {
  const g = String(genreFilter || '').trim().toLowerCase();
  if (!g) return [];
  const normalizedKey = g.replace(/_/g, ' ');
  const synonymGroups = [
    ['akcja', 'action'],
    ['komedia', 'comedy'],
    ['dramat', 'drama'],
    ['sci-fi', 'sci fi', 'science fiction', 'science_fiction'],
    ['horror'],
    ['thriller', 'dreszczowiec'],
    ['kryminał', 'kryminal', 'crime'],
    ['przygodowy', 'przygoda', 'adventure'],
    ['fantasy'],
    ['animacja', 'animation'],
    ['romans', 'romance'],
    ['dokumentalny', 'dokument', 'documentary'],
    ['rodzinny', 'family'],
    ['tajemnica', 'mystery'],
    ['wojenny', 'war'],
    ['historyczny', 'history', 'historical'],
    ['muzyczny', 'music'],
    ['western']
  ];
  for (const group of synonymGroups) {
    if (group.includes(normalizedKey) || group.includes(g)) {
      if (normalizedKey.startsWith('sci')) {
        return ['sci-fi', 'science fiction', 'science_fiction'];
      }
      return group;
    }
  }
  return Array.from(new Set([g, normalizedKey, g.replace(/\s+/g, '_')].filter(Boolean)));
}

  function normalizeGenre(genre) {
    if (!genre || typeof genre !== 'string') return '';
        return genre.split(/[,;|]+/)
      .map(s => s.trim())
      .map(s => {
        const key = s.toLowerCase().replace(/_/g, ' ');
        if (key === 'science fiction' || key === 'science_fiction' || key === 'science-fiction') return 'Sci-Fi';
            if (key === 'drama' || key === 'dramat') return 'Dramat';
        return s.replace(/_/g, ' ');
      })
      .filter(Boolean)
      .join(', ');
  }

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const method = request.method;
  
  // Nagłówki CORS
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  if (method !== 'GET') {
    return new Response('Method not allowed', { 
      status: 405,
      headers: corsHeaders 
    });
  }

  const query = url.searchParams.get('query') || '';
  const isCal = url.searchParams.get('mode') === 'calendar';

  // Sprawdź uwierzytelnienie
  const userId = await getUserIdFromRequest(request);
  if (!userId) {
    return new Response(JSON.stringify({ error: 'Authentication required' }), {
      status: 401,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }

  const mode = url.searchParams.get('mode');

  try {
    // ── TRYB KALENDARZA: lekkie zapytanie filtrowane po dacie ────────────────
    if (mode === 'calendar') {
      const dateFrom = url.searchParams.get('date_from');
      const dateTo   = url.searchParams.get('date_to');
      if (!dateFrom || !dateTo) {
        return new Response(JSON.stringify({ error: 'date_from and date_to required' }), {
          status: 400,
          headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }
      const result = await env.db.prepare(`
        SELECT id, title, media_type as type, release_date, trailer_url, poster_url as poster, description
        FROM movies
        WHERE release_date IS NOT NULL AND release_date >= ? AND release_date <= ?
        ORDER BY release_date
        LIMIT 1000
      `).bind(dateFrom, dateTo).all();

      const calendarResults = result.results.map(row => ({
        id: `db_${row.id}`,
        title: row.title,
        type: row.type,
        release_date: row.release_date,
        trailer_url: row.trailer_url || null,
        poster: normalizePosterUrl(row.poster) || null,
        description: row.description || ''
      }));
      return new Response(JSON.stringify({ results: calendarResults }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    // ── ZWYKŁE WYSZUKIWANIE / PRZEGLĄDANIE KATALOGU Z PAGINACJĄ ─────────────
    const page  = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10) || 0);
    const rawLimit = parseInt(url.searchParams.get('limit') || '30', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(40, Math.max(1, rawLimit)) : 30;
    const fetchLimit = limit + 1;
    const offset = page * limit;

    const normalizedQuery = query.trim().replace(/\s+/g, ' ');
    const whereClauses = [];
    const whereParams = [];

    if (normalizedQuery) {
      const qLower = normalizedQuery.toLowerCase();
      let tokens = qLower.split(/[\s:;,.\-–—/]+/).filter(Boolean).slice(0, 6);
      if (tokens.length === 0) {
        tokens = [qLower];
      }

      if (tokens.length === 1) {
        const p = `%${escapeLike(tokens[0])}%`;
        whereClauses.push("(LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(original_title, '')) LIKE ? ESCAPE '\\')");
        whereParams.push(p, p);
      } else {
        const titleConds = tokens.map(() => "LOWER(title) LIKE ? ESCAPE '\\'").join(' AND ');
        const origConds = tokens.map(() => "LOWER(IFNULL(original_title, '')) LIKE ? ESCAPE '\\'").join(' AND ');
        whereClauses.push(`((${titleConds}) OR (${origConds}))`);
        const tokenPatterns = tokens.map(t => `%${escapeLike(t)}%`);
        whereParams.push(...tokenPatterns, ...tokenPatterns);
      }
    }

    const typeFilter = (url.searchParams.get('type') || '').trim().toLowerCase();
    if (typeFilter === 'movie' || typeFilter === 'series') {
      whereClauses.push('media_type = ?');
      whereParams.push(typeFilter);
    }

    const genreFilter = (url.searchParams.get('genre') || '').trim();
    if (genreFilter) {
      const genreTerms = getGenreSearchTerms(genreFilter);
      if (genreTerms.length > 0) {
        const genreConds = genreTerms.map(() => "LOWER(COALESCE(NULLIF(genre, ''), genres, '')) LIKE ? ESCAPE '\\'").join(' OR ');
        whereClauses.push(`(${genreConds})`);
        genreTerms.forEach(term => whereParams.push(`%${escapeLike(term)}%`));
      }
    }

    const yearFilter = (url.searchParams.get('year') || '').trim();
    if (yearFilter) {
      if (/^\d{4}$/.test(yearFilter)) {
        whereClauses.push('substr(release_date, 1, 4) = ?');
        whereParams.push(yearFilter);
      } else if (/^\d{4}-\d{4}$/.test(yearFilter)) {
        const [startYear, endYear] = yearFilter.split('-').map(Number);
        whereClauses.push('CAST(substr(release_date, 1, 4) AS INTEGER) BETWEEN ? AND ?');
        whereParams.push(startYear, endYear);
      }
    }

    const whereSql = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

    let orderClause;
    let queryParams;
    if (normalizedQuery) {
      const qLower = normalizedQuery.toLowerCase();
      const qWithThe = qLower.startsWith('the ') ? qLower : `the ${qLower}`;
      const qEsc = escapeLike(qLower);
      const qWithTheEsc = escapeLike(qWithThe);
      orderClause = `
        CASE
          WHEN LOWER(title) = ? OR LOWER(IFNULL(original_title, '')) = ?
            OR LOWER(title) = ? OR LOWER(IFNULL(original_title, '')) = ? THEN 0
          WHEN LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(original_title, '')) LIKE ? ESCAPE '\\'
            OR LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(original_title, '')) LIKE ? ESCAPE '\\' THEN 1
          WHEN LOWER(title) LIKE ? ESCAPE '\\' OR LOWER(IFNULL(original_title, '')) LIKE ? ESCAPE '\\' THEN 2
          ELSE 3
        END,
        COALESCE(popularity, 0) DESC,
        COALESCE(vote_count, 0) DESC,
        COALESCE(imdb_rating, vote_average, 0) DESC,
        title ASC
      `;
      queryParams = [
        ...whereParams,
        qLower, qLower, qWithThe, qWithThe,
        `${qEsc}%`, `${qEsc}%`, `${qWithTheEsc}%`, `${qWithTheEsc}%`,
        `%${qEsc}%`, `%${qEsc}%`,
        fetchLimit, offset
      ];
    } else {
      orderClause = 'popularity DESC, vote_count DESC, imdb_rating DESC, title ASC';
      queryParams = [...whereParams, fetchLimit, offset];
    }

    const sql = `
      SELECT 
        id,
        title,
        original_title,
        media_type as type,
        release_date,
        strftime('%Y', release_date) as year,
        COALESCE(NULLIF(genre, ''), genres, '') as genre,
        poster_path,
        poster_url,
        trailer_url,
        COALESCE(NULLIF(description, ''), overview, '') as description,
        duration,
        COALESCE(total_seasons, 1) as total_seasons,
        COALESCE(total_episodes, 1) as total_episodes,
        popularity,
        vote_count,
        vote_average,
        imdb_rating
      FROM movies
      ${whereSql}
      ORDER BY ${orderClause}
      LIMIT ? OFFSET ?
    `;

    const result = await env.db.prepare(sql).bind(...queryParams).all();
    const rawRows = result.results || [];
    const hasMore = rawRows.length > limit;
    const pageRows = hasMore ? rawRows.slice(0, limit) : rawRows;

    const movieIds = pageRows.map(r => r.id);
    const seriesIds = pageRows.filter(r => r.type === 'series').map(r => r.id);

    const reviewsMap = new Map();
    if (movieIds.length > 0) {
      try {
        const placeholders = movieIds.map(() => '?').join(',');
        const reviewsRes = await env.db.prepare(`
          SELECT movie_id, AVG(rating) as avg_rating, COUNT(*) as review_count
          FROM reviews
          WHERE movie_id IN (${placeholders})
          GROUP BY movie_id
        `).bind(...movieIds).all();
        for (const r of (reviewsRes.results || [])) {
          if (r.review_count > 0 && r.avg_rating !== null) {
            reviewsMap.set(r.movie_id, Math.round(r.avg_rating * 10) / 10);
          }
        }
      } catch (e) {
        console.warn('Could not compute avg ratings for search batch:', e);
      }
    }

    const episodeAvgMap = new Map();
    if (seriesIds.length > 0) {
      try {
        const placeholders = seriesIds.map(() => '?').join(',');
        const avgRes = await env.db.prepare(`
          SELECT s.series_id, AVG(e.duration) as avg_duration
          FROM episodes e
          JOIN seasons s ON e.season_id = s.id
          WHERE s.series_id IN (${placeholders})
          GROUP BY s.series_id
        `).bind(...seriesIds).all();
        for (const r of (avgRes.results || [])) {
          if (r.avg_duration !== null) {
            episodeAvgMap.set(r.series_id, Math.round(r.avg_duration));
          }
        }
      } catch (e) {
        console.warn('Could not compute avg episode duration for search batch:', e);
      }
    }

    const currentYear = new Date().getFullYear();
    const transformedResults = pageRows.map(row => {
      const rawYear = parseInt(row.year, 10);
      const year = (Number.isFinite(rawYear) && rawYear >= 1800 && rawYear <= currentYear + 5) ? rawYear : null;
      const duration = (row.duration !== undefined && row.duration !== null) ? Number(row.duration) : null;
      const avgEpisodeLength = row.type === 'series' ? (episodeAvgMap.get(row.id) ?? null) : null;
      const avgRating = reviewsMap.get(row.id) ?? 0;
      const posterUrl = resolvePoster(row);

      return {
        id: `db_${row.id}`,
        title: row.title,
        type: row.type,
        year: year,
        release_date: row.release_date || null,
        genre: normalizeGenre(row.genre) || 'Unknown',
        poster_url: posterUrl,
        poster: posterUrl || `https://placehold.co/200x300/4CAF50/white/png?text=${encodeURIComponent(row.title)}`,
        trailer_url: row.trailer_url || null,
        description: row.description || '',
        duration: row.type === 'movie' ? duration : (avgEpisodeLength || null),
        avgEpisodeLength: avgEpisodeLength,
        totalSeasons: row.total_seasons || null,
        totalEpisodes: row.total_episodes || null,
        rating: avgRating,
        status: 'planning',
        watchedDate: new Date().toISOString().split('T')[0]
      };
    });

    return new Response(JSON.stringify({
      results: transformedResults,
      total: null,
      page,
      hasMore
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  } catch (error) {
    console.error('Search error:', error);
    return new Response(JSON.stringify({ error: 'Search failed' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
}

// Wyodrębnij ID użytkownika z tokenu autoryzacyjnego
async function getUserIdFromRequest(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token));
    
    if (payload.exp < Date.now()) {
      return null; // Token wygasł
    }
    
    return payload.userId;
  } catch {
    return null;
  }
}
