(function () {
    // 1. INJECT FAVICON, FONTS & TAILWIND STYLES TO HEAD
    const head = document.head;

    // Favicon SVG Data URI
    if (!document.querySelector("link[rel*='icon']")) {
        const favicon = document.createElement('link');
        favicon.rel = 'icon';
        favicon.type = 'image/svg+xml';
        favicon.href = "data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%2310b981' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polygon points='12 2 2 7 12 12 22 7 12 2'/><polyline points='2 17 12 22 22 17'/><polyline points='2 12 12 17 22 12'/></svg>";
        head.appendChild(favicon);
    }

    // Initialize Saved Theme (Prevents White Flashes)
    const savedTheme = localStorage.getItem('dsa_theme') || 'dark';
    if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }

    // Global Styles (Dark & Light Overrides)
    const style = document.createElement('style');
    style.textContent = `
        html.dark body { background-color: #09090b; color: #f4f4f5; }
        html.dark .glass-card { background: rgba(24, 24, 27, 0.75); backdrop-filter: blur(16px); border: 1px solid rgba(255, 255, 255, 0.08); }
        html:not(.dark) body { background-color: #f8fafc; color: #0f172a; }
        html:not(.dark) .glass-card { background: rgba(255, 255, 255, 0.9); backdrop-filter: blur(16px); border: 1px solid rgba(226, 232, 240, 0.9); box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05); }
        html:not(.dark) table thead { background-color: #f1f5f9 !important; color: #475569 !important; }
        html:not(.dark) table tbody tr { border-color: #e2e8f0 !important; }
        html:not(.dark) table tbody tr:hover { background-color: #f1f5f9 !important; }
        html:not(.dark) select, html:not(.dark) input { background-color: #ffffff !important; color: #0f172a !important; border-color: #cbd5e1 !important; }
    `;
    head.appendChild(style);

    // 2. RENDER COMMON NAVIGATION BAR ON DOM CONTENT LOAD
    window.addEventListener('DOMContentLoaded', () => {
        const navContainer = document.getElementById('app-nav');
        if (!navContainer) return;

        const currentPath = window.location.pathname;

        const navLinks = [
            { name: 'Dashboard', path: '/dashboard' },
            { name: 'Roadmaps', path: '/roadmaps' },
            { name: 'Problems', path: '/problems' },
            { name: 'Kanban', path: '/kanban' },
            { name: 'Analytics', path: '/analytics' },
            { name: 'AI Mentor', path: '/ai-coach' }
        ];

        const linksHTML = navLinks.map(link => {
            const isActive = currentPath === link.path || (currentPath === '/' && link.path === '/dashboard');
            const activeClass = isActive 
                ? 'text-emerald-500 border-b-2 border-emerald-500 pb-1 font-bold' 
                : 'hover:text-emerald-500 transition font-medium';
            return `<a href="${link.path}" class="${activeClass}">${link.name}</a>`;
        }).join('');

        navContainer.className = "sticky top-0 z-50 glass-card border-b border-slate-200 dark:border-obsidian-800 px-6 py-3.5 flex items-center justify-between";
        navContainer.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="p-2 bg-emerald-500/10 text-emerald-500 rounded-xl border border-emerald-500/20">
                    <i data-lucide="layers" class="w-5 h-5"></i>
                </div>
                <span class="font-black text-lg tracking-wide text-slate-900 dark:text-white">DSA ENGINE</span>
            </div>

            <div class="flex items-center gap-6 text-xs text-slate-500 dark:text-slate-400">
                ${linksHTML}
            </div>

            <div class="flex items-center gap-3">
                <!-- Theme Switcher Button -->
                <button onclick="window.toggleTheme()" class="p-2 bg-slate-200 dark:bg-obsidian-900 text-slate-700 dark:text-slate-300 rounded-xl border border-slate-300 dark:border-obsidian-800 hover:scale-105 transition flex items-center justify-center" title="Toggle Mode">
                    <i data-lucide="sun" class="w-4 h-4 text-amber-500 hidden dark:block"></i>
                    <i data-lucide="moon" class="w-4 h-4 text-indigo-600 block dark:hidden"></i>
                </button>

                <!-- Logout Button -->
                <button onclick="window.logout()" class="px-3 py-1.5 bg-slate-200 dark:bg-obsidian-900 text-slate-700 dark:text-slate-400 rounded-xl border border-slate-300 dark:border-obsidian-800 hover:text-slate-900 dark:hover:text-white text-xs font-bold">Logout</button>
            </div>
        `;

        if (window.lucide) lucide.createIcons();
    });
})();

// Global Functions Exposed to Window
window.toggleTheme = function () {
    const isDark = document.documentElement.classList.toggle('dark');
    localStorage.setItem('dsa_theme', isDark ? 'dark' : 'light');
    if (window.lucide) lucide.createIcons();
};

window.logout = function () {
    localStorage.removeItem('dsa_jwt');
    window.location.href = '/';
};