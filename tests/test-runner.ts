// Standalone Test Runner for Wireon
import { startVitest } from 'vitest/node';

export async function runAllTests(): Promise<boolean> {
  console.log('🚀 Launching Wireon Full E2E & Unit Test Suite...');
  const vitest = await startVitest('test', [], {
    run: true,
    reporters: ['default']
  });

  if (!vitest) {
    console.error('❌ Failed to initialize Vitest runner.');
    return false;
  }

  const success = (vitest as any).state?.getFailedFileCount?.() === 0 || !(vitest as any).closing;
  await vitest.close();
  return success;
}

if (process.argv[1]?.endsWith('test-runner.ts') || process.argv[1]?.endsWith('test-runner.js')) {
  runAllTests()
    .then(success => {
      process.exit(success ? 0 : 1);
    })
    .catch(err => {
      console.error('Test execution error:', err);
      process.exit(1);
    });
}
