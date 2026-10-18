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

// Initialize Database Schema with Email Tracking & Notes Columns
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
                week INT,
                topic TEXT,
                name TEXT,
                difficulty TEXT,
                priority TEXT,
                url TEXT
            );
            ALTER TABLE problems ADD COLUMN IF NOT EXISTS url TEXT;

            CREATE TABLE IF NOT EXISTS user_progress (
                id SERIAL PRIMARY KEY,
                user_id INT REFERENCES users(id),
                problem_id INT REFERENCES problems(id),
                status TEXT DEFAULT 'Todo',
                solved_date TEXT,
                time_min INT,
                revisions INT DEFAULT 0,
                pattern_notes TEXT,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(user_id, problem_id)
            );
            ALTER TABLE user_progress ADD COLUMN IF NOT EXISTS pattern_notes TEXT;

            CREATE TABLE IF NOT EXISTS roadmap (
                week INT PRIMARY KEY,
                phase TEXT,
                topic TEXT,
                patterns TEXT,
                goal TEXT
            );
        `);
        console.log('Database schema verified with key logic notes support.');
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

// Gemini AI API Helper with Model Fallbacks
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

// Adaptive Diagnostic Engine
async function analyzeUserPerformanceAndAdapt(userId) {
    const progressRes = await pool.query(`
        SELECT p.id, p.name, p.topic, p.difficulty, p.priority, p.url,
               COALESCE(up.status, 'Todo') as status,
               up.solved_date, COALESCE(up.revisions, 0) as revisions, up.pattern_notes
        FROM problems p
        LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
        ORDER BY p.id ASC
    `, [userId]);

    const problems = progressRes.rows;
    const total = problems.length;
    const solved = problems.filter(p => p.status === 'Solved' || p.status === 'Mastered');
    
    // Evaluate struggle on Medium difficulty
    const mediumAttempted = problems.filter(p => p.difficulty === 'Medium' && p.status !== 'Todo');
    const mediumSolvedClean = mediumAttempted.filter(p => p.status === 'Solved' || p.status === 'Mastered');
    const mediumHintSolved = mediumAttempted.filter(p => p.status === 'Hint-solved');
    
    const isStrugglingInMedium = mediumAttempted.length >= 2 && 
        (mediumHintSolved.length / mediumAttempted.length >= 0.35 || mediumSolvedClean.length / mediumAttempted.length < 0.45);

    // Revisions Due Schedule
    const today = new Date().toISOString().split('T')[0];
    const intervals = [1, 3, 7, 21, 60];
    const revisionsDue = problems.filter(p => {
        if (!p.solved_date || p.revisions >= 5) return false;
        const d = new Date(p.solved_date);
        d.setDate(d.getDate() + intervals[Math.min(p.revisions, 4)]);
        return d.toISOString().split('T')[0] <= today;
    });

    let recommendedQueue = [];
    let coachTrackStatus = "On Track";
    let adaptationReason = "Pacing optimal. Advance through core curriculum.";

    if (isStrugglingInMedium) {
        coachTrackStatus = "Pacing Adapted: Easy Stepping-Stone Mode";
        adaptationReason = "Struggle detected on Medium problems. Difficulty automatically scaled down to Easy foundational patterns.";
        recommendedQueue = problems.filter(p => p.difficulty === 'Easy' && p.status === 'Todo').slice(0, 3);
    } else {
        recommendedQueue = problems.filter(p => p.status === 'Todo' && p.priority === 'P1').slice(0, 3);
        if (recommendedQueue.length < 3) {
            recommendedQueue = problems.filter(p => p.status === 'Todo').slice(0, 3);
        }
    }

    let aiFeedback = `Completed ${solved.length}/${total} problems.${adaptationReason}`;
    
    if (process.env.GEMINI_API_KEY) {
        try {
            const prompt = `You are a competitive programming coach. User stats: ${solved.length}/${total} solved. Current Track: ${coachTrackStatus}. Write a 2-sentence coaching directive for today.`;
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
            isStrugglingInMedium,
            trackStatus: coachTrackStatus,
            adaptationReason
        },
        aiFeedback,
        revisionsDue: revisionsDue.slice(0, 5),
        recommendedQueue
    };
}

// Send Email Helper Function
async function sendCoachingEmail(user, insights, isAutoTrigger = false) {
    if (!process.env.RESEND_API_KEY || !resend) return false;

    const subject = isAutoTrigger 
        ? `⚠️ AI Coach Alert: Track Auto-Adjusted & Revision Plan`
        : `🎯 Today's DSA Coaching Plan (${new Date().toLocaleDateString()})`;

    await resend.emails.send({
        from: 'DSA AI Coach <onboarding@resend.dev>',
        to: user.email,
        subject: subject,
        html: `
            <div style="font-family: Arial, sans-serif; background: #09090b; color: #f4f4f5; padding: 24px; border-radius: 12px;">
                <h2 style="color: #10b981;">DSA AI Coach ${isAutoTrigger ? 'Auto-Trigger Briefing' : 'Daily Briefing'}</h2>
                <p>Hi <strong>${user.name}</strong>,</p>
                <p style="background: #18181b; padding: 12px; border-left: 4px solid #10b981; border-radius: 6px;">${insights.aiFeedback}</p>
                
                <h3 style="color: #06b6d4;">Track Status: ${insights.summary.trackStatus}</h3>
                <p style="color: #a1a1aa;">${insights.summary.adaptationReason}</p>

                <h4 style="color: #f59e0b;">1. Revisions Due Today (${insights.revisionsDue.length})</h4>
                <ul>
                    ${insights.revisionsDue.map(r => `<li><strong>${r.name}</strong> (${r.topic}) - Rev${r.revisions}/5</li>`).join('') || '<li>No revisions due today! 🎉</li>'}
                </ul>

                <h4 style="color: #6366f1;">2. Recommended Next Problems</h4>
                <ul>
                    ${insights.recommendedQueue.map(p => `<li><a href="${p.url}" style="color: #38bdf8; text-decoration: none;"><strong>${p.name}</strong></a> (${p.difficulty})</li>`).join('')}
                </ul>
            </div>
        `
    });
    return true;
}

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

// --- PROGRESS & NOTES APIS ---
app.get('/api/problems', authenticateToken, async (req, res) => {
    try {
        const query = `
            SELECT p.*, 
                   COALESCE(up.status, 'Todo') as status,
                   up.solved_date,
                   COALESCE(up.revisions, 0) as revisions,
                   up.pattern_notes
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
            ORDER BY p.id ASC
        `;
        const result = await pool.query(query, [req.user.userId]);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Update status/revisions
app.put('/api/progress/:problemId', authenticateToken, async (req, res) => {
    try {
        const status = req.body.status || 'Todo';
        const solved_date = req.body.solved_date || null;
        const revisions = req.body.revisions != null ? req.body.revisions : 0;
        const pattern_notes = req.body.pattern_notes != null ? req.body.pattern_notes : '';

        await pool.query(`
            INSERT INTO user_progress (user_id, problem_id, status, solved_date, revisions, pattern_notes, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, problem_id) DO UPDATE SET
                status = EXCLUDED.status,
                solved_date = EXCLUDED.solved_date,
                revisions = EXCLUDED.revisions,
                pattern_notes = EXCLUDED.pattern_notes,
                updated_at = CURRENT_TIMESTAMP
        `, [req.user.userId, req.params.problemId, status, solved_date, revisions, pattern_notes]);

        const insights = await analyzeUserPerformanceAndAdapt(req.user.userId);
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

// Dedicated Notes Endpoint
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

app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const summaryRes = await pool.query(`
            SELECT 
                COUNT(p.id)::int as total,
                SUM(CASE WHEN up.status IN ('Solved', 'Mastered') THEN 1 ELSE 0 END)::int as solved,
                SUM(CASE WHEN up.revisions >= 5 OR up.status = 'Mastered' THEN 1 ELSE 0 END)::int as mastered
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
        `, [req.user.userId]);

        const topicsRes = await pool.query(`
            SELECT 
                p.topic,
                COUNT(p.id)::int as total,
                SUM(CASE WHEN up.status IN ('Solved', 'Mastered') THEN 1 ELSE 0 END)::int as solved
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
            GROUP BY p.topic
            ORDER BY p.topic ASC
        `, [req.user.userId]);

        res.json({ summary: summaryRes.rows[0] || {}, topics: topicsRes.rows || [] });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/roadmap', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`SELECT * FROM roadmap ORDER BY week ASC`);
        res.json(result.rows || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- AI COACH APIS ---
app.get('/api/coach/insights', authenticateToken, async (req, res) => {
    try {
        const insights = await analyzeUserPerformanceAndAdapt(req.user.userId);
        res.json(insights);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/coach/ask', authenticateToken, async (req, res) => {
    try {
        const { question } = req.body;
        if (!question) return res.status(400).json({ error: "Question required" });

        const insights = await analyzeUserPerformanceAndAdapt(req.user.userId);
        if (!process.env.GEMINI_API_KEY) {
            return res.json({ answer: "⚠️ GEMINI_API_KEY missing in environment variables." });
        }

        try {
            const prompt = `You are an elite DSA coach. User progress: ${insights.summary.solvedCount}/${insights.summary.total} solved. Current Track: ${insights.summary.trackStatus}.
User Question: "${question}"
Provide a clear, encouraging 2-3 sentence response.`;

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

        const insights = await analyzeUserPerformanceAndAdapt(req.user.userId);
        const sent = await sendCoachingEmail(user, insights, false);

        if (sent) {
            res.json({ success: true, message: `Coaching email sent to ${user.email}!` });
        } else {
            res.json({ success: false, message: "RESEND_API_KEY missing in environment variables." });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Automated Cron Endpoints
app.get('/api/cron/daily-briefing', async (req, res) => {
    const today = new Date().toISOString().split('T')[0];
    try {
        const usersRes = await pool.query(`SELECT id, name, email, last_email_date FROM users`);
        let emailsSent = 0;

        for (const user of usersRes.rows) {
            if (user.last_email_date !== today) {
                const insights = await analyzeUserPerformanceAndAdapt(user.id);
                if (insights.revisionsDue.length > 0 || insights.recommendedQueue.length > 0) {
                    const sent = await sendCoachingEmail(user, insights, false);
                    if (sent) {
                        await pool.query(`UPDATE users SET last_email_date = $1 WHERE id = $2`, [today, user.id]);
                        emailsSent++;
                    }
                }
            }
        }
        res.json({ success: true, message: `Automated run complete. ${emailsSent} emails dispatched.`, date: today });
    } catch (err) {
        console.error("Cron endpoint error:", err);
        res.status(500).json({ error: err.message });
    }
});

cron.schedule('0 8 * * *', async () => {
    try {
        const today = new Date().toISOString().split('T')[0];
        const usersRes = await pool.query(`SELECT id, name, email, last_email_date FROM users`);
        for (const user of usersRes.rows) {
            if (user.last_email_date !== today) {
                const insights = await analyzeUserPerformanceAndAdapt(user.id);
                if (insights.revisionsDue.length > 0 || insights.recommendedQueue.length > 0) {
                    const sent = await sendCoachingEmail(user, insights, false);
                    if (sent) {
                        await pool.query(`UPDATE users SET last_email_date = $1 WHERE id = $2`, [today, user.id]);
                    }
                }
            }
        }
    } catch (e) {
        console.error('Internal cron error:', e.message);
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));