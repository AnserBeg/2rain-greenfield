// The fork uses Node's TypeScript reader so it needs no compiler subprocess.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (
        error.code === 'ERR_MODULE_NOT_FOUND' &&
        specifier.startsWith('.') &&
        specifier.endsWith('.js')
      ) {
        return next(specifier.slice(0, -3) + '.ts', context);
      }
      throw error;
    }
  },
});
