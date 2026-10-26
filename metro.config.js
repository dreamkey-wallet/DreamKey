const {getDefaultConfig, mergeConfig} = require('@react-native/metro-config');
const {resolve} = require('metro-resolver');

/**
 * Metro configuration
 * https://reactnative.dev/docs/metro
 *
 * @type {import('metro-config').MetroConfig}
 */
const config = {
  resolver: {
    // TypeScript uses NodeNext-style `.js` specifiers so the same source can
    // be consumed by Node tooling. Metro resolves the actual `.ts/.tsx`
    // source through this small compatibility fallback.
    resolveRequest(context, moduleName, platform) {
      try {
        return resolve(context, moduleName, platform);
      } catch (error) {
        if (!moduleName.endsWith('.js')) throw error;
        const withoutExtension = moduleName.slice(0, -3);
        for (const candidate of [`${withoutExtension}.ts`, `${withoutExtension}.tsx`]) {
          try {
            return resolve(context, candidate, platform);
          } catch {
            // Continue until the TypeScript source extension is found.
          }
        }
        throw error;
      }
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
