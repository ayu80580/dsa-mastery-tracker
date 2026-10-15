const sqlite3 = require('sqlite3').verbose();
const XLSX = require('xlsx');
const path = require('path');

const dbPath = path.join(__dirname, 'dsa_tracker.db');
const excelPath = path.join(__dirname, 'DSA_Mastery_Tracker.xlsx');

const db = new sqlite3.Database(dbPath);

console.log('Reading Excel file...');
const workbook = XLSX.readFile(excelPath);

db.serialize(() => {
    // Create Tables
    db.run(`CREATE TABLE IF NOT EXISTS problems (
        id INTEGER PRIMARY KEY,
        week INTEGER,
        topic TEXT,
        name TEXT,
        difficulty TEXT,
        priority TEXT
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS roadmap (
        week INTEGER PRIMARY KEY,
        phase TEXT,
        topic TEXT,
        patterns TEXT,
        goal TEXT
    )`);

    // Parse Problems
    const problemsSheet = workbook.Sheets['Problems'];
    const problemsData = XLSX.utils.sheet_to_json(problemsSheet);
    
    const stmtProblem = db.prepare(`INSERT OR REPLACE INTO problems (id, week, topic, name, difficulty, priority) VALUES (?, ?, ?, ?, ?, ?)`);
    problemsData.forEach(row => {
        if (row['#'] && row['Problem (click to open)']) {
            stmtProblem.run(
                row['#'],
                row['Week'] || 1,
                row['Topic'] || 'General',
                row['Problem (click to open)'],
                row['Difficulty'] || 'Easy',
                row['Priority'] || 'P2'
            );
        }
    });
    stmtProblem.finalize();

    // Parse Roadmap
    const roadmapSheet = workbook.Sheets['Roadmap'];
    const roadmapData = XLSX.utils.sheet_to_json(roadmapSheet);

    const stmtRoadmap = db.prepare(`INSERT OR REPLACE INTO roadmap (week, phase, topic, patterns, goal) VALUES (?, ?, ?, ?, ?)`);
    roadmapData.forEach(row => {
        if (row['Week'] !== undefined) {
            stmtRoadmap.run(
                row['Week'],
                row['Phase'] || '',
                row['Focus topic'] || '',
                row['Patterns to own'] || '',
                row['Checkpoint / contest goal'] || ''
            );
        }
    });
    stmtRoadmap.finalize();

    console.log('Database successfully seeded from Excel!');
});