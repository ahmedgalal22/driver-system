/**
 * auth.js — consolidated module
 * Internal structure: Constants → State → Services → Helpers → Rendering → Events → Public API → Boot
 */

import { AuthRepository } from './services/authRepository.js';
import { DB } from './database.js';


// ========================================
// Services — AuthService
// ========================================

const SESSION_KEY = 'session';

function _assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`[Auth] ${label} is required`);
  }
  return value;
}

function _assertCrypto() {
  if (!crypto || !crypto.subtle) {
    throw new Error('[Auth] Web Crypto API is required');
  }
}

function _toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

function _uuid() {
  if (!crypto || typeof crypto.randomUUID !== 'function') {
    throw new Error('[Auth] crypto.randomUUID is required');
  }
  return crypto.randomUUID();
}

async function hashPassword(password) {
  const clean = _assertString(password, 'password');
  _assertCrypto();
  const encoded = new TextEncoder().encode(clean);
  const buffer = await crypto.subtle.digest('SHA-256', encoded);
  return _toHex(buffer);
}

async function verifyPassword(password, hash) {
  const clean = _assertString(password, 'password');
  if (typeof hash !== 'string' || hash.trim() === '') {
    throw new Error('[Auth] password hash is required');
  }
  const expected = await hashPassword(clean);
  return expected === hash;
}

async function initialize() {
  await DB.init();
}

async function createInitialAdmin() {
  // Never replace or reactivate a stored admin, including a soft-deleted one.
  const existing = await DB.findByFields('users', { username: 'admin' }, { includeDeleted: true });
  if (existing.length > 0) return null;

  const adminPayload = {
    id: _uuid(),
    username: 'admin',
    password_hash: await hashPassword('admin123'),
  };
  await AuthRepository.saveUser(adminPayload);
  return adminPayload;
}

async function login(username, password) {
  const cleanUsername = _assertString(username, 'username');
  const cleanPassword = _assertString(password, 'password');

  await initialize();
  if (cleanUsername !== 'admin') throw new Error('Invalid credentials');
  await createInitialAdmin();

  const user = await AuthRepository.getUser(cleanUsername);

  if (!user) {
    throw new Error('Invalid credentials');
  }

  const ok = await verifyPassword(cleanPassword, user.password_hash);
  if (!ok) {
    throw new Error('Invalid credentials');
  }

  localStorage.setItem(SESSION_KEY, JSON.stringify({
    username: user.username,
  }));

  return user;
}

function logout() {
  localStorage.removeItem(SESSION_KEY);
  if (typeof sessionStorage !== 'undefined') {
    sessionStorage.clear();
  }
}

function getSession() {
  const raw = localStorage.getItem(SESSION_KEY);
  if (!raw) return null;

  let parsed = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object') return null;
  if (typeof parsed.username !== 'string' || parsed.username.trim() === '') return null;
  if (parsed.username !== 'admin') return null;

  return {
    username: parsed.username,
  };
}

function requireSession() {
  const session = getSession();
  if (!session) {
    throw new Error('Session required');
  }
  return session;
}

const AuthService = Object.freeze({
  hashPassword,
  verifyPassword,
  initialize,
  createInitialAdmin,
  login,
  logout,
  getSession,
  requireSession,
});



// ========================================
// Module — AuthModule
// ========================================

const AuthModule = Object.freeze({
  initialize: () => AuthService.initialize(),
  login: (username, password) => AuthService.login(username, password),
  logout: () => AuthService.logout(),
  getSession: () => AuthService.getSession(),
  requireSession: () => AuthService.requireSession(),
});



// ========================================
// Helpers
// ========================================

// ========================================
// Login Page — Events / Boot
// ========================================

function _byId(id) {
  return document.getElementById(id);
}

function _setError(message) {
  const errorEl = _byId('error');
  if (!errorEl) return;
  if (!message) {
    errorEl.textContent = '';
    return;
  }
  errorEl.textContent = message;
}

async function _handleSubmit(event) {
  event.preventDefault();
  _setError('');

  const username = _byId('username')?.value;
  const password = _byId('password')?.value;

  try {
    await AuthModule.login(username, password);
    window.location.href = 'index.html';
  } catch (err) {
    const message = err?.message;
    if (!message) throw err;
    _setError(message);
  }
}

async function bootLoginPage() {
  if (typeof document === 'undefined') return;
  const form = _byId('loginForm');
  if (!form) return;

  form.addEventListener('submit', _handleSubmit);
  try {
    await initialize();
    const session = AuthModule.getSession();
    if (session) {
      window.location.href = 'index.html';
      return;
    }
  } catch (err) {
    _setError(err?.message || 'تعذر تهيئة تسجيل الدخول');
  }
}

bootLoginPage();



// ========================================
// Public API
// ========================================

export { AuthService, AuthModule };
