'use strict';
/**
 * AES-256-GCM encryption for sensitive PII (SSN, ID images, DOB)
 * Each encrypted value is stored as: iv:authTag:ciphertext (all hex-encoded)
 */
const crypto = require('crypto');

const ALGO = 'aes-256-gcm';
const KEY  = Buffer.from(process.env.ENCRYPTION_KEY || '', 'hex');

function getKey() {
  if (KEY.length !== 32) {
    throw new Error('ENCRYPTION_KEY must be a 64-char hex string (32 bytes)');
  }
  return KEY;
}

/**
 * Encrypt a string or Buffer. Returns hex string: iv:authTag:ciphertext
 */
function encrypt(value) {
  if (value === null || value === undefined || value === '') return value;
  const key = getKey();
  const iv  = crypto.randomBytes(12); // 96-bit IV for GCM
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  
  let encrypted;
  if (Buffer.isBuffer(value)) {
    encrypted = Buffer.concat([cipher.update(value), cipher.final()]);
  } else {
    encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
  }
  
  const authTag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted.toString('hex');
}

/**
 * Decrypt a hex string produced by encrypt(). Returns string or Buffer.
 * Pass returnBuffer=true for binary data (ID images).
 */
function decrypt(encoded, returnBuffer = false) {
  if (!encoded || typeof encoded !== 'string' || !encoded.includes(':')) return encoded;
  const key = getKey();
  const parts = encoded.split(':');
  if (parts.length !== 3) return encoded; // not encrypted, return as-is
  const [ivHex, authTagHex, cipherHex] = parts;
  const iv       = Buffer.from(ivHex, 'hex');
  const authTag  = Buffer.from(authTagHex, 'hex');
  const cipher   = Buffer.from(cipherHex, 'hex');
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(cipher), decipher.final()]);
  return returnBuffer ? decrypted : decrypted.toString('utf8');
}

/**
 * Returns true if a value looks like an encrypted blob
 */
function isEncrypted(value) {
  if (!value || typeof value !== 'string') return false;
  const parts = value.split(':');
  return parts.length === 3 && parts[0].length === 24; // 12-byte IV = 24 hex chars
}

module.exports = { encrypt, decrypt, isEncrypted };
