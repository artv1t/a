
const winston = require('winston');
const fs = require('fs');
const path = require('path');

class Logger {
  constructor() {
    this.sessionId = this.generateSessionId();
    this.sessionDir = path.join(process.cwd(), 'logs', `session_${this.sessionId}`);
    this.ensureSessionDir();
    this.setupLoggers();
  }

  generateSessionId() {
    const now = new Date();
    return now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  }

  ensureSessionDir() {
    if (!fs.existsSync(this.sessionDir)) {
      fs.mkdirSync(this.sessionDir, { recursive: true });
    }
  }

  setupLoggers() {
    const logFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    );

    const textFormat = winston.format.combine(
      winston.format.timestamp(),
      winston.format.printf(({ timestamp, level, message, ...meta }) => {
        const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
        return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
      })
    );

    this.eventsLogger = winston.createLogger({
      level: 'info',
      format: logFormat,
      transports: [
        new winston.transports.File({
          filename: path.join(this.sessionDir, 'events.log'),
          maxsize: 50 * 1024 * 1024, // 50MB
          maxFiles: 5
        })
      ]
    });

    this.errorLogger = winston.createLogger({
      level: 'error',
      format: logFormat,
      transports: [
        new winston.transports.File({
          filename: path.join(this.sessionDir, 'errors.log'),
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 3
        })
      ]
    });

    this.healthLogger = winston.createLogger({
      level: 'info',
      format: logFormat,
      transports: [
        new winston.transports.File({
          filename: path.join(this.sessionDir, 'health.log'),
          maxsize: 10 * 1024 * 1024, // 10MB
          maxFiles: 3
        })
      ]
    });

    this.mainLogger = winston.createLogger({
      level: process.env.LOG_LEVEL || 'info',
      format: logFormat,
      transports: [
        new winston.transports.File({
          filename: path.join(this.sessionDir, 'main.log'),
          maxsize: 20 * 1024 * 1024, // 20MB
          maxFiles: 3
        }),
        new winston.transports.Console({
          format: textFormat,
          level: 'info'
        })
      ]
    });
  }

  logEvent(signature, mints, metadata = {}) {
    this.eventsLogger.info('helius_event', {
      signature,
      mints,
      timestamp: Date.now(),
      ...metadata
    });
  }

  logBatch(batchSize, processingTime, metadata = {}) {
    this.eventsLogger.info('batch_processed', {
      batchSize,
      processingTime,
      timestamp: Date.now(),
      ...metadata
    });
  }

  logDedup(total, filtered, cacheSize) {
    this.eventsLogger.info('dedup_stats', {
      total,
      filtered,
      cacheSize,
      timestamp: Date.now()
    });
  }

  logHealth(event, data = {}) {
    this.healthLogger.info(event, {
      timestamp: Date.now(),
      ...data
    });
  }

  logError(error, context = {}) {
    this.errorLogger.error('error', {
      message: error.message,
      stack: error.stack,
      timestamp: Date.now(),
      ...context
    });
  }

  info(message, meta = {}) {
    this.mainLogger.info(message, meta);
  }

  warn(message, meta = {}) {
    this.mainLogger.warn(message, meta);
  }

  error(message, meta = {}) {
    this.mainLogger.error(message, meta);
  }

  debug(message, meta = {}) {
    this.mainLogger.debug(message, meta);
  }

  getSessionDir() {
    return this.sessionDir;
  }

  getSessionId() {
    return this.sessionId;
  }
}

const logger = new Logger();

module.exports = logger;
