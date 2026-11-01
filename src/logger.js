import fs from 'node:fs';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

let currentLevel = LEVELS.info;
let logStream = null;
let logPath = null;

export function initLogger({ level = 'info', file = null } = {}) {
  currentLevel = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  if (file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    logStream = fs.createWriteStream(file, { flags: 'a' });
    logPath = file;
  }
}

function fmt(v) {
  if (v instanceof Error) return v.stack || `${v.name}: ${v.message}`;
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function emit(level, scope, args) {
  if ((LEVELS[level] ?? 20) < currentLevel) return;
  const ts = new Date().toISOString();
  const line = `${ts} ${level.toUpperCase().padEnd(5)} [${scope}] ${args.map(fmt).join(' ')}`;
  if (level === 'error' || level === 'warn') console.error(line);
  else console.log(line);
  if (logStream) logStream.write(line + '\n');
}

export function createLogger(scope) {
  return {
    debug: (...a) => emit('debug', scope, a),
    info: (...a) => emit('info', scope, a),
    warn: (...a) => emit('warn', scope, a),
    error: (...a) => emit('error', scope, a),
    child: (sub) => createLogger(`${scope}:${sub}`),
  };
}

export function logFilePath() {
  return logPath;
}

export const logger = createLogger('core');
