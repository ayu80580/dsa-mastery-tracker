const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'dsa_tracker_secret_2026';

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
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
        console.log('Database tables verified.');
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

// Auth APIs
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

// Get Problems & User Progress
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

// Dashboard Analytics
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