/**
 * @format
 */

// React Native's built-in URL shim intentionally omits URL properties such as
// `protocol`, `origin`, and `hostname`. The dApp browser relies on these
// properties for navigation and provider origin checks, so install a complete
// WHATWG-compatible implementation before the app (and its modules) loads.
import 'react-native-url-polyfill/auto';

import {AppRegistry} from 'react-native';
import App from './App';
import {name as appName} from './app.json';
import {startRpcCatalogService} from './src/native/rpc-catalog-service';
import {rpcPreferencesStorage} from './src/native/rpc-preferences-storage';

startRpcCatalogService();
// Restore the user's public RPC routing preference before the first wallet
// request; a storage failure simply leaves automatic selection active.
void rpcPreferencesStorage.read();
AppRegistry.registerComponent(appName, () => App);
