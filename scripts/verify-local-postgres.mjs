// Explicit local gate. Never reads production database URLs or provisions a service.
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomBytes } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
const root = path.resolve(import.meta.dirname, '..');
const option = name => { const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1]; };
const defaultBin = path.join(root, '.runtime/postgres-real-verification/root/usr/lib/postgresql/17/bin');
const bin = path.resolve(option('--bin') || defaultBin);
const privateMode = { mode: 0o600 };
function command(program, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(program, args, { cwd: root, env: { PATH: process.env.PATH, LANG: 'C.UTF-8' }, ...options });
    let stdout = '', stderr = '';
    child.stdout?.on('data', chunk => stdout += chunk);
    child.stderr?.on('data', chunk => stderr += chunk);
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve({ stdout, stderr }) : reject(Error(`${path.basename(program)} exited ${code}: ${stderr.slice(-1200)}`)));
  });
}
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}
let stage, started = false;
try {
  const version = (await command(path.join(bin, 'postgres'), ['--version'])).stdout.trim();
  await fs.mkdir(path.join(root, '.runtime'), { recursive: true });
  stage = await fs.mkdtemp(path.join(root, '.runtime/postgres-selected-role-'));
  const data = path.join(stage, 'data');
  const clusterName = path.basename(stage);
  const credentials = { bootstrap: randomBytes(32).toString('hex'), operator: randomBytes(32).toString('hex'), runtime: randomBytes(32).toString('hex') };
  await fs.writeFile(path.join(stage, 'bootstrap-password'), credentials.bootstrap, privateMode);
  const init = ['-D', data, '--username=pvme_bootstrap', '--pwfile='+path.join(stage, 'bootstrap-password'), '--auth-host=scram-sha-256', '--auth-local=scram-sha-256', '--no-locale', '--encoding=UTF8'];
  const share = path.resolve(bin, '../../../../share/postgresql/'+/PostgreSQL\) (\d+)/.exec(version)?.[1]);
  try { await fs.access(path.join(share, 'postgres.bki')); init.push('-L', share); } catch {}
  await command(path.join(bin, 'initdb'), init);
  const ca = path.join(stage, 'ca.crt');
  await command('openssl', ['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj','/CN=PvME local verification CA','-addext','basicConstraints=critical,CA:TRUE','-addext','keyUsage=critical,keyCertSign,cRLSign','-keyout',path.join(stage,'ca.key'),'-out',ca]);
  await command('openssl', ['req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=localhost','-keyout',path.join(stage,'server.key'),'-out',path.join(stage,'server.csr')]);
  await fs.writeFile(path.join(stage, 'server.ext'), 'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1\nextendedKeyUsage=serverAuth\n');
  await command('openssl', ['x509','-req','-in',path.join(stage,'server.csr'),'-CA',ca,'-CAkey',path.join(stage,'ca.key'),'-CAcreateserial','-days','1','-extfile',path.join(stage,'server.ext'),'-out',path.join(stage,'server.crt')]);
  await fs.chmod(path.join(stage, 'server.key'), 0o600);
  const port = await freePort();
  const quoted = value => "'"+value.replaceAll("'", "''")+"'";
  await fs.appendFile(path.join(data, 'postgresql.conf'), `\nlisten_addresses='localhost'\ncluster_name=${quoted(clusterName)}\nport=${port}\nunix_socket_directories=''\nssl=on\nssl_cert_file=${quoted(path.join(stage,'server.crt'))}\nssl_key_file=${quoted(path.join(stage,'server.key'))}\nssl_min_protocol_version='TLSv1.2'\nmax_connections=20\nshared_buffers='32MB'\npassword_encryption='scram-sha-256'\n`);
  await fs.writeFile(path.join(data, 'pg_hba.conf'), 'local all all scram-sha-256\nhostnossl all all 127.0.0.1/32 reject\nhostnossl all all ::1/128 reject\nhostssl all all 127.0.0.1/32 scram-sha-256\nhostssl all all ::1/128 scram-sha-256\n');
  await command(path.join(bin, 'pg_ctl'), ['-D',data,'-l',path.join(stage,'server.log'),'-w','-t','20','start']);
  started = true;
  const configPath = path.join(stage, 'local-connection.json');
  await fs.writeFile(configPath, JSON.stringify({ host:'localhost', port, clusterName, credentials, version, report:path.join(stage,'report.json') }), privateMode);
  const childEnv = { PATH: process.env.PATH, LANG:'C.UTF-8', NODE_EXTRA_CA_CERTS:ca };
  const verified = await command(process.execPath, [path.join(root,'server/tests/real-postgres-verification.mjs'),configPath], { env:childEnv });
  process.stdout.write(verified.stdout);
  // A separate process has no extra CA trust: the unchanged production client
  // must refuse this otherwise valid local server certificate.
  const negative = await command(process.execPath, [path.join(root,'server/tests/real-postgres-verification.mjs'),'--untrusted',configPath], { env:{ PATH:process.env.PATH, LANG:'C.UTF-8' } });
  process.stdout.write(negative.stdout);
  const report = JSON.parse(await fs.readFile(path.join(stage,'report.json'),'utf8'));
  report.untrustedCertificateRejected = true;
  report.packageVersion = version;
  report.sourceTree = execFileSync('git',['rev-parse','HEAD^{tree}'],{cwd:root,encoding:'utf8',env:{PATH:process.env.PATH,LANG:'C.UTF-8'}}).trim();
  await fs.writeFile(path.join(stage,'report.json'), JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({ result:'passed', report:path.join(stage,'report.json'), checks:report.checks.length, packageVersion:version }));
} catch (error) {
  console.error(JSON.stringify({ result:'failed', message:error.message }));
  process.exitCode = 1;
} finally {
  let serverMayBeRunning = started;
  if (stage && !serverMayBeRunning) { try { await fs.access(path.join(stage,'data/postmaster.pid')); serverMayBeRunning = true; } catch {} }
  if (serverMayBeRunning) {
    try { await command(path.join(bin,'pg_ctl'),['-D',path.join(stage,'data'),'-m','fast','-w','-t','20','stop']); }
    catch (error) { console.error(JSON.stringify({ result:'cleanup_failed', message:error.message })); process.exitCode = 1; }
  }
  if (stage) for (const name of ['local-connection.json','bootstrap-password','ca.key','server.key']) await fs.rm(path.join(stage,name),{force:true});
}
