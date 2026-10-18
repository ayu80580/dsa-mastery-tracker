// 1. EXPOSE GLOBAL FUNCTIONS TO WINDOW
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

// 2. IMMEDIATE THEME INITIALIZATION (Runs as soon as script loads to prevent white flashes)
(function initTheme() {
    const savedTheme = localStorage.getItem('dsa_theme') || 'dark';
    if (savedTheme === 'dark') {
        document.documentElement.classList.add('dark');
    } else {
        document.documentElement.classList.remove('dark');
    }
})();

(function () {
    const head = document.head;

    // 2. INJECT FAVICON DATA URI
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

    // 4. INJECT THEME STYLES (DARK & LIGHT MODE OVERRIDES)
    const style = document.createElement('style');
    style.textContent = `
        html.dark body { background-color: #09090b !important; color: #f4f4f5 !important; }
        html.dark .glass-card { background: rgba(24, 24, 27, 0.75) !important; backdrop-filter: blur(16px); border-color: rgba(255, 255, 255, 0.08) !important; }
        html.dark table thead { background-color: #121215 !important; color: #a1a1aa !important; }
        html.dark table tbody tr:hover { background-color: rgba(18, 18, 21, 0.5) !important; }
        
        html:not(.dark) body { background-color: #f8fafc !important; color: #0f172a !important; }
        html:not(.dark) .glass-card { background: rgba(255, 255, 255, 0.9) !important; backdrop-filter: blur(16px); border-color: rgba(226, 232, 240, 0.9) !important; box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.05); }
        html:not(.dark) table thead { background-color: #f1f5f9 !important; color: #475569 !important; }
        html:not(.dark) table tbody tr { border-color: #e2e8f0 !important; }
        html:not(.dark) table tbody tr:hover { background-color: #f1f5f9 !important; }
        html:not(.dark) select, html:not(.dark) input, html:not(.dark) textarea { background-color: #ffffff !important; color: #0f172a !important; border-color: #cbd5e1 !important; }
    `;
    head.appendChild(style);

    // 5. NAVBAR INJECTION ENGINE (TARGETS #app-nav OR ANY <nav> TAG)
    function renderNav() {
        const navContainer = document.getElementById('app-nav') || document.querySelector('nav');
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
                ? 'text-emerald-500 dark:text-emerald-400 border-b-2 border-emerald-500 dark:border-emerald-400 pb-1 font-bold' 
                : 'hover:text-emerald-500 dark:hover:text-emerald-400 transition font-medium text-slate-600 dark:text-slate-400';
            return `<a href="${link.path}" class="${activeClass}">${link.name}</a>`;
        }).join('');

        navContainer.className = "sticky top-0 z-50 glass-card border-b border-slate-200 dark:border-obsidian-800 px-6 py-3.5 flex items-center justify-between transition-colors duration-200";
        navContainer.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="p-2 bg-emerald-500/10 text-emerald-500 rounded-xl border border-emerald-500/20">
                    <i data-lucide="layers" class="w-5 h-5"></i>
                </div>
                <span class="font-black text-lg tracking-wide text-slate-900 dark:text-white">DSA ENGINE</span>
            </div>

            <div class="flex items-center gap-6 text-xs font-bold">
                ${linksHTML}
            </div>

            <div class="flex items-center gap-3">
                <!-- Theme Switcher Button -->
                <button onclick="window.toggleTheme()" class="p-2 bg-slate-200 dark:bg-obsidian-900 text-slate-700 dark:text-slate-300 rounded-xl border border-slate-300 dark:border-obsidian-800 hover:scale-105 transition flex items-center justify-center cursor-pointer" title="Toggle Theme">
                    <i data-lucide="sun" class="w-4 h-4 text-amber-500 hidden dark:block"></i>
                    <i data-lucide="moon" class="w-4 h-4 text-indigo-600 block dark:hidden"></i>
                </button>

                <!-- Logout Button -->
                <button onclick="window.logout()" class="px-3.5 py-1.5 bg-slate-200 dark:bg-obsidian-900 text-slate-700 dark:text-slate-400 hover:text-slate-900 dark:hover:text-white rounded-xl border border-slate-300 dark:border-obsidian-800 text-xs font-bold transition">Logout</button>
            </div>
        `;

        const initIcons = () => {
            if (window.lucide && typeof lucide.createIcons === 'function') {
                lucide.createIcons();
            } else {
                setTimeout(initIcons, 50);
            }
        };
        initIcons();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', renderNav);
    } else {
        renderNav();
    }
})();


