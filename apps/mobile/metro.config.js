// Metro para monorepo: @releva/core se consume desde el código fuente TypeScript.
const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
const corePath = path.resolve(__dirname, '../../packages/core');

// El núcleo usa imports ESM con extensión .js (requerido por Node); Metro los resuelve al .ts.
const upstream = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.startsWith('.') && moduleName.endsWith('.js') && context.originModulePath.startsWith(corePath)) {
    return context.resolveRequest(context, moduleName.slice(0, -3), platform);
  }
  return upstream ? upstream(context, moduleName, platform) : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
