import { loadConfig } from './core/config.js';
import { logger } from './utils/logger.js';

export async function main() {
  try {
    logger.info('Starting Forge Orchestrator...');

    const config = loadConfig();
    logger.info({ config }, 'Configuration loaded successfully');

    logger.info('Forge Orchestrator initialized');
  } catch (error) {
    logger.error({ error }, 'Failed to start Forge Orchestrator');
    process.exit(1);
  }
}

// Run if this is the main module
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    logger.error({ error }, 'Unhandled error');
    process.exit(1);
  });
}
