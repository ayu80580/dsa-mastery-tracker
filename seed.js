const { Pool } = require('pg');
const XLSX = require('xlsx');
const path = require('path');

const excelPath = path.join(__dirname, 'DSA_Mastery_Tracker.xlsx');
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function seed() {
    console.log('Connecting to PostgreSQL & parsing Excel with hyperlinks...');
    const workbook = XLSX.readFile(excelPath, { cellDates: true, cellStyles: true });

    await pool.query(`
        CREATE TABLE IF NOT EXISTS problems (
            id INT PRIMARY KEY,
            week INT,
            topic TEXT,
            name TEXT,
            difficulty TEXT,
            priority TEXT,
            url TEXT
        );
        CREATE TABLE IF NOT EXISTS roadmap (
            week INT PRIMARY KEY,
            phase TEXT,
            topic TEXT,
            patterns TEXT,
            goal TEXT
        );
    `);

    const problemsSheet = workbook.Sheets['Problems'];
    const range = XLSX.utils.decode_range(problemsSheet['!ref']);

    // Iterate through sheet rows to extract values and hyperlinks
    for (let r = range.s.r + 1; r <= range.e.r; r++) {
        const idCell = problemsSheet[XLSX.utils.encode_cell({ r: r, c: 0 })];   // Col A: #
        const weekCell = problemsSheet[XLSX.utils.encode_cell({ r: r, c: 1 })]; // Col B: Week
        const topicCell = problemsSheet[XLSX.utils.encode_cell({ r: r, c: 2 })];// Col C: Topic
        const nameCell = problemsSheet[XLSX.utils.encode_cell({ r: r, c: 3 })]; // Col D: Problem (click to open)
        const diffCell = problemsSheet[XLSX.utils.encode_cell({ r: r, c: 4 })]; // Col E: Difficulty
        const prioCell = problemsSheet[XLSX.utils.encode_cell({ r: r, c: 5 })]; // Col F: Priority

        if (idCell && idCell.v && nameCell && nameCell.v) {
            const id = parseInt(idCell.v);
            const week = weekCell ? parseInt(weekCell.v) : 1;
            const topic = topicCell ? String(topicCell.v) : 'General';
            const name = String(nameCell.v);
            const difficulty = diffCell ? String(diffCell.v) : 'Easy';
            const priority = prioCell ? String(prioCell.v) : 'P2';

            // Extract hyperlink target target URL
            let url = '';
            if (nameCell.l && nameCell.l.Target) {
                url = nameCell.l.Target;
            } else {
                const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                url = `https://leetcode.com/problems/${slug}/`;
            }

            await pool.query(
                `INSERT INTO problems (id, week, topic, name, difficulty, priority, url)
                 VALUES ($1, $2, $3, $4, $5, $6, $7)
                 ON CONFLICT (id) DO UPDATE SET
                    week = EXCLUDED.week,
                    topic = EXCLUDED.topic,
                    name = EXCLUDED.name,
                    difficulty = EXCLUDED.difficulty,
                    priority = EXCLUDED.priority,
                    url = EXCLUDED.url`,
                [id, week, topic, name, difficulty, priority, url]
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

    console.log('PostgreSQL database successfully seeded with all LeetCode URLs!');
    await pool.end();
}

seed().catch(err => {
    console.error('Seeding error:', err);
    process.exit(1);
});