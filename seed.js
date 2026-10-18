const { Pool } = require('pg');
const XLSX = require('xlsx');
const path = require('path');
const fs = require('fs');

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function seedTierFile(filePath, tierName) {
    if (!fs.existsSync(filePath)) {
        console.log(`ℹ️ File ${path.basename(filePath)} not found. Tier '${tierName}' remains in BETA/Coming Soon.`);
        return;
    }

    console.log(`⚡ Seeding tier '${tierName}' from ${path.basename(filePath)}...`);
    const workbook = XLSX.readFile(filePath, { cellDates: true, cellStyles: true });

    for (const sheetName of workbook.SheetNames) {
        const sheet = workbook.Sheets[sheetName];
        const range = XLSX.utils.decode_range(sheet['!ref']);

        for (let r = range.s.r + 1; r <= range.e.r; r++) {
            const idCell = sheet[XLSX.utils.encode_cell({ r, c: 0 })];
            const weekCell = sheet[XLSX.utils.encode_cell({ r, c: 1 })];
            const topicCell = sheet[XLSX.utils.encode_cell({ r, c: 2 })];
            const nameCell = sheet[XLSX.utils.encode_cell({ r, c: 3 })];
            const diffCell = sheet[XLSX.utils.encode_cell({ r, c: 4 })];
            const prioCell = sheet[XLSX.utils.encode_cell({ r, c: 5 })];

            if (idCell && idCell.v && nameCell && nameCell.v) {
                const id = parseInt(idCell.v);
                const week = weekCell ? parseInt(weekCell.v) : 1;
                const topic = topicCell ? String(topicCell.v) : 'General';
                const name = String(nameCell.v);
                const difficulty = diffCell ? String(diffCell.v) : 'Easy';
                const priority = prioCell ? String(prioCell.v) : 'P2';

                let url = '';
                if (nameCell.l && nameCell.l.Target) {
                    url = nameCell.l.Target;
                } else {
                    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
                    url = `https://leetcode.com/problems/${slug}/`;
                }

                await pool.query(
                    `INSERT INTO problems (id, tier, week, topic, name, difficulty, priority, url)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT (id) DO UPDATE SET
                        tier = EXCLUDED.tier,
                        week = EXCLUDED.week,
                        topic = EXCLUDED.topic,
                        name = EXCLUDED.name,
                        difficulty = EXCLUDED.difficulty,
                        priority = EXCLUDED.priority,
                        url = EXCLUDED.url`,
                    [id, tierName, week, topic, name, difficulty, priority, url]
                );
            }
        }
    }
    console.log(`✅ Successfully loaded tier '${tierName}'!`);
}

async function seedAll() {
    await pool.query(`
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
    `);

    // Check single workbook with sheets OR individual tier files
    const mainExcel = path.join(__dirname, 'DSA_Mastery_Tracker.xlsx');
    if (fs.existsSync(mainExcel)) {
        console.log("Found unified workbook: DSA_Mastery_Tracker.xlsx");
        const workbook = XLSX.readFile(mainExcel, { cellDates: true, cellStyles: true });
        
        for (const sheetName of workbook.SheetNames) {
            let tier = 'Beginner';
            if (sheetName.toLowerCase().includes('inter')) tier = 'Intermediate';
            if (sheetName.toLowerCase().includes('master')) tier = 'Mastery';
            await seedTierFile(mainExcel, tier);
        }
    } else {
        await seedTierFile(path.join(__dirname, 'Roadmap_Beginner.xlsx'), 'Beginner');
        await seedTierFile(path.join(__dirname, 'Roadmap_Intermediate.xlsx'), 'Intermediate');
        await seedTierFile(path.join(__dirname, 'Roadmap_Mastery.xlsx'), 'Mastery');
    }

    await pool.end();
}

seedAll().catch(err => {
    console.error('Seeding error:', err);
    process.exit(1);
});