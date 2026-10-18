const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { Resend } = require('resend');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'dsa_tracker_secret_2026';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

// Initialize Database Schema with Multi-Tier Roadmap Support
async function initDb() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                email TEXT UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
            ALTER TABLE users ADD COLUMN IF NOT EXISTS last_track_status TEXT;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS last_email_date TEXT;

            CREATE TABLE IF NOT EXISTS problems (
                id INT PRIMARY KEY,
                tier TEXT DEFAULT 'Beginner',
                week INT,
                topic TEXT,
                name TEXT,
                difficulty TEXT,
                priority TEXT,
                url TEXT
            );
            ALTER TABLE problems ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'Beginner';
            ALTER TABLE problems ADD COLUMN IF NOT EXISTS url TEXT;

            CREATE TABLE IF NOT EXISTS user_progress (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id),
                problem_id INT REFERENCES problems(id),
                status TEXT DEFAULT 'Todo',
                solved_date TEXT,
                time_min INT DEFAULT 0,
                revisions INT DEFAULT 0,
                pattern_notes TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, problem_id)
            );
            ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS pattern_notes TEXT;
            ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS time_min INT DEFAULT 0;

            CREATE TABLE IF NOT EXISTS roadmap (
                week INT PRIMARY KEY,
                tier TEXT DEFAULT 'Beginner',
                phase TEXT,
                topic TEXT,
                patterns TEXT,
                goal TEXT
            );
            ALTER TABLE roadmap ADD COLUMN IF NOT EXISTS tier TEXT DEFAULT 'Beginner';
        `);
        console.log('Database schema initialized with multi-tier roadmaps and beta-locking support.');
    } catch (err) {
        console.error('Database initialization failed:', err);
    }
}
initDb();

function authenticateToken(req, res, next) {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token required' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid token' });
        req.user = user;
        next();
    });
}

// Gemini AI Helper
async function callGeminiAPI(promptText) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY missing in environment variables.");

    const genAI = new GoogleGenerativeAI(apiKey);
    const candidateModels = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"];

    let lastError = null;
    for (const modelName of candidateModels) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent(promptText);
            const response = await result.response;
            const text = response.text();
            if (text) return text.trim();
        } catch (err) {
            console.warn(`Gemini model ${modelName} failed:`, err.message);
            lastError = err;
        }
    }
    throw lastError || new Error("All Gemini models failed.");
}

// Diagnostic Engine for Specific Tier
async function analyzeUserPerformanceAndAdapt(userId, activeTier = 'Beginner') {
    const progressRes = await pool.query(`
        SELECT p.id, p.tier, p.name, p.topic, p.difficulty, p.priority, p.url,
               COALESCE(up.status, 'Todo') as status,
               up.solved_date, COALESCE(up.time_min, 0) as time_min,
               COALESCE(up.revisions, 0) as revisions, up.pattern_notes
        FROM problems p
        LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
        WHERE p.tier = $2
        ORDER BY p.id ASC
    `, [userId, activeTier]);

    const problems = progressRes.rows;
    const total = problems.length;
    const solved = problems.filter(p => p.status === 'Solved' || p.status === 'Mastered');

    const mediumAttempted = problems.filter(p => p.difficulty === 'Medium' && p.status !== 'Todo');
    const mediumSolvedClean = mediumAttempted.filter(p => p.status === 'Solved' || p.status === 'Mastered');
    const mediumHintSolved = mediumAttempted.filter(p => p.status === 'Hint-solved');
    
    const isStrugglingInMedium = mediumAttempted.length >= 2 && 
        (mediumHintSolved.length / mediumAttempted.length >= 0.35 || mediumSolvedClean.length / mediumAttempted.length < 0.45);

    const today = new Date().toISOString().split('T')[0];
    const intervals = [1, 3, 7, 21, 60];
    const revisionsDue = problems.filter(p => {
        if (!p.solved_date || p.revisions >= 5) return false;
        const d = new Date(p.solved_date);
        d.setDate(d.getDate() + intervals[Math.min(p.revisions, 4)]);
        return d.toISOString().split('T')[0] <= today;
    });

    // Solving Streak
    const solvedDates = [...new Set(solved.map(p => p.solved_date).filter(Boolean))].sort().reverse();
    let streak = 0;
    if (solvedDates.length > 0) {
        const todayDate = new Date();
        const yesterdayDate = new Date();
        yesterdayDate.setDate(todayDate.getDate() - 1);
        const tStr = todayDate.toISOString().split('T')[0];
        const yStr = yesterdayDate.toISOString().split('T')[0];

        if (solvedDates[0] === tStr || solvedDates[0] === yStr) {
            let curr = new Date(solvedDates[0]);
            for (const dStr of solvedDates) {
                const d = new Date(dStr);
                const diffDays = Math.round((curr - d) / (1000 * 60 * 60 * 24));
                if (diffDays <= 1) {
                    streak++;
                    curr = d;
                } else {
                    break;
                }
            }
        }
    }

    let recommendedQueue = [];
    let coachTrackStatus = "Optimal Pace";
    let adaptationReason = "Curriculum flow perfectly aligned with current performance.";

    if (isStrugglingInMedium) {
        coachTrackStatus = "Pacing Adapted: Foundation Stepping-Stone";
        adaptationReason = "Performance pattern indicates slight struggle on Medium concepts. Queue auto-focused on core Easy patterns.";
        recommendedQueue = problems.filter(p => p.difficulty === 'Easy' && p.status === 'Todo').slice(0, 3);
    } else {
        recommendedQueue = problems.filter(p => p.status === 'Todo' && p.priority === 'P1').slice(0, 3);
        if (recommendedQueue.length < 3) {
            recommendedQueue = problems.filter(p => p.status === 'Todo').slice(0, 3);
        }
    }

    let aiFeedback = `Completed ${solved.length}/${total} problems in ${activeTier} tier. ${adaptationReason}`;
    
    if (process.env.GEMINI_API_KEY && total > 0) {
        try {
            const prompt = `You are an elite competitive programming coach. User stats for ${activeTier} tier: ${solved.length}/${total} solved. Track: ${coachTrackStatus}. Write a concise, motivational 2-sentence strategy directive for today.`;
            aiFeedback = await callGeminiAPI(prompt);
        } catch (e) {
            console.warn("Gemini AI fallback triggered:", e.message);
        }
    }

    return {
        summary: {
            total,
            solvedCount: solved.length,
            masteredCount: problems.filter(p => p.revisions >= 5).length,
            dueCount: revisionsDue.length,
            streak,
            isStrugglingInMedium,
            trackStatus: coachTrackStatus,
            adaptationReason
        },
        aiFeedback,
        revisionsDue: revisionsDue.slice(0, 5),
        recommendedQueue
    };
}

async function sendCoachingEmail(user, insights, isAutoTrigger = false) {
    if (!process.env.RESEND_API_KEY || !resend) return false;

    const subject = isAutoTrigger 
        ? `⚡ AI Coach Alert: Strategy Adaptive Shift`
        : `🎯 Daily DSA Strategy Plan (${new Date().toLocaleDateString()})`;

    await resend.emails.send({
        from: 'DSA AI Engine <onboarding@resend.dev>',
        to: user.email,
        subject: subject,
        html: `
            <div style="font-family: Inter, sans-serif; background: #09090b; color: #f4f4f5; padding: 28px; border-radius: 16px; border: 1px solid #27272a;">
                <h2 style="color: #10b981; margin-top: 0;">DSA AI Engine Briefing</h2>
                <p>Hi <strong>${user.name}</strong>,</p>
                <p style="background: #18181b; padding: 14px; border-left: 4px solid #10b981; border-radius: 8px; color: #e4e4e7;">${insights.aiFeedback}</p>
                
                <h3 style="color: #06b6d4;">Track Mode: ${insights.summary.trackStatus}</h3>
                <p style="color: #a1a1aa; font-size: 13px;">${insights.summary.adaptationReason}</p>

                <h4 style="color: #f59e0b; margin-top: 20px;">1. Revisions Due Today (${insights.revisionsDue.length})</h4>
                <ul style="color: #d4d4d8;">
                    ${insights.revisionsDue.map(r => `<li><strong>${r.name}</strong> (${r.topic}) - Rev ${r.revisions}/5</li>`).join('') || '<li>No revisions due today! Keep grinding! 🚀</li>'}
                </ul>

                <h4 style="color: #8b5cf6;">2. Recommended Next Problems</h4>
                <ul style="color: #d4d4d8;">
                    ${insights.recommendedQueue.map(p => `<li><a href="${p.url}" style="color: #38bdf8; text-decoration: none;"><strong>${p.name}</strong></a> (${p.difficulty})</li>`).join('')}
                </ul>
            </div>
        `
    });
    return true;
}

// --- ROADMAP & TIER APIS ---
app.get('/api/roadmaps/meta', authenticateToken, async (req, res) => {
    try {
        const tiers = ['Beginner', 'Intermediate', 'Mastery'];
        const metadata = [];

        for (const tier of tiers) {
            const countRes = await pool.query(
                `SELECT COUNT(p.id)::int as total,
                        SUM(CASE WHEN up.status IN ('Solved', 'Mastered') THEN 1 ELSE 0 END)::int as solved
                 FROM problems p
                 LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
                 WHERE p.tier = $2`,
                [req.user.userId, tier]
            );
            const total = countRes.rows[0].total || 0;
            const solved = countRes.rows[0].solved || 0;

            metadata.push({
                tier,
                totalProblems: total,
                solvedProblems: solved,
                isUnlocked: total > 0,
                isBeta: total === 0,
                expectedFileName: tier === 'Beginner' ? 'Roadmap_Beginner.xlsx (or Sheet 1)' :
                                  tier === 'Intermediate' ? 'Roadmap_Intermediate.xlsx' : 'Roadmap_Mastery.xlsx'
            });
        }

        res.json(metadata);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- AUTHENTICATION APIS ---
app.post('/api/auth/signup', async (req, res) => {
    try {
        const { name, email, password } = req.body;
        if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

        const hash = bcrypt.hashSync(password, 10);
        const result = await pool.query(
            `INSERT INTO users (name, email, password_hash) VALUES ($1, $2, $3) RETURNING id`,
            [name, email, hash]
        );
        const userId = result.rows[0].id;
        const token = jwt.sign({ userId, name, email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: userId, name, email } });
    } catch (err) {
        if (err.code === '23505') return res.status(400).json({ error: 'Email already registered' });
        res.status(500).json({ error: err.message });
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

app.get('/api/auth/me', authenticateToken, (req, res) => res.json({ user: req.user }));

// --- PROBLEMS & PROGRESS APIS ---
app.get('/api/problems', authenticateToken, async (req, res) => {
    try {
        const tier = req.query.tier || 'Beginner';
        const query = `
            SELECT p.*, 
                   COALESCE(up.status, 'Todo') as status,
                   up.solved_date,
                   COALESCE(up.time_min, 0) as time_min,
                   COALESCE(up.revisions, 0) as revisions,
                   up.pattern_notes
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
            WHERE p.tier = $2
            ORDER BY p.id ASC
        `;
        const result = await pool.query(query, [req.user.userId, tier]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/progress/:problemId', authenticateToken, async (req, res) => {
    try {
        const status = req.body.status || 'Todo';
        const solved_date = req.body.solved_date || null;
        const revisions = req.body.revisions != null ? req.body.revisions : 0;
        const time_min = req.body.time_min != null ? req.body.time_min : 0;
        const pattern_notes = req.body.pattern_notes != null ? req.body.pattern_notes : '';

        await pool.query(`
            INSERT INTO user_progress (user_id, problem_id, status, solved_date, time_min, revisions, pattern_notes, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, problem_id) DO UPDATE SET
                status = EXCLUDED.status,
                solved_date = EXCLUDED.solved_date,
                time_min = EXCLUDED.time_min,
                revisions = EXCLUDED.revisions,
                pattern_notes = EXCLUDED.pattern_notes,
                updated_at = CURRENT_TIMESTAMP
        `, [req.user.userId, req.params.problemId, status, solved_date, time_min, revisions, pattern_notes]);

        const probTierRes = await pool.query(`SELECT tier FROM problems WHERE id = $1`, [req.params.problemId]);
        const tier = probTierRes.rows[0]?.tier || 'Beginner';

        const insights = await analyzeUserPerformanceAndAdapt(req.user.userId, tier);
        const userRes = await pool.query(`SELECT name, email, last_track_status FROM users WHERE id = $1`, [req.user.userId]);
        const user = userRes.rows[0];

        if (user && insights.summary.trackStatus !== user.last_track_status) {
            await pool.query(`UPDATE users SET last_track_status = $1 WHERE id = $2`, [insights.summary.trackStatus, req.user.userId]);
            sendCoachingEmail(user, insights, true).catch(e => console.error("Auto email trigger error:", e.message));
        }

        res.json({ success: true, trackStatus: insights.summary.trackStatus });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/progress/:problemId/notes', authenticateToken, async (req, res) => {
    try {
        const { pattern_notes } = req.body;
        const problemId = parseInt(req.params.problemId);
        const userId = req.user.userId;

        await pool.query(`
            INSERT INTO user_progress (user_id, problem_id, status, pattern_notes, updated_at)
            VALUES ($1, $2, 'Todo', $3, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, problem_id) DO UPDATE SET
                pattern_notes = EXCLUDED.pattern_notes,
                updated_at = CURRENT_TIMESTAMP
        `, [userId, problemId, pattern_notes || '']);

        res.json({ success: true, message: 'Notes saved successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/progress/:problemId/time', authenticateToken, async (req, res) => {
    try {
        const { time_min } = req.body;
        const problemId = parseInt(req.params.problemId);
        const userId = req.user.userId;

        await pool.query(`
            INSERT INTO user_progress (user_id, problem_id, status, time_min, updated_at)
            VALUES ($1, $2, 'Todo', $3, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, problem_id) DO UPDATE SET
                time_min = EXCLUDED.time_min,
                updated_at = CURRENT_TIMESTAMP
        `, [userId, problemId, time_min || 0]);

        res.json({ success: true, message: 'Time logged successfully' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/coach/insights', authenticateToken, async (req, res) => {
    try {
        const tier = req.query.tier || 'Beginner';
        const insights = await analyzeUserPerformanceAndAdapt(req.user.userId, tier);
        res.json(insights);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/coach/ask', authenticateToken, async (req, res) => {
    try {
        const { question, tier } = req.body;
        if (!question) return res.status(400).json({ error: "Question required" });

        const insights = await analyzeUserPerformanceAndAdapt(req.user.userId, tier || 'Beginner');
        if (!process.env.GEMINI_API_KEY) {
            return res.json({ answer: "⚠️ GEMINI_API_KEY missing in environment variables." });
        }

        try {
            const prompt = `You are an elite competitive programming mentor. User progress in ${tier || 'Beginner'} tier: ${insights.summary.solvedCount}/${insights.summary.total} solved. Track: ${insights.summary.trackStatus}.
User Question: "${question}"
Provide a sharp, encouraging 2-sentence technical answer.`;

            const text = await callGeminiAPI(prompt);
            res.json({ answer: text });
        } catch (aiErr) {
            res.json({ answer: `⚠️ Gemini API Error (${aiErr.message}). Check GEMINI_API_KEY!` });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/coach/send-email', authenticateToken, async (req, res) => {
    try {
        const userRes = await pool.query(`SELECT name, email FROM users WHERE id = $1`, [req.user.userId]);
        const user = userRes.rows[0];
        if (!user) return res.status(404).json({ error: "User not found" });

        const tier = req.body.tier || 'Beginner';
        const insights = await analyzeUserPerformanceAndAdapt(req.user.userId, tier);
        const sent = await sendCoachingEmail(user, insights, false);

        if (sent) {
            res.json({ success: true, message: `Coaching plan sent to ${user.email}!` });
        } else {
            res.json({ success: false, message: "RESEND_API_KEY missing in environment variables." });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));