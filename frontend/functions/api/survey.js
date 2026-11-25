// Endpoint ankiety ewaluacyjnej (slepy test A/B/C/D + Zapytaj AI).
// Czyta rekomendacje i zapisuje wyniki per-user w D1 oraz wysyla kopie zapasowa do FastAPI.

const MODEL_TYPES = [
  'collaborative_filtering',
  'content_based',
  'llm_querec',
  'hybrid_querec',
];
const SET_LABELS = ['A', 'B', 'C', 'D'];

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const userId = await getUserIdFromRequest(request);
    if (!userId) {
      return jsonResponse({ error: 'Wymagane logowanie.' }, 401, corsHeaders);
    }

    const surveyEnabled = await isSurveyEnabled(env.db);

    if (method === 'GET') {
      if (!surveyEnabled) {
        return jsonResponse(
          {
            surveyEnabled: false,
            submitted: false,
            ready: false,
            sets: [],
          },
          200,
          corsHeaders
        );
      }

      const existing = await env.db
        .prepare(
          'SELECT id, winner_label, ask_ai_used, ask_ai_rating, created_at FROM survey_submissions WHERE user_id = ?'
        )
        .bind(userId)
        .first();

      if (existing) {
        return jsonResponse(
          {
            surveyEnabled: true,
            submitted: true,
            submission: {
              winnerLabel: existing.winner_label,
              askAiUsed: Boolean(existing.ask_ai_used),
              askAiRating: existing.ask_ai_rating,
              createdAt: existing.created_at,
            },
          },
          200,
          corsHeaders
        );
      }

      const { sets } = await buildBlindSetsForUser(env.db, userId, env.SURVEY_SALT);
      return jsonResponse(
        {
          surveyEnabled: true,
          submitted: false,
          ready: sets.length > 0,
          setsCount: sets.length,
          expectedSets: MODEL_TYPES.length,
          sets,
        },
        200,
        corsHeaders
      );
    }

    if (method === 'POST') {
      if (!surveyEnabled) {
        return jsonResponse(
          {
            error: 'Sesja ankiet jeszcze nie została rozpoczęta przez administratora.',
            surveyLocked: true,
          },
          403,
          corsHeaders
        );
      }

      const existing = await env.db
        .prepare('SELECT id FROM survey_submissions WHERE user_id = ?')
        .bind(userId)
        .first();

      if (existing) {
        return jsonResponse(
          {
            error:
              'Ankieta została już wypełniona przez to konto. Każdy użytkownik może wysłać ją tylko raz.',
            alreadySubmitted: true,
          },
          409,
          corsHeaders
        );
      }

      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Nieprawidłowy format JSON.' }, 400, corsHeaders);
      }

      const { sets, blindMapping, validMovieMap } = await buildBlindSetsForUser(
        env.db,
        userId,
        env.SURVEY_SALT
      );

      if (!sets.length) {
        return jsonResponse(
          { error: 'Brak wygenerowanych rekomendacji do oceny. Dodaj najpierw oceny filmów i przelicz rekomendacje.' },
          400,
          corsHeaders
        );
      }

      const activeLabels = Object.keys(blindMapping);
      const winnerLabel = String(body?.winnerLabel || '').trim().toUpperCase();
      if (!activeLabels.includes(winnerLabel)) {
        return jsonResponse(
          { error: 'Wybierz zwycięski zestaw rekomendacji.' },
          400,
          corsHeaders
        );
      }

      const rawSetRatings = body?.setRatings || {};
      const parsedSetRatings = {};
      for (const label of activeLabels) {
        const sr = rawSetRatings[label];
        const relevance = toRatingInt(sr?.relevance);
        const novelty = toRatingInt(sr?.novelty);
        const diversity = toRatingInt(sr?.diversity);
        if (!relevance || !novelty || !diversity) {
          return jsonResponse(
            {
              error: `Uzupełnij wszystkie 3 oceny (1-5) dla Zestawu ${label}: trafność, odkrywczość i różnorodność.`,
            },
            400,
            corsHeaders
          );
        }
        parsedSetRatings[label] = { relevance, novelty, diversity };
      }

      const rawFeedback = Array.isArray(body?.movieFeedback) ? body.movieFeedback : [];
      const dedupedFeedback = new Map();
      for (const item of rawFeedback) {
        const label = String(item?.label || '').trim().toUpperCase();
        const movieId = parseInt(item?.movieId, 10);
        if (!activeLabels.includes(label) || !Number.isInteger(movieId)) continue;
        const movieRankMap = validMovieMap[label];
        if (!movieRankMap || !movieRankMap.has(movieId)) continue;
        const isRelevant = item?.isRelevant === true || item?.isRelevant === 1 ? 1 : 0;
        dedupedFeedback.set(`${label}:${movieId}`, {
          label,
          movieId,
          recommendationType: blindMapping[label],
          rank: movieRankMap.get(movieId),
          isRelevant,
        });
      }

      const feedbackByLabel = {};
      for (const label of activeLabels) {
        feedbackByLabel[label] = [];
      }
      for (const fb of dedupedFeedback.values()) {
        feedbackByLabel[fb.label].push(fb);
      }

      for (const setObj of sets) {
        const expectedCount = setObj.movies.length;
        const ratedCount = feedbackByLabel[setObj.label].length;
        if (ratedCount < expectedCount) {
          return jsonResponse(
            {
              error: `Oceń wszystkie pozycje (👍/👎) w Zestawie ${setObj.label} (${ratedCount}/${expectedCount}).`,
            },
            400,
            corsHeaders
          );
        }
      }

      const askAiUsed = body?.askAiUsed !== false;
      let askAiRating = null;
      if (askAiUsed) {
        askAiRating = toRatingInt(body?.askAiRating);
        if (!askAiRating) {
          return jsonResponse(
            { error: 'Oceń w skali 1-5 trafność rekomendacji z czatu "Zapytaj AI" lub zaznacz, że nie korzystałeś z tej funkcji.' },
            400,
            corsHeaders
          );
        }
      }

      const askAiComment = String(body?.askAiComment || '').trim().slice(0, 2000);
      const generalComment = String(body?.generalComment || '').trim().slice(0, 2000);
      const winnerModel = blindMapping[winnerLabel];
      const submittedAt = new Date().toISOString();

      let submissionId;
      try {
        const insertSub = await env.db
          .prepare(
            `INSERT INTO survey_submissions
              (user_id, blind_mapping_json, winner_label, winner_model, ask_ai_used, ask_ai_rating, ask_ai_comment, general_comment, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            userId,
            JSON.stringify(blindMapping),
            winnerLabel,
            winnerModel,
            askAiUsed ? 1 : 0,
            askAiRating,
            askAiComment || null,
            generalComment || null,
            submittedAt
          )
          .run();

        submissionId = insertSub?.meta?.last_row_id;
        if (!submissionId) {
          const row = await env.db
            .prepare('SELECT id FROM survey_submissions WHERE user_id = ?')
            .bind(userId)
            .first();
          submissionId = row?.id;
        }
      } catch (insertErr) {
        const msg = String(insertErr?.message || '');
        if (msg.toLowerCase().includes('unique')) {
          return jsonResponse(
            {
              error:
                'Ankieta została już wypełniona przez to konto. Każdy użytkownik może wysłać ją tylko raz.',
              alreadySubmitted: true,
            },
            409,
            corsHeaders
          );
        }
        throw insertErr;
      }

      const statements = [];
      const setRatingsForBackup = [];
      const movieFeedbackForBackup = [];

      for (const setObj of sets) {
        const label = setObj.label;
        const recType = blindMapping[label];
        const ratings = parsedSetRatings[label];
        const fbs = feedbackByLabel[label];
        const itemsShown = setObj.movies.length;
        const thumbsUp = fbs.filter((f) => f.isRelevant === 1).length;
        const thumbsDown = fbs.length - thumbsUp;
        const precisionAtK = fbs.length > 0 ? Number((thumbsUp / fbs.length).toFixed(4)) : null;

        statements.push(
          env.db
            .prepare(
              `INSERT INTO survey_set_ratings
                (submission_id, user_id, set_label, recommendation_type, relevance_rating, novelty_rating, diversity_rating, items_shown, thumbs_up_count, thumbs_down_count, precision_at_k, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
            )
            .bind(
              submissionId,
              userId,
              label,
              recType,
              ratings.relevance,
              ratings.novelty,
              ratings.diversity,
              itemsShown,
              thumbsUp,
              thumbsDown,
              precisionAtK,
              submittedAt
            )
        );

        setRatingsForBackup.push({
          set_label: label,
          recommendation_type: recType,
          relevance_rating: ratings.relevance,
          novelty_rating: ratings.novelty,
          diversity_rating: ratings.diversity,
          items_shown: itemsShown,
          thumbs_up_count: thumbsUp,
          thumbs_down_count: thumbsDown,
          precision_at_k: precisionAtK,
        });

        for (const fb of fbs) {
          statements.push(
            env.db
              .prepare(
                `INSERT INTO recommendation_feedback
                  (submission_id, user_id, movie_id, recommendation_type, set_label, rank, is_relevant, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
              )
              .bind(
                submissionId,
                userId,
                fb.movieId,
                fb.recommendationType,
                fb.label,
                fb.rank,
                fb.isRelevant,
                submittedAt
              )
          );

          movieFeedbackForBackup.push({
            movie_id: fb.movieId,
            recommendation_type: fb.recommendationType,
            set_label: fb.label,
            rank: fb.rank,
            is_relevant: fb.isRelevant,
          });
        }
      }

      if (statements.length) {
        await env.db.batch(statements);
      }

      let serverBackupSaved = false;
      try {
        const userInfo = await env.db
          .prepare('SELECT nickname, email FROM users WHERE id = ?')
          .bind(userId)
          .first();

        const backupRes = await fetch('https://mvt-api.110187.xyz/survey/backup', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-API-Key': env.MVT_API_KEY || '',
          },
          body: JSON.stringify({
            user_id: userId,
            nickname: userInfo?.nickname || null,
            email: userInfo?.email || null,
            blind_mapping: blindMapping,
            winner_label: winnerLabel,
            winner_model: winnerModel,
            ask_ai_used: askAiUsed,
            ask_ai_rating: askAiRating,
            ask_ai_comment: askAiComment || null,
            general_comment: generalComment || null,
            submitted_at: submittedAt,
            set_ratings: setRatingsForBackup,
            movie_feedback: movieFeedbackForBackup,
            overwrite: false,
          }),
          signal: AbortSignal.timeout(8000),
        });
        serverBackupSaved = backupRes.ok;
      } catch (backupErr) {
        console.warn('Nie udało się zapisać kopii ankiety na serwerze FastAPI:', backupErr);
      }

      return jsonResponse(
        {
          success: true,
          submissionId,
          serverBackupSaved,
          submittedAt,
        },
        201,
        corsHeaders
      );
    }

    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  } catch (error) {
    console.error('Survey API error:', error);
    return jsonResponse({ error: error.message || 'Błąd serwera' }, 500, corsHeaders);
  }
}

function jsonResponse(payload, status, corsHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
}

function toRatingInt(val) {
  const num = Number(val);
  if (!Number.isInteger(num) || num < 1 || num > 5) return null;
  return num;
}

function fnv1a32(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function getShuffledModelsForUser(userId, salt) {
  const seed = fnv1a32(`${userId}:${salt || 'mvt-blind-survey-v1'}`);
  const rng = mulberry32(seed);
  const arr = [...MODEL_TYPES];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function buildBlindSetsForUser(db, userId, salt) {
  const rowsRes = await db
    .prepare(
      `SELECT
         r.movie_id,
         r.rank,
         r.recommendation_type,
         m.title,
         m.media_type,
         m.release_date,
         m.genre,
         m.overview,
         m.cast,
         m.director,
         m.poster_path,
         m.poster_url,
         m.imdb_rating,
         m.trailer_url,
         m.duration,
         m.total_seasons,
         m.total_episodes
       FROM user_recommendations r
       JOIN movies m ON m.id = r.movie_id
       WHERE r.user_id = ?
       ORDER BY r.rank ASC, r.predicted_rating DESC`
    )
    .bind(userId)
    .all();

  const byModel = {};
  for (const r of rowsRes.results || []) {
    const recType = r.recommendation_type;
    if (!MODEL_TYPES.includes(recType)) continue;
    if (!byModel[recType]) byModel[recType] = [];

    let poster = r.poster_path || r.poster_url;
    if (poster) {
      if (!poster.startsWith('http')) {
        poster = `https://image.tmdb.org/t/p/w200${poster}`;
      }
    } else {
      poster = `https://placehold.co/200x300/4CAF50/white/png?text=${encodeURIComponent(r.title || '?')}`;
    }

    byModel[recType].push({
      id: r.movie_id,
      title: r.title,
      media_type: r.media_type,
      release_date: r.release_date,
      genre: r.genre,
      overview: r.overview,
      description: r.overview,
      cast: r.cast,
      director: r.director,
      poster_path: r.poster_path || r.poster_url,
      poster_url: poster,
      imdb_rating: r.imdb_rating,
      trailer_url: r.trailer_url,
      duration: r.duration,
      total_seasons: r.total_seasons,
      total_episodes: r.total_episodes,
      rank: r.rank,
    });
  }

  const orderedModels = getShuffledModelsForUser(userId, salt);
  const sets = [];
  const blindMapping = {};
  const validMovieMap = {};
  let labelIdx = 0;

  for (const modelType of orderedModels) {
    const items = byModel[modelType];
    if (!items || items.length === 0) continue;
    const label = SET_LABELS[labelIdx++];
    blindMapping[label] = modelType;
    const rankMap = new Map();
    for (const item of items) {
      rankMap.set(Number(item.id), item.rank);
    }
    validMovieMap[label] = rankMap;
    sets.push({
      label,
      movies: items,
    });
  }

  return { sets, blindMapping, validMovieMap };
}

async function isSurveyEnabled(db) {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key = 'survey_enabled'").first();
  return row?.value === '1';
}

async function getUserIdFromRequest(request) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return null;
  }

  try {
    const token = authHeader.substring(7);
    const payload = JSON.parse(atob(token));
    if (payload.exp < Date.now()) {
      return null;
    }
    return payload.userId;
  } catch {
    return null;
  }
}
