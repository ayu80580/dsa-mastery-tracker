const { Pool } = require('pg');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

// Configure PostgreSQL connection pool with SSL
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Helper to safely parse numbers without producing NaN
function safeParseInt(val, fallback = 0) {
    if (val === null || val === undefined) return fallback;
    const parsed = parseInt(val, 10);
    return isNaN(parsed) ? fallback : parsed;
}

// Ingest an Excel file safely into the database
async function seedTierFile(filePath, defaultTrackSlug = 'beginner') {
    if (!fs.existsSync(filePath)) {
        console.warn(`File not found: ${filePath}, skipping...`);
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

        // Extract ID and skip if NaN or missing
        const rawId = row[0];
        const parsedId = safeParseInt(rawId, null);
        
        // If ID cell is empty or non-numeric (e.g. text/headers), generate or fallback safely
        const id = (parsedId !== null && parsedId > 0) ? parsedId : (r + 10000);
        
        // Safely parse week (defaults to 1 if NaN)
        const week = safeParseInt(row[1], 1);
        
        const topic = row[2] ? String(row[2]).trim() : 'General';
        const name = row[3] ? String(row[3]).trim() : '';
        
        // Skip row if problem name is empty
        if (!name || name.toLowerCase() === 'problem (click to open)') continue;

        const difficulty = row[4] ? String(row[4]).trim() : 'Easy';
        const priority = row[5] ? String(row[5]).trim() : 'P2';
        let url = row[6] ? String(row[6]).trim() : '';
        const trackLevel = row[7] ? String(row[7]).toLowerCase().trim() : defaultTrackSlug;

        if (!url || !url.startsWith('http')) {
            const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            url = `https://leetcode.com/problems/${slug}/`;
        }

        // Execute parameterized query guaranteed to have valid integer types
        await pool.query(`
            INSERT INTO problems (id, week, topic, name, difficulty, priority, url, track_level)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO UPDATE SET
                week = EXCLUDED.week,
                topic = EXCLUDED.topic,
                name = EXCLUDED.name,
                difficulty = EXCLUDED.difficulty,
                priority = EXCLUDED.priority,
                url = EXCLUDED.url,
                track_level = EXCLUDED.track_level
        `, [id, week, topic, name, difficulty, priority, url, trackLevel]);

        imported++;
    }

    return imported;
}

async function seedAll() {
    console.log('⚡ Initializing Database Schema...');
    
    try {
        // Ensure Database Tables Exist
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
                id INT PRIMARY KEY,
                week INT,
                topic TEXT,
                name TEXT,
                difficulty TEXT,
                priority TEXT,
                url TEXT,
                track_level TEXT DEFAULT 'beginner'
            );

            CREATE TABLE IF NOT EXISTS user_progress (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id),
                problem_id INT REFERENCES problems(id),
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

        // Scan root directory for all .xlsx files
        const rootFiles = fs.readdirSync(__dirname).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));
        
        for (const file of rootFiles) {
            let trackSlug = file.replace(/\.xlsx$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-\vert{}-$)/g, '');
            if (trackSlug.includes('mastery') || trackSlug.includes('tracker')) trackSlug = 'beginner';

            console.log(`⚡ Seeding track '${trackSlug}' from ${file}...`);
            const count = await seedTierFile(path.join(__dirname, file), trackSlug);
            console.log(`✅ Successfully seeded ${count} problems for '${trackSlug}'.`);
        }

        console.log('🎉 Seeding process completed successfully!');
    } catch (err) {
        console.error('❌ Seeding Error:', err);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

seedAll();