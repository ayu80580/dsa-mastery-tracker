const { Pool } = require('pg');
const XLSX = require('xlsx');
const path = require('path');

const excelPath = path.join(__dirname, 'DSA_Mastery_Tracker.xlsx');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function seed() {
    console.log('Connecting to PostgreSQL & reading Excel...');
    const workbook = XLSX.readFile(excelPath);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS problems (
            id INT PRIMARY KEY,
            week INT,
            topic TEXT,
            name TEXT,
            difficulty TEXT,
            priority TEXT
        );
        CREATE TABLE IF NOT EXISTS roadmap (
            week INT PRIMARY KEY,
            phase TEXT,
            topic TEXT,
            patterns TEXT,
            goal TEXT
        );
    `);

    // Seed Problems
    const problemsSheet = workbook.Sheets['Problems'];
    const problemsData = XLSX.utils.sheet_to_json(problemsSheet);

    for (const row of problemsData) {
        if (row['#'] && row['Problem (click to open)']) {
            await pool.query(
                `INSERT INTO problems (id, week, topic, name, difficulty, priority)
                 VALUES ($1, $2, $3, $4, $5, $6)
                 ON CONFLICT (id) DO UPDATE SET
                    week = EXCLUDED.week,
                    topic = EXCLUDED.topic,
                    name = EXCLUDED.name,
                    difficulty = EXCLUDED.difficulty,
                    priority = EXCLUDED.priority`,
                [
                    row['#'],
                    row['Week'] || 1,
                    row['Topic'] || 'General',
                    row['Problem (click to open)'],
                    row['Difficulty'] || 'Easy',
                    row['Priority'] || 'P2'
                ]
            );
        }
    }

    // Seed Roadmap
    const roadmapSheet = workbook.Sheets['Roadmap'];
    const roadmapData = XLSX.utils.sheet_to_json(roadmapSheet);

    for (const row of roadmapData) {
        if (row['Week'] !== undefined) {
            await pool.query(
                `INSERT INTO roadmap (week, phase, topic, patterns, goal)
                 VALUES ($1, $2, $3, $4, $5)
                 ON CONFLICT (week) DO UPDATE SET
                    phase = EXCLUDED.phase,
                    topic = EXCLUDED.topic,
                    patterns = EXCLUDED.patterns,
                    goal = EXCLUDED.goal`,
                [
                    row['Week'],
                    row['Phase'] || '',
                    row['Focus topic'] || '',
                    row['Patterns to own'] || '',
                    row['Checkpoint / contest goal'] || ''
                ]
            );
        }
    }

    console.log('PostgreSQL database successfully seeded!');
    await pool.end();
}

seed().catch(err => {
    console.error('Seeding error:', err);
    process.exit(1);
});