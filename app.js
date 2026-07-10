'use strict';

// ================= NOTIFICATIONS =================
        function showToast(msg, type='success') {
            const container = document.getElementById('toast-container');
            const toast = document.createElement('div');
            toast.className = `toast text-white px-6 py-3 rounded shadow-lg transform translate-y-10 opacity-0 flex items-center gap-2 ${type==='success'?'bg-green-600':'bg-red-600'}`;
            toast.innerHTML = `<i class="fas ${type==='success'?'fa-check-circle':'fa-exclamation-triangle'}"></i> ${msg}`;
            container.appendChild(toast);
            setTimeout(() => toast.classList.remove('translate-y-10', 'opacity-0'), 10);
            setTimeout(() => { toast.classList.add('translate-y-10', 'opacity-0'); setTimeout(() => toast.remove(), 300); }, 3000);
        }

        // ================= STATE & FIREBASE DB =================
let defaultCurrencies = [
            { code: 'USD', name: 'دولار أمريكي', rate: 365 },
            { code: 'ILS', name: 'شيكل إسرائيلي', rate: 100 },
            { code: 'USDT', name: 'تيثر رقمي (USDT)', rate: 368 },
            { code: 'JOD', name: 'دينار أردني', rate: 515 },
            { code: 'EUR', name: 'يورو', rate: 395 }
        ];

        let firebaseRootRef = null;
        let firebaseConnected = false;
        let remoteInitialized = false;
        let editingQuickId = null;
        let editingTransferId = null;
        let editingCheckId = null;
        const saveLocks = { quick: false, transfer: false, check: false };
        let snapshotMigrationInProgress = false;
        const DATA_RESET_VERSION = 'movement-sequence-reset-2026-07-10-v2';
        const LOCAL_RESET_MARKER_KEY = `${LOCAL_DB_KEY}:dataResetVersion`;
        const MARKET_RATES_CACHE_KEY = `${LOCAL_DB_KEY}:marketRates:v1`;
        const MARKET_RATES_MAX_AGE = 24 * 60 * 60 * 1000;
        let globalMarketRates = {};
        let globalMarketRatesUpdatedAt = 0;
        let globalMarketRatesLoading = false;

        function setFormSaving(formId, active) {
            const form = document.getElementById(formId);
            if(!form) return;
            form.querySelectorAll('button').forEach(button => {
                button.disabled = active;
                button.classList.toggle('opacity-60', active);
                button.classList.toggle('cursor-not-allowed', active);
            });
        }

        async function runSaveOnce(kind, formId, task) {
            if(saveLocks[kind]) {
                showToast('جاري حفظ العملية، انتظر لحظة', 'error');
                return;
            }
            saveLocks[kind] = true;
            setFormSaving(formId, true);
            try {
                await task();
            } finally {
                saveLocks[kind] = false;
                setFormSaving(formId, false);
            }
        }

        function defaultDatabase() {
            return {
                settings: { companyName: "WATAN PLS LTD", phone: "+970567406000", address: "فلسطين", currencies: defaultCurrencies.map(c => ({...c})), logo: DEFAULT_LOGO_FILE, dataResetVersion: DATA_RESET_VERSION, lastMovementNumber: 0 },
                ledger: [],
                clients: []
            };
        }

        function collectionToArray(value) {
            if(!value) return [];
            if(Array.isArray(value)) return value.filter(Boolean);
            if(typeof value !== 'object') return [];
            return Object.entries(value).filter(([key]) => key !== 'updatedAt').map(([key, row]) => {
                if(!row || typeof row !== 'object') return null;
                const numericKey = Number(key);
                return { ...row, id: row.id ?? (Number.isFinite(numericKey) ? numericKey : key) };
            }).filter(Boolean);
        }

        function normalizeDatabase(raw) {
            const base = defaultDatabase();
            const source = raw && typeof raw === 'object' ? raw : {};
            const rawSettings = source.settings && typeof source.settings === 'object' ? source.settings : {};
            const currencies = collectionToArray(rawSettings.currencies).map(c => ({
                code: String(c.code || '').toUpperCase(),
                name: String(c.name || c.code || ''),
                rate: Number(c.rate) || 100
            })).filter(c => c.code);
            const ledger = collectionToArray(source.ledger).map(t => ({
                ...t,
                id: Number.isFinite(Number(t.id)) ? Number(t.id) : t.id,
                amount: Number(t.amount) || 0,
                totalIls: Number(t.totalIls) || 0,
                totalUsd: t.totalUsd === undefined ? undefined : Number(t.totalUsd) || 0,
                totalUsdSnapshot: t.totalUsdSnapshot === undefined ? undefined : Number(t.totalUsdSnapshot) || 0,
                rate: t.rate === undefined ? undefined : Number(t.rate) || 0,
                currencyRateAtSave: t.currencyRateAtSave === undefined ? undefined : Number(t.currencyRateAtSave) || 0,
                equivalentCurrency: String(t.equivalentCurrency || 'ILS').toUpperCase(),
                equivalentAmount: t.equivalentAmount === undefined ? undefined : Number(t.equivalentAmount) || 0,
                equivalentRateAtSave: t.equivalentRateAtSave === undefined ? undefined : Number(t.equivalentRateAtSave) || 0,
                pairRateAtSave: t.pairRateAtSave === undefined ? undefined : Number(t.pairRateAtSave) || 0,
                financialVersion: Number(t.financialVersion) || 0
            }));
            const clients = collectionToArray(source.clients).map(c => ({
                ...c,
                id: Number.isFinite(Number(c.id)) ? Number(c.id) : c.id
            }));
            return {
                settings: { ...base.settings, ...rawSettings, currencies: currencies.length ? currencies : base.settings.currencies, logo: /^data:image\//i.test(String(rawSettings.logo || '')) ? '' : String(rawSettings.logo || ''), dataResetVersion: String(rawSettings.dataResetVersion || ''), lastMovementNumber: Number(rawSettings.lastMovementNumber) || 0 },
                ledger,
                clients
            };
        }

        function readLocalDatabase() {
            try { return normalizeDatabase(JSON.parse(localStorage.getItem(LOCAL_DB_KEY) || 'null')); }
            catch(error) { console.error('Local DB read error:', error); return defaultDatabase(); }
        }

        let db = readLocalDatabase();

        function saveLocalOnly() {
            localStorage.setItem(LOCAL_DB_KEY, JSON.stringify(db));
        }

        function resetLocalDataForRequiredVersion() {
            const marker = localStorage.getItem(LOCAL_RESET_MARKER_KEY);
            if(marker === DATA_RESET_VERSION && db.settings?.dataResetVersion === DATA_RESET_VERSION) return false;
            const preservedSettings = { ...(db.settings || {}) };
            db = {
                settings: {
                    ...defaultDatabase().settings,
                    ...preservedSettings,
                    dataResetVersion: DATA_RESET_VERSION,
                    lastMovementNumber: 0
                },
                ledger: [],
                clients: []
            };
            localStorage.setItem(LOCAL_RESET_MARKER_KEY, DATA_RESET_VERSION);
            saveLocalOnly();
            if(window.WatanLocalDB?.set) {
                window.WatanLocalDB.set(db).catch(error => console.error('IndexedDB reset error:', error));
            }
            return true;
        }

        function sanitizeForFirebase(value) {
            if(Array.isArray(value)) return value.map(item => item === undefined ? null : sanitizeForFirebase(item));
            if(value && typeof value === 'object') {
                const clean = {};
                Object.entries(value).forEach(([key, item]) => {
                    if(item !== undefined) clean[key] = sanitizeForFirebase(item);
                });
                return clean;
            }
            return value;
        }

        function mapCollectionById(rows) {
            const result = {};
            (rows || []).forEach((row, index) => {
                const key = String(row.id ?? index).replace(/[.#$\[\]\/]/g, '_');
                result[key] = row;
            });
            return result;
        }

        function firebasePayload() {
            return sanitizeForFirebase({
                settings: db.settings,
                ledger: mapCollectionById(db.ledger),
                clients: mapCollectionById(db.clients),
                updatedAt: firebase.database.ServerValue.TIMESTAMP
            });
        }

        async function saveDB(options = {}) {
            saveLocalOnly();
            if(!firebaseRootRef) {
                if(!options.silent) showToast('تم الحفظ محلياً، وسيتم التزامن عند توفر اتصال فايربيز', 'error');
                return false;
            }
            try {
                const writePromise = firebaseRootRef.set(firebasePayload());
                await Promise.race([
                    writePromise,
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Firebase sync timeout')), 10000))
                ]);
                return true;
            } catch(error) {
                console.error('Firebase save error:', error);
                if(!options.silent) showToast('تم الحفظ محلياً لكن تعذر التزامن مع فايربيز', 'error');
                return false;
            }
        }

        function getEffectiveLogo() {
            return String(db.settings.logo || '').trim() || DEFAULT_LOGO_FILE;
        }

        async function bootstrapFirebase() {
            try {
                if(!window.firebase) throw new Error('Firebase SDK is not available');
                if(!firebase.apps.length) firebase.initializeApp(firebaseConfig);
                firebaseRootRef = firebase.database().ref(FIREBASE_ROOT);

                firebase.database().ref('.info/connected').on('value', snap => {
                    firebaseConnected = snap.val() === true;
                });

                firebaseRootRef.on('value', async snapshot => {
                    const remote = snapshot.val();
                    if(!remote) {
                        if(!remoteInitialized) {
                            remoteInitialized = true;
                            await saveDB({silent: true});
                        }
                        return;
                    }
                    const remoteResetVersion = String(remote?.settings?.dataResetVersion || '');
                    if(remoteResetVersion !== DATA_RESET_VERSION) {
                        remoteInitialized = true;
                        const remoteSettings = remote?.settings && typeof remote.settings === 'object' ? remote.settings : {};
                        const localIsCurrent = db.settings?.dataResetVersion === DATA_RESET_VERSION;
                        const localLedger = localIsCurrent ? [...(db.ledger || [])] : [];
                        const localClients = localIsCurrent ? [...(db.clients || [])] : [];
                        const localLastMovement = localLedger.reduce((max, row) => Math.max(max, getMovementNumber(row)), 0);
                        db = {
                            settings: {
                                ...defaultDatabase().settings,
                                ...remoteSettings,
                                ...(localIsCurrent ? db.settings : {}),
                                dataResetVersion: DATA_RESET_VERSION,
                                lastMovementNumber: localLastMovement
                            },
                            ledger: localLedger,
                            clients: localClients
                        };
                        localStorage.setItem(LOCAL_RESET_MARKER_KEY, DATA_RESET_VERSION);
                        saveLocalOnly();
                        await firebaseRootRef.set(firebasePayload());
                        refreshSyncedViews();
                        showToast('تم حذف البيانات القديمة وبدء الترقيم من 0001');
                        return;
                    }
                    remoteInitialized = true;
                    db = normalizeDatabase(remote);
                    saveLocalOnly();
                    localStorage.setItem(LOCAL_RESET_MARKER_KEY, DATA_RESET_VERSION);
                    refreshSyncedViews();
                }, error => {
                    console.error('Firebase listener error:', error);
                    showToast('تعذر قراءة البيانات من فايربيز؛ تحقق من قواعد قاعدة البيانات', 'error');
                });
            } catch(error) {
                console.error('Firebase initialization error:', error);
                showToast('تعذر تشغيل مزامنة فايربيز، وسيستمر الحفظ المحلي', 'error');
            }
        }

        function getCurrencyRate(code, fallback = 100) {
            const normalized = String(code || '').toUpperCase();
            const configured = Number((db.settings.currencies.find(c => String(c.code).toUpperCase() === normalized) || {}).rate);
            return Number.isFinite(configured) && configured > 0 ? configured : fallback;
        }

        function getUsdRate() { return getCurrencyRate('USD', 365); }
        function getUsdEquivalent(ilsAmount, usdRate = getUsdRate()) {
            return Number(usdRate) > 0 ? Number(ilsAmount || 0) / (Number(usdRate) / 100) : 0;
        }

        function roundLedgerMoney(value) {
            const number = Number(value);
            return Number.isFinite(number) ? Math.round((number + Number.EPSILON) * 100) / 100 : 0;
        }

        function getDefaultPairRate(sourceCurrency, equivalentCurrency) {
            const sourceRate = getCurrencyRate(sourceCurrency);
            const targetRate = getCurrencyRate(equivalentCurrency);
            return targetRate > 0 ? (sourceRate / targetRate) * 100 : 0;
        }

        function createFinancialSnapshot(currency, amount, equivalentCurrency, equivalentAmount, pairRate, equivalentRate) {
            const sourceCode = String(currency || 'USD').toUpperCase();
            const targetCode = String(equivalentCurrency || 'ILS').toUpperCase();
            const amountNumber = Number(amount) || 0;
            const equivalentNumber = Number(equivalentAmount) || 0;

            // أسعار الإعدادات ثابتة بصيغة: كل 100 من العملة = كم شيكل.
            // أما حقل السعر داخل العملية فهو سعر الزوج: كل 100 من العملة الأولى = كم من العملة الثانية.
            const sourceRateAtSave = getCurrencyRate(sourceCode);
            const targetRateAtSave = Number(equivalentRate) > 0 ? Number(equivalentRate) : getCurrencyRate(targetCode);
            const usdRateAtSave = getUsdRate();
            const resolvedPairRate = Number(pairRate) > 0
                ? Number(pairRate)
                : (amountNumber > 0 ? (equivalentNumber / amountNumber) * 100 : getDefaultPairRate(sourceCode, targetCode));

            // قيمة السجل بالدولار تعتمد دائماً على المبلغ الأساسي (العملة الأولى)،
            // وليست على مبلغ العملة المقابلة. مثال: 100 USD مقابل 98 USDT تُسجل 100 USD.
            const sourceValueIls = amountNumber * (sourceRateAtSave / 100);
            const totalUsd = usdRateAtSave > 0 ? sourceValueIls / (usdRateAtSave / 100) : 0;

            return {
                totalUsd: roundLedgerMoney(totalUsd),
                totalUsdSnapshot: roundLedgerMoney(totalUsd),
                totalIls: roundLedgerMoney(sourceValueIls),
                usdRateAtSave: Number(usdRateAtSave),
                currencyRateAtSave: Number(sourceRateAtSave),
                equivalentCurrency: targetCode,
                equivalentAmount: roundLedgerMoney(equivalentNumber),
                equivalentRateAtSave: Number(targetRateAtSave),
                pairRateAtSave: Number(resolvedPairRate),
                sourceAmountAtSave: roundLedgerMoney(amountNumber),
                financialBasis: 'source',
                financialVersion: 2
            };
        }

        function getMovementNumber(row) {
            const explicit = Number(row?.movementNumber);
            if(Number.isFinite(explicit) && explicit > 0) return explicit;
            const parsed = parseInt(String(row?.ref || '').replace(/\D/g, ''), 10);
            return Number.isFinite(parsed) ? parsed : 0;
        }

        function getLastMovementNumber() {
            const stored = Number(db.settings?.lastMovementNumber) || 0;
            const ledgerMax = (db.ledger || []).reduce((max, row) => Math.max(max, getMovementNumber(row)), 0);
            return Math.max(stored, ledgerMax);
        }

        function generateRefNum() {
            return String(getLastMovementNumber() + 1).padStart(4, '0');
        }

        async function reserveMovementReference(existing) {
            if(existing) {
                const movementNumber = getMovementNumber(existing);
                return { ref: String(existing.ref || String(movementNumber).padStart(4, '0')), movementNumber };
            }

            let movementNumber = getLastMovementNumber() + 1;
            if(firebaseRootRef && firebaseConnected) {
                try {
                    const counterRef = firebaseRootRef.child('settings/lastMovementNumber');
                    const transaction = await counterRef.transaction(current => {
                        const remoteCurrent = Number(current) || 0;
                        const localCurrent = getLastMovementNumber();
                        return Math.max(remoteCurrent, localCurrent) + 1;
                    });
                    if(transaction.committed) movementNumber = Number(transaction.snapshot.val()) || movementNumber;
                } catch(error) {
                    console.error('Movement sequence transaction error:', error);
                }
            }

            db.settings.lastMovementNumber = Math.max(Number(db.settings.lastMovementNumber) || 0, movementNumber);
            return { ref: String(movementNumber).padStart(4, '0'), movementNumber };
        }

        let activeFilterType = 'all', customStartDate = '', customEndDate = '';

        // ================= INIT =================
        function applyBrandingAndSettings() {
            document.querySelectorAll('.pr-company-name').forEach(el => el.innerText = db.settings.companyName);
            document.getElementById('pr-comp-phone').innerText = db.settings.phone || '';
            document.getElementById('set-name').value = db.settings.companyName || '';
            document.getElementById('set-phone').value = db.settings.phone || '';
            document.getElementById('set-address').value = db.settings.address || '';
            document.getElementById('set-logo').value = db.settings.logo || '';

            const logoUrl = getEffectiveLogo();
            document.querySelectorAll('.logo-img').forEach(img => {
                img.dataset.fallbackApplied = '';
                img.src = logoUrl;
                img.classList.remove('hidden');
                img.setAttribute('referrerpolicy', 'no-referrer');
                img.onerror = function() {
                    if(!this.dataset.fallbackApplied) {
                        this.dataset.fallbackApplied = '1';
                        this.src = DEFAULT_LOGO_FILE;
                        this.classList.remove('hidden');
                    } else {
                        this.classList.add('hidden');
                    }
                };
            });
            document.querySelectorAll('.logo-img-placeholder').forEach(div => div.classList.add('hidden'));
        }

        function normalizeLedgerFinancials() {
            let changed = false;
            const fallbackUsdRate = getUsdRate();
            db.ledger = (db.ledger || []).map(row => {
                const amount = Number(row.amount) || 0;
                const sourceCurrency = String(row.currency || 'USD').toUpperCase();
                const equivalentCurrency = String(row.equivalentCurrency || 'ILS').toUpperCase();

                // في النسخ القديمة كان row.rate هو سعر العملة مقابل الشيكل.
                // في النسخة الجديدة row.rate هو سعر الزوج، لذلك نعتمد لقطة العملة الأساسية أولاً.
                const sourceRateAtSave = Number(row.currencyRateAtSave)
                    || (Number(row.financialVersion) >= 2 ? getCurrencyRate(sourceCurrency) : Number(row.rate))
                    || getCurrencyRate(sourceCurrency);
                const equivalentRateAtSave = Number(row.equivalentRateAtSave) || getCurrencyRate(equivalentCurrency);
                const usdRateAtSave = Number(row.usdRateAtSave) || fallbackUsdRate;

                let equivalentAmount = Number(row.equivalentAmount);
                if(!Number.isFinite(equivalentAmount)) {
                    const legacyTotalIls = Number(row.totalIls) || 0;
                    equivalentAmount = equivalentCurrency === 'ILS'
                        ? legacyTotalIls
                        : (equivalentRateAtSave > 0 ? legacyTotalIls / (equivalentRateAtSave / 100) : 0);
                    changed = true;
                }

                let pairRateAtSave = Number(row.pairRateAtSave);
                if(!Number.isFinite(pairRateAtSave) || pairRateAtSave <= 0) {
                    pairRateAtSave = amount > 0
                        ? (equivalentAmount / amount) * 100
                        : getDefaultPairRate(sourceCurrency, equivalentCurrency);
                    changed = true;
                }

                const sourceValueIls = amount * (sourceRateAtSave / 100);
                const sourceBasedUsd = usdRateAtSave > 0 ? sourceValueIls / (usdRateAtSave / 100) : 0;
                const storedUsd = Number(row.totalUsdSnapshot ?? row.totalUsd);
                const isSourceSnapshot = row.financialBasis === 'source' && Number(row.financialVersion) >= 2;
                const totalUsd = isSourceSnapshot && Number.isFinite(storedUsd) ? storedUsd : sourceBasedUsd;

                if(!isSourceSnapshot || row.pairRateAtSave === undefined || row.totalUsdSnapshot === undefined) changed = true;

                return {
                    ...row,
                    amount,
                    rate: Number(pairRateAtSave),
                    totalIls: roundLedgerMoney(sourceValueIls),
                    totalUsd: roundLedgerMoney(totalUsd),
                    totalUsdSnapshot: roundLedgerMoney(totalUsd),
                    usdRateAtSave: Number(usdRateAtSave),
                    currencyRateAtSave: Number(sourceRateAtSave),
                    equivalentCurrency,
                    equivalentAmount: roundLedgerMoney(equivalentAmount),
                    equivalentRateAtSave: Number(equivalentRateAtSave),
                    pairRateAtSave: Number(pairRateAtSave),
                    sourceAmountAtSave: Number(row.sourceAmountAtSave ?? amount) || 0,
                    financialBasis: 'source',
                    financialVersion: 2
                };
            });
            if(changed) {
                saveLocalOnly();
                if(firebaseRootRef && remoteInitialized && !snapshotMigrationInProgress) {
                    snapshotMigrationInProgress = true;
                    setTimeout(async () => {
                        try { await saveDB({ silent: true }); }
                        finally { snapshotMigrationInProgress = false; }
                    }, 0);
                }
            }
            return changed;
        }

        function recalculateFinancialViews() {
            normalizeLedgerFinancials();
            renderDashboard();
            renderReports();
        }

        function refreshSyncedViews() {
            applyBrandingAndSettings();
            populateCurrencies();
            recalculateFinancialViews();
            renderRatesEditor();
            renderClients();
        }

        function init() {
            refreshSyncedViews();
            const today = new Date().toISOString().split('T')[0];
            if(!document.getElementById('q-date').value) document.getElementById('q-date').value = today;
            if(!document.getElementById('chk-due').value) document.getElementById('chk-due').value = today;
            if(!document.getElementById('filter-start').value) document.getElementById('filter-start').value = today;
            if(!document.getElementById('filter-end').value) document.getElementById('filter-end').value = today;
            if(!editingQuickId) document.getElementById('q-ref').value = generateRefNum();
            if(!editingTransferId) document.getElementById('tr-ref').value = generateRefNum();
            if(!editingCheckId && document.getElementById('chk-ref')) document.getElementById('chk-ref').value = generateRefNum();
            triggerQSync(); triggerTrSync(); triggerChkSync();
        }

        function switchTab(tabId) {
            editingQuickId = null;
            editingTransferId = null;
            editingCheckId = null;
            document.querySelectorAll('.tab-content').forEach(el => el.classList.add('hidden'));
            document.getElementById(tabId).classList.remove('hidden');
            document.querySelectorAll('.sidebar-item').forEach(el => el.classList.remove('active'));
            document.getElementById('nav-' + tabId).classList.add('active');
            if(window.innerWidth < 768 && document.getElementById('sidebar').classList.contains('open')) toggleSidebar();
        }

        function toggleSidebar() {
            document.getElementById('sidebar').classList.toggle('open');
            document.getElementById('sidebar-overlay').classList.toggle('hidden');
        }

        function populateCurrencies() {
            const selects = document.querySelectorAll('.dynamic-currencies, .dynamic-equivalent-currencies');
            const selected = new Map(Array.from(selects).map(select => [select.id, select.value]));
            let optionsHtml = '';
            db.settings.currencies.forEach(currency => {
                optionsHtml += `<option value="${currency.code}" data-rate="${currency.rate}">${currency.code} - ${currency.name}</option>`;
            });
            selects.forEach(select => {
                select.innerHTML = optionsHtml;
                const previous = selected.get(select.id);
                const hasPrevious = previous && Array.from(select.options).some(option => option.value === previous);
                if(hasPrevious) {
                    select.value = previous;
                } else if(select.classList.contains('dynamic-equivalent-currencies')) {
                    const hasIls = Array.from(select.options).some(option => option.value === 'ILS');
                    if(hasIls) select.value = 'ILS';
                }
            });
            ['q', 'tr', 'chk'].forEach(updateEquivalentRateNote);
        }

        // ================= MODAL & FILTER LOGIC =================
        function openFilterModal() { document.getElementById('filter-modal').classList.remove('hidden', 'modal-active'); document.getElementById('filter-modal').classList.add('modal-active'); }
        function closeFilterModal() { document.getElementById('filter-modal').classList.remove('modal-active'); setTimeout(() => document.getElementById('filter-modal').classList.add('hidden'), 200); }
        function toggleCustomDates() { const type = document.querySelector('input[name="date-filter"]:checked').value; if(type === 'custom') document.getElementById('custom-date-fields').classList.remove('hidden'); else document.getElementById('custom-date-fields').classList.add('hidden'); }
        function applyFilter() { 
            activeFilterType = document.querySelector('input[name="date-filter"]:checked').value; 
            if(activeFilterType === 'custom') { 
                customStartDate = document.getElementById('filter-start').value; 
                customEndDate = document.getElementById('filter-end').value; 
                if(!customStartDate || !customEndDate) { showToast('يرجى تحديد تاريخ البداية والنهاية', 'error'); return; } 
            } 
            closeFilterModal(); 
            updateFilterLabel();
            renderReports(); 
            showToast('تم تطبيق التصفية'); 
        }
        function resetFilters() { 
            document.getElementById('rep-search').value = ''; 
            activeFilterType = 'all'; 
            document.querySelector('input[name="date-filter"][value="all"]').checked = true; 
            toggleCustomDates(); 
            updateFilterLabel();
            renderReports(); 
        }
        function updateFilterLabel() {
            const label = document.getElementById('active-filter-text');
            if(activeFilterType === 'all') {
                label.classList.add('hidden');
            } else {
                label.classList.remove('hidden');
                const textMap = { 'today': 'اليوم', 'week': 'آخر أسبوع', 'month': 'آخر شهر', 'year': 'آخر سنة' };
                if(activeFilterType === 'custom') {
                    label.innerHTML = `<i class="fas fa-calendar-check"></i> من ${customStartDate} إلى ${customEndDate}`;
                } else {
                    label.innerHTML = `<i class="fas fa-calendar-check"></i> ${textMap[activeFilterType]}`;
                }
            }
        }

        // ================= SYNC & CALCULATIONS =================
        function getConversionElements(prefix) {
            return {
                sourceCurrency: document.getElementById(`${prefix}-currency`),
                pairRate: document.getElementById(`${prefix}-rate`),
                rateLabel: document.getElementById(`${prefix}-rate-label`),
                sourceAmount: document.getElementById(`${prefix}-amount`),
                equivalentCurrency: document.getElementById(`${prefix}-equivalent-currency`),
                equivalentAmount: document.getElementById(`${prefix}-ils`),
                sync: document.getElementById(`${prefix}-sync`),
                note: document.getElementById(`${prefix}-equivalent-rate-note`)
            };
        }

        function getPairRateForElements(elements) {
            const entered = Number(elements.pairRate?.value);
            if(Number.isFinite(entered) && entered >= 0) return entered;
            return getDefaultPairRate(elements.sourceCurrency?.value, elements.equivalentCurrency?.value);
        }

        function updateEquivalentRateNote(prefix) {
            const elements = getConversionElements(prefix);
            const sourceCode = String(elements.sourceCurrency?.value || 'USD').toUpperCase();
            const targetCode = String(elements.equivalentCurrency?.value || 'ILS').toUpperCase();
            const pairRate = getPairRateForElements(elements);
            if(elements.rateLabel) elements.rateLabel.textContent = `سعر تصريف كل 100 ${sourceCode} مقابل ${targetCode}`;
            if(elements.note) elements.note.textContent = `كل 100 ${sourceCode} = ${Number(pairRate).toFixed(4)} ${targetCode}`;
        }

        function resetPairRateFromCurrencies(prefix) {
            const elements = getConversionElements(prefix);
            if(!elements.pairRate) return;
            const pairRate = getDefaultPairRate(elements.sourceCurrency?.value, elements.equivalentCurrency?.value);
            elements.pairRate.value = Number(pairRate).toFixed(4);
            updateEquivalentRateNote(prefix);
            if(!elements.sync || elements.sync.checked) syncSourceToEquivalent(prefix);
        }

        function syncSourceToEquivalent(prefix) {
            const elements = getConversionElements(prefix);
            if(!elements.sourceAmount || !elements.pairRate || !elements.equivalentAmount) return;
            const sourceAmount = Number(elements.sourceAmount.value) || 0;
            const pairRate = getPairRateForElements(elements);
            const equivalentAmount = sourceAmount * (pairRate / 100);
            elements.equivalentAmount.value = equivalentAmount.toFixed(2);
            updateEquivalentRateNote(prefix);
        }

        function syncEquivalentToPairRate(prefix) {
            const elements = getConversionElements(prefix);
            if(!elements.sourceAmount || !elements.pairRate || !elements.equivalentAmount) return;
            const sourceAmount = Number(elements.sourceAmount.value) || 0;
            const equivalentAmount = Number(elements.equivalentAmount.value) || 0;
            const pairRate = sourceAmount > 0 ? (equivalentAmount / sourceAmount) * 100 : 0;
            elements.pairRate.value = pairRate.toFixed(4);
            updateEquivalentRateNote(prefix);
        }

        function triggerSourceCurrency(prefix) {
            resetPairRateFromCurrencies(prefix);
        }

        function triggerEquivalentCurrency(prefix) {
            resetPairRateFromCurrencies(prefix);
        }

        function handleSourceAmount(prefix) {
            const elements = getConversionElements(prefix);
            if(!elements.sync || elements.sync.checked) syncSourceToEquivalent(prefix);
            else updateEquivalentRateNote(prefix);
        }

        function handleEquivalentAmount(prefix) {
            const elements = getConversionElements(prefix);
            // تعديل المبلغ المقابل لا يغير المبلغ الأساسي؛ يغيّر سعر الزوج فقط.
            if(!elements.sync || elements.sync.checked) syncEquivalentToPairRate(prefix);
            else updateEquivalentRateNote(prefix);
        }

        function triggerQSync() { triggerSourceCurrency('q'); }
        function handleQAmount() { handleSourceAmount('q'); }
        function handleQIls() { handleEquivalentAmount('q'); }
        function triggerQEquivalentSync() { triggerEquivalentCurrency('q'); }

        function triggerTrSync() { triggerSourceCurrency('tr'); }
        function handleTrAmount() { handleSourceAmount('tr'); }
        function handleTrIls() { handleEquivalentAmount('tr'); }
        function triggerTrEquivalentSync() { triggerEquivalentCurrency('tr'); }

        function triggerChkSync() { triggerSourceCurrency('chk'); }
        function handleChkAmount() { handleSourceAmount('chk'); }
        function handleChkIls() { handleEquivalentAmount('chk'); }
        function triggerChkEquivalentSync() { triggerEquivalentCurrency('chk'); }

        // ================= SAVE OPERATIONS =================
        function cancelQuickForm() {
            editingQuickId = null;
            document.getElementById('quick-form').reset();
            init();
        }

        function updateQuickFormColors() {
            const type = document.getElementById('q-type').value;
            const btn = document.getElementById('quick-save-button');
            if(btn) {
                if(type === 'in') { btn.classList.replace('bg-red-600', 'bg-green-600'); btn.classList.replace('hover:bg-red-700', 'hover:bg-green-700'); }
                else { btn.classList.replace('bg-green-600', 'bg-red-600'); btn.classList.replace('hover:bg-green-700', 'hover:bg-red-700'); }
            }
        }

        async function saveQuickOperation(isPrint) {
            return runSaveOnce('quick', 'quick-form', async () => {
                const form = document.getElementById('quick-form');
                if(!form.checkValidity()) { form.reportValidity(); return; }
                const amount = parseFloat(document.getElementById('q-amount').value) || 0;
                const equivalentAmount = parseFloat(document.getElementById('q-ils').value) || 0;
                const currency = document.getElementById('q-currency').value;
                const equivalentCurrency = document.getElementById('q-equivalent-currency').value || 'ILS';
                const enteredRate = parseFloat(document.getElementById('q-rate').value) || getDefaultPairRate(currency, equivalentCurrency);
                const equivalentRate = getCurrencyRate(equivalentCurrency);
                const financial = createFinancialSnapshot(currency, amount, equivalentCurrency, equivalentAmount, enteredRate, equivalentRate);
                const existingIndex = editingQuickId === null ? -1 : db.ledger.findIndex(x => x.id === editingQuickId && x.type === 'quick');
                const existing = existingIndex >= 0 ? db.ledger[existingIndex] : null;
                const movement = await reserveMovementReference(existing);
                const ref = movement.ref;
                if(existingIndex < 0 && db.ledger.some(row => row.type === 'quick' && String(row.ref) === String(ref))) {
                    showToast('هذه العملية محفوظة مسبقاً ولن يتم تكرارها', 'error');
                    return;
                }
                const selectedDate = document.getElementById('q-date').value;
                const existingTime = existing?.date?.includes('T') ? existing.date.split('T')[1] : new Date().toTimeString().split(' ')[0];
                const entry = {
                    ...(existing || {}),
                    id: existing?.id ?? Date.now(),
                    ref,
                    movementNumber: movement.movementNumber,
                    date: selectedDate + 'T' + existingTime,
                    type: 'quick',
                    subType: document.getElementById('q-type').value,
                    client: document.getElementById('q-client').value,
                    amount,
                    currency,
                    rate: enteredRate,
                    ...financial,
                    notes: document.getElementById('q-notes').value,
                    savedAt: existing?.savedAt || new Date().toISOString(),
                    updatedAtLocal: new Date().toISOString()
                };
                if(existingIndex >= 0) db.ledger[existingIndex] = entry; else db.ledger.push(entry);
                const synced = await saveDB();
                if(synced) showToast(existing ? 'تم تعديل العملية ومزامنتها' : 'تم حفظ العملية ومزامنتها');
                if(isPrint) await triggerPrint(entry.id);
                editingQuickId = null;
                form.reset();
                init();
            });
        }

        async function saveTransfer(isPrint) {
            return runSaveOnce('transfer', 'transfer-form', async () => {
                const form = document.getElementById('transfer-form');
                if(!form.checkValidity()) { form.reportValidity(); return; }
                const amount = parseFloat(document.getElementById('tr-amount').value) || 0;
                const equivalentAmount = parseFloat(document.getElementById('tr-ils').value) || 0;
                const currency = document.getElementById('tr-currency').value;
                const equivalentCurrency = document.getElementById('tr-equivalent-currency').value || 'ILS';
                const enteredRate = parseFloat(document.getElementById('tr-rate').value) || getDefaultPairRate(currency, equivalentCurrency);
                const equivalentRate = getCurrencyRate(equivalentCurrency);
                const financial = createFinancialSnapshot(currency, amount, equivalentCurrency, equivalentAmount, enteredRate, equivalentRate);
                const existingIndex = editingTransferId === null ? -1 : db.ledger.findIndex(x => x.id === editingTransferId && x.type === 'transfer');
                const existing = existingIndex >= 0 ? db.ledger[existingIndex] : null;
                const movement = await reserveMovementReference(existing);
                const ref = movement.ref;
                if(existingIndex < 0 && db.ledger.some(row => row.type === 'transfer' && String(row.ref) === String(ref))) {
                    showToast('هذه الحوالة محفوظة مسبقاً ولن يتم تكرارها', 'error');
                    return;
                }
                const entry = {
                    ...(existing || {}),
                    id: existing?.id ?? Date.now(),
                    ref,
                    movementNumber: movement.movementNumber,
                    date: existing?.date || new Date().toISOString(),
                    type: 'transfer',
                    subType: document.getElementById('tr-type').value,
                    client: document.getElementById('tr-sender-name').value + ' لـ ' + document.getElementById('tr-receiver-name').value,
                    amount,
                    currency,
                    rate: enteredRate,
                    ...financial,
                    senderName: document.getElementById('tr-sender-name').value,
                    senderPhone: document.getElementById('tr-sender-phone').value,
                    senderId: document.getElementById('tr-sender-id').value,
                    receiverName: document.getElementById('tr-receiver-name').value,
                    receiverPhone: document.getElementById('tr-receiver-phone').value,
                    receiverCountry: document.getElementById('tr-receiver-country').value,
                    agent: document.getElementById('tr-agent').value,
                    savedAt: existing?.savedAt || new Date().toISOString(),
                    updatedAtLocal: new Date().toISOString()
                };
                if(existingIndex >= 0) db.ledger[existingIndex] = entry; else db.ledger.push(entry);
                const synced = await saveDB();
                if(synced) showToast(existing ? 'تم تعديل الحوالة ومزامنتها' : 'تم حفظ الحوالة ومزامنتها');
                if(isPrint) await triggerPrint(entry.id);
                editingTransferId = null;
                form.reset();
                init();
            });
        }

        async function saveCheck(isPrint) {
            return runSaveOnce('check', 'check-form', async () => {
                const form = document.getElementById('check-form');
                if(!form.checkValidity()) { form.reportValidity(); return; }
                const amount = parseFloat(document.getElementById('chk-amount').value) || 0;
                const equivalentAmount = parseFloat(document.getElementById('chk-ils').value) || 0;
                const currency = document.getElementById('chk-currency').value;
                const equivalentCurrency = document.getElementById('chk-equivalent-currency').value || 'ILS';
                const enteredRate = parseFloat(document.getElementById('chk-rate').value) || getDefaultPairRate(currency, equivalentCurrency);
                const equivalentRate = getCurrencyRate(equivalentCurrency);
                const financial = createFinancialSnapshot(currency, amount, equivalentCurrency, equivalentAmount, enteredRate, equivalentRate);
                const existingIndex = editingCheckId === null ? -1 : db.ledger.findIndex(x => x.id === editingCheckId && x.type === 'check');
                const existing = existingIndex >= 0 ? db.ledger[existingIndex] : null;
                const movement = await reserveMovementReference(existing);
                const ref = movement.ref;
                const checkNo = document.getElementById('chk-no').value.trim();
                if(existingIndex < 0 && checkNo && db.ledger.some(row => row.type === 'check' && String(row.checkNo || '') === checkNo)) {
                    showToast('رقم الشيك محفوظ مسبقاً ولن يتم تكراره', 'error');
                    return;
                }
                const entry = {
                    ...(existing || {}),
                    id: existing?.id ?? Date.now(),
                    ref,
                    movementNumber: movement.movementNumber,
                    checkNo,
                    date: existing?.date || new Date().toISOString(),
                    type: 'check',
                    subType: document.getElementById('chk-type').value,
                    client: document.getElementById('chk-client').value,
                    amount,
                    currency,
                    rate: enteredRate,
                    ...financial,
                    bank: document.getElementById('chk-bank').value,
                    due: document.getElementById('chk-due').value,
                    notes: document.getElementById('chk-notes').value,
                    savedAt: existing?.savedAt || new Date().toISOString(),
                    updatedAtLocal: new Date().toISOString()
                };
                if(existingIndex >= 0) db.ledger[existingIndex] = entry; else db.ledger.push(entry);
                const synced = await saveDB();
                if(synced) showToast(existing ? 'تم تعديل الشيك ومزامنته' : 'تم حفظ الشيك ومزامنته');
                if(isPrint) await triggerPrint(entry.id);
                editingCheckId = null;
                form.reset();
                init();
            });
        }

        async function addClient() {
            const name = document.getElementById('cl-name').value.trim();
            const phone = document.getElementById('cl-phone').value.trim();
            const idNum = document.getElementById('cl-id').value.trim();
            if(!name) { showToast('يرجى إدخال اسم العميل', 'error'); return; }
            db.clients = db.clients || [];
            db.clients.push({ id: Date.now(), name, phone, idNum, date: new Date().toLocaleDateString('en-GB') });
            const synced = await saveDB();
            renderClients();
            document.getElementById('cl-name').value = '';
            document.getElementById('cl-phone').value = '';
            document.getElementById('cl-id').value = '';
            if(synced) showToast('تمت إضافة العميل ومزامنته');
        }

        async function editClient(id) {
            const client = db.clients.find(c => c.id === id); if(!client) return;
            const name = prompt('اسم العميل:', client.name || ''); if(name === null) return;
            const phone = prompt('رقم الهاتف:', client.phone || ''); if(phone === null) return;
            const idNum = prompt('رقم الهوية / الجواز:', client.idNum || ''); if(idNum === null) return;
            client.name = name.trim() || client.name;
            client.phone = phone.trim();
            client.idNum = idNum.trim();
            const synced = await saveDB();
            renderClients();
            if(synced) showToast('تم تعديل العميل ومزامنته');
        }

        async function deleteClient(id) {
            const client = db.clients.find(c => c.id === id); if(!client) return;
            if(!confirm(`حذف العميل "${client.name}"؟`)) return;
            db.clients = db.clients.filter(c => c.id !== id);
            const synced = await saveDB();
            renderClients();
            if(synced) showToast('تم حذف العميل ومزامنة الحذف');
        }

        function renderClients() {
            const tbody = document.getElementById('clients-list'); tbody.innerHTML = '';
            (db.clients || []).forEach(c => {
                tbody.innerHTML += `<tr class="border-b hover:bg-slate-50"><td class="p-3 font-bold text-indigo-900">${c.name}</td><td class="p-3" dir="ltr">${c.phone || '-'}</td><td class="p-3">${c.idNum || '-'}</td><td class="p-3 text-slate-500 text-xs"><div>${c.date || '-'}</div><div class="mt-2 flex justify-center gap-3"><button onclick="editClient(${c.id})" class="text-blue-600 hover:text-blue-800" title="تعديل"><i class="fas fa-edit"></i></button><button onclick="deleteClient(${c.id})" class="text-red-600 hover:text-red-800" title="حذف"><i class="fas fa-trash"></i></button></div></td></tr>`;
            });
        }

        function getUsdValueSafe(t) {
            const value = Number(t.totalUsdSnapshot ?? t.totalUsd);
            return Number.isFinite(value) ? value : 0;
        }

        function getEquivalentSnapshot(entry) {
            const currency = String(entry?.equivalentCurrency || 'ILS').toUpperCase();
            const rate = Number(entry?.equivalentRateAtSave) || getCurrencyRate(currency);
            let amount = Number(entry?.equivalentAmount);
            if(!Number.isFinite(amount)) {
                const totalIls = Number(entry?.totalIls) || 0;
                amount = currency === 'ILS' ? totalIls : (rate > 0 ? totalIls / (rate / 100) : 0);
            }
            return { currency, amount: roundLedgerMoney(amount), rate };
        }

        function formatEquivalentSnapshot(entry) {
            const snapshot = getEquivalentSnapshot(entry);
            return `${snapshot.amount.toFixed(2)} ${snapshot.currency}`;
        }

        function formatMarketRate(value) {
            const number = Number(value);
            if(!Number.isFinite(number) || number <= 0) return '--';
            if(number >= 100) return number.toFixed(2);
            if(number >= 1) return number.toFixed(4);
            return number.toFixed(6);
        }

        function readMarketRatesCache() {
            try {
                const cached = JSON.parse(localStorage.getItem(MARKET_RATES_CACHE_KEY) || 'null');
                if(!cached || typeof cached !== 'object') return;
                globalMarketRates = cached.rates && typeof cached.rates === 'object' ? cached.rates : {};
                globalMarketRatesUpdatedAt = Number(cached.updatedAt) || 0;
            } catch(error) {
                console.error('Market rates cache read error:', error);
            }
        }

        function saveMarketRatesCache() {
            try {
                localStorage.setItem(MARKET_RATES_CACHE_KEY, JSON.stringify({
                    rates: globalMarketRates,
                    updatedAt: globalMarketRatesUpdatedAt
                }));
            } catch(error) {
                console.error('Market rates cache save error:', error);
            }
        }

        async function fetchJsonWithTimeout(url, timeout = 12000) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), timeout);
            try {
                const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
                if(!response.ok) throw new Error(`HTTP ${response.status}`);
                return await response.json();
            } finally {
                clearTimeout(timer);
            }
        }

        async function refreshGlobalMarketRates(force = false) {
            if(globalMarketRatesLoading) return;
            const cacheIsFresh = globalMarketRatesUpdatedAt && (Date.now() - globalMarketRatesUpdatedAt < MARKET_RATES_MAX_AGE);
            if(cacheIsFresh && !force) {
                renderDashboard();
                return;
            }

            globalMarketRatesLoading = true;
            renderDashboard();
            try {
                const fiat = await fetchJsonWithTimeout('https://open.er-api.com/v6/latest/USD');
                if(fiat?.result !== 'success' || !fiat?.rates?.ILS) throw new Error('Invalid market-rate response');

                const usdToIls = Number(fiat.rates.ILS);
                const nextRates = {};
                (db.settings.currencies || []).forEach(currency => {
                    const code = String(currency.code || '').toUpperCase();
                    const usdToCurrency = Number(fiat.rates[code]);
                    if(code === 'ILS') nextRates.ILS = 100;
                    else if(Number.isFinite(usdToCurrency) && usdToCurrency > 0) {
                        nextRates[code] = 100 * usdToIls / usdToCurrency;
                    }
                });

                try {
                    const usdt = await fetchJsonWithTimeout('https://api.coinbase.com/v2/prices/USDT-USD/spot');
                    const usdtUsd = Number(usdt?.data?.amount);
                    if(Number.isFinite(usdtUsd) && usdtUsd > 0) nextRates.USDT = 100 * usdtUsd * usdToIls;
                } catch(error) {
                    console.warn('USDT global rate unavailable:', error);
                }

                globalMarketRates = nextRates;
                globalMarketRatesUpdatedAt = Date.now();
                saveMarketRatesCache();
            } catch(error) {
                console.error('Global market rates error:', error);
            } finally {
                globalMarketRatesLoading = false;
                renderDashboard();
            }
        }

        function renderDashboard() {
            const today = new Date().toISOString().split('T')[0];
            let count = 0, inUsd = 0, outUsd = 0, balanceUsd = 0;
            const ratesContainer = document.getElementById('dash-rates'); ratesContainer.innerHTML = '';
            db.settings.currencies.forEach(c => {
                if(c.code === 'ILS') return;
                const marketValue = formatMarketRate(globalMarketRates[String(c.code || '').toUpperCase()]);
                ratesContainer.innerHTML += `<div class="flex justify-between items-center border-b pb-2 gap-3"><span class="font-bold text-slate-700">100 ${c.name}</span><span class="text-left shrink-0" dir="ltr"><span class="block text-blue-600 font-bold">${c.rate} ₪</span><span class="block text-red-600 text-xs font-bold mt-1">${marketValue}${marketValue === '--' ? '' : ' ₪'}</span></span></div>`;
            });
            ratesContainer.innerHTML += `<div class="pt-1 text-[10px] text-slate-400 text-center"><a href="https://www.exchangerate-api.com" target="_blank" rel="noopener noreferrer">Rates By Exchange Rate API</a></div>`;

            db.ledger.forEach(t => {
                const valUsd = getUsdValueSafe(t);
                if(t.subType === 'in') balanceUsd += valUsd;
                if(t.subType === 'out') balanceUsd -= valUsd;
                if(t.date.startsWith(today)) { count++; if(t.subType === 'in') inUsd += valUsd; if(t.subType === 'out') outUsd += valUsd; }
            });

            document.getElementById('stat-count').innerText = count; document.getElementById('stat-in').innerText = inUsd.toFixed(2); document.getElementById('stat-out').innerText = outUsd.toFixed(2);
            const balEl = document.getElementById('stat-balance'); balEl.innerText = balanceUsd.toFixed(2); balEl.className = `text-xl font-black ${balanceUsd < 0 ? 'text-red-600' : 'text-yellow-600'}`;
        }

        // ================= RENDER REPORTS (WITH FILTERING) =================
        function passesActiveDateFilter(date) {
            if(activeFilterType === 'today') {
                const start = new Date(); start.setHours(0,0,0,0);
                return date >= start;
            }
            if(activeFilterType === 'week') {
                const start = new Date(); start.setDate(start.getDate() - 7); start.setHours(0,0,0,0);
                return date >= start;
            }
            if(activeFilterType === 'month') {
                const start = new Date(); start.setMonth(start.getMonth() - 1); start.setHours(0,0,0,0);
                return date >= start;
            }
            if(activeFilterType === 'year') {
                const start = new Date(); start.setFullYear(start.getFullYear() - 1); start.setHours(0,0,0,0);
                return date >= start;
            }
            if(activeFilterType === 'custom') {
                const start = new Date(customStartDate); start.setHours(0,0,0,0);
                const end = new Date(customEndDate); end.setHours(23,59,59,999);
                return date >= start && date <= end;
            }
            return true;
        }

        function calculateLedgerTotals(entries) {
            const totals = (entries || []).reduce((acc, entry) => {
                const valueUsd = getUsdValueSafe(entry);
                if(entry.subType === 'in') acc.incoming += valueUsd;
                if(entry.subType === 'out') acc.outgoing += valueUsd;
                return acc;
            }, { incoming: 0, outgoing: 0 });
            totals.difference = totals.incoming - totals.outgoing;
            return totals;
        }

        function getVisibleReportData() {
            const filterStr = String(document.getElementById('rep-search')?.value || '').trim().toLowerCase();
            let runningBalance = 0;
            const chronological = [...db.ledger].sort((a, b) => {
                const byDate = new Date(a.date || 0) - new Date(b.date || 0);
                return byDate || (Number(a.id) || 0) - (Number(b.id) || 0);
            });

            const rows = [];
            chronological.forEach(entry => {
                const date = new Date(entry.date);
                const valueUsd = getUsdValueSafe(entry);
                const incoming = entry.subType === 'in' ? valueUsd : 0;
                const outgoing = entry.subType === 'out' ? valueUsd : 0;
                runningBalance += incoming - outgoing;

                if(!passesActiveDateFilter(date)) return;
                const searchable = `${entry.client || ''} ${entry.senderName || ''} ${entry.receiverName || ''} ${entry.ref || ''} ${entry.notes || ''} ${entry.currency || ''} ${entry.equivalentCurrency || ''}`.toLowerCase();
                if(filterStr && !searchable.includes(filterStr)) return;

                rows.push({ entry, date, incoming, outgoing, balance: runningBalance });
            });

            rows.reverse();
            const totals = rows.reduce((acc, row) => {
                acc.incoming += row.incoming;
                acc.outgoing += row.outgoing;
                return acc;
            }, { incoming: 0, outgoing: 0 });
            totals.difference = totals.incoming - totals.outgoing;

            const allTotals = calculateLedgerTotals(db.ledger);
            return { rows, totals, allTotals };
        }

        function formatSignedAmount(value) {
            return value < 0 ? `${Math.abs(value).toFixed(2)}-` : value.toFixed(2);
        }

        function getLedgerDisplayName(entry) {
            if(entry?.type === 'transfer') return entry.receiverName || entry.client || '-';
            return entry?.client || '-';
        }

        function renderReports() {
            const tbody = document.getElementById('reports-body');
            tbody.innerHTML = '';
            const { rows, totals, allTotals } = getVisibleReportData();

            rows.forEach(({ entry: t, date: d, incoming: inAmt, outgoing: outAmt, balance }) => {
                const balanceClass = balance < 0 ? 'text-red-600' : 'text-slate-800';
                tbody.innerHTML += `
                    <tr>
                        <td class="text-xs text-slate-500">${d.toLocaleDateString('en-GB')}<br><span class="text-[10px]">${d.toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'})}</span></td>
                        <td class="text-right leading-tight">
                            <span class="font-bold text-slate-800 block">${getLedgerDisplayName(t)}</span>
                            <span class="text-[10px] text-slate-500 bg-slate-200 px-1 rounded inline-block mt-1">م: ${t.ref || '-'} | ${t.amount || 0} ${t.currency || ''}</span>
                            ${t.notes ? `<div class="text-xs text-blue-600 mt-1"><i class="fas fa-comment-alt"></i> ${t.notes}</div>` : ''}
                        </td>
                        <td class="text-green-600 font-black">
                            <div>${inAmt > 0 ? inAmt.toFixed(2) : '0'}</div>
                            ${inAmt > 0 ? `<div class="ledger-ils-subvalue">${formatEquivalentSnapshot(t)}</div>` : ''}
                        </td>
                        <td class="text-red-600 font-black">
                            <div>${outAmt > 0 ? outAmt.toFixed(2) : '0'}</div>
                            ${outAmt > 0 ? `<div class="ledger-ils-subvalue">${formatEquivalentSnapshot(t)}</div>` : ''}
                        </td>
                        <td class="font-black ${balanceClass}" dir="ltr">${formatSignedAmount(balance)}</td>
                        <td class="no-print">
                            <div class="flex justify-center items-center gap-2 bg-slate-50 p-1 rounded border">
                                <select id="lang-${t.id}" class="text-xs font-bold border-0 bg-transparent text-slate-700 outline-none cursor-pointer">
                                    <option value="ar">عربي</option>
                                    <option value="en">EN</option>
                                </select>
                                <div class="w-px h-6 bg-slate-300"></div>
                                <button onclick="printLedgerReceipt(${t.id})" class="text-green-700 hover:text-green-900 transition px-1" title="طباعة الوصل"><i class="fas fa-print fa-lg"></i></button>
                                <button onclick="downloadReceipt(${t.id}, 'pdf')" class="text-red-600 hover:text-red-800 transition px-1" title="تنزيل PDF"><i class="fas fa-file-pdf fa-lg"></i></button>
                                <button onclick="downloadReceipt(${t.id}, 'img')" class="text-blue-600 hover:text-blue-800 transition px-1" title="تنزيل صورة"><i class="fas fa-image fa-lg"></i></button>
                                <button onclick="editLedgerEntry(${t.id})" class="text-amber-600 hover:text-amber-800 transition px-1" title="تعديل العملية"><i class="fas fa-edit"></i></button>
                                <button onclick="deleteLedgerEntry(${t.id})" class="text-slate-600 hover:text-red-700 transition px-1" title="حذف العملية"><i class="fas fa-trash"></i></button>
                            </div>
                        </td>
                    </tr>
                `;
            });

            const periodInEl = document.getElementById('period-tot-in');
            const periodOutEl = document.getElementById('period-tot-out');
            const periodDiffEl = document.getElementById('period-tot-diff');
            if(periodInEl) periodInEl.innerText = totals.incoming.toFixed(2);
            if(periodOutEl) periodOutEl.innerText = totals.outgoing.toFixed(2);
            if(periodDiffEl) periodDiffEl.innerText = formatSignedAmount(totals.difference);
            document.getElementById('all-tot-in').innerText = allTotals.incoming.toFixed(2);
            document.getElementById('all-tot-out').innerText = allTotals.outgoing.toFixed(2);
            document.getElementById('all-tot-diff').innerText = formatSignedAmount(allTotals.difference);
        }

        async function deleteLedgerEntry(id) {
            const entry = db.ledger.find(x => x.id === id); if(!entry) return;
            if(!confirm(`حذف العملية رقم ${entry.ref} نهائياً؟`)) return;
            db.ledger = db.ledger.filter(x => x.id !== id);
            const synced = await saveDB();
            refreshSyncedViews();
            if(synced) showToast('تم حذف العملية ومزامنة الحذف');
        }

        function editLedgerEntry(id) {
            const entry = db.ledger.find(x => x.id === id); if(!entry) return;
            const equivalentSnapshot = getEquivalentSnapshot(entry);
            const derivedRate = Number(entry.pairRateAtSave ?? entry.rate)
                || (Number(entry.amount) > 0 ? (equivalentSnapshot.amount / Number(entry.amount)) * 100 : getDefaultPairRate(entry.currency || 'USD', equivalentSnapshot.currency));
            if(entry.type === 'transfer') {
                switchTab('transfers');
                editingTransferId = id;
                document.getElementById('tr-type').value = entry.subType || 'out';
                document.getElementById('tr-agent').value = entry.agent || '';
                document.getElementById('tr-ref').value = entry.ref || '';
                document.getElementById('tr-sender-name').value = entry.senderName || '';
                document.getElementById('tr-sender-phone').value = entry.senderPhone || '';
                document.getElementById('tr-sender-id').value = entry.senderId || '';
                document.getElementById('tr-receiver-name').value = entry.receiverName || '';
                document.getElementById('tr-receiver-phone').value = entry.receiverPhone || '';
                document.getElementById('tr-receiver-country').value = entry.receiverCountry || '';
                document.getElementById('tr-currency').value = entry.currency || 'USD';
                document.getElementById('tr-rate').value = Number(derivedRate).toFixed(4);
                document.getElementById('tr-amount').value = entry.amount || 0;
                document.getElementById('tr-equivalent-currency').value = equivalentSnapshot.currency;
                document.getElementById('tr-ils').value = equivalentSnapshot.amount.toFixed(2);
                document.getElementById('tr-sync').checked = false;
                updateEquivalentRateNote('tr');
                showToast('عدّل بيانات الحوالة ثم اضغط حفظ');
                return;
            }
            if(entry.type === 'check') {
                switchTab('checks');
                editingCheckId = id;
                document.getElementById('chk-type').value = entry.subType || 'out';
                if(document.getElementById('chk-ref')) document.getElementById('chk-ref').value = entry.ref || '';
                document.getElementById('chk-no').value = entry.checkNo || '';
                document.getElementById('chk-client').value = entry.client || '';
                document.getElementById('chk-bank').value = entry.bank || '';
                document.getElementById('chk-due').value = entry.due || new Date().toISOString().split('T')[0];
                document.getElementById('chk-currency').value = entry.currency || 'USD';
                document.getElementById('chk-rate').value = Number(derivedRate).toFixed(4);
                document.getElementById('chk-amount').value = entry.amount || 0;
                document.getElementById('chk-equivalent-currency').value = equivalentSnapshot.currency;
                document.getElementById('chk-ils').value = equivalentSnapshot.amount.toFixed(2);
                document.getElementById('chk-notes').value = entry.notes || '';
                document.getElementById('chk-sync').checked = false;
                updateEquivalentRateNote('chk');
                showToast('عدّل بيانات الشيك ثم اضغط حفظ');
                return;
            }
            switchTab('dashboard');
            editingQuickId = id;
            document.getElementById('q-ref').value = entry.ref || '';
            document.getElementById('q-date').value = String(entry.date || '').split('T')[0] || new Date().toISOString().split('T')[0];
            document.getElementById('q-client').value = entry.client || '';
            document.getElementById('q-type').value = entry.subType || 'in';
            document.getElementById('q-currency').value = entry.currency || 'USD';
            document.getElementById('q-rate').value = Number(derivedRate).toFixed(4);
            document.getElementById('q-amount').value = entry.amount || 0;
            document.getElementById('q-equivalent-currency').value = equivalentSnapshot.currency;
            document.getElementById('q-ils').value = equivalentSnapshot.amount.toFixed(2);
            document.getElementById('q-notes').value = entry.notes || '';
            document.getElementById('q-sync').checked = false;
            updateEquivalentRateNote('q');
            updateQuickFormColors();
            showToast('عدّل بيانات العملية ثم اضغط حفظ العملية');
        }

        // ================= EXCEL EXPORT =================
        function reportPeriodLabel() {
            const label = document.getElementById('active-filter-text')?.innerText?.trim();
            return label || 'كل الأوقات';
        }

        function reportDetailsText(entry) {
            const parts = [
                entry.client || '-',
                `المرجع: ${entry.ref || '-'}`,
                `المبلغ: ${entry.amount || 0} ${entry.currency || ''}`,
                `المكافئ: ${formatEquivalentSnapshot(entry)}`
            ];
            if(entry.notes) parts.push(`ملاحظات: ${entry.notes}`);
            return parts.join(' | ');
        }

        function escapeReportHtml(value) {
            return String(value ?? '').replace(/[&<>"']/g, char => ({
                '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;'
            })[char]);
        }

        function reportDetailsHtml(entry) {
            const client = escapeReportHtml(entry.client || '-');
            const ref = escapeReportHtml(entry.ref || '-');
            const amount = escapeReportHtml(entry.amount || 0);
            const currency = escapeReportHtml(entry.currency || '');
            const equivalent = escapeReportHtml(formatEquivalentSnapshot(entry));
            const notes = entry.notes ? `<div style="margin-top:3px;color:#475569;font-size:11px;">ملاحظات: ${escapeReportHtml(entry.notes)}</div>` : '';
            return `<div style="font-weight:800;margin-bottom:3px;">${client}</div><div style="font-size:11px;color:#475569;">المرجع: ${ref} &nbsp;|&nbsp; المبلغ: ${amount} ${currency} &nbsp;|&nbsp; المكافئ: ${equivalent}</div>${notes}`;
        }

        function exportReportsExcel() {
            showToast('جاري تصدير كل عمليات الفترة الظاهرة لإكسل...', 'success');
            const { rows, totals, allTotals } = getVisibleReportData();
            const wsData = [
                ['البيان', 'الوارد', 'الصادر', 'الصافي', ''],
                ['الفترة', totals.incoming, totals.outgoing, totals.difference, ''],
                ['كل الفترات', allTotals.incoming, allTotals.outgoing, allTotals.difference, ''],
                [`الفترة المحددة: ${reportPeriodLabel()}`, `عدد العمليات: ${rows.length}`, '', '', ''],
                [],
                ['التاريخ', 'التفاصيل', 'وارد (دولار)', 'منصرف (دولار)', 'الرصيد التراكمي']
            ];

            rows.forEach(({ entry, date, incoming, outgoing, balance }) => {
                wsData.push([
                    `${date.toLocaleDateString('en-GB')} ${date.toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'})}`,
                    reportDetailsText(entry),
                    Number(incoming.toFixed(2)),
                    Number(outgoing.toFixed(2)),
                    Number(balance.toFixed(2))
                ]);
            });

            const ws = XLSX.utils.aoa_to_sheet(wsData);
            ws['!dir'] = 'rtl';
            ws['!cols'] = [{wch: 15}, {wch: 50}, {wch: 17}, {wch: 18}, {wch: 27}];
            ws['!merges'] = [
                {s:{r:0,c:3}, e:{r:0,c:4}},
                {s:{r:1,c:3}, e:{r:1,c:4}},
                {s:{r:2,c:3}, e:{r:2,c:4}}
            ];
            ws['!autofilter'] = { ref: `A6:E${Math.max(6, wsData.length)}` };
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'كشف الحساب');
            XLSX.writeFile(wb, `CashTop_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
        }

        // ================= PDF EXPORT (ALL VISIBLE PERIOD ROWS) =================
        async function exportReportsPDF() {
            showToast('جاري تجهيز كل عمليات الفترة الظاهرة في PDF...', 'success');
            const { rows, totals, allTotals } = getVisibleReportData();
            const container = document.createElement('div');
            container.className = 'print-container p-6';
            container.dir = 'rtl';
            container.style.fontFamily = "'Cairo', sans-serif";
            container.style.background = '#ffffff';
            container.style.width = '1120px';

            const tableRows = rows.map(({ entry, date, incoming, outgoing, balance }) => `
                <tr style="page-break-inside:avoid; break-inside:avoid;">
                    <td>${date.toLocaleDateString('en-GB')}<br><small>${date.toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'})}</small></td>
                    <td style="text-align:right;">${reportDetailsText(entry)}</td>
                    <td style="color:#15803d;font-weight:800;">${incoming > 0 ? `<div>${incoming.toFixed(2)}</div><div style="font-size:9px;color:#64748b;margin-top:2px;">${formatEquivalentSnapshot(entry)}</div>` : '0'}</td>
                    <td style="color:#dc2626;font-weight:800;">${outgoing > 0 ? `<div>${outgoing.toFixed(2)}</div><div style="font-size:9px;color:#64748b;margin-top:2px;">${formatEquivalentSnapshot(entry)}</div>` : '0'}</td>
                    <td dir="ltr" style="font-weight:800;">${formatSignedAmount(balance)}</td>
                </tr>
            `).join('');

            container.innerHTML = `
                <div style="text-align:center;border-bottom:4px solid #0f172a;padding-bottom:14px;margin-bottom:16px;">
                    <h1 style="font-size:28px;font-weight:900;margin:0;color:#0f172a;">${db.settings.companyName}</h1>
                    <h2 style="font-size:18px;font-weight:700;margin:8px 0;color:#475569;">كشف حساب الصندوق العام (بالدولار الأمريكي)</h2>
                    <div style="display:flex;justify-content:space-between;gap:12px;margin-top:12px;font-size:13px;font-weight:700;background:#f1f5f9;padding:10px;border-radius:8px;">
                        <span>تاريخ الطباعة: ${new Date().toLocaleString('ar-EG')}</span>
                        <span>الفترة: ${reportPeriodLabel()}</span>
                        <span>عدد العمليات: ${rows.length}</span>
                    </div>
                </div>

                <table style="width:100%;border-collapse:collapse;font-size:12px;margin-bottom:14px;table-layout:fixed;">
                    <colgroup>
                        <col style="width:12%;">
                        <col style="width:18%;">
                        <col style="width:18%;">
                        <col style="width:52%;">
                    </colgroup>
                    <thead>
                        <tr>
                            <th>البيان</th>
                            <th>الوارد</th>
                            <th>الصادر</th>
                            <th>الصافي</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td style="font-weight:800;">الفترة</td>
                            <td dir="ltr">${totals.incoming.toFixed(2)}</td>
                            <td dir="ltr">${totals.outgoing.toFixed(2)}</td>
                            <td dir="ltr" style="font-size:15px;font-weight:900;white-space:nowrap;">${formatSignedAmount(totals.difference)}</td>
                        </tr>
                        <tr>
                            <td style="font-weight:800;">كل الفترات</td>
                            <td dir="ltr">${allTotals.incoming.toFixed(2)}</td>
                            <td dir="ltr">${allTotals.outgoing.toFixed(2)}</td>
                            <td dir="ltr" style="font-size:15px;font-weight:900;white-space:nowrap;">${formatSignedAmount(allTotals.difference)}</td>
                        </tr>
                    </tbody>
                </table>

                <table style="width:100%;border-collapse:collapse;font-size:12px;">
                    <thead style="display:table-header-group;">
                        <tr>
                            <th style="width:16%;">التاريخ</th>
                            <th>التفاصيل</th>
                            <th style="width:14%;">وارد (دولار)</th>
                            <th style="width:14%;">منصرف (دولار)</th>
                            <th style="width:14%;">الرصيد</th>
                        </tr>
                    </thead>
                    <tbody>${tableRows || '<tr><td colspan="5" style="padding:30px;text-align:center;">لا توجد عمليات ضمن الفترة الظاهرة</td></tr>'}</tbody>
                </table>
            `;

            container.querySelectorAll('th, td').forEach(cell => {
                cell.style.border = '1px solid #cbd5e1';
                cell.style.padding = '9px';
                cell.style.textAlign = cell.style.textAlign || 'center';
            });
            container.querySelectorAll('th').forEach(th => {
                th.style.backgroundColor = '#e2e8f0';
                th.style.color = '#0f172a';
                th.style.fontWeight = '900';
            });

            const wrapper = document.getElementById('print-wrapper');
            const oldHtml = wrapper.innerHTML;
            wrapper.innerHTML = '';
            wrapper.appendChild(container);
            wrapper.className = 'offscreen-render';

            const options = {
                margin: [0.35, 0.3, 0.35, 0.3],
                filename: `CashTop_Report_${Date.now()}.pdf`,
                image: { type: 'jpeg', quality: 1 },
                html2canvas: { scale: 2, useCORS: true, allowTaint: false, backgroundColor: '#ffffff', logging: false },
                jsPDF: { unit: 'in', format: 'a4', orientation: 'landscape' },
                pagebreak: { mode: ['css', 'legacy'], before: '.page-break-before', avoid: 'tr' }
            };

            try {
                await html2pdf().set(options).from(container).save();
                showToast('تم تحميل كل عمليات الفترة الظاهرة في PDF');
            } catch(error) {
                console.error('Report PDF export error:', error);
                showToast('تعذر تجهيز تقرير PDF', 'error');
            } finally {
                wrapper.className = 'hidden';
                wrapper.innerHTML = oldHtml;
            }
        }

        // ================= RECEIPT PRINT & TRANSLATION =================
        function prepareReceiptDOM(id, lang = 'ar') {
            const entry = db.ledger.find(x => x.id === id); if(!entry) return null;
            const tmpl = document.getElementById('tmpl-receipt');
            const isEn = lang === 'en';
            
            tmpl.dir = isEn ? 'ltr' : 'rtl';
            tmpl.style.fontFamily = "'Cairo', sans-serif";
            const receiptLogo = tmpl.querySelector('.logo-img');
            if(receiptLogo) {
                receiptLogo.src = getEffectiveLogo();
                receiptLogo.classList.remove('hidden');
                receiptLogo.setAttribute('referrerpolicy', 'no-referrer');
                receiptLogo.onerror = function() {
                    if(this.dataset.fallbackApplied === '1') {
                        this.classList.add('hidden');
                        return;
                    }
                    this.dataset.fallbackApplied = '1';
                    this.src = DEFAULT_LOGO_FILE;
                    this.classList.remove('hidden');
                };
            }
            
            // تغيير اسم الشركة (للوطن) عند اختيار الإنجليزية
            const titleEl = document.getElementById('pr-comp-name');
            titleEl.innerText = isEn ? 'WATAN PLSLTD' : db.settings.companyName;
            
            document.getElementById('pr-subtitle').innerText = isEn ? 'Exchange & Transfers' : 'للصرافة والحوالات';
            document.getElementById('pr-lbl-ref').innerText = isEn ? 'Ref:' : 'رقم:';
            document.getElementById('pr-lbl-date').innerText = isEn ? 'Date & Time:' : 'التاريخ والوقت:';
            document.getElementById('pr-lbl-client').innerText = isEn ? 'Client/Beneficiary:' : 'المستفيد/العميل:';
            document.getElementById('pr-lbl-amount').innerText = isEn ? 'Amount' : 'المبلغ';
            document.getElementById('pr-lbl-eq').innerText = isEn ? 'Equivalent: ' : 'المعادل (للقبض/الصرف): ';
            document.getElementById('pr-lbl-emp').innerText = isEn ? 'Employee Sign' : 'توقيع الموظف';
            document.getElementById('pr-lbl-cust').innerText = isEn ? 'Client Sign / Stamp' : 'الختم / توقيع العميل';

            const typeStrAr = entry.subType === 'in' ? 'إيصال استلام (وارد)' : 'إيصال صرف (صادر)';
            const typeStrEn = entry.subType === 'in' ? 'Receipt (IN)' : 'Voucher (OUT)';
            
            const badgeEl = document.getElementById('pr-title');
            badgeEl.innerText = isEn ? typeStrEn : typeStrAr;
            badgeEl.className = entry.subType === 'in' ? 'receipt-title-bg receipt-title-in' : 'receipt-title-bg receipt-title-out';
            
            document.getElementById('pr-ref').innerText = entry.ref; 
            document.getElementById('pr-date').innerText = new Date(entry.date).toLocaleString('ar-EG'); 
            document.getElementById('pr-client').innerText = entry.client; 
            document.getElementById('pr-amount').innerText = entry.amount; 
            document.getElementById('pr-cur').innerText = entry.currency; 
            document.getElementById('pr-ils').innerText = formatEquivalentSnapshot(entry);
            
            let extraStr = '';
            if(entry.type === 'transfer') { 
                if(isEn) {
                    extraStr = `<div class="border-2 border-slate-300 p-4 mb-4 bg-slate-50 text-left rounded text-base"><h4 class="font-black text-slate-800 border-b-2 border-slate-300 pb-2 mb-3">Transfer Details</h4><div class="grid grid-cols-2 gap-y-4 gap-x-8"><div><span class="text-slate-500 block text-xs">Sender:</span> <strong class="text-lg">${entry.senderName || '---'}</strong></div><div><span class="text-slate-500 block text-xs">Sender Phone:</span> <strong class="text-lg">${entry.senderPhone || '---'}</strong></div><div><span class="text-slate-500 block text-xs">Receiver:</span> <strong class="text-lg">${entry.receiverName || '---'}</strong></div><div><span class="text-slate-500 block text-xs">Receiver Phone:</span> <strong class="text-lg">${entry.receiverPhone || '---'}</strong></div><div><span class="text-slate-500 block text-xs">Dest. Country:</span> <strong class="text-lg">${entry.receiverCountry || '---'}</strong></div><div><span class="text-slate-500 block text-xs">Agent:</span> <strong class="text-lg text-blue-700">${entry.agent || '---'}</strong></div></div></div>`;
                } else {
                    extraStr = `<div class="border-2 border-slate-300 p-4 mb-4 bg-slate-50 text-right rounded text-base"><h4 class="font-black text-slate-800 border-b-2 border-slate-300 pb-2 mb-3">تفاصيل الحوالة</h4><div class="grid grid-cols-2 gap-y-4 gap-x-8"><div><span class="text-slate-500 block text-xs">المرسل:</span> <strong class="text-lg">${entry.senderName || '---'}</strong></div><div><span class="text-slate-500 block text-xs">هاتف المرسل:</span> <strong class="text-lg" dir="ltr">${entry.senderPhone || '---'}</strong></div><div><span class="text-slate-500 block text-xs">المستلم:</span> <strong class="text-lg">${entry.receiverName || '---'}</strong></div><div><span class="text-slate-500 block text-xs">هاتف المستلم:</span> <strong class="text-lg" dir="ltr">${entry.receiverPhone || '---'}</strong></div><div><span class="text-slate-500 block text-xs">بلد الاستلام:</span> <strong class="text-lg">${entry.receiverCountry || '---'}</strong></div><div><span class="text-slate-500 block text-xs">الوكيل المراسل:</span> <strong class="text-lg text-blue-700">${entry.agent || '---'}</strong></div></div></div>`;
                }
            } 
            else if (entry.type === 'check') { 
                if(isEn) {
                    extraStr = `<div class="border border-slate-300 p-4 mb-4 bg-slate-50 text-left rounded"><p><strong>Bank:</strong> ${entry.bank} &nbsp;|&nbsp; <strong>Due Date:</strong> ${entry.due}</p><p class="mt-2"><strong>Notes:</strong> ${entry.notes || '---'}</p></div>`;
                } else {
                    extraStr = `<div class="border border-slate-300 p-4 mb-4 bg-slate-50 text-right rounded"><p><strong>البنك:</strong> ${entry.bank} &nbsp;|&nbsp; <strong>تاريخ الاستحقاق:</strong> ${entry.due}</p><p class="mt-2"><strong>البيان:</strong> ${entry.notes || '---'}</p></div>`;
                }
            } 
            else if(entry.notes) { 
                extraStr += `<p class="border p-2 bg-slate-50 rounded text-${isEn?'left':'right'}"><strong>${isEn?'Notes:':'ملاحظات:'}</strong> ${entry.notes}</p>`; 
            }
            const extraEl = document.getElementById('pr-extra'); extraEl.style.fontFamily = "'Cairo', sans-serif"; extraEl.innerHTML = extraStr; 
            return tmpl;
        }

        function waitForReceiptAssets(element) {
            const fontReady = document.fonts?.ready || Promise.resolve();
            const imagesReady = Promise.all(Array.from(element.querySelectorAll('img')).map(img => {
                if(img.complete && img.naturalWidth > 0) return Promise.resolve();
                return new Promise(resolve => {
                    const done = () => resolve();
                    img.addEventListener('load', done, {once: true});
                    img.addEventListener('error', done, {once: true});
                    setTimeout(done, 4000);
                });
            }));
            return Promise.all([fontReady, imagesReady]);
        }

        function nextPaint() {
            return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        }

        function pause(ms) {
            return new Promise(resolve => setTimeout(resolve, ms));
        }

        function buildPrintFrameDocument(receiptHtml, dir = 'rtl') {
            const styleNodes = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]'))
                .map(node => node.outerHTML)
                .join('\n');
            return [
                '<!DOCTYPE html>',
                `<html lang="ar" dir="${dir}">`,
                '<head>',
                '<meta charset="UTF-8">',
                '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
                `<base href="${location.href}">`,
                styleNodes,
                '<style>' +
                    '@page{size:A4 portrait;margin:8mm;}' +
                    'html,body{width:100%!important;height:auto!important;min-height:0!important;background:#fff!important;margin:0!important;padding:0!important;overflow:visible!important;font-family:"Cairo",sans-serif!important;}' +
                    'body{display:block!important;}' +
                    'body>*{visibility:visible!important;}' +
                    '#print-wrapper{display:block!important;position:static!important;width:100%!important;height:auto!important;margin:0!important;padding:0!important;background:#fff!important;visibility:visible!important;}' +
                    '#print-wrapper,#print-wrapper *{visibility:visible!important;-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;font-family:"Cairo",sans-serif!important;}' +
                    '#print-wrapper #tmpl-receipt{display:block!important;position:static!important;width:190mm!important;max-width:190mm!important;min-height:260mm!important;margin:0 auto!important;padding:9mm!important;box-sizing:border-box!important;background:#fff!important;border:1.2mm solid #0f172a!important;break-inside:avoid!important;page-break-inside:avoid!important;}' +
                    '.no-print{display:none!important;}' +
                '</style>',
                '</head>',
                `<body><div id="print-wrapper" class="print-mode">${receiptHtml}</div></body>`,
                '</html>'
            ].join('');
        }

        async function printLedgerReceipt(id) {
            const lang = document.getElementById('lang-' + id)?.value || 'ar';
            await triggerPrint(id, lang);
        }

        async function triggerPrint(id, lang = 'ar') {
            const el = prepareReceiptDOM(id, lang); if(!el) return;
            const wrapper = document.getElementById('print-wrapper');
            wrapper.className = 'print-mode print-preview-mode';
            document.body.classList.add('print-preview-open');
            await waitForReceiptAssets(el);
            await nextPaint();
            await pause(250);
            wrapper.scrollTop = 0;
            showToast('تم تجهيز المعاينة، اضغط طباعة الآن');
        }

        function closePrintPreview() {
            const wrapper = document.getElementById('print-wrapper');
            wrapper.className = 'hidden';
            document.body.classList.remove('print-preview-open');
        }

        async function confirmPrintPreview() {
            const wrapper = document.getElementById('print-wrapper');
            const receipt = document.getElementById('tmpl-receipt');
            if(!wrapper || !receipt || wrapper.classList.contains('hidden')) return;

            let iframe = null;
            try {
                showToast('جاري تجهيز صفحة A4 للطباعة...', 'success');
                await waitForReceiptAssets(receipt);
                if(document.fonts?.ready) await document.fonts.ready;
                await nextPaint();

                iframe = document.createElement('iframe');
                iframe.setAttribute('aria-hidden', 'true');
                iframe.style.cssText = [
                    'position:fixed',
                    'top:0',
                    'left:-220vw',
                    'width:210mm',
                    'height:297mm',
                    'border:0',
                    'background:#fff',
                    'visibility:visible',
                    'pointer-events:none'
                ].join(';');
                document.body.appendChild(iframe);

                const frameDoc = iframe.contentDocument || iframe.contentWindow.document;
                frameDoc.open();
                frameDoc.write(buildPrintFrameDocument(receipt.outerHTML, receipt.dir || 'rtl'));
                frameDoc.close();

                await new Promise(resolve => {
                    const done = () => resolve();
                    iframe.addEventListener('load', done, { once: true });
                    setTimeout(done, 900);
                });

                const frameWin = iframe.contentWindow;
                const frameReceipt = frameDoc.getElementById('tmpl-receipt');
                if(frameDoc.fonts?.ready) {
                    try { await frameDoc.fonts.ready; } catch(_) {}
                }
                if(frameReceipt) {
                    await Promise.all(Array.from(frameReceipt.querySelectorAll('img')).map(img => new Promise(resolve => {
                        if(img.complete && img.naturalWidth > 0) return resolve();
                        const done = () => resolve();
                        img.addEventListener('load', done, { once: true });
                        img.addEventListener('error', done, { once: true });
                        setTimeout(done, 4000);
                    })));
                }
                await pause(350);

                let cleaned = false;
                const cleanup = () => {
                    if(cleaned) return;
                    cleaned = true;
                    closePrintPreview();
                    setTimeout(() => iframe?.remove(), 300);
                };
                frameWin.addEventListener('afterprint', cleanup, { once: true });
                setTimeout(cleanup, 60000);
                frameWin.focus();
                frameWin.print();
            } catch(error) {
                console.error('Print preview error:', error);
                iframe?.remove();
                showToast('تعذر تشغيل الطباعة، حاول مرة أخرى', 'error');
            }
        }

        async function downloadReceipt(id, type) {
            const lang = document.getElementById('lang-' + id)?.value || 'ar';
            const el = prepareReceiptDOM(id, lang); if(!el) return;
            const wrapper = document.getElementById('print-wrapper');
            wrapper.className = 'offscreen-render';
            showToast('جاري تجهيز الملف احترافياً...', 'success');
            try {
                await waitForReceiptAssets(el);
                await nextPaint();
                if(type === 'img') {
                    const canvas = await html2canvas(el, {
                        scale: 2.5,
                        useCORS: true,
                        allowTaint: false,
                        backgroundColor: '#ffffff',
                        logging: false,
                        scrollX: 0,
                        scrollY: 0
                    });
                    const link = document.createElement('a');
                    link.download = `Receipt_${id}_${lang}.png`;
                    link.href = canvas.toDataURL('image/png', 1);
                    link.click();
                    showToast('تم تحميل الصورة بنجاح');
                } else if(type === 'pdf') {
                    const opt = {
                        margin: [0.12, 0.12, 0.12, 0.12],
                        filename: `Receipt_${id}_${lang}.pdf`,
                        image: { type: 'jpeg', quality: 1 },
                        html2canvas: { scale: 2.5, useCORS: true, allowTaint: false, backgroundColor: '#ffffff', logging: false },
                        jsPDF: { unit: 'in', format: 'a4', orientation: 'portrait' },
                        pagebreak: { mode: ['avoid-all', 'css', 'legacy'] }
                    };
                    await html2pdf().set(opt).from(el).save();
                    showToast('تم تحميل PDF بنجاح');
                }
            } catch(error) {
                console.error('Receipt export error:', error);
                showToast('تعذر تجهيز الوصل؛ حاول مرة أخرى', 'error');
            } finally {
                wrapper.className = 'hidden';
            }
        }

        // ================= RATES & SETTINGS =================
        function renderRatesEditor() {
            const c = document.getElementById('rates-editor-full'); c.innerHTML = '';
            db.settings.currencies.forEach((cur, i) => {
                const canDelete = !['USD', 'ILS'].includes(cur.code);
                c.innerHTML += `<div class="flex justify-between items-center gap-2"><span class="font-bold w-1/3">${cur.name} (${cur.code})</span><div class="flex items-center flex-1 gap-2"><span class="text-xs text-slate-500">كل 100 =</span><input type="number" step="0.0001" id="rate-set-${i}" value="${cur.rate}" class="border rounded p-2 text-center flex-1 font-bold text-blue-700"><span class="text-xs font-bold">شيكل</span>${canDelete ? `<button onclick="deleteCurrency('${cur.code}')" class="text-red-600 hover:text-red-800 px-2" title="حذف العملة"><i class="fas fa-trash"></i></button>` : ''}</div></div>`;
            });
        }

        async function addCurrency() {
            const code = document.getElementById('new-cur-code').value.trim().toUpperCase();
            const name = document.getElementById('new-cur-name').value.trim();
            const rate = parseFloat(document.getElementById('new-cur-rate').value) || 100;
            if(!code || !name) { showToast('أدخل رمز واسم العملة', 'error'); return; }
            if(db.settings.currencies.some(c => c.code === code)) { showToast('رمز العملة موجود مسبقاً', 'error'); return; }
            db.settings.currencies.push({code, name, rate});
            const synced = await saveDB();
            document.getElementById('new-cur-code').value = '';
            document.getElementById('new-cur-name').value = '';
            document.getElementById('new-cur-rate').value = '';
            init();
            if(synced) showToast('تمت إضافة العملة ومزامنتها');
        }

        async function saveRates() {
            db.settings.currencies.forEach((cur, i) => {
                cur.rate = parseFloat(document.getElementById(`rate-set-${i}`).value) || cur.rate;
            });
            const synced = await saveDB();
            init();
            if(synced) showToast('تم تحديث الأسعار ومزامنتها');
        }

        async function deleteCurrency(code) {
            if(['USD', 'ILS'].includes(code)) return;
            if(db.ledger.some(row => row.currency === code)) { showToast('لا يمكن حذف عملة مستخدمة في السجل', 'error'); return; }
            if(!confirm(`حذف العملة ${code}؟`)) return;
            db.settings.currencies = db.settings.currencies.filter(c => c.code !== code);
            const synced = await saveDB();
            init();
            if(synced) showToast('تم حذف العملة ومزامنة الحذف');
        }

        async function saveCompanySettings() {
            db.settings.companyName = document.getElementById('set-name').value.trim() || 'WATAN PLS LTD';
            db.settings.phone = document.getElementById('set-phone').value.trim();
            db.settings.address = document.getElementById('set-address').value.trim();
            db.settings.logo = document.getElementById('set-logo').value.trim();
            const synced = await saveDB();
            init();
            if(synced) showToast('تم حفظ الإعدادات ومزامنتها');
        }

        async function factoryReset() {
            if(!confirm('تحذير: سيتم مسح كافة البيانات والسجل من الجهاز وفايربيز. هل أنت متأكد؟')) return;
            db = defaultDatabase();
            localStorage.removeItem(LOCAL_DB_KEY);
            const synced = await saveDB();
            editingQuickId = editingTransferId = editingCheckId = null;
            init();
            if(synced) showToast('تم تصفير النظام ومزامنة الحذف');
        }



        // ================= PWA INSTALLATION =================
        let deferredInstallPrompt = null;

        function updateInstallButton(visible) {
            const button = document.getElementById('install-app-btn');
            if(!button) return;
            button.classList.toggle('hidden', !visible);
        }

        window.addEventListener('beforeinstallprompt', event => {
            event.preventDefault();
            deferredInstallPrompt = event;
            updateInstallButton(true);
        });

        async function installApp() {
            if(deferredInstallPrompt) {
                deferredInstallPrompt.prompt();
                const choice = await deferredInstallPrompt.userChoice;
                deferredInstallPrompt = null;
                updateInstallButton(false);
                if(choice.outcome === 'accepted') showToast('تم إرسال طلب تثبيت التطبيق');
                return;
            }
            if(location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
                showToast('التثبيت يحتاج رفع الملفات على رابط HTTPS، ولا يعمل عند فتح index.html مباشرة', 'error');
                return;
            }
            showToast('من قائمة كروم اختر: إضافة إلى الشاشة الرئيسية أو تثبيت التطبيق');
        }

        window.addEventListener('appinstalled', () => {
            deferredInstallPrompt = null;
            updateInstallButton(false);
            showToast('تم تثبيت التطبيق بنجاح');
        });

        if('serviceWorker' in navigator) {
            window.addEventListener('load', () => {
                const secureContext = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
                if(!secureContext) return;
                navigator.serviceWorker.register('./sw.js').catch(error => {
                    console.error('Service worker registration error:', error);
                });
            });
        }

        window.addEventListener('load', async () => {
            resetLocalDataForRequiredVersion();
            readMarketRatesCache();
            init();
            refreshGlobalMarketRates(false);
            await bootstrapFirebase();
        });
