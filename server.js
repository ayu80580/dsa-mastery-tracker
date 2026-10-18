const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const path = require('path');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'dsa_mastery_secret_key_2026';

app.use(cors());
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

// Authentication Middleware
function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired session' });
        req.user = user;
        next();
    });
}

// Gemini AI Helper
async function callGeminiAPI(promptText) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY missing");
    const genAI = new GoogleGenerativeAI(apiKey);
    const candidateModels = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];

    for (const modelName of candidateModels) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(promptText);
            const response = await result.response;
            const text = response.text();
            if (text) return text.trim();
        } catch (err) {
            console.warn(`Model ${modelName} failed:`, err.message);
        }
    }
    throw new Error("All AI models failed.");
}

// --- 1. DASHBOARD TELEMETRY API ---
app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const track = (req.query.track || 'all').toLowerCase().trim();
        const userId = req.user.userId;

        let whereClause = '';
        let queryParams = [userId];

        if (track !== 'all') {
            whereClause = 'WHERE LOWER(COALESCE(p.track_level, \'beginner\')) = $2';
            queryParams.push(track);
        }

        // Summary Counts
        const summaryRes = await pool.query(`
            SELECT 
                COUNT(p.id)::int as total,
                SUM(CASE WHEN up.status IN ('Solved', 'Mastered') THEN 1 ELSE 0 END)::int as solved,
                SUM(CASE WHEN up.status = 'Mastered' OR up.revisions >= 5 THEN 1 ELSE 0 END)::int as mastered,
                SUM(CASE WHEN up.status = 'Hint-solved' THEN 1 ELSE 0 END)::int as hint_used
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
            ${whereClause}
        `, queryParams);

        const summary = summaryRes.rows[0] || { total: 0, solved: 0, mastered: 0, hint_used: 0 };

        // Spaced Repetition Due Review Schedule
        const today = new Date().toISOString().split('T')[0];
        const dueRes = await pool.query(`
            SELECT p.id, p.name, p.topic, p.difficulty, p.url, up.solved_date, COALESCE(up.revisions, 0) as revisions
            FROM problems p
            JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
            WHERE up.solved_date IS NOT NULL AND up.revisions < 5
            ${track !== 'all' ? 'AND LOWER(COALESCE(p.track_level, \'beginner\')) = $2' : ''}
            ORDER BY up.solved_date ASC
        `, queryParams);

        const intervals = [1, 3, 7, 21, 60];
        const revisionsDue = dueRes.rows.filter(p => {
            const d = new Date(p.solved_date);
            d.setDate(d.getDate() + intervals[Math.min(p.revisions, 4)]);
            return d.toISOString().split('T')[0] <= today;
        });

        // 365-Day Submission Heatmap Data
        const heatmapRes = await pool.query(`
            SELECT solved_date, COUNT(*)::int as count
            FROM user_progress
            WHERE user_id = $1 AND solved_date IS NOT NULL
            GROUP BY solved_date
        `, [userId]);

        // Daily Streak Calculation
        const solvedDates = [...new Set(heatmapRes.rows.map(r => r.solved_date))].sort().reverse();
        let streak = 0;
        if (solvedDates.length > 0) {
            let curr = new Date(solvedDates[0]);
            for (const dStr of solvedDates) {
                const d = new Date(dStr);
                const diff = Math.round((curr - d) / (1000 * 60 * 60 * 24));
                if (diff <= 1) { streak++; curr = d; } else break;
            }
        }

        res.json({
            summary: {
                total: summary.total || 0,
                solvedCount: summary.solved || 0,
                masteredCount: summary.mastered || 0,
                dueCount: revisionsDue.length,
                streak
            },
            revisionsDue: revisionsDue.slice(0, 5),
            heatmap: heatmapRes.rows || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 2. MASTER PROBLEMS API ---
app.get('/api/problems', authenticateToken, async (req, res) => {
    try {
        const trackLevel = (req.query.track || 'all').toLowerCase().trim();
        let query = `
            SELECT p.*, COALESCE(up.status, 'Todo') as status, up.solved_date,
                   COALESCE(up.time_min, 0) as time_min, COALESCE(up.revisions, 0) as revisions,
                   up.pattern_notes, up.code_snippet
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
        `;
        const params = [req.user.userId];

        if (trackLevel !== 'all') {
            query += ` WHERE LOWER(COALESCE(p.track_level, 'beginner')) = $2`;
            params.push(trackLevel);
        }

        query += ` ORDER BY p.id ASC`;

        const result = await pool.query(query, params);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 3. ANALYTICS API ---
const handleAnalytics = async (req, res) => {
    try {
        const track = (req.query.track || 'all').toLowerCase().trim();
        const userId = req.user.userId;

        let whereClause = '';
        let queryParams = [userId];

        if (track !== 'all') {
            whereClause = 'WHERE LOWER(COALESCE(p.track_level, \'beginner\')) = $2';
            queryParams.push(track);
        }

        const topicsRes = await pool.query(`
            SELECT 
                p.topic,
                COUNT(p.id)::int as total,
                SUM(CASE WHEN up.status IN ('Solved', 'Mastered') THEN 1 ELSE 0 END)::int as solved,
                SUM(CASE WHEN up.status = 'Hint-solved' THEN 1 ELSE 0 END)::int as hint_used,
                SUM(CASE WHEN up.status = 'Mastered' THEN 1 ELSE 0 END)::int as mastered
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
            ${whereClause}
            GROUP BY p.topic
            ORDER BY total DESC
        `, queryParams);

        const diffRes = await pool.query(`
            SELECT 
                p.difficulty,
                COUNT(p.id)::int as total,
                SUM(CASE WHEN up.status IN ('Solved', 'Mastered') THEN 1 ELSE 0 END)::int as solved
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
            ${whereClause}
            GROUP BY p.difficulty
        `, queryParams);

        res.json({
            topics: topicsRes.rows || [],
            difficulties: diffRes.rows || []
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

app.get('/api/analytics', authenticateToken, handleAnalytics);
app.get('/api/analytics/deep', authenticateToken, handleAnalytics);

// --- 4. ROADMAP & TRACK STATUS API ---
app.get('/api/tracks/status', authenticateToken, async (req, res) => {
    try {
        const countsRes = await pool.query(`
            SELECT COALESCE(track_level, 'beginner') as track_level, COUNT(*)::int as count 
            FROM problems GROUP BY COALESCE(track_level, 'beginner')
        `);

        const counts = { beginner: 0, intermediate: 0, advanced: 0 };
        countsRes.rows.forEach(r => { counts[r.track_level] = r.count; });

        res.json({
            tracks: {
                beginner: { name: 'Beginner Roadmap', problemCount: counts.beginner || 100 },
                intermediate: { name: 'Intermediate Roadmap', problemCount: counts.intermediate || 150 },
                advanced: { name: 'Advanced Roadmap', problemCount: counts.advanced || 200 }
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- 5. PROGRESS UPDATE API ---
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

// --- 6. AI COACH APIS ---
app.get('/api/coach/insights', authenticateToken, async (req, res) => {
    try {
        const track = (req.query.track || 'all').toLowerCase().trim();
        let whereClause = '';
        let params = [req.user.userId];

        if (track !== 'all') {
            whereClause = 'WHERE LOWER(COALESCE(p.track_level, \'beginner\')) = $2';
            params.push(track);
        }

        const progressRes = await pool.query(`
            SELECT p.id, p.name, p.topic, p.difficulty, COALESCE(up.status, 'Todo') as status
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
            ${whereClause}
        `, params);

        const total = progressRes.rows.length;
        const solved = progressRes.rows.filter(p => p.status === 'Solved' || p.status === 'Mastered').length;

        let aiFeedback = `Completed ${solved}/${total} problems on track '${track}'. Maintain daily practice!`;
        if (process.env.GEMINI_API_KEY) {
            try {
                aiFeedback = await callGeminiAPI(`You are a competitive programming coach. User stats for track '${track}': ${solved}/${total} solved. Write a short 2-sentence coaching directive.`);
            } catch (e) {
                console.warn("AI fallback:", e.message);
            }
        }

        res.json({
            summary: { total, solvedCount: solved, trackStatus: "On Track", adaptationReason: "Pacing optimal." },
            aiFeedback
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/coach/ask', authenticateToken, async (req, res) => {
    try {
        const { question } = req.body;
        if (!question) return res.status(400).json({ error: "Question required" });
        if (!process.env.GEMINI_API_KEY) {
            return res.json({ answer: "⚠️ GEMINI_API_KEY missing in Render environment variables." });
        }
        const text = await callGeminiAPI(`You are an elite DSA coach. User question: "${question}". Provide a helpful 2-3 sentence explanation.`);
        res.json({ answer: text });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- AUTH ROUTES ---
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

// HTML Page Routes
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public', 'dashboard.html')));
app.get('/roadmaps', (req, res) => res.sendFile(path.join(__dirname, 'public', 'roadmaps.html')));
app.get('/problems', (req, res) => res.sendFile(path.join(__dirname, 'public', 'problems.html')));
app.get('/kanban', (req, res) => res.sendFile(path.join(__dirname, 'public', 'kanban.html')));
app.get('/analytics', (req, res) => res.sendFile(path.join(__dirname, 'public', 'analytics.html')));
app.get('/ai-coach', (req, res) => res.sendFile(path.join(__dirname, 'public', 'ai-coach.html')));

// Catch-all for API endpoints so they always return JSON 404 instead of raw HTML
app.all('/api/*', (req, res) => {
    res.status(404).json({ error: `API route ${req.originalUrl} not found` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DSA Engine Active on http://localhost:${PORT}`));