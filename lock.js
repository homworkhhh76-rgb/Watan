'use strict';

/*
 * Login + PIN + device biometric module transferred from the previous build.
 * It is intentionally isolated so the attached application's design and core app.js stay unchanged.
 */
(() => {
    const DEVICE_ID_KEY = 'watanSecurityDeviceId';
    const LEGACY_DEVICE_ID_KEY = 'watanLockDeviceId';

    let appUnlocked = false;
    let securityInitializationInProgress = false;
    let autoBiometricAttempted = false;
    let autoBiometricInProgress = false;

    function ensureSecurityShape() {
        db.settings = db.settings || {};
        const current = db.settings.security && typeof db.settings.security === 'object'
            ? db.settings.security
            : {};
        const credentials = current.biometricCredentials && typeof current.biometricCredentials === 'object'
            ? current.biometricCredentials
            : {};

        db.settings.security = {
            pinHash: String(current.pinHash || ''),
            biometricEnabled: Boolean(current.biometricEnabled),
            biometricCredentials: credentials,
            pinUpdatedAt: current.pinUpdatedAt || null
        };
        return db.settings.security;
    }

    function getDeviceId() {
        let id = localStorage.getItem(DEVICE_ID_KEY);
        if(id) return id;

        // Migrate the identifier created by the separate-lock build, if present.
        const legacyId = localStorage.getItem(LEGACY_DEVICE_ID_KEY);
        if(legacyId) {
            localStorage.setItem(DEVICE_ID_KEY, legacyId);
            return legacyId;
        }

        const random = new Uint8Array(16);
        crypto.getRandomValues(random);
        id = Array.from(random, byte => byte.toString(16).padStart(2, '0')).join('');
        localStorage.setItem(DEVICE_ID_KEY, id);
        return id;
    }

    function getBiometricCredentialRecord(deviceId = getDeviceId()) {
        const security = ensureSecurityShape();
        const stored = security.biometricCredentials[deviceId];
        if(!stored) return null;

        if(typeof stored === 'string') {
            return { id: stored, version: 1, legacy: true };
        }

        if(typeof stored === 'object' && stored.id) {
            const version = Number(stored.version) || 1;
            return {
                id: String(stored.id),
                version,
                createdAt: stored.createdAt || null,
                authenticator: stored.authenticator || null,
                legacy: version !== 2
            };
        }
        return null;
    }

    function hasCurrentDeviceBiometric() {
        const security = ensureSecurityShape();
        const record = getBiometricCredentialRecord();
        return Boolean(security.biometricEnabled && record && record.version === 2 && record.id);
    }

    function randomBytes(length = 32) {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes);
        return bytes;
    }

    function bytesToBase64Url(buffer) {
        const bytes = new Uint8Array(buffer);
        let binary = '';
        bytes.forEach(byte => { binary += String.fromCharCode(byte); });
        return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
    }

    function base64UrlToBytes(value) {
        const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
        const padding = '='.repeat((4 - normalized.length % 4) % 4);
        const binary = atob(normalized + padding);
        return Uint8Array.from(binary, char => char.charCodeAt(0));
    }

    async function hashPin(pin) {
        const bytes = new TextEncoder().encode(String(pin));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return bytesToBase64Url(digest);
    }

    async function hashPinHex(pin) {
        const bytes = new TextEncoder().encode(String(pin));
        const digest = await crypto.subtle.digest('SHA-256', bytes);
        return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    }

    async function verifyAppPin(pin) {
        if(!/^\d{4}$/.test(String(pin))) return false;
        const security = ensureSecurityShape();
        if(!security.pinHash) return String(pin) === '0000';

        // Accept both the previous integrated build and the temporary separate-module hash formats.
        const [base64Hash, hexHash] = await Promise.all([hashPin(pin), hashPinHex(pin)]);
        return security.pinHash === base64Hash || security.pinHash === hexHash;
    }

    async function ensureSecurityInitialized(options = {}) {
        const security = ensureSecurityShape();
        if(security.pinHash || securityInitializationInProgress) return;

        securityInitializationInProgress = true;
        try {
            security.pinHash = await hashPin('0000');
            security.pinUpdatedAt = Date.now();
            if(typeof saveLocalOnly === 'function') saveLocalOnly();
            if(options.save !== false && typeof firebaseRootRef !== 'undefined' && firebaseRootRef && typeof saveDB === 'function') {
                await saveDB({ silent: true });
            }
        } finally {
            securityInitializationInProgress = false;
        }
    }

    function updateBranding() {
        const logo = document.querySelector('.lock-logo-img');
        const name = document.querySelector('.lock-company-name');
        if(name) name.textContent = db.settings?.companyName || 'WATAN PLS LTD';
        if(logo) {
            logo.src = typeof getEffectiveLogo === 'function' ? getEffectiveLogo() : 'logo.png';
            logo.onerror = () => {
                logo.onerror = null;
                logo.src = 'logo.png';
            };
        }
    }

    function isBiometricContextSupported() {
        return Boolean(window.isSecureContext && window.PublicKeyCredential && navigator.credentials);
    }

    async function hasPlatformBiometricAuthenticator() {
        if(!isBiometricContextSupported()) return false;
        if(typeof PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable !== 'function') return true;
        try {
            return await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
        } catch(error) {
            return false;
        }
    }

    function updateLockBiometricUI() {
        const button = document.getElementById('lock-biometric-btn');
        const hint = document.getElementById('lock-biometric-hint');
        const enabled = Boolean(hasCurrentDeviceBiometric() && isBiometricContextSupported());
        const record = getBiometricCredentialRecord();

        if(button) {
            button.disabled = !enabled || autoBiometricInProgress;
            button.classList.toggle('is-disabled', !enabled || autoBiometricInProgress);
        }

        if(hint) {
            if(enabled) hint.innerText = autoBiometricInProgress ? 'جاري فتح بصمة الجهاز...' : 'ستفتح بصمة الجهاز تلقائياً';
            else if(record?.legacy) hint.innerText = 'أعد تفعيل البصمة مرة واحدة من الإعدادات';
            else if(!isBiometricContextSupported()) hint.innerText = 'البصمة تحتاج فتح التطبيق من رابط HTTPS';
            else hint.innerText = 'يمكن تفعيل البصمة من الإعدادات';
        }
    }

    function updateBiometricSettingsStatus(message = '') {
        const status = document.getElementById('biometric-settings-status');
        const checkbox = document.getElementById('set-biometric-enabled');
        if(checkbox) checkbox.checked = hasCurrentDeviceBiometric();
        if(!status) return;

        if(message) {
            status.innerText = message;
            return;
        }

        const record = getBiometricCredentialRecord();
        if(hasCurrentDeviceBiometric()) status.innerText = 'البصمة مفعلة على هذا الجهاز وتفتح تلقائياً.';
        else if(record?.legacy) status.innerText = 'اعتماد البصمة القديم يحتاج إعادة تفعيل مرة واحدة.';
        else if(!isBiometricContextSupported()) status.innerText = 'لتفعيل البصمة افتح التطبيق من رابط HTTPS أو من التطبيق المثبت.';
        else status.innerText = 'البصمة غير مفعلة على هذا الجهاز.';
    }

    function lockAppUI() {
        appUnlocked = false;
        document.body.classList.add('app-is-locked');
        const screen = document.getElementById('app-lock-screen');
        if(screen) screen.classList.remove('unlocked');
        updateBranding();
        updateLockBiometricUI();
    }

    function unlockAppUI() {
        appUnlocked = true;
        document.body.classList.remove('app-is-locked');
        const screen = document.getElementById('app-lock-screen');
        if(screen) screen.classList.add('unlocked');
        closePinLoginModal();
    }

    function waitForTransition(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }

    function showBiometricUnlockTransition() {
        const screen = document.getElementById('app-lock-screen');
        const card = screen?.querySelector('.app-lock-card');
        if(!screen || !card) return;

        let loader = document.getElementById('biometric-unlock-loader');
        if(!loader) {
            loader = document.createElement('div');
            loader.id = 'biometric-unlock-loader';
            loader.className = 'biometric-unlock-loader';
            loader.setAttribute('role', 'status');
            loader.setAttribute('aria-live', 'polite');
            loader.innerHTML = '<span class="biometric-unlock-spinner" aria-hidden="true"></span>';
            card.appendChild(loader);
        }

        screen.classList.add('biometric-unlock-transition');
        loader.classList.add('is-visible');
    }

    function clearBiometricUnlockTransition() {
        const screen = document.getElementById('app-lock-screen');
        screen?.classList.remove('biometric-unlock-transition');
        document.getElementById('biometric-unlock-loader')?.classList.remove('is-visible');
    }

    function clearPinInputs() {
        document.querySelectorAll('.pin-digit').forEach(input => { input.value = ''; });
        document.getElementById('pin-login-error')?.classList.add('hidden');
    }

    function openPinLoginModal() {
        const modal = document.getElementById('pin-login-modal');
        if(!modal) return;
        clearPinInputs();
        modal.classList.remove('hidden');
        setTimeout(() => document.querySelector('.pin-digit')?.focus(), 60);
    }

    function closePinLoginModal() {
        document.getElementById('pin-login-modal')?.classList.add('hidden');
        clearPinInputs();
    }

    function setupPinInputs() {
        const inputs = Array.from(document.querySelectorAll('.pin-digit'));
        inputs.forEach((input, index) => {
            input.addEventListener('input', event => {
                const digit = String(event.target.value || '').replace(/\D/g, '').slice(-1);
                event.target.value = digit;
                document.getElementById('pin-login-error')?.classList.add('hidden');
                if(digit && inputs[index + 1]) inputs[index + 1].focus();
                if(digit && index === inputs.length - 1) submitPinLogin();
            });

            input.addEventListener('keydown', event => {
                if(event.key === 'Backspace' && !input.value && inputs[index - 1]) inputs[index - 1].focus();
                if(event.key === 'Enter') submitPinLogin();
            });

            input.addEventListener('paste', event => {
                event.preventDefault();
                const digits = (event.clipboardData?.getData('text') || '').replace(/\D/g, '').slice(0, 4);
                digits.split('').forEach((digit, position) => {
                    if(inputs[position]) inputs[position].value = digit;
                });
                if(digits.length === 4) submitPinLogin();
                else inputs[Math.min(digits.length, inputs.length - 1)]?.focus();
            });
        });
    }

    async function submitPinLogin() {
        const inputs = Array.from(document.querySelectorAll('.pin-digit'));
        const pin = inputs.map(input => input.value).join('');
        const error = document.getElementById('pin-login-error');

        if(pin.length !== 4) {
            if(error) {
                error.innerText = 'أدخل الأرقام الأربعة';
                error.classList.remove('hidden');
            }
            return;
        }

        try {
            if(await verifyAppPin(pin)) {
                unlockAppUI();
                return;
            }
        } catch(authenticationError) {
            console.error('PIN verification error:', authenticationError);
        }

        if(error) {
            error.innerText = 'رمز القفل غير صحيح';
            error.classList.remove('hidden');
        }
        inputs.forEach(input => { input.value = ''; });
        inputs[0]?.focus();
    }

    async function changeAppPin() {
        const currentPin = document.getElementById('set-current-pin')?.value.trim() || '';
        const newPin = document.getElementById('set-new-pin')?.value.trim() || '';
        const confirmPin = document.getElementById('set-confirm-pin')?.value.trim() || '';

        if(!/^\d{4}$/.test(currentPin) || !/^\d{4}$/.test(newPin)) {
            showToast('رمز القفل يجب أن يكون 4 أرقام', 'error');
            return;
        }
        if(newPin !== confirmPin) {
            showToast('تأكيد رمز القفل غير مطابق', 'error');
            return;
        }
        if(!(await verifyAppPin(currentPin))) {
            showToast('رمز القفل الحالي غير صحيح', 'error');
            return;
        }

        const security = ensureSecurityShape();
        security.pinHash = await hashPin(newPin);
        security.pinUpdatedAt = Date.now();
        const synced = await saveDB();

        ['set-current-pin', 'set-new-pin', 'set-confirm-pin'].forEach(id => {
            const input = document.getElementById(id);
            if(input) input.value = '';
        });
        showToast(synced ? 'تم تغيير رمز القفل وحفظه في Firebase' : 'تم تغيير رمز القفل محلياً وسيُزامن لاحقاً');
    }

    async function registerBiometricCredential() {
        if(!(await hasPlatformBiometricAuthenticator())) {
            throw new Error('لا توجد بصمة مدعومة أو أن التطبيق ليس على HTTPS');
        }

        const deviceId = getDeviceId();
        const credential = await navigator.credentials.create({
            publicKey: {
                challenge: randomBytes(32),
                rp: { name: db.settings?.companyName || 'WATAN PLS LTD' },
                user: {
                    id: randomBytes(32),
                    name: `watan-${deviceId}`,
                    displayName: db.settings?.companyName || 'WATAN PLS LTD'
                },
                pubKeyCredParams: [
                    { type: 'public-key', alg: -7 },
                    { type: 'public-key', alg: -257 }
                ],
                timeout: 60000,
                attestation: 'none',
                authenticatorSelection: {
                    authenticatorAttachment: 'platform',
                    residentKey: 'discouraged',
                    requireResidentKey: false,
                    userVerification: 'required'
                },
                extensions: { credProps: true }
            }
        });

        if(!credential) throw new Error('لم يتم إنشاء اعتماد البصمة');

        const security = ensureSecurityShape();
        security.biometricCredentials[deviceId] = {
            id: bytesToBase64Url(credential.rawId),
            version: 2,
            createdAt: Date.now(),
            authenticator: 'platform'
        };
        security.biometricEnabled = true;
        autoBiometricAttempted = false;
        await saveDB();
        return true;
    }

    async function saveBiometricSetting() {
        const checkbox = document.getElementById('set-biometric-enabled');
        if(!checkbox) return;

        const security = ensureSecurityShape();
        const deviceId = getDeviceId();
        try {
            if(checkbox.checked) {
                updateBiometricSettingsStatus('انتظر تأكيد بصمة الجهاز...');
                await registerBiometricCredential();
                updateBiometricSettingsStatus('تم تفعيل البصمة على هذا الجهاز وحفظ الإعداد في Firebase.');
                showToast('تم تفعيل الدخول بالبصمة');
            } else {
                delete security.biometricCredentials[deviceId];
                security.biometricEnabled = Object.keys(security.biometricCredentials).length > 0;
                await saveDB();
                autoBiometricAttempted = false;
                updateBiometricSettingsStatus('تم إلغاء البصمة من هذا الجهاز.');
                showToast('تم إلغاء الدخول بالبصمة من هذا الجهاز');
            }
        } catch(error) {
            console.error('Biometric registration error:', error);
            checkbox.checked = hasCurrentDeviceBiometric();
            updateBiometricSettingsStatus(error.message || 'تعذر تفعيل البصمة');
            showToast(error.message || 'تعذر تفعيل البصمة', 'error');
        }
        updateLockBiometricUI();
    }

    async function authenticateWithBiometric(options = {}) {
        const record = getBiometricCredentialRecord();
        if(!hasCurrentDeviceBiometric() || !record?.id) {
            if(!options.silent) {
                showToast(record?.legacy ? 'أعد تفعيل البصمة مرة واحدة من الإعدادات' : 'فعّل البصمة أولاً من الإعدادات', 'error');
            }
            return false;
        }

        if(!isBiometricContextSupported()) {
            if(!options.silent) showToast('البصمة تحتاج رابط HTTPS أو تطبيقاً مثبتاً', 'error');
            return false;
        }
        if(autoBiometricInProgress) return false;

        autoBiometricInProgress = true;
        updateLockBiometricUI();
        try {
            const assertion = await navigator.credentials.get({
                publicKey: {
                    challenge: randomBytes(32),
                    allowCredentials: [{
                        type: 'public-key',
                        id: base64UrlToBytes(record.id),
                        transports: ['internal']
                    }],
                    timeout: 45000,
                    userVerification: 'required'
                },
                mediation: 'optional'
            });

            if(assertion) {
                showBiometricUnlockTransition();
                await waitForTransition(700);
                unlockAppUI();
                setTimeout(clearBiometricUnlockTransition, 350);
                return true;
            }
            return false;
        } catch(error) {
            console.error('Biometric authentication error:', error);
            if(!options.silent && error?.name !== 'NotAllowedError') showToast('لم يتم التحقق من البصمة', 'error');
            return false;
        } finally {
            autoBiometricInProgress = false;
            updateLockBiometricUI();
        }
    }

    function scheduleAutomaticBiometricUnlock() {
        if(appUnlocked || autoBiometricAttempted || autoBiometricInProgress) return;
        if(!hasCurrentDeviceBiometric() || !isBiometricContextSupported()) return;
        autoBiometricAttempted = true;
        setTimeout(() => authenticateWithBiometric({ silent: true }), 350);
    }

    Object.assign(window, {
        openPinLoginModal,
        closePinLoginModal,
        submitPinLogin,
        changeAppPin,
        saveBiometricSetting,
        authenticateWithBiometric
    });

    // Keep security controls synchronized with live Firebase updates without modifying app.js.
    if(typeof refreshSyncedViews === 'function') {
        const originalRefreshSyncedViews = refreshSyncedViews;
        refreshSyncedViews = function(...args) {
            const result = originalRefreshSyncedViews.apply(this, args);
            ensureSecurityShape();
            updateBranding();
            updateLockBiometricUI();
            updateBiometricSettingsStatus();
            scheduleAutomaticBiometricUnlock();
            return result;
        };
    }

    setupPinInputs();
    lockAppUI();

    window.addEventListener('load', async () => {
        await ensureSecurityInitialized({ save: false });
        updateBranding();
        updateLockBiometricUI();
        updateBiometricSettingsStatus();
        scheduleAutomaticBiometricUnlock();

        // Firebase is initialized by app.js. Re-check after its first synchronization.
        setTimeout(async () => {
            await ensureSecurityInitialized({ save: true });
            updateBiometricSettingsStatus();
            scheduleAutomaticBiometricUnlock();
        }, 1200);
        setTimeout(scheduleAutomaticBiometricUnlock, 3000);
    });
})();
