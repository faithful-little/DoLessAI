const {
    buildFtsQuery,
    clamp,
    cosineSimilarity,
    normalizeBm25Score,
    normalizePatternList,
    safeJsonParse,
    toNumberArray,
    urlMatchesPatterns
} = require('./utils');

function parseFunctionRow(row) {
    if (!row) return null;
    const functionDef = safeJsonParse(row.function_json, {});
    const metadata = safeJsonParse(row.metadata_json, {});
    const embedding = toNumberArray(safeJsonParse(row.embedding_json, null));
    const sites = normalizePatternList(safeJsonParse(row.sites_json, []));
    return {
        id: row.id,
        functionDef,
        metadata,
        embedding,
        sites,
        verified: row.verified === 1,
        updatedAt: row.updated_at
    };
}

function scoreRow({
    row,
    queryEmbedding,
    bm25ById,
    alpha,
    hasEmbeddingQuery
}) {
    const parsed = parseFunctionRow(row);
    if (!parsed) return null;

    const rawBm25 = bm25ById.get(parsed.id);
    const bm25Score = rawBm25 === undefined ? 0 : normalizeBm25Score(rawBm25);

    let vectorScore = 0;
    if (hasEmbeddingQuery && Array.isArray(parsed.embedding) && parsed.embedding.length > 0) {
        const rawVector = cosineSimilarity(queryEmbedding, parsed.embedding);
        vectorScore = (rawVector + 1) / 2;
    }

    const score = hasEmbeddingQuery
        ? (alpha * vectorScore) + ((1 - alpha) * bm25Score)
        : bm25Score;

    return {
        id: parsed.id,
        score,
        bm25Score,
        vectorScore,
        verified: parsed.verified,
        functionDef: parsed.functionDef,
        metadata: parsed.metadata,
        sites: parsed.sites,
        updatedAt: parsed.updatedAt
    };
}

function filterBySite(rows, currentUrl = '') {
    if (!currentUrl) return rows;
    return rows.filter((row) => {
        const patterns = normalizePatternList(safeJsonParse(row.sites_json, []));
        if (patterns.length === 0) return true;
        return urlMatchesPatterns(currentUrl, patterns);
    });
}

function hybridSearch(dbClient, {
    query = '',
    queryEmbedding = null,
    currentUrl = '',
    topK = 8,
    alpha = 0.65
} = {}) {
    const normalizedTopK = clamp(topK, 1, 30);
    const normalizedAlpha = clamp(alpha, 0, 1);
    const embedding = toNumberArray(queryEmbedding);
    const hasEmbeddingQuery = Array.isArray(embedding) && embedding.length > 0;
    const textQuery = String(query || '').trim();
    const ftsQuery = buildFtsQuery(textQuery);

    const bm25Rows = dbClient.bm25Search(ftsQuery, Math.max(120, normalizedTopK * 15));
    const bm25ById = new Map(
        bm25Rows.map((row) => [row.function_id, Number(row.bm25_score)])
    );

    const allRows = filterBySite(dbClient.getAllFunctions(), currentUrl);
    const scored = allRows
        .map((row) => scoreRow({
            row,
            queryEmbedding: embedding,
            bm25ById,
            alpha: normalizedAlpha,
            hasEmbeddingQuery
        }))
        .filter(Boolean)
        .filter((entry) => {
            if (!textQuery && !hasEmbeddingQuery) return true;
            return entry.score > 0;
        });

    scored.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
    });

    return {
        results: scored.slice(0, normalizedTopK),
        totalCandidates: scored.length
    };
}

module.exports = {
    hybridSearch,
    parseFunctionRow
};
