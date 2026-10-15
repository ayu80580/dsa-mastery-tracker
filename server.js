const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const cron = require('node-cron');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'dsa_tracker_secret_2026';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Initialize Free Gemini AI Client
const genAI = process.env.GEMINI_API_KEY ? new GoogleGenerativeAI(process.env.GEMINI_API_KEY) : null;

// Initialize Free Nodemailer Transporter (Gmail App Password or Resend)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

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
        `);
        console.log('Database schema ready with AI Coach support.');
    } catch (err) {
        console.error('Database init error:', err);
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

// --- ADAPTIVE AI COACH ENGINE ---
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
    const hintSolved = problems.filter(p => p.status === 'Hint-solved');
    
    // Performance Metrics
    const mediumAttempted = problems.filter(p => p.difficulty === 'Medium' && p.status !== 'Todo');
    const mediumSolvedClean = mediumAttempted.filter(p => p.status === 'Solved' || p.status === 'Mastered');
    const mediumHintSolved = mediumAttempted.filter(p => p.status === 'Hint-solved');
    
    const isStrugglingInMedium = mediumAttempted.length >= 2 && 
        (mediumHintSolved.length / mediumAttempted.length >= 0.35 || mediumSolvedClean.length / mediumAttempted.length < 0.45);

    // Revisions Due Today
    const today = new Date().toISOString().split('T')[0];
    const intervals = [1, 3, 7, 21, 60];
    const revisionsDue = problems.filter(p => {
        if (!p.solved_date || p.revisions >= 5) return false;
        const d = new Date(p.solved_date);
        d.setDate(d.getDate() + intervals[Math.min(p.revisions, 4)]);
        return d.toISOString().split('T')[0] <= today;
    });

    // Adaptive Problem Queue Generation
    let recommendedQueue = [];
    let coachTrackStatus = "On Track";
    let adaptationReason = "Your current pacing is optimal. Continue with standard curriculum progression.";

    if (isStrugglingInMedium) {
        coachTrackStatus = "Pacing Adapted: Easy Stepping-Stone Mode";
        adaptationReason = "Detected struggle/hints on Medium problems. Automatically reduced recommendation difficulty to Easy foundational patterns to build confidence before advancing.";
        
        // Priority 1: Unsolved Easy problems in active topics
        recommendedQueue = problems.filter(p => p.difficulty === 'Easy' && p.status === 'Todo').slice(0, 3);
    } else {
        // Standard queue: Unsolved P1 problems
        recommendedQueue = problems.filter(p => p.status === 'Todo' && p.priority === 'P1').slice(0, 3);
        if (recommendedQueue.length < 3) {
            recommendedQueue = problems.filter(p => p.status === 'Todo').slice(0, 3);
        }
    }

    // AI Dynamic Feedback Generation (Gemini 1.5 Flash Free)
    let aiFeedback = `You have completed ${solved.length}/${total} problems (${Math.round((solved.length/total)*100)}%). ${adaptationReason}`;
    
    if (genAI) {
        try {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `You are an elite, encouraging competitive programming and DSA Coach. 
            User Stats:
            - Total Problems Solved: ${solved.length}/${total}
            - Medium Problems Attempted: ${mediumAttempted.length}
            - Medium Problems Solved Without Hints: ${mediumSolvedClean.length}
            - Medium Problems Needing Hints: ${mediumHintSolved.length}
            - Struggling in Medium: ${isStrugglingInMedium}
            - Revisions Due Today: ${revisionsDue.length}
            
            Write a concise 2-sentence coaching directive for today. Tell them exactly what pattern to focus on and why their difficulty was set to ${coachTrackStatus}.`;

            const result = await model.generateContent(prompt);
            const responseText = result.response.text();
            if (responseText) aiFeedback = responseText.trim();
        } catch (e) {
            console.warn("Gemini AI API call fallback:", e.message);
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

// --- COACH API ENDPOINTS ---
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
        let answer = "Remember: Master 1 pattern at a time, write clean code, and re-solve problems from a blank editor without looking at hints.";

        if (genAI) {
            const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
            const prompt = `You are a friendly DSA coach. User Progress: ${insights.summary.solvedCount}/${insights.summary.total} solved. Current Track: ${insights.summary.trackStatus}.
            User Question: "${question}"
            Provide a helpful, actionable 3-sentence response.`;

            const result = await model.generateContent(prompt);
            answer = result.response.text().trim();
        }

        res.json({ answer });
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
        
        const mailOptions = {
            from: `"DSA AI Coach" <${process.env.EMAIL_USER || 'coach@dsa-tracker.com'}>`,
            to: user.email,
            subject: `🎯 Today's DSA Coaching Plan & Revisions (${new Date().toLocaleDateString()})`,
            html: `
                <div style="font-family: Arial, sans-serif; background-color: #09090b; color: #f4f4f5; padding: 24px; border-radius: 16px;">
                    <h2 style="color: #10b981;">DSA AI Coach Daily Briefing</h2>
                    <p>Hi <strong>${user.name}</strong>,</p>
                    <p style="background: #18181b; padding: 12px; border-left: 4px solid #10b981; border-radius: 8px;">${insights.aiFeedback}</p>
                    
                    <h3>Status: <span style="color: #06b6d4;">${insights.summary.trackStatus}</span></h3>
                    <p>${insights.summary.adaptationReason}</p>

                    <h4 style="color: #f59e0b;">1. Revisions Due Today (${insights.revisionsDue.length})</h4>
                    <ul>
                        ${insights.revisionsDue.map(r => `<li><strong>${r.name}</strong> (${r.topic}) - Rev ${r.revisions}/5</li>`).join('') || '<li>No revisions due today! 🎉</li>'}
                    </ul>

                    <h4 style="color: #6366f1;">2. Recommended Next Problems</h4>
                    <ul>
                        ${insights.recommendedQueue.map(p => `<li><a href="${p.url}" style="color: #38bdf8; text-decoration: none;"><strong>${p.name}</strong></a> (${p.difficulty} - ${p.topic})</li>`).join('')}
                    </ul>

                    <p style="margin-top: 24px; font-size: 12px; color: #71717a;">Keep pushing forward! One problem a day builds mastery.</p>
                </div>
            `
        };

        if (process.env.EMAIL_USER && process.env.EMAIL_PASS) {
            await transporter.sendMail(mailOptions);
            res.json({ success: true, message: `Coaching email sent to ${user.email}!` });
        } else {
            res.json({ success: true, message: "Email simulation successful! (Set EMAIL_USER and EMAIL_PASS in Render environment variables to send live emails)." });
        }
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- DAILY AUTOMATED CRON SCHEDULER (Runs every day at 8:00 AM) ---
cron.schedule('0 8 * * *', async () => {
    console.log('Running daily 8:00 AM AI Coach Email Dispatch...');
    if (!process.env.EMAIL_USER || !process.env.EMAIL_PASS) return;

    try {
        const usersRes = await pool.query(`SELECT id, name, email FROM users`);
        for (const user of usersRes.rows) {
            const insights = await analyzeUserPerformanceAndAdapt(user.id);
            if (insights.revisionsDue.length > 0 || insights.recommendedQueue.length > 0) {
                await transporter.sendMail({
                    from: `"DSA AI Coach" <${process.env.EMAIL_USER}>`,
                    to: user.email,
                    subject: `⏰ Daily DSA Practice Reminder & Revision Schedule`,
                    html: `<p>Hi ${user.name}, your AI Coach has prepared today's plan: ${insights.aiFeedback}</p>`
                });
            }
        }
    } catch (e) {
        console.error('Cron dispatch error:', e.message);
    }
});

// Standard APIs
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

app.put('/api/progress/:problemId', authenticateToken, async (req, res) => {
    try {
        const { status, solved_date, revisions, pattern_notes } = req.body;
        const query = `
            INSERT INTO user_progress (user_id, problem_id, status, solved_date, revisions, pattern_notes, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, CURRENT_TIMESTAMP)
            ON CONFLICT (user_id, problem_id) DO UPDATE SET
                status = EXCLUDED.status,
                solved_date = EXCLUDED.solved_date,
                revisions = EXCLUDED.revisions,
                pattern_notes = EXCLUDED.pattern_notes,
                updated_at = CURRENT_TIMESTAMP
        `;
        await pool.query(query, [req.user.userId, req.params.problemId, status, solved_date, revisions || 0, pattern_notes]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/dashboard', authenticateToken, async (req, res) => {
    try {
        const summaryQuery = `
            SELECT 
                COUNT(p.id)::int as total,
                SUM(CASE WHEN up.status IN ('Solved', 'Mastered') THEN 1 ELSE 0 END)::int as solved,
                SUM(CASE WHEN up.revisions >= 5 OR up.status = 'Mastered' THEN 1 ELSE 0 END)::int as mastered
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
        `;

        const topicQuery = `
            SELECT 
                p.topic,
                COUNT(p.id)::int as total,
                SUM(CASE WHEN up.status IN ('Solved', 'Mastered') THEN 1 ELSE 0 END)::int as solved
            FROM problems p
            LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = $1
            GROUP BY p.topic
            ORDER BY p.topic ASC
        `;

        const summaryRes = await pool.query(summaryQuery, [req.user.userId]);
        const topicsRes = await pool.query(topicQuery, [req.user.userId]);

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));