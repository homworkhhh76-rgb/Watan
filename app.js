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

        function defaultDatabase() {
            return {
                settings: { companyName: "WATAN PLS LTD", phone: "+970567406000", address: "فلسطين", currencies: defaultCurrencies.map(c => ({...c})), logo: DEFAULT_LOGO_FILE },
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
                rate: t.rate === undefined ? undefined : Number(t.rate) || 0
            }));
            const clients = collectionToArray(source.clients).map(c => ({
                ...c,
                id: Number.isFinite(Number(c.id)) ? Number(c.id) : c.id
            }));
            return {
                settings: { ...base.settings, ...rawSettings, currencies: currencies.length ? currencies : base.settings.currencies, logo: /^data:image\//i.test(String(rawSettings.logo || '')) ? '' : String(rawSettings.logo || '') },
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
                    remoteInitialized = true;
                    db = normalizeDatabase(remote);
                    saveLocalOnly();
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

        function getUsdRate() { return (db.settings.currencies.find(c => c.code === 'USD') || {}).rate || 365; }
        function getUsdEquivalent(ilsAmount) { return Number(ilsAmount || 0) / (getUsdRate() / 100); }

        function generateRefNum() {
            const maxRef = db.ledger.reduce((max, row) => {
                const value = parseInt(String(row.ref || '').replace(/\D/g, ''), 10);
                return Number.isFinite(value) ? Math.max(max, value) : max;
            }, 0);
            return String(maxRef + 1).padStart(4, '0');
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
            db.ledger = (db.ledger || []).map(row => {
                const totalIls = Number(row.totalIls) || 0;
                const savedUsd = Number(row.totalUsd);
                return {
                    ...row,
                    amount: Number(row.amount) || 0,
                    totalIls,
                    totalUsd: Number.isFinite(savedUsd) ? savedUsd : getUsdEquivalent(totalIls)
                };
            });
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
            if(!editingTransferId) document.getElementById('tr-ref').value = 'TR-' + generateRefNum();
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
            const selects = document.querySelectorAll('.dynamic-currencies');
            const selected = new Map(Array.from(selects).map(s => [s.id, s.value]));
            let optionsHtml = '';
            db.settings.currencies.forEach(c => { optionsHtml += `<option value="${c.code}" data-rate="${c.rate}">${c.code} - ${c.name}</option>`; });
            selects.forEach(s => {
                s.innerHTML = optionsHtml;
                const previous = selected.get(s.id);
                if(previous && Array.from(s.options).some(option => option.value === previous)) s.value = previous;
            });
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
        function triggerQSync() { const sel = document.getElementById('q-currency'); const rate = parseFloat(sel.options[sel.selectedIndex]?.dataset.rate) || 100; document.getElementById('q-rate').value = rate; handleQAmount(); }
        function handleQAmount() { if(document.getElementById('q-sync').checked) { const amt = parseFloat(document.getElementById('q-amount').value) || 0; const rate = parseFloat(document.getElementById('q-rate').value) || 100; document.getElementById('q-ils').value = (amt * (rate / 100)).toFixed(2); } }
        function handleQIls() { if(document.getElementById('q-sync').checked) { const ils = parseFloat(document.getElementById('q-ils').value) || 0; const rate = parseFloat(document.getElementById('q-rate').value) || 100; document.getElementById('q-amount').value = rate ? (ils / (rate / 100)).toFixed(2) : 0; } }

        function triggerTrSync() { const sel = document.getElementById('tr-currency'); const rate = parseFloat(sel.options[sel.selectedIndex]?.dataset.rate) || 100; document.getElementById('tr-rate').value = rate; handleTrAmount(); }
        function handleTrAmount() { if(document.getElementById('tr-sync').checked) { const amt = parseFloat(document.getElementById('tr-amount').value) || 0; const rate = parseFloat(document.getElementById('tr-rate').value) || 100; document.getElementById('tr-ils').value = (amt * (rate / 100)).toFixed(2); } }
        function handleTrIls() { if(document.getElementById('tr-sync').checked) { const ils = parseFloat(document.getElementById('tr-ils').value) || 0; const rate = parseFloat(document.getElementById('tr-rate').value) || 100; document.getElementById('tr-amount').value = rate ? (ils / (rate / 100)).toFixed(2) : 0; } }

        function triggerChkSync() { const sel = document.getElementById('chk-currency'); const rate = parseFloat(sel.options[sel.selectedIndex]?.dataset.rate) || 100; document.getElementById('chk-rate').value = rate; handleChkAmount(); }
        function handleChkAmount() { if(document.getElementById('chk-sync').checked) { const amt = parseFloat(document.getElementById('chk-amount').value) || 0; const rate = parseFloat(document.getElementById('chk-rate').value) || 100; document.getElementById('chk-ils').value = (amt * (rate / 100)).toFixed(2); } }
        function handleChkIls() { if(document.getElementById('chk-sync').checked) { const ils = parseFloat(document.getElementById('chk-ils').value) || 0; const rate = parseFloat(document.getElementById('chk-rate').value) || 100; document.getElementById('chk-amount').value = rate ? (ils / (rate / 100)).toFixed(2) : 0; } }

        // ================= SAVE OPERATIONS =================
        function cancelQuickForm() {
            editingQuickId = null;
            document.getElementById('quick-form').reset();
            init();
        }

        function updateQuickFormColors() {
            const type = document.getElementById('q-type').value;
            const btn = document.querySelector('#quick-form button.bg-green-600, #quick-form button.bg-red-600');
            if(btn) {
                if(type === 'in') { btn.classList.replace('bg-red-600', 'bg-green-600'); btn.classList.replace('hover:bg-red-700', 'hover:bg-green-700'); }
                else { btn.classList.replace('bg-green-600', 'bg-red-600'); btn.classList.replace('hover:bg-green-700', 'hover:bg-red-700'); }
            }
        }

        async function saveQuickOperation(isPrint) {
            const form = document.getElementById('quick-form');
            if(!form.checkValidity()) { form.reportValidity(); return; }
            const ilsValue = parseFloat(document.getElementById('q-ils').value) || 0;
            const existingIndex = editingQuickId === null ? -1 : db.ledger.findIndex(x => x.id === editingQuickId && x.type === 'quick');
            const existing = existingIndex >= 0 ? db.ledger[existingIndex] : null;
            const selectedDate = document.getElementById('q-date').value;
            const existingTime = existing?.date?.includes('T') ? existing.date.split('T')[1] : new Date().toTimeString().split(' ')[0];
            const entry = {
                ...(existing || {}),
                id: existing?.id ?? Date.now(),
                ref: existing?.ref || document.getElementById('q-ref').value,
                date: selectedDate + 'T' + existingTime,
                type: 'quick',
                subType: document.getElementById('q-type').value,
                client: document.getElementById('q-client').value,
                amount: parseFloat(document.getElementById('q-amount').value) || 0,
                currency: document.getElementById('q-currency').value,
                rate: parseFloat(document.getElementById('q-rate').value) || 100,
                totalIls: ilsValue,
                totalUsd: getUsdEquivalent(ilsValue),
                notes: document.getElementById('q-notes').value
            };
            if(existingIndex >= 0) db.ledger[existingIndex] = entry; else db.ledger.push(entry);
            const synced = await saveDB();
            if(synced) showToast(existing ? 'تم تعديل العملية ومزامنتها' : 'تم حفظ العملية ومزامنتها');
            if(isPrint) await triggerPrint(entry.id);
            editingQuickId = null;
            form.reset();
            init();
        }

        async function saveTransfer(isPrint) {
            const form = document.getElementById('transfer-form');
            if(!form.checkValidity()) { form.reportValidity(); return; }
            const ilsValue = parseFloat(document.getElementById('tr-ils').value) || 0;
            const existingIndex = editingTransferId === null ? -1 : db.ledger.findIndex(x => x.id === editingTransferId && x.type === 'transfer');
            const existing = existingIndex >= 0 ? db.ledger[existingIndex] : null;
            const entry = {
                ...(existing || {}),
                id: existing?.id ?? Date.now(),
                ref: existing?.ref || document.getElementById('tr-ref').value,
                date: existing?.date || new Date().toISOString(),
                type: 'transfer',
                subType: document.getElementById('tr-type').value,
                client: document.getElementById('tr-sender-name').value + ' لـ ' + document.getElementById('tr-receiver-name').value,
                amount: parseFloat(document.getElementById('tr-amount').value) || 0,
                currency: document.getElementById('tr-currency').value,
                rate: parseFloat(document.getElementById('tr-rate').value) || 100,
                totalIls: ilsValue,
                totalUsd: getUsdEquivalent(ilsValue),
                senderName: document.getElementById('tr-sender-name').value,
                senderPhone: document.getElementById('tr-sender-phone').value,
                senderId: document.getElementById('tr-sender-id').value,
                receiverName: document.getElementById('tr-receiver-name').value,
                receiverPhone: document.getElementById('tr-receiver-phone').value,
                receiverCountry: document.getElementById('tr-receiver-country').value,
                agent: document.getElementById('tr-agent').value
            };
            if(existingIndex >= 0) db.ledger[existingIndex] = entry; else db.ledger.push(entry);
            const synced = await saveDB();
            if(synced) showToast(existing ? 'تم تعديل الحوالة ومزامنتها' : 'تم حفظ الحوالة ومزامنتها');
            if(isPrint) await triggerPrint(entry.id);
            editingTransferId = null;
            form.reset();
            init();
        }

        async function saveCheck(isPrint) {
            const form = document.getElementById('check-form');
            if(!form.checkValidity()) { form.reportValidity(); return; }
            const ilsValue = parseFloat(document.getElementById('chk-ils').value) || 0;
            const existingIndex = editingCheckId === null ? -1 : db.ledger.findIndex(x => x.id === editingCheckId && x.type === 'check');
            const existing = existingIndex >= 0 ? db.ledger[existingIndex] : null;
            const entry = {
                ...(existing || {}),
                id: existing?.id ?? Date.now(),
                ref: document.getElementById('chk-no').value,
                date: existing?.date || new Date().toISOString(),
                type: 'check',
                subType: document.getElementById('chk-type').value,
                client: document.getElementById('chk-client').value,
                amount: parseFloat(document.getElementById('chk-amount').value) || 0,
                currency: document.getElementById('chk-currency').value,
                rate: parseFloat(document.getElementById('chk-rate').value) || 100,
                totalIls: ilsValue,
                totalUsd: getUsdEquivalent(ilsValue),
                bank: document.getElementById('chk-bank').value,
                due: document.getElementById('chk-due').value,
                notes: document.getElementById('chk-notes').value
            };
            if(existingIndex >= 0) db.ledger[existingIndex] = entry; else db.ledger.push(entry);
            const synced = await saveDB();
            if(synced) showToast(existing ? 'تم تعديل الشيك ومزامنته' : 'تم حفظ الشيك ومزامنته');
            if(isPrint) await triggerPrint(entry.id);
            editingCheckId = null;
            form.reset();
            init();
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

        function getUsdValueSafe(t) { return t.totalUsd !== undefined ? t.totalUsd : getUsdEquivalent(t.totalIls); }

        function renderDashboard() {
            const today = new Date().toISOString().split('T')[0];
            let count = 0, inUsd = 0, outUsd = 0, balanceUsd = 0;
            const ratesContainer = document.getElementById('dash-rates'); ratesContainer.innerHTML = '';
            db.settings.currencies.forEach(c => {
                if(c.code === 'ILS') return;
                ratesContainer.innerHTML += `<div class="flex justify-between items-center border-b pb-2"><span class="font-bold text-slate-700">100 ${c.name}</span><span class="text-blue-600 font-bold" dir="ltr">${c.rate} ₪</span></div>`;
            });

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
                const searchable = `${entry.client || ''} ${entry.ref || ''} ${entry.notes || ''}`.toLowerCase();
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
            return { rows, totals };
        }

        function formatSignedAmount(value) {
            return value < 0 ? `${Math.abs(value).toFixed(2)}-` : value.toFixed(2);
        }

        function renderReports() {
            const tbody = document.getElementById('reports-body');
            tbody.innerHTML = '';
            const { rows, totals } = getVisibleReportData();

            rows.forEach(({ entry: t, date: d, incoming: inAmt, outgoing: outAmt, balance }) => {
                const balanceClass = balance < 0 ? 'text-red-600' : 'text-slate-800';
                tbody.innerHTML += `
                    <tr>
                        <td class="text-xs text-slate-500">${d.toLocaleDateString('en-GB')}<br><span class="text-[10px]">${d.toLocaleTimeString('ar-EG', {hour:'2-digit', minute:'2-digit'})}</span></td>
                        <td class="text-right leading-tight">
                            <span class="font-bold text-slate-800 block">${t.client || '-'}</span>
                            <span class="text-[10px] text-slate-500 bg-slate-200 px-1 rounded inline-block mt-1">م: ${t.ref || '-'} | ${t.amount || 0} ${t.currency || ''}</span>
                            ${t.notes ? `<div class="text-xs text-blue-600 mt-1"><i class="fas fa-comment-alt"></i> ${t.notes}</div>` : ''}
                        </td>
                        <td class="text-green-600 font-black">${inAmt > 0 ? inAmt.toFixed(2) : '0'}</td>
                        <td class="text-red-600 font-black">${outAmt > 0 ? outAmt.toFixed(2) : '0'}</td>
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

            document.getElementById('tot-in').innerText = totals.incoming.toFixed(2);
            document.getElementById('tot-out').innerText = totals.outgoing.toFixed(2);
            document.getElementById('tot-diff').innerText = formatSignedAmount(totals.difference);
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
            const derivedRate = entry.rate || (entry.amount ? (Number(entry.totalIls || 0) / Number(entry.amount)) * 100 : 100);
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
                document.getElementById('tr-ils').value = Number(entry.totalIls || 0).toFixed(2);
                document.getElementById('tr-sync').checked = false;
                showToast('عدّل بيانات الحوالة ثم اضغط حفظ');
                return;
            }
            if(entry.type === 'check') {
                switchTab('checks');
                editingCheckId = id;
                document.getElementById('chk-type').value = entry.subType || 'out';
                document.getElementById('chk-no').value = entry.ref || '';
                document.getElementById('chk-client').value = entry.client || '';
                document.getElementById('chk-bank').value = entry.bank || '';
                document.getElementById('chk-due').value = entry.due || new Date().toISOString().split('T')[0];
                document.getElementById('chk-currency').value = entry.currency || 'USD';
                document.getElementById('chk-rate').value = Number(derivedRate).toFixed(4);
                document.getElementById('chk-amount').value = entry.amount || 0;
                document.getElementById('chk-ils').value = Number(entry.totalIls || 0).toFixed(2);
                document.getElementById('chk-notes').value = entry.notes || '';
                document.getElementById('chk-sync').checked = false;
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
            document.getElementById('q-ils').value = Number(entry.totalIls || 0).toFixed(2);
            document.getElementById('q-notes').value = entry.notes || '';
            document.getElementById('q-sync').checked = false;
            updateQuickFormColors();
            showToast('عدّل بيانات العملية ثم اضغط حفظ العملية');
        }

        // ================= EXCEL EXPORT =================
        function reportPeriodLabel() {
            const label = document.getElementById('active-filter-text')?.innerText?.trim();
            return label || 'كل الأوقات';
        }

        function reportDetailsText(entry) {
            const parts = [entry.client || '-', `المرجع: ${entry.ref || '-'}`, `${entry.amount || 0} ${entry.currency || ''}`];
            if(entry.notes) parts.push(`ملاحظات: ${entry.notes}`);
            return parts.join(' | ');
        }

        function exportReportsExcel() {
            showToast('جاري تصدير كل عمليات الفترة الظاهرة لإكسل...', 'success');
            const { rows, totals } = getVisibleReportData();
            const wsData = [
                ['إجمالي الفترة الظاهرة', '', totals.incoming, totals.outgoing, totals.difference],
                [`الفترة: ${reportPeriodLabel()}`, `عدد العمليات: ${rows.length}`, '', '', ''],
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
            ws['!cols'] = [{wch: 23}, {wch: 55}, {wch: 18}, {wch: 18}, {wch: 20}];
            ws['!merges'] = [
                {s:{r:0,c:0}, e:{r:0,c:1}}
            ];
            ws['!autofilter'] = { ref: `A4:E${Math.max(4, wsData.length)}` };
            const wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, 'كشف الحساب');
            XLSX.writeFile(wb, `CashTop_Report_${new Date().toISOString().split('T')[0]}.xlsx`);
        }

        // ================= PDF EXPORT (ALL VISIBLE PERIOD ROWS) =================
        async function exportReportsPDF() {
            showToast('جاري تجهيز كل عمليات الفترة الظاهرة في PDF...', 'success');
            const { rows, totals } = getVisibleReportData();
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
                    <td style="color:#15803d;font-weight:800;">${incoming > 0 ? incoming.toFixed(2) : '0'}</td>
                    <td style="color:#dc2626;font-weight:800;">${outgoing > 0 ? outgoing.toFixed(2) : '0'}</td>
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

                <div style="display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:1px;background:#cbd5e1;border:1px solid #cbd5e1;margin-bottom:14px;border-radius:8px;overflow:hidden;text-align:center;font-weight:900;">
                    <div style="background:#0f172a;color:white;padding:12px;">إجمالي الفترة الظاهرة</div>
                    <div style="background:#dcfce7;color:#166534;padding:12px;">الوارد: ${totals.incoming.toFixed(2)}</div>
                    <div style="background:#fee2e2;color:#991b1b;padding:12px;">المنصرف: ${totals.outgoing.toFixed(2)}</div>
                    <div style="background:#e2e8f0;color:#0f172a;padding:12px;">الصافي: ${formatSignedAmount(totals.difference)}</div>
                </div>

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
            document.getElementById('pr-lbl-eq').innerText = isEn ? 'Equivalent (ILS): ' : 'المعادل (للقبض/الصرف): ';
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
            document.getElementById('pr-ils').innerText = Number(entry.totalIls || 0).toFixed(2);
            
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
            const styleNodes = Array.from(document.querySelectorAll('style, link[rel="stylesheet"]')).map(node => node.outerHTML).join('\n');
            return [
                '<!DOCTYPE html>',
                `<html lang="ar" dir="${dir}">`,
                '<head>',
                '<meta charset="UTF-8">',
                '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
                `<base href="${location.href}">`,
                styleNodes,
                '<style>' +
                    'html,body{background:#fff!important;margin:0;padding:0;font-family:"Cairo",sans-serif!important;}' +
                    'body{display:block!important;}' +
                    '#print-root{width:100%;padding:0;margin:0;background:#fff;}' +
                    '#print-root #tmpl-receipt{width:190mm!important;max-width:190mm!important;min-height:260mm!important;margin:0 auto!important;padding:9mm!important;box-sizing:border-box!important;background:#fff!important;border:1.2mm solid #0f172a!important;}' +
                    '#print-root,#print-root *{-webkit-print-color-adjust:exact!important;print-color-adjust:exact!important;font-family:"Cairo",sans-serif!important;}' +
                '</style>',
                '</head>',
                `<body><div id="print-root">${receiptHtml}</div></body>`,
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
            wrapper.className = 'offscreen-render';
            showToast('جاري تجهيز الوصل للطباعة...', 'success');
            try {
                await waitForReceiptAssets(el);
                await nextPaint();
                await pause(250);
                const iframe = document.createElement('iframe');
                iframe.style.position = 'fixed';
                iframe.style.right = '0';
                iframe.style.bottom = '0';
                iframe.style.width = '0';
                iframe.style.height = '0';
                iframe.style.border = '0';
                iframe.setAttribute('aria-hidden', 'true');
                document.body.appendChild(iframe);

                const frameDoc = iframe.contentWindow.document;
                frameDoc.open();
                frameDoc.write(buildPrintFrameDocument(el.outerHTML, el.dir || 'rtl'));
                frameDoc.close();

                await new Promise(resolve => {
                    const done = () => resolve();
                    iframe.onload = done;
                    setTimeout(done, 700);
                });

                const frameWin = iframe.contentWindow;
                if(frameWin.document && frameWin.document.fonts && frameWin.document.fonts.ready) {
                    try { await frameWin.document.fonts.ready; } catch(_) {}
                }
                const frameImgs = Array.from(frameWin.document.images || []);
                await Promise.all(frameImgs.map(img => new Promise(resolve => {
                    if(img.complete && img.naturalWidth > 0) return resolve();
                    const done = () => resolve();
                    img.addEventListener('load', done, {once:true});
                    img.addEventListener('error', done, {once:true});
                    setTimeout(done, 4000);
                })));
                await pause(300);

                await new Promise(resolve => {
                    let finished = false;
                    const cleanup = () => {
                        if(finished) return;
                        finished = true;
                        setTimeout(() => iframe.remove(), 300);
                        resolve();
                    };
                    frameWin.addEventListener('afterprint', cleanup, { once: true });
                    setTimeout(cleanup, 60000);
                    frameWin.focus();
                    frameWin.print();
                });
            } catch(error) {
                console.error('Print error:', error);
                showToast('تعذر فتح الطباعة، حاول مرة أخرى', 'error');
            } finally {
                wrapper.className = 'hidden';
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
            init();
            await bootstrapFirebase();
        });
