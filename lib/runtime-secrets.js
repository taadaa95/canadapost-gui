'use strict';

async function readJsonStream(stream, { maxBytes = 64 * 1024, timeoutMs = 5000 } = {}) {
  const chunks = [];
  let total = 0;

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => finish(new Error('Timed out while reading protected runtime credentials.')), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    stream.on('data', chunk => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.length;
      if (total > maxBytes) {
        finish(new Error('Protected runtime credential payload was too large.'));
        stream.destroy?.();
        return;
      }
      chunks.push(buffer);
    });
    stream.once('error', error => finish(error));
    stream.once('end', () => {
      try {
        finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (error) {
        finish(new Error(`Could not decode protected runtime credentials: ${error.message}`));
      }
    });
    stream.resume?.();
  });
}

async function readRuntimeSecrets({ env = process.env, stream = process.stdin } = {}) {
  if (String(env.CANADAPOST_SECRETS_STDIN || '') !== '1') {
    const result = { username: String(env.CANADAPOST_USERNAME || ''), password: String(env.CANADAPOST_PASSWORD || '') };
    if (env.CANADAPOST_TRACKING_CLIENT_ID) result.clientId = String(env.CANADAPOST_TRACKING_CLIENT_ID);
    if (env.CANADAPOST_TRACKING_CLIENT_SECRET) result.clientSecret = String(env.CANADAPOST_TRACKING_CLIENT_SECRET);
    if (env.CANADAPOST_API_CREDENTIAL_ENVIRONMENT) result.environment = String(env.CANADAPOST_API_CREDENTIAL_ENVIRONMENT);
    if (env.CANADAPOST_USERNAME_SOURCE) result.usernameSource = String(env.CANADAPOST_USERNAME_SOURCE);
    if (env.CANADAPOST_PASSWORD_SOURCE) result.passwordSource = String(env.CANADAPOST_PASSWORD_SOURCE);
    return result;
  }

  const value = await readJsonStream(stream);
  const result = { username: String(value.username || ''), password: String(value.password || '') };
  if (value.clientId) result.clientId = String(value.clientId);
  if (value.clientSecret) result.clientSecret = String(value.clientSecret);
  if (value.environment) result.environment = String(value.environment);
  if (value.usernameSource) result.usernameSource = String(value.usernameSource);
  if (value.passwordSource) result.passwordSource = String(value.passwordSource);
  return result;
}

module.exports = { readJsonStream, readRuntimeSecrets };
