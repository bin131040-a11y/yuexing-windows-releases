import { createHash, createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const repository = process.env.RELEASE_REPOSITORY;
const version = process.env.RELEASE_VERSION;
const expectedHash = process.env.CANDIDATE_SHA256;
const config = JSON.parse(readFileSync('release-channel.json', 'utf8'));
if (repository !== config.repository || !/^\d{1,5}(\.\d{1,5}){3}$/.test(version) || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error('Invalid publish identity');
const tag = 'v' + version;
const gh = args => execFileSync('gh', [...args, '--repo', repository], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 8 * 1024 * 1024 });
const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
const candidate = JSON.parse(gh(['release', 'view', tag, '--json', 'isDraft,body,assets']));
if (!candidate.isDraft) throw new Error('Release is already published; use a new version');
try {
  const latest = JSON.parse(gh(['release', 'view', '--json', 'tagName'])).tagName.replace(/^v/, '').split('.').map(Number);
  const incoming = version.split('.').map(Number);
  if (latest.length === 4) {
    const index = incoming.findIndex((n, i) => n !== latest[i]);
    if (index < 0 || incoming[index] <= latest[index]) throw new Error('Release version must increase');
  }
} catch (e) { if (!String(e.stderr ?? '').includes('release not found')) throw e; }
mkdirSync('incoming');gh(['release', 'download', tag, '--pattern', 'candidate.zip', '--dir', 'incoming']);
if (hash('incoming/candidate.zip') !== expectedHash) throw new Error('Candidate hash does not match local validation');
execFileSync('python3', ['pack-update.py', 'extract', 'incoming/candidate.zip', 'package'], {stdio:'inherit'});
const bundle = JSON.parse(readFileSync('package/bundle/windows-delivery.json', 'utf8'));
if (bundle.contract !== 'YUEXING_WINDOWS_DELIVERY_V1' || bundle.onlineUpdateVersion !== version || bundle.localFreeze !== false) throw new Error('Bundle version or contract mismatch');
const desktopConfig = JSON.parse(readFileSync('package/bundle/desktop/online-update.json', 'utf8'));
if (desktopConfig.publicKey !== config.publicKey || desktopConfig.feedUrl !== config.feedUrl || desktopConfig.version !== version) throw new Error('Installed updater identity mismatch');
const expected = new Map(bundle.files.map(f => [f.path, f]));
let count = 0;
function verifyTree(dir, rel = '') {
  for (const name of readdirSync(dir)) {
    const file = path.join(dir, name), key = rel + name;
    if (statSync(file).isDirectory()) { verifyTree(file, key + '/'); continue; }
    if (['windows-delivery.json', '安装月星.exe'].includes(key)) continue;
    const metadata = expected.get(key);
    if (!metadata || statSync(file).size !== metadata.sizeBytes || hash(file) !== metadata.sha256) throw new Error('Payload mismatch: ' + key);
    count++;
  }
}
verifyTree('package/bundle');
if (count !== expected.size || expected.size !== bundle.files.length) throw new Error('Payload inventory count mismatch');
const key = createPrivateKey(process.env.YUEXING_UPDATE_PRIVATE_KEY);
delete process.env.YUEXING_UPDATE_PRIVATE_KEY;
if (createPublicKey(key).export({format:'der', type:'spki'}).subarray(-32).toString('base64') !== config.publicKey) throw new Error('Cloud signing key mismatch');
const manifest = Buffer.from(JSON.stringify({contract:'YUEXING_SIGNED_UPDATE_V1',product:'yuexing-windows',channel:config.channel,version,
  bundleDirectory:'bundle',bundleManifestSha256:hash('package/bundle/windows-delivery.json'),setupSha256:hash('package/bundle/安装月星.exe'),
  sourceCommit:bundle.commit,installerSourceCommit:bundle.installerSourceCommit,publishedAt:new Date().toISOString()}) + '\n');
writeFileSync('package/signed-update.json',manifest);writeFileSync('package/signed-update.sig',sign(null,manifest,key).toString('base64'));
execFileSync('python3',['pack-update.py','zip','package','update.zip'],{stdio:'inherit'});
const archive=readFileSync('update.zip'), signature=sign(null,archive,key).toString('base64');
writeFileSync('update.zip.sha256',hash('update.zip')+'  update.zip\n');
const escape=s=>s.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
const notes=escape(candidate.body || '功能改进与问题修复，保留原账号和业务数据。');
const url='https://github.com/'+repository+'/releases/download/'+tag+'/update.zip';
const appcast=`<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0" xmlns:sparkle="http://www.andymatuschak.org/xml-namespaces/sparkle"><channel><title>月星平台更新</title><language>zh_CN</language><item><title>月星平台 ${version}</title><sparkle:version>${version}</sparkle:version><description><![CDATA[<p>更新前请保存正在录入的内容。更新会保留原账号、业务数据、附件和配置，完成后自动打开。</p><p>${notes.replaceAll('\n','<br/>')}</p>]]></description><pubDate>${new Date().toUTCString()}</pubDate><enclosure url="${url}" length="${archive.length}" type="application/zip" sparkle:version="${version}" sparkle:os="windows-x64" sparkle:edSignature="${signature}"/></item></channel></rss>\n`;
writeFileSync('appcast.xml',appcast);
writeFileSync('release-proof.json',JSON.stringify({version,candidateSha256:expectedHash,updateSha256:hash('update.zip'),sizeBytes:archive.length,
  bundleManifestSha256:hash('package/bundle/windows-delivery.json'),verifiedFiles:count,signature,publicKey:config.publicKey,sourceCommit:bundle.commit,at:new Date().toISOString()},null,2)+'\n');
// Assets remain a draft until every signed file is present. Updating latest is the final action.
gh(['release','upload',tag,'update.zip','update.zip.sha256','appcast.xml','release-proof.json','--clobber']);
gh(['release','delete-asset',tag,'candidate.zip','--yes']);
gh(['release','edit',tag,'--draft=false','--latest']);
console.log('SIGNED_WINDOWS_RELEASE_PUBLISHED '+tag+' files='+count);
