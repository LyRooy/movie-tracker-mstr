// Aplikacja MovieTracker
class MovieTracker {
    constructor() {
        this.currentUser = null;
        this.authToken = null;
        this.watchedMovies = [];
        this.currentRating = 0;
        this.currentSection = 'dashboard';
        this.adminVerified = false;
        this.currentView = 'grid'; // Śledź aktualny tryb widoku
        this.currentListStatus = 'all'; // Śledź aktualnie wybrany status w Mojej Liście
        this.tokenCheckInterval = null; // Sprawdzacz wygaśnięcia tokenu
        
        // Stan paska rekomendacji "Dla ciebie"
        this._recCount = 0;       // ile kart na tracku
        this._recOffset = 0;      // aktualny offset scrollowania (karty)
        this._recLoading = false; // flaga ładowania (blokuje przyciski)
        this._recLoaded = false;  // czy dane już zostały przeładowane
        this._lastRecMovies = [];
        this._lastRecStatus = 'empty';
        this._lastRecUpdatedAt = null;
        this._isRecalculating = false;
        this._recalcQueued = false;
        this._askAiLoading = false;
        this._showRecModels = localStorage.getItem('admin_show_rec_models') === '1';
        this._surveyData = null;
        this._surveyState = null;
        this._surveySubmitting = false;
        this._adminSurveyEnabled = false;
        this._onboardingSelected = new Map();
        this._onboardingMoviesCache = new Map();
        this._onboardingSearchTimer = null;
        
        // Właściwości kalendarza
        const now = new Date();
        this.calendarMonth = now.getMonth();
        this.calendarYear = now.getFullYear();
        
        this.init(); 
    }
    // ============= KONIEC KONSTRUKTORA I INIT =============

    async init() {
        // Sprawdź czy użytkownik jest zalogowany
        await this.checkAuth();
        
        if (!this.currentUser) {
            this.showAuthScreen();
            return;
        }
        
        this.bindEvents();
        this.loadUserData();
        const askWidget = document.getElementById('ask-ai-widget');
        if (askWidget) askWidget.style.display = 'block';
        await this.generateCalendar();
        await this.loadMoviesData();
        this.setupTheme();

        // Pokaż modal onboardingu nowym użytkownikom tylko raz na sesję (per userId)
        const favModalKey = this.currentUser?.id ? `favorites_modal_shown_${this.currentUser.id}` : 'favorites_modal_shown';
        if (this.currentUser && !this.currentUser.favorites_selected
                && !sessionStorage.getItem(favModalKey)) {
            sessionStorage.setItem(favModalKey, '1');
            await this.showFavoritesModal();
        }

        this._updateFavoritesBanner();

        // Pokaż sekcję admina jeśli użytkownik jest adminem
        if (this.currentUser && this.currentUser.role === 'admin') {
            const adminSection = document.getElementById('admin');
            if (adminSection) adminSection.style.display = '';
        }

                // Odśwież wyniki wyszukiwania
        setTimeout(() => {
            document.body.classList.add('transitions-enabled');
        }, 100);
        
        // Ustaw bieżący rok w stopce
        try {
            const yearEl = document.getElementById('footer-year');
            if (yearEl) yearEl.textContent = new Date().getFullYear();
        } catch (e) { /* ignore */ }
    }

    async loadGenres() {
        const CACHE_KEY = '_db_genres_v1';
        const CACHE_TTL = 15 * 60 * 1000;

        try {
            const rawCache = localStorage.getItem(CACHE_KEY);
            if (rawCache) {
                const parsed = JSON.parse(rawCache);
                if (parsed && Array.isArray(parsed.items) && parsed.items.length > 0 && (Date.now() - parsed.ts < CACHE_TTL)) {
                    this._dbGenres = parsed.items;
                    this.populateGenreFilterFromValues(parsed.items.map(g => g.name));
                    this.renderSearchGenreChips(parsed.items);
                    return;
                }
            }
        } catch (e) { /* ignore cache errors */ }

        try {
            const res = await fetch('/api/genres?with_counts=1', { headers: this.getAuthHeaders() });
            if (!res.ok) {
                console.warn('Failed to load genres from /api/genres');
                return;
            }
            const data = await res.json();
            if (!Array.isArray(data)) return;

            const items = data
                .map(g => typeof g === 'string'
                    ? { name: g.trim(), count: 0 }
                    : { name: String(g?.name || '').trim(), count: Number(g?.count) || 0 })
                .filter(g => g.name.length > 0);

            if (items.length === 0) return;

            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify({ ts: Date.now(), items }));
            } catch (e) { /* ignore storage quota errors */ }

            this._dbGenres = items;
            this.populateGenreFilterFromValues(items.map(g => g.name));
            this.renderSearchGenreChips(items);
        } catch (e) {
            console.error('Error loading genres:', e);
        }
    }

    renderSearchGenreChips(genres) {
        const container = document.getElementById('search-genre-chips');
        if (!container) return;

        const MAX_VISIBLE = 8;
        const list = Array.isArray(genres) ? genres : [];
        const visible = list.slice(0, MAX_VISIBLE);
        const overflow = list.slice(MAX_VISIBLE);

        container.innerHTML = '';

        const allBtn = document.createElement('button');
        allBtn.type = 'button';
        allBtn.className = 'genre-chip active';
        allBtn.dataset.genre = '';
        allBtn.textContent = 'Wszystkie';
        container.appendChild(allBtn);

        visible.forEach(item => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'genre-chip';
            btn.dataset.genre = item.name;
            btn.textContent = item.name;
            btn.title = item.count ? `${item.name} (${item.count.toLocaleString('pl-PL')})` : item.name;
            container.appendChild(btn);
        });

        if (overflow.length > 0) {
            const wrap = document.createElement('div');
            wrap.className = 'genre-more-wrap';

            const defaultLabel = `Więcej (${overflow.length})`;
            const moreBtn = document.createElement('button');
            moreBtn.type = 'button';
            moreBtn.id = 'search-genre-more-btn';
            moreBtn.className = 'genre-chip genre-chip-more';
            moreBtn.setAttribute('aria-expanded', 'false');
            moreBtn.setAttribute('aria-haspopup', 'listbox');
            moreBtn.dataset.defaultLabel = defaultLabel;

            const labelSpan = document.createElement('span');
            labelSpan.className = 'genre-more-label';
            labelSpan.textContent = defaultLabel;
            const icon = document.createElement('i');
            icon.className = 'fas fa-chevron-down';
            moreBtn.appendChild(labelSpan);
            moreBtn.appendChild(icon);

            const menu = document.createElement('div');
            menu.id = 'search-genre-more-menu';
            menu.className = 'genre-more-menu';
            menu.setAttribute('role', 'listbox');
            menu.hidden = true;

            overflow.forEach(item => {
                const itemBtn = document.createElement('button');
                itemBtn.type = 'button';
                itemBtn.className = 'genre-more-item';
                itemBtn.dataset.genre = item.name;
                itemBtn.setAttribute('role', 'option');

                const nameSpan = document.createElement('span');
                nameSpan.textContent = item.name;
                itemBtn.appendChild(nameSpan);

                if (item.count > 0) {
                    const countSpan = document.createElement('span');
                    countSpan.className = 'genre-more-count';
                    countSpan.textContent = item.count.toLocaleString('pl-PL');
                    itemBtn.appendChild(countSpan);
                }

                menu.appendChild(itemBtn);
            });

            wrap.appendChild(moreBtn);
            wrap.appendChild(menu);
            container.appendChild(wrap);
        }

        const currentGenre = document.getElementById('genre-filter')?.value || '';
        this.syncSearchGenreChips(currentGenre);
    }

    // Wypełnij pola wyboru gatunków na podstawie podanej tablicy wartości
    populateGenreFilterFromValues(values) {
        if (!Array.isArray(values)) return;
        const selectIds = ['genre-filter', 'list-genre-filter'];
        selectIds.forEach(id => {
            const genreSelect = document.getElementById(id);
            if (!genreSelect) return;
            const prevValue = genreSelect.value;
            const existingDisplay = new Set(Array.from(genreSelect.options).map(o => (o.textContent || o.value || '').toLowerCase().trim()));
            values.forEach(g => {
                if (!g) return;
                const label = g.trim();
                if (!existingDisplay.has(label.toLowerCase())) {
                    const opt = document.createElement('option');
                    opt.value = label;
                    opt.textContent = label;
                    genreSelect.appendChild(opt);
                }
            });
            if (prevValue) {
                genreSelect.value = prevValue;
            }
        });
    }
    // ============= BIND EVENTS =============
    bindEvents() {
        const closeNavDropdowns = () => {
            document.querySelectorAll('.nav-dropdown.open').forEach(dd => {
                dd.classList.remove('open');
                const toggle = dd.querySelector('.nav-dropdown-toggle');
                if (toggle) toggle.setAttribute('aria-expanded', 'false');
            });
        };

        const closeMobileMenu = () => {
            const navMenu = document.querySelector('.nav-menu');
            const hamburger = document.querySelector('.hamburger');
            if (navMenu && navMenu.classList.contains('active')) {
                navMenu.classList.remove('active');
                if (hamburger) {
                    hamburger.classList.remove('active');
                }
            }
        };

        // Klikniecie w logo przenosi do Dashboardu
        const navLogo = document.getElementById('nav-logo');
        if (navLogo) {
            const goDashboard = () => {
                this.showSection('dashboard');
                closeNavDropdowns();
                closeMobileMenu();
            };
            navLogo.addEventListener('click', goDashboard);
            navLogo.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    goDashboard();
                }
            });
        }

        // Rozwijane listy zakladek w pasku nawigacji
        document.querySelectorAll('.nav-dropdown-toggle').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const parent = btn.closest('.nav-dropdown');
                if (!parent) return;
                const willOpen = !parent.classList.contains('open');
                closeNavDropdowns();
                if (willOpen) {
                    parent.classList.add('open');
                    btn.setAttribute('aria-expanded', 'true');
                }
            });
        });

        document.addEventListener('click', (e) => {
            if (!e.target.closest('.nav-dropdown')) {
                closeNavDropdowns();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                closeNavDropdowns();
            }
        });

        // Nawigacja
        document.querySelectorAll('.nav-link').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const section = link.getAttribute('href').substring(1);
                this.showSection(section);
                closeNavDropdowns();
                closeMobileMenu();
            });
        });

        // Przełącznik motywu
        document.getElementById('theme-toggle').addEventListener('click', () => {
            this.toggleTheme();
        });

        // Przycisk wylogowania
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => {
                this.logout();
            });
        }

        // Wybór motywu w profilu
        const themeSelect = document.getElementById('theme-select');
        if (themeSelect) {
            themeSelect.addEventListener('change', (e) => {
                this.changeTheme(e.target.value);
            });
        }

        // Przesłanie awatara
        const avatarWrapper = document.getElementById('avatar-wrapper');
        const avatarUpload = document.getElementById('avatar-upload');
        if (avatarWrapper && avatarUpload) {
            avatarWrapper.addEventListener('click', () => {
                avatarUpload.click();
            });
            avatarUpload.addEventListener('change', (e) => {
                this.uploadAvatar(e.target.files[0]);
            });
        }

        // Funkcjonalność wyszukiwania
        const searchInput = document.getElementById('search-input');

        if (searchInput) {
            // Wyszukiwanie po naciśnięciu Enter
            searchInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    clearTimeout(this._liveSearchTimeout);
                    this.performSearch();
                }
            });

            // Sugestie na żywo podczas pisania (z opóźnieniem)
            searchInput.addEventListener('input', (e) => {
                clearTimeout(this._liveSearchTimeout);
                const query = e.target.value.trim();
                if (query.length === 0) {
                    this.performSearch();
                    return;
                }

                if (query.length < 2) {
                    return;
                }

                this._liveSearchTimeout = setTimeout(() => {
                    this.performSearch();
                }, 320);
            });
        }

        // Filtry
        const typeFilter = document.getElementById('type-filter');
        const genreFilter = document.getElementById('genre-filter');
        const yearFilter = document.getElementById('year-filter');
        const genreChipsContainer = document.getElementById('search-genre-chips');
        const resetFiltersBtn = document.getElementById('search-reset-filters');
        
        if (typeFilter) {
            typeFilter.addEventListener('change', () => {
                clearTimeout(this._liveSearchTimeout);
                this.performSearch();
            });
        }
        if (genreFilter) {
            genreFilter.addEventListener('change', () => {
                clearTimeout(this._liveSearchTimeout);
                this.syncSearchGenreChips(genreFilter.value);
                this.performSearch();
            });
        }
        if (yearFilter) {
            yearFilter.addEventListener('change', () => {
                clearTimeout(this._liveSearchTimeout);
                this.performSearch();
            });
        }
        if (genreChipsContainer) {
            genreChipsContainer.addEventListener('click', (e) => {
                const moreBtn = e.target.closest('#search-genre-more-btn');
                if (moreBtn) {
                    const menu = document.getElementById('search-genre-more-menu');
                    if (menu) {
                        const willOpen = menu.hidden;
                        menu.hidden = !willOpen;
                        moreBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
                    }
                    return;
                }

                const target = e.target.closest('.genre-chip:not(.genre-chip-more), .genre-more-item');
                if (!target) return;

                const menu = document.getElementById('search-genre-more-menu');
                const btn = document.getElementById('search-genre-more-btn');
                if (menu) menu.hidden = true;
                if (btn) btn.setAttribute('aria-expanded', 'false');

                const genreVal = target.dataset.genre || '';
                if (genreFilter) {
                    if (genreVal && !Array.from(genreFilter.options).some(o => o.value.toLowerCase() === genreVal.toLowerCase())) {
                        const opt = document.createElement('option');
                        opt.value = genreVal;
                        opt.textContent = genreVal;
                        genreFilter.appendChild(opt);
                    }
                    genreFilter.value = genreVal;
                }
                this.syncSearchGenreChips(genreVal);
                clearTimeout(this._liveSearchTimeout);
                this.performSearch();
            });

            if (!this._genreMoreOutsideBound) {
                this._genreMoreOutsideBound = true;
                document.addEventListener('click', (e) => {
                    if (!e.target.closest('.genre-more-wrap')) {
                        const menu = document.getElementById('search-genre-more-menu');
                        const btn = document.getElementById('search-genre-more-btn');
                        if (menu && !menu.hidden) menu.hidden = true;
                        if (btn) btn.setAttribute('aria-expanded', 'false');
                    }
                });
                document.addEventListener('keydown', (e) => {
                    if (e.key === 'Escape') {
                        const menu = document.getElementById('search-genre-more-menu');
                        const btn = document.getElementById('search-genre-more-btn');
                        if (menu && !menu.hidden) menu.hidden = true;
                        if (btn) btn.setAttribute('aria-expanded', 'false');
                    }
                });
            }
        }
        if (resetFiltersBtn) {
            resetFiltersBtn.addEventListener('click', () => {
                clearTimeout(this._liveSearchTimeout);
                if (searchInput) searchInput.value = '';
                if (typeFilter) typeFilter.value = '';
                if (genreFilter) genreFilter.value = '';
                if (yearFilter) yearFilter.value = '';
                this.syncSearchGenreChips('');
                this.performSearch();
            });
        }

        // Rozwijany czat "Zapytaj AI" w prawym dolnym rogu
        const askAiFab = document.getElementById('ask-ai-fab');
        const askAiClose = document.getElementById('ask-ai-close');
        const askAiClear = document.getElementById('ask-ai-clear');
        const askAiForm = document.getElementById('ask-ai-form');
        const askAiMessages = document.getElementById('ask-ai-messages');

        if (askAiFab) {
            askAiFab.addEventListener('click', () => this.toggleAskAIDrawer());
        }
        if (askAiClose) {
            askAiClose.addEventListener('click', () => this.toggleAskAIDrawer(false));
        }
        if (askAiClear) {
            askAiClear.addEventListener('click', () => this.resetAskAIChat());
        }
        if (askAiForm) {
            askAiForm.addEventListener('submit', (e) => {
                e.preventDefault();
                this.submitAskAI();
            });
        }
        if (askAiMessages) {
            askAiMessages.addEventListener('click', (e) => {
                const chip = e.target.closest('.ask-ai-chip');
                if (!chip) return;
                const promptText = chip.dataset.prompt || chip.textContent.trim();
                this.submitAskAI(promptText);
            });
        }
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                const drawer = document.getElementById('ask-ai-drawer');
                if (drawer && !drawer.hidden) {
                    this.toggleAskAIDrawer(false);
                }
            }
        });

        // Zdarzenia modalne - obsłuż przycisk zamykający w modalu filmu
        document.querySelectorAll('#movie-modal .close').forEach(btn => {
            btn.addEventListener('click', () => this.closeModal());
        });

        window.addEventListener('click', (e) => {
            const modal = document.getElementById('movie-modal');
            if (modal && e.target === modal) {
                this.closeModal();
            }
        });

        // Gwiazdki oceny
        const starsContainer = document.querySelector('.stars');
        if (starsContainer) {
            starsContainer.querySelectorAll('i').forEach((star, index) => {
                star.addEventListener('click', () => {
                    // Jeśli kliknie się tę samą gwiazdkę co już zaznaczona, wyzeruj ocenę
                    if (this.currentRating === index + 1) {
                        this.setRating(0);
                    } else {
                        this.setRating(index + 1);
                    }
                });
                star.addEventListener('mouseenter', () => {
                    this.highlightStars(index + 1);
                });
            });

            starsContainer.addEventListener('mouseleave', () => {
                this.highlightStars(this.currentRating);
            });
        }

        // Przycisk dodawania do listy
        const addToListBtn = document.getElementById('add-to-list');
        if (addToListBtn) {
            addToListBtn.addEventListener('click', () => {
                this.addToWatched();
            });
        }

        // Przycisk aktualizacji elementu
        const updateItemBtn = document.getElementById('update-item');
        if (updateItemBtn) {
            updateItemBtn.addEventListener('click', () => {
                this.updateMovieItem();
            });
        }

        // Przycisk usuwania z listy
        const removeFromListBtn = document.getElementById('remove-from-list');
        if (removeFromListBtn) {
            removeFromListBtn.addEventListener('click', () => {
                this.removeFromList();
            });
        }

        // Przyciski zakładek dla sekcji Moja Lista
        document.querySelectorAll('.tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                // Usuń klasę active ze wszystkich przycisków zakładek
                document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
                // Dodaj klasę active do klikniętego przycisku
                e.target.classList.add('active');
                
                // Filtruj listę na podstawie wybranej zakładki
                const status = e.target.dataset.status;
                this.filterMyList(status);
            });
        });

        // Filtry i sortowanie dla sekcji Moja Lista
        const listTypeFilter = document.getElementById('list-type-filter');
        if (listTypeFilter) {
            listTypeFilter.addEventListener('change', () => {
                this.displayMyList(this.currentListStatus);
            });
        }

        const listGenreFilter = document.getElementById('list-genre-filter');
        if (listGenreFilter) {
            listGenreFilter.addEventListener('change', () => {
                this.displayMyList(this.currentListStatus);
            });
        }

        const listSort = document.getElementById('list-sort');
        if (listSort) {
            listSort.addEventListener('change', () => {
                this.displayMyList(this.currentListStatus);
            });
        }

        // Przyciski sterowania widokiem (widok siatki/listy)
        document.querySelectorAll('.view-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                
                const button = e.currentTarget;
                const viewMode = button.dataset.view;
                
                // Usuń klasę active ze wszystkich przycisków widoku
                document.querySelectorAll('.view-btn').forEach(b => b.classList.remove('active'));
                // Dodaj klasę active do klikniętego przycisku
                button.classList.add('active');
                
                // Zmień tryb widoku
                this.changeViewMode(viewMode);
            });
        });

        // Menu mobilne
        const hamburger = document.querySelector('.hamburger');
        const navMenu = document.querySelector('.nav-menu');
        if (hamburger && navMenu) {
            hamburger.addEventListener('click', () => {
                hamburger.classList.toggle('active');
                navMenu.classList.toggle('active');
            });

            // Zamknij menu po kliknięciu poza nim
            document.addEventListener('click', (e) => {
                if (!hamburger.contains(e.target) && !navMenu.contains(e.target)) {
                    hamburger.classList.remove('active');
                    navMenu.classList.remove('active');
                }
            });
        }

        // Generuj opcje roku dla filtra
        this.generateYearOptions();
        
        // Event listenery dla profilu
        this.bindProfileEvents();
        
        // Kliknięcia elementów listy - deleguj do kontenera
        const myListContainer = document.getElementById('my-list-content');
        if (myListContainer) {
            myListContainer.addEventListener('click', (e) => {
                const listItem = e.target.closest('.list-item');
                if (listItem) {
                    const itemId = parseInt(listItem.dataset.id);
                    // Zawsze otwieraj normalny modal edycji (również dla seriali)
                    this.editItem(itemId);
                }
            });
        }
        
        // Przyciski zakładek modalnych
        document.querySelectorAll('.modal-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tab = e.target.dataset.tab;
                this.switchModalTab(tab);
            });
        });
        
        // Powiązania panelu admina (jeśli admin)
        if (this.currentUser && this.currentUser.role === 'admin') {
            this.bindAdminEvents();

            const recModelCheckbox = document.getElementById('admin-show-rec-models');
            if (recModelCheckbox) {
                recModelCheckbox.checked = this._showRecModels;
                recModelCheckbox.addEventListener('change', (e) => {
                    this._showRecModels = !!e.target.checked;
                    localStorage.setItem('admin_show_rec_models', this._showRecModels ? '1' : '0');
                    if (this._recLoaded) {
                        this.renderForYou(this._lastRecMovies, this._lastRecStatus);
                    }
                });
            }
        }
    }
    // ============= KONIEC BIND EVENTS =============

    showSection(sectionName) {
        // Panel admina wymaga weryfikacji hasła
        if (sectionName === 'admin' && !this.adminVerified) {
            this.showAdminPasswordPrompt();
            return;
        }

        // Ukryj wszystkie sekcje
        document.querySelectorAll('.section').forEach(section => {
            section.classList.remove('active');
        });

        // Pokaż wybraną sekcję (bezpiecznie - sprawdź istnienie)
        const targetSection = document.getElementById(sectionName);
        if (targetSection) {
            targetSection.classList.add('active');
            this.currentSection = sectionName;
        } else {
            console.warn('showSection: section not found:', sectionName);
        }

        // Zaktualizuj nawigację (bezpiecznie)
        document.querySelectorAll('.nav-link').forEach(link => link.classList.remove('active'));
        document.querySelectorAll('.nav-dropdown-toggle').forEach(btn => btn.classList.remove('active'));
        const navLink = document.querySelector(`.nav-link[href="#${sectionName}"]`);
        if (navLink) {
            navLink.classList.add('active');
            const parentDropdown = navLink.closest('.nav-dropdown');
            if (parentDropdown) {
                const toggle = parentDropdown.querySelector('.nav-dropdown-toggle');
                if (toggle) toggle.classList.add('active');
            }
        }

        // Ładuj dane specyficzne dla sekcji
        if (sectionName === 'statistics') {
            this.loadCharts();
        } else if (sectionName === 'my-list') {
            this.displayMyList(this.currentListStatus);
        } else if (sectionName === 'search') {
            if (!this._dbGenres || this._dbGenres.length === 0) {
                this.loadGenres();
            }
            if (!this._searchState) {
                this.performSearch();
            }
        } else if (sectionName === 'profile') {
            this.loadProfileData();
        } else if (sectionName === 'challenges') {
            this.loadChallenges();
        } else if (sectionName === 'survey') {
            this.loadSurvey();
        } else if (sectionName === 'admin') {
            this.loadAdminData();
        }
    }

    setupTheme() {
        const savedTheme = localStorage.getItem('theme') || 'light';
        
        let actualTheme = savedTheme;
        
        // Motyw powinien być już ustawiony przez skrypt inline, zaktualizuj wybór
        const themeSelect = document.getElementById('theme-select');
        if (themeSelect) {
            themeSelect.value = actualTheme;
        }
    }

    toggleTheme() {
        const currentTheme = document.body.classList.contains('dark-theme') ? 'dark' : 'light';
        const newTheme = currentTheme === 'light' ? 'dark' : 'light';
        this.changeTheme(newTheme);
    }

    changeTheme(theme) {
        // Zaktualizuj zarówno klasę body jak i html dla spójności
        document.body.className = `${theme}-theme transitions-enabled`;
        document.documentElement.className = `${theme}-theme`;
        
        // Zapisz w localStorage
        localStorage.setItem('theme', theme);
        
        // Zaktualizuj wybór motywu w profilu
        const themeSelect = document.getElementById('theme-select');
        if (themeSelect) {
            themeSelect.value = theme;
        }
        
        console.log('Theme changed to:', theme);

        // Zachowaj preferencję dla zalogowanych użytkowników
        if (this.authToken) {
            fetch('/api/auth/theme', {
                method: 'POST',
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ theme_preference: theme })
            }).then(async (res) => {
                if (!res.ok) {
                    const err = await res.json().catch(() => ({}));
                    console.warn('Failed to persist theme preference:', err);
                    return;
                }
                const json = await res.json();
                if (json && json.user) {
                    this.currentUser = json.user; // zaktualizuj buforowanego użytkownika
                }
            }).catch(err => {
                console.warn('Error saving theme preference:', err);
            });
        }
    }

    loadUserData() {
        // Zaktualizuj interfejs danymi bieżącego użytkownika (załadowane z uwierzytelnienia)
        if (this.currentUser) {
            const usernameEl = document.getElementById('username');
            if (usernameEl) usernameEl.textContent = this.currentUser.nickname;
            const profileUsername = document.getElementById('profile-username');
            const profileEmail = document.getElementById('profile-email');
            const profileDescription = document.getElementById('profile-user-description');
            
            if (profileUsername) profileUsername.textContent = this.currentUser.nickname;
            if (profileEmail) profileEmail.textContent = this.currentUser.email;
            if (profileDescription) {
                profileDescription.textContent = this.currentUser.description || 'Brak opisu';
                profileDescription.style.fontStyle = this.currentUser.description ? 'normal' : 'italic';
            }
            // Ustaw datę członkostwa na podstawie daty utworzenia konta (jeśli dostępna), inaczej użyj bieżącej daty
            const memberSinceEl = document.getElementById('member-since');
            if (memberSinceEl) {
                const rawDate = this.currentUser.created_at || this.currentUser.createdAt || this.currentUser.registered_at || this.currentUser.registeredAt || this.currentUser.joined_at || null;
                let formattedDate = null;
                if (rawDate) {
                    try {
                        const date = new Date(rawDate);
                        if (!isNaN(date.getTime())) {
                            formattedDate = date.toLocaleDateString('pl-PL', { 
                                year: 'numeric', 
                                month: 'long' 
                            });
                        }
                    } catch (e) {
                        formattedDate = null;
                    }
                }
                if (!formattedDate) {
                    formattedDate = new Date().toLocaleDateString('pl-PL', { 
                        year: 'numeric', 
                        month: 'long' 
                    });
                }
                memberSinceEl.textContent = formattedDate;
            }
            
            // Awatar + nick w profilu, navbarze i dashboardzie (spójny domyślny awatar)
            const avatarUrl = this.currentUser.avatar_url || 'images/default-avatar.png';
            const userAvatar = document.getElementById('user-avatar');
            const navAvatar = document.getElementById('nav-avatar');
            const navUsername = document.getElementById('nav-username');
            const dashAvatar = document.getElementById('dashboard-avatar');
            if (userAvatar) userAvatar.src = avatarUrl;
            if (navAvatar) navAvatar.src = avatarUrl;
            if (navUsername) navUsername.textContent = this.currentUser.nickname;
            if (dashAvatar) dashAvatar.src = avatarUrl;

            // Pokaż nawigację admina i przełącznik modeli jeśli użytkownik jest adminem
            if (this.currentUser.role === 'admin') {
                const adminNavItem = document.getElementById('admin-nav-item');
                if (adminNavItem) adminNavItem.style.display = 'block';

                const recModelToggleWrap = document.getElementById('admin-rec-model-toggle-wrap');
                const recModelCheckbox = document.getElementById('admin-show-rec-models');
                if (recModelToggleWrap) recModelToggleWrap.style.display = 'inline-flex';
                if (recModelCheckbox) recModelCheckbox.checked = this._showRecModels;
            }
        }
    }

    async uploadAvatar(file) {
        if (!file) return;
        
        // Zweryfikuj typ pliku
        if (!file.type.startsWith('image/')) {
            alert('Proszę wybrać plik obrazu');
            return;
        }
        
        // Zweryfikuj rozmiar pliku (maks. 2MB)
        if (file.size > 2 * 1024 * 1024) {
            alert('Rozmiar pliku nie może przekraczać 2MB');
            return;
        }
        
        try {
            // Utwórz FormData
            const formData = new FormData();
            formData.append('avatar', file);
            
            const response = await fetch('/api/auth/avatar', {
                method: 'POST',
                headers: {
                    'Authorization': this.getAuthHeaders()['Authorization']
                    // Nie ustawiaj Content-Type - przeglądarka ustawi go z granicą dla FormData
                },
                body: formData
            });
            
            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Nie udało się zaktualizować avatara');
            }
            
            const data = await response.json();
            
            // Zaktualizuj interfejs
            const userAvatar = document.getElementById('user-avatar');
            if (userAvatar) {
                userAvatar.src = data.avatar_url;
            }
            
            // Zaktualizuj bieżącego użytkownika
            this.currentUser.avatar_url = data.avatar_url;
            
            alert('Avatar został zaktualizowany!');
        } catch (error) {
            console.error('Error uploading avatar:', error);
            alert('Błąd podczas przesyłania avatara: ' + error.message);
        }
    }

    // ============= FUNKCJE PROFILU =============

    bindProfileEvents() {
        // Zakładki profilu
        document.querySelectorAll('.profile-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                // Użyj currentTarget, aby kliknięcia wewnętrznych elementów (ikony/spany) nie przerywały działania
                const el = e.currentTarget || e.target.closest('.profile-tab-btn');
                const tabName = el?.dataset?.profileTab;
                if (!tabName) return;
                this.switchProfileTab(tabName);
            });
        });

        // Przycisk dodawania znajomego
        const addFriendBtn = document.getElementById('add-friend-btn');
        if (addFriendBtn) {
            addFriendBtn.addEventListener('click', () => {
                this.openAddFriendModal();
            });
        }

        // Zamknięcie modalu (przycisk X) - dopasuj do rzeczywistej klasy w HTML
        const closeModalBtn = document.querySelector('#add-friend-modal .close');
        if (closeModalBtn) {
            closeModalBtn.addEventListener('click', () => {
                this.closeAddFriendModal();
            });
        }

        // Zamknięcie modalu przez kliknięcie tła
        const addFriendModal = document.getElementById('add-friend-modal');
        if (addFriendModal) {
            addFriendModal.addEventListener('click', (e) => {
                if (e.target === addFriendModal) {
                    this.closeAddFriendModal();
                }
            });
        }

        // Wyszukiwanie użytkowników (debounced)
        const userSearchInput = document.getElementById('friend-search-input');
        if (userSearchInput) {
            let searchTimeout;
            userSearchInput.addEventListener('input', (e) => {
                clearTimeout(searchTimeout);
                const query = e.target.value.trim();
                const resultsContainer = document.getElementById('friend-search-results');

                // Wyczyść wyniki jeśli zapytanie jest puste
                if (query.length < 2) {
                    if (resultsContainer) {
                        resultsContainer.innerHTML = '<p class="help-text">Wpisz co najmniej 2 znaki, aby wyszukać użytkowników.</p>';
                    }
                    return;
                }

                // Pokaż komunikat szukania
                if (resultsContainer) resultsContainer.innerHTML = '<p class="searching">Szukam...</p>';
                searchTimeout = setTimeout(() => {
                    this.searchUsers(query);
                }, 300);
            });
        }

        // Zobacz wszystkie odznaki
        const viewAllBadgesBtn = document.getElementById('view-all-badges');
        if (viewAllBadgesBtn) {
            viewAllBadgesBtn.addEventListener('click', (e) => {
                e.preventDefault();
                this.showAllBadges();
            });
        }

        // Zmiana hasła
        const changePasswordBtn = document.getElementById('change-password-btn');
        if (changePasswordBtn) {
            changePasswordBtn.addEventListener('click', () => {
                this.showChangePasswordModal();
            });
        }

        // Usunięcie konta
        const deleteAccountBtn = document.getElementById('delete-account-btn');
        if (deleteAccountBtn) {
            deleteAccountBtn.addEventListener('click', () => {
                this.showDeleteAccountModal();
            });
        }

        // Zapis opisu profilu
        const saveDescriptionBtn = document.getElementById('save-description-btn');
        const descriptionInput = document.getElementById('profile-description-input');
        const charCount = document.getElementById('description-char-count');
        
        if (descriptionInput && charCount) {
            descriptionInput.addEventListener('input', () => {
                charCount.textContent = descriptionInput.value.length;
            });
        }
        
        if (saveDescriptionBtn) {
            saveDescriptionBtn.addEventListener('click', () => {
                this.saveProfileDescription();
            });
        }
    }

    switchProfileTab(tabName) {
        // Usuń active ze wszystkich zakładek
        document.querySelectorAll('.profile-tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelectorAll('.profile-tab-content').forEach(content => {
            content.classList.remove('active');
        });

        // Aktywuj wybraną zakładkę
        const activeBtn = document.querySelector(`[data-profile-tab="${tabName}"]`);
        const activeContent = document.getElementById(`profile-${tabName}-tab`);
        
        if (activeBtn) activeBtn.classList.add('active');
        if (activeContent) activeContent.classList.add('active');

        // Załaduj zawartość dla wybranych zakładek, aby interfejs był aktualny
        if (tabName === 'friends') {
            // Załaduj listę znajomych oraz zaproszenia do znajomych
            this.loadFriends();
            this.loadFriendRequests();
        } else if (tabName === 'badges') {
            this.loadBadges();
        } else if (tabName === 'settings') {
            this.loadProfileSettings();
        }
    }

    async loadProfileSettings() {
        try {
            const response = await fetch('/api/auth/me', {
                headers: this.getAuthHeaders()
            });
            
            if (response.ok) {
                const data = await response.json();
                const user = data.user;
                
                // Załaduj opis
                const descriptionInput = document.getElementById('profile-description-input');
                const charCount = document.getElementById('description-char-count');
                if (descriptionInput) {
                    descriptionInput.value = user.description || '';
                    if (charCount) {
                        charCount.textContent = descriptionInput.value.length;
                    }
                }
            }
        } catch (error) {
            console.error('Error loading profile settings:', error);
        }
    }

    async saveProfileDescription() {
        const descriptionInput = document.getElementById('profile-description-input');
        if (!descriptionInput) return;

        const description = descriptionInput.value.trim();

        try {
            const response = await fetch('/api/auth/me', {
                method: 'PUT',
                headers: {
                    ...this.getAuthHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ description })
            });

            if (response.ok) {
                this.showNotification('Opis profilu został zaktualizowany', 'success');
                // Zaktualizuj dane użytkownika w pamięci i wyświetlacz
                if (this.currentUser) {
                    this.currentUser.description = description;
                }
                // Zaktualizuj wyświetlanie opisu w profilu
                const profileDescription = document.getElementById('profile-user-description');
                if (profileDescription) {
                    profileDescription.textContent = description || 'Brak opisu';
                    profileDescription.style.fontStyle = description ? 'normal' : 'italic';
                }
            } else {
                const error = await response.json();
                this.showNotification(error.error || 'Błąd podczas zapisywania opisu', 'error');
            }
        } catch (error) {
            console.error('Error saving description:', error);
            this.showNotification('Błąd podczas zapisywania opisu', 'error');
        }
    }

    async loadProfileData() {
        // Załaduj wszystkie dane profilu
        await Promise.all([
            this.loadBadges(),
            this.loadFriends(),
            this.loadFriendRequests()
        ]);
    }

    async loadChallenges() {
        try {
            const response = await fetch('/api/challenges', {
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error('Nie udało się załadować wyzwań');
            }

            const challenges = await response.json();
            this.displayChallenges(challenges);
        } catch (error) {
            console.error('Error loading challenges:', error);
            this.displayChallenges([]);
        }
    }

    displayChallenges(challenges) {
        const container = document.getElementById('challenges-container');
        if (!container) return;

        if (!Array.isArray(challenges) || challenges.length === 0) {
            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-flag" style="font-size:48px;color:#ccc;margin-bottom:12px"></i>
                    <h3>Brak aktywnych wyzwań</h3>
                    <p>Sprawdź ponownie później</p>
                </div>
            `;
            return;
        }

        // Sortuj wyzwania - aktywne/upcoming najpierw, potem zakończone
        const sortedChallenges = [...challenges].sort((a, b) => {
            const statusOrder = { 'active': 1, 'upcoming': 2, 'expired': 3 };
            return (statusOrder[a.status] || 99) - (statusOrder[b.status] || 99);
        });

        container.innerHTML = sortedChallenges.map(ch => {
            const statusClass = ch.status === 'active' ? 'active' : ch.status === 'expired' ? 'expired' : 'upcoming';
            const statusText = ch.status === 'active' ? 'Aktywne' : ch.status === 'expired' ? 'Zakończone' : 'Nadchodzące';
            const typeText = ch.type === 'movies' ? 'Filmy' : ch.type === 'series' ? 'Seriale' : ch.type === 'genre' ? `Gatunek: ${ch.criteria_value}` : 'Wszystko';
            
            let actionButton = '';
            if (ch.status === 'active' || ch.status === 'upcoming') {
                if (ch.is_participant) {
                    actionButton = `
                        <button class="btn btn-secondary" onclick="app.leaveChallenge(${ch.id})">
                            <i class="fas fa-sign-out-alt"></i> Opuść wyzwanie
                        </button>
                    `;
                } else {
                    actionButton = `
                        <button class="btn btn-primary" onclick="app.joinChallenge(${ch.id})">
                            <i class="fas fa-play"></i> Weź udział
                        </button>
                    `;
                }
            }
            
            // Wyświetl tiery z odznakaniami
            const tiersHtml = [];
            if (ch.target_silver) {
                const silverCompleted = ch.completed_silver_at ? '✓' : '';
                tiersHtml.push(`
                    <div class="tier-item ${ch.completed_silver_at ? 'completed' : ''}">
                        <i class="fas fa-medal" style="color: #C0C0C0"></i>
                        <span>Srebrna: ${ch.target_silver} ${silverCompleted}</span>
                    </div>
                `);
            }
            if (ch.target_gold) {
                const goldCompleted = ch.completed_gold_at ? '✓' : '';
                tiersHtml.push(`
                    <div class="tier-item ${ch.completed_gold_at ? 'completed' : ''}">
                        <i class="fas fa-medal" style="color: #FFD700"></i>
                        <span>Złota: ${ch.target_gold} ${goldCompleted}</span>
                    </div>
                `);
            }
            if (ch.target_platinum) {
                const platinumCompleted = ch.completed_platinum_at ? '✓' : '';
                tiersHtml.push(`
                    <div class="tier-item ${ch.completed_platinum_at ? 'completed' : ''}">
                        <i class="fas fa-medal" style="color: #E5E4E2"></i>
                        <span>Platynowa: ${ch.target_platinum} ${platinumCompleted}</span>
                    </div>
                `);
            }
            
            const tiersSection = tiersHtml.length > 0 ? `
                <div class="challenge-tiers">
                    ${tiersHtml.join('')}
                </div>
            ` : '';
            
            const maxTarget = ch.target_platinum || ch.target_gold || ch.target_silver || 0;
            const progressBar = ch.is_participant && maxTarget > 0 ? `
                <div class="challenge-progress">
                    <div class="challenge-progress-bar">
                        <div class="challenge-progress-fill" style="width: ${ch.percentage}%"></div>
                    </div>
                    <span class="challenge-progress-text">${ch.progress} / ${maxTarget}</span>
                </div>
            ` : '';
            
            return `
                <div class="challenge-card ${statusClass}">
                    <div class="challenge-header">
                        <h3>${this.escapeHtml(ch.title)}</h3>
                        <span class="challenge-status challenge-status-${statusClass}">${statusText}</span>
                    </div>
                    <p class="challenge-desc">${this.escapeHtml(ch.description || '')}</p>
                    <div class="challenge-meta">
                        <div class="challenge-meta-item">
                            <i class="fas fa-film"></i>
                            <span>Typ: ${typeText}</span>
                        </div>
                        <div class="challenge-meta-item">
                            <i class="fas fa-calendar"></i>
                            <span>${this.formatDate(ch.start_date)} - ${this.formatDate(ch.end_date)}</span>
                        </div>
                    </div>
                    ${tiersSection}
                    ${progressBar}
                    <div class="challenge-actions">
                        ${actionButton}
                    </div>
                </div>
            `;
        }).join('');
    }

    async joinChallenge(challengeId) {
        try {
            const response = await fetch(`/api/challenges/${challengeId}`, {
                method: 'POST',
                headers: this.getAuthHeaders()
            });
            
            if (response.ok) {
                this.showNotification('Dołączono do wyzwania!', 'success');
                await this.loadChallenges(); // Odśwież listę
            } else {
                const error = await response.json();
                this.showNotification(error.error || 'Błąd podczas dołączania', 'error');
            }
        } catch (error) {
            console.error('Error joining challenge:', error);
            this.showNotification('Błąd podczas dołączania do wyzwania', 'error');
        }
    }

    async leaveChallenge(challengeId) {
        if (!(await this.showConfirm('Czy na pewno chcesz opuścić to wyzwanie?', 'Potwierdź'))) {
            return;
        }
        
        try {
            const response = await fetch(`/api/challenges/${challengeId}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });
            
            if (response.ok) {
                this.showNotification('Opuszczono wyzwanie', 'success');
                await this.loadChallenges(); // Odśwież listę
            } else {
                const error = await response.json();
                this.showNotification(error.error || 'Błąd podczas opuszczania', 'error');
            }
        } catch (error) {
            console.error('Error leaving challenge:', error);
            this.showNotification('Błąd podczas opuszczania wyzwania', 'error');
        }
    }

    async showAllBadges() {
        this.showSection('badges-all');
        await this.loadAllBadges();
    }

    async loadAllBadges() {
        try {
            const response = await fetch('/api/badges', {
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error('Nie udało się załadować odznak');
            }

            const badges = await response.json();
            this.displayAllBadges(badges);
        } catch (error) {
            console.error('Error loading all badges:', error);
            this.displayAllBadges([]);
        }
    }

    displayAllBadges(badges) {
        const container = document.getElementById('all-badges-container');
        if (!container) return;

        // Zaktualizuj statystyki
        document.getElementById('total-badges-count').textContent = badges.length;
        document.getElementById('platinum-badges-count').textContent = 
            badges.filter(b => b.level === 'platinum').length;
        document.getElementById('gold-badges-count').textContent = 
            badges.filter(b => b.level === 'gold').length;
        document.getElementById('silver-badges-count').textContent = 
            badges.filter(b => b.level === 'silver').length;

        if (badges.length === 0) {
            container.innerHTML = `
                <div class="no-badges-message">
                    <i class="fas fa-award" style="font-size: 4rem; color: #ccc; margin-bottom: 1rem;"></i>
                    <h3>Nie masz jeszcze żadnych odznak</h3>
                    <p>Ukończ wyzwania, aby zdobyć odznaki!</p>
                    <button class="btn btn-primary" onclick="app.showSection('challenges')">
                        <i class="fas fa-trophy"></i> Zobacz wyzwania
                    </button>
                </div>
            `;
            return;
        }

        container.innerHTML = badges.map(badge => `
            <div class="badge-item-full">
                <div class="badge-icon">
                    ${badge.image_url || badge.imageUrl 
                        ? `<img src="${badge.image_url || badge.imageUrl}" alt="${badge.name}">` 
                        : '<i class="fas fa-award"></i>'
                    }
                </div>
                <div class="badge-details">
                    <h4>${badge.name}</h4>
                    <span class="badge-level ${badge.level}">${this.getBadgeLevelText(badge.level)}</span>
                    ${badge.description ? `<p class="badge-description">${badge.description}</p>` : ''}
                    <span class="badge-earned-date">
                        <i class="fas fa-calendar"></i> Zdobyte: ${this.formatDate(badge.earnedAt || badge.earned_at)}
                    </span>
                </div>
            </div>
        `).join('');
    }

    async loadBadges() {
        try {
            const response = await fetch('/api/badges?limit=6', {
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error('Nie udało się załadować odznak');
            }

            const badges = await response.json();
            this.displayBadges(badges);
        } catch (error) {
            console.error('Error loading badges:', error);
            this.displayBadges([]);
        }
    }

    displayBadges(badges) {
        const container = document.getElementById('badges-container');
        if (!container) return;

        if (badges.length === 0) {
            // Pokaż placeholder wyśrodkowany
            container.innerHTML = `
                <div class="no-badges-message" style="grid-column: 1 / -1;">
                    <i class="fas fa-award" style="font-size: 4rem; color: #ccc; margin-bottom: 1rem;"></i>
                    <h3>Nie masz jeszcze żadnych odznak</h3>
                    <p>Ukończ wyzwania, aby zdobyć odznaki!</p>
                    <button class="btn btn-primary" onclick="app.showSection('challenges')">
                        <i class="fas fa-trophy"></i> Zobacz wyzwania
                    </button>
                </div>
            `;
            return;
        }

        container.innerHTML = badges.map(badge => `
            <div class="badge-item">
                ${badge.image_url || badge.imageUrl 
                    ? `<img src="${badge.image_url || badge.imageUrl}" alt="${badge.name}">` 
                    : '<i class="fas fa-award"></i>'
                }
                <h4>${badge.name}</h4>
                <span class="badge-level ${badge.level}">${this.getBadgeLevelText(badge.level)}</span>
            </div>
        `).join('');
    }

    getBadgeLevelText(level) {
        const levels = {
            'silver': 'Srebrna',
            'gold': 'Złota',
            'platinum': 'Platynowa',
            'none': 'Podstawowa'
        };
        return levels[level] || level;
    }

    formatDate(dateString) {
        if (!dateString) return 'Nieznana data';
        const date = new Date(dateString);
        if (isNaN(date.getTime())) return 'Nieznana data';
        return date.toLocaleDateString('pl-PL', {
            year: 'numeric',
            month: 'long',
            day: 'numeric'
        });
    }

    // Znormalizuj pole roku tak, aby zwracać tylko rok (lub oryginalny zakres),
    // zamiast pełnej daty typu 1985-01-01. Przydatne gdy backend zapisuje
    // release_date jako pełną datę, a w UI chcemy wyświetlać tylko rok.
    normalizeYear(value) {
        if (!value && value !== 0) return null;
        if (typeof value === 'number') return String(value);
        if (typeof value !== 'string') return null;

        const v = value.trim();
        if (v === '') return null;

        // Dokładny rok
        if (/^\d{4}$/.test(v)) return v;

        // Pełna data ISO YYYY-MM-DD -> zwróć rok
        if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v.substr(0, 4);

        // Zakresy jak 2008-2013 lub 2025-teraz - zostaw bez zmian
        if (/^\d{4}-\d{4}$/.test(v) || /^\d{4}-\D+/.test(v)) return v;

        // Spróbuj sparsować jako data i wyciągnąć rok
        const d = new Date(v);
        if (!isNaN(d.getTime())) return String(d.getFullYear());

        // Wypatruj pierwszego wystąpienia czterech cyfr (fallback)
        const m = v.match(/\d{4}/);
        return m ? m[0] : v;
    }

    // Bezpieczne sprawdzenie roku: odrzucaj oczywiste błędy (np. -4707)
    safeYear(value) {
        const currentYear = new Date().getFullYear();
        let y = null;
        if (typeof value === 'number') y = value;
        else if (typeof value === 'string') {
            const parsed = parseInt(value, 10);
            if (!Number.isNaN(parsed)) y = parsed;
        }

        if (!y) return null;
        if (y < 1800 || y > currentYear + 5) return null;
        return String(y);
    }

    // Zwraca poprawny URL plakatu z obiektu (PRIORYTET: `poster_url` z bazy).
    // Jeśli brak, generuje placeholder używając placehold.co (z tytułem filmu).
    // Zapisuje znormalizowany URL do `item.poster` dla wygody frontendu.
    getPosterUrl(item) {
        if (!item) return 'https://placehold.co/200x300/cccccc/666666/png?text=Brak';

        // Preferuj poster_url z bazy danych
        let poster = item.poster_url || item.posterUrl || item.poster || null;
        
        // Normalizuj na https
        if (poster && poster.startsWith('http://')) {
            poster = poster.replace('http://', 'https://');
        }
        
        // Jeśli brak postera, użyj placeholder
        if (!poster) {
            const title = item.title || item.name || 'Movie';
            poster = `https://placehold.co/200x300/cccccc/666666/png?text=${encodeURIComponent(title)}`;
        }
        
        return poster;
    }

    shorten(text, max = 150) {
        if (!text) return '';
        if (text.length <= max) return text;
        return text.substr(0, max - 1).trim() + '…';
    }

    // Rozdziel i znormalizuj gatunki rozdzielone przecinkami, średnikami lub pionowymi kreskami, przechowywane w bazie danych
    parseGenres(genreField) {
        if (!genreField) return [];
        if (Array.isArray(genreField)) {
            // Spłaszcz tablicę i znormalizuj każdy element
            const arr = genreField.map(g => (typeof g === 'string' ? g : '')).filter(Boolean);
            if (arr.length === 0) return [];
            // Przetwórz każdy element jako osobny ciąg znaków, aby połączyć tokeny
            const tokens = arr.map(s => {
                return this.parseGenres(s);
            }).flat();
            return Array.from(new Set(tokens));
        }
        if (typeof genreField !== 'string') return [];
        // Podziel według przecinków, średników lub pionowych kresek
        const parts = genreField.split(/[,;|]+/).map(s => s.trim()).filter(Boolean);
        // Normalizuj popularne wartości (np. Science_fiction -> Sci-Fi) i usuń podkreślenia
        const map = {
            'science_fiction': 'Sci-Fi',
            'science fiction': 'Sci-Fi',
            'sci-fi': 'Sci-Fi',
            'sci fi': 'Sci-Fi',
            'dramat': 'Dramat',
            'drama': 'Dramat',
            'komedia': 'Komedia',
            'horror': 'Horror',
            'akcja': 'Akcja'
        };
        // Znormalizuj i usuń duplikaty
        const normalized = parts.map(p => {
            const key = p.toLowerCase().replace(/_/g, ' ').trim();
            return map[key] || p.replace(/_/g, ' ');
        });
        return Array.from(new Set(normalized));
    }

    // Porównanie gatunków bez rozróżniania wielkości liter: zwraca true, gdy 'filter' znajduje się w ciągu gatunków item
    genreMatches(itemGenre, filterGenre) {
        if (!filterGenre) return true;
        if (!itemGenre) return false;
        const tokens = this.parseGenres(itemGenre).map(t => t.toLowerCase());
        return tokens.includes(filterGenre.toLowerCase());
    }

    async loadFriends() {
        try {
            const response = await fetch('/api/friends?status=accepted', {
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error('Nie udało się załadować znajomych');
            }

            const friends = await response.json();
            this.displayFriends(friends);
            this.updateFriendsStats(friends.length);
        } catch (error) {
            console.error('Error loading friends:', error);
            this.displayFriends([]);
            this.updateFriendsStats(0);
        }
    }

    displayFriends(friends) {
        const container = document.getElementById('friends-list');
        if (!container) return;
        const headerAddBtn = document.getElementById('add-friend-btn');

        if (friends.length === 0) {
            // Ukryj przycisk dodawania w nagłówku, aby uniknąć duplikacji z akcją w stanie pustym
            if (headerAddBtn) headerAddBtn.style.display = 'none';

            container.innerHTML = `
                <div class="empty-state">
                    <i class="fas fa-user-friends"></i>
                    <p class="empty-state-text">Nie masz jeszcze znajomych</p>
                    <button class="btn btn-primary" onclick="document.getElementById('add-friend-btn').click()">
                        Dodaj znajomego
                    </button>
                </div>
            `;
            // wyśrodkuj zawartość kontenera
            container.classList.add('empty-center');
            return;
        }

        // W trakcie normalnego wyświetlania znajomych, pokaż przycisk dodawania w nagłówku
        if (headerAddBtn) headerAddBtn.style.display = '';
        container.classList.remove('empty-center');

        container.innerHTML = friends.map(friend => `
            <div class="friend-card">
                <img src="${friend.avatar_url || '/images/default-avatar.png'}" alt="${friend.nickname}">
                    <div class="friend-info">
                    <h4>${friend.nickname}</h4>
                    <p>${friend.total_movies || 0} filmów&nbsp;&bull;&nbsp;${friend.total_series || 0}&nbsp;seriali</p>
                </div>
                <div class="friend-actions">
                    <button type="button" class="btn-icon" onclick="app.viewFriendProfile(${friend.user_id})" title="Zobacz profil">
                        <i class="fas fa-eye"></i>
                    </button>
                    <button class="btn-icon btn-danger" onclick="app.removeFriend(${friend.friendship_id}, 'friend')" title="Usuń znajomego">
                        <i class="fas fa-user-times"></i>
                    </button>
                </div>
            </div>
        `).join('');
    }

    updateFriendsStats(count) {
        const statsCount = document.getElementById('friends-count');
        if (statsCount) {
            statsCount.textContent = count;
        }
    }

    async loadFriendRequests() {
        try {
            const response = await fetch('/api/friends?status=pending', {
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error('Nie udało się załadować zaproszeń');
            }

            const requests = await response.json();
            // Filtruj tylko zaproszenia otrzymane (nie wysłane)
            const receivedRequests = requests.filter(r => r.request_direction === 'received');
            
            // Zaktualizuj licznik
            const pendingCount = document.getElementById('pending-requests-count');
            if (pendingCount) {
                pendingCount.textContent = receivedRequests.length;
            }
            
            this.displayFriendRequests(receivedRequests);
        } catch (error) {
            console.error('Error loading friend requests:', error);
            this.displayFriendRequests([]);
        }
    }

    displayFriendRequests(requests) {
        const container = document.getElementById('friend-requests-list');
        const section = document.getElementById('friend-requests-section');
        
        if (!container) return;

        if (requests.length === 0) {
            if (section) section.style.display = 'none';
            return;
        }

        if (section) section.style.display = 'block';

        container.innerHTML = requests.map(request => `
            <div class="friend-request-item">
                <img src="${request.avatar_url || '/images/default-avatar.png'}" alt="${request.nickname}">
                <div class="request-info">
                    <h4>${request.nickname}</h4>
                    <p>Wysłano ${this.formatDate(request.requested_at)}</p>
                </div>
                <div class="request-actions">
                    <button class="btn btn-primary btn-sm" onclick="app.acceptFriendRequest(${request.friendship_id})">
                        Akceptuj
                    </button>
                    <button class="btn btn-secondary btn-sm" onclick="app.rejectFriendRequest(${request.friendship_id})">
                        Odrzuć
                    </button>
                </div>
            </div>
        `).join('');
    }

    openAddFriendModal() {
        const modal = document.getElementById('add-friend-modal');
        if (modal) {
            // Użyj display block zamiast klasy, aby uniknąć konfliktów z animacjami
            modal.style.display = 'block';
            const searchInput = document.getElementById('friend-search-input');
            if (searchInput) searchInput.focus();
        }
    }

    closeAddFriendModal() {
        const modal = document.getElementById('add-friend-modal');
        if (modal) {
            modal.style.display = 'none';
            const searchInput = document.getElementById('friend-search-input');
            if (searchInput) searchInput.value = '';
            document.getElementById('friend-search-results').innerHTML = '';
        }
    }

    async searchUsers(query) {
        try {
            const resultsContainer = document.getElementById('friend-search-results');
            console.log('[searchUsers] Query:', query);
            const response = await fetch(`/api/users/search?q=${encodeURIComponent(query)}&limit=10`, {
                headers: this.getAuthHeaders()
            });
            console.log('[searchUsers] Response status:', response.status);

            if (!response.ok) {
                // Jeśli brak autoryzacji, pokaż komunikat
                if (response.status === 401) {
                    if (resultsContainer) resultsContainer.innerHTML = '<p class="search-error">Wymagana autoryzacja - zaloguj się.</p>';
                    console.warn('[searchUsers] Unauthorized (401)');
                    return;
                }
                // Pokaż komunikat błędu w UI
                if (resultsContainer) resultsContainer.innerHTML = '<p class="search-error">Błąd wyszukiwania</p>';
                throw new Error('Nie udało się wyszukać użytkowników');
            }

            let data;
            try {
                data = await response.json();
            } catch (e) {
                console.warn('[searchUsers] Failed to parse JSON response', e);
                if (resultsContainer) resultsContainer.innerHTML = '<p class="search-error">Błąd odczytu odpowiedzi</p>';
                return;
            }
            console.log('[searchUsers] Response data:', data);
            // Obsłuż różne formaty odpowiedzi: tablica, { results: [] }, { users: [] }, { data: [] }
            let users = [];
            if (Array.isArray(data)) {
                users = data;
            } else if (Array.isArray(data.results)) {
                users = data.results;
            } else if (Array.isArray(data.users)) {
                users = data.users;
            } else if (Array.isArray(data.data)) {
                users = data.data;
            } else if (Array.isArray(data.items)) {
                users = data.items;
            } else {
                // próbuj znaleźć pierwszą tablicę wewnątrz obiektu
                for (const k of Object.keys(data || {})) {
                    if (Array.isArray(data[k])) {
                        users = data[k];
                        break;
                    }
                }
            }

            this.displayFriendSearchResults(users || []);
        } catch (error) {
            console.error('Error searching users:', error);
            const resultsContainer = document.getElementById('friend-search-results');
            if (resultsContainer) resultsContainer.innerHTML = '<p class="search-error">Błąd wyszukiwania</p>';
        }
    }

    displayFriendSearchResults(users) {
        const container = document.getElementById('friend-search-results');
        if (!container) return;
        // Upewnij się, że mamy tablicę
        if (!Array.isArray(users)) users = [];

        if (users.length === 0) {
            container.innerHTML = '<p class="no-results">Nie znaleziono użytkowników</p>';
            return;
        }

        container.innerHTML = users.map(user => {
            const avatar = user.avatar_url || user.avatar || user.avatarUrl || '/images/default-avatar.png';
            const nickname = user.nickname || user.name || user.login || 'Użytkownik';
            const description = user.description || 'Brak opisu';
            const id = user.id || user.user_id || user.userId || user.uid || 0;
            const normalized = { ...user, id, avatar_url: avatar, nickname };
            return `
                <div class="user-search-item" data-user-id="${id}">
                <img src="${avatar}" alt="${nickname}" class="user-search-avatar">
                <div class="user-search-info">
                        <div class="user-search-name">${nickname}</div>
                        <div class="user-search-description">${description}</div>
                        <div class="user-search-stats">${normalized.total_movies || 0} filmów&nbsp;&bull;&nbsp;${normalized.total_series || 0}&nbsp;seriali</div>
                    </div>
                ${this.getFriendshipButton(normalized)}
            </div>
        `}).join('');
    }

    getFriendshipButton(user) {
        const status = user.friendship_status || user.friendshipStatus || null;
        const friendshipId = user.friendship_id || user.friendshipId || null;
        const direction = user.friendship_direction || user.friendshipDirection || null;
        if (status === 'accepted') {
            return '<span class="friendship-status accepted">Znajomy</span>';
        } else if (status === 'pending') {
            if (direction === 'sent') {
                return `<span class="friendship-status pending">Oczekujące</span> <button class="btn btn-danger btn-sm" onclick="app.removeFriend(${friendshipId}, 'invitation')">Anuluj</button>`;
            }
            return '<span class="friendship-status pending">Oczekujące</span>';
        } else if (status === 'rejected') {
            // Jeśli odrzucenie zostało wykonane przez nas, pozwól na ponowne wysłanie
            if (friendshipId) {
                return `<span class="friendship-status rejected">Odrzucone</span> <button class="btn btn-secondary btn-sm" onclick="app.dismissRejected(${friendshipId}, ${user.id})">Potwierdź odrzucenie</button> <button class="btn btn-primary btn-sm" onclick="app.sendFriendRequest(${user.id})">Wyślij ponownie</button>`;
            }
            return `<span class="friendship-status rejected">Odrzucone</span> <button class="btn btn-primary btn-sm" onclick="app.sendFriendRequest(${user.id})">Wyślij ponownie</button>`;
        } else if (status === 'blocked') {
            return '<span class="friendship-status blocked">Zablokowany</span>';
        } else {
            return `<button class="btn btn-primary btn-sm" onclick="app.sendFriendRequest(${user.id})">Dodaj</button>`;
        }
    }

    async sendFriendRequest(userId) {
        try {
            // Wyłącz przycisk wysyłania, jeśli dostępny
            try {
                const el = document.querySelector(`.user-search-item[data-user-id="${userId}"]`);
                if (el) {
                    const btn = el.querySelector('button');
                    if (btn) {
                        btn.disabled = true;
                        btn.textContent = 'Wysyłanie...';
                    }
                }
            } catch (e) { /* ignore */ }
            const response = await fetch('/api/friends', {
                method: 'POST',
                headers: {
                    ...this.getAuthHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ friendId: userId })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Nie udało się wysłać zaproszenia');
            }

            const body = await response.json().catch(() => ({}));

            // Odśwież wyniki wyszukiwania
            const query = document.getElementById('friend-search-input').value;
            if (query) {
                await this.searchUsers(query);
            }

            // Odśwież profil aby zaktualizować licznik oczekujących
            if (this.currentSection === 'profile') {
                await this.loadProfileData();
            }
            // Jeśli modal profilu znajomego jest otwarty, przeładuj go, aby zaktualizować kontrolki
            if (document.getElementById('friend-profile-modal')) {
                await this.viewFriendProfile(userId);
            }

            if (body && body.resent) {
                this.showNotification('Zaproszenie wysłane ponownie!', 'success');
            } else {
                this.showNotification('Zaproszenie zostało wysłane!', 'success');
            }
        } catch (error) {
            console.error('Error sending friend request:', error);
            // Przywróć przycisk dodawania w przypadku błędu
            try {
                const el = document.querySelector(`.user-search-item[data-user-id="${userId}"]`);
                if (el) {
                    const btn = el.querySelector('button');
                    if (btn) {
                        btn.disabled = false;
                        btn.textContent = 'Dodaj';
                    }
                }
            } catch (e) { /* ignore */ }
            this.showNotification('Błąd: ' + error.message, 'error');
        }
    }

    async acceptFriendRequest(friendshipId, userId) {
        try {
            const response = await fetch('/api/friends', {
                method: 'PUT',
                headers: {
                    ...this.getAuthHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    friendshipId: friendshipId,
                    action: 'accept'
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Nie udało się zaakceptować zaproszenia');
            }

            // Odśwież listy
            await Promise.all([
                this.loadFriends(),
                this.loadFriendRequests()
            ]);
            // Jeżeli otwarty był profil, odśwież dane profilu
            if (userId && document.getElementById('friend-profile-modal')) {
                await this.viewFriendProfile(userId);
            }

            alert('Zaproszenie zostało zaakceptowane!');
        } catch (error) {
            console.error('Error accepting friend request:', error);
            alert('Błąd: ' + error.message);
        }
    }

    async rejectFriendRequest(friendshipId, userId) {
        try {
            const response = await fetch('/api/friends', {
                method: 'PUT',
                headers: {
                    ...this.getAuthHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ 
                    friendshipId: friendshipId,
                    action: 'reject'
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Nie udało się odrzucić zaproszenia');
            }

            // Odśwież listę zaproszeń
            await this.loadFriendRequests();
            if (userId && document.getElementById('friend-profile-modal')) {
                await this.viewFriendProfile(userId);
            }

            alert('Zaproszenie zostało odrzucone');
        } catch (error) {
            console.error('Error rejecting friend request:', error);
            alert('Błąd: ' + error.message);
        }
    }

    async removeFriend(friendshipId, context = 'friend') {
        const isInvitation = context === 'invitation';
        const title = isInvitation ? 'Anuluj zaproszenie' : 'Usuń znajomego';
        const message = isInvitation ? 'Czy na pewno chcesz anulować to zaproszenie?' : 'Czy na pewno chcesz usunąć tego znajomego?';
        if (!(await this.showConfirm(message, title))) {
            return;
        }

        try {
            const response = await fetch('/api/friends', {
                method: 'DELETE',
                headers: {
                    ...this.getAuthHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({ friendshipId: friendshipId })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Nie udało się usunąć znajomego');
            }

            // Odśwież listę znajomych
            await this.loadFriends();
            // Odśwież search results if search is open
            const qInput = document.getElementById('friend-search-input');
            if (qInput && qInput.value && qInput.value.length > 1) {
                await this.searchUsers(qInput.value);
            }
            // Jeżeli otwarty był profil, odśwież dane profilu
            if (this.currentSection === 'profile') await this.loadProfileData();

            this.showNotification(isInvitation ? 'Zaproszenie zostało anulowane' : 'Znajomy został usunięty', 'success');
        } catch (error) {
            console.error('Error removing friend:', error);
            alert('Błąd: ' + error.message);
        }
    }

    // Potwierdź odrzucenie zaproszenia, aby umożliwić ponowne wysłanie
    async dismissRejected(friendshipId, userId) {
        try {
            const response = await fetch('/api/friends', {
                method: 'DELETE',
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ friendshipId })
            });
            if (!response.ok) {
                const err = await response.json().catch(() => ({}));
                throw new Error(err.error || 'Błąd usuwania rekordu');
            }

            this.showNotification('Odrzucenie zostało potwierdzone. Możesz ponownie wysłać zaproszenie.', 'success');
            // Odśwież widok: search results, friends, and profile modal
            await Promise.all([
                this.loadFriends(),
                this.loadFriendRequests(),
            ]);
            // Odśwież wyniki wyszukiwania, jeśli są otwarte
            const qInput = document.getElementById('friend-search-input');
            if (qInput && qInput.value && qInput.value.length > 1) {
                await this.searchUsers(qInput.value);
            }
            // Jeśli modal profilu znajomego jest otwarty, przeładuj go, aby zaktualizować kontrolki; w przeciwnym razie upewnij się, że dane profilu są odświeżone dla bieżącego użytkownika
            if (document.getElementById('friend-profile-modal')) {
                // ponownie otwórz profil dla tego samego userId, aby odświeżyć przyciski
                await this.viewFriendProfile(userId);
            } else if (this.currentSection === 'profile') {
                await this.loadProfileData();
            }
        } catch (error) {
            console.error('Error dismissing rejected friend request', error);
            this.showNotification('Błąd: ' + error.message, 'error');
        }
    }

    async viewFriendProfile(userId) {
        console.log('[viewFriendProfile] called for userId:', userId);
        if (!userId) {
            this.showNotification('Nieprawidłowe ID użytkownika', 'error');
            return;
        }

        try {
            const response = await fetch(`/api/users/${userId}`, {
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                // Spróbuj wyodrębnić komunikat o błędzie z odpowiedzi JSON
                let errMsg = 'Nie udało się pobrać profilu użytkownika';
                try {
                    const json = await response.json();
                    if (json && json.error) errMsg = json.error;
                } catch (e) { /* ignore invalid json */ }
                throw new Error(errMsg);
            }

            const profile = await response.json();
            console.log('[viewFriendProfile] profile loaded', profile);
            this.showFriendProfileModal(profile);
        } catch (error) {
            console.error('Error loading friend profile:', error);
            this.showNotification('Błąd podczas ładowania profilu: ' + (error.message || ''), 'error');
        }
    }

    showFriendProfileModal(profile) {
        // Normalizuj dane profilu
        profile = profile || {};
        profile.badges = Array.isArray(profile.badges) ? profile.badges : (profile.badges || []);
        profile.recentActivity = Array.isArray(profile.recentActivity) ? profile.recentActivity : (profile.recentActivity || []);
        profile.stats = profile.stats || {};

        const avatar = profile.avatar_url || '/images/default-avatar.png';
        const memberSince = new Date(profile.created_at).toLocaleDateString('pl-PL', { 
            year: 'numeric', 
            month: 'long' 
        });

        const badgesHtml = (profile.badges || []).length > 0
            ? profile.badges.map(badge => `
                <div class="badge-item" title="${badge.description}">
                    <i class="fas ${badge.image_url || 'fa-award'}"></i>
                    <span>${badge.name}</span>
                    ${badge.level && badge.level !== 'none' ? `<span class="badge-level">${badge.level}</span>` : ''}
                </div>
            `).join('')
            : '<p class="no-badges">Brak odznak</p>';

        const recentActivityHtml = (profile.recentActivity || []).length > 0
            ? profile.recentActivity.map(item => {
                const poster = this.getPosterUrl(item);
                const stars = item.rating ? '★'.repeat(item.rating) + '☆'.repeat(5 - item.rating) : 'Brak oceny';
                return `
                    <div class="activity-item">
                        <img src="${poster}" alt="${item.title}">
                        <div class="activity-info">
                            <h4>${item.title}</h4>
                            <p>Obejrzano: ${this.formatDate(item.watched_date)}</p>
                            ${item.rating ? `<p>Ocena: ${stars}</p>` : ''}
                        </div>
                    </div>
                `;
            }).join('')
            : '<p class="no-activity">Brak ostatniej aktywności</p>';

        const modalHtml = `
            <div class="modal active" id="friend-profile-modal" role="dialog" aria-modal="true" aria-labelledby="friend-profile-title">
                <div class="modal-content profile-modal">
                    <button class="fpm-close" onclick="app.closeFriendProfileModal()" aria-label="Zamknij">&times;</button>

                    <!-- GÓRNY PASEK: avatar + info + przyciski -->
                    <div class="fpm-header">
                        <img src="${avatar}" alt="${profile.nickname}" class="fpm-avatar">
                        <div class="fpm-info">
                            <h2 id="friend-profile-title">${profile.nickname}</h2>
                            ${profile.friendship ? `<span class="friendship-status ${profile.friendship.status}">${profile.friendship.status === 'pending' ? 'Oczekujące' : profile.friendship.status === 'accepted' ? 'Znajomi' : profile.friendship.status === 'rejected' ? 'Odrzucone' : profile.friendship.status}</span>` : ''}
                            <p class="fpm-desc">${profile.description || ''}</p>
                            <p class="fpm-since"><i class="fas fa-calendar-alt"></i> Członek od ${memberSince}</p>
                        </div>
                        <div class="fpm-actions">
                            ${this.getProfileFriendshipControls(profile)}
                        </div>
                    </div>

                    <!-- STATYSTYKI - jeden rząd -->
                    <div class="fpm-stats">
                        <div class="fpm-stat">
                            <i class="fas fa-film"></i>
                            <strong>${profile.stats.watchedMovies || 0}</strong>
                            <span>Filmy</span>
                        </div>
                        <div class="fpm-stat">
                            <i class="fas fa-tv"></i>
                            <strong>${profile.stats.watchedSeries || 0}</strong>
                            <span>Seriale</span>
                        </div>
                        <div class="fpm-stat">
                            <i class="fas fa-eye"></i>
                            <strong>${profile.stats.watching || 0}</strong>
                            <span>Oglądane</span>
                        </div>
                        <div class="fpm-stat">
                            <i class="fas fa-calendar"></i>
                            <strong>${profile.stats.planning || 0}</strong>
                            <span>Planowane</span>
                        </div>
                        <div class="fpm-stat">
                            <i class="fas fa-user-friends"></i>
                            <strong>${profile.stats.friends || 0}</strong>
                            <span>Znajomi</span>
                        </div>
                    </div>

                    <!-- DOLNA CZĘŚĆ: odznaki (lewo) + aktywność ze scrollem (prawo) -->
                    <div class="fpm-body">
                        <div class="fpm-badges-col">
                            <h3 class="fpm-section-title"><i class="fas fa-award"></i> Odznaki</h3>
                            <div class="fpm-badges-row">
                                ${badgesHtml}
                            </div>
                        </div>
                        <div class="fpm-activity-col">
                            <h3 class="fpm-section-title"><i class="fas fa-clock"></i> Ostatnia aktywność</h3>
                            <div class="fpm-activity-scroll">
                                ${recentActivityHtml}
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        `;

        // Usuń poprzedni modal jeśli istnieje
        const existingModal = document.getElementById('friend-profile-modal');
        if (existingModal) {
            existingModal.remove();
        }

        // Dodaj nowy modal do body
        document.body.insertAdjacentHTML('beforeend', modalHtml);

        // Zamknij modal po kliknięciu poza nim
        const modal = document.getElementById('friend-profile-modal');
        // Pokaż modal (użyj display block zamiast klasy, aby uniknąć konfliktów z animacjami)
        try { modal.style.display = 'block'; } catch (e) {}
        // Zablokuj przewijanie tła
        try { document.body.style.overflow = 'hidden'; } catch (e) {}
        const modalContent = modal.querySelector('.modal-content');
        if (modalContent) {
            modalContent.setAttribute('tabindex', '-1');
            modalContent.focus();
        }
        // Dostosuj dla urządzeń mobilnych
        if (window.innerWidth <= 520) modal.classList.add('mobile');
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                this.closeFriendProfileModal();
            }
        });
    }

    getProfileFriendshipControls(profile) {
        // profile.friendship: { id, status, direction }
        const f = profile.friendship || null;
        if (!f) {
            return `<button class="btn btn-primary" onclick="app.sendFriendRequest(${profile.id})">Dodaj znajomego</button>`;
        }

        switch (f.status) {
            case 'pending':
                if (f.direction === 'received') {
                    return `
                        <button class="btn btn-primary" onclick="app.acceptFriendRequest(${f.id}, ${profile.id})">Akceptuj</button>
                        <button class="btn btn-secondary" onclick="app.rejectFriendRequest(${f.id}, ${profile.id})">Odrzuć</button>
                    `;
                }
                // 'sent' 
                return `<span class="friendship-status pending">Oczekujące</span> <button class="btn btn-danger" onclick="app.removeFriend(${f.id}, 'invitation')">Anuluj</button>`;
            case 'rejected':
                // Pozwól na ponowne wysłanie zaproszenia
                return `<span class="friendship-status rejected">Odrzucone</span> <button class="btn btn-secondary" onclick="app.dismissRejected(${f.id}, ${profile.id})">Potwierdź odrzucenie</button> <button class="btn btn-primary" onclick="app.sendFriendRequest(${profile.id})">Wyślij ponownie</button>`;
            case 'accepted':
                // Nie pokazujemy nic dla znajomych - przycisk jest w sekcji profilu
                return '';
            case 'blocked':
                return `<span class="friendship-status blocked">Zablokowany</span>`;
            default:
                return `<button class="btn btn-primary" onclick="app.sendFriendRequest(${profile.id})">Dodaj znajomego</button>`;
        }
    }

    closeFriendProfileModal() {
        const modal = document.getElementById('friend-profile-modal');
        if (modal) {
            modal.classList.remove('active');
            try { document.body.style.overflow = ''; } catch (e) {}
            setTimeout(() => modal.remove(), 300);
        }
    }

    formatDate(dateString) {
        const date = new Date(dateString);
        const now = new Date();
        const diff = now - date;
        const days = Math.floor(diff / (1000 * 60 * 60 * 24));

        if (days === 0) return 'Dzisiaj';
        if (days === 1) return 'Wczoraj';
        if (days < 7) return `${days} dni temu`;
        if (days < 30) return `${Math.floor(days / 7)} tyg. temu`;
        if (days < 365) return `${Math.floor(days / 30)} mies. temu`;
        return date.toLocaleDateString('pl-PL');
    }

    showChangePasswordModal() {
        // Customowy modal do zmiany hasła
        const modalHtml = `
            <div class="modal active" id="change-password-modal">
                <div class="modal-content">
                    <h2>Zmiana hasła</h2>
                    <form id="change-password-form">
                        <div class="form-group">
                            <label>Obecne hasło</label>
                            <input type="password" id="current-password" required>
                        </div>
                        <div class="form-group">
                            <label>Nowe hasło</label>
                            <input type="password" id="new-password" required minlength="6">
                            <small style="color: var(--text-secondary); display: block; margin-top: 0.25rem;">
                                Hasło musi mieć minimum 6 znaków
                            </small>
                        </div>
                        <div class="form-group">
                            <label>Potwierdź nowe hasło</label>
                            <input type="password" id="confirm-password" required minlength="6">
                        </div>
                        <div class="modal-actions">
                            <button type="button" class="btn-secondary" id="cancel-password-change">Anuluj</button>
                            <button type="submit" class="btn-primary">Zmień hasło</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        const modal = document.getElementById('change-password-modal');
        const form = document.getElementById('change-password-form');
        const cancelBtn = document.getElementById('cancel-password-change');
        
        const closeModal = () => modal.remove();
        
        cancelBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const currentPassword = document.getElementById('current-password').value;
            const newPassword = document.getElementById('new-password').value;
            const confirmPassword = document.getElementById('confirm-password').value;
            
            if (newPassword !== confirmPassword) {
                this.showNotification('Hasła nie są identyczne!', 'error');
                return;
            }
            
            if (newPassword.length < 6) {
                this.showNotification('Nowe hasło musi mieć minimum 6 znaków!', 'error');
                return;
            }
            
            // Wywołanie API zmiany hasła
            const success = await this.changePassword(currentPassword, newPassword);
            if (success) {
                closeModal();
            }
        });
    }

    showDeleteAccountModal() {
        // Customowy modal do usuwania konta
        const modalHtml = `
            <div class="modal active" id="delete-account-modal">
                <div class="modal-content">
                    <h2 style="color: #dc3545;">⚠️ Usuń konto</h2>
                    <p><strong>UWAGA! Ta operacja jest nieodwracalna!</strong></p>
                    <p>Wszystkie Twoje dane, filmy, recenzje i postępy zostaną trwale usunięte.</p>
                    <form id="delete-account-form">
                        <div class="form-group">
                            <label>Aby potwierdzić, wpisz: <strong>USUN KONTO</strong></label>
                            <input type="text" id="delete-confirmation" required placeholder="USUN KONTO">
                        </div>
                        <div class="modal-actions">
                            <button type="button" class="btn-secondary" id="cancel-delete">Anuluj</button>
                            <button type="submit" class="btn-danger">Usuń konto</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
        
        document.body.insertAdjacentHTML('beforeend', modalHtml);
        
        const modal = document.getElementById('delete-account-modal');
        const form = document.getElementById('delete-account-form');
        const cancelBtn = document.getElementById('cancel-delete');
        
        const closeModal = () => modal.remove();
        
        cancelBtn.addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });
        
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            
            const confirmation = document.getElementById('delete-confirmation').value;
            
            if (confirmation === 'USUN KONTO') {
                closeModal();
                this.deleteAccount();
            } else {
                this.showNotification('Nieprawidłowe potwierdzenie. Konto nie zostało usunięte.', 'error');
            }
        });
    }

    async changePassword(currentPassword, newPassword) {
        try {
            const response = await fetch('/api/auth/password', {
                method: 'PUT',
                headers: {
                    ...this.getAuthHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    currentPassword,
                    newPassword
                })
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Nie udało się zmienić hasła');
            }

            this.showNotification('Hasło zostało zmienione pomyślnie!', 'success');
            return true;
        } catch (error) {
            console.error('Error changing password:', error);
            this.showNotification('Błąd: ' + error.message, 'error');
            return false;
        }
    }

    async deleteAccount() {
        try {
            const response = await fetch('/api/auth/delete', {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                const error = await response.json();
                throw new Error(error.error || 'Nie udało się usunąć konta');
            }

            this.showNotification('Konto zostało usunięte. Żegnamy!', 'success');
            setTimeout(() => this.logout(), 1500);
        } catch (error) {
            console.error('Error deleting account:', error);
            this.showNotification('Błąd podczas usuwania konta: ' + error.message, 'error');
        }
    }

    // ============= KONIEC FUNKCJI PROFILU =============


    async loadMoviesData() {
        // Odśwież listę top filmów równolegle z ładowaniem danych użytkownika
        this.loadTopMovies('popularity', 0, false);

        try {
            // Załaduj WSZYSTKIE filmy (obejrzane, oglądane, planowane, porzucone)
            const response = await fetch('/api/movies?status=all', {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                this.watchedMovies = await response.json();
                // Znormalizuj pole `year` dla wygodnego wyświetlania w UI.
                this.watchedMovies = this.watchedMovies.map(item => {
                    const raw = item.release_date || item.releaseDate || null;
                    // Prefer numeric `item.year` provided by the API when it's valid
                    let normalized = null;
                    if (typeof item.year === 'number' && this.safeYear(item.year)) {
                        normalized = String(item.year);
                    } else if (typeof item.year === 'string' && /^\d{4}$/.test(item.year)) {
                        normalized = item.year;
                    } else if (raw) {
                        normalized = this.normalizeYear(raw);
                    } else {
                        normalized = null;
                    }
                    // Normalizuj pole plakatu - użyj poster_url z bazy danych
                    let poster = item.poster_url || item.poster || item.posterUrl || null;
                    if (poster && poster.startsWith('http://')) {
                        poster = poster.replace('http://', 'https://');
                    }
                    if (!poster) {
                        console.warn('Movie item missing poster for', item.id, item.title);
                        poster = `https://placehold.co/200x300/cccccc/666666/png?text=${encodeURIComponent(item.title || 'Movie')}`;
                    }

                    // Normalizuj pola seriali: liczba sezonów/odcinków, średnia długość odcinka
                    let avgEp = item.avg_episode_length || item.avgEpisodeLength || item.average_episode_length || item.episode_length || item.episodeLength || item.avgEpisodeMinutes || item.duration || null;
                    let totalEpisodes = item.totalEpisodes || item.total_episodes || item.episodesCount || item.episodes_total || null;
                    let totalSeasons = item.totalSeasons || item.total_seasons || null;

                    // Jeśli API zwraca strukturę seasons, policz odcinki
                    if (Array.isArray(item.seasons)) {
                        totalSeasons = totalSeasons || item.seasons.length;
                        totalEpisodes = totalEpisodes || item.seasons.reduce((acc, s) => acc + (Array.isArray(s.episodes) ? s.episodes.length : 0), 0);

                        // Jeśli nie mamy średniej długości odcinka, spróbuj policzyć ją z pól episodes[].duration
                        if (!avgEp) {
                            let sumDur = 0;
                            let cnt = 0;
                            item.seasons.forEach(s => {
                                if (Array.isArray(s.episodes)) {
                                    s.episodes.forEach(ep => {
                                        if (ep && (ep.duration || ep.duration === 0)) {
                                            sumDur += Number(ep.duration) || 0;
                                            cnt++;
                                        }
                                    });
                                }
                            });
                            if (cnt > 0) {
                                avgEp = Math.round(sumDur / cnt);
                            }
                        }
                    }

                    const watchedEpisodes = item.watchedEpisodes || item.watched_episodes || item.watched_count || item.watched || 0;

                    // Ustal ujednolicone pola na obiekcie
                    return {
                        ...item,
                        year: normalized || null,
                        poster: poster,  // Zapisz jako poster
                        poster_url: poster,  // Zapisz jako poster_url w razie potrzeby
                        description: item.description || '',
                        release_date: item.release_date || null,
                        avgEpisodeLength: avgEp ? Number(avgEp) : null,
                        totalEpisodes: totalEpisodes ? Number(totalEpisodes) : (item.totalEpisodes ? Number(item.totalEpisodes) : null),
                        totalSeasons: totalSeasons ? Number(totalSeasons) : (item.totalSeasons ? Number(item.totalSeasons) : null),
                        watchedEpisodes: Number(watchedEpisodes) || 0
                    };
                });
            } else {
                console.warn('Failed to load movies from API, using empty array');
                this.watchedMovies = [];
            }
        } catch (error) {
            console.error('Error loading movies:', error);
            this.watchedMovies = [];
        }
        
        this.updateStats();
        this.displayRecentActivity();
        this.displayMyList(this.currentListStatus);
        this.loadRecommendations();
        // Wypełnij filtry gatunków na podstawie załadowanych filmów
        try { this.populateGenreFilterFromList(this.watchedMovies); } catch (e) { /* ignore */ }
        // Odśwież globalne gatunki również (obsługuje aktualizacje/nowe wpisy administratora)
        try { await this.loadGenres(); } catch (e) { /* ignore */ }
    }

    // Wypełnij `#genre-filter` unikalnymi gatunkami znalezionymi na podstawie podanej listy (dodaje do istniejących opcji, zapewnia odpowiednie etykiety)
    populateGenreFilterFromList(list) {
        if (!Array.isArray(list)) return;
        const selectIds = ['genre-filter', 'list-genre-filter'];
        const found = new Set();
        list.forEach(item => {
            const genres = this.parseGenres(item.genre || '');
            // Normalizuj i dodaj do zbioru
            genres.map(g => g.trim()).filter(Boolean).forEach(g => found.add(g));
        });

        // Sortuj alfabetycznie i dodaj do selectów
        const values = Array.from(found).sort((a,b) => a.localeCompare(b, 'pl'));
        selectIds.forEach(id => {
            const genreSelect = document.getElementById(id);
            if (!genreSelect) return;
            const existingDisplay = new Set(Array.from(genreSelect.options).map(o => (o.textContent || o.value || '').toLowerCase().trim()));
            values.forEach(g => {
                if (!existingDisplay.has(g.toLowerCase())) {
                    const opt = document.createElement('option');
                    opt.value = g;
                    opt.textContent = g;
                    genreSelect.appendChild(opt);
                }
            });
        });
    }

    displayMyList(filterStatus = 'all') {
        const listContainer = document.getElementById('my-list-content');
        if (!listContainer) {
            console.error('Lista container not found');
            return;
        }

        let filteredItems = this.watchedMovies;
        
        // Filtruj po statusie
        if (filterStatus !== 'all') {
            filteredItems = filteredItems.filter(item => item.status === filterStatus);
        }

        // Filtruj po typie (film/serial)
        const typeFilter = document.getElementById('list-type-filter');
        if (typeFilter && typeFilter.value) {
            filteredItems = filteredItems.filter(item => item.type === typeFilter.value);
        }

        // Filtruj po gatunku
        const genreFilter = document.getElementById('list-genre-filter');
        if (genreFilter && genreFilter.value) {
            filteredItems = filteredItems.filter(item => {
                try {
                    return this.genreMatches(item.genre, genreFilter.value);
                } catch (e) {
                    return false;
                }
            });
        }

        // Sortuj
        const sortSelect = document.getElementById('list-sort');
        if (sortSelect && sortSelect.value) {
            const sortValue = sortSelect.value;
            filteredItems = this.sortItems(filteredItems, sortValue);
        }

        listContainer.innerHTML = '';

        if (filteredItems.length === 0) {
            // Usuń klasę siatki dla pustego stanu
            listContainer.classList.remove('my-list-grid');
            listContainer.innerHTML = `
                <div class="empty-list">
                    <i class="fas fa-film"></i>
                    <h3>Brak elementów</h3>
                    <p>Nie masz jeszcze żadnych filmów lub seriali w tej kategorii.</p>
                </div>
            `;
            return;
        }

        // Dodaj klasę siatki gdy są elementy
        listContainer.classList.add('my-list-grid');

        filteredItems.forEach(item => {
            const statusBadge = this.getStatusBadge(item.status || 'watched');
            const stars = '★'.repeat(item.rating) + '☆'.repeat(5 - item.rating);
            // Użyj poster_url z bazy danych
            let poster = item.poster_url || item.poster || item.posterUrl || null;
            if (poster && poster.startsWith('http://')) {
                poster = poster.replace('http://', 'https://');
            }
            if (!poster) {
                poster = `https://placehold.co/200x300/cccccc/666666/png?text=${encodeURIComponent(item.title || 'Movie')}`;
            }

            // Wyodrębnij rok z pola release_date lub year
            let displayYear = '';
            if (item.year) {
                if (typeof item.year === 'string') {
                    const yearMatch = item.year.match(/^(\d{4})/);
                    displayYear = yearMatch ? yearMatch[1] : item.year;
                } else {
                    displayYear = String(item.year);
                }
            } else if (item.release_date) {
                const rawStr = String(item.release_date);
                if (item.type === 'series' && /[-–—]/.test(rawStr)) {
                    displayYear = rawStr;
                } else {
                    const yearMatch = rawStr.match(/^(\d{4})/);
                    displayYear = yearMatch ? yearMatch[1] : '';
                }
            }

            // Dane serialu
            const seasons = item.totalSeasons || (Array.isArray(item.seasons) ? item.seasons.length : null);
            const episodes = item.totalEpisodes || (Array.isArray(item.seasons) ? item.seasons.reduce((acc, s) => acc + (Array.isArray(s.episodes) ? s.episodes.length : 0), 0) : null);
            const avg = item.avgEpisodeLength || item.avg_episode_length || item.duration || null;

            // Tekst z typem i dodatkowymi informacjami (minuty dla filmu, sezony/odcinki dla serialu)
            const typeInfo = item.type === 'movie'
                ? (item.duration ? `${item.duration} min` : 'Film')
                : `${seasons ? seasons + ' sez.' : 'Serial'} • ${episodes ? episodes + ' odc.' : ''}${avg ? ' • śr. ' + avg + ' min' : ''}`;

            // Debugowanie brakujących danych
            if (item.type === 'movie' && !item.duration) {
                console.debug('Movie missing duration:', item.id, item.title);
            }
            if (!displayYear) {
                console.debug('Movie missing year:', item.id, item.title, item.release_date);
            }

            // Informacje o postępie dla seriali
            const progressInfo = item.type === 'series'
                ? `<p class="series-progress">
                       <i class="fas fa-tv"></i>
                       ${item.watchedEpisodes || 0}/${episodes || 0} odcinków (${item.progress || 0}%)
                       <div class="progress-bar">
                         <div class="progress-fill" style="width: ${item.progress || 0}%"></div>
                       </div>
                   </p>`
                : '';

            const viewClass = this.currentView === 'list' ? 'list-item-list' : 'list-item-grid';
            const cardGenres = this.parseGenres(item.genre).join(', ');
            const listItemHtml = `
                <div class="list-item ${viewClass}" data-status="${item.status || 'watched'}" data-id="${item.id}" data-type="${item.type}">
                    ${statusBadge}
                    <img src="${poster}" alt="${item.title}" class="list-item-poster">
                    ${this.currentView === 'list' ? `
                    <div class="list-item-info">
                        <h3>${item.title}</h3>
                        <p>${displayYear}${displayYear && (cardGenres || typeInfo) ? ' • ' : ''}${cardGenres || ''}${cardGenres && typeInfo ? ' • ' : ''}${typeInfo}</p>
                        ${item.description ? `<p class="list-item-desc">${this.shorten(item.description, 160)}</p>` : ''}
                        ${progressInfo}
                        <div class="list-item-rating">
                            <span class="stars">${stars}</span>
                            <span>${item.rating}/5</span>
                        </div>
                    </div>
                    ` : `
                    ${item.type === 'series' ? `
                    <div class="grid-series-progress">
                        <small>${item.watchedEpisodes || 0}/${episodes || 0} odc. (${item.progress || 0}%)</small>
                        <div class="progress-bar-small">
                            <div class="progress-fill" style="width: ${item.progress || 0}%"></div>
                        </div>
                    </div>
                    ` : ''}
                    `}
                </div>
            `;
            listContainer.innerHTML += listItemHtml;
        });

        // Zaktualizuj statystyki
        this.updateListStats(filteredItems.length);
    }

    getStatusBadge(status) {
        const badges = {
            'watched': '<div class="status-badge status-watched">Obejrzane</div>',
            'watching': '<div class="status-badge status-watching">Oglądane</div>',
            'planning': '<div class="status-badge status-planning">Planowane</div>',
            'dropped': '<div class="status-badge status-dropped">Porzucone</div>'
        };
        return badges[status] || badges['watched'];
    }

    updateListStats(count) {
        const statsContainer = document.querySelector('.list-stats');
        if (statsContainer) {
            statsContainer.innerHTML = `<span>Łącznie: ${count} pozycji</span>`;
        }
    }

    sortItems(items, sortValue) {
        // Sortuj elementy na podstawie wybranej opcji sortowania
        const sortedItems = [...items]; // Kopia tablicy, żeby nie modyfikować oryginału
        
        switch (sortValue) {
            case 'date-desc': // Najnowsze
                sortedItems.sort((a, b) => new Date(b.watchedDate) - new Date(a.watchedDate));
                break;
            case 'date-asc': // Najstarsze
                sortedItems.sort((a, b) => new Date(a.watchedDate) - new Date(b.watchedDate));
                break;
            case 'title-asc': // Tytuł A-Z
                sortedItems.sort((a, b) => (a.title || '').localeCompare(b.title || '', 'pl'));
                break;
            case 'title-desc': // Tytuł Z-A
                sortedItems.sort((a, b) => (b.title || '').localeCompare(a.title || '', 'pl'));
                break;
            case 'rating-desc': // Najwyżej ocenione
                sortedItems.sort((a, b) => (b.rating || 0) - (a.rating || 0));
                break;
            case 'rating-asc': // Najniżej ocenione
                sortedItems.sort((a, b) => (a.rating || 0) - (b.rating || 0));
                break;
            default:
                // Domyślnie sortuj po dacie (najnowsze)
                sortedItems.sort((a, b) => new Date(b.watchedDate) - new Date(a.watchedDate));
        }
        
        return sortedItems;
    }

    // ============= TOP MOVIES W DASHBOARDZIE =============
    async loadTopMovies(sort, page, append) {
        const CACHE_TTL = 15 * 60 * 1000; // 15 minut
        const cacheKey = `_top_${sort}_p${page}`;

        // Próbuj odczytać z localStorage (pomaga przy zimnym starcie workera)
        if (!append) {
            try {
                const raw = localStorage.getItem(cacheKey);
                if (raw) {
                    const { data, ts } = JSON.parse(raw);
                    if (Date.now() - ts < CACHE_TTL) {
                        this._topSort = sort;
                        this._topPage = page;
                        this._topHasMore = data.hasMore;
                        this.renderTopMovies(data.results, false, page);
                        return; // dane świeże - nie odpytuj serwera
                    }
                }
            } catch {}
        }

        try {
            // Bez nagłówka Authorization - top filmy są globalne (nie per-user),
            // dzięki temu Cloudflare CDN może cachować odpowiedź na poziomie edge.
            const res = await fetch(`/api/movies/top?sort=${sort}&page=${page}`);
            if (!res.ok) return;
            const data = await res.json();
            this._topSort = sort;
            this._topPage = page;
            this._topHasMore = data.hasMore;
            this.renderTopMovies(data.results, append, page);

            // Zapisz stronę 0 do localStorage jako cache
            if (page === 0) {
                try {
                    localStorage.setItem(cacheKey, JSON.stringify({ data, ts: Date.now() }));
                } catch {}
            }
        } catch (e) {
            console.error('loadTopMovies error', e);
        }
    }

    renderTopMovies(movies, append, page) {
        const container = document.getElementById('top-movies-list');
        const moreWrap = document.getElementById('top-movies-more');
        const moreBtn  = document.getElementById('top-movies-load-more');
        if (!container) return;

        if (!append) container.innerHTML = '';

        const offset = page * 40;
        movies.forEach((m, i) => {
            const rank = offset + i + 1;
            const poster = m.poster_path
                ? `https://image.tmdb.org/t/p/w200${m.poster_path}`
                : `https://placehold.co/140x210/cccccc/666666/png?text=${encodeURIComponent(m.title || '?')}`;

            let scoreLabel = '';
            if (this._topSort === 'imdb_rating') {
                scoreLabel = m.imdb_rating != null ? `⭐ IMDb ${parseFloat(m.imdb_rating).toFixed(1)}` : '';
            } else if (this._topSort === 'avg_rating') {
                scoreLabel = m.avg_user_rating != null ? `⭐ ${parseFloat(m.avg_user_rating).toFixed(1)} (${m.review_count})` : 'Brak ocen';
            } else {
                scoreLabel = m.popularity != null ? `🔥 ${parseFloat(m.popularity).toFixed(0)}` : '';
            }

            const card = document.createElement('div');
            card.className = 'top-movie-card';
            card.dataset.movieId = m.id;
            card.innerHTML = `
                <span class="top-movie-rank">#${rank}</span>
                <img src="${poster}" alt="${this.escapeHtml(m.title || '')}" loading="lazy">
                <div class="top-movie-info">
                    <div class="top-movie-title">${this.escapeHtml(m.title || '')}</div>
                    <div class="top-movie-score">${scoreLabel}</div>
                </div>
            `;
            card.addEventListener('click', () => {
                const watched = this.watchedMovies.find(w => w.id === m.id || w.movie_id === m.id);
                if (watched) {
                    this.openMovieModal(watched, false);
                } else {
                    this.openMovieModal(m, false);
                }
            });
            container.appendChild(card);
        });

        if (moreWrap) moreWrap.style.display = this._topHasMore ? 'flex' : 'none';
        if (moreBtn) {
            moreBtn.onclick = () => this.loadTopMovies(this._topSort, this._topPage + 1, true);
        }

        // Podpnij przyciski sortowania (tylko raz przy pierwszym renderze)
        if (!append) {
            document.querySelectorAll('.top-sort-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.sort === this._topSort);
                btn.onclick = () => {
                    this.loadTopMovies(btn.dataset.sort, 0, false);
                };
            });
        }
    }

    // ============= PASEK REKOMENDACJI "DLA CIEBIE" =============
    // Działa per-user: Worker (/api/movies/recommendations) czyta rekomendacje
    // bezpośrednio z bazy D1 (env.db), a FastAPI nadpisuje je przy zmianie ocen/filmów.
    // Dzięki temu strona działa nawet gdy serwer Python jest wyłączony.

    _renderRecUpdatedAt(timestamp) {
        const el = document.getElementById('for-you-updated-at');
        if (!el) return;
        el.classList.remove('is-updating');
        if (!timestamp) {
            el.textContent = '';
            el.style.display = 'none';
            return;
        }
        const normalized = timestamp.includes('T') ? timestamp : timestamp.replace(' ', 'T') + 'Z';
        const parsed = new Date(normalized);
        if (Number.isNaN(parsed.getTime())) {
            el.textContent = '';
            el.style.display = 'none';
            return;
        }
        const formatted = parsed.toLocaleString('pl-PL', {
            day: '2-digit',
            month: '2-digit',
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        });
        el.textContent = `Zaktualizowano: ${formatted}`;
        el.style.display = 'inline-block';
    }

    async triggerFastApiRecalculation({ silent = false } = {}) {
        if (!this.currentUser) return;
        if (this._isRecalculating) {
            this._recalcQueued = true;
            return;
        }

        this._isRecalculating = true;
        this._recalcQueued = false;

        const updatedEl = document.getElementById('for-you-updated-at');
        if (updatedEl) {
            updatedEl.classList.add('is-updating');
            updatedEl.innerHTML = '<span class="rec-spinner" aria-hidden="true"></span><span>Aktualizuję rekomendacje...</span>';
            updatedEl.style.display = 'inline-flex';
        }

        let shouldRestart = false;
        try {
            const response = await fetch('/api/movies/recalculate', {
                method: 'POST',
                headers: this.getAuthHeaders()
            });

            if (response.ok) {
                await this.loadRecommendations({ skipAutoRecalc: true });
                if (!silent) {
                    this.showNotification('Rekomendacje zostały zaktualizowane!', 'success');
                }
            } else {
                console.warn('Błąd przeliczania rekomendacji:', response.status);
            }
        } catch (e) {
            console.warn('Błąd wywołania Workera:', e);
        } finally {
            this._isRecalculating = false;
            if (this._recalcQueued) {
                this._recalcQueued = false;
                shouldRestart = true;
            } else {
                this._renderRecUpdatedAt(this._lastRecUpdatedAt);
            }
        }

        if (shouldRestart) {
            await this.triggerFastApiRecalculation({ silent });
        }
    }

    async loadRecommendations({ skipAutoRecalc = false } = {}) {
        this._recLoaded = false;
        this._recOffset = 0;
        this._recCount = 0;

        try { localStorage.removeItem('for-you-pending'); } catch {}

        const container = document.getElementById('for-you-track');
        if (!container) return;

        // Pokaż placeholder ładowania
        container.classList.add('is-loading');
        container.innerHTML = `<div class="for-you-card-empty" style="width:100%; text-align:center;">
            <i class="fas fa-spinner fa-spin" style="font-size: 2.5rem; color: var(--secondary-color); margin-bottom: 1rem;"></i>
            <p style="font-size: 1.1rem; font-weight: 600; color: var(--text-color);">Sprawdzam rekomendacje...</p>
        </div>`;

        let data = [];
        let status = 'loading';

        try {
            // 1. Zwykłe odpytanie Cloudflare Workera o gotowe dane w D1 (bez limitu kart)
            const res = await fetch('/api/movies/recommendations', {
                headers: this.getAuthHeaders()
            });

            if (res.ok) {
                data = await res.json();
                this._lastRecUpdatedAt = data.updatedAt || null;
                if (!this._isRecalculating) {
                    this._renderRecUpdatedAt(this._lastRecUpdatedAt);
                }

                // Jeśli D1 ma dane, status to 'ok'
                if (data.results && data.results.length > 0) {
                    status = 'ok';
                } else {
                    status = 'empty';

                    // 2. BRAK DANYCH W D1 -> Zimny start.
                    if (!skipAutoRecalc && this.currentUser) {
                        console.log("D1 jest puste, uruchamiam przeliczenie w FastAPI...");
                        this.triggerFastApiRecalculation({ silent: true });
                    }
                }
            } else {
                status = 'empty';
            }
        } catch (e) {
            console.error('loadRecommendations error', e);
            status = 'empty';
        }

        this._recLoaded = true;
        
        // renderForYou zajmie się wyświetleniem odpowiedniego placeholdera 
        // (czy "Czekam na Twój ruch", czy "Przeliczam...") na podstawie liczby ocen.
        this.renderForYou(data.results || [], status);
    }

    // ============= ROZWIJANY CZAT "ZAPYTAJ AI" =============
    _getAiSparkleSvg(size = 20) {
        return `<svg class="ai-sparkle-icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M10.5 2L12.7 8.3L19 10.5L12.7 12.7L10.5 19L8.3 12.7L2 10.5L8.3 8.3L10.5 2Z"/><path d="M18.5 14L19.6 17.4L23 18.5L19.6 19.6L18.5 23L17.4 19.6L14 18.5L17.4 17.4L18.5 14Z"/><path d="M19.5 2.5L20.1 4.4L22 5L20.1 5.6L19.5 7.5L18.9 5.6L17 5L18.9 4.4L19.5 2.5Z"/></svg>`;
    }

    toggleAskAIDrawer(forceState = null) {
        const drawer = document.getElementById('ask-ai-drawer');
        const fab = document.getElementById('ask-ai-fab');
        if (!drawer || !fab) return;

        const shouldOpen = forceState !== null ? Boolean(forceState) : drawer.hidden;
        drawer.hidden = !shouldOpen;
        fab.classList.toggle('is-open', shouldOpen);
        fab.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');
        fab.innerHTML = shouldOpen
            ? '<i class="fas fa-chevron-down"></i>'
            : this._getAiSparkleSvg(22);

        if (shouldOpen) {
            const input = document.getElementById('ask-ai-input');
            if (input) setTimeout(() => input.focus(), 40);
        }
    }

    resetAskAIChat() {
        const messagesEl = document.getElementById('ask-ai-messages');
        if (!messagesEl) return;
        messagesEl.innerHTML = `
            <div id="ask-ai-welcome" class="ask-ai-welcome">
                <h3>Co chcesz dziś obejrzeć?</h3>
                <p>Opisz klimat, gatunek, reżysera lub lata premiery.</p>
                <div class="ask-ai-chips">
                    <button type="button" class="ask-ai-chip" data-prompt="Thriller od Christophera Nolana">Thriller od Christophera Nolana</button>
                    <button type="button" class="ask-ai-chip" data-prompt="Coś lekkiego i ciepłego na letnie wieczory">Coś na letnie wieczory</button>
                    <button type="button" class="ask-ai-chip" data-prompt="Sci-fi z twistem fabularnym po 2015">Sci-fi z twistem po 2015</button>
                </div>
            </div>
        `;
    }

    async submitAskAI(customPrompt = null) {
        if (!this.currentUser || this._askAiLoading) return;

        const input = document.getElementById('ask-ai-input');
        const submitBtn = document.getElementById('ask-ai-submit');
        const excludeBox = document.getElementById('ask-ai-exclude-watched');
        const messagesEl = document.getElementById('ask-ai-messages');
        if (!messagesEl) return;

        const prompt = (customPrompt !== null ? customPrompt : (input ? input.value : '')).trim();
        if (prompt.length < 2) {
            this.showNotification('Wpisz pytanie dla AI (min. 2 znaki).', 'info');
            return;
        }

        this.toggleAskAIDrawer(true);

        const welcomeEl = document.getElementById('ask-ai-welcome');
        if (welcomeEl) welcomeEl.remove();
        if (input && customPrompt === null) input.value = '';

        const userMsgEl = document.createElement('div');
        userMsgEl.className = 'ask-ai-msg-user';
        userMsgEl.textContent = prompt;
        messagesEl.appendChild(userMsgEl);

        const botMsgEl = document.createElement('div');
        botMsgEl.className = 'ask-ai-msg-bot';
        botMsgEl.innerHTML = '<div class="ask-ai-loading"><span class="rec-spinner" aria-hidden="true"></span><span>Analizuję pytanie i przeszukuję bazę filmów...</span></div>';
        messagesEl.appendChild(botMsgEl);
        messagesEl.scrollTop = messagesEl.scrollHeight;

        this._askAiLoading = true;
        if (submitBtn) submitBtn.disabled = true;

        try {
            const response = await fetch('/api/movies/ask-ai', {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify({
                    prompt,
                    limit: 6,
                    exclude_watched: excludeBox ? excludeBox.checked : true,
                    include_explanations: true
                })
            });

            const data = await response.json();
            if (!response.ok) {
                throw new Error(data.error || `Błąd serwera (${response.status})`);
            }

            this.renderAskAIResults(data, botMsgEl);
        } catch (e) {
            console.error('Ask AI error:', e);
            botMsgEl.innerHTML = `<div class="ask-ai-error"><i class="fas fa-exclamation-triangle"></i><span>${this.escapeHtml(e.message || 'Nie udało się pobrać odpowiedzi AI.')}</span></div>`;
        } finally {
            this._askAiLoading = false;
            if (submitBtn) submitBtn.disabled = false;
            messagesEl.scrollTop = messagesEl.scrollHeight;
        }
    }

    renderAskAIResults(data, containerEl) {
        if (!containerEl) return;
        containerEl.innerHTML = '';

        const pills = [];
        const f = data.parsed_filters || {};
        if (f.director) pills.push(`Reżyser: ${f.director}`);
        if (Array.isArray(f.cast) && f.cast.length) pills.push(`Obsada: ${f.cast.join(', ')}`);
        if (Array.isArray(f.genres) && f.genres.length) pills.push(`Gatunki: ${f.genres.join(', ')}`);
        if (f.year_from || f.year_to) pills.push(`Lata: ${f.year_from || '...'} - ${f.year_to || '...'}`);
        if (f.media_type) pills.push(f.media_type === 'series' ? 'Typ: Serial' : 'Typ: Film');
        if (f.min_rating) pills.push(`IMDb >= ${f.min_rating}`);

        if (pills.length || data.relaxed_filters) {
            const metaEl = document.createElement('div');
            metaEl.className = 'ask-ai-meta';
            const pillsHtml = pills.map(p => `<span class="ask-ai-filter-pill">${this.escapeHtml(p)}</span>`).join('');
            const relaxedHtml = data.relaxed_filters
                ? '<span class="ask-ai-relaxed-note">Brak dokładnych wyników dla wszystkich filtrów. Pokazano najbliższe dopasowania semantyczne.</span>'
                : '';
            metaEl.innerHTML = `<span>Filtry:</span>${pillsHtml}${relaxedHtml}`;
            containerEl.appendChild(metaEl);
        }

        const movies = data.results || [];
        if (!movies.length) {
            const emptyEl = document.createElement('div');
            emptyEl.className = 'ask-ai-empty';
            emptyEl.textContent = 'Nie znaleziono pasujących tytułów w bazie. Spróbuj inaczej opisać czego szukasz.';
            containerEl.appendChild(emptyEl);
            return;
        }

        const listEl = document.createElement('div');
        listEl.className = 'ask-ai-results-list';

        movies.forEach((m) => {
            const card = document.createElement('div');
            card.className = 'ask-ai-card';
            const poster = this.getPosterUrl(m);
            const year = (m.release_date || '').slice(0, 4);
            const matchPct = m.match_score != null ? `${Math.round(Number(m.match_score) * 100)}%` : '';
            const imdb = m.imdb_rating != null ? `<span>⭐ ${parseFloat(m.imdb_rating).toFixed(1)}</span>` : '';
            const reasonHtml = m.ai_reason ? `<p class="ask-ai-reason">${this.escapeHtml(m.ai_reason)}</p>` : '';

            card.innerHTML = `
                <img src="${poster}" alt="${this.escapeHtml(m.title || '')}" loading="lazy">
                <div class="ask-ai-card-body">
                    <div class="ask-ai-card-title">${this.escapeHtml(m.title || '')}${year ? ` (${this.escapeHtml(year)})` : ''}</div>
                    <div class="ask-ai-card-meta">
                        ${matchPct ? `<span class="ask-ai-match">Dopasowanie: ${matchPct}</span>` : ''}
                        ${imdb}
                    </div>
                    ${m.genre ? `<div class="ask-ai-card-genres">${this.escapeHtml(m.genre)}</div>` : ''}
                    ${reasonHtml}
                </div>
            `;

            card.addEventListener('click', () => {
                const watched = this.watchedMovies.find(w => w.id === m.id || w.movie_id === m.id);
                this.openMovieModal(watched || m, false);
            });
            listEl.appendChild(card);
        });

        containerEl.appendChild(listEl);
    }

    formatRecTypeBadge(recType) {
        const labels = {
            collaborative_filtering: 'CF',
            content_based: 'CB',
            llm_querec: 'LLM',
            hybrid_querec: 'HYBRID'
        };
        return labels[recType] || String(recType).toUpperCase();
    }

    renderForYou(movies, status) {
        const track = document.getElementById('for-you-track');
        const prev = document.getElementById('for-you-prev');
        const next = document.getElementById('for-you-next');
        const countEl = document.getElementById('for-you-count');
        if (!track) return;

        this._lastRecMovies = movies || [];
        this._lastRecStatus = status;

        track.classList.remove('is-loading');
        track.innerHTML = '';
        track.scrollLeft = 0;

        if (status === 'empty' || !movies || movies.length === 0) {
            if (countEl) {
                countEl.textContent = '';
                countEl.style.display = 'none';
            }
            // Ukryj strzałki, gdy nie ma rekomendacji
            if (prev) prev.style.display = 'none';
            if (next) next.style.display = 'none';

            // Sprawdzamy, ile filmów/seriali ocenił użytkownik
            const ratedCount = this.watchedMovies ? this.watchedMovies.length : 0;
            
            let icon = 'fa-film';
            let title = '';
            let subtitle = '';

            // DYNAMICZNY PLACEHOLDER
            if (ratedCount < 3) {
                title = 'Czekam na Twój ruch...';
                subtitle = `Oceniłeś ${ratedCount} z minimum 3 filmów. Dodaj więcej ocen, aby nasze algorytmy mogły dopasować pierwsze propozycje.`;
            } else {
                icon = 'fa-cogs';
                title = 'Przeliczam rekomendacje...';
                subtitle = 'Nasze modele analizują Twój gust. Może to potrwać kilka minut. Odśwież stronę za chwilę!';
            }

            const empty = document.createElement('div');
            empty.className = 'for-you-card-empty'; 
            empty.style.width = '100%';
            empty.style.textAlign = 'center';
            empty.innerHTML = `
                <i class="fas ${icon}" style="font-size: 2.5rem; color: var(--secondary-color); margin-bottom: 1rem;"></i>
                <p style="font-size: 1.1rem; font-weight: 600; color: var(--text-color);">${title}</p>
                <p style="font-size: 0.9rem; color: var(--text-secondary);">${subtitle}</p>`;
            track.appendChild(empty);
            this._recCount = 0;
            return;
        }

        // Pokaż strzałki, gdy są karty do pokazania
        if (prev) prev.style.display = 'flex';
        if (next) next.style.display = 'flex';

        this._recCount = movies.length;

        const isAdmin = Boolean(this.currentUser && this.currentUser.role === 'admin');
        if (countEl) {
            if (isAdmin && this._showRecModels) {
                const countsByBadge = {};
                movies.forEach((m) => {
                    if (!m.recType) return;
                    const badge = this.formatRecTypeBadge(m.recType);
                    countsByBadge[badge] = (countsByBadge[badge] || 0) + 1;
                });
                const preferredOrder = ['CF', 'CB', 'LLM', 'HYBRID'];
                const orderedBadges = [
                    ...preferredOrder.filter((b) => countsByBadge[b]),
                    ...Object.keys(countsByBadge).filter((b) => !preferredOrder.includes(b))
                ];
                const breakdown = orderedBadges.map((b) => `${b}: ${countsByBadge[b]}`).join(', ');
                countEl.textContent = breakdown ? `${movies.length} (${breakdown})` : `${movies.length}`;
            } else {
                countEl.textContent = `${movies.length}`;
            }
            countEl.style.display = 'inline-block';
        }

        // Renderowanie właściwych kart
        movies.forEach((m, i) => {
            const card = document.createElement('div');
            card.className = 'for-you-card';
            card.dataset.movieId = m.id;
            const poster = this.getPosterUrl(m);

            const cfLabel = (isAdmin && this._showRecModels && m.recType)
                ? `<span class="for-you-card-cf">${this.escapeHtml(this.formatRecTypeBadge(m.recType))}</span>`
                : '';

            const imdb = m.imdb_rating != null
                ? `<span class="for-you-card-imdb">⭐ ${parseFloat(m.imdb_rating).toFixed(1)}</span>`
                : '';
            const genres = m.genre
                ? `<span class="for-you-card-genres">${this.escapeHtml(m.genre)}</span>`
                : '';

            card.innerHTML = `
                ${cfLabel}
                <img src="${poster}" alt="${this.escapeHtml(m.title || '')}" loading="lazy">
                <div class="for-you-card-body">
                    <div class="for-you-card-title">${this.escapeHtml(m.title || '')}</div>
                    <div class="for-you-card-meta">
                        <span class="for-you-card-recommended" title="Przewidywana ocena przez algorytm rekomendacji (skala 1-5)">
                            <svg class="for-you-approx-icon" width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M2 5.5c1.5-2 4.5-2 6 0s4.5 2 6 0"/><path d="M2 10.5c1.5-2 4.5-2 6 0s4.5 2 6 0"/></svg>
                            ${parseFloat(m.recommended_rating).toFixed(1)}
                        </span>
                        ${imdb}
                    </div>
                    ${genres}
                </div>
            `;

            card.addEventListener('click', () => {
                const watched = this.watchedMovies.find(w => w.id === m.id || w.movie_id === m.id);
                if (watched) {
                    this.openMovieModal(watched, false);
                } else {
                    this.openMovieModal(m, false);
                }
            });
            track.appendChild(card);
        });

        this._recOffset = 0;
        this._bindForYouControls();
    }

    // Scroll tracka do danego offsetu (karty).
    _scrollForYouTo(direction) {
        const track = document.getElementById('for-you-track');
        // Zabezpieczenie przed spamowaniem przycisku i błędami
        if (!track || track.children.length <= 1 || this._isScrolling) return;

        this._isScrolling = true;

        // Obliczamy dokładną szerokość przeskoku (szerokość karty + luka)
        const firstCard = track.querySelector('.for-you-card');
        if (!firstCard) {
            this._isScrolling = false;
            return;
        }
        const gap = parseFloat(getComputedStyle(track).gap || 12);
        const scrollAmount = firstCard.offsetWidth + gap;

        // Wyłączamy płynne przewijanie na ułamek sekundy, by niezauważenie manipulować kartami
        track.style.scrollBehavior = 'auto';

        if (direction === -1) {
            // PRZEWIJANIE W LEWO (Ostatnia karta leci na początek)
            track.prepend(track.lastElementChild);
            
            // Rekompensujemy skok, żeby obraz stał w miejscu
            track.scrollLeft += scrollAmount;
            
            // "Zmuszamy" przeglądarkę do załapania zmian przed animacją
            void track.offsetWidth; 
            
            // Włączamy płynność i animujemy "wsunięcie" nowej karty
            track.style.scrollBehavior = 'smooth';
            track.scrollLeft -= scrollAmount;
            
            setTimeout(() => { 
                this._isScrolling = false; 
            }, 400); // Czas trwania animacji
        } else {
            // PRZEWIJANIE W PRAWO (Standardowy skok)
            track.style.scrollBehavior = 'smooth';
            track.scrollLeft += scrollAmount;
            
            setTimeout(() => {
                // Po zakończeniu animacji wyłączamy płynność
                track.style.scrollBehavior = 'auto';
                // Przerzucamy pierwszą kartę na koniec
                track.appendChild(track.firstElementChild);
                // Cofamy scrolla, by nie było zacięcia
                track.scrollLeft -= scrollAmount;
                this._isScrolling = false;
            }, 250);
        }
    }

    _bindForYouControls() {
        const prev = document.getElementById('for-you-prev');
        const next = document.getElementById('for-you-next');
        const track = document.getElementById('for-you-track');
        if (!track) return;

        // W nieskończonej pętli strzałki są ZAWSZE aktywne
        if (prev) {
            prev.disabled = false;
            prev.style.opacity = '0.9';
            prev.onclick = () => this._scrollForYouTo(-1);
        }
        if (next) {
            next.disabled = false;
            next.style.opacity = '0.9';
            next.onclick = () => this._scrollForYouTo(1);
        }

        // Obsługa machnięcia palcem (swipe) na telefonach
        if (!track.dataset.touchBound) {
            track.dataset.touchBound = '1';
            let startX = 0;
            let panning = false;
            track.addEventListener('touchstart', (e) => {
                startX = e.touches[0].clientX;
                panning = true;
            }, { passive: true });

            track.addEventListener('touchmove', (e) => {
                if (!panning) return;
                const dx = e.touches[0].clientX - startX;
                // Reagujemy, gdy palec przesunie się o min. 40px
                if (Math.abs(dx) > 40) { 
                    this._scrollForYouTo(dx < 0 ? 1 : -1);
                    startX = e.touches[0].clientX;
                    panning = false;
                }
            }, { passive: true });

            track.addEventListener('touchend', () => { panning = false; }, { passive: true });
        }
    }

    // Obsługa klawiszy strzałek dla paska rekomendacji
    bindArrowKeysForForYou() {
        document.addEventListener('keydown', (e) => {
            if (this.currentSection !== 'dashboard') return;
            const tag = e.target?.tagName;
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || e.target?.isContentEditable) return;
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                this._scrollForYouTo(-1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                this._scrollForYouTo(1);
            }
        });
    }

    displayRecentActivity() {
        const recentList = document.getElementById('recent-list');
        recentList.innerHTML = '';

        const recentItems = this.watchedMovies
            .sort((a, b) => new Date(b.watchedDate) - new Date(a.watchedDate))
            .slice(0, 5);

        recentItems.forEach(item => {
            const activityItem = document.createElement('div');
            activityItem.className = 'activity-item';
            let poster = item.poster_url || item.poster || item.posterUrl || null;
            if (poster && poster.startsWith('http://')) {
                poster = poster.replace('http://', 'https://');
            }
            if (!poster) {
                poster = `https://placehold.co/60x90/cccccc/666666/png?text=${encodeURIComponent(item.title || 'Movie')}`;
            }
            
            // Określ etykietę statusu
            let statusText = 'Obejrzano';
            if (item.status === 'watching') statusText = 'Oglądane';
            else if (item.status === 'planning') statusText = 'Planowane';
            else if (item.status === 'dropped') statusText = 'Porzucone';
            
            activityItem.innerHTML = `
                <img src="${poster}" alt="${item.title}">
                <div class="activity-info">
                    <h4>${item.title}</h4>
                    ${this.getStatusBadge(item.status)}
                    <p>${statusText}: ${this.formatDate(item.watchedDate)}</p>
                    <p>Ocena: ${'★'.repeat(item.rating)}${'☆'.repeat(5-item.rating)}</p>
                </div>
            `;
            recentList.appendChild(activityItem);
        });
    }

    updateStats() {
        // Licz tylko filmy/seriale ze statusem 'watched'
        const movies = this.watchedMovies.filter(item => item.type === 'movie' && item.status === 'watched');
        const series = this.watchedMovies.filter(item => item.type === 'series' && item.status === 'watched');
        // Oblicz czas oglądania w minutach osobno dla filmów i seriali
        let movieMinutes = 0;
        let seriesMinutes = 0;
        
        this.watchedMovies.forEach(item => {
            if (item.type === 'movie') {
                const dur = item.duration || item.runtime || item.durationMinutes || 0;
                movieMinutes += Number(dur) || 0;
            } else if (item.type === 'series') {
                const avg = item.avgEpisodeLength || item.avg_episode_length || item.duration || 0;
                const watched = item.watchedEpisodes || item.watched_episodes || item.watched_count || 0;
                if (watched && avg) {
                    seriesMinutes += Number(avg) * Number(watched);
                } else if ((item.status === 'watched' || item.status === 'completed') && item.totalEpisodes && avg) {
                    seriesMinutes += Number(avg) * Number(item.totalEpisodes);
                }
            }
        });
        
        const movieHours = Math.round(movieMinutes / 60);
        const seriesHours = Math.round(seriesMinutes / 60);
        const avgRating = this.watchedMovies.length > 0 
            ? (this.watchedMovies.reduce((total, item) => total + item.rating, 0) / this.watchedMovies.length).toFixed(1)
            : 0;

        document.getElementById('movies-count').textContent = movies.length;
        document.getElementById('series-count').textContent = series.length;
        document.getElementById('movies-hours-count').textContent = movieHours;
        document.getElementById('series-hours-count').textContent = seriesHours;
        document.getElementById('avg-rating').textContent = avgRating;
    }

    syncSearchGenreChips(genreValue) {
        const container = document.getElementById('search-genre-chips');
        if (!container) return;

        const targetLower = String(genreValue || '').trim().toLowerCase();

        container.querySelectorAll('.genre-chip:not(.genre-chip-more)').forEach(chip => {
            const chipVal = (chip.dataset.genre || '').trim().toLowerCase();
            chip.classList.toggle('active', chipVal === targetLower);
        });

        let activeOverflowLabel = null;
        container.querySelectorAll('.genre-more-item').forEach(item => {
            const itemVal = (item.dataset.genre || '').trim().toLowerCase();
            const isMatch = Boolean(targetLower) && itemVal === targetLower;
            item.classList.toggle('active', isMatch);
            if (isMatch) {
                activeOverflowLabel = item.dataset.genre;
            }
        });

        const moreBtn = document.getElementById('search-genre-more-btn');
        if (moreBtn) {
            const labelEl = moreBtn.querySelector('.genre-more-label');
            if (activeOverflowLabel) {
                moreBtn.classList.add('active');
                if (labelEl) labelEl.textContent = activeOverflowLabel;
            } else {
                moreBtn.classList.remove('active');
                if (labelEl && moreBtn.dataset.defaultLabel) {
                    labelEl.textContent = moreBtn.dataset.defaultLabel;
                }
            }
        }
    }

    async performSearch() {
        clearTimeout(this._liveSearchTimeout);

        if (this._searchAbortController) {
            this._searchAbortController.abort();
            this._searchAbortController = null;
        }

        this._searchRequestId = (this._searchRequestId || 0) + 1;
        const requestId = this._searchRequestId;

        const query = document.getElementById('search-input')?.value.trim() || '';
        const typeFilter = document.getElementById('type-filter')?.value || '';
        const genreFilter = document.getElementById('genre-filter')?.value || '';
        const yearFilter = document.getElementById('year-filter')?.value || '';
        const resultsContainer = document.getElementById('search-results');

        this.syncSearchGenreChips(genreFilter);

        // Nowe wyszukiwanie / przeglądanie - resetuj paginację
        this._searchState = { query, typeFilter, genreFilter, yearFilter, page: 0 };
        this._searchLoadingMore = false;

        if (resultsContainer) {
            resultsContainer.innerHTML = '<p class="search-loading">Wyszukiwanie...</p>';
        }

        const controller = new AbortController();
        this._searchAbortController = controller;

        const params = new URLSearchParams({
            page: '0',
            limit: '30'
        });
        if (query) params.set('query', query);
        if (typeFilter) params.set('type', typeFilter);
        if (genreFilter) params.set('genre', genreFilter);
        if (yearFilter) params.set('year', yearFilter);

        try {
            const response = await fetch(`/api/search?${params.toString()}`, {
                headers: this.getAuthHeaders(),
                signal: controller.signal
            });

            if (requestId !== this._searchRequestId) return;

            if (!response.ok) {
                console.warn('Search API failed with status:', response.status);
                if (resultsContainer) {
                    resultsContainer.innerHTML = '<p class="search-error">Wystąpił błąd podczas wyszukiwania. Spróbuj ponownie.</p>';
                }
                return;
            }

            const data = await response.json();
            if (requestId !== this._searchRequestId) return;

            const results = data.results || (Array.isArray(data) ? data : []);
            const hasMore = Boolean(data.hasMore);
            this._searchTotal = typeof data.total === 'number' ? data.total : null;

            this.displaySearchResults(results, hasMore, false);
        } catch (error) {
            if (error && error.name === 'AbortError') return;
            console.error('Search error:', error);
            if (requestId === this._searchRequestId && resultsContainer) {
                resultsContainer.innerHTML = '<p class="search-error">Wystąpił błąd podczas wyszukiwania. Spróbuj ponownie.</p>';
            }
        } finally {
            if (this._searchAbortController === controller) {
                this._searchAbortController = null;
            }
        }
    }

    async loadMoreSearchResults() {
        if (!this._searchState || this._searchLoadingMore) return;
        this._searchLoadingMore = true;

        const requestId = this._searchRequestId;
        this._searchState.page++;
        const { query, typeFilter, genreFilter, yearFilter, page } = this._searchState;

        const params = new URLSearchParams({
            page: String(page),
            limit: '30'
        });
        if (query) params.set('query', query);
        if (typeFilter) params.set('type', typeFilter);
        if (genreFilter) params.set('genre', genreFilter);
        if (yearFilter) params.set('year', yearFilter);

        try {
            const response = await fetch(`/api/search?${params.toString()}`, {
                headers: this.getAuthHeaders()
            });
            if (requestId !== this._searchRequestId) return;
            if (!response.ok) {
                this._searchState.page = Math.max(0, this._searchState.page - 1);
                return;
            }
            const data = await response.json();
            if (requestId !== this._searchRequestId) return;

            const results = data.results || [];
            const hasMore = Boolean(data.hasMore);
            this.displaySearchResults(results, hasMore, true);
        } catch (e) {
            if (e && e.name === 'AbortError') return;
            if (this._searchState) {
                this._searchState.page = Math.max(0, this._searchState.page - 1);
            }
            console.error('Load more error:', e);
        } finally {
            this._searchLoadingMore = false;
        }
    }

    displaySearchResults(results, hasMore = false, append = false) {
        const resultsContainer = document.getElementById('search-results');

        // Usuń poprzedni przycisk "Pokaż więcej"; licznik usuwamy tylko przy nowym wyszukiwaniu
        resultsContainer.querySelector('.load-more-btn')?.remove();
        if (!append) {
            resultsContainer.querySelector('.search-count')?.remove();
            resultsContainer.innerHTML = '';
        }

        if (!append && results.length === 0) {
            resultsContainer.innerHTML = '<p>Nie znaleziono wyników.</p>';
            return;
        }

        const isBrowseMode = !this._searchState?.query;

        // Licznik wyników - tylko przy pierwszej stronie
        if (!append) {
            const counter = document.createElement('div');
            counter.className = 'search-count';
            if (typeof this._searchTotal === 'number') {
                counter.textContent = `Znaleziono: ${this._searchTotal.toLocaleString('pl-PL')} wyników`;
            } else if (isBrowseMode) {
                counter.textContent = `Wyświetlono ${results.length} najpopularniejszych produkcji${hasMore ? ' (dostępne kolejne)' : ''}`;
            } else if (hasMore) {
                counter.textContent = `Wyświetlono ${results.length} najlepiej dopasowanych wyników (dostępne kolejne)`;
            } else {
                counter.textContent = `Znaleziono: ${results.length} wyników`;
            }
            resultsContainer.appendChild(counter);
        }

        results.forEach(item => {
            const movieCard = document.createElement('div');
            movieCard.className = 'movie-card';
            const poster = this.getPosterUrl(item);
                const cardGenre = this.parseGenres(item.genre).join(', ');
                const rawYear = item.release_date || item.year || '';
                let cardYear = '';
                if (item.type === 'series' && rawYear && /[-–—]/.test(String(rawYear))) {
                    cardYear = String(rawYear);
                } else if (item.year) {
                    cardYear = String(item.year);
                } else if (rawYear) {
                    const ym = String(rawYear).match(/^(\d{4})/);
                    cardYear = ym ? ym[1] : String(rawYear);
                }
                const avg = item.avgEpisodeLength || item.avg_episode_length || item.duration || null;
                movieCard.innerHTML = `
                <img src="${poster}" alt="${item.title}">
                <div class="movie-card-content">
                    <h3>${item.title}</h3>
                    <p class="movie-card-meta">${cardYear}${cardYear && (cardGenre || avg) ? ' • ' : ''}${cardGenre}${(avg && item.type === 'series') ? ' • śr. ' + avg + ' min' : ''}</p>
                    <p>${item.description || ''}</p>
                    <p class="movie-card-genre">${cardGenre}</p>
                    <div class="movie-rating">
                        <span class="stars">${'★'.repeat(Math.floor(item.rating || 0))}${'☆'.repeat(5-Math.floor(item.rating || 0))}</span>
                        <span>${item.rating || 0}</span>
                    </div>
                </div>
            `;

            movieCard.addEventListener('click', () => {
                // Upewnij się, że obiekt ma pole poster ustawione (modal używa movie.poster)
                item.poster = this.getPosterUrl(item);
                this.openMovieModal(item);
            });

            resultsContainer.appendChild(movieCard);
        });

        if (append) {
            const existingCounter = resultsContainer.querySelector('.search-count');
            if (existingCounter) {
                const shown = resultsContainer.querySelectorAll('.movie-card').length;
                if (typeof this._searchTotal === 'number') {
                    existingCounter.textContent = `Znaleziono: ${this._searchTotal.toLocaleString('pl-PL')} wyników (wyświetlono ${shown})`;
                } else if (isBrowseMode) {
                    existingCounter.textContent = `Wyświetlono ${shown} najpopularniejszych produkcji${hasMore ? ' (dostępne kolejne)' : ''}`;
                } else {
                    existingCounter.textContent = `Wyświetlono ${shown} wyników${hasMore ? ' (dostępne kolejne)' : ''}`;
                }
            }
        }

        // Przycisk "Pokaż więcej" z liczbą pozostałych
        if (hasMore) {
            const shown = resultsContainer.querySelectorAll('.movie-card').length;
            const remaining = typeof this._searchTotal === 'number' ? this._searchTotal - shown : '';
            const label = remaining ? `Pokaż więcej (jeszcze ~${remaining.toLocaleString('pl-PL')})` : 'Pokaż więcej';
            const loadMoreBtn = document.createElement('div');
            loadMoreBtn.className = 'load-more-btn';
            loadMoreBtn.innerHTML = `<button onclick="app.loadMoreSearchResults()">${label}</button>`;
            resultsContainer.appendChild(loadMoreBtn);
        }
    }

    async openMovieModal(movie, isEdit = false) {
        const modal = document.getElementById('movie-modal');
        // Spróbuj pobrać pełne dane filmu z API, jeśli dostępne
        try {
            try {
                let id = movie.id;
                if (typeof id === 'string' && id.startsWith('db_')) id = id.replace(/^db_/, '');
                if (id) {
                    const res = await fetch(`/api/movies/${id}`, { headers: this.getAuthHeaders() });
                    if (res.ok) {
                        const full = await res.json();
                        // Scal dane filmu
                        movie = { ...movie, ...full };
                    }
                }
            } catch (e) {
                console.warn('Failed to fetch full movie details for modal:', e);
            }
        } catch (e) {
            console.warn('Failed to fetch movie details for modal:', e);
        }
        // Upewnij się, że modal dostaje prawidłowy URL plakatu (schemat DB)
            const poster = this.getPosterUrl(movie);
            document.getElementById('modal-poster').src = poster;
        document.getElementById('modal-title').textContent = movie.title;
        document.getElementById('modal-description').textContent = movie.description && movie.description.trim() !== '' ? movie.description : 'Brak opisu';
        
            // Wyodrębnij rok z release_date lub użyj pola year bezpośrednio
        let displayYear = '';
        if (typeof movie.year === 'number' && this.safeYear(movie.year)) {
            displayYear = String(movie.year);
        } else if (typeof movie.year === 'string') {
            // Spróbuj wyodrębnić rok z ciągu daty (YYYY-MM-DD lub tylko YYYY)
            const yearMatch = movie.year.match(/^(\d{4})/);
            if (yearMatch) {
                displayYear = yearMatch[1];
            }
        }
        
        if (!displayYear) {
            const rawYear = movie.release_date || movie.releaseDate || null;
            if (rawYear) {
                const rawStr = String(rawYear);
                // Jeśli to serial i release_date jest zakresem (zawiera myślnik), użyj pełnego ciągu zakresu
                if (movie.type === 'series' && /[-–—]/.test(rawStr)) {
                    displayYear = rawStr;
                } else {
                    const yearMatch = rawStr.match(/^(\d{4})/);
                    if (yearMatch) {
                        displayYear = yearMatch[1];
                    } else {
                        displayYear = this.safeYear(rawYear) || this.normalizeYear(rawYear) || '';
                    }
                }
            }
        }
        
        document.getElementById('modal-year').textContent = displayYear || '-';
        // Normalizuj i wyświetl gatunki
        const genreDisplay = Array.isArray(movie.genre) ? movie.genre.join(', ') : (movie.genre || '');
        document.getElementById('modal-genre').textContent = this.parseGenres(genreDisplay).join(', ');
        
        // Wyświetl odtwarzacz trailera jeśli dostępny
        this.displayTrailer(movie.trailer_url || movie.trailerUrl);
        const modalDurationEl = document.getElementById('modal-duration');
        if (movie.type === 'series') {
            // Jeśli backend nie dostarczył totalEpisodes/totalSeasons lub avg, pobierz szczegóły odcinków
            const seasons = movie.totalSeasons || (Array.isArray(movie.seasons) ? movie.seasons.length : null);
            const episodes = movie.totalEpisodes || (Array.isArray(movie.seasons) ? movie.seasons.reduce((acc, s) => acc + (Array.isArray(s.episodes) ? s.episodes.length : 0), 0) : null);
            let avg = movie.avgEpisodeLength || movie.avg_episode_length || movie.duration || null;

            const setModalSeriesInfo = (sCount, eCount, avgMins) => {
                const seasonText = sCount ? `${sCount} ${sCount === 1 ? 'sezon' : sCount < 5 ? 'sezony' : 'sezonów'}` : 'Serial';
                const episodeText = eCount ? `${eCount} ${eCount === 1 ? 'odcinek' : 'odc.'}` : '';
                const avgText = avgMins ? `śr. ${avgMins} min` : '';
                const parts = [seasonText, episodeText, avgText].filter(p => p);
                modalDurationEl.textContent = parts.join(' • ');
            };

            if ((episodes && seasons) || avg) {
                setModalSeriesInfo(seasons, episodes, avg);
            } else {
                // Pobierz szczegóły sezonów/odcinków z API i zaktualizuj modal
                (async () => {
                    try {
                        const res = await fetch(`/api/series/${movie.id}/episodes`, { headers: this.getAuthHeaders() });
                        if (res.ok) {
                            const data = await res.json();
                            const sCount = data.series?.totalSeasons || data.series?.totalSeasons || (Array.isArray(data.seasons) ? data.seasons.length : null);
                            const eCount = data.series?.totalEpisodes || data.series?.totalEpisodes || (Array.isArray(data.seasons) ? data.seasons.reduce((acc, s) => acc + (Array.isArray(s.episodes) ? s.episodes.length : 0), 0) : null);
                            // Oblicz średnią długość odcinków
                            let sum = 0, cnt = 0;
                            if (Array.isArray(data.seasons)) {
                                data.seasons.forEach(s => {
                                    if (Array.isArray(s.episodes)) {
                                        s.episodes.forEach(ep => { if (ep.duration || ep.duration === 0) { sum += Number(ep.duration) || 0; cnt++; } });
                                    }
                                });
                            }
                            const computedAvg = cnt > 0 ? Math.round(sum / cnt) : null;
                            avg = avg || computedAvg;

                            // Ustaw informacje w modalu
                            setModalSeriesInfo(sCount, eCount, avg);
                            // Dołącz dane do obiektu movie na przyszłość
                            try { movie.seasons = data.seasons || movie.seasons; } catch {}
                            movie.totalSeasons = sCount || movie.totalSeasons;
                            movie.totalEpisodes = eCount || movie.totalEpisodes;
                            movie.avgEpisodeLength = avg || movie.avgEpisodeLength;
                        } else {
                            setModalSeriesInfo(seasons, episodes, avg);
                        }
                    } catch (e) {
                        console.warn('Could not fetch series episodes for modal:', e);
                        setModalSeriesInfo(seasons, episodes, avg);
                    }
                })();
            }
        } else {
            modalDurationEl.textContent = movie.duration ? `${movie.duration} min` : 'Brak danych';
        }

        // Ustaw status jeśli dostępny
        const statusSelect = document.getElementById('movie-status');
        if (statusSelect && movie.status) {
            statusSelect.value = movie.status;
        } else if (statusSelect) {
            statusSelect.value = '';
        }
        
        // Blokuj opcję "obejrzane" jeśli premiera jest w przyszłości
        if (statusSelect) {
            const watchedOption = statusSelect.querySelector('option[value="watched"]');
            const watchingOption = statusSelect.querySelector('option[value="watching"]');
            if (watchedOption) {
                const releaseDate = movie.release_date || movie.releaseDate || movie.year;
                if (releaseDate) {
                    const releaseDateStr = String(releaseDate).match(/(\d{4}-\d{2}-\d{2})/);
                    if (releaseDateStr) {
                        const release = new Date(releaseDateStr[1]);
                        const today = new Date();
                        today.setHours(0, 0, 0, 0);
                        if (release > today) {
                            watchedOption.disabled = true;
                            watchedOption.textContent = 'Obejrzane (Dostępne po premierze)';
                            watchingOption.disabled = true;
                            watchingOption.textContent = 'Obecnie oglądane (Dostępne po premierze)';
                        } else {
                            watchedOption.disabled = false;
                            watchingOption.disabled = false;
                            watchedOption.textContent = 'Obejrzane';
                            watchingOption.textContent = 'Obecnie oglądane';
                        }
                    }
                }
            }
        }

        // Pokaż/ukryj zakładkę odcinków w zależności od typu
        const episodesTabBtn = document.getElementById('episodes-tab-btn');
        if (episodesTabBtn) {
            episodesTabBtn.style.display = movie.type === 'series' ? 'inline-block' : 'none';
        }

        // Sprawdź czy film jest na liście użytkownika
        const isOnList = this.watchedMovies.some(m => m.id === movie.id);
        
        // Ustaw ocenę i recenzję
        if (isOnList) {
            this.currentRating = movie.rating || 0;
            this.highlightStars(this.currentRating);
            const reviewTextarea = document.getElementById('review-text');
            reviewTextarea.value = movie.review || '';
            // Zablokuj pole recenzji jeśli nie ma oceny
            if (this.currentRating === 0) {
                reviewTextarea.disabled = true;
                reviewTextarea.placeholder = 'Najpierw wybierz ocenę (1-5 gwiazdek), aby móc dodać recenzję tekstową';
            } else {
                reviewTextarea.disabled = false;
                reviewTextarea.placeholder = 'Dodaj swoją recenzję...';
            }
            
            // Pokaż przyciski aktualizacji i usuwania, ukryj przycisk dodawania
            document.getElementById('add-to-list').style.display = 'none';
            document.getElementById('update-item').style.display = 'inline-block';
            document.getElementById('remove-from-list').style.display = 'inline-block';
        } else {
            // Zresetuj ocenę dla nowych elementów
            this.currentRating = 0;
            this.highlightStars(0);
            const reviewTextarea = document.getElementById('review-text');
            reviewTextarea.value = '';
            reviewTextarea.disabled = true;
            reviewTextarea.placeholder = 'Najpierw wybierz ocenę (1-5 gwiazdek), aby móc dodać recenzję tekstową';
            
            // Pokaż przycisk dodawania, ukryj przyciski aktualizacji i usuwania
            document.getElementById('add-to-list').style.display = 'inline-block';
            document.getElementById('update-item').style.display = 'none';
            document.getElementById('remove-from-list').style.display = 'none';
        }
        
        // Zawsze otwieraj na zakładce informacji (niezależnie od trybu)
        this.switchModalTab('info');

        modal.style.display = 'block';
        modal.currentMovie = movie;
        modal.isEditMode = isEdit;
        // ============= MODALE I OCENY =============
    }

    displayTrailer(trailerUrl) {
        const container = document.getElementById('trailer-container');
        const wrapper = document.getElementById('trailer-wrapper');
        
        if (!trailerUrl || trailerUrl.trim() === '') {
            container.style.display = 'none';
            container.dataset.hasTrailer = 'false';
            wrapper.innerHTML = '';
            return;
        }
        
        // Wykryj typ URL i wygeneruj embed
        let embedUrl = null;
        
        // YouTube
        const youtubeRegex = /(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/ ]{11})/;
        const youtubeMatch = trailerUrl.match(youtubeRegex);
        if (youtubeMatch) {
            embedUrl = `https://www.youtube.com/embed/${youtubeMatch[1]}?enablejsapi=1&rel=0`;
        }
        
        // Vimeo
        const vimeoRegex = /vimeo\.com\/(\d+)/;
        const vimeoMatch = trailerUrl.match(vimeoRegex);
        if (vimeoMatch) {
            embedUrl = `https://player.vimeo.com/video/${vimeoMatch[1]}`;
        }
        
        // Dailymotion
        const dailymotionRegex = /dailymotion\.com\/video\/([a-zA-Z0-9]+)/;
        const dailymotionMatch = trailerUrl.match(dailymotionRegex);
        if (dailymotionMatch) {
            embedUrl = `https://www.dailymotion.com/embed/video/${dailymotionMatch[1]}`;
        }
        
        if (embedUrl) {
            wrapper.innerHTML = `<iframe src="${embedUrl}" allowfullscreen allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"></iframe>`;
            container.style.display = 'block';
            container.dataset.hasTrailer = 'true';
        } else {
            // Jeśli nie rozpoznano URL, pokaż link
            wrapper.innerHTML = `<p style="padding: 2rem; text-align: center;"><a href="${trailerUrl}" target="_blank" rel="noopener noreferrer" style="color: var(--secondary-color);">Otwórz trailer w nowej karcie</a></p>`;
            container.style.display = 'block';
            container.dataset.hasTrailer = 'true';
        }
    }
    
    switchModalTab(tabName) {
        // Usuń klasę active ze wszystkich zakładek i zawartości
        document.querySelectorAll('.modal-tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        document.querySelectorAll('.modal-tab-content').forEach(content => {
            content.classList.remove('active');
        });
        
        // Ukryj/pokaż trailer i pauzuj/wznawiaj odtwarzanie
        const trailerContainer = document.getElementById('trailer-container');
        if (trailerContainer) {
            const iframe = trailerContainer.querySelector('iframe');
            if (tabName === 'info') {
                trailerContainer.style.display = trailerContainer.dataset.hasTrailer === 'true' ? 'block' : 'none';
            } else {
                // Pauzuj video przed ukryciem
                if (iframe) {
                    // YouTube
                    try {
                        iframe.contentWindow.postMessage('{"event":"command","func":"pauseVideo","args":""}', '*');
                    } catch (e) {}
                    // Vimeo
                    try {
                        iframe.contentWindow.postMessage('{"method":"pause"}', '*');
                    } catch (e) {}
                }
                trailerContainer.style.display = 'none';
            }
        }
        
        // Dodaj klasę active do wybranej zakładki i zawartości
        const tabBtn = document.querySelector(`.modal-tab-btn[data-tab="${tabName}"]`);
        const tabContent = document.getElementById(`${tabName}-tab`);
        
        if (tabBtn) tabBtn.classList.add('active');
        if (tabContent) tabContent.classList.add('active');
        
        // Jeśli przechodzi na zakładkę odcinków, załaduj odcinki
        if (tabName === 'episodes') {
            const modal = document.getElementById('movie-modal');
            const movie = modal.currentMovie;
            if (movie && movie.id) {
                // Upewnij się, że ID jest liczbą, a nie stringiem z prefiksem
                const seriesId = typeof movie.id === 'string' ? movie.id.replace(/^db_/, '') : movie.id;
                this.loadEpisodesIntoTab(seriesId);
            }
        }
        
        // Jeśli przechodzi na zakładkę recenzji, załaduj recenzje
        if (tabName === 'reviews') {
            const modal = document.getElementById('movie-modal');
            const movie = modal.currentMovie;
            if (movie && movie.id) {
                const movieId = typeof movie.id === 'string' ? movie.id.replace(/^db_/, '') : movie.id;
                this.loadReviewsIntoTab(movieId);
            }
        }
    }

    showConfirm(message, title = 'Potwierdzenie') {
        return new Promise((resolve) => {
            const modal = document.getElementById('confirm-modal');
            const titleEl = document.getElementById('confirm-title');
            const messageEl = document.getElementById('confirm-message');
            const yesBtn = document.getElementById('confirm-yes');
            const noBtn = document.getElementById('confirm-no');
            
            titleEl.textContent = title;
            messageEl.textContent = message;
            modal.style.display = 'block';
            
            const handleYes = () => {
                modal.style.display = 'none';
                yesBtn.removeEventListener('click', handleYes);
                noBtn.removeEventListener('click', handleNo);
                resolve(true);
            };
            
            const handleNo = () => {
                modal.style.display = 'none';
                yesBtn.removeEventListener('click', handleYes);
                noBtn.removeEventListener('click', handleNo);
                resolve(false);
            };
            
            yesBtn.addEventListener('click', handleYes);
            noBtn.addEventListener('click', handleNo);
        });
    }

    closeModal() {
        // Resetuj trailer przed zamknięciem modala
        const trailerWrapper = document.getElementById('trailer-wrapper');
        if (trailerWrapper) {
            trailerWrapper.innerHTML = '';
        }
        const trailerContainer = document.getElementById('trailer-container');
        if (trailerContainer) {
            trailerContainer.style.display = 'none';
        }
        
        document.getElementById('movie-modal').style.display = 'none';
    }
    // ============= KONIEC MODALI I OCENY =============

    setRating(rating) {
        this.currentRating = rating;
        this.highlightStars(rating);
        
        // Zablokuj/odblokuj pole recenzji w zależności od oceny
        const reviewTextarea = document.getElementById('review-text');
        if (reviewTextarea) {
            if (rating === 0) {
                reviewTextarea.disabled = true;
                reviewTextarea.placeholder = 'Najpierw wybierz ocenę (1-5 gwiazdek), aby móc dodać recenzję tekstową';
                reviewTextarea.value = '';
            } else {
                reviewTextarea.disabled = false;
                reviewTextarea.placeholder = 'Dodaj swoją recenzję...';
            }
        }
    }

    highlightStars(rating) {
        document.querySelectorAll('.stars i').forEach((star, index) => {
            if (index < rating) {
                star.classList.add('active');
            } else {
                star.classList.remove('active');
            }
        });
    }

    async addToWatched() {
        const modal = document.getElementById('movie-modal');
        const movie = modal.currentMovie;
        const reviewText = document.getElementById('review-text').value;
        const statusSelect = document.getElementById('movie-status');
        const selectedStatus = statusSelect ? statusSelect.value : 'watched';

        const movieData = {
            ...movie,
            rating: this.currentRating,
            review: reviewText,
            status: selectedStatus || 'watched',
            watchedDate: new Date().toISOString().split('T')[0]
        };

        try {
            const response = await fetch('/api/movies', {
                method: 'POST',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(movieData)
            });

            if (response.ok) {
                const result = await response.json();
                // Przeładuj dane filmów, aby odświeżyć listę
                await this.loadMoviesData();
                this.triggerFastApiRecalculation();
                this.closeModal();
                
                // Jeśli to serial, od razu otwórz modal z zakładką odcinków
                if (movie.type === 'series' && result.id) {
                    // Poczekaj chwilę na załadowanie danych
                    setTimeout(() => {
                        const addedSeries = this.watchedMovies.find(m => m.id === result.id);
                        if (addedSeries) {
                            this.openMovieModal(addedSeries, false);
                            // Przełącz na zakładkę odcinków
                            setTimeout(() => {
                                this.switchModalTab('episodes');
                                this.showNotification('Serial został dodany! Zaznacz obejrzane odcinki.');
                            }, 100);
                        }
                    }, 300);
                } else {
                    this.showNotification('Film został dodany do listy!');
                }
            } else {
                throw new Error('Failed to add movie');
            }
        } catch (error) {
            console.error('Error adding movie:', error);
            this.showNotification('Błąd podczas dodawania filmu. Spróbuj ponownie.');
        }
    }

    async updateMovieItem() {
        const modal = document.getElementById('movie-modal');
        const movie = modal.currentMovie;
        const reviewText = document.getElementById('review-text').value;
        const statusSelect = document.getElementById('movie-status');
        const selectedStatus = statusSelect ? statusSelect.value : movie.status || 'watched';

        if (!movie.id) {
            this.showNotification('Błąd: Brak identyfikatora filmu.');
            return;
        }

        const movieData = {
            rating: this.currentRating,
            review: reviewText,
            status: selectedStatus,
            watchedDate: movie.watchedDate || new Date().toISOString().split('T')[0]
        };

        try {
            const response = await fetch(`/api/movies/${movie.id}`, {
                method: 'PUT',
                headers: this.getAuthHeaders(),
                body: JSON.stringify(movieData)
            });

            if (response.ok) {
                const result = await response.json();
                
                // Sprawdź, czy ukończono jakieś wyzwania
                if (result.completedChallenges && result.completedChallenges.length > 0) {
                    for (const completed of result.completedChallenges) {
                        this.showNotification(
                            `🎉 Gratulacje! Ukończyłeś wyzwanie "${completed.challengeTitle}" i zdobyłeś odznakę "${completed.badge.name}"!`,
                            'success',
                            true,
                            7000
                        );
                    }
                    // Odśwież odznaki w profilu
                    await this.loadBadges();
                }
                
                // Jeśli to serial i status zmieniono na 'watched', oznacz wszystkie odcinki jako obejrzane
                if (movie.type === 'series' && selectedStatus === 'watched') {
                    const loadingNotification = this.showNotification('Oznaczam wszystkie odcinki jako obejrzane...', 'info', false);
                    await this.markAllEpisodesAsWatched(movie.id);
                    // Usuń notyfikację ładowania
                    if (loadingNotification && loadingNotification.parentNode) {
                        loadingNotification.style.transform = 'translateX(400px)';
                        setTimeout(() => {
                            if (loadingNotification.parentNode) {
                                document.body.removeChild(loadingNotification);
                            }
                        }, 300);
                    }
                }
                
                // Przeładuj dane filmów, aby odświeżyć listę
                await this.loadMoviesData();
                this.triggerFastApiRecalculation();
                this.closeModal();
                this.showNotification(movie.type === 'series' ? 'Serial został zaktualizowany!' : 'Film został zaktualizowany!');
            } else {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to update movie');
            }
        } catch (error) {
            console.error('Błąd podczas aktualizacji filmu:', error);
            this.showNotification('Błąd podczas aktualizacji filmu. Spróbuj ponownie.');
        }
    }

    // Funkcja do oznaczenia wszystkich odcinków serialu jako obejrzanych
    async markAllEpisodesAsWatched(seriesId) {
        try {
            // Pobierz wszystkie odcinki serialu
            const response = await fetch(`/api/series/${seriesId}/episodes`, {
                method: 'GET',
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error('Failed to fetch episodes');
            }

            const data = await response.json();

            // Oznacz każdy nieobejrzany odcinek jako obejrzany
            for (const season of data.seasons) {
                for (const episode of season.episodes) {
                    // Sprawdź czy odcinek NIE jest już obejrzany
                    if (!episode.isWatched) {
                        await fetch(`/api/series/${seriesId}/episodes`, {
                            method: 'POST',
                            headers: this.getAuthHeaders(),
                            body: JSON.stringify({
                                episodeId: episode.id,
                                watched: true,
                                markPrevious: false
                            })
                        });
                    }
                }
            }
            
            // Przeładuj dane filmów, aby zaktualizować postęp
            await this.loadMoviesData();
        } catch (error) {
            console.error('Błąd podczas oznaczania wszystkich odcinków jako obejrzanych:', error);
            // Nie pokazuj notyfikacji błędu - to operacja w tle
        }
    }

    async removeFromList() {
        const modal = document.getElementById('movie-modal');
        const movie = modal.currentMovie;

        if (!movie.id) {
            this.showNotification('Błąd: Brak identyfikatora filmu.');
            return;
        }

        if (!(await this.showConfirm(`Czy na pewno chcesz usunąć "${movie.title}" z listy?`, 'Potwierdzenie usunięcia'))) {
            return;
        }

        try {
            const response = await fetch(`/api/movies/${movie.id}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (response.ok) {
                // Przeładuj dane filmów, aby odświeżyć listę
                await this.loadMoviesData();
                this.closeModal();
                this.showNotification(`Usunięto "${movie.title}" z listy`);
            } else {
                const errorData = await response.json();
                throw new Error(errorData.error || 'Failed to delete movie');
            }
        } catch (error) {
            console.error('Error deleting movie:', error);
            this.showNotification('Błąd podczas usuwania filmu. Spróbuj ponownie.');
        }
    }

    showNotification(message, type = 'success', autoHide = true, duration = 3000) {
        const notification = document.createElement('div');
        notification.className = 'notification';
        
        // Dodaj ikonę w zależności od typu
        let icon = '';
        let bgColor = 'var(--secondary-color)';
        
        if (type === 'info') {
            icon = '<i class="fas fa-spinner fa-spin"></i> ';
            bgColor = '#2196F3';
        } else if (type === 'error') {
            icon = '<i class="fas fa-exclamation-circle"></i> ';
            bgColor = '#f44336';
        } else {
            icon = '<i class="fas fa-check-circle"></i> ';
        }
        
        notification.innerHTML = icon + message;
        notification.style.cssText = `
            position: fixed;
            top: 90px;
            right: 20px;
            background-color: ${bgColor};
            color: white;
            padding: 1rem 2rem;
            border-radius: 5px;
            box-shadow: var(--shadow);
            z-index: 3000;
            transform: translateX(400px);
            transition: transform 0.3s ease;
        `;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.transform = 'translateX(0)';
        }, 100);

        if (autoHide) {
            setTimeout(() => {
                notification.style.transform = 'translateX(400px)';
                setTimeout(() => {
                    if (notification.parentNode) {
                        document.body.removeChild(notification);
                    }
                }, 300);
            }, duration);
        }
        
        return notification; // Zwróć element, aby móc go usunąć ręcznie
    }

    async generateCalendar() {
        const calendar = document.getElementById('calendar-container');

        // Ładuj rzeczywiste premiery z bazy danych
        const premieres = await this.loadPremieres();

        const calendarHTML = `
            <div class="calendar-header">
                <h3>${this.getMonthName(this.calendarMonth)} ${this.calendarYear}</h3>
                <div class="calendar-nav">
                    <button onclick="app.changeMonth(-1)">‹</button>
                    <button onclick="app.goToToday()" class="today-btn">Dzisiaj</button>
                    <button onclick="app.changeMonth(1)">›</button>
                </div>
            </div>
            <div class="calendar-grid">
                ${this.generateCalendarDays(this.calendarYear, this.calendarMonth, premieres)}
            </div>
        `;

        calendar.innerHTML = calendarHTML;
    }

    async loadPremieres() {
        try {
            const premieres = [];
            
            // Sprawdź czy użytkownik jest zalogowany
            const token = localStorage.getItem('movieTrackerToken') || localStorage.getItem('token');
            if (!token) {
                console.log('User not logged in, skipping calendar load');
                return [];
            }
            
            // Oblicz zakres dat widocznej siatki kalendarza
            const firstDay = new Date(this.calendarYear, this.calendarMonth, 1);
            const dayOfWeek = firstDay.getDay();
            const daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
            const gridStart = new Date(firstDay);
            gridStart.setDate(gridStart.getDate() - daysToSubtract);
            const gridEnd = new Date(gridStart);
            gridEnd.setDate(gridEnd.getDate() + 41);
            const dateFrom = gridStart.toISOString().split('T')[0];
            const dateTo   = gridEnd.toISOString().split('T')[0];

            // Pobierz tylko filmy z datą premiery w widocznym zakresie
            const moviesRes = await fetch(`/api/search?mode=calendar&date_from=${dateFrom}&date_to=${dateTo}`, { headers: this.getAuthHeaders() });
            console.log('Calendar API response status:', moviesRes.status);
            if (moviesRes.ok) {
                const data = await moviesRes.json();
                // Nowe API zwraca { results: [...] }
                const movies = data.results || (Array.isArray(data) ? data : []);
                console.log('Loaded movies for calendar:', movies.length);
                
                movies.forEach(movie => {
                    // Sprawdź release_date dla filmów i seriali
                    if (movie.release_date) {
                        // Wyciągnij datę - jeśli format YYYY-MM-DD, YYYY-MM lub tylko YYYY
                        let dateMatch = String(movie.release_date).match(/^(\d{4}-\d{2}-\d{2})/);
                        if (!dateMatch) {
                            // Jeśli brak pełnej daty, spróbuj YYYY-MM
                            dateMatch = String(movie.release_date).match(/^(\d{4}-\d{2})/);
                            if (dateMatch) {
                                dateMatch[1] = dateMatch[1] + '-01'; // Dodaj pierwszy dzień miesiąca
                            } else {
                                // Jeśli tylko rok YYYY, dodaj -01-01
                                const yearMatch = String(movie.release_date).match(/^(\d{4})/);
                                if (yearMatch) {
                                    dateMatch = [null, yearMatch[1] + '-01-01'];
                                }
                            }
                        }
                        if (dateMatch) {
                            console.log(`Adding premiere: ${movie.title} on ${dateMatch[1]}`);
                            premieres.push({
                                date: dateMatch[1],
                                title: movie.title,
                                type: movie.media_type === 'series' ? 'series' : 'movie',
                                id: movie.id,
                                trailer_url: movie.trailer_url || null,
                                poster: movie.poster || null,
                                description: movie.description || ''
                            });
                        }
                    }
                });
                
                // Pobierz odcinki dla seriali
                const series = movies.filter(m => m.media_type === 'series');
                console.log('Found series:', series.length, series.map(s => s.title));
                for (const s of series) {
                    try {
                        // Usuń prefix "db_" z ID
                        const cleanId = s.id.toString().replace(/^db_/, '');
                        const episodesRes = await fetch(`/api/series/${cleanId}/episodes`, { headers: this.getAuthHeaders() });
                        if (episodesRes.ok) {
                            const data = await episodesRes.json();
                            // API zwraca {seasons: [{episodes: [...]}]}
                            if (data.seasons && Array.isArray(data.seasons)) {
                                let episodeCount = 0;
                                data.seasons.forEach(season => {
                                    if (season.episodes && Array.isArray(season.episodes)) {
                                        season.episodes.forEach(ep => {
                                            episodeCount++;
                                            if (ep.airDate || ep.air_date) {
                                                const airDate = ep.airDate || ep.air_date;
                                                const dateMatch = String(airDate).match(/^(\d{4}-\d{2}-\d{2})/);
                                                if (dateMatch) {
                                                    console.log(`Adding episode premiere: ${s.title} - ${ep.displayNumber || ep.display_number} on ${dateMatch[1]}`);
                                                    premieres.push({
                                                        date: dateMatch[1],
                                                        title: `${s.title} - ${ep.displayNumber || ep.display_number || 'Odcinek'}`,
                                                        type: 'episode',
                                                        id: s.id
                                                    });
                                                }
                                            }
                                        });
                                    }
                                });
                                console.log(`Processed ${episodeCount} episodes for ${s.title}`);
                            }
                        }
                    } catch (e) {
                        console.debug(`Could not load episodes for series ${s.id}:`, e);
                    }
                }
            }
            
            console.log('Total premieres loaded:', premieres.length);
            console.log('Movies with trailer_url:', premieres.filter(p => p.type === 'movie' && p.trailer_url).length);
            console.log('Movies without trailer_url:', premieres.filter(p => p.type === 'movie' && !p.trailer_url).length);
            console.log('Series with trailer_url:', premieres.filter(p => p.type === 'series' && p.trailer_url).length);
            console.log('Episodes:', premieres.filter(p => p.type === 'episode').length);
            return premieres;
        } catch (error) {
            console.error('Error loading premieres:', error);
            return [];
        }
    }

    generateCalendarDays(year, month, premieres) {
        const firstDay = new Date(year, month, 1);
        const lastDay = new Date(year, month + 1, 0);
        const startDate = new Date(firstDay);
        
        // Dostosuj do poniedziałku jako pierwszego dnia tygodnia
        // getDay() zwraca 0-6 (Niedziela=0, Poniedziałek=1)
        // Chcemy: Poniedziałek=0, więc: (getDay() + 6) % 7
        let dayOfWeek = firstDay.getDay();
        let daysToSubtract = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Niedziela=6, Poniedziałek=0
        startDate.setDate(startDate.getDate() - daysToSubtract);

        let html = '';
        const dayNames = ['Pon', 'Wto', 'Śro', 'Czw', 'Pią', 'Sob', 'Nie'];
        
        // Dodaj nagłówki dni
        dayNames.forEach(day => {
            html += `<div class="calendar-day-header">${day}</div>`;
        });

        // Generuj dni kalendarza
        for (let i = 0; i < 42; i++) {
            const currentDate = new Date(startDate);
            currentDate.setDate(startDate.getDate() + i);
            
            const isCurrentMonth = currentDate.getMonth() === month;
            const isToday = this.isToday(currentDate);
            
            // Użyj lokalnej daty zamiast UTC aby uniknąć przesunięcia czasowego
            const dateYear = currentDate.getFullYear();
            const dateMonth = String(currentDate.getMonth() + 1).padStart(2, '0');
            const dateDay = String(currentDate.getDate()).padStart(2, '0');
            const dateString = `${dateYear}-${dateMonth}-${dateDay}`;
            
            const dayPremieres = premieres.filter(p => p.date === dateString);
            if (dayPremieres.length > 0) {
                console.log(`Day ${dateString} has ${dayPremieres.length} premieres:`, dayPremieres.map(p => p.title));
            }
            
            html += `
                <div class="calendar-day ${!isCurrentMonth ? 'other-month' : ''} ${isToday ? 'today' : ''}">
                    <div class="day-number">${currentDate.getDate()}</div>
                    ${dayPremieres.map(p => {
                        const clickHandler = p.id ? `onclick="app.openMovieFromCalendar('${p.id}')" style="cursor: pointer;"` : '';
                        return `<div class="premiere-item premiere-${p.type}" ${clickHandler} title="${p.id ? 'Kliknij aby otworzyć' : p.title}">${this.escapeHtml(p.title)}</div>`;
                    }).join('')}
                </div>
            `;
        }

        return html;
    }

    loadCharts() {
        this.loadTypeChart();
        this.loadGenreChart();
        this.loadTimeChart();
    }

    destroyChart(key) {
        if (this._charts && this._charts[key]) {
            this._charts[key].destroy();
            this._charts[key] = null;
        }
    }

    loadTypeChart() {
        if (!this._charts) this._charts = {};
        this.destroyChart('type');
        const ctx = document.getElementById('typeChart').getContext('2d');
        const movies = this.watchedMovies.filter(item => item.type === 'movie').length;
        const series = this.watchedMovies.filter(item => item.type === 'series').length;

        this._charts['type'] = new Chart(ctx, {
            type: 'doughnut',
            data: {
                labels: ['Filmy', 'Seriale'],
                datasets: [{
                    data: [movies, series],
                    backgroundColor: ['#3498db', '#e74c3c']
                }]
            },
            options: {
                responsive: true,
                plugins: {
                    legend: {
                        position: 'bottom'
                    }
                }
            }
        });
    }

    loadGenreChart() {
        if (!this._charts) this._charts = {};
        this.destroyChart('genre');
        const ctx = document.getElementById('genreChart').getContext('2d');
        const genres = {};
        
        this.watchedMovies.forEach(item => {
            genres[item.genre] = (genres[item.genre] || 0) + 1;
        });

        this._charts['genre'] = new Chart(ctx, {
            type: 'bar',
            data: {
                labels: Object.keys(genres),
                datasets: [{
                    label: 'Liczba produkcji',
                    data: Object.values(genres),
                    backgroundColor: '#3498db'
                }]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    }

    loadTimeChart() {
        if (!this._charts) this._charts = {};
        this.destroyChart('time');
        const ctx = document.getElementById('timeChart').getContext('2d');
        const monthlyData = {};
        
        this.watchedMovies.forEach(item => {
            const month = item.watchedDate.substring(0, 7);
            monthlyData[month] = (monthlyData[month] || 0) + 1;
        });

        this._charts['time'] = new Chart(ctx, {
            type: 'line',
            data: {
                labels: Object.keys(monthlyData),
                datasets: [{
                    label: 'Obejrzane produkcje',
                    data: Object.values(monthlyData),
                    borderColor: '#3498db',
                    backgroundColor: 'rgba(52, 152, 219, 0.1)',
                    fill: true
                }]
            },
            options: {
                responsive: true,
                scales: {
                    y: {
                        beginAtZero: true
                    }
                }
            }
        });
    }

    generateYearOptions() {
        const yearFilter = document.getElementById('year-filter');
        const currentYear = new Date().getFullYear();
        
        for (let year = currentYear; year >= 1900; year--) {
            const option = document.createElement('option');
            option.value = year;
            option.textContent = year;
            yearFilter.appendChild(option);
        }
    }

    // Funkcje pomocnicze
    formatDate(dateString) {
        const date = new Date(dateString);
        return date.toLocaleDateString('pl-PL');
    }

    getMonthName(month) {
        const months = [
            'Styczeń', 'Luty', 'Marzec', 'Kwiecień', 'Maj', 'Czerwiec',
            'Lipiec', 'Sierpień', 'Wrzesień', 'Październik', 'Listopad', 'Grudzień'
        ];
        return months[month];
    }

    isToday(date) {
        const today = new Date();
        return date.toDateString() === today.toDateString();
    }

    async changeMonth(direction) {
        // Nawigacja po miesiącach
        this.calendarMonth += direction;
        
        // Obsługa przekroczenia zakresu miesięcy
        if (this.calendarMonth > 11) {
            this.calendarMonth = 0;
            this.calendarYear++;
        } else if (this.calendarMonth < 0) {
            this.calendarMonth = 11;
            this.calendarYear--;
        }
        
        // Przerysuj kalendarz
        await this.generateCalendar();
    }

    async goToToday() {
        // Powrót do aktualnego miesiąca
        const now = new Date();
        this.calendarMonth = now.getMonth();
        this.calendarYear = now.getFullYear();
        await this.generateCalendar();
    }

    async openMovieFromCalendar(movieId) {
        try {
            // Usuń prefix "db_" jeśli istnieje
            const cleanId = movieId.toString().replace(/^db_/, '');
            // Pobierz szczegóły filmu
            const response = await fetch(`/api/movies/${cleanId}`, {
                headers: this.getAuthHeaders()
            });
            
            if (!response.ok) {
                this.showNotification('Nie można załadować filmu', 'error');
                return;
            }
            
            const movie = await response.json();
            
            // Sprawdź czy film jest już na liście użytkownika
            const watchedMovie = this.watchedMovies.find(m => m.id === movieId);
            
            if (watchedMovie) {
                // Film jest już na liście - otwórz z zakładką informacji
                await this.openMovieModal(watchedMovie, false);
            } else {
                // Film nie jest na liście - otwórz w trybie dodawania
                await this.openMovieModal(movie, false);
            }
        } catch (error) {
            console.error('Error opening movie from calendar:', error);
            this.showNotification('Błąd podczas otwierania filmu', 'error');
        }
    }

    filterMyList(status) {
        // Zapisz aktualnie wybrany status
        this.currentListStatus = status;
        // Filtruj listę na podstawie statusu
        this.displayMyList(status);
        console.log('Filtering list by status:', status);
    }

    changeViewMode(viewMode) {
        // Przełącz między widokiem siatki a widokiem listy
        this.currentView = viewMode;
        
        const myListContainer = document.getElementById('my-list-content');
        
        if (myListContainer) {
            if (viewMode === 'list') {
                myListContainer.classList.add('my-list-list');
                myListContainer.classList.remove('my-list-grid');
            } else {
                myListContainer.classList.add('my-list-grid');
                myListContainer.classList.remove('my-list-list');
            }
            
            // Przerysuj listę z nowym trybem widoku
            this.displayMyList(this.currentListStatus);
        }
        
        console.log('Changed view mode to:', viewMode);
    }

    editItem(itemId) {
        // Znajdź i edytuj element
        const item = this.watchedMovies.find(movie => movie.id === itemId);
        if (item) {
            console.log('Editing item:', item);
            // Otwórz modal w trybie informacji (edycja będzie dostępna przez zakładkę)
            this.openMovieModal(item, false);
        } else {
            console.error('Item not found:', itemId);
            this.showNotification('Nie znaleziono filmu do edycji.');
        }
    }

    async deleteItem(itemId) {
        // Usuń element z listy
        const item = this.watchedMovies.find(movie => movie.id === itemId);
        
        if (!item) {
            this.showNotification('Nie znaleziono filmu do usunięcia.');
            return;
        }

        if (!(await this.showConfirm(`Czy na pewno chcesz usunąć "${item.title}" z listy?`, 'Potwierdzenie usunięcia'))) {
            return;
        }

        try {
            const response = await fetch(`/api/movies/${itemId}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (response.ok) {
                // Przeładuj dane filmów, aby odświeżyć listę
                await this.loadMoviesData();
                this.showNotification(`Usunięto "${item.title}" z listy`);
            } else {
                const errorData = await response.json();
                console.error('Delete error response:', errorData);
                throw new Error(errorData.error || 'Failed to delete movie');
            }
        } catch (error) {
            console.error('Error deleting movie:', error);
            this.showNotification('Błąd podczas usuwania filmu. Spróbuj ponownie.');
        }
    }

    async loadEpisodesIntoTab(seriesId) {
        const container = document.getElementById('series-seasons-container');
        container.innerHTML = '<p style="text-align: center; padding: 20px;"><i class="fas fa-spinner fa-spin"></i> Ładowanie odcinków...</p>';
        
        try {
            const response = await fetch(`/api/series/${seriesId}/episodes`, {
                headers: this.getAuthHeaders()
            });

            if (!response.ok) {
                throw new Error('Failed to fetch episodes');
            }

            const data = await response.json();
            container.innerHTML = '';

            if (!data.seasons || data.seasons.length === 0) {
                container.innerHTML = '<p style="text-align: center; padding: 20px;">Brak odcinków do wyświetlenia. Serial może nie być jeszcze skonfigurowany.</p>';
                return;
            }

            // Dodaj wskazówkę dla użytkownika
            const hintDiv = document.createElement('div');
            hintDiv.className = 'episodes-hint';
            hintDiv.innerHTML = `
                <i class="fas fa-info-circle"></i>
                <span>Kliknij w odcinek, aby zobaczyć szczegóły • Użyj checkboxa, aby oznaczyć jako obejrzany</span>
            `;
            container.appendChild(hintDiv);

            // Renderuj sezony
            data.seasons.forEach(season => {
                const watchedCount = season.episodes.filter(ep => ep.isWatched).length;
                const totalCount = season.episodes.length;
                
                const seasonDiv = document.createElement('div');
                seasonDiv.className = 'season-section';
                
                const today = new Date();
                today.setHours(0, 0, 0, 0);
                
                seasonDiv.innerHTML = `
                    <div class="season-header" onclick="this.nextElementSibling.classList.toggle('active')">
                        <h3>Sezon ${season.seasonNumber}</h3>
                        <span class="season-progress">${watchedCount}/${totalCount} odcinków</span>
                    </div>
                    <div class="season-episodes">
                        ${season.episodes.map(episode => {
                            // Sprawdź czy odcinek ma premierę w przyszłości
                            let isFutureRelease = false;
                            let airDateInfo = '';
                            if (episode.airDate) {
                                const airDate = new Date(episode.airDate);
                                airDate.setHours(0, 0, 0, 0);
                                isFutureRelease = airDate > today;
                                if (isFutureRelease) {
                                    airDateInfo = `<span style="color: #ff9800; font-size: 0.85em;"> • Premiera: ${episode.airDate}</span>`;
                                }
                            }
                            
                            return `
                            <div class="episode-item ${episode.isWatched ? 'watched' : ''} ${isFutureRelease ? 'future-release' : ''}" data-episode-id="${episode.id}">
                                <input type="checkbox" 
                                    class="episode-checkbox" 
                                    ${episode.isWatched ? 'checked' : ''}
                                    ${isFutureRelease ? 'disabled title="Premiera jeszcze się nie odbyła"' : ''}
                                    onchange="app.toggleEpisode(${seriesId}, ${episode.id}, ${season.seasonNumber}, ${episode.episodeNumber}, this.checked)"
                                    onclick="event.stopPropagation()">
                                <span class="episode-label" onclick="app.showEpisodeDetails(${seriesId}, ${episode.id}, event)" style="cursor: pointer; flex: 1;">
                                    Odcinek ${episode.episodeNumber}
                                    ${episode.duration ? `<span style="color: #888; font-size: 0.9em;"> • ${episode.duration} min</span>` : ''}
                                    ${airDateInfo}
                                </span>
                            </div>
                        `}).join('')}
                    </div>
                `;
                container.appendChild(seasonDiv);
            });
        } catch (error) {
            console.error('Error loading episodes:', error);
            container.innerHTML = '<p style="text-align: center; padding: 20px; color: #e74c3c;">Błąd podczas ładowania odcinków.</p>';
        }
    }

    // Funkcja openSeriesEpisodes usunięta - używamy zakładki odcinków w głównym modalu

    async toggleEpisode(seriesId, episodeId, seasonNumber, episodeNumber, isChecked) {
        try {
            // Sprawdź czy odcinek ma premierę w przyszłości (tylko przy zaznaczaniu)
            if (isChecked) {
                const episodeItem = document.querySelector(`.episode-item[data-episode-id="${episodeId}"]`);
                if (episodeItem && episodeItem.classList.contains('future-release')) {
                    this.showNotification('Nie możesz oznaczyć odcinka jako obejrzany przed jego premierą', 'error');
                    // Odznacz checkbox
                    const checkbox = episodeItem.querySelector('.episode-checkbox');
                    if (checkbox) checkbox.checked = false;
                    return;
                }
            }
            
            // Jeśli użytkownik zaznacza odcinek jako obejrzany, upewnij się, że serial jest w liście
            if (isChecked) {
                const series = this.watchedMovies.find(m => m.id === seriesId);
                if (!series) {
                    // Serial nie jest jeszcze na liście - dodaj go jako 'watching'
                    const movieResponse = await fetch(`/api/movies/${seriesId}`, {
                        headers: this.getAuthHeaders()
                    });
                    
                    if (movieResponse.ok) {
                        const movieData = await movieResponse.json();
                        // Jeśli serial nie ma statusu, dodaj go jako 'watching'
                        if (!movieData.status || movieData.status === 'planning') {
                            await fetch(`/api/movies/${seriesId}`, {
                                method: 'PUT',
                                headers: {
                                    ...this.getAuthHeaders(),
                                    'Content-Type': 'application/json'
                                },
                                body: JSON.stringify({
                                    status: 'watching',
                                    rating: movieData.rating || 0,
                                    review: movieData.review || ''
                                })
                            });
                        }
                    }
                }
            }
            
            const response = await fetch(`/api/series/${seriesId}/episodes`, {
                method: 'POST',
                headers: {
                    ...this.getAuthHeaders(),
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    episodeId,
                    watched: isChecked
                })
            });

            if (!response.ok) {
                throw new Error('Failed to update episode');
            }

            const data = await response.json();
            
            // Sprawdź, czy ukończono jakieś wyzwania
            if (data.completedChallenges && data.completedChallenges.length > 0) {
                for (const completed of data.completedChallenges) {
                    this.showNotification(
                        `🎉 Gratulacje! Ukończyłeś wyzwanie "${completed.challengeTitle}" i zdobyłeś odznakę "${completed.badge.name}"!`,
                        'success',
                        true,
                        7000
                    );
                }
                // Odśwież odznaki w profilu
                await this.loadBadges();
            }

            // Sprawdź czy były poprzednie nieobejrzane odcinki
            if (data.hasPreviousUnwatched && isChecked) {
                if (await this.showConfirm(`Odcinek ${episodeNumber} w sezonie ${seasonNumber} został zaznaczony. Czy oznaczyć poprzednie odcinki jako obejrzane?`, 'Zaznacz poprzednie odcinki')) {
                    // Oznacz poprzednie odcinki jako obejrzane
                    const markPreviousResponse = await fetch(`/api/series/${seriesId}/episodes`, {
                        method: 'POST',
                        headers: {
                            ...this.getAuthHeaders(),
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            episodeId,
                            watched: true,
                            markPrevious: true
                        })
                    });

                    if (markPreviousResponse.ok) {
                        // Przeładuj zakładkę odcinków
                        await this.loadEpisodesIntoTab(seriesId);
                        return; // Wyjdź z funkcji, ponieważ odcinki zostały już przeładowane
                    }
                }
            }

            // Zaktualizuj wyświetlanie elementu odcinka
            const episodeItem = document.querySelector(`.episode-item[data-episode-id="${episodeId}"]`);
            if (episodeItem) {
                if (isChecked) {
                    episodeItem.classList.add('watched');
                } else {
                    episodeItem.classList.remove('watched');
                }
                
                // Zaktualizuj licznik postępu sezonu
                const seasonSection = episodeItem.closest('.season-section');
                if (seasonSection) {
                    const checkboxes = seasonSection.querySelectorAll('.episode-checkbox');
                    const watchedCount = Array.from(checkboxes).filter(cb => cb.checked).length;
                    const totalCount = checkboxes.length;
                    const progressSpan = seasonSection.querySelector('.season-progress');
                    if (progressSpan) {
                        progressSpan.textContent = `${watchedCount}/${totalCount} odcinków`;
                    }
                }
            }

            // Przeładuj dane filmów, aby zaktualizować postęp
            await this.loadMoviesData();
            
            // Jeśli użytkownik jest w sekcji Moja Lista, odśwież jej widok
            if (this.currentSection === 'my-list') {
                this.displayMyList(this.currentListStatus);
            }
            
        } catch (error) {
            console.error('Error toggling episode:', error);
            this.showNotification('Błąd podczas aktualizacji odcinka.');
        }
    }

    async showEpisodeDetails(seriesId, episodeId, event) {
        // Zatrzymaj propagację aby nie kliknąć checkboxa
        event.stopPropagation();
        event.preventDefault();
        
        try {
            const response = await fetch(`/api/series/${seriesId}/episodes`, {
                headers: this.getAuthHeaders()
            });
            
            if (!response.ok) {
                this.showNotification('Nie można załadować szczegółów odcinka', 'error');
                return;
            }
            
            const data = await response.json();
            // API zwraca {seasons: [{episodes: [...]}]}
            let episode = null;
            if (data.seasons) {
                for (const season of data.seasons) {
                    if (season.episodes) {
                        episode = season.episodes.find(ep => ep.id === episodeId);
                        if (episode) break;
                    }
                }
            }
            
            if (!episode) {
                this.showNotification('Nie znaleziono odcinka', 'error');
                return;
            }
            
            // Wyświetl szczegóły w oknie dialogowym
            const details = `
                <div style="text-align: left; padding: 20px;">
                    <h3>${episode.displayNumber || `Odcinek ${episode.episodeNumber}`}</h3>
                    <p><strong>Tytuł:</strong> ${episode.title || 'Brak tytułu'}</p>
                    <p><strong>Długość:</strong> ${episode.duration || 'Nieznana'} minut</p>
                    ${episode.airDate ? `<p><strong>Data emisji:</strong> ${episode.airDate}</p>` : ''}
                    ${episode.description ? `<p><strong>Opis:</strong><br>${episode.description}</p>` : ''}
                    <button onclick="this.closest('.modal').remove();" class="btn btn-primary" style="margin-top: 20px;">Zamknij</button>
                </div>
            `;
            
            // Użyj istniejących klas CSS dla modala
            const modal = document.createElement('div');
            modal.className = 'modal active';
            modal.innerHTML = `<div class="modal-content" style="max-width: 500px; margin: 5rem auto;">${details}</div>`;
            modal.onclick = (e) => {
                if (e.target === modal) {
                    modal.remove();
                }
            };
            
            document.body.appendChild(modal);
            
        } catch (error) {
            console.error('Error loading episode details:', error);
            this.showNotification('Błąd podczas ładowania szczegółów odcinka', 'error');
        }
    }

    // ============= MODAL WYBORU ULUBIONYCH FILMÓW =============

    _updateFavoritesBanner() {
        const banner = document.getElementById('favorites-banner');
        if (!banner) return;
        const modal = document.getElementById('favorites-modal');
        const modalOpen = modal && modal.style.display !== 'none' && modal.style.display !== '';
        // Baner znika gdy użytkownik choć raz przeszedł przez onboarding (nawet pomijając)
        const notSetup = !this.currentUser?.favorites_selected;
        const show = !!this.currentUser && notSetup && !modalOpen;
        banner.style.display = show ? 'block' : 'none';
    }

    dismissFavoritesBanner() {
        sessionStorage.setItem('favorites_banner_dismissed', '1');
        const banner = document.getElementById('favorites-banner');
        if (banner) banner.style.display = 'none';
    }

    async showFavoritesModal() {
        const modal = document.getElementById('favorites-modal');
        if (!modal) return;

        // Ukryj baner gdy modal jest otwarty
        const banner = document.getElementById('favorites-banner');
        if (banner) banner.style.display = 'none';

        this._onboardingSelected = new Map();
        this._onboardingMoviesCache = new Map();

        modal.style.display = 'block';
        document.body.style.overflow = 'hidden';

        this._setOnboardingStep(1);

        const searchInput = document.getElementById('favorites-search-input');
        const clearSearchBtn = document.getElementById('favorites-search-clear-btn');
        const rerollBtn = document.getElementById('favorites-reroll-btn');
        const skipBtn = document.getElementById('favorites-skip-btn');
        const skipBtn2 = document.getElementById('favorites-skip-btn2');
        const saveBtn = document.getElementById('favorites-save-btn');
        const backBtn = document.getElementById('onboarding-back-btn');
        const skipWatchedBtn = document.getElementById('onboarding-skip-watched-btn');
        const confirmWatchedBtn = document.getElementById('onboarding-confirm-watched-btn');

        if (searchInput) {
            searchInput.value = '';
            const freshSearch = searchInput.cloneNode(true);
            searchInput.replaceWith(freshSearch);
            freshSearch.addEventListener('input', (e) => {
                const q = e.target.value.trim();
                const clr = document.getElementById('favorites-search-clear-btn');
                if (clr) clr.style.display = q ? 'block' : 'none';
                clearTimeout(this._onboardingSearchTimer);
                this._onboardingSearchTimer = setTimeout(() => {
                    this._loadFavoritesMovies(q);
                }, 260);
            });
            freshSearch.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    clearTimeout(this._onboardingSearchTimer);
                    this._loadFavoritesMovies(freshSearch.value.trim());
                }
            });
        }

        if (clearSearchBtn) {
            const freshClear = clearSearchBtn.cloneNode(true);
            clearSearchBtn.replaceWith(freshClear);
            freshClear.style.display = 'none';
            freshClear.addEventListener('click', () => {
                const inp = document.getElementById('favorites-search-input');
                if (inp) inp.value = '';
                freshClear.style.display = 'none';
                this._loadFavoritesMovies('');
            });
        }

        if (rerollBtn) {
            const freshReroll = rerollBtn.cloneNode(true);
            rerollBtn.replaceWith(freshReroll);
            freshReroll.addEventListener('click', () => {
                const inp = document.getElementById('favorites-search-input');
                const clr = document.getElementById('favorites-search-clear-btn');
                if (inp) inp.value = '';
                if (clr) clr.style.display = 'none';
                this._loadFavoritesMovies('');
            });
        }

        const bindFresh = (el, handler) => {
            if (!el) return null;
            const fresh = el.cloneNode(true);
            el.replaceWith(fresh);
            fresh.addEventListener('click', handler);
            return fresh;
        };

        bindFresh(skipBtn, () => this.closeFavoritesModal(true));
        bindFresh(skipBtn2, () => this.closeFavoritesModal(true));
        const freshSave = bindFresh(saveBtn, () => this.saveFavoriteMovies());
        if (freshSave) {
            freshSave.disabled = false;
            freshSave.innerHTML = '<i class="fas fa-arrow-right"></i> Dalej';
        }
        bindFresh(backBtn, () => this._setOnboardingStep(1));
        bindFresh(skipWatchedBtn, () => this.confirmOnboardingWatched(true));
        const freshConfirm = bindFresh(confirmWatchedBtn, () => this.confirmOnboardingWatched(false));
        if (freshConfirm) {
            freshConfirm.disabled = false;
            freshConfirm.innerHTML = '<i class="fas fa-check"></i> Dodaj do obejrzanych i zapisz';
        }

        if (!modal.dataset.backdropBound) {
            modal.dataset.backdropBound = '1';
            modal.addEventListener('click', (e) => {
                if (e.target === modal) this.closeFavoritesModal(true);
            });
        }

        this._renderSelectedFavoritesStrip();
        this._updateFavoritesCount();
        await this._loadFavoritesMovies('');
    }

    _setOnboardingStep(step) {
        const step1 = document.getElementById('favorites-step-1');
        const step2 = document.getElementById('favorites-step-2');
        const footer1 = document.getElementById('favorites-footer-step-1');
        const footer2 = document.getElementById('favorites-footer-step-2');
        const titleEl = document.getElementById('favorites-modal-title');
        const subEl = document.getElementById('favorites-modal-subtitle');

        if (step === 2) {
            if (step1) step1.style.display = 'none';
            if (step2) step2.style.display = 'block';
            if (footer1) footer1.style.display = 'none';
            if (footer2) footer2.style.display = 'flex';
            if (titleEl) titleEl.textContent = 'Oceń wybrane filmy';
            if (subEl) subEl.textContent = 'Dodaj wybrane produkcje do obejrzanych, wystaw ocenę w gwiazdkach i opcjonalną krótką recenzję.';
            this._renderOnboardingRateList();
        } else {
            if (step1) step1.style.display = 'block';
            if (step2) step2.style.display = 'none';
            if (footer1) footer1.style.display = 'flex';
            if (footer2) footer2.style.display = 'none';
            if (titleEl) titleEl.textContent = 'Witaj w MovieTracker!';
            if (subEl) subEl.textContent = 'Zaznacz filmy, które lubisz lub już widziałeś - im więcej wybierzesz, tym trafniejsze będą Twoje rekomendacje. Możesz też wyszukać własne tytuły.';
            this._updateFavoritesCount();
        }
    }

    async _loadFavoritesMovies(query = '') {
        const grid = document.getElementById('favorites-movies-grid');
        if (!grid) return;

        grid.innerHTML = '<div class="favorites-loading"><i class="fas fa-spinner fa-spin"></i><span>Szukam filmów...</span></div>';

        try {
            const endpoint = query && query.length >= 2
                ? `/api/auth/favorites-setup?q=${encodeURIComponent(query)}`
                : '/api/auth/favorites-setup';
            const res = await fetch(endpoint, {
                headers: this.getAuthHeaders(),
            });

            if (!res.ok) throw new Error('Błąd ładowania filmów');

            const movies = await res.json();

            if (!Array.isArray(movies) || movies.length === 0) {
                grid.innerHTML = query && query.length >= 2
                    ? `<p style="grid-column:1/-1;text-align:center;color:var(--text-secondary);padding:2rem;">Brak wyników dla "${this.escapeHtml(query)}". Spróbuj wpisać inny tytuł lub kliknij "Wylosuj inne".</p>`
                    : '<p style="grid-column:1/-1;text-align:center;color:var(--text-secondary);padding:2rem;">Brak filmów do wyświetlenia. Możesz pominąć ten krok.</p>';
                return;
            }

            movies.forEach((m) => {
                const poster = m.poster_url
                    ? (m.poster_url.startsWith('http://') ? m.poster_url.replace('http://', 'https://') : m.poster_url)
                    : `https://placehold.co/200x300/cccccc/666666/png?text=${encodeURIComponent(m.title || 'Film')}`;
                this._onboardingMoviesCache.set(Number(m.id), { ...m, poster_url: poster });
            });

            grid.innerHTML = movies.map(m => {
                const id = Number(m.id);
                const cached = this._onboardingMoviesCache.get(id);
                const poster = cached?.poster_url || `https://placehold.co/200x300/cccccc/666666/png?text=${encodeURIComponent(m.title || 'Film')}`;
                const isSelected = this._onboardingSelected.has(id);
                const year = m.release_date ? ` (${String(m.release_date).slice(0, 4)})` : '';
                return `
                    <div class="favorites-movie-card ${isSelected ? 'selected' : ''}" data-id="${id}" onclick="app._toggleFavoriteCard(this)">
                        <img class="favorites-movie-poster" src="${poster}" alt="${this.escapeHtml(m.title)}" loading="lazy"
                             onerror="this.src='https://placehold.co/200x300/cccccc/666666/png?text=${encodeURIComponent(m.title || 'Film')}'">
                        <div class="favorites-check-overlay"><i class="fas fa-check"></i></div>
                        <div class="favorites-movie-title">${this.escapeHtml(m.title)}${this.escapeHtml(year)}</div>
                    </div>
                `;
            }).join('');
            this._updateFavoritesCount();
        } catch (e) {
            console.error('Error loading favorites movies:', e);
            grid.innerHTML = '<p style="grid-column:1/-1;text-align:center;color:var(--text-secondary);padding:2rem;">Nie udało się załadować filmów.</p>';
        }
    }

    _toggleFavoriteCard(card) {
        const id = Number(card.dataset.id);
        if (!id) return;

        if (this._onboardingSelected.has(id)) {
            this._onboardingSelected.delete(id);
            card.classList.remove('selected');
        } else {
            const movie = this._onboardingMoviesCache.get(id) || {
                id,
                title: card.querySelector('.favorites-movie-title')?.textContent?.trim() || `Film #${id}`,
                poster_url: card.querySelector('img')?.src || '',
            };
            this._onboardingSelected.set(id, {
                ...movie,
                addToWatched: true,
                rating: 0,
                review: '',
            });
            card.classList.add('selected');
        }
        this._renderSelectedFavoritesStrip();
        this._updateFavoritesCount();
    }

    _renderSelectedFavoritesStrip() {
        const strip = document.getElementById('favorites-selected-strip');
        if (!strip) return;
        const items = Array.from(this._onboardingSelected.values());
        if (!items.length) {
            strip.style.display = 'none';
            strip.innerHTML = '';
            return;
        }
        strip.style.display = 'flex';
        strip.innerHTML = items.map(item => `
            <span class="favorites-selected-chip">
                <span>${this.escapeHtml(item.title)}</span>
                <button type="button" data-remove-id="${item.id}" title="Usuń z wybranych">&times;</button>
            </span>
        `).join('');

        strip.querySelectorAll('button[data-remove-id]').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = Number(btn.dataset.removeId);
                this._onboardingSelected.delete(id);
                const card = document.querySelector(`#favorites-movies-grid .favorites-movie-card[data-id="${id}"]`);
                if (card) card.classList.remove('selected');
                this._renderSelectedFavoritesStrip();
                this._updateFavoritesCount();
            });
        });
    }

    _updateFavoritesCount() {
        const selected = this._onboardingSelected ? this._onboardingSelected.size : 0;
        const label = document.getElementById('favorites-selected-count');
        if (!label) return;
        const step2 = document.getElementById('favorites-step-2');
        if (step2 && step2.style.display === 'block') {
            const toWatchCount = Array.from(this._onboardingSelected.values()).filter(it => it.addToWatched).length;
            const ratedCount = Array.from(this._onboardingSelected.values()).filter(it => it.addToWatched && it.rating > 0).length;
            label.textContent = `Do obejrzanych: ${toWatchCount}/${selected} | Oceniono: ${ratedCount}`;
            label.className = ratedCount > 0 ? 'favorites-count-label good' : 'favorites-count-label';
            return;
        }
        if (selected === 0) {
            label.textContent = 'Zaznacz co najmniej 3 filmy';
            label.className = 'favorites-count-label';
        } else if (selected < 3) {
            const left = 3 - selected;
            label.textContent = `Zaznaczono: ${selected} - jeszcze ${left} ${left === 1 ? 'film' : 'filmy'}`;
            label.className = 'favorites-count-label warn';
        } else {
            label.textContent = `Zaznaczono: ${selected} ✔`;
            label.className = 'favorites-count-label good';
        }
    }

    async closeFavoritesModal(skip = false) {
        const modal = document.getElementById('favorites-modal');
        if (!modal) return;

        modal.style.display = 'none';
        document.body.style.overflow = '';

        // Gdy użytkownik kliknie "Pomiń" - zapisz favorites_selected=1 żeby nie pytać ponownie.
        if (skip && this.currentUser && !this.currentUser.favorites_selected) {
            try {
                await fetch('/api/auth/favorites-setup', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
                    body: JSON.stringify({ movieIds: [], skipped: true }),
                });
                this.currentUser.favorites_selected = 1;
            } catch (e) {
                console.warn('Could not mark favorites as dismissed:', e);
            }
        }

        this._updateFavoritesBanner();
    }

    async saveFavoriteMovies() {
        const movieIds = Array.from(this._onboardingSelected.keys());

        // Jeśli nic nie zaznaczono - traktuj jak pominięcie
        if (movieIds.length === 0) {
            await this.closeFavoritesModal(true);
            this.showNotification('Pominięto wybór - możesz wrócić do ulubionych w ustawieniach.', 'info');
            return;
        }

        const saveBtn = document.getElementById('favorites-save-btn');
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Zapisywanie...';
        }

        try {
            // 1. Zapis konfiguracji (dodaje wpisy do user_onboarding_movies)
            const res = await fetch('/api/auth/favorites-setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
                body: JSON.stringify({ movieIds }),
            });

            if (!res.ok) throw new Error('Błąd zapisu');

            this.currentUser.favorites_selected = 1;
            this._updateFavoritesBanner();

            // Przejdz do kroku 2 w tym samym modalu: obejrzane + oceny + opcjonalna recenzja
            this._setOnboardingStep(2);
        } catch (e) {
            console.error('Error saving favorites:', e);
            this.showNotification('Błąd podczas zapisywania. Spróbuj ponownie.', 'error');
        } finally {
            if (saveBtn) {
                saveBtn.disabled = false;
                saveBtn.innerHTML = '<i class="fas fa-arrow-right"></i> Dalej';
            }
        }
    }

    _renderOnboardingRateList() {
        const listEl = document.getElementById('onboarding-rate-list');
        if (!listEl) return;

        const items = Array.from(this._onboardingSelected.values());
        listEl.innerHTML = items.map(item => {
            const year = item.release_date ? ` (${String(item.release_date).slice(0, 4)})` : '';
            const starsHtml = [1, 2, 3, 4, 5].map(n => `
                <button type="button" class="onboarding-star-btn ${item.rating >= n ? 'active' : ''}" data-movie-id="${item.id}" data-rating="${n}" ${!item.addToWatched ? 'disabled' : ''} title="Oceń na ${n}/5">
                    <i class="fas fa-star"></i>
                </button>
            `).join('');
            return `
                <div class="onboarding-rate-row ${!item.addToWatched ? 'is-unchecked' : ''}" data-rate-row="${item.id}">
                    <div class="onboarding-rate-check">
                        <input type="checkbox" class="onboarding-watch-checkbox" data-movie-id="${item.id}" ${item.addToWatched ? 'checked' : ''} title="Dodaj do obejrzanych">
                    </div>
                    <img class="onboarding-rate-poster" src="${item.poster_url}" alt="${this.escapeHtml(item.title)}" onerror="this.src='https://placehold.co/100x150/cccccc/666666/png?text=Film'">
                    <div class="onboarding-rate-info">
                        <div class="onboarding-rate-title">${this.escapeHtml(item.title)}${this.escapeHtml(year)}</div>
                        <div class="onboarding-rate-controls">
                            <div class="onboarding-stars" data-movie-id="${item.id}">
                                ${starsHtml}
                            </div>
                            <span class="onboarding-rating-label" data-rating-label="${item.id}">
                                ${item.rating > 0 ? `Twoja ocena: ${item.rating}/5` : 'Brak oceny (opcjonalnie)'}
                            </span>
                        </div>
                        <input type="text" class="onboarding-review-input" data-movie-id="${item.id}" value="${this.escapeHtml(item.review || '')}" placeholder="Krótka recenzja / opinia (opcjonalnie)..." ${!item.addToWatched ? 'disabled' : ''}>
                    </div>
                </div>
            `;
        }).join('');

        listEl.querySelectorAll('.onboarding-watch-checkbox').forEach(cb => {
            cb.addEventListener('change', () => {
                const id = Number(cb.dataset.movieId);
                const item = this._onboardingSelected.get(id);
                if (!item) return;
                item.addToWatched = cb.checked;
                const row = listEl.querySelector(`.onboarding-rate-row[data-rate-row="${id}"]`);
                if (row) {
                    row.classList.toggle('is-unchecked', !cb.checked);
                    row.querySelectorAll('.onboarding-star-btn, .onboarding-review-input').forEach(ctrl => {
                        ctrl.disabled = !cb.checked;
                    });
                }
                this._updateFavoritesCount();
            });
        });

        const highlightOnboardingStars = (starsWrap, count) => {
            if (!starsWrap) return;
            starsWrap.querySelectorAll('.onboarding-star-btn').forEach(b => {
                b.classList.toggle('active', Number(b.dataset.rating) <= count);
            });
        };

        listEl.querySelectorAll('.onboarding-stars').forEach(starsWrap => {
            const id = Number(starsWrap.dataset.movieId);
            starsWrap.querySelectorAll('.onboarding-star-btn').forEach(btn => {
                btn.addEventListener('mouseenter', () => {
                    const item = this._onboardingSelected.get(id);
                    if (!item || !item.addToWatched) return;
                    highlightOnboardingStars(starsWrap, Number(btn.dataset.rating));
                });
                btn.addEventListener('click', () => {
                    const val = Number(btn.dataset.rating);
                    const item = this._onboardingSelected.get(id);
                    if (!item || !item.addToWatched) return;
                    item.rating = item.rating === val ? 0 : val;

                    highlightOnboardingStars(starsWrap, item.rating);
                    const row = listEl.querySelector(`.onboarding-rate-row[data-rate-row="${id}"]`);
                    const lbl = row?.querySelector(`[data-rating-label="${id}"]`);
                    if (lbl) lbl.textContent = item.rating > 0 ? `Twoja ocena: ${item.rating}/5` : 'Brak oceny (opcjonalnie)';
                    this._updateFavoritesCount();
                });
            });
            starsWrap.addEventListener('mouseleave', () => {
                const item = this._onboardingSelected.get(id);
                highlightOnboardingStars(starsWrap, item ? item.rating : 0);
            });
        });

        listEl.querySelectorAll('.onboarding-review-input').forEach(inp => {
            inp.addEventListener('input', () => {
                const id = Number(inp.dataset.movieId);
                const item = this._onboardingSelected.get(id);
                if (item) item.review = inp.value;
            });
        });

        this._updateFavoritesCount();
    }

    async confirmOnboardingWatched(skipWatched = false) {
        if (skipWatched) {
            await this.closeFavoritesModal(false);
            this.showNotification('Ulubione filmy zostały zapisane! Przeliczam rekomendacje...', 'success');
            this.triggerFastApiRecalculation();
            return;
        }

        const selectedItems = Array.from(this._onboardingSelected.values()).filter(it => it.addToWatched);
        if (selectedItems.length === 0) {
            await this.closeFavoritesModal(false);
            this.showNotification('Ulubione filmy zostały zapisane! Przeliczam rekomendacje...', 'success');
            this.triggerFastApiRecalculation();
            return;
        }

        // Jeśli użytkownik wpisał recenzję tekstową, musi też kliknąć gwiazdkę (tabela reviews wymaga rating 1-5)
        for (const item of selectedItems) {
            if ((item.review || '').trim() && !item.rating) {
                this.showNotification(`Wystaw ocenę w gwiazdkach (1-5) dla filmu "${item.title}", jeśli dodałeś do niego recenzję.`, 'error');
                const row = document.querySelector(`.onboarding-rate-row[data-rate-row="${item.id}"]`);
                row?.scrollIntoView({ behavior: 'smooth', block: 'center' });
                return;
            }
        }

        const confirmBtn = document.getElementById('onboarding-confirm-watched-btn');
        if (confirmBtn) {
            confirmBtn.disabled = true;
            confirmBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Zapisuję...';
        }

        try {
            const payloadItems = selectedItems.map(it => ({
                movieId: it.id,
                rating: it.rating > 0 ? it.rating : null,
                review: (it.review || '').trim(),
            }));

            const res = await fetch('/api/auth/confirm-watched', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
                body: JSON.stringify({ items: payloadItems }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Błąd zapisu obejrzanych');

            await this.closeFavoritesModal(false);
            const ratedMsg = data.ratedCount > 0 ? ` i oceniono ${data.ratedCount}` : '';
            this.showNotification(`Dodano ${data.watchedCount ?? payloadItems.length} filmów do obejrzanych${ratedMsg}!`, 'success');
            await this.loadMoviesData();
            this.triggerFastApiRecalculation();
        } catch (e) {
            console.error('Błąd przenoszenia z onboardingu do obejrzanych:', e);
            this.showNotification(e.message || 'Wystąpił problem przy zapisywaniu obejrzanych i ocen.', 'error');
        } finally {
            if (confirmBtn) {
                confirmBtn.disabled = false;
                confirmBtn.innerHTML = '<i class="fas fa-check"></i> Dodaj do obejrzanych i zapisz';
            }
        }
    }

    // ============= KONIEC MODALU ULUBIONYCH =============

    // Metody uwierzytelniania
    async checkAuth() {
        this.authToken = localStorage.getItem('movieTrackerToken');
        if (this.authToken) {
            // Sprawdź czy token wygasł przed wykonaniem wywołania API
            if (this.isTokenExpired(this.authToken)) {
                console.log('Token expired, logging out...');
                localStorage.setItem('sessionExpired', 'true');
                localStorage.removeItem('movieTrackerToken');
                this.authToken = null;
                return;
            }
            
            try {
                const response = await fetch('/api/auth/me', {
                    headers: { 'Authorization': `Bearer ${this.authToken}` }
                });
                if (response.ok) {
                    const data = await response.json();
                    this.currentUser = data.user;
                    
                    // Synchronizuj motyw z preferencji użytkownika, jeśli nie ma w localStorage
                    const userTheme = data.user && data.user.theme_preference ? data.user.theme_preference : 'light';
                    const currentTheme = localStorage.getItem('theme');
                    if (!currentTheme || currentTheme !== userTheme) {
                        localStorage.setItem('theme', userTheme);
                        this.changeTheme(userTheme);
                    }
                    
                    // Uruchom sprawdzacz wygaśnięcia tokenu
                    this.startTokenExpirationChecker();
                } else {
                    localStorage.removeItem('movieTrackerToken');
                    this.authToken = null;
                }
            } catch (error) {
                console.error('Auth check failed:', error);
                localStorage.removeItem('movieTrackerToken');
                this.authToken = null;
            }
        }
    }

    isTokenExpired(token) {
        try {
            const payload = JSON.parse(atob(token));
            return payload.exp < Date.now();
        } catch (e) {
            console.error('Invalid token format:', e);
            return true; // Traktuj nieprawidłowy token jako wygasły
        }
    }

    startTokenExpirationChecker() {
        // Sprawdzaj wygaśnięcie tokenu co 5 minut
        if (this.tokenCheckInterval) {
            clearInterval(this.tokenCheckInterval);
        }
        
        this.tokenCheckInterval = setInterval(() => {
            if (this.isTokenExpired(this.authToken)) {
                clearInterval(this.tokenCheckInterval);
                alert('Twoja sesja wygasła. Zostaniesz wylogowany.');
                this.logout();
            }
        }, 5 * 60 * 1000); // Sprawdzaj co 5 minut
        
        // Sprawdź również 1 minutę przed wygaśnięciem, aby ostrzec użytkownika
        const token = this.authToken;
        try {
            const payload = JSON.parse(atob(token));
            const timeUntilExpiry = payload.exp - Date.now();
            const oneMinuteBeforeExpiry = timeUntilExpiry - (60 * 1000);
            
            if (oneMinuteBeforeExpiry > 0 && oneMinuteBeforeExpiry <= 2147483647) {
                setTimeout(() => {
                    if (!this.isTokenExpired(this.authToken)) {
                        alert('Twoja sesja wygaśnie za minutę. Zapisz swoją pracę.');
                    }
                }, oneMinuteBeforeExpiry);
            }
        } catch (e) {
            console.error('Error setting expiration warning:', e);
        }
    }

    showAuthScreen() {
        // Sprawdź czy sesja wygasła
        const sessionExpired = localStorage.getItem('sessionExpired');
        const expiredMessage = sessionExpired ? '<div class="auth-info" style="display: block; background-color: #ff9800; color: white; padding: 0.75rem; border-radius: 5px; margin-bottom: 1rem; text-align: center;"><i class="fas fa-clock"></i> Twoja sesja wygasła. Zaloguj się ponownie.</div>' : '';
        localStorage.removeItem('sessionExpired');
        
        document.body.innerHTML = `
            <div class="auth-container">
                <div class="auth-card">
                    <h2 id="auth-title">Zaloguj się do MovieTracker</h2>
                    ${expiredMessage}
                    <div id="auth-error" class="auth-error" style="display: none;"></div>
                    <form class="auth-form" id="auth-form">
                        <input type="text" id="nickname" placeholder="Nazwa użytkownika" class="auth-input" style="display: none;">
                        <input type="text" id="emailOrUsername" placeholder="Email lub nazwa użytkownika" class="auth-input" required>
                        <input type="password" id="password" placeholder="Hasło" class="auth-input" required minlength="6">
                        <small id="password-hint" style="color: var(--text-secondary); display: none; margin-top: 0.25rem; font-size: 0.85rem;">
                            Hasło musi mieć minimum 6 znaków
                        </small>
                        <button type="submit" class="auth-btn" id="auth-submit">Zaloguj się</button>
                    </form>
                    <div class="auth-toggle">
                        <span id="auth-toggle-text">Nie masz konta?</span>
                        <a id="auth-toggle-link">Utwórz konto</a>
                    </div>
                </div>
            </div>
        `;

        this.bindAuthEvents();
    }

    bindAuthEvents() {
        const form = document.getElementById('auth-form');
        const toggleLink = document.getElementById('auth-toggle-link');
        const passwordInput = document.getElementById('password');
        const passwordHint = document.getElementById('password-hint');
        let isLogin = true;

        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            const emailOrUsername = document.getElementById('emailOrUsername').value;
            const password = document.getElementById('password').value;
            const nickname = document.getElementById('nickname').value;

            // Walidacja email przy rejestracji
            if (!isLogin) {
                const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
                if (!emailRegex.test(emailOrUsername)) {
                    this.showAuthError('Podaj poprawny adres e-mail');
                    return;
                }
            }

            // Walidacja hasła przy rejestracji
            if (!isLogin && password.length < 6) {
                this.showAuthError('Hasło musi mieć minimum 6 znaków');
                return;
            }

            try {
                const endpoint = isLogin ? '/api/auth/login' : '/api/auth/register';
                const body = isLogin ? { emailOrUsername, password } : { nickname, email: emailOrUsername, password };

                const response = await fetch(endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });

                const data = await response.json();

                if (response.ok) {
                    this.authToken = data.token;
                    this.currentUser = data.user;
                    localStorage.setItem('movieTrackerToken', this.authToken);
                    
                    // Synchronizuj motyw z preferencji użytkownika
                    const userTheme = data.user && data.user.theme_preference ? data.user.theme_preference : 'light';
                    localStorage.setItem('theme', userTheme);
                    localStorage.removeItem('for-you-pending');
                    
                    // Przeładuj stronę z nowym stanem zalogowania
                    location.reload();
                } else {
                    this.showAuthError(data.error);
                }
            } catch (error) {
                this.showAuthError('Błąd połączenia. Spróbuj ponownie.');
            }
        });

        toggleLink.addEventListener('click', () => {
            isLogin = !isLogin;
            const title = document.getElementById('auth-title');
            const submitBtn = document.getElementById('auth-submit');
            const toggleText = document.getElementById('auth-toggle-text');
            const nicknameInput = document.getElementById('nickname');
            const emailOrUsernameInput = document.getElementById('emailOrUsername');

            if (isLogin) {
                title.textContent = 'Zaloguj się do MovieTracker';
                submitBtn.textContent = 'Zaloguj się';
                toggleText.textContent = 'Nie masz konta?';
                toggleLink.textContent = 'Utwórz konto';
                nicknameInput.style.display = 'none';
                nicknameInput.required = false;
                emailOrUsernameInput.type = 'text';
                emailOrUsernameInput.placeholder = 'Email lub nazwa użytkownika';
                passwordHint.style.display = 'none';
            } else {
                title.textContent = 'Utwórz konto MovieTracker';
                submitBtn.textContent = 'Zarejestruj się';
                toggleText.textContent = 'Masz już konto?';
                toggleLink.textContent = 'Zaloguj się';
                nicknameInput.style.display = 'block';
                nicknameInput.required = true;
                emailOrUsernameInput.type = 'email';
                emailOrUsernameInput.placeholder = 'Adres email';
                passwordHint.style.display = 'block';
            }
        });
    }

    showAuthError(message) {
        const errorDiv = document.getElementById('auth-error');
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
    }

    getAuthHeaders() {
        return {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${this.authToken}`
        };
    }

    escapeHtml(str) {
        if (str === undefined || str === null) return '';
        return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    logout() {
        // Wyczyść interwał sprawdzający token
        if (this.tokenCheckInterval) {
            clearInterval(this.tokenCheckInterval);
        }
        const askWidget = document.getElementById('ask-ai-widget');
        if (askWidget) askWidget.style.display = 'none';
        
        // Pokaż powiadomienie o wylogowaniu
        this.showNotification('Wylogowano pomyślnie. Do zobaczenia!', 'success');
        
        // Opóźnij reload, żeby użytkownik zobaczyl powiadomienie
        setTimeout(() => {
            localStorage.removeItem('movieTrackerToken');
            try {
                sessionStorage.removeItem('favorites_modal_shown');
                sessionStorage.removeItem('favorites_banner_dismissed');
                if (this.currentUser?.id) {
                    sessionStorage.removeItem(`favorites_modal_shown_${this.currentUser.id}`);
                }
            } catch {}
            location.reload();
        }, 1000);
    }

    // Metody panelu admina
    bindAdminEvents() {
        // Przełączanie zakładek
        document.querySelectorAll('.admin-tab-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                const tab = e.target.dataset.tab;
                this.switchAdminTab(tab);
            });
        });

        // Przyciski dodawania
        document.getElementById('add-movie-btn').addEventListener('click', () => this.showAdminMovieModal());
        document.getElementById('add-challenge-btn').addEventListener('click', () => this.showAdminChallengeModal());
        document.getElementById('add-badge-btn').addEventListener('click', () => this.showAdminBadgeModal());

        // Masowe usuwanie zaznaczonych elementów
        document.getElementById('delete-selected-movies-btn').addEventListener('click', () => this.bulkDeleteMovies());
        document.getElementById('delete-selected-challenges-btn').addEventListener('click', () => this.bulkDeleteChallenges());
        document.getElementById('delete-selected-badges-btn').addEventListener('click', () => this.bulkDeleteBadges());
        document.getElementById('delete-selected-reviews-btn').addEventListener('click', () => this.bulkDeleteReviews());

        // Zaznacz wszystkie checkboxy
        document.getElementById('select-all-movies').addEventListener('change', (e) => {
            document.querySelectorAll('.movie-checkbox').forEach(cb => cb.checked = e.target.checked);
            this.updateBulkDeleteButton('movies');
        });
        document.getElementById('select-all-challenges').addEventListener('change', (e) => {
            document.querySelectorAll('.challenge-checkbox').forEach(cb => cb.checked = e.target.checked);
            this.updateBulkDeleteButton('challenges');
        });
        document.getElementById('select-all-badges').addEventListener('change', (e) => {
            document.querySelectorAll('.badge-checkbox').forEach(cb => cb.checked = e.target.checked);
            this.updateBulkDeleteButton('badges');
        });
        document.getElementById('select-all-reviews').addEventListener('change', (e) => {
            document.querySelectorAll('.review-checkbox').forEach(cb => cb.checked = e.target.checked);
            this.updateBulkDeleteButton('reviews');
        });

        // Przyciski zamykania modalów
        document.querySelectorAll('#admin-movie-modal .close').forEach(btn => {
            btn.addEventListener('click', () => this.closeAdminModal('admin-movie-modal'));
        });
        document.querySelectorAll('#admin-challenge-modal .close').forEach(btn => {
            btn.addEventListener('click', () => this.closeAdminModal('admin-challenge-modal'));
        });
        document.querySelectorAll('#admin-badge-modal .close').forEach(btn => {
            btn.addEventListener('click', () => this.closeAdminModal('admin-badge-modal'));
        });
        document.querySelectorAll('#admin-season-count-modal .close').forEach(btn => {
            btn.addEventListener('click', () => this.closeAdminModal('admin-season-count-modal'));
        });
        document.querySelectorAll('#admin-seasons-modal .close').forEach(btn => {
            btn.addEventListener('click', () => this.closeAdminModal('admin-seasons-modal'));
        });
        document.querySelectorAll('#admin-episodes-modal .close').forEach(btn => {
            btn.addEventListener('click', () => this.closeAdminModal('admin-episodes-modal'));
        });
        const adminEpisodesSaveAllBtn = document.getElementById('admin-episodes-save-all');
        if (adminEpisodesSaveAllBtn) adminEpisodesSaveAllBtn.addEventListener('click', () => {
            const sid = document.getElementById('admin-episodes-series-id').value;
            if (sid) this.saveAllAdminEpisodes(Number(sid));
        });

        // Obsługa formularzy
        document.getElementById('admin-movie-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveAdminMovie();
        });
        
        document.getElementById('admin-season-count-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.submitSeasonCount();
        });
        
        document.getElementById('admin-seasons-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveSeasonsConfig();
        });
        
        // Pokaż/ukryj pola w zależności od typu produkcji
        const adminMovieType = document.getElementById('admin-movie-type');
        if (adminMovieType) {
            adminMovieType.addEventListener('change', (e) => {
                const isSeries = e.target.value === 'series';
                const durationField = document.getElementById('duration-field');
                const durationLabel = document.getElementById('duration-label');
                
                document.getElementById('series-fields').style.display = isSeries ? 'block' : 'none';
                
                // Zaktualizuj etykietę czasu trwania
                if (isSeries) {
                    durationLabel.textContent = 'Średni czas trwania odcinka (minuty):';
                } else {
                    durationLabel.textContent = 'Czas trwania (minuty):';
                }
            });
        }
        
        document.getElementById('admin-challenge-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveAdminChallenge();
        });
        document.getElementById('admin-badge-form').addEventListener('submit', (e) => {
            e.preventDefault();
            this.saveAdminBadge();
        });

        const adminSurveyRefreshBtn = document.getElementById('admin-survey-refresh-btn');
        if (adminSurveyRefreshBtn) {
            adminSurveyRefreshBtn.addEventListener('click', () => this.loadAdminSurvey());
        }
        const adminSurveySyncBtn = document.getElementById('admin-survey-sync-btn');
        if (adminSurveySyncBtn) {
            adminSurveySyncBtn.addEventListener('click', () => this.syncAdminSurveyToServer());
        }
        const adminSurveyToggleBtn = document.getElementById('admin-survey-toggle-btn');
        if (adminSurveyToggleBtn) {
            adminSurveyToggleBtn.addEventListener('click', () => this.toggleAdminSurveySession());
        }
        document.querySelectorAll('.admin-survey-csv-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const dataset = btn.dataset.dataset || 'metrics';
                this.downloadAdminSurveyCsv(dataset);
            });
        });
    }

    switchAdminTab(tab) {
        // zaktualizuj aktywny przycisk zakładki
        document.querySelectorAll('.admin-tab-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        const targetTabBtn = document.querySelector(`.admin-tab-btn[data-tab="${tab}"]`);
        if (targetTabBtn) targetTabBtn.classList.add('active');

        // Zaktualizuj zawartość zakładki
        document.querySelectorAll('.admin-tab-content').forEach(content => {
            content.classList.remove('active');
        });
        const targetTabContent = document.getElementById(`admin-${tab}-tab`);
        if (targetTabContent) targetTabContent.classList.add('active');

        // Załaduj dane dla wybranej zakładki
        if (tab === 'movies') this.loadAdminMovies();
        else if (tab === 'challenges') this.loadAdminChallenges();
        else if (tab === 'badges') this.loadAdminBadges();
        else if (tab === 'reviews') this.loadAdminReviews();
        else if (tab === 'survey') this.loadAdminSurvey();
    }

    async loadAdminData() {
        // Załaduj dane dla aktualnie aktywnej zakładki
        const activeTab = document.querySelector('.admin-tab-btn.active').dataset.tab;
        this.switchAdminTab(activeTab);
    }

    async loadAdminMovies(page = 0, search = '', type = '') {
        try {
            // Zapamiętaj stan paginacji
            this._adminMoviesPage   = page;
            this._adminMoviesSearch = search;
            this._adminMoviesType   = type;

            const params = new URLSearchParams({ page, limit: 50 });
            if (search) params.set('search', search);
            if (type)   params.set('type', type);

            const response = await fetch(`/api/admin/movies?${params}`, {
                headers: this.getAuthHeaders()
            });
            if (!response.ok) {
                this.showNotification('Błąd podczas ładowania filmów (' + response.status + ')', 'error');
                return;
            }
            const data = await response.json();
            // Odpowiedź to { results, total, page, hasMore }
            const movies = Array.isArray(data) ? data : (data.results || []);
            const total   = data.total   ?? movies.length;
            const hasMore = data.hasMore ?? false;

            this.updateAdminCounts(movies, total);
            this.displayAdminMovies(movies);
            this._setupAdminMoviesPagination(page, total, hasMore, search, type);
        } catch (error) {
            console.error('Error loading admin movies:', error);
            this.showNotification('Błąd podczas ładowania filmów', 'error');
        }
    }

    _setupAdminMoviesPagination(page, total, hasMore, search, type = '') {
        const wrap     = document.getElementById('admin-movies-pagination');
        const prevBtn  = document.getElementById('admin-movies-prev');
        const nextBtn  = document.getElementById('admin-movies-next');
        const pageInfo = document.getElementById('admin-movies-page-info');
        if (!wrap) return;

        const totalPages = Math.ceil(total / 50) || 1;
        wrap.style.display = totalPages > 1 ? 'flex' : 'none';
        if (pageInfo) pageInfo.textContent = `Strona ${page + 1} / ${totalPages} (${total} pozycji)`;
        if (prevBtn) {
            prevBtn.disabled = page === 0;
            prevBtn.onclick  = () => this.loadAdminMovies(page - 1, search, type);
        }
        if (nextBtn) {
            nextBtn.disabled = !hasMore;
            nextBtn.onclick  = () => this.loadAdminMovies(page + 1, search, type);
        }

        // Podepnij search input (tylko raz)
        const searchInput = document.getElementById('admin-movies-search');
        if (searchInput && !searchInput._bound) {
            searchInput._bound = true;
            let debounce;
            searchInput.addEventListener('input', () => {
                clearTimeout(debounce);
                const typeVal = (document.getElementById('admin-movies-type-filter') || {}).value || '';
                debounce = setTimeout(() => this.loadAdminMovies(0, searchInput.value.trim(), typeVal), 350);
            });
        }

        // Podepnij type filter (tylko raz)
        const typeFilter = document.getElementById('admin-movies-type-filter');
        if (typeFilter && !typeFilter._bound) {
            typeFilter._bound = true;
            typeFilter.addEventListener('change', () => {
                const searchVal = (document.getElementById('admin-movies-search') || {}).value?.trim() || '';
                this.loadAdminMovies(0, searchVal, typeFilter.value);
            });
        }
        // Synchronizuj value dropdownu z aktualnym filtrem
        if (typeFilter) typeFilter.value = type;
    }

    // Aktualizuje liczniki filmów i seriali w panelu admina
    updateAdminCounts(movies, serverTotal) {
        // Pobierz rzeczywiste liczniki niezależnie od aktywnego filtra
        this._fetchAdminTypeCounts();

        // Pobierz liczniki dla wyzwań i odznak
        this.updateAdminChallengesCount();
        this.updateAdminBadgesCount();
        this.updateAdminReviewsCount();
    }
    
    async updateAdminChallengesCount() {
        try {
            const response = await fetch('/api/admin/challenges', {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const challenges = await response.json();
                const countEl = document.getElementById('admin-total-challenges-count');
                if (countEl) countEl.textContent = String(challenges.length);
            }
        } catch (error) {
            console.error('Error loading challenges count:', error);
        }
    }
    
    async updateAdminBadgesCount() {
        try {
            const response = await fetch('/api/admin/badges', {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const badges = await response.json();
                const countEl = document.getElementById('admin-total-badges-count');
                if (countEl) countEl.textContent = String(badges.length);
            }
        } catch (error) {
            console.error('Error loading badges count:', error);
        }
    }
    
    async updateAdminReviewsCount() {
        try {
            const response = await fetch('/api/admin/reviews', {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const reviews = await response.json();
                const countEl = document.getElementById('admin-total-reviews-count');
                if (countEl) countEl.textContent = String(reviews.length);
            }
        } catch (error) {
            console.error('Error loading reviews count:', error);
        }
    }

    async _fetchAdminTypeCounts() {
        // Debounce - nie wysyłaj dwa razy na raz
        if (this._fetchingTypeCounts) return;
        this._fetchingTypeCounts = true;
        try {
            const [moviesRes, seriesRes] = await Promise.all([
                fetch('/api/admin/movies?type=movie&limit=1&page=0', { headers: this.getAuthHeaders() }),
                fetch('/api/admin/movies?type=series&limit=1&page=0', { headers: this.getAuthHeaders() }),
            ]);
            if (moviesRes.ok) {
                const d = await moviesRes.json();
                const el = document.getElementById('admin-total-movies-count');
                if (el) el.textContent = String(d.total ?? 0);
            }
            if (seriesRes.ok) {
                const d = await seriesRes.json();
                const el = document.getElementById('admin-total-series-count');
                if (el) el.textContent = String(d.total ?? 0);
            }
        } catch (e) {
            console.error('Error fetching type counts:', e);
        } finally {
            this._fetchingTypeCounts = false;
        }
    }

    displayAdminMovies(movies) {
        const tbody = document.getElementById('admin-movies-list');
        tbody.innerHTML = movies.map(movie => {
            const displayYear = this.normalizeYear(movie.release_date || movie.year || movie.releaseDate) || '-';
            return `
            <tr>
                <td><input type="checkbox" class="movie-checkbox" data-id="${movie.id}" onchange="app.updateBulkDeleteButton('movies')"></td>
                <td>${movie.id}</td>
                <td>${movie.title}</td>
                <td>${movie.media_type === 'movie' ? 'Film' : 'Serial'}</td>
                <td>${displayYear}</td>
                <td>${movie.genre || '-'}</td>
                <td>
                    <button class="action-btn btn-edit" onclick="app.editAdminMovie(${movie.id})">
                        <i class="fas fa-edit"></i> Edytuj
                    </button>
                    ${movie.media_type === 'series' ? `
                    <button class="action-btn btn-edit" onclick="app.editSeriesSeasons(${movie.id}, '${movie.title.replace(/'/g, "\\'")}')"
                            style="background: #2196F3;" title="Edytuj sezony">
                        <i class="fas fa-list-ol"></i> Sezony
                    </button>
                    <button class="action-btn btn-edit" onclick="app.editAdminEpisodes(${movie.id}, '${movie.title.replace(/'/g, "\\'")}')"
                            style="background: #4CAF50; margin-left: 6px;" title="Edytuj odcinki">
                        <i class="fas fa-tv"></i> Odcinki
                    </button>
                    ` : ''}
                    <button class="action-btn btn-delete" onclick="app.deleteAdminMovie(${movie.id})">
                        <i class="fas fa-trash"></i> Usuń
                    </button>
                </td>
            </tr>
        `}).join('');
    }

    async loadAdminChallenges() {
        try {
            const response = await fetch('/api/admin/challenges', {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const challenges = await response.json();
                this.displayAdminChallenges(challenges);
                // Aktualizuj licznik
                const countEl = document.getElementById('admin-total-challenges-count');
                if (countEl) countEl.textContent = String(challenges.length);
            }
        } catch (error) {
            console.error('Error loading admin challenges:', error);
            this.showNotification('Błąd podczas ładowania wyzwań', 'error');
        }
    }

    displayAdminChallenges(challenges) {
        const tbody = document.getElementById('admin-challenges-list');
        tbody.innerHTML = challenges.map(challenge => `
            <tr>
                <td><input type="checkbox" class="challenge-checkbox" data-id="${challenge.id}" onchange="app.updateBulkDeleteButton('challenges')"></td>
                <td>${challenge.id}</td>
                <td>${challenge.title}</td>
                <td>${challenge.type}</td>
                <td>${challenge.criteria_value || '-'}</td>
                <td>${challenge.target_silver || '-'}</td>
                <td>${challenge.target_gold || '-'}</td>
                <td>${challenge.target_platinum || '-'}</td>
                <td>
                    <button class="action-btn btn-edit" onclick="app.editAdminChallenge(${challenge.id})">
                        <i class="fas fa-edit"></i> Edytuj
                    </button>
                    <button class="action-btn btn-delete" onclick="app.deleteAdminChallenge(${challenge.id})">
                        <i class="fas fa-trash"></i> Usuń
                    </button>
                </td>
            </tr>
        `).join('');
    }

    async loadAdminBadges() {
        try {
            const response = await fetch('/api/admin/badges', {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const badges = await response.json();
                this.displayAdminBadges(badges);
                // Aktualizuj licznik
                const countEl = document.getElementById('admin-total-badges-count');
                if (countEl) countEl.textContent = String(badges.length);
            }
        } catch (error) {
            console.error('Error loading admin badges:', error);
            this.showNotification('Błąd podczas ładowania odznak', 'error');
        }
    }

    displayAdminBadges(badges) {
        const tbody = document.getElementById('admin-badges-list');
        tbody.innerHTML = badges.map(badge => `
            <tr>
                <td><input type="checkbox" class="badge-checkbox" data-id="${badge.id}" onchange="app.updateBulkDeleteButton('badges')"></td>
                <td>${badge.id}</td>
                <td>${badge.name}</td>
                <td>${badge.description}</td>
                <td><i class="fas ${badge.image_url || 'fa-award'}"></i></td>
                <td>
                    <button class="action-btn btn-edit" onclick="app.editAdminBadge(${badge.id})">
                        <i class="fas fa-edit"></i> Edytuj
                    </button>
                    <button class="action-btn btn-delete" onclick="app.deleteAdminBadge(${badge.id})">
                        <i class="fas fa-trash"></i> Usuń
                    </button>
                </td>
            </tr>
        `).join('');
    }

    // CRUD filmów
    showAdminMovieModal(movie = null) {
        const modal = document.getElementById('admin-movie-modal');
        const title = document.getElementById('admin-movie-modal-title');
        
        if (movie) {
            // Ustaw tytuł na podstawie typu
            title.textContent = movie.media_type === 'series' ? 'Edytuj serial' : 'Edytuj film';
            document.getElementById('admin-movie-id').value = movie.id;
            document.getElementById('admin-movie-title').value = movie.title;
            document.getElementById('admin-movie-type').value = movie.media_type;
            
            // Wydobycie roku z release_date lub year
            let yearValue = '';
            if (movie.release_date) {
                const raw = String(movie.release_date);
                // Dla seriali pozwól na zakresy lat (np. 2015-2020)
                if (movie.media_type === 'series' && /[-–—]/.test(raw)) {
                    yearValue = raw;
                } else {
                    // Użyj pełnej daty release_date, jeśli jest w poprawnym formacie (YYYY-MM-DD lub YYYY-MM)
                    // W przeciwnym razie wydobądź tylko rok
                    if (/^\d{4}-\d{2}(-\d{2})?$/.test(raw)) {
                        yearValue = raw; // pełna data
                    } else {
                        const yearMatch = raw.match(/^(\d{4})/);
                        yearValue = yearMatch ? yearMatch[1] : raw;
                    }
                }
            } else if (movie.year) {
                yearValue = String(movie.year);
            }
            console.debug('Prefilling admin movie year:', yearValue);
            document.getElementById('admin-movie-year').value = yearValue;
            document.getElementById('admin-movie-genre').value = movie.genre || '';
            // Bazując na typie, ustaw odpowiednio pole duration
            const normalizedType = movie.media_type || movie.type;
            const durationPrefill = normalizedType === 'series' ? (movie.avgEpisodeLength || movie.duration || '') : (movie.duration || '');
            console.debug('Prefilling admin movie duration:', durationPrefill);
            document.getElementById('admin-movie-duration').value = durationPrefill;
            document.getElementById('admin-movie-description').value = movie.description || '';
            document.getElementById('admin-movie-poster').value = movie.poster_url || '';
            document.getElementById('admin-movie-trailer').value = movie.trailer_url || '';
        } else {
            title.textContent = 'Dodaj film';
            document.getElementById('admin-movie-form').reset();
            document.getElementById('admin-movie-id').value = '';
            // Ustaw domyślny typ na film i ukryj pola serialu
            document.getElementById('admin-movie-type').value = 'movie';
            document.getElementById('series-fields').style.display = 'none';
            document.getElementById('duration-label').textContent = 'Czas trwania (minuty):';
        }
        
        modal.style.display = 'block';
    }

    async editAdminMovie(id) {
        try {
            const response = await fetch(`/api/admin/movies/${id}`, {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const movie = await response.json();
                this.showAdminMovieModal(movie);
            } else {
                const error = await response.json().catch(() => ({ error: 'Nieznany błąd' }));
                this.showNotification(error.error || 'Błąd podczas ładowania filmu', 'error');
            }
        } catch (error) {
            console.error('Error loading movie:', error);
            this.showNotification('Błąd podczas ładowania filmu', 'error');
        }
    }

    async saveAdminMovie() {
        const id = document.getElementById('admin-movie-id').value;
        const movieType = document.getElementById('admin-movie-type').value;
        
        // Rok wydania - tylko dołączać jeśli niepusty
        let yearValue = document.getElementById('admin-movie-year').value || null;
        
        // Czytaj i parsuj duration tylko jeśli podano wartość
        const rawDurationInput = (document.getElementById('admin-movie-duration').value || '').toString().trim();
        console.log('Duration input raw value:', rawDurationInput);
        let durationValue = undefined;
        if (rawDurationInput !== '') {
            const parsed = parseInt(rawDurationInput, 10);
            durationValue = Number.isNaN(parsed) ? null : parsed;
            console.log('Duration parsed value:', durationValue);
        }
        
        const data = {
            title: document.getElementById('admin-movie-title').value,
            type: movieType,
            year: yearValue,
            genre: document.getElementById('admin-movie-genre').value || null,
            description: document.getElementById('admin-movie-description').value || null,
            poster: document.getElementById('admin-movie-poster').value || null,
            trailer: document.getElementById('admin-movie-trailer').value || null
        };
        
        // Dla seriali zawsze wyślij duration (dla odcinków)
        if (movieType === 'series') {
            const finalDuration = durationValue !== undefined && durationValue !== null ? durationValue : 45;
            console.log('Series duration (final):', finalDuration);
            data.duration = finalDuration;
            data.totalSeasons = parseInt(document.getElementById('admin-series-seasons').value) || 1;
        } else if (durationValue !== undefined) {
            // Dla filmów tylko jeśli podano
            data.duration = durationValue;
        }

        try {
            console.log('Saving admin movie payload (sent):', JSON.stringify(data, null, 2));
            const url = id ? `/api/admin/movies/${id}` : '/api/admin/movies';
            const method = id ? 'PUT' : 'POST';
            if (id) data.id = id; // używaj id w payload przy aktualizacji
            
            const response = await fetch(url, {
                method,
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (response.ok) {
                const result = await response.json();
                
                // Pokaż powiadomienie zmiany progresu dla seriali
                if (id) {
                    if (movieType === 'series' && durationValue) {
                        this.showNotification('Aktualizowanie czasu trwania odcinków...', 'info');
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    this.showNotification('Film/serial zaktualizowany pomyślnie!', 'success');
                } else {
                    this.showNotification('Film/serial dodany pomyślnie!', 'success');
                }
                
                this.closeAdminModal('admin-movie-modal');
                
                // Jeśli to nowy serial, pokaż modal do konfiguracji sezonów
                if (!id && movieType === 'series') {
                    const seriesId = result.id;
                    const seasonCount = data.totalSeasons;
                    this.showSeasonsConfigModal(seriesId, seasonCount, data.title);
                } else {
                    this.loadAdminMovies();
                    // Odśwież dane filmów na stronie głównej
                    try { await this.loadMoviesData(); } catch (e) { /* ignore */ }
                }
                
                // Odśwież kalendarz aby pokazać nowe premiery
                try { await this.generateCalendar(); } catch (e) { console.debug('Kalendarz niedostępny'); }
            } else {
                const error = await response.json();
                this.showNotification(error.error || 'Błąd podczas zapisywania', 'error');
            }
        } catch (error) {
            console.error('Error saving movie:', error);
            this.showNotification('Błąd podczas zapisywania', 'error');
        }
    }

    async editSeriesSeasons(seriesId, seriesTitle) {
        try {
            // Pobierz dane serialu
            const movieResponse = await fetch(`/api/admin/movies/${seriesId}`, {
                headers: this.getAuthHeaders()
            });
            
            if (!movieResponse.ok) {
                throw new Error('Nie udało się pobrać danych serialu');
            }
            
            const movie = await movieResponse.json();
            
            // Pokaż modal do wprowadzania liczby sezonów
            this.showSeasonCountModal(seriesId, seriesTitle, movie.total_seasons);
            
        } catch (error) {
            console.error('Error loading series seasons:', error);
            this.showNotification('Błąd podczas ładowania danych serialu', 'error');
        }
    }

    async editAdminEpisodes(seriesId, seriesTitle) {
        try {
            document.getElementById('admin-episodes-series-id').value = seriesId;
            document.getElementById('admin-episodes-modal-title').textContent = `Edytuj odcinki: ${seriesTitle}`;
            document.getElementById('admin-episodes-modal-subtitle').textContent = 'Edytuj tytuł, opis i czas trwania odcinka (minuty)';
            document.getElementById('admin-episodes-modal').style.display = 'block';
            await this.loadAdminEpisodes(seriesId);
        } catch (error) {
            console.error('Error opening admin episodes modal:', error);
            this.showNotification('Błąd podczas otwierania odcinków', 'error');
        }
    }

    async loadAdminEpisodes(seriesId) {
        try {
            const res = await fetch(`/api/admin/movies/${seriesId}/episodes`, { headers: this.getAuthHeaders() });
            if (!res.ok) {
                throw new Error('Failed to load episodes');
            }
            const data = await res.json();
            this.populateAdminEpisodesModal(data);
        } catch (error) {
            console.error('Error loading admin episodes:', error);
            this.showNotification('Błąd podczas ładowania odcinków', 'error');
        }
    }

    populateAdminEpisodesModal(data) {
        const hasDisplay = data && data.hasDisplay;
        const warnEl = document.getElementById('admin-episodes-warning');
        if (warnEl) { warnEl.style.display = hasDisplay ? 'none' : 'block'; }
        const container = document.getElementById('admin-episodes-list');
        container.innerHTML = '';
        if (!data || !Array.isArray(data.episodes) || data.episodes.length === 0) {
            container.innerHTML = '<p>Brak odcinków do edycji.</p>';
            return;
        }
        // Grupuj odcinki według sezonów
        const seasons = {};
        data.episodes.forEach(ep => {
            if (!seasons[ep.seasonNumber]) seasons[ep.seasonNumber] = [];
            seasons[ep.seasonNumber].push(ep);
        });

        Object.keys(seasons).sort((a,b)=> Number(a)-Number(b)).forEach(seasonNumber => {
            const eps = seasons[seasonNumber];
            const seasonDiv = document.createElement('div');
            seasonDiv.className = 'admin-season-group';
            seasonDiv.innerHTML = `<h4>Sezon ${seasonNumber}</h4>`;
            const list = document.createElement('div');
            list.className = 'admin-episode-list';
            eps.forEach(ep => {
                const row = document.createElement('div');
                row.className = 'admin-episode-row';
                row.setAttribute('data-episode-id', ep.id);
                row.innerHTML = `
                    <div class="admin-episode-meta">
                        <label>Numer: </label>
                        <input type="text" class="admin-episode-displayNumber" value="${this.escapeHtml(ep.displayNumber || '')}" ${hasDisplay ? '' : 'disabled'} />
                    </div>
                    <div class="admin-episode-fields">
                        <label>Tytuł</label>
                        <input type="text" class="admin-episode-title" value="${this.escapeHtml(ep.title || '')}" />
                        <label>Czas (min)</label>
                        <input type="number" class="admin-episode-duration" min="0" value="${this.escapeHtml(ep.duration || '')}" />
                        <label>Data emisji</label>
                        <input type="date" class="admin-episode-airdate" value="${this.escapeHtml(ep.airDate || '')}" />
                        <label>Opis</label>
                        <textarea class="admin-episode-description">${this.escapeHtml(ep.description || '')}</textarea>
                    </div>
                    <div class="admin-episode-actions">
                        <button type="button" class="btn btn-primary admin-episode-save-btn" data-episode-id="${ep.id}">Zapisz</button>
                    </div>
                `;
                list.appendChild(row);
            });
            seasonDiv.appendChild(list);
            container.appendChild(seasonDiv);
        });

        // Bind przyciski zapisu
        const saveBtns = container.querySelectorAll('.admin-episode-save-btn');
        saveBtns.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                const id = btn.dataset.episodeId;
                await this.saveAdminEpisode(document.getElementById('admin-episodes-series-id').value, id);
            });
        });

        const saveAllBtn = document.getElementById('admin-episodes-save-all');
        saveAllBtn.onclick = async () => {
            await this.saveAllAdminEpisodes(document.getElementById('admin-episodes-series-id').value);
        };
    }

    async saveAdminEpisode(seriesId, episodeId) {
        try {
            const row = document.querySelector(`.admin-episode-row[data-episode-id='${episodeId}']`);
            if (!row) return;
            const title = row.querySelector('.admin-episode-title').value.trim();
            const durationVal = row.querySelector('.admin-episode-duration').value;
            const duration = durationVal === '' ? undefined : Number(durationVal);
            const descriptionRaw = row.querySelector('.admin-episode-description').value;
            const description = descriptionRaw === undefined ? undefined : descriptionRaw.trim();
            const displayNumberVal = row.querySelector('.admin-episode-displayNumber') ? row.querySelector('.admin-episode-displayNumber').value.trim() : undefined;
            const displayNumber = displayNumberVal === '' ? undefined : displayNumberVal;
            const airDateVal = row.querySelector('.admin-episode-airdate') ? row.querySelector('.admin-episode-airdate').value.trim() : undefined;
            const airDate = airDateVal === '' ? undefined : airDateVal;

            const body = { id: Number(episodeId) };
            if (title !== undefined) body.title = title;
            if (description !== undefined) body.description = (description === '' ? null : description);
            if (displayNumber !== undefined) body.displayNumber = displayNumber;
            if (airDate !== undefined) body.airDate = airDate;
            if (duration !== undefined) body.duration = Number(duration);

            const res = await fetch(`/api/admin/movies/${seriesId}/episodes`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
                body: JSON.stringify(body)
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Błąd' }));
                this.showNotification(err.error || 'Błąd podczas zapisywania odcinka', 'error');
                return;
            }
            this.showNotification('Odcinek zapisany', 'success');
            await this.loadAdminEpisodes(seriesId);
        } catch (error) {
            console.error('Error saving admin episode:', error);
            this.showNotification('Błąd podczas zapisu odcinka', 'error');
        }
    }

    async saveAllAdminEpisodes(seriesId) {
        try {
            const rows = document.querySelectorAll('#admin-episodes-list .admin-episode-row');
            const episodes = Array.from(rows).map(row => {
                const id = Number(row.getAttribute('data-episode-id'));
                const title = row.querySelector('.admin-episode-title').value.trim();
                const durationVal = row.querySelector('.admin-episode-duration').value;
                const airDateVal = row.querySelector('.admin-episode-airdate') ? row.querySelector('.admin-episode-airdate').value.trim() : undefined;
                const airDate = airDateVal === '' ? undefined : airDateVal;
                const duration = durationVal === '' ? undefined : Number(durationVal);
                const descriptionRaw = row.querySelector('.admin-episode-description').value;
                const description = descriptionRaw === undefined ? undefined : descriptionRaw.trim();
                const displayNumberVal = row.querySelector('.admin-episode-displayNumber') ? row.querySelector('.admin-episode-displayNumber').value.trim() : undefined;
                const displayNumber = displayNumberVal === '' ? undefined : displayNumberVal;
                const ep = { id };
                if (title !== undefined) ep.title = title;
                if (description !== undefined) ep.description = (description === '' ? null : description);
                if (displayNumber !== undefined) ep.displayNumber = displayNumber;
                if (airDate !== undefined) ep.airDate = airDate;
                if (duration !== undefined) ep.duration = duration;
                return ep;
            });

            const res = await fetch(`/api/admin/movies/${seriesId}/episodes`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
                body: JSON.stringify({ episodes })
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({ error: 'Błąd' }));
                this.showNotification(err.error || 'Błąd podczas zapisywania odcinków', 'error');
                return;
            }
            this.showNotification('Zapisano wszystkie odcinki', 'success');
            await this.loadAdminEpisodes(seriesId);
            this.closeAdminModal('admin-episodes-modal');
        } catch (error) {
            console.error('Error saving all admin episodes:', error);
            this.showNotification('Błąd podczas zapisywania odcinków', 'error');
        }
    }

    async deleteAdminMovie(id) {
        if (!(await this.showConfirm('Czy na pewno chcesz usunąć ten film?', 'Potwierdzenie usunięcia'))) return;

        try {
            const response = await fetch(`/api/admin/movies/${id}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (response.ok) {
                this.showNotification('Film usunięty', 'success');
                this.loadAdminMovies();
                // Odśwież kalendarz
                try { await this.generateCalendar(); } catch (e) { console.debug('Calendar not available'); }
            } else {
                const error = await response.json();
                this.showNotification(error.error || 'Błąd podczas usuwania filmu', 'error');
            }
        } catch (error) {
            console.error('Error deleting movie:', error);
            this.showNotification('Błąd podczas usuwania filmu', 'error');
        }
    }

    // CRUD wyzwań
    showAdminChallengeModal(challenge = null) {
        const modal = document.getElementById('admin-challenge-modal');
        const title = document.getElementById('admin-challenge-modal-title');
        const typeSelect = document.getElementById('admin-challenge-type');
        const criteriaGroup = document.getElementById('criteria-group');
        
        // Nasłuchuj zmiany typu wyzwania
        typeSelect.onchange = () => {
            if (typeSelect.value === 'genre') {
                criteriaGroup.style.display = 'block';
            } else {
                criteriaGroup.style.display = 'none';
                document.getElementById('admin-challenge-criteria').value = '';
            }
        };
        
        if (challenge) {
            title.textContent = 'Edytuj wyzwanie';
            document.getElementById('admin-challenge-id').value = challenge.id;
            document.getElementById('admin-challenge-name').value = challenge.title;
            document.getElementById('admin-challenge-description').value = challenge.description || '';
            document.getElementById('admin-challenge-type').value = challenge.type;
            document.getElementById('admin-challenge-criteria').value = challenge.criteria_value || '';
            document.getElementById('admin-challenge-target-silver').value = challenge.target_silver || '';
            document.getElementById('admin-challenge-target-gold').value = challenge.target_gold || '';
            document.getElementById('admin-challenge-target-platinum').value = challenge.target_platinum || '';
            document.getElementById('admin-challenge-start').value = challenge.start_date ? challenge.start_date.split('T')[0] : '';
            document.getElementById('admin-challenge-end').value = challenge.end_date ? challenge.end_date.split('T')[0] : '';
            document.getElementById('admin-challenge-badge-silver').value = challenge.badge_silver_id || '';
            document.getElementById('admin-challenge-badge-gold').value = challenge.badge_gold_id || '';
            document.getElementById('admin-challenge-badge-platinum').value = challenge.badge_platinum_id || '';
            
            // Pokaż pole kryterium jeśli typ to genre
            criteriaGroup.style.display = challenge.type === 'genre' ? 'block' : 'none';
        } else {
            title.textContent = 'Dodaj wyzwanie';
            document.getElementById('admin-challenge-form').reset();
            document.getElementById('admin-challenge-id').value = '';
            criteriaGroup.style.display = 'none';
        }
        
        modal.style.display = 'block';
    }

    async editAdminChallenge(id) {
        try {
            const response = await fetch(`/api/admin/challenges/${id}`, {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const challenge = await response.json();
                this.showAdminChallengeModal(challenge);
            } else {
                const error = await response.json().catch(() => ({ error: 'Nieznany błąd' }));
                this.showNotification(error.error || 'Błąd podczas ładowania wyzwania', 'error');
            }
        } catch (error) {
            console.error('Error loading challenge:', error);
            this.showNotification('Błąd podczas ładowania wyzwania', 'error');
        }
    }

    async saveAdminChallenge() {
        const id = document.getElementById('admin-challenge-id').value;
        // Funkcja pomocnicza do parsowania daty
        const parseDateInput = (raw) => {
            if (!raw) return null;
            const s = String(raw).trim();
            if (s === '') return null;

            // Jeśli już w formacie ISO
            if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

            // DD.MM.YYYY lub DD/MM/YYYY
            const dmy = s.match(/^(\d{1,2})[\.\/](\d{1,2})[\.\/](\d{4})$/);
            if (dmy) {
                const day = dmy[1].padStart(2, '0');
                const month = dmy[2].padStart(2, '0');
                const year = dmy[3];
                return `${year}-${month}-${day}`;
            }

            // Próba parsowania daty jako fallback
            const parsed = new Date(s);
            if (!isNaN(parsed.getTime())) {
                const yyyy = parsed.getFullYear();
                const mm = String(parsed.getMonth() + 1).padStart(2, '0');
                const dd = String(parsed.getDate()).padStart(2, '0');
                return `${yyyy}-${mm}-${dd}`;
            }

            return null;
        };

        const rawName = document.getElementById('admin-challenge-name').value;
        const rawType = document.getElementById('admin-challenge-type').value;
        const rawTargetSilver = document.getElementById('admin-challenge-target-silver').value;
        const rawTargetGold = document.getElementById('admin-challenge-target-gold').value;
        const rawTargetPlatinum = document.getElementById('admin-challenge-target-platinum').value;
        const rawStart = document.getElementById('admin-challenge-start').value;
        const rawEnd = document.getElementById('admin-challenge-end').value;
        const rawBadgeSilver = document.getElementById('admin-challenge-badge-silver').value;
        const rawBadgeGold = document.getElementById('admin-challenge-badge-gold').value;
        const rawBadgePlatinum = document.getElementById('admin-challenge-badge-platinum').value;

        // Podstawowa walidacja po stronie klienta
        if (!rawName || rawName.trim().length === 0) {
            this.showNotification('Nazwa wyzwania jest wymagana', 'error');
            return;
        }

        if (!rawType || rawType.trim().length === 0) {
            this.showNotification('Typ wyzwania jest wymagany', 'error');
            return;
        }

        const data = {
            title: rawName.trim(),
            description: document.getElementById('admin-challenge-description').value || null,
            type: rawType.trim(),
            criteria_value: document.getElementById('admin-challenge-criteria').value || null,
            target_silver: (rawTargetSilver && rawTargetSilver.trim() !== '') ? parseInt(rawTargetSilver) : null,
            target_gold: (rawTargetGold && rawTargetGold.trim() !== '') ? parseInt(rawTargetGold) : null,
            target_platinum: (rawTargetPlatinum && rawTargetPlatinum.trim() !== '') ? parseInt(rawTargetPlatinum) : null,
            start_date: parseDateInput(rawStart),
            end_date: parseDateInput(rawEnd),
            badge_silver_id: (rawBadgeSilver && rawBadgeSilver.trim() !== '') ? (parseInt(rawBadgeSilver) || null) : null,
            badge_gold_id: (rawBadgeGold && rawBadgeGold.trim() !== '') ? (parseInt(rawBadgeGold) || null) : null,
            badge_platinum_id: (rawBadgePlatinum && rawBadgePlatinum.trim() !== '') ? (parseInt(rawBadgePlatinum) || null) : null
        };

        // Walidacja wymagalnych pól zgodnie ze schematem DB
        if (!data.start_date) {
            this.showNotification('Data rozpoczęcia jest wymagana (wprowadź w formacie DD.MM.RRRR lub RRRR-MM-DD)', 'error');
            return;
        }

        // Debug log danych wyzwania (wysyłany payload)
        console.log('Saving challenge payload (sent):', data);

        try {
            const url = id ? `/api/admin/challenges/${id}` : '/api/admin/challenges';
            const method = id ? 'PUT' : 'POST';

            const response = await fetch(url, {
                method,
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(data)
            });

            if (response.ok) {
                this.showNotification(id ? 'Wyzwanie zaktualizowane' : 'Wyzwanie dodane', 'success');
                this.closeAdminModal('admin-challenge-modal');
                this.loadAdminChallenges();
                return;
            }

            // Sprób dokładnie przeanalizować odpowiedź błędu
            let errorBody = null;
            try {
                errorBody = await response.json();
            } catch (jsonErr) {
                try {
                    const text = await response.text();
                    errorBody = { text };
                } catch (txtErr) {
                    errorBody = { text: 'Unable to parse server response' };
                }
            }

            console.error('Error saving challenge, status:', response.status, 'body:', errorBody);
            const message = (errorBody && (errorBody.error || errorBody.message)) ? (errorBody.error || errorBody.message) : (errorBody.text || 'Błąd podczas zapisywania wyzwania');
            this.showNotification(`Błąd: ${message}`, 'error');

        } catch (error) {
            console.error('Błąd podczas zapisywania wyzwania (połączenie):', error);
            this.showNotification('Błąd podczas zapisywania wyzwania (połączenie)', 'error');
        }
    }

    async deleteAdminChallenge(id) {
        if (!(await this.showConfirm('Czy na pewno chcesz usunąć to wyzwanie?', 'Potwierdzenie usunięcia'))) return;

        try {
            const response = await fetch(`/api/admin/challenges/${id}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (response.ok) {
                this.showNotification('Wyzwanie usunięte', 'success');
                this.loadAdminChallenges();
            } else {
                const error = await response.json();
                this.showNotification(error.error || 'Błąd podczas usuwania wyzwania', 'error');
            }
        } catch (error) {
            console.error('Error deleting challenge:', error);
            this.showNotification('Błąd podczas usuwania wyzwania', 'error');
        }
    }

    // CRUD odznak
    showAdminBadgeModal(badge = null) {
        const modal = document.getElementById('admin-badge-modal');
        const title = document.getElementById('admin-badge-modal-title');
        
        if (badge) {
            title.textContent = 'Edytuj odznakę';
            document.getElementById('admin-badge-id').value = badge.id;
            document.getElementById('admin-badge-name').value = badge.name;
            document.getElementById('admin-badge-description').value = badge.description;
            document.getElementById('admin-badge-level').value = badge.level || 'gold';
            document.getElementById('admin-badge-icon').value = badge.image_url || '';
        } else {
            title.textContent = 'Dodaj odznakę';
            document.getElementById('admin-badge-form').reset();
            document.getElementById('admin-badge-id').value = '';
        }
        
        modal.style.display = 'block';
    }

    async editAdminBadge(id) {
        try {
            const response = await fetch(`/api/admin/badges/${id}`, {
                headers: this.getAuthHeaders()
            });
            if (response.ok) {
                const badge = await response.json();
                this.showAdminBadgeModal(badge);
            } else {
                const error = await response.json().catch(() => ({ error: 'Nieznany błąd' }));
                this.showNotification(error.error || 'Błąd podczas ładowania odznaki', 'error');
            }
        } catch (error) {
            console.error('Error loading badge:', error);
            this.showNotification('Błąd podczas ładowania odznaki', 'error');
        }
    }

    async saveAdminBadge() {
        const id = document.getElementById('admin-badge-id').value;
        const name = document.getElementById('admin-badge-name').value;
        const description = document.getElementById('admin-badge-description').value || null;
        const level = document.getElementById('admin-badge-level').value;
        const iconUrl = document.getElementById('admin-badge-icon').value || null;
        const fileInput = document.getElementById('admin-badge-file');
        const file = fileInput.files[0];
        
        if (!level) {
            this.showNotification('Poziom odznaki jest wymagany', 'error');
            return;
        }
        
        let imageUrl = iconUrl || '/images/default-badge.jpg';
        
        try {
            // Jeśli wybrano plik, prześlij go najpierw
            if (file) {
                const formData = new FormData();
                formData.append('badge', file);
                
                const uploadResponse = await fetch('/api/admin/upload-badge', {
                    method: 'POST',
                    headers: { 
                        'Authorization': `Bearer ${this.authToken}`
                    },
                    body: formData
                });
                
                if (!uploadResponse.ok) {
                    const uploadError = await uploadResponse.json();
                    this.showNotification(uploadError.error || 'Błąd podczas uploadu pliku', 'error');
                    return;
                }
                
                const uploadResult = await uploadResponse.json();
                imageUrl = uploadResult.url; // Zapisz pełny URL
            }
            
            // Przygotuj payload i wyślij dane odznaki
            const data = { 
                name: name, 
                description: description, 
                level: level,
                image_url: imageUrl 
            };

            const url = id ? `/api/admin/badges/${id}` : '/api/admin/badges';
            const method = id ? 'PUT' : 'POST';

            const response = await fetch(url, {
                method,
                headers: { 
                    'Authorization': `Bearer ${this.authToken}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (response.ok) {
                this.showNotification(id ? 'Odznaka zaktualizowana' : 'Odznaka dodana', 'success');
                this.closeAdminModal('admin-badge-modal');
                this.loadAdminBadges();
            } else {
                let errBody = null;
                try { 
                    errBody = await response.json(); 
                } catch (e) { 
                    errBody = { text: await response.text().catch(()=>'') }; 
                }
                console.error('Error saving badge:', response.status, errBody);
                const msg = (errBody && (errBody.error || errBody.message)) ? (errBody.error || errBody.message) : (errBody.text || 'Błąd podczas zapisywania odznaki');
                this.showNotification(msg, 'error');
            }
        } catch (error) {
            console.error('Error saving badge:', error);
            this.showNotification('Błąd podczas zapisywania odznaki', 'error');
        }
    }

    async deleteAdminBadge(id) {
        if (!(await this.showConfirm('Czy na pewno chcesz usunąć tę odznakę?', 'Potwierdzenie usunięcia'))) return;

        try {
            const response = await fetch(`/api/admin/badges/${id}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (response.ok) {
                this.showNotification('Odznaka usunięta', 'success');
                this.loadAdminBadges();
            } else {
                const error = await response.json();
                this.showNotification(error.error || 'Błąd podczas usuwania odznaki', 'error');
            }
        } catch (error) {
            console.error('Error deleting badge:', error);
            this.showNotification('Błąd podczas usuwania odznaki', 'error');
        }
    }

    showSeasonCountModal(seriesId, seriesTitle, currentSeasonCount = null) {
        const modal = document.getElementById('admin-season-count-modal');
        const title = document.getElementById('admin-season-count-modal-title');
        const subtitle = document.getElementById('admin-season-count-subtitle');
        const input = document.getElementById('admin-season-count-input');
        
        document.getElementById('admin-season-count-series-id').value = seriesId;
        document.getElementById('admin-season-count-series-title').value = seriesTitle;
        
        title.textContent = `Edycja sezonów: ${seriesTitle}`;
        subtitle.textContent = 'Wprowadź nową liczbę sezonów';
        input.value = currentSeasonCount || 1;
        input.focus();
        
        modal.style.display = 'block';
    }

    async submitSeasonCount() {
        const seriesId = document.getElementById('admin-season-count-series-id').value;
        const seriesTitle = document.getElementById('admin-season-count-series-title').value;
        const seasonCount = parseInt(document.getElementById('admin-season-count-input').value);
        
        if (!seasonCount || seasonCount < 1) {
            this.showNotification('Podaj prawidłową liczbę sezonów (minimum 1)', 'error');
            return;
        }
        
        // Zamknij modal wyboru liczby sezonów
        this.closeAdminModal('admin-season-count-modal');
        
        // Pobierz istniejące sezony
        try {
            const seasonsResponse = await fetch(`/api/admin/movies/${seriesId}/seasons`, {
                headers: this.getAuthHeaders()
            });
            
            const existingSeasons = seasonsResponse.ok ? await seasonsResponse.json() : [];
            
            // Otwórz modal konfiguracji sezonów
            this.showSeasonsConfigModal(seriesId, seasonCount, seriesTitle, existingSeasons);
        } catch (error) {
            console.error('Error loading seasons:', error);
            // Kontynuuj z pustą listą sezonów
            this.showSeasonsConfigModal(seriesId, seasonCount, seriesTitle, []);
        }
    }

    showSeasonsConfigModal(seriesId, seasonCount, seriesTitle, existingSeasons = null) {
        const modal = document.getElementById('admin-seasons-modal');
        const title = document.getElementById('admin-seasons-modal-title');
        const container = document.getElementById('seasons-config-container');
        
        title.textContent = `Konfiguracja sezonów - ${seriesTitle}`;
        document.getElementById('admin-seasons-series-id').value = seriesId;
        
        // Wygeneruj pola dla każdego sezonu
        container.innerHTML = '';
        for (let i = 1; i <= seasonCount; i++) {
            const existingSeason = existingSeasons?.find(s => s.season_number === i);
            const episodeCount = existingSeason?.episode_count || 10;
            
            const seasonItem = document.createElement('div');
            seasonItem.className = 'season-config-item';
            seasonItem.innerHTML = `
                <label>Sezon ${i}:</label>
                <input type="number" 
                       class="season-episodes-input" 
                       data-season="${i}" 
                       min="1" 
                       value="${episodeCount}" 
                       placeholder="Liczba odcinków"
                       required>
            `;
            container.appendChild(seasonItem);
        }
        
        modal.style.display = 'block';
    }

    async saveSeasonsConfig() {
        const seriesId = document.getElementById('admin-seasons-series-id').value;
        const inputs = document.querySelectorAll('.season-episodes-input');
        
        const seasons = Array.from(inputs).map(input => ({
            seasonNumber: parseInt(input.dataset.season),
            episodeCount: parseInt(input.value) || 10
        }));
        
        try {
            const response = await fetch(`/api/admin/movies/${seriesId}/seasons`, {
                method: 'POST',
                headers: { ...this.getAuthHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({ seasons })
            });
            
            if (response.ok) {
                this.showNotification('Sezony skonfigurowane pomyślnie', 'success');
                this.closeAdminModal('admin-seasons-modal');
                this.loadAdminMovies();
                // Odśwież kalendarz
                try { await this.generateCalendar(); } catch (e) { console.debug('Calendar not available'); }
            } else {
                const error = await response.json();
                this.showNotification(error.error || 'Błąd podczas zapisywania sezonów', 'error');
            }
        } catch (error) {
            console.error('Error saving seasons:', error);
            this.showNotification('Błąd podczas zapisywania sezonów', 'error');
        }
    }

    closeAdminModal(modalId) {
        document.getElementById(modalId).style.display = 'none';
    }

    // Weryfikacja hasła administratora
    showAdminPasswordPrompt() {
        const modal = document.getElementById('admin-password-modal');
        const passwordInput = document.getElementById('admin-password-input');
        const errorDiv = document.getElementById('admin-password-error');
        
        // Resetuj pole i błędy
        passwordInput.value = '';
        errorDiv.style.display = 'none';
        
        // Pokaż modal
        modal.style.display = 'block';
        
        // Ustaw fokus na pole hasła
        setTimeout(() => passwordInput.focus(), 100);
        
        // Ustaw obsługę formularza (Użyj cloneNode, aby usunąć stare nasłuchiwacze)
        const form = document.getElementById('admin-password-form');
        const newForm = form.cloneNode(true);
        form.parentNode.replaceChild(newForm, form);
        
        newForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const password = document.getElementById('admin-password-input').value;
            this.verifyAdminPassword(password);
        });
        
        // Obsługa przycisków zamykania
        modal.querySelectorAll('.close').forEach(btn => {
            btn.addEventListener('click', () => {
                modal.style.display = 'none';
            });
        });
    }

    async verifyAdminPassword(password) {
        const errorDiv = document.getElementById('admin-password-error');
        
        try {
            // Spróbuj zalogować się za pomocą emaila/nazwy użytkownika i podanego hasła
            const loginData = {
                emailOrUsername: this.currentUser.email,
                password: password
            };

            const response = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(loginData)
            });

            if (response.ok) {
                // Hasło poprawne
                this.adminVerified = true;
                document.getElementById('admin-password-modal').style.display = 'none';
                this.showNotification('Dostęp przyznany', 'success');
                this.showSection('admin');
            } else {
                // Pokaż błąd w modalu
                errorDiv.textContent = 'Nieprawidłowe hasło';
                errorDiv.style.display = 'block';
            }
        } catch (error) {
            console.error('Error verifying admin password:', error);
            errorDiv.textContent = 'Błąd podczas weryfikacji hasła';
            errorDiv.style.display = 'block';
        }
    }

    // ============================= PRZEKIEROWANIE MOTYWU DO MVT GO ADMIN PANEL =============================
    
    // Funkcja: Przekazanie theme użytkownika do panelu admina
    passThemeToAdmin(event) {
        event.preventDefault();
        const userTheme = localStorage.getItem('theme') || 'dark';
        console.log(`Przekazuję theme "${userTheme}" do panelu admina...`);
        const newUrl = `https://mvt-reco-admin.110187.xyz/login?__user_theme__=${encodeURIComponent(userTheme)}`;

        // Otwiera link w nowej karcie
        window.open(newUrl, '_blank');
    }

    // ============ USUWANIE HURTOWE =============
    updateBulkDeleteButton(type) {
        const checkboxes = document.querySelectorAll(`.${type.slice(0, -1)}-checkbox:checked`);
        const button = document.getElementById(`delete-selected-${type}-btn`);
        const selectAllCheckbox = document.getElementById(`select-all-${type}`);
        
        if (button) {
            button.style.display = checkboxes.length > 0 ? 'inline-block' : 'none';
        }
        
        // Aktualizuj stan checkboxa "Zaznacz wszystko"
        if (selectAllCheckbox) {
            const allCheckboxes = document.querySelectorAll(`.${type.slice(0, -1)}-checkbox`);
            selectAllCheckbox.checked = allCheckboxes.length > 0 && checkboxes.length === allCheckboxes.length;
        }
    }

    async bulkDeleteMovies() {
        const checkboxes = document.querySelectorAll('.movie-checkbox:checked');
        const ids = Array.from(checkboxes).map(cb => cb.dataset.id);
        
        if (ids.length === 0) return;
        
        if (!confirm(`Czy na pewno chcesz usunąć ${ids.length} film(ów)?`)) return;

        let successCount = 0;
        let errorCount = 0;

        for (const id of ids) {
            try {
                const response = await fetch(`/api/admin/movies/${id}`, {
                    method: 'DELETE',
                    headers: this.getAuthHeaders()
                });

                if (response.ok) {
                    successCount++;
                } else {
                    errorCount++;
                }
            } catch (error) {
                console.error(`Error deleting movie ${id}:`, error);
                errorCount++;
            }
        }

        this.showNotification(`Usunięto: ${successCount}, Błędy: ${errorCount}`, successCount > 0 ? 'success' : 'error');
        await this.loadAdminMovies();
        document.getElementById('select-all-movies').checked = false;
        this.updateBulkDeleteButton('movies');
    }

    async bulkDeleteChallenges() {
        const checkboxes = document.querySelectorAll('.challenge-checkbox:checked');
        const ids = Array.from(checkboxes).map(cb => cb.dataset.id);
        
        if (ids.length === 0) return;
        
        if (!confirm(`Czy na pewno chcesz usunąć ${ids.length} wyzwań?`)) return;

        let successCount = 0;
        let errorCount = 0;

        for (const id of ids) {
            try {
                const response = await fetch(`/api/admin/challenges/${id}`, {
                    method: 'DELETE',
                    headers: this.getAuthHeaders()
                });

                if (response.ok) {
                    successCount++;
                } else {
                    errorCount++;
                }
            } catch (error) {
                console.error(`Error deleting challenge ${id}:`, error);
                errorCount++;
            }
        }

        this.showNotification(`Usunięto: ${successCount}, Błędy: ${errorCount}`, successCount > 0 ? 'success' : 'error');
        await this.loadAdminChallenges();
        document.getElementById('select-all-challenges').checked = false;
        this.updateBulkDeleteButton('challenges');
    }

    async bulkDeleteBadges() {
        const checkboxes = document.querySelectorAll('.badge-checkbox:checked');
        const ids = Array.from(checkboxes).map(cb => cb.dataset.id);
        
        if (ids.length === 0) return;
        
        if (!confirm(`Czy na pewno chcesz usunąć ${ids.length} odznak(i)?`)) return;

        let successCount = 0;
        let errorCount = 0;

        for (const id of ids) {
            try {
                const response = await fetch(`/api/admin/badges/${id}`, {
                    method: 'DELETE',
                    headers: this.getAuthHeaders()
                });

                if (response.ok) {
                    successCount++;
                } else {
                    errorCount++;
                }
            } catch (error) {
                console.error(`Error deleting badge ${id}:`, error);
                errorCount++;
            }
        }

        this.showNotification(`Usunięto: ${successCount}, Błędy: ${errorCount}`, successCount > 0 ? 'success' : 'error');
        await this.loadAdminBadges();
        document.getElementById('select-all-badges').checked = false;
        this.updateBulkDeleteButton('badges');
    }

    // ============= MODERACJA RECENZJI =============
    async loadAdminReviews() {
        try {
            const response = await fetch('/api/admin/reviews', {
                headers: this.getAuthHeaders()
            });
            
            if (response.ok) {
                const reviews = await response.json();
                this.displayAdminReviews(reviews);
                // Aktualizuj licznik
                const countEl = document.getElementById('admin-total-reviews-count');
                if (countEl) countEl.textContent = String(reviews.length);
            }
        } catch (error) {
            console.error('Error loading admin reviews:', error);
            this.showNotification('Błąd podczas ładowania recenzji', 'error');
        }
    }

    displayAdminReviews(reviews) {
        const tbody = document.getElementById('admin-reviews-list');
        
        if (!reviews || reviews.length === 0) {
            tbody.innerHTML = '<tr><td colspan="8" style="text-align: center;">Brak recenzji</td></tr>';
            return;
        }
        
        tbody.innerHTML = reviews.map(review => {
            const reviewText = review.review_text ? 
                (review.review_text.length > 100 ? review.review_text.substring(0, 100) + '...' : review.review_text) : 
                '-';
            const stars = '⭐'.repeat(review.rating || 0);
            const date = review.created_at ? new Date(review.created_at).toLocaleDateString('pl-PL') : '-';
            
            return `
            <tr>
                <td><input type="checkbox" class="review-checkbox" data-id="${review.id}" onchange="app.updateBulkDeleteButton('reviews')"></td>
                <td>${review.id}</td>
                <td>${this.escapeHtml(review.username || 'Nieznany')}</td>
                <td>${this.escapeHtml(review.movie_title || 'Nieznany')}</td>
                <td title="${this.escapeHtml(review.review_text || '')}">${this.escapeHtml(reviewText)}</td>
                <td>${stars}</td>
                <td>${date}</td>
                <td>
                    <button class="action-btn btn-delete" onclick="app.deleteAdminReview(${review.id})" title="Usuń">
                        <i class="fas fa-trash"></i> Usuń
                    </button>
                </td>
            </tr>
        `}).join('');
    }

    async deleteAdminReview(id) {
        if (!(await this.showConfirm('Czy na pewno chcesz usunąć tę recenzję?', 'Potwierdzenie usunięcia'))) return;

        try {
            const response = await fetch(`/api/admin/reviews/${id}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders()
            });

            if (response.ok) {
                this.showNotification('Recenzja usunięta', 'success');
                await this.loadAdminReviews();
            } else {
                const error = await response.json();
                this.showNotification(error.error || 'Błąd podczas usuwania recenzji', 'error');
            }
        } catch (error) {
            console.error('Error deleting review:', error);
            this.showNotification('Błąd podczas usuwania recenzji', 'error');
        }
    }

    async bulkDeleteReviews() {
        const checkboxes = document.querySelectorAll('.review-checkbox:checked');
        const ids = Array.from(checkboxes).map(cb => cb.dataset.id);
        
        if (ids.length === 0) return;
        
        if (!confirm(`Czy na pewno chcesz usunąć ${ids.length} recenzji?`)) return;

        let successCount = 0;
        let errorCount = 0;

        for (const id of ids) {
            try {
                const response = await fetch(`/api/admin/reviews/${id}`, {
                    method: 'DELETE',
                    headers: this.getAuthHeaders()
                });

                if (response.ok) {
                    successCount++;
                } else {
                    errorCount++;
                }
            } catch (error) {
                console.error(`Error deleting review ${id}:`, error);
                errorCount++;
            }
        }

        this.showNotification(`Usunięto: ${successCount}, Błędy: ${errorCount}`, successCount > 0 ? 'success' : 'error');
        await this.loadAdminReviews();
        document.getElementById('select-all-reviews').checked = false;
        this.updateBulkDeleteButton('reviews');
    }

    // ============= ANKIETA EWALUACYJNA (SLEPY TEST A/B/C/D) =============
    _getSurveyDraftKey() {
        const uid = this.currentUser?.id || 'anon';
        return `mvt_survey_draft_${uid}`;
    }

    _saveSurveyDraft() {
        if (!this._surveyState) return;
        try {
            localStorage.setItem(this._getSurveyDraftKey(), JSON.stringify(this._surveyState));
        } catch {}
    }

    _clearSurveyDraft() {
        try {
            localStorage.removeItem(this._getSurveyDraftKey());
        } catch {}
    }

    _createEmptySurveyState(sets) {
        const setRatings = {};
        (sets || []).forEach((s) => {
            setRatings[s.label] = { relevance: null, novelty: null, diversity: null };
        });
        return {
            feedback: {},
            setRatings,
            winnerLabel: '',
            askAiUsed: true,
            askAiRating: null,
            askAiComment: '',
            generalComment: '',
        };
    }

    async loadSurvey() {
        const container = document.getElementById('survey-content');
        const progressEl = document.getElementById('survey-progress-summary');
        if (!container) return;

        container.innerHTML = '<div class="survey-loading"><i class="fas fa-spinner fa-spin"></i> Przygotowuję ankietę...</div>';
        if (progressEl) progressEl.style.display = 'none';

        try {
            const res = await fetch('/api/survey', { headers: this.getAuthHeaders() });
            const data = await res.json();

            if (!res.ok) {
                throw new Error(data.error || 'Nie udało się załadować ankiety.');
            }

            if (data.surveyEnabled === false) {
                this._surveyData = null;
                this._surveyState = null;
                this.renderSurveyLocked();
                return;
            }

            if (data.submitted) {
                this._surveyData = null;
                this._surveyState = null;
                this._clearSurveyDraft();
                this.renderSurveyCompleted(data.submission);
                return;
            }

            if (!data.ready || !Array.isArray(data.sets) || data.sets.length === 0) {
                this._surveyData = null;
                this._surveyState = null;
                this.renderSurveyNotReady();
                return;
            }

            this._surveyData = data;
            const fresh = this._createEmptySurveyState(data.sets);

            try {
                const rawDraft = localStorage.getItem(this._getSurveyDraftKey());
                if (rawDraft) {
                    const parsed = JSON.parse(rawDraft);
                    if (parsed && typeof parsed === 'object') {
                        if (parsed.feedback && typeof parsed.feedback === 'object') {
                            fresh.feedback = parsed.feedback;
                        }
                        if (parsed.setRatings && typeof parsed.setRatings === 'object') {
                            data.sets.forEach((s) => {
                                const savedSr = parsed.setRatings[s.label];
                                if (savedSr) {
                                    fresh.setRatings[s.label] = {
                                        relevance: savedSr.relevance || null,
                                        novelty: savedSr.novelty || null,
                                        diversity: savedSr.diversity || null,
                                    };
                                }
                            });
                        }
                        if (data.sets.some((s) => s.label === parsed.winnerLabel)) {
                            fresh.winnerLabel = parsed.winnerLabel;
                        }
                        if (typeof parsed.askAiUsed === 'boolean') {
                            fresh.askAiUsed = parsed.askAiUsed;
                        }
                        if (parsed.askAiRating >= 1 && parsed.askAiRating <= 5) {
                            fresh.askAiRating = parsed.askAiRating;
                        }
                        if (typeof parsed.askAiComment === 'string') {
                            fresh.askAiComment = parsed.askAiComment;
                        }
                        if (typeof parsed.generalComment === 'string') {
                            fresh.generalComment = parsed.generalComment;
                        }
                    }
                }
            } catch {}

            this._surveyState = fresh;
            this.renderSurveyForm();
        } catch (err) {
            console.error('loadSurvey error:', err);
            container.innerHTML = `<div class="survey-empty-card"><i class="fas fa-exclamation-triangle"></i><h3>Błąd ładowania ankiety</h3><p>${this.escapeHtml(err.message)}</p></div>`;
        }
    }

    renderSurveyLocked() {
        const container = document.getElementById('survey-content');
        const progressEl = document.getElementById('survey-progress-summary');
        if (progressEl) progressEl.style.display = 'none';
        if (!container) return;

        const skeletonSets = ['A', 'B', 'C', 'D'].map((label) => `
            <article class="survey-set-card">
                <div class="survey-set-header">
                    <h2><i class="fas fa-layer-group"></i> Zestaw ${label}</h2>
                    <span class="survey-set-badge">Zablokowany</span>
                </div>
                <div class="survey-locked-placeholder-cards">
                    <div class="survey-locked-placeholder-card"></div>
                    <div class="survey-locked-placeholder-card"></div>
                    <div class="survey-locked-placeholder-card"></div>
                    <div class="survey-locked-placeholder-card"></div>
                    <div class="survey-locked-placeholder-card"></div>
                </div>
            </article>
        `).join('');

        container.innerHTML = `
            <div class="survey-locked-wrap">
                <div class="survey-locked-banner">
                    <i class="fas fa-lock"></i>
                    <h2>Sesja ankiet jeszcze nie rozpoczęta</h2>
                    <p>
                        Administrator nie uruchomił jeszcze etapu oceny rekomendacji.
                        W międzyczasie dodawaj i oceniaj obejrzane filmy oraz seriale na stronie. Gdy rozpocznie się etap oceny, formularz ankiety odblokuje się automatycznie w tym miejscu.
                    </p>
                    <button type="button" class="btn btn-primary" onclick="app.showSection('dashboard')">
                        Wróć do Dashboardu
                    </button>
                </div>
                <div class="survey-locked-preview" aria-hidden="true">
                    ${skeletonSets}
                </div>
            </div>
        `;
    }

    renderSurveyCompleted(submission) {
        const container = document.getElementById('survey-content');
        const progressEl = document.getElementById('survey-progress-summary');
        if (progressEl) progressEl.style.display = 'none';
        if (!container) return;

        const submittedDate = submission?.createdAt
            ? new Date(submission.createdAt).toLocaleString('pl-PL')
            : '';

        container.innerHTML = `
            <div class="survey-done-card">
                <i class="fas fa-check-circle"></i>
                <h2>Dziękujemy za wypełnienie ankiety!</h2>
                <p style="margin-top: 0.5rem; color: var(--text-secondary);">
                    Twoja odpowiedź została zapisana w bazie danych oraz zabezpieczona na serwerze.
                    Aby zapewnić wiarygodność badania, każde konto może wysłać ankietę tylko raz.
                </p>
                ${submission?.winnerLabel ? `<p style="margin-top: 0.85rem; font-weight: 600;">Wskazany zwycięzca: Zestaw ${this.escapeHtml(submission.winnerLabel)}</p>` : ''}
                ${submittedDate ? `<p style="margin-top: 0.25rem; font-size: 0.85rem; color: var(--text-secondary);">Data wysłania: ${this.escapeHtml(submittedDate)}</p>` : ''}
                <div style="margin-top: 1.4rem;">
                    <button type="button" class="btn btn-primary" onclick="app.showSection('dashboard')">Wróć do Dashboardu</button>
                </div>
            </div>
        `;
    }

    renderSurveyNotReady() {
        const container = document.getElementById('survey-content');
        const progressEl = document.getElementById('survey-progress-summary');
        if (progressEl) progressEl.style.display = 'none';
        if (!container) return;

        container.innerHTML = `
            <div class="survey-empty-card">
                <i class="fas fa-film"></i>
                <h2>Brak list rekomendacji do oceny</h2>
                <p style="margin-top: 0.5rem; color: var(--text-secondary);">
                    Aby wziąć udział w ankiecie, musisz najpierw mieć wygenerowane własne listy rekomendacji.
                    Oceń kilka filmów w Dashboardzie lub Mojej Liście, a następnie wróć tutaj.
                </p>
                <div style="margin-top: 1.4rem; display: flex; justify-content: center; gap: 0.75rem; flex-wrap: wrap;">
                    <button type="button" class="btn btn-primary" onclick="app.showSection('dashboard')">Przejdź do Dashboardu</button>
                </div>
            </div>
        `;
    }

    _scrollSurveyTrack(label, direction) {
        const track = document.querySelector(`.survey-track[data-set-label="${label}"]`);
        if (!track) return;
        const card = track.querySelector('.survey-movie-card');
        const step = card ? (card.offsetWidth + 13) * 2 : 320;
        track.scrollBy({ left: direction * step, behavior: 'smooth' });
    }

    _updateSurveyProgress() {
        const sets = this._surveyData?.sets || [];
        const state = this._surveyState;
        if (!sets.length || !state) return;

        let totalMovies = 0;
        let ratedMovies = 0;
        let completedSets = 0;

        sets.forEach((s) => {
            const label = s.label;
            const totalInSet = s.movies.length;
            let ratedInSet = 0;
            s.movies.forEach((m) => {
                const key = `${label}:${m.id}`;
                if (state.feedback[key] === true || state.feedback[key] === false) {
                    ratedInSet++;
                }
            });
            totalMovies += totalInSet;
            ratedMovies += ratedInSet;

            const sr = state.setRatings[label] || {};
            const setRatingsDone = Boolean(sr.relevance && sr.novelty && sr.diversity);
            const isSetDone = ratedInSet === totalInSet && setRatingsDone;
            if (isSetDone) completedSets++;

            const badge = document.querySelector(`.survey-set-badge[data-set-label="${label}"]`);
            if (badge) {
                badge.textContent = `${ratedInSet}/${totalInSet} filmów | oceny ${setRatingsDone ? 'OK' : 'brak'}`;
                badge.classList.toggle('is-complete', isSetDone);
            }
        });

        const progressEl = document.getElementById('survey-progress-summary');
        if (progressEl) {
            progressEl.style.display = 'inline-flex';
            progressEl.innerHTML = `<i class="fas fa-tasks"></i> Zestawy: ${completedSets}/${sets.length} | Filmy: ${ratedMovies}/${totalMovies}`;
        }
    }

    renderSurveyForm() {
        const container = document.getElementById('survey-content');
        const sets = this._surveyData?.sets || [];
        const state = this._surveyState;
        if (!container || !sets.length || !state) return;

        const metricDefs = [
            { key: 'relevance', label: 'Trafność pod gust', hint: '1 = zupełnie nietrafione, 5 = idealnie pod mój gust' },
            { key: 'novelty', label: 'Odkrywczość (nowość)', hint: '1 = same oczywiste hity, 5 = świetne nieznane perełki' },
            { key: 'diversity', label: 'Różnorodność propozycji', hint: '1 = bardzo monotonna lista, 5 = ciekawe zróżnicowanie' },
        ];

        const setsHtml = sets.map((s) => {
            const label = this.escapeHtml(s.label);
            const cardsHtml = s.movies.map((m) => {
                const key = `${s.label}:${m.id}`;
                const fb = state.feedback[key];
                const poster = this.getPosterUrl(m);
                const imdb = m.imdb_rating != null ? `<span>⭐ ${parseFloat(m.imdb_rating).toFixed(1)}</span>` : '<span></span>';
                const genre = m.genre ? `<div class="survey-movie-genre">${this.escapeHtml(m.genre)}</div>` : '';

                return `
                    <div class="survey-movie-card" data-survey-card="${this.escapeHtml(key)}">
                        <div class="survey-movie-clickable" data-movie-id="${m.id}" data-set-label="${label}" title="Kliknij, aby zobaczyć szczegóły filmu">
                            <img src="${poster}" alt="${this.escapeHtml(m.title || '')}" loading="lazy">
                            <div class="survey-movie-body">
                                <div class="survey-movie-title">${this.escapeHtml(m.title || '')}</div>
                                <div class="survey-movie-meta">${imdb}<span>#${m.rank ?? ''}</span></div>
                                ${genre}
                            </div>
                        </div>
                        <div class="survey-thumb-actions">
                            <button type="button" class="survey-thumb-btn is-up ${fb === true ? 'active' : ''}" data-set-label="${label}" data-movie-id="${m.id}" data-vote="1" title="Pasuje / ciekawa propozycja">
                                <i class="fas fa-thumbs-up"></i>
                            </button>
                            <button type="button" class="survey-thumb-btn is-down ${fb === false ? 'active' : ''}" data-set-label="${label}" data-movie-id="${m.id}" data-vote="0" title="Nie pasuje / nietrafione">
                                <i class="fas fa-thumbs-down"></i>
                            </button>
                        </div>
                    </div>
                `;
            }).join('');

            const sr = state.setRatings[s.label] || {};
            const ratingsHtml = metricDefs.map((def) => {
                const currentVal = sr[def.key];
                const btns = [1, 2, 3, 4, 5].map((n) => `
                    <button type="button" class="survey-likert-btn ${currentVal === n ? 'active' : ''}" data-set-label="${label}" data-metric="${def.key}" data-value="${n}">${n}</button>
                `).join('');
                return `
                    <div class="survey-metric-box">
                        <span class="survey-metric-label">${def.label}</span>
                        <span class="survey-metric-hint">${def.hint}</span>
                        <div class="survey-likert-row">${btns}</div>
                    </div>
                `;
            }).join('');

            return `
                <article class="survey-set-card" data-survey-set="${label}">
                    <div class="survey-set-header">
                        <h2><i class="fas fa-layer-group" style="color: var(--secondary-color);"></i> Zestaw ${label}</h2>
                        <span class="survey-set-badge" data-set-label="${label}">0/${s.movies.length}</span>
                    </div>
                    <div class="survey-slider-container">
                        <button type="button" class="for-you-arrow for-you-prev survey-arrow" data-set-label="${label}" data-dir="-1" aria-label="Poprzednie w zestawie ${label}">
                            <i class="fas fa-chevron-left"></i>
                        </button>
                        <div class="survey-track" data-set-label="${label}">
                            ${cardsHtml}
                        </div>
                        <button type="button" class="for-you-arrow for-you-next survey-arrow" data-set-label="${label}" data-dir="1" aria-label="Następne w zestawie ${label}">
                            <i class="fas fa-chevron-right"></i>
                        </button>
                    </div>
                    <div class="survey-set-ratings">
                        ${ratingsHtml}
                    </div>
                </article>
            `;
        }).join('');

        const winnerButtonsHtml = sets.map((s) => `
            <button type="button" class="survey-winner-btn ${state.winnerLabel === s.label ? 'active' : ''}" data-winner="${this.escapeHtml(s.label)}">
                Zestaw ${this.escapeHtml(s.label)}
            </button>
        `).join('');

        const askAiLikertHtml = [1, 2, 3, 4, 5].map((n) => `
            <button type="button" class="survey-likert-btn survey-ask-ai-btn ${state.askAiUsed && state.askAiRating === n ? 'active' : ''}" data-value="${n}" ${!state.askAiUsed ? 'disabled' : ''}>${n}</button>
        `).join('');

        container.innerHTML = `
            <div class="survey-intro-card">
                <h3>Instrukcja badania</h3>
                <p>Poniżej widzisz <strong>${sets.length} anonimowe zestawy rekomendacji</strong> (kolejność modeli została losowo wymieszana specjalnie dla Twojego konta). Oceń każdy film przyciskiem 👍 lub 👎 (kliknięcie plakatu otwiera opis), wystaw 3 oceny dla każdego zestawu, a na końcu wskaż najlepszą listę oraz oceń czat <strong>"Zapytaj AI"</strong>. Postęp zapisuje się lokalnie automatycznie, a po wysłaniu ankieta jest przypisywana na stałe do konta.</p>
            </div>

            ${setsHtml}

            <div class="survey-final-card" id="survey-final-card">
                <div class="survey-question-block">
                    <span class="survey-question-title">1. Który zestaw rekomendacji najbardziej Ci się spodobał?</span>
                    <div class="survey-winner-options">
                        ${winnerButtonsHtml}
                    </div>
                </div>

                <div class="survey-question-block">
                    <span class="survey-question-title">2. Jak oceniasz rekomendacje z czatu na żywo "Zapytaj AI" (ikona w prawym dolnym rogu)?</span>
                    <div class="survey-ask-ai-controls">
                        <div class="survey-likert-row">
                            ${askAiLikertHtml}
                        </div>
                        <button type="button" id="survey-open-ask-ai-btn" class="btn btn-secondary btn-sm">
                            <i class="fas fa-comments"></i> Przetestuj "Zapytaj AI"
                        </button>
                        <label class="survey-ask-ai-skip">
                            <input type="checkbox" id="survey-ask-ai-not-used" ${!state.askAiUsed ? 'checked' : ''}>
                            <span>Nie korzystałem z "Zapytaj AI"</span>
                        </label>
                    </div>
                    <textarea id="survey-ask-ai-comment" class="survey-textarea" placeholder="Napisz krótko, jak podobały Ci się rekomendacje i odpowiedzi z czatu na żywo LLM (np. trafność, szybkość, opisy)...">${this.escapeHtml(state.askAiComment || '')}</textarea>
                </div>

                <div class="survey-question-block">
                    <span class="survey-question-title">3. Dodatkowe uwagi ogólne (opcjonalnie)</span>
                    <textarea id="survey-general-comment" class="survey-textarea" placeholder="Wszelkie spostrzeżenia dotyczące rekomendacji lub działania aplikacji...">${this.escapeHtml(state.generalComment || '')}</textarea>
                </div>

                <div class="survey-submit-row">
                    <span style="font-size: 0.85rem; color: var(--text-secondary);">Po wysłaniu ankiety nie można jej wypełnić ponownie.</span>
                    <button type="button" id="survey-submit-btn" class="btn btn-primary">
                        <i class="fas fa-paper-plane"></i> Wyślij ankietę
                    </button>
                </div>
            </div>
        `;

        // Podpiecie zdarzen ankiety
        const movieMap = new Map();
        sets.forEach((s) => s.movies.forEach((m) => movieMap.set(`${s.label}:${m.id}`, m)));

        container.querySelectorAll('.survey-movie-clickable').forEach((el) => {
            el.addEventListener('click', () => {
                const key = `${el.dataset.setLabel}:${el.dataset.movieId}`;
                const movie = movieMap.get(key);
                if (movie) this.openMovieModal(movie, false);
            });
        });

        container.querySelectorAll('.survey-thumb-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const label = btn.dataset.setLabel;
                const movieId = btn.dataset.movieId;
                const vote = btn.dataset.vote === '1';
                const key = `${label}:${movieId}`;
                state.feedback[key] = vote;

                const card = container.querySelector(`.survey-movie-card[data-survey-card="${key}"]`);
                if (card) {
                    card.classList.remove('is-unrated-highlight');
                    const upBtn = card.querySelector('.survey-thumb-btn.is-up');
                    const downBtn = card.querySelector('.survey-thumb-btn.is-down');
                    if (upBtn) upBtn.classList.toggle('active', vote === true);
                    if (downBtn) downBtn.classList.toggle('active', vote === false);
                }
                this._saveSurveyDraft();
                this._updateSurveyProgress();
            });
        });

        container.querySelectorAll('.survey-arrow').forEach((arrow) => {
            arrow.addEventListener('click', () => {
                const label = arrow.dataset.setLabel;
                const dir = Number(arrow.dataset.dir) || 1;
                this._scrollSurveyTrack(label, dir);
            });
        });

        container.querySelectorAll('.survey-likert-btn:not(.survey-ask-ai-btn)').forEach((btn) => {
            btn.addEventListener('click', () => {
                const label = btn.dataset.setLabel;
                const metric = btn.dataset.metric;
                const value = Number(btn.dataset.value);
                if (!state.setRatings[label]) state.setRatings[label] = {};
                state.setRatings[label][metric] = value;

                const row = btn.closest('.survey-likert-row');
                if (row) {
                    row.querySelectorAll('.survey-likert-btn').forEach((b) => {
                        b.classList.toggle('active', Number(b.dataset.value) === value);
                    });
                }
                const setCard = btn.closest('.survey-set-card');
                if (setCard) setCard.classList.remove('has-error');
                this._saveSurveyDraft();
                this._updateSurveyProgress();
            });
        });

        container.querySelectorAll('.survey-winner-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                state.winnerLabel = btn.dataset.winner;
                container.querySelectorAll('.survey-winner-btn').forEach((b) => {
                    b.classList.toggle('active', b.dataset.winner === state.winnerLabel);
                });
                this._saveSurveyDraft();
            });
        });

        container.querySelectorAll('.survey-ask-ai-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                if (!state.askAiUsed) return;
                const val = Number(btn.dataset.value);
                state.askAiRating = val;
                container.querySelectorAll('.survey-ask-ai-btn').forEach((b) => {
                    b.classList.toggle('active', Number(b.dataset.value) === val);
                });
                this._saveSurveyDraft();
            });
        });

        const askAiSkip = document.getElementById('survey-ask-ai-not-used');
        if (askAiSkip) {
            askAiSkip.addEventListener('change', (e) => {
                state.askAiUsed = !e.target.checked;
                container.querySelectorAll('.survey-ask-ai-btn').forEach((b) => {
                    b.disabled = !state.askAiUsed;
                    if (!state.askAiUsed) b.classList.remove('active');
                    else b.classList.toggle('active', Number(b.dataset.value) === state.askAiRating);
                });
                this._saveSurveyDraft();
            });
        }

        const openAskAiBtn = document.getElementById('survey-open-ask-ai-btn');
        if (openAskAiBtn) {
            openAskAiBtn.addEventListener('click', () => this.toggleAskAIDrawer(true));
        }

        const askAiCommentEl = document.getElementById('survey-ask-ai-comment');
        if (askAiCommentEl) {
            askAiCommentEl.addEventListener('input', (e) => {
                state.askAiComment = e.target.value;
                this._saveSurveyDraft();
            });
        }

        const generalCommentEl = document.getElementById('survey-general-comment');
        if (generalCommentEl) {
            generalCommentEl.addEventListener('input', (e) => {
                state.generalComment = e.target.value;
                this._saveSurveyDraft();
            });
        }

        const submitBtn = document.getElementById('survey-submit-btn');
        if (submitBtn) {
            submitBtn.addEventListener('click', () => this.submitSurvey());
        }

        this._updateSurveyProgress();
    }

    async submitSurvey() {
        if (this._surveySubmitting) return;
        const sets = this._surveyData?.sets || [];
        const state = this._surveyState;
        if (!sets.length || !state) return;

        // Walidacja lokalna przed wyslaniem
        for (const s of sets) {
            for (const m of s.movies) {
                const key = `${s.label}:${m.id}`;
                if (state.feedback[key] !== true && state.feedback[key] !== false) {
                    const card = document.querySelector(`.survey-movie-card[data-survey-card="${key}"]`);
                    if (card) {
                        card.classList.add('is-unrated-highlight');
                        card.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'center' });
                    }
                    this.showNotification(`Oceń film "${m.title}" (👍/👎) w Zestawie ${s.label}.`, 'error');
                    return;
                }
            }
            const sr = state.setRatings[s.label] || {};
            if (!sr.relevance || !sr.novelty || !sr.diversity) {
                const setCard = document.querySelector(`.survey-set-card[data-survey-set="${s.label}"]`);
                if (setCard) {
                    setCard.classList.add('has-error');
                    setCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
                }
                this.showNotification(`Uzupełnij wszystkie 3 oceny (1-5) dla Zestawu ${s.label}.`, 'error');
                return;
            }
        }

        if (!state.winnerLabel) {
            document.getElementById('survey-final-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            this.showNotification('Wybierz zwycięski zestaw rekomendacji.', 'error');
            return;
        }

        if (state.askAiUsed && !state.askAiRating) {
            document.getElementById('survey-final-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
            this.showNotification('Oceń czat "Zapytaj AI" w skali 1-5 lub zaznacz, że z niego nie korzystałeś.', 'error');
            return;
        }

        const movieFeedback = [];
        sets.forEach((s) => {
            s.movies.forEach((m) => {
                movieFeedback.push({
                    label: s.label,
                    movieId: m.id,
                    isRelevant: state.feedback[`${s.label}:${m.id}`] ? 1 : 0,
                });
            });
        });

        const submitBtn = document.getElementById('survey-submit-btn');
        this._surveySubmitting = true;
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Zapisuję ankietę...';
        }

        try {
            const res = await fetch('/api/survey', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
                body: JSON.stringify({
                    winnerLabel: state.winnerLabel,
                    setRatings: state.setRatings,
                    movieFeedback,
                    askAiUsed: state.askAiUsed,
                    askAiRating: state.askAiUsed ? state.askAiRating : null,
                    askAiComment: state.askAiComment || '',
                    generalComment: state.generalComment || '',
                }),
            });

            const data = await res.json().catch(() => ({}));
            if (res.status === 403 || data.surveyLocked) {
                this.showNotification(data.error || 'Sesja ankiet jest obecnie zablokowana.', 'info');
                await this.loadSurvey();
                return;
            }
            if (res.status === 409 || data.alreadySubmitted) {
                this._clearSurveyDraft();
                this.showNotification(data.error || 'Ankieta została już wcześniej wysłana.', 'info');
                await this.loadSurvey();
                return;
            }
            if (!res.ok) {
                throw new Error(data.error || 'Nie udało się zapisać ankiety.');
            }

            this._clearSurveyDraft();
            this.showNotification('Dziękujemy! Wyniki ankiety zostały zapisane.', 'success');
            this.renderSurveyCompleted({
                winnerLabel: state.winnerLabel,
                askAiUsed: state.askAiUsed,
                askAiRating: state.askAiRating,
                createdAt: data.submittedAt || new Date().toISOString(),
            });
        } catch (err) {
            console.error('submitSurvey error:', err);
            this.showNotification(err.message || 'Błąd wysyłania ankiety.', 'error');
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = '<i class="fas fa-paper-plane"></i> Wyślij ankietę';
            }
        } finally {
            this._surveySubmitting = false;
        }
    }

    // ============= PANEL ADMINA: WYNIKI ANKIETY I METRYKI =============
    async loadAdminSurvey() {
        const container = document.getElementById('admin-survey-content');
        if (!container) return;
        container.innerHTML = '<div class="survey-loading"><i class="fas fa-spinner fa-spin"></i> Ładowanie wyników i metryk...</div>';

        try {
            const res = await fetch('/api/admin/survey', { headers: this.getAuthHeaders() });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Błąd pobierania wyników ankiety.');
            this.renderAdminSurvey(data);
        } catch (err) {
            console.error('loadAdminSurvey error:', err);
            container.innerHTML = `<div class="survey-empty-card"><i class="fas fa-exclamation-triangle"></i><p>${this.escapeHtml(err.message)}</p></div>`;
        }
    }

    renderAdminSurvey(data) {
        this._adminSurveyEnabled = Boolean(data.surveyEnabled);
        this._updateAdminSurveyLockUi();

        const container = document.getElementById('admin-survey-content');
        if (!container) return;

        const fmt = (val, suffix = '') => (val !== null && val !== undefined ? `${val}${suffix}` : '-');
        const models = [
            'collaborative_filtering',
            'content_based',
            'llm_querec',
            'hybrid_querec',
        ];
        const latModels = data.latency?.models || {};

        const groupARows = models.map((m) => {
            const a = data.groupA?.[m] || {};
            return `
                <tr>
                    <td><strong>${this.escapeHtml(a.label || m)}</strong></td>
                    <td>${a.wins ?? 0} (${fmt(a.winRatePct, '%')})</td>
                    <td>${fmt(a.microPrecisionPct, '%')} <small style="color:var(--text-secondary);">(${a.thumbsUp ?? 0}/${(a.thumbsUp ?? 0) + (a.thumbsDown ?? 0)})</small></td>
                    <td>${fmt(a.avgRelevance)}</td>
                    <td>${fmt(a.avgNovelty)}</td>
                    <td>${fmt(a.avgDiversity)}</td>
                    <td>${a.ratedSets ?? 0}</td>
                </tr>
            `;
        }).join('');

        const groupBRows = models.map((m) => {
            const b = data.groupB?.[m] || {};
            const l = latModels[m] || {};
            return `
                <tr>
                    <td><strong>${this.escapeHtml(b.label || m)}</strong></td>
                    <td>${b.usersCount ?? 0}</td>
                    <td>${b.catalogCoverage ?? 0} <small style="color:var(--text-secondary);">/ ${b.totalRecs ?? 0}</small></td>
                    <td>${fmt(b.avgPopularity)} / ${fmt(b.medianPopularity)}</td>
                    <td>${fmt(b.avgVoteCount)} / ${fmt(b.medianVoteCount)}</td>
                    <td>${fmt(b.avgImdbRating)}</td>
                    <td>${l.mean_ms != null ? `${l.mean_ms} ms (med. ${l.median_ms} ms, n=${l.count})` : '-'}</td>
                </tr>
            `;
        }).join('');

        const askAiLat = latModels.ask_ai;
        const commentsHtml = (data.askAi?.comments || []).length
            ? data.askAi.comments.map((c) => `
                <div class="admin-survey-comment-item">
                    <div style="display:flex; justify-content:space-between; gap:0.5rem; margin-bottom:0.3rem;">
                        <strong>${this.escapeHtml(c.nickname)}</strong>
                        <span style="color:var(--text-secondary); font-size:0.8rem;">Zapytaj AI: ${c.ask_ai_used ? `${c.ask_ai_rating ?? '-'}/5` : 'nie użyto'}</span>
                    </div>
                    ${c.ask_ai_comment ? `<p><strong>Czat AI:</strong> ${this.escapeHtml(c.ask_ai_comment)}</p>` : ''}
                    ${c.general_comment ? `<p style="margin-top:0.2rem;"><strong>Uwagi ogólne:</strong> ${this.escapeHtml(c.general_comment)}</p>` : ''}
                </div>
            `).join('')
            : '<p style="color:var(--text-secondary);">Brak komentarzy tekstowych od testerów.</p>';

        const subRows = (data.submissions || []).length
            ? data.submissions.map((s) => `
                <tr>
                    <td>${s.user_id}</td>
                    <td>${this.escapeHtml(s.nickname || '-')}</td>
                    <td><strong>Zestaw ${this.escapeHtml(s.winner_label)}</strong> (${this.escapeHtml(s.winner_model_label)})</td>
                    <td>${s.ask_ai_used ? `${s.ask_ai_rating ?? '-'}/5` : 'Nie użyto'}</td>
                    <td>${this.escapeHtml(new Date(s.created_at).toLocaleString('pl-PL'))}</td>
                    <td>
                        <button type="button" class="btn btn-secondary btn-sm admin-survey-reset-btn" data-user-id="${s.user_id}" data-nickname="${this.escapeHtml(s.nickname || `ID ${s.user_id}`)}">
                            Resetuj
                        </button>
                    </td>
                </tr>
            `).join('')
            : '<tr><td colspan="6" style="text-align:center; color:var(--text-secondary);">Brak wysłanych ankiet.</td></tr>';

        container.innerHTML = `
            <div class="admin-survey-summary-grid">
                <div class="admin-survey-card">
                    <div class="admin-survey-card-label">Wypełnione ankiety</div>
                    <div class="admin-survey-card-value">${data.totalSubmissions ?? 0}</div>
                </div>
                <div class="admin-survey-card">
                    <div class="admin-survey-card-label">Śr. ocena "Zapytaj AI"</div>
                    <div class="admin-survey-card-value">${fmt(data.askAi?.avgRating, '/5')}</div>
                </div>
                <div class="admin-survey-card">
                    <div class="admin-survey-card-label">Overlap CF vs LLM</div>
                    <div class="admin-survey-card-value">${fmt(data.cfLlmOverlap?.avgOverlapPct, '%')}</div>
                </div>
                <div class="admin-survey-card">
                    <div class="admin-survey-card-label">Serwer FastAPI (Latency)</div>
                    <div class="admin-survey-card-value" style="font-size:1rem;">${data.latency?.serverOnline ? `Online (${data.latency.total_measurements ?? 0} pom.)` : 'Offline'}</div>
                </div>
            </div>

            <h3 class="admin-survey-section-title">Grupa A: Oceny użytkowników (ślepy test)</h3>
            <div class="admin-table-container">
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>Model</th>
                            <th>Wygrane (Win Rate)</th>
                            <th>Precision@k (👍/razem)</th>
                            <th>Trafność (1-5)</th>
                            <th>Odkrywczość (1-5)</th>
                            <th>Różnorodność (1-5)</th>
                            <th>Liczba zestawów</th>
                        </tr>
                    </thead>
                    <tbody>${groupARows}</tbody>
                </table>
            </div>

            <h3 class="admin-survey-section-title">Grupa B: Metryki automatyczne z D1 i czasy FastAPI</h3>
            <div class="admin-table-container">
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>Model</th>
                            <th>Użytkownicy</th>
                            <th>Pokrycie (unikalne / wszystkie)</th>
                            <th>Popularity (śr. / med.)</th>
                            <th>Vote count (śr. / med.)</th>
                            <th>Śr. IMDb</th>
                            <th>Latency (FastAPI)</th>
                        </tr>
                    </thead>
                    <tbody>${groupBRows}</tbody>
                </table>
            </div>
            ${askAiLat ? `<p style="margin-top:0.5rem; font-size:0.85rem; color:var(--text-secondary);">Czas "Zapytaj AI" (interaktywny): średnio ${askAiLat.mean_ms} ms, mediana ${askAiLat.median_ms} ms (n=${askAiLat.count}).</p>` : ''}

            <h3 class="admin-survey-section-title">Komentarze do "Zapytaj AI" i uwagi testerów</h3>
            <div class="admin-survey-comments-list">${commentsHtml}</div>

            <h3 class="admin-survey-section-title">Lista zgłoszeń użytkowników</h3>
            <div class="admin-table-container">
                <table class="admin-table">
                    <thead>
                        <tr>
                            <th>ID</th>
                            <th>Użytkownik</th>
                            <th>Zwycięzca</th>
                            <th>Zapytaj AI</th>
                            <th>Data</th>
                            <th>Akcje</th>
                        </tr>
                    </thead>
                    <tbody>${subRows}</tbody>
                </table>
            </div>
        `;

        container.querySelectorAll('.admin-survey-reset-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                this.resetUserSurvey(Number(btn.dataset.userId), btn.dataset.nickname);
            });
        });
    }

    _updateAdminSurveyLockUi() {
        const badge = document.getElementById('admin-survey-status-badge');
        const hint = document.getElementById('admin-survey-status-hint');
        const btn = document.getElementById('admin-survey-toggle-btn');

        if (badge) {
            badge.classList.toggle('is-open', this._adminSurveyEnabled);
            badge.classList.toggle('is-locked', !this._adminSurveyEnabled);
            badge.innerHTML = this._adminSurveyEnabled
                ? '<i class="fas fa-unlock"></i> Sesja ankiet: Odblokowana'
                : '<i class="fas fa-lock"></i> Sesja ankiet: Zablokowana';
        }
        if (hint) {
            hint.textContent = this._adminSurveyEnabled
                ? 'Wszyscy użytkownicy z wygenerowanymi rekomendacjami mogą teraz wypełnić ankietę.'
                : 'Użytkownicy widzą ekran oczekiwania i nie mogą wypełnić ankiety.';
        }
        if (btn) {
            btn.classList.toggle('btn-danger', this._adminSurveyEnabled);
            btn.classList.toggle('btn-primary', !this._adminSurveyEnabled);
            btn.innerHTML = this._adminSurveyEnabled
                ? '<i class="fas fa-lock"></i> Zablokuj ankietę'
                : '<i class="fas fa-unlock"></i> Odblokuj ankietę dla wszystkich';
        }
    }

    async toggleAdminSurveySession() {
        const nextState = !this._adminSurveyEnabled;
        const msg = nextState
            ? 'Czy chcesz odblokować ankietę dla wszystkich użytkowników? Upewnij się, że rekomendacje dla Tury 2 zostały już przeliczone.'
            : 'Czy chcesz zablokować dostęp do ankiety dla użytkowników?';
        const title = nextState ? 'Odblokowanie sesji ankiet' : 'Blokada sesji ankiet';

        if (!(await this.showConfirm(msg, title))) return;

        const btn = document.getElementById('admin-survey-toggle-btn');
        if (btn) btn.disabled = true;

        try {
            const res = await fetch('/api/admin/survey', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', ...this.getAuthHeaders() },
                body: JSON.stringify({ surveyEnabled: nextState }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Nie udało się zmienić statusu ankiety.');

            this._adminSurveyEnabled = Boolean(data.surveyEnabled);
            this._updateAdminSurveyLockUi();
            this.showNotification(
                this._adminSurveyEnabled
                    ? 'Ankieta została odblokowana dla wszystkich użytkowników!'
                    : 'Ankieta została zablokowana.',
                'success'
            );
        } catch (err) {
            console.error('toggleAdminSurveySession error:', err);
            this.showNotification(err.message || 'Błąd zmiany statusu ankiety.', 'error');
        } finally {
            if (btn) btn.disabled = false;
        }
    }

    async downloadAdminSurveyCsv(dataset) {
        try {
            const res = await fetch(`/api/admin/survey?format=csv&dataset=${encodeURIComponent(dataset)}`, {
                headers: this.getAuthHeaders(),
            });
            if (!res.ok) {
                const err = await res.json().catch(() => ({}));
                throw new Error(err.error || 'Błąd eksportu CSV.');
            }
            const blob = await res.blob();
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `survey_${dataset}.csv`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            URL.revokeObjectURL(url);
        } catch (err) {
            console.error('downloadAdminSurveyCsv error:', err);
            this.showNotification(err.message || 'Nie udało się pobrać pliku CSV.', 'error');
        }
    }

    async syncAdminSurveyToServer() {
        try {
            const res = await fetch('/api/admin/survey', {
                method: 'POST',
                headers: this.getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Nie udało się zsynchronizować ankiet.');
            this.showNotification(`Zsynchronizowano ${data.syncedCount ?? 0} ankiet z serwerem.`, 'success');
            await this.loadAdminSurvey();
        } catch (err) {
            console.error('syncAdminSurveyToServer error:', err);
            this.showNotification(err.message || 'Błąd synchronizacji z serwerem.', 'error');
        }
    }

    async resetUserSurvey(userId, nickname) {
        const ok = await this.showConfirm(
            `Czy na pewno chcesz usunąć ankietę użytkownika ${nickname} (ID ${userId})? Po resecie użytkownik będzie mógł wypełnić ankietę ponownie.`,
            'Reset ankiety'
        );
        if (!ok) return;

        try {
            const res = await fetch(`/api/admin/survey?userId=${encodeURIComponent(userId)}`, {
                method: 'DELETE',
                headers: this.getAuthHeaders(),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || 'Błąd resetowania ankiety.');
            this.showNotification(`Zresetowano ankietę użytkownika ${nickname}.`, 'success');
            await this.loadAdminSurvey();
        } catch (err) {
            console.error('resetUserSurvey error:', err);
            this.showNotification(err.message || 'Nie udało się zresetować ankiety.', 'error');
        }
    }

    // ============= ŁADOWANIE RECENZJI W MODALU =============
    async loadReviewsIntoTab(movieId) {
        const container = document.getElementById('reviews-container');
        
        // Pokaż loader
        container.innerHTML = '<div class="loading-reviews"><i class="fas fa-spinner fa-spin"></i> Ładowanie recenzji...</div>';
        
        try {
            const response = await fetch(`/api/movies/${movieId}/reviews`, {
                headers: this.getAuthHeaders()
            });
            
            if (!response.ok) {
                throw new Error('Nie udało się pobrać recenzji');
            }
            
            const reviews = await response.json();
            
            // Jeśli brak recenzji
            if (!reviews || reviews.length === 0) {
                container.innerHTML = '<div class="no-reviews"><i class="fas fa-comment-slash"></i><p>Brak recenzji dla tego tytułu</p></div>';
                return;
            }
            
            // Wyświetl recenzje
            let html = '<div class="reviews-list">';
            
            reviews.forEach(review => {
                const dateToShow = review.updatedAt ? review.updatedAt : review.createdAt;
                const dateLabel = review.updatedAt ? 'Zaktualizowana' : '';
                const formattedDate = this.formatReviewDate(dateToShow);
                const displayDate = dateLabel ? `${dateLabel} ${formattedDate}` : formattedDate;
                const stars = this.generateStarsHTML(review.rating);
                const avatarUrl = review.avatarUrl || `https://ui-avatars.com/api/?name=${encodeURIComponent(review.username)}&background=4CAF50&color=fff`;
                
                html += `
                    <div class="review-item">
                        <div class="review-header">
                            <div class="review-user">
                                <img src="${avatarUrl}" alt="${review.username}" class="review-avatar">
                                <div class="review-user-info">
                                    <span class="review-username">${review.username}</span>
                                    <span class="review-date">${displayDate}</span>
                                </div>
                            </div>
                            <div class="review-rating">
                                ${stars}
                            </div>
                        </div>
                        <div class="review-content">
                            <p>${this.escapeHtml(review.reviewText || 'Użytkownik nie dodał recenzji tekstowej.')}</p>
                        </div>
                    </div>
                `;
            });
            
            html += '</div>';
            container.innerHTML = html;
            
        } catch (error) {
            console.error('Error loading reviews:', error);
            container.innerHTML = '<div class="error-reviews"><i class="fas fa-exclamation-triangle"></i><p>Błąd podczas ładowania recenzji</p></div>';
        }
    }
    
    // Formatuj datę recenzji
    formatReviewDate(dateString) {
        if (!dateString) return 'Brak daty';
        
        try {
            const date = new Date(dateString);
            const now = new Date();
            
            // Porównaj tylko daty, bez czasu
            const dateOnly = new Date(date.getFullYear(), date.getMonth(), date.getDate());
            const nowOnly = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            
            const diffTime = nowOnly - dateOnly;
            const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));
            
            if (diffDays === 0) {
                return 'Dziś';
            } else if (diffDays === 1) {
                return 'Wczoraj';
            } else if (diffDays < 7) {
                return `${diffDays} dni temu`;
            } else if (diffDays < 30) {
                const weeks = Math.floor(diffDays / 7);
                return `${weeks} ${weeks === 1 ? 'tydzień' : 'tygodni'} temu`;
            } else if (diffDays < 365) {
                const months = Math.floor(diffDays / 30);
                return `${months} ${months === 1 ? 'miesiąc' : 'miesięcy'} temu`;
            } else {
                return date.toLocaleDateString('pl-PL', {
                    day: 'numeric',
                    month: 'long',
                    year: 'numeric'
                });
            }
        } catch (e) {
            return 'Brak daty';
        }
    }
    
    // Generuj HTML dla gwiazdek
    generateStarsHTML(rating) {
        let html = '';
        for (let i = 1; i <= 5; i++) {
            if (i <= rating) {
                html += '<i class="fas fa-star"></i>';
            } else {
                html += '<i class="far fa-star"></i>';
            }
        }
        return html;
    }
    
    // Escape HTML dla bezpieczeństwa
    escapeHtml(text) {
        if (text == null) return '';
        const str = String(text);
        const map = {
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#039;'
        };
        return str.replace(/[&<>"']/g, m => map[m]);
    }
    
}

// Inicjalizacja aplikacji - ustaw na `window.app` aby inline onclick mogły go znaleźć
const _app = new MovieTracker();
window.app = _app;
