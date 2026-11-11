import { createHash, sign } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const sha = p => createHash('sha256').update(readFileSync(p)).digest('hex');
const json = p => JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''));
export function prepareSignedUpdate(folder, config, version, key) {
  const root = path.join(folder, 'bundle');
  let manifest, expected, count = 0;
  const metadata = new Set(['web-update.json', 'bundle-reuse.json']);
  if (existsSync(path.join(root, 'web-update.json'))) {
    manifest = json(path.join(root, 'web-update.json'));
    if (manifest.contract !== 'YUEXING_SIGNED_WEB_UPDATE_V1' || manifest.version !== version || manifest.channel !== config.channel ||
        !Array.isArray(manifest.files) || manifest.files.length > 2000) throw new Error('Invalid web candidate');
    expected = new Map(manifest.files.filter(f => !f.reuse).map(f => ['web/' + f.path, { sizeBytes: f.size, sha256: f.sha256 }]));
  } else {
    const bundle = json(path.join(root, 'windows-delivery.json'));
    if (bundle.contract !== 'YUEXING_WINDOWS_DELIVERY_V1' || bundle.onlineUpdateVersion !== version || bundle.localFreeze !== false) throw new Error('Invalid bundle candidate');
    const desktop = json(path.join(root, 'desktop/online-update.json'));
    if (desktop.publicKey !== config.publicKey || desktop.feedUrl !== config.feedUrl || desktop.version !== version) throw new Error('Installed updater identity mismatch');
    const reuse = existsSync(path.join(root, 'bundle-reuse.json')) ? json(path.join(root, 'bundle-reuse.json')) : null;
    if (reuse && (!Array.isArray(reuse.reusedFiles) || reuse.reusedFiles.some(p => !/^(runtimes|desktop|installer)\//.test(p)))) throw new Error('Invalid component reuse');
    const reused = new Set(reuse?.reusedFiles ?? []);
    expected = new Map(bundle.files.filter(f => !reused.has(f.path)).map(f => [f.path, f]));
    if ([...reused].some(name => !bundle.files.some(f => f.path === name))) throw new Error('Unknown reused file');
    metadata.add('windows-delivery.json'); metadata.add('安装月星.exe');
    manifest = { contract: 'YUEXING_SIGNED_UPDATE_V1', product: 'yuexing-windows', channel: config.channel, version,
      bundleDirectory: 'bundle', bundleManifestSha256: sha(path.join(root, 'windows-delivery.json')), setupSha256: sha(path.join(root, '安装月星.exe')),
      sourceCommit: bundle.commit, installerSourceCommit: bundle.installerSourceCommit, publishedAt: new Date().toISOString(), ...(reuse ? {baseVersion: reuse.baseVersion, reusedFiles: reuse.reusedFiles} : {}) };
  }
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir)) {
      const file = path.join(dir, name), relative = prefix + name, stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error('Linked update file');
      if (stat.isDirectory()) { walk(file, relative + '/'); continue; }
      if (metadata.has(relative)) continue;
      const entry = expected.get(relative);
      if (!entry || stat.size !== entry.sizeBytes || sha(file) !== entry.sha256) throw new Error('Update file mismatch: ' + relative);
      count++;
    }
  }
  walk(root);
  if (count !== expected.size) throw new Error('Missing candidate files');
  const bytes = Buffer.from(JSON.stringify(manifest) + '\n');
  writeFileSync(path.join(folder, 'signed-update.json'), bytes);
  writeFileSync(path.join(folder, 'signed-update.sig'), sign(null, bytes, key).toString('base64'));
  return { manifest, count };
}
