const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const XLSX = require('xlsx');
const fs = require('fs');
const path = require('path');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'dsa_mastery_secret_key_2026';

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Initialize Database Schema
async function initDb() {
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
        console.log('PostgreSQL Multi-Page Schema Initialized');

        // Initial scan on startup
        await syncRootExcelFiles();
    } catch (err) {
        console.error('Database Initialization Error:', err);
    }
}

// Ingest Excel File Dynamic Engine with Track Tagging
async function processExcelBuffer(buffer, defaultTrackSlug = 'beginner') {
    const workbook = XLSX.read(buffer, { type: 'buffer', cellDates: true });
    const sheetName = workbook.Sheets['Problems'] ? 'Problems' : workbook.SheetNames[0];
    const problemsSheet = workbook.Sheets[sheetName];
    if (!problemsSheet) return 0;

    const rows = XLSX.utils.sheet_to_json(problemsSheet, { header: 1 });
    let imported = 0;

    for (let r = 1; r < rows.length; r++) {
        const row = rows[r];
        if (!row || row.length < 2) continue;

        const id = parseInt(row[0]) || (r + 10000);
        const week = parseInt(row[1]) || 1;
        const topic = row[2] ? String(row[2]) : 'General';
        const name = row[3] ? String(row[3]) : '';
        if (!name) continue;

        const difficulty = row[4] ? String(row[4]) : 'Easy';
        const priority = row[5] ? String(row[5]) : 'P2';
        let url = row[6] ? String(row[6]) : '';
        const rowTrack = row[7] ? String(row[7]).toLowerCase().trim() : '';
        const trackLevel = rowTrack || defaultTrackSlug;

        if (!url || !url.startsWith('http')) {
            const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
            url = `https://leetcode.com/problems/${slug}/`;
        }

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

// Automatically scans root directory for ANY .xlsx file and parses it
async function syncRootExcelFiles() {
    try {
        const files = fs.readdirSync(__dirname).filter(f => f.endsWith('.xlsx') && !f.startsWith('~$'));
        for (const file of files) {
            const filePath = path.join(__dirname, file);
            let trackSlug = file.replace(/\.xlsx$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-\vert{}-$)/g, '');
            if (trackSlug.includes('mastery') || trackSlug.includes('tracker')) trackSlug = 'beginner';

            const buffer = fs.readFileSync(filePath);
            await processExcelBuffer(buffer, trackSlug);
        }
    } catch (err) {
        console.error('Error syncing Excel files from root directory:', err);
    }
}

initDb();

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid session' });
        req.user = user;
        next();
    });
}

// --- DYNAMIC TRACKS API ---
app.get('/api/tracks/status', authenticateToken, async (req, res) => {
    try {
        await syncRootExcelFiles();

        const countsRes = await pool.query(`
            SELECT COALESCE(track_level, 'beginner') as track_level, COUNT(*)::int as count 
            FROM problems GROUP BY COALESCE(track_level, 'beginner')
        `);

        const tracks = {};
        countsRes.rows.forEach(r => {
            const slug = r.track_level;
            const formattedTitle = slug.split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
            tracks[slug] = {
                id: slug,
                name: formattedTitle.includes('Track') || formattedTitle.includes('Mastery') ? formattedTitle : `${formattedTitle} Roadmap`,
                status: 'ACTIVE',
                isBeta: false,
                problemCount: r.count
            };
        });

        res.json({ tracks });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/tracks/upload-excel', authenticateToken, async (req, res) => {
    try {
        const { fileBase64, fileName } = req.body;
        const buffer = Buffer.from(fileBase64.replace(/^data:.*;base64,/, ''), 'base64');
        
        let trackSlug = fileName.replace(/\.xlsx$/i, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-\vert{}-$)/g, '');
        if (trackSlug.includes('mastery') || trackSlug.includes('tracker')) trackSlug = 'beginner';

        const count = await processExcelBuffer(buffer, trackSlug);
        fs.writeFileSync(path.join(__dirname, fileName), buffer);
        res.json({ success: true, message: `Successfully loaded ${count} problems for track '${trackSlug}'!`, importedCount: count });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- PROBLEMS API ---
app.get('/api/problems', authenticateToken, async (req, res) => {
    try {
        const trackLevel = req.query.track || 'beginner';
        const query = `
            SELECT p.*, COALESCE(up.status, 'Todo') as status, up.solved_date,
                   COALESCE(up.time_min, 0) as time_min, COALESCE(up.revisions, 0) as revisions,
                   up.pattern_notes, up.code_snippet
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
            WHERE COALESCE(p.track_level, 'beginner') = $2
            ORDER BY p.id ASC
        `;
        const result = await pool.query(query, [req.user.userId, trackLevel]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/progress/:problemId', authenticateToken, async (req, res) => {
    try {
        const { status, solved_date, revisions, time_min, pattern_notes, code_snippet } = req.body;
        await pool.query(`
            INSERT INTO user_progress (user_id, problem_id, status, solved_date, time_min, revisions, pattern_notes, code_snippet, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, problem_id) DO UPDATE SET
                status = EXCLUDED.status, solved_date = EXCLUDED.solved_date, time_min = EXCLUDED.time_min,
                revisions = EXCLUDED.revisions, pattern_notes = EXCLUDED.pattern_notes, code_snippet = EXCLUDED.code_snippet, updated_at = CURRENT_TIMESTAMP
        `, [req.user.userId, req.params.problemId, status || 'Todo', solved_date || null, time_min || 0, revisions || 0, pattern_notes || '', code_snippet || '']);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- AUTH & HTML ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/roadmaps', (req, res) => res.sendFile(path.join(__dirname, 'public', 'roadmaps.html')));
app.get('/problems', (req, res) => res.sendFile(path.join(__dirname, 'public', 'problems.html')));
app.get('/kanban', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kanban.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'public', 'analytics.html')));
app.get('/ai-coach', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ai-coach.html')));

app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        const hash = bcrypt.hashSync(password, 10);
        const result = await pool.query(`INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id`, [name, email, hash]);
        const userId = result.rows[0].id;
        const token = jwt.sign({ userId, name, email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: userId, name, email } });
    } catch (err) {
        res.status(400).json({ error: 'User already exists' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await pool.query(`SELECT * FROM users WHERE email = $1`, [email]);
        const user = result.rows[0];
        if (!user || !bcrypt.compareSync(password, user.password_hash)) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign({ userId: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Dynamic Multi-Track Server Running on http://localhost:${PORT}`));