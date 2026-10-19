const { Pool } = require('pg');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

function safeParseInt(val, fallback = 0) {
    if (val === null || val === undefined) return fallback;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? fallback : parsed;
}

// Strict mapping of Excel filenames to track slugs
const TRACK_MAPPINGS = [
    { file: 'DSA_Mastery_Tracker.xlsx', track: 'beginner' },
    { file: 'intermediate.xlsx', track: 'intermediate' },
    { file: 'advanced.xlsx', track: 'advanced' },
    { file: 'dp_patterns.xlsx', track: 'dp_mastery' }
];

async function seedTierFile(filePath, trackSlug) {
    if (!fs.existsSync(filePath)) {
        console.warn(`⚠️ File not found: ${filePath}, skipping...`);
        return 0;
    }

    const workbook = XLSX.readFile(filePath, { cellDates: true });
    const sheetName = workbook.Sheets['Problems'] ? 'Problems' : workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return 0;

    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    let imported = 0;

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.length < 2) continue;

        const week = safeParseInt(row[1], 1);
        const topic = row[2] ? String(row[2]).trim() : 'General';
        const name = row[3] ? String(row[3]).trim() : '';

        if (!name || name.toLowerCase() === 'problem (click to open)') continue;

        const difficulty = row[4] ? String(row[4]).trim() : 'Easy';
        const priority = row[5] ? String(row[5]).trim() : 'P2';
        let url = row[6] ? String(row[6]).trim() : '';

        if (!url || !url.startsWith('http')) {
            const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            url = `https://leetcode.com/problems/${slug}/`;
        }

        // Upsert problem safely without manual primary key collisions
        await pool.query(`
            INSERT INTO problems (week, topic, name, difficulty, priority, url, track_level, track)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (name, track_level) DO UPDATE SET
                week = EXCLUDED.week,
                topic = EXCLUDED.topic,
                difficulty = EXCLUDED.difficulty,
                priority = EXCLUDED.priority,
                url = EXCLUDED.url,
                track = EXCLUDED.track;
        `, [week, topic, name, difficulty, priority, url, trackSlug, trackSlug]);

        imported++;
    }

    return imported;
}

async function seedAll() {
    console.log('⚡ Initializing & Migrating Database Schema...');

    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                tier_access TEXT DEFAULT 'pro',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );

            CREATE TABLE IF NOT EXISTS problems (
                id SERIAL PRIMARY KEY,
                week INT,
                topic TEXT,
                name TEXT NOT NULL,
                difficulty TEXT,
                priority TEXT,
                url TEXT,
                track_level TEXT DEFAULT 'beginner',
                track TEXT DEFAULT 'beginner'
            );

            CREATE TABLE IF NOT EXISTS user_progress (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id) ON DELETE CASCADE,
                problem_id INT REFERENCES problems(id) ON DELETE CASCADE,
                status TEXT DEFAULT 'Todo',
                solved_date TEXT,
                time_min INT DEFAULT 0,
                revisions INT DEFAULT 0,
                pattern_notes TEXT,
                code_snippet TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, problem_id)
            );
        `);

        // Attach auto-increment sequence to problems.id if missing
        await pool.query(`
            CREATE SEQUENCE IF NOT EXISTS problems_id_seq;
            ALTER TABLE problems ALTER COLUMN id SET DEFAULT nextval('problems_id_seq');
            ALTER SEQUENCE problems_id_seq OWNED BY problems.id;
            SELECT setval('problems_id_seq', COALESCE((SELECT MAX(id) FROM problems), 0) + 1, false);
        `);

        // Align schema columns
        await pool.query(`
            ALTER TABLE problems ADD COLUMN IF NOT EXISTS url TEXT;
            ALTER TABLE problems ADD COLUMN IF NOT EXISTS track_level TEXT DEFAULT 'beginner';
            ALTER TABLE problems ADD COLUMN IF NOT EXISTS track TEXT DEFAULT 'beginner';
            ALTER TABLE users ADD COLUMN IF NOT EXISTS tier_access TEXT DEFAULT 'pro';
            ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS pattern_notes TEXT;
            ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS code_snippet TEXT;
            ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS time_min INT DEFAULT 0;
        `);

        // Ensure unique constraint exists on (name, track_level)
        await pool.query(`
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint WHERE conname = 'unique_problem_per_track_level'
                ) THEN
                    ALTER TABLE problems ADD CONSTRAINT unique_problem_per_track_level UNIQUE (name, track_level);
                END IF;
            END $$;
        `);

        // Process each mapped Excel track file
        for (const target of TRACK_MAPPINGS) {
            const filePath = path.join(__dirname, target.file);
            console.log(`⚡ Seeding track '${target.track}' from ${target.file}...`);
            const count = await seedTierFile(filePath, target.track);
            console.log(`✅ Successfully seeded ${count} problems for '${target.track}'.`);
        }

        console.log('🎉 All 4 tracks seeded successfully!');
    } catch (err) {
        console.error('❌ Seeding Error:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

seedAll();