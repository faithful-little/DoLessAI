const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { toIsoNow } = require('./utils');

function resolveDbPath() {
    const explicitPath = process.env.DB_PATH;
    if (explicitPath && explicitPath.trim()) return explicitPath.trim();

    const dataDir = process.env.DATA_DIR && process.env.DATA_DIR.trim()
        ? process.env.DATA_DIR.trim()
        : path.join(process.cwd(), 'data');
    return path.join(dataDir, 'functions.db');
}

function ensureParentDir(filePath) {
    const parent = path.dirname(filePath);
    fs.mkdirSync(parent, { recursive: true });
}

function initDatabase() {
    const dbPath = resolveDbPath();
    ensureParentDir(dbPath);
    const db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    db.exec(`
        CREATE TABLE IF NOT EXISTS functions (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            description TEXT,
            function_json TEXT NOT NULL,
            embedding_json TEXT,
            metadata_json TEXT,
            sites_json TEXT,
            searchable_text TEXT NOT NULL,
            fingerprint TEXT UNIQUE,
            source_extension TEXT,
            verified INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
        );

        CREATE INDEX IF NOT EXISTS idx_functions_name ON functions(name);
        CREATE INDEX IF NOT EXISTS idx_functions_updated ON functions(updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_functions_fingerprint ON functions(fingerprint);

        CREATE VIRTUAL TABLE IF NOT EXISTS function_fts USING fts5(
            function_id UNINDEXED,
            searchable_text
        );
    `);

    const upsertFnStmt = db.prepare(`
        INSERT INTO functions (
            id, name, description, function_json, embedding_json, metadata_json, sites_json,
            searchable_text, fingerprint, source_extension, verified, created_at, updated_at
        )
        VALUES (
            @id, @name, @description, @function_json, @embedding_json, @metadata_json, @sites_json,
            @searchable_text, @fingerprint, @source_extension, @verified, @created_at, @updated_at
        )
        ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            function_json = excluded.function_json,
            embedding_json = excluded.embedding_json,
            metadata_json = excluded.metadata_json,
            sites_json = excluded.sites_json,
            searchable_text = excluded.searchable_text,
            fingerprint = excluded.fingerprint,
            source_extension = excluded.source_extension,
            verified = excluded.verified,
            updated_at = excluded.updated_at
    `);

    const upsertFtsStmt = db.prepare(`
        INSERT INTO function_fts (function_id, searchable_text)
        VALUES (?, ?)
    `);
    const deleteFtsByIdStmt = db.prepare('DELETE FROM function_fts WHERE function_id = ?');

    const txUpsert = db.transaction((record) => {
        upsertFnStmt.run(record);
        deleteFtsByIdStmt.run(record.id);
        upsertFtsStmt.run(record.id, record.searchable_text);
    });

    function findByFingerprint(fingerprint) {
        if (!fingerprint) return null;
        return db.prepare('SELECT * FROM functions WHERE fingerprint = ? LIMIT 1').get(fingerprint) || null;
    }

    function findById(id) {
        if (!id) return null;
        return db.prepare('SELECT * FROM functions WHERE id = ? LIMIT 1').get(id) || null;
    }

    function upsertFunction(record = {}) {
        const now = toIsoNow();
        const existing = findByFingerprint(record.fingerprint) || findById(record.id);
        const normalized = {
            ...record,
            id: existing?.id || record.id,
            created_at: existing?.created_at || record.created_at || now,
            updated_at: now
        };

        txUpsert(normalized);
        return findById(normalized.id);
    }

    function listFunctions(limit = 50, offset = 0) {
        return db.prepare(`
            SELECT * FROM functions
            ORDER BY updated_at DESC
            LIMIT ? OFFSET ?
        `).all(limit, offset);
    }

    function getAllFunctions() {
        return db.prepare('SELECT * FROM functions ORDER BY updated_at DESC').all();
    }

    function getFunctionById(id) {
        return findById(id);
    }

    function countFunctions() {
        const row = db.prepare('SELECT COUNT(*) AS count FROM functions').get();
        return Number(row?.count || 0);
    }

    function bm25Search(ftsQuery, limit = 100) {
        if (!ftsQuery) return [];
        try {
            return db.prepare(`
                SELECT function_id, bm25(function_fts) AS bm25_score
                FROM function_fts
                WHERE function_fts MATCH ?
                ORDER BY bm25(function_fts)
                LIMIT ?
            `).all(ftsQuery, limit);
        } catch {
            return [];
        }
    }

    return {
        dbPath,
        upsertFunction,
        listFunctions,
        getAllFunctions,
        getFunctionById,
        countFunctions,
        bm25Search
    };
}

module.exports = {
    initDatabase
};
