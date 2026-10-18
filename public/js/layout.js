// 1. GLOBAL THEME TOGGLE & LOGOUT
window.toggleTheme = function () {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('dsa_theme', isDark ? 'dark' : 'light');
    if (window.lucide && typeof lucide.createIcons === 'function') {
        lucide.createIcons();
    }
};

window.logout = function () {
    localStorage.removeItem('dsa_jwt');
    window.location.href = '/';
};

(function () {
    const head = document.head;

    // 2. FAVICON INJECTION
    if (!document.querySelector("link[rel*='icon']")) {
        const favicon = document.createElement('link');
        favicon.rel = 'icon';
        favicon.type = 'image/svg+xml';
        favicon.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2310b981' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polygon points='12 2 2 7 12 12 22 7 12 2'/><polyline points='2 17 12 22 22 17'/><polyline points='2 12 12 17 22 12'/></svg>";
        head.appendChild(favicon);
    }

    // 3. INITIALIZE SAVED THEME (DEFAULT TO DARK)
    const savedTheme = localStorage.getItem('dsa_theme') || 'dark';
    if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    // 4. GLOBAL DUAL-THEME CSS RECOLOR ENGINE
    const style = document.createElement('style');
    style.textContent = `
        /* --- DARK MODE RULES --- */
        html.dark body { background-color: #09090b !important; color: #f4f4f5 !important; }
        html.dark .glass-card { background: rgba(24, 24, 27, 0.75) !important; backdrop-filter: blur(16px); border-color: rgba(255, 255, 255, 0.08) !important; }
        html.dark table thead { background-color: #121215 !important; color: #a1a1aa !important; }
        html.dark table tbody tr:hover { background-color: rgba(18, 18, 21, 0.5) !important; }

        /* --- LIGHT MODE RECOLOR OVERRIDES --- */
        html:not(.dark) body { background-color: #f8fafc !important; color: #0f172a !important; }
        
        /* Background Overrides */
        html:not(.dark) .bg-obsidian-950,
        html:not(.dark) .bg-obsidian-900,
        html:not(.dark) .bg-obsidian-850 { background-color: #ffffff !important; }
        html:not(.dark) .bg-obsidian-800 { background-color: #f1f5f9 !important; }
        
        /* Text Color Overrides */
        html:not(.dark) .text-white,
        html:not(.dark) .text-slate-100,
        html:not(.dark) .text-slate-200 { color: #0f172a !important; }
        html:not(.dark) .text-slate-400,
        html:not(.dark) .text-slate-500 { color: #64748b !important; }
        
        /* Border Overrides */
        html:not(.dark) .border-obsidian-800,
        html:not(.dark) .border-obsidian-900 { border-color: #e2e8f0 !important; }
        
        /* Card & Input Overrides */
        html:not(.dark) .glass-card { 
            background: rgba(255, 255, 255, 0.95) !important; 
            backdrop-filter: blur(16px); 
            border-color: #e2e8f0 !important; 
            box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05) !important; 
        }
        html:not(.dark) select, 
        html:not(.dark) input, 
        html:not(.dark) textarea { 
            background-color: #ffffff !important; 
            color: #0f172a !important; 
            border-color: #cbd5e1 !important; 
        }
        html:not(.dark) table thead { background-color: #f1f5f9 !important; color: #475569 !important; }
        html:not(.dark) table tbody tr:hover { background-color: #f8fafc !important; }
    `;
    head.appendChild(style);
})();