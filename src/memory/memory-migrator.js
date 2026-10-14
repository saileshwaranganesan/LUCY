'use strict';

const fs = require('fs');
const path = require('path');
const { MEMORY_CATEGORIES } = require('./memory-constants.js');

/**
 * MemoryMigrator
 * Safe JSON-to-SQLite migration engine with timestamped backups,
 * 5-category exact parity verification, secret scrubbing, and automatic rollback.
 */
class MemoryMigrator {
    /**
     * Migrate JSON memory store to SQLite with strict verification gates
     */
    static async migrate({
        memoryDir = path.resolve(__dirname, '../../data/memory'),
        jsonPath = null,
        sqliteAdapter
    } = {}) {
        const sourceJsonPath = jsonPath || path.join(memoryDir, 'memory-store.json');

        if (!fs.existsSync(sourceJsonPath)) {
            return {
                ok: true,
                migrated: false,
                reason: 'No legacy JSON memory store found on disk.'
            };
        }

        // 1. Read & parse source JSON
        let jsonContent;
        try {
            jsonContent = JSON.parse(fs.readFileSync(sourceJsonPath, 'utf8'));
        } catch (err) {
            return {
                ok: false,
                migrated: false,
                error: `Failed to parse source JSON memory store: ${err.message}`
            };
        }

        const sourceMemories = Array.isArray(jsonContent.memories) ? jsonContent.memories : [];

        // 2. Compute baseline counts across all 5 memory categories
        const sourceCounts = {};
        for (const cat of Object.values(MEMORY_CATEGORIES)) {
            sourceCounts[cat] = 0;
        }
        for (const m of sourceMemories) {
            const cat = m.category || MEMORY_CATEGORIES.WORKING_DATA;
            sourceCounts[cat] = (sourceCounts[cat] || 0) + 1;
        }

        // 3. Initialize SQLite Database Adapter if not yet initialized
        try {
            if (!sqliteAdapter.initialized) {
                await sqliteAdapter.init();
            }
        } catch (err) {
            return {
                ok: false,
                migrated: false,
                error: `Failed to initialize SQLite adapter: ${err.message}`
            };
        }

        // 4. Check if migration has already completed (Idempotency gate)
        const alreadyMigrated = sqliteAdapter.getMetadata('migrated_from_json') === 'true';
        if (alreadyMigrated) {
            const currentCounts = sqliteAdapter.getCategoryCounts();
            if (currentCounts.total >= sourceMemories.length) {
                return {
                    ok: true,
                    migrated: false,
                    alreadyMigrated: true,
                    parityVerified: true,
                    totalMigrated: currentCounts.total,
                    sourceCounts,
                    sqliteCounts: currentCounts.categories
                };
            }
        }

        // 5. Create Collision-Safe Timestamped Backup before any modifications
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const backupPath = path.join(memoryDir, `memory-store.json.bak_${timestamp}_${Math.random().toString(36).slice(2, 6)}`);

        try {
            fs.copyFileSync(sourceJsonPath, backupPath);
            const origSize = fs.statSync(sourceJsonPath).size;
            const bakSize = fs.statSync(backupPath).size;
            if (origSize !== bakSize) {
                throw new Error(`Backup file size mismatch (${origSize} vs ${bakSize})`);
            }
            // Validate that the backup file is fully readable and contains valid JSON
            const backupRaw = fs.readFileSync(backupPath, 'utf8');
            JSON.parse(backupRaw);
        } catch (err) {
            return {
                ok: false,
                migrated: false,
                error: `Pre-migration backup failed: ${err.message}. Aborting migration to preserve data integrity.`
            };
        }

        // 6. Import records into SQLite in a single transaction with secret scrubbing
        try {
            if (typeof sqliteAdapter.insertMemoriesBatch === 'function') {
                sqliteAdapter.insertMemoriesBatch(sourceMemories);
            } else {
                for (const record of sourceMemories) {
                    sqliteAdapter.insertMemory(record, { save: false });
                }
                sqliteAdapter.saveToDisk();
            }
        } catch (err) {
            // Rollback on insertion failure
            console.error('[MemoryMigrator] Error during record insertion, initiating rollback:', err.message);
            sqliteAdapter.close();
            try {
                if (fs.existsSync(sqliteAdapter.dbPath)) {
                    fs.unlinkSync(sqliteAdapter.dbPath);
                }
            } catch {}
            return {
                ok: false,
                migrated: false,
                backupPath,
                error: `Insertion failed during migration: ${err.message}. Rollback performed; JSON remains active.`
            };
        }

        // 7. Verify Exact Migration Parity across all 5 categories
        const sqliteCategorySummary = sqliteAdapter.getCategoryCounts();
        let parityMatch = true;
        const discrepancies = [];

        if (sourceMemories.length !== sqliteCategorySummary.total) {
            parityMatch = false;
            discrepancies.push(`Total count mismatch: JSON had ${sourceMemories.length}, SQLite has ${sqliteCategorySummary.total}`);
        }

        for (const cat of Object.values(MEMORY_CATEGORIES)) {
            const srcCount = sourceCounts[cat] || 0;
            const sqlCount = sqliteCategorySummary.categories[cat] || 0;
            if (srcCount !== sqlCount) {
                parityMatch = false;
                discrepancies.push(`Category '${cat}' count mismatch: JSON had ${srcCount}, SQLite has ${sqlCount}`);
            }
        }

        // Verify sample content fidelity
        const sampleCheckCount = Math.min(sourceMemories.length, 10);
        for (let i = 0; i < sampleCheckCount; i++) {
            const src = sourceMemories[i];
            if (src && src.id) {
                const fetched = sqliteAdapter.getMemoryById(src.id);
                if (!fetched) {
                    parityMatch = false;
                    discrepancies.push(`Record fidelity check failed: record id '${src.id}' missing in SQLite`);
                }
            }
        }

        // 8. Gate Decision: Commit or Rollback
        if (!parityMatch) {
            console.error('[MemoryMigrator] Parity verification failed! Discrepancies:', discrepancies);
            // Rollback: Close and remove incomplete/mismatched SQLite database
            sqliteAdapter.close();
            try {
                if (fs.existsSync(sqliteAdapter.dbPath)) {
                    fs.unlinkSync(sqliteAdapter.dbPath);
                }
            } catch {}

            return {
                ok: false,
                migrated: false,
                parityVerified: false,
                error: 'Exact migration parity check failed across categories.',
                discrepancies,
                backupPath,
                sourceCounts,
                sqliteCounts: sqliteCategorySummary.categories
            };
        }

        // 9. Record Migration Success Metadata (Never delete source JSON per locked policy)
        sqliteAdapter.setMetadata('migrated_from_json', 'true');
        sqliteAdapter.setMetadata('migration_timestamp', new Date().toISOString());
        sqliteAdapter.setMetadata('backup_path', backupPath);
        sqliteAdapter.setMetadata('long_term_enabled', String(jsonContent.longTermEnabled !== false));
        sqliteAdapter.setMetadata('source_records_count', String(sourceMemories.length));
        sqliteAdapter.saveToDisk();

        return {
            ok: true,
            migrated: true,
            parityVerified: true,
            totalMigrated: sourceMemories.length,
            backupPath,
            sourceCounts,
            sqliteCounts: sqliteCategorySummary.categories
        };
    }
}

module.exports = {
    MemoryMigrator
};
