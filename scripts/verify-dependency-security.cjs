/* Exercise the patched XML dependency through the CLI consumers and attack input. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { XMLBuilder, XMLParser, XMLValidator } = require('fast-xml-parser');

const root = path.resolve(__dirname, '..');
const parser = new XMLParser({ ignoreAttributes: false });
const manifestPath = path.join(root, 'android/app/src/main/AndroidManifest.xml');
const manifest = fs.readFileSync(manifestPath, 'utf8');
assert.equal(XMLValidator.validate(manifest), true);
assert.equal(parser.parse(manifest).manifest.application.activity['@_android:name'], '.MainActivity');

// Check the actual CLI entry points used by autolinking and iOS scheme selection.
const getMainActivity = require('@react-native-community/cli-platform-android/build/config/getMainActivity').default;
assert.equal(getMainActivity(manifestPath), '.MainActivity');
const { getBuildConfigurationFromXcScheme } = require('@react-native-community/cli-platform-apple/build/tools/getBuildConfigurationFromXcScheme');
assert.equal(getBuildConfigurationFromXcScheme('IndependentWallet', 'Release', path.join(root, 'ios')), 'Debug');

// GHSA-gh4j-gqv2-49f6: hostile delimiters must remain text, never create elements.
const builder = new XMLBuilder({ commentPropName: '#comment', cdataPropName: '#cdata' });
for (const data of [
  { root: { '#comment': '--><injected /> <!--' } },
  { root: { '#cdata': ']]><injected/><![CDATA[' } },
]) {
  const xml = builder.build(data);
  assert.equal(XMLValidator.validate(xml), true);
  assert.ok(!Object.hasOwn(parser.parse(xml).root, 'injected'), 'XML delimiter injection must not create an element');
}
console.log('Dependency security verification passed: Android CLI manifest, iOS scheme parsing, and XML comment/CDATA injection regression. No native build or network access.');
