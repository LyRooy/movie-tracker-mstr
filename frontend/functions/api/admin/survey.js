// Endpoint administracyjny dla wynikow ankiety (Grupa A, Grupa B, eksport CSV, synchronizacja z serwerem i reset).

const MODEL_TYPES = [
  'collaborative_filtering',
  'content_based',
  'llm_querec',
  'hybrid_querec',
];

const MODEL_LABELS = {
  collaborative_filtering: 'CF (SVD)',
  content_based: 'CB (TF-IDF)',
  llm_querec: 'LLM (QueRec)',
  hybrid_querec: 'HYBRID (CF + LLM)',
};

export async function onRequest(context) {
  const { request, env } = context;
  const method = request.method;
  const url = new URL(request.url);

  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  };

  if (method === 'OPTIONS') {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const adminId = await getUserIdFromRequest(request);
    if (!adminId) {
      return jsonResponse({ error: 'Authentication required' }, 401, corsHeaders);
    }

    const adminUser = await env.db.prepare('SELECT role FROM users WHERE id = ?').bind(adminId).first();
    if (!adminUser || adminUser.role !== 'admin') {
      return jsonResponse({ error: 'Admin access required' }, 403, corsHeaders);
    }

    if (method === 'GET') {
      const data = await collectSurveyAnalytics(env);
      const format = url.searchParams.get('format');
      if (format === 'csv') {
        const dataset = url.searchParams.get('dataset') || 'submissions';
        const csvContent = buildCsvForDataset(dataset, data);
        if (csvContent === null) {
          return jsonResponse({ error: 'Nieznany zestaw CSV.' }, 400, corsHeaders);
        }
        return new Response('\uFEFF' + csvContent, {
          status: 200,
          headers: {
            ...corsHeaders,
            'Content-Type': 'text/csv; charset=utf-8',
            'Content-Disposition': `attachment; filename="survey_${dataset}.csv"`,
          },
        });
      }

      return jsonResponse(data, 200, corsHeaders);
    }

    if (method === 'POST') {
      const [subsRes, setsRes, fbRes] = await env.db.batch([
        env.db.prepare(`
          SELECT s.*, u.nickname, u.email
          FROM survey_submissions s
          LEFT JOIN users u ON u.id = s.user_id
          ORDER BY s.created_at ASC
        `),
        env.db.prepare('SELECT * FROM survey_set_ratings ORDER BY id ASC'),
        env.db.prepare('SELECT * FROM recommendation_feedback ORDER BY id ASC'),
      ]);

      const setsByUser = new Map();
      for (const sr of setsRes.results || []) {
        if (!setsByUser.has(sr.user_id)) setsByUser.set(sr.user_id, []);
        setsByUser.get(sr.user_id).push({
          set_label: sr.set_label,
          recommendation_type: sr.recommendation_type,
          relevance_rating: sr.relevance_rating,
          novelty_rating: sr.novelty_rating,
          diversity_rating: sr.diversity_rating,
          items_shown: sr.items_shown,
          thumbs_up_count: sr.thumbs_up_count,
          thumbs_down_count: sr.thumbs_down_count,
          precision_at_k: sr.precision_at_k,
        });
      }

      const fbByUser = new Map();
      for (const fb of fbRes.results || []) {
        if (!fbByUser.has(fb.user_id)) fbByUser.set(fb.user_id, []);
        fbByUser.get(fb.user_id).push({
          movie_id: fb.movie_id,
          recommendation_type: fb.recommendation_type,
          set_label: fb.set_label,
          rank: fb.rank,
          is_relevant: fb.is_relevant,
        });
      }

      const submissionsPayload = (subsRes.results || []).map((s) => {
        let blindMapping = {};
        try {
          blindMapping = JSON.parse(s.blind_mapping_json || '{}');
        } catch {
          blindMapping = {};
        }
        return {
          user_id: s.user_id,
          nickname: s.nickname || null,
          email: s.email || null,
          blind_mapping: blindMapping,
          winner_label: s.winner_label,
          winner_model: s.winner_model,
          ask_ai_used: Boolean(s.ask_ai_used),
          ask_ai_rating: s.ask_ai_rating,
          ask_ai_comment: s.ask_ai_comment || null,
          general_comment: s.general_comment || null,
          submitted_at: s.created_at,
          set_ratings: setsByUser.get(s.user_id) || [],
          movie_feedback: fbByUser.get(s.user_id) || [],
          overwrite: true,
        };
      });

      const syncRes = await fetch('https://mvt-api.110187.xyz/survey/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': env.MVT_API_KEY || '',
        },
        body: JSON.stringify({ submissions: submissionsPayload }),
        signal: AbortSignal.timeout(10000),
      });

      if (!syncRes.ok) {
        const errText = await syncRes.text();
        return jsonResponse(
          { error: `Błąd synchronizacji z serwerem (${syncRes.status}): ${errText}` },
          502,
          corsHeaders
        );
      }

      const syncData = await syncRes.json();
      return jsonResponse(
        {
          success: true,
          syncedCount: syncData.synced_count ?? submissionsPayload.length,
        },
        200,
        corsHeaders
      );
    }

    if (method === 'PATCH') {
      let body;
      try {
        body = await request.json();
      } catch {
        return jsonResponse({ error: 'Nieprawidłowy format JSON.' }, 400, corsHeaders);
      }

      const surveyEnabled = Boolean(body?.surveyEnabled);
      const val = surveyEnabled ? '1' : '0';

      await env.db
        .prepare(
          `INSERT INTO app_settings (key, value, updated_at)
           VALUES ('survey_enabled', ?, strftime('%Y-%m-%d %H:%M:%f', 'now'))
           ON CONFLICT(key) DO UPDATE SET
             value = excluded.value,
             updated_at = excluded.updated_at`
        )
        .bind(val)
        .run();

      return jsonResponse({ success: true, surveyEnabled }, 200, corsHeaders);
    }

    if (method === 'DELETE') {
      const targetUserId = parseInt(url.searchParams.get('userId'), 10);
      if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
        return jsonResponse({ error: 'Wymagany poprawny parametr userId.' }, 400, corsHeaders);
      }

      await env.db.batch([
        env.db.prepare('DELETE FROM recommendation_feedback WHERE user_id = ?').bind(targetUserId),
        env.db.prepare('DELETE FROM survey_set_ratings WHERE user_id = ?').bind(targetUserId),
        env.db.prepare('DELETE FROM survey_submissions WHERE user_id = ?').bind(targetUserId),
      ]);

      let serverBackupDeleted = false;
      try {
        const delRes = await fetch(`https://mvt-api.110187.xyz/survey/backup/${targetUserId}`, {
          method: 'DELETE',
          headers: { 'X-API-Key': env.MVT_API_KEY || '' },
          signal: AbortSignal.timeout(6000),
        });
        serverBackupDeleted = delRes.ok;
      } catch (err) {
        console.warn('Nie udało się usunąć kopii ankiety z serwera FastAPI:', err);
      }

      return jsonResponse(
        { success: true, deletedUserId: targetUserId, serverBackupDeleted },
        200,
        corsHeaders
      );
    }

    return jsonResponse({ error: 'Method not allowed' }, 405, corsHeaders);
  } catch (error) {
    console.error('Admin survey API error:', error);
    return jsonResponse({ error: error.message || 'Błąd serwera' }, 500, corsHeaders);
  }
}

async function collectSurveyAnalytics(env) {
  const [subsRes, setsRes, fbRes, recsRes, settingRow] = await env.db.batch([
    env.db.prepare(`
      SELECT
        s.id,
        s.user_id,
        u.nickname,
        u.email,
        s.blind_mapping_json,
        s.winner_label,
        s.winner_model,
        s.ask_ai_used,
        s.ask_ai_rating,
        s.ask_ai_comment,
        s.general_comment,
        s.created_at
      FROM survey_submissions s
      LEFT JOIN users u ON u.id = s.user_id
      ORDER BY s.created_at DESC
    `),
    env.db.prepare(`
      SELECT sr.*, u.nickname
      FROM survey_set_ratings sr
      LEFT JOIN users u ON u.id = sr.user_id
      ORDER BY sr.created_at DESC, sr.set_label ASC
    `),
    env.db.prepare(`
      SELECT rf.*, u.nickname, m.title AS movie_title
      FROM recommendation_feedback rf
      LEFT JOIN users u ON u.id = rf.user_id
      LEFT JOIN movies m ON m.id = rf.movie_id
      ORDER BY rf.created_at DESC, rf.set_label ASC, rf.rank ASC
    `),
    env.db.prepare(`
      SELECT
        r.user_id,
        r.movie_id,
        r.recommendation_type,
        m.popularity,
        m.vote_count,
        m.imdb_rating
      FROM user_recommendations r
      JOIN movies m ON m.id = r.movie_id
    `),
    env.db.prepare("SELECT value FROM app_settings WHERE key = 'survey_enabled'"),
  ]);

  const submissions = subsRes.results || [];
  const setRatings = setsRes.results || [];
  const feedbacks = fbRes.results || [];
  const allRecs = recsRes.results || [];
  const surveyEnabled = (settingRow?.results?.[0]?.value ?? settingRow?.value) === '1';
  const totalSubmissions = submissions.length;

  // Grupa A: metryki na podstawie ocen uzytkownikow
  const groupA = {};
  for (const model of MODEL_TYPES) {
    const modelSets = setRatings.filter((sr) => sr.recommendation_type === model);
    const wins = submissions.filter((s) => s.winner_model === model).length;
    const ratedSets = modelSets.length;
    const avg = (vals) => (vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null);

    const thumbsUp = modelSets.reduce((acc, s) => acc + (Number(s.thumbs_up_count) || 0), 0);
    const thumbsDown = modelSets.reduce((acc, s) => acc + (Number(s.thumbs_down_count) || 0), 0);
    const totalThumbs = thumbsUp + thumbsDown;
    const precisionValues = modelSets
      .map((s) => s.precision_at_k)
      .filter((v) => v !== null && v !== undefined && !Number.isNaN(Number(v)))
      .map((v) => Number(v) * 100);

    groupA[model] = {
      label: MODEL_LABELS[model],
      wins,
      winRatePct: totalSubmissions > 0 ? round2((wins / totalSubmissions) * 100) : null,
      ratedSets,
      avgRelevance: avg(modelSets.map((s) => Number(s.relevance_rating))),
      avgNovelty: avg(modelSets.map((s) => Number(s.novelty_rating))),
      avgDiversity: avg(modelSets.map((s) => Number(s.diversity_rating))),
      thumbsUp,
      thumbsDown,
      microPrecisionPct: totalThumbs > 0 ? round2((thumbsUp / totalThumbs) * 100) : null,
      macroPrecisionPct: avg(precisionValues),
    };
  }

  // Ask AI
  const askAiRated = submissions
    .filter((s) => Boolean(s.ask_ai_used) && s.ask_ai_rating != null)
    .map((s) => Number(s.ask_ai_rating));
  const askAiComments = submissions
    .filter((s) => (s.ask_ai_comment && s.ask_ai_comment.trim()) || (s.general_comment && s.general_comment.trim()))
    .map((s) => ({
      user_id: s.user_id,
      nickname: s.nickname || `User #${s.user_id}`,
      ask_ai_used: Boolean(s.ask_ai_used),
      ask_ai_rating: s.ask_ai_rating,
      ask_ai_comment: s.ask_ai_comment || '',
      general_comment: s.general_comment || '',
      created_at: s.created_at,
    }));

  const askAi = {
    usedCount: submissions.filter((s) => Boolean(s.ask_ai_used)).length,
    notUsedCount: submissions.filter((s) => !s.ask_ai_used).length,
    avgRating: askAiRated.length
      ? round2(askAiRated.reduce((a, b) => a + b, 0) / askAiRated.length)
      : null,
    comments: askAiComments,
  };

  // Grupa B: metryki automatyczne z user_recommendations + movies
  const groupB = {};
  const userModelMovies = {};
  for (const model of MODEL_TYPES) {
    const rows = allRecs.filter((r) => r.recommendation_type === model);
    const uniqueUsers = new Set(rows.map((r) => r.user_id));
    const uniqueMovies = new Set(rows.map((r) => r.movie_id));
    const pops = rows.map((r) => r.popularity).filter(isFiniteNum).map(Number);
    const votes = rows.map((r) => r.vote_count).filter(isFiniteNum).map(Number);
    const imdbs = rows.map((r) => r.imdb_rating).filter(isFiniteNum).map(Number);

    for (const r of rows) {
      if (!userModelMovies[r.user_id]) userModelMovies[r.user_id] = {};
      if (!userModelMovies[r.user_id][model]) userModelMovies[r.user_id][model] = new Set();
      userModelMovies[r.user_id][model].add(r.movie_id);
    }

    groupB[model] = {
      label: MODEL_LABELS[model],
      usersCount: uniqueUsers.size,
      totalRecs: rows.length,
      catalogCoverage: uniqueMovies.size,
      avgPopularity: meanOrNull(pops),
      medianPopularity: medianOrNull(pops),
      avgVoteCount: meanOrNull(votes),
      medianVoteCount: medianOrNull(votes),
      avgImdbRating: meanOrNull(imdbs),
    };
  }

  // Overlap CF vs LLM per user
  const overlaps = [];
  for (const modelsMap of Object.values(userModelMovies)) {
    const cfSet = modelsMap.collaborative_filtering;
    const llmSet = modelsMap.llm_querec;
    if (cfSet && llmSet && cfSet.size > 0 && llmSet.size > 0) {
      let shared = 0;
      for (const mid of cfSet) {
        if (llmSet.has(mid)) shared++;
      }
      const denom = Math.min(cfSet.size, llmSet.size);
      overlaps.push((shared / denom) * 100);
    }
  }

  // Opcjonalny odczyt statystyk latency z FastAPI
  let latencyStats = null;
  let serverOnline = false;
  try {
    const latRes = await fetch('https://mvt-api.110187.xyz/survey/latency-stats', {
      headers: { 'X-API-Key': env.MVT_API_KEY || '' },
      signal: AbortSignal.timeout(3500),
    });
    if (latRes.ok) {
      latencyStats = await latRes.json();
      serverOnline = true;
    }
  } catch {
    serverOnline = false;
  }

  return {
    surveyEnabled,
    totalSubmissions,
    groupA,
    askAi,
    groupB,
    cfLlmOverlap: {
      usersWithBoth: overlaps.length,
      avgOverlapPct: meanOrNull(overlaps),
    },
    latency: {
      serverOnline,
      ...(latencyStats || { total_measurements: 0, models: {} }),
    },
    submissions: submissions.map((s) => ({
      ...s,
      winner_model_label: MODEL_LABELS[s.winner_model] || s.winner_model,
    })),
    rawSetRatings: setRatings,
    rawFeedbacks: feedbacks,
  };
}

function buildCsvForDataset(dataset, data) {
  if (dataset === 'submissions') {
    const header = [
      'user_id',
      'nickname',
      'email',
      'winner_label',
      'winner_model',
      'ask_ai_used',
      'ask_ai_rating',
      'ask_ai_comment',
      'general_comment',
      'blind_mapping_json',
      'created_at',
    ];
    const rows = data.submissions.map((s) => [
      s.user_id,
      s.nickname || '',
      s.email || '',
      s.winner_label,
      s.winner_model,
      s.ask_ai_used,
      s.ask_ai_rating ?? '',
      s.ask_ai_comment || '',
      s.general_comment || '',
      s.blind_mapping_json || '',
      s.created_at,
    ]);
    return toCsv(header, rows);
  }

  if (dataset === 'sets') {
    const header = [
      'user_id',
      'nickname',
      'set_label',
      'recommendation_type',
      'relevance_rating',
      'novelty_rating',
      'diversity_rating',
      'items_shown',
      'thumbs_up_count',
      'thumbs_down_count',
      'precision_at_k',
      'created_at',
    ];
    const rows = data.rawSetRatings.map((r) => [
      r.user_id,
      r.nickname || '',
      r.set_label,
      r.recommendation_type,
      r.relevance_rating,
      r.novelty_rating,
      r.diversity_rating,
      r.items_shown,
      r.thumbs_up_count,
      r.thumbs_down_count,
      r.precision_at_k ?? '',
      r.created_at,
    ]);
    return toCsv(header, rows);
  }

  if (dataset === 'feedback') {
    const header = [
      'user_id',
      'nickname',
      'set_label',
      'recommendation_type',
      'movie_id',
      'movie_title',
      'rank',
      'is_relevant',
      'created_at',
    ];
    const rows = data.rawFeedbacks.map((f) => [
      f.user_id,
      f.nickname || '',
      f.set_label,
      f.recommendation_type,
      f.movie_id,
      f.movie_title || '',
      f.rank ?? '',
      f.is_relevant,
      f.created_at,
    ]);
    return toCsv(header, rows);
  }

  if (dataset === 'metrics') {
    const header = [
      'model',
      'model_label',
      'wins',
      'win_rate_pct',
      'rated_sets',
      'avg_relevance',
      'avg_novelty',
      'avg_diversity',
      'thumbs_up',
      'thumbs_down',
      'micro_precision_pct',
      'macro_precision_pct',
      'users_with_recs',
      'total_recs',
      'catalog_coverage',
      'avg_popularity',
      'median_popularity',
      'avg_vote_count',
      'median_vote_count',
      'avg_imdb_rating',
      'latency_mean_ms',
      'latency_median_ms',
    ];
    const latModels = data.latency?.models || {};
    const rows = MODEL_TYPES.map((m) => {
      const a = data.groupA[m] || {};
      const b = data.groupB[m] || {};
      const l = latModels[m] || {};
      return [
        m,
        MODEL_LABELS[m],
        a.wins ?? 0,
        a.winRatePct ?? '',
        a.ratedSets ?? 0,
        a.avgRelevance ?? '',
        a.avgNovelty ?? '',
        a.avgDiversity ?? '',
        a.thumbsUp ?? 0,
        a.thumbsDown ?? 0,
        a.microPrecisionPct ?? '',
        a.macroPrecisionPct ?? '',
        b.usersCount ?? 0,
        b.totalRecs ?? 0,
        b.catalogCoverage ?? 0,
        b.avgPopularity ?? '',
        b.medianPopularity ?? '',
        b.avgVoteCount ?? '',
        b.medianVoteCount ?? '',
        b.avgImdbRating ?? '',
        l.mean_ms ?? '',
        l.median_ms ?? '',
      ];
    });
    return toCsv(header, rows);
  }

  return null;
}

function toCsv(header, rows) {
  const esc = (val) => {
    const str = val === null || val === undefined ? '' : String(val);
    if (/[",\r\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  return [header.map(esc).join(','), ...rows.map((r) => r.map(esc).join(','))].join('\r\n');
}

function isFiniteNum(v) {
  return v !== null && v !== undefined && Number.isFinite(Number(v));
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function meanOrNull(arr) {
  if (!arr.length) return null;
  return round2(arr.reduce((a, b) => a + b, 0) / arr.length);
}

function medianOrNull(arr) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 !== 0) return round2(sorted[mid]);
  return round2((sorted[mid - 1] + sorted[mid]) / 2);
}

function jsonResponse(payload, status, corsHeaders) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });
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
