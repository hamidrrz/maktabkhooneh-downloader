import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';

export async function readEnvironment(file = new URL('../.env',import.meta.url), env = process.env) {
  let local = {};
  try {
    local = parseEnv(await readFile(file,'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Could not read the local .env file.');
  }
  return {
    email:(env.MK_EMAIL ?? local.MK_EMAIL ?? '').trim(),
    password:env.MK_PASSWORD ?? local.MK_PASSWORD ?? '',
    autoLogin:/^true$/i.test(env.MK_AUTO_LOGIN ?? local.MK_AUTO_LOGIN ?? ''),
    output:(env.MK_OUTPUT_DIR ?? local.MK_OUTPUT_DIR)?.trim() || undefined
  };
}
