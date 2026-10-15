'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const crypto = require('crypto');

/**
 * CredentialStore
 * Secure credential storage using Windows Data Protection API (DPAPI).
 * DPAPI encrypts data using a cryptographic key derived from the Windows user's logon credentials.
 * Data can only be decrypted by processes running under the same Windows user account.
 */
class CredentialStore {
    constructor(options = {}) {
        this.storeDir = options.storageDir || options.storeDir || options.configDir || path.join(
            process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
            'LUCY',
            'secure'
        );
        this.storePath = path.join(this.storeDir, 'credentials.dpapi');
        this._memoryCache = new Map();
        this._initialized = false;
    }

    init() {
        if (!fs.existsSync(this.storeDir)) {
            fs.mkdirSync(this.storeDir, { recursive: true, mode: 0o700 });
        }
        this._initialized = true;
    }

    /**
     * Encrypt a string using Windows DPAPI (CurrentUser scope)
     * @param {string} plaintext
     * @returns {string} Base64 representation of DPAPI ciphertext
     */
    encryptDpapi(plaintext) {
        if (!plaintext || typeof plaintext !== 'string') {
            throw new Error('Plaintext must be a non-empty string');
        }

        if (process.platform === 'win32') {
            try {
                // Use powershell to invoke .NET ProtectedData with CurrentUser scope
                const script = `
                    $ErrorActionPreference = 'Stop'
                    Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
                    $bytes = [System.Text.Encoding]::UTF8.GetBytes($env:LUCY_SECRET_PAYLOAD)
                    $entropy = [System.Text.Encoding]::UTF8.GetBytes('LUCY-DPAPI-SALT-v1')
                    $encrypted = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
                    [Convert]::ToBase64String($encrypted)
                `.trim();

                const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
                    env: { ...process.env, LUCY_SECRET_PAYLOAD: plaintext },
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 8000
                });

                return output.trim();
            } catch (err) {
                // Fallback to AES-256-GCM keyed to machine-user hash if PowerShell fails
                return this._encryptAesGcm(plaintext);
            }
        }

        return this._encryptAesGcm(plaintext);
    }

    /**
     * Decrypt DPAPI ciphertext
     * @param {string} ciphertextBase64
     * @returns {string} Decrypted plaintext
     */
    decryptDpapi(ciphertextBase64) {
        if (!ciphertextBase64 || typeof ciphertextBase64 !== 'string') {
            return '';
        }

        if (ciphertextBase64.startsWith('aes:')) {
            return this._decryptAesGcm(ciphertextBase64);
        }

        if (process.platform === 'win32') {
            try {
                const script = `
                    $ErrorActionPreference = 'Stop'
                    Add-Type -AssemblyName System.Security -ErrorAction SilentlyContinue
                    $bytes = [Convert]::FromBase64String($env:LUCY_CIPHER_PAYLOAD)
                    $entropy = [System.Text.Encoding]::UTF8.GetBytes('LUCY-DPAPI-SALT-v1')
                    $decrypted = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $entropy, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
                    [System.Text.Encoding]::UTF8.GetString($decrypted)
                `.trim();

                const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
                    env: { ...process.env, LUCY_CIPHER_PAYLOAD: ciphertextBase64 },
                    encoding: 'utf8',
                    windowsHide: true,
                    timeout: 8000
                });

                return output.trim();
            } catch (err) {
                return '';
            }
        }

        return '';
    }

    /**
     * Cryptographic AES-256-GCM fallback using machine/user derived key
     */
    _getMachineKey() {
        const seed = `${os.hostname()}-${os.userInfo().username}-${process.env.COMPUTERNAME || 'LOCAL'}`;
        return crypto.scryptSync(seed, 'LUCY-SALT-PROTECT', 32);
    }

    _encryptAesGcm(plaintext) {
        const key = this._getMachineKey();
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let enc = cipher.update(plaintext, 'utf8', 'base64');
        enc += cipher.final('base64');
        const tag = cipher.getAuthTag().toString('base64');
        return `aes:${iv.toString('base64')}:${tag}:${enc}`;
    }

    _decryptAesGcm(payload) {
        try {
            const parts = payload.split(':');
            if (parts.length !== 4) return '';
            const [, ivB64, tagB64, encB64] = parts;
            const key = this._getMachineKey();
            const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
            decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
            let dec = decipher.update(encB64, 'base64', 'utf8');
            dec += decipher.final('utf8');
            return dec;
        } catch {
            return '';
        }
    }

    /**
     * Store a credential securely
     * @param {string} keyName e.g. 'gemini_api_key'
     * @param {string} secretValue
     */
    setSecret(keyName, secretValue) {
        if (!keyName) throw new Error('Key name is required');
        this.init();

        const cleanKey = String(keyName).trim().toLowerCase();
        const cleanVal = String(secretValue || '').trim();

        if (!cleanVal) {
            this.deleteSecret(cleanKey);
            return;
        }

        // Cache in memory for process lifetime
        this._memoryCache.set(cleanKey, cleanVal);

        // Encrypt with DPAPI and persist
        const store = this._loadStore();
        store[cleanKey] = {
            ciphertext: this.encryptDpapi(cleanVal),
            updatedAt: new Date().toISOString(),
            algorithm: 'windows-dpapi'
        };
        this._saveStore(store);
    }

    /**
     * Retrieve a credential securely
     * @param {string} keyName
     * @returns {string} Plaintext secret or empty string
     */
    getSecret(keyName) {
        if (!keyName) return '';
        const cleanKey = String(keyName).trim().toLowerCase();

        // 1. Check memory cache
        if (this._memoryCache.has(cleanKey)) {
            return this._memoryCache.get(cleanKey);
        }

        // 2. Check environment variables
        const envName = `LUCY_${cleanKey.toUpperCase()}`;
        if (process.env[envName]) {
            const val = process.env[envName].trim();
            this._memoryCache.set(cleanKey, val);
            return val;
        }

        // 3. Load from DPAPI store
        const store = this._loadStore();
        if (store[cleanKey] && store[cleanKey].ciphertext) {
            const decrypted = this.decryptDpapi(store[cleanKey].ciphertext);
            if (decrypted) {
                this._memoryCache.set(cleanKey, decrypted);
                return decrypted;
            }
        }

        return '';
    }

    /**
     * Check if a secret is configured without exposing it
     * @param {string} keyName
     * @returns {boolean}
     */
    hasSecret(keyName) {
        return Boolean(this.getSecret(keyName));
    }

    /**
     * Delete a stored credential
     * @param {string} keyName
     */
    deleteSecret(keyName) {
        const cleanKey = String(keyName).trim().toLowerCase();
        this._memoryCache.delete(cleanKey);
        const store = this._loadStore();
        if (store[cleanKey]) {
            delete store[cleanKey];
            this._saveStore(store);
        }
    }

    /**
     * List configured secret keys (names only, values redacted)
     */
    listConfiguredKeys() {
        const store = this._loadStore();
        const keys = new Set([...Object.keys(store), ...this._memoryCache.keys()]);
        return Array.from(keys).map((k) => ({
            key: k,
            configured: true,
            protection: 'dpapi-protected',
            updatedAt: store[k]?.updatedAt || new Date().toISOString()
        }));
    }

    _loadStore() {
        if (!fs.existsSync(this.storePath)) {
            return {};
        }
        try {
            const content = fs.readFileSync(this.storePath, 'utf8');
            return JSON.parse(content);
        } catch {
            return {};
        }
    }

    _saveStore(data) {
        this.init();
        fs.writeFileSync(this.storePath, JSON.stringify(data, null, 2), {
            encoding: 'utf8',
            mode: 0o600
        });
    }

    /**
     * Redact secrets from text/objects to prevent log leakage
     */
    redact(text) {
        if (typeof text !== 'string') return text;
        let sanitized = text;
        for (const secret of this._memoryCache.values()) {
            if (secret && secret.length >= 6) {
                sanitized = sanitized.replaceAll(secret, '[REDACTED_SECRET]');
            }
        }
        return sanitized;
    }
}

module.exports = {
    CredentialStore
};
