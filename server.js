const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const path = require('path');

const app = express();
const JWT_SECRET = process.env.JWT_SECRET || 'dsa_tracker_secret_2026';
const DB_PATH = path.join(__dirname, 'dsa_tracker.db');

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const db = new sqlite3.Database(DB_PATH);

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS user_progress (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        problem_id INTEGER,
        status TEXT DEFAULT 'Todo',
        solved_date TEXT,
        time_min INTEGER,
        revisions INTEGER DEFAULT 0,
        pattern_notes TEXT,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, problem_id)
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS contest_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        date TEXT,
        type TEXT,
        name TEXT,
        qs_solved INTEGER,
        rank INTEGER,
        rating INTEGER,
        mistake TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

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

// Auth API
app.post('/api/auth/signup', (req, res) => {
    const { name, email, password } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'All fields required' });

    const hash = bcrypt.hashSync(password, 10);
    db.run(`INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)`, [name, email, hash], function(err) {
        if (err) return res.status(400).json({ error: 'Email already exists' });
        const token = jwt.sign({ userId: this.lastID, name, email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: this.lastID, name, email } });
    });
});

app.post('/api/auth/login', (req, res) => {
    const { email, password } = req.body;
    db.get(`SELECT * FROM users WHERE email = ?`, [email], (err, user) => {
        if (err || !user || !bcrypt.compareSync(password, user.password_hash)) {
            return res.status(400).json({ error: 'Invalid credentials' });
        }
        const token = jwt.sign({ userId: user.id, name: user.name, email: user.email }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
    });
});

app.get('/api/auth/me', authenticateToken, (req, res) => res.json({ user: req.user }));

// Problems & Progress
app.get('/api/problems', authenticateToken, (req, res) => {
    const query = `
        SELECT p.*, 
               COALESCE(up.status, 'Todo') as status,
               up.solved_date,
               COALESCE(up.revisions, 0) as revisions,
               up.pattern_notes
        FROM problems p
        LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = ?
        ORDER BY p.id ASC
    `;
    db.all(query, [req.user.userId], (err, rows) => res.json(rows || []));
});

app.put('/api/progress/:problemId', authenticateToken, (req, res) => {
    const { status, solved_date, revisions, pattern_notes } = req.body;
    const query = `
        INSERT INTO user_progress (user_id, problem_id, status, solved_date, revisions, pattern_notes, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(user_id, problem_id) DO UPDATE SET
            status = excluded.status,
            solved_date = excluded.solved_date,
            revisions = excluded.revisions,
            pattern_notes = excluded.pattern_notes,
            updated_at = CURRENT_TIMESTAMP
    `;
    db.run(query, [req.user.userId, req.params.problemId, status, solved_date, revisions, pattern_notes], (err) => {
        res.json({ success: true });
    });
});

// Dashboard Analytics
app.get('/api/dashboard', authenticateToken, (req, res) => {
    const summaryQuery = `
        SELECT 
            COUNT(p.id) as total,
            SUM(CASE WHEN up.status IN ('Solved', 'Mastered') THEN 1 ELSE 0 END) as solved,
            SUM(CASE WHEN up.revisions >= 5 OR up.status = 'Mastered' THEN 1 ELSE 0 END) as mastered
        FROM problems p
        LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = ?
    `;

    const topicQuery = `
        SELECT 
            p.topic,
            COUNT(p.id) as total,
            SUM(CASE WHEN up.status IN ('Solved', 'Mastered') THEN 1 ELSE 0 END) as solved
        FROM problems p
        LEFT JOIN user_progress up ON p.id = up.problem_id AND up.user_id = ?
        GROUP BY p.topic
    `;

    db.get(summaryQuery, [req.user.userId], (err, summary) => {
        db.all(topicQuery, [req.user.userId], (err, topics) => {
            res.json({ summary: summary || {}, topics: topics || [] });
        });
    });
});

app.get('/api/roadmap', authenticateToken, (req, res) => {
    db.all(`SELECT * FROM roadmap ORDER BY week ASC`, [], (err, rows) => res.json(rows || []));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));