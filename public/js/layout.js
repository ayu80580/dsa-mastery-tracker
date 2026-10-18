// 1. EXPOSE GLOBAL FUNCTIONS
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

    // 2. INJECT FAVICON DATA URI IF MISSING
    if (!document.querySelector("link[rel*='icon']")) {
        const favicon = document.createElement('link');
        favicon.rel = 'icon';
        favicon.type = 'image/svg+xml';
        favicon.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2310b981' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polygon points='12 2 2 7 12 12 22 7 12 2'/><polyline points='2 17 12 22 22 17'/><polyline points='2 12 12 17 22 12'/></svg>";
        head.appendChild(favicon);
    }

    // 3. INITIALIZE SAVED THEME INSTANTLY
    const savedTheme = localStorage.getItem('dsa_theme') || 'dark';
    if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    // 4. GLOBAL THEME CSS OVERRIDES
    const style = document.createElement('style');
    style.textContent = `
        html.dark body { background-color: #09090b !important; color: #f4f4f5 !important; }
        html.dark .glass-card { background: rgba(24, 24, 27, 0.75) !important; backdrop-filter: blur(16px); border-color: rgba(255, 255, 255, 0.08) !important; }
        
        html:not(.dark) body { background-color: #f8fafc !important; color: #0f172a !important; }
        html:not(.dark) .glass-card { background: rgba(255, 255, 255, 0.9) !important; backdrop-filter: blur(16px); border-color: rgba(226, 232, 240, 0.9) !important; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05); }
        html:not(.dark) table thead { background-color: #f1f5f9 !important; color: #475569 !important; }
        html:not(.dark) table tbody tr { border-color: #e2e8f0 !important; }
        html:not(.dark) table tbody tr:hover { background-color: #f1f5f9 !important; }
        html:not(.dark) select, html:not(.dark) input, html:not(.dark) textarea { background-color: #ffffff !important; color: #0f172a !important; border-color: #cbd5e1 !important; }
    `;
    head.appendChild(style);
})();