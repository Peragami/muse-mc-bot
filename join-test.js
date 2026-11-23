// One-shot join test: connect as Muze, wait for spawn, report, disconnect.
const http = require('http');
const net = require('net');
const { URL } = require('url');
const mineflayer = require('mineflayer');
const HOST = process.env.MC_HOST || '127.0.0.1';
const PORT = parseInt(process.env.MC_PORT || '25565', 10);
const USERNAME = process.env.MC_USER || 'Muze';
const PROXY = process.env.MC_PROXY || '';
function connectViaProxy(client) {
  const u = new URL(PROXY);
  const headers = [`CONNECT ${HOST}:${PORT} HTTP/1.1`, `Host: ${HOST}:${PORT}`];
  if (u.username) {
    const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
    headers.push(`Proxy-Authorization: Basic ${auth}`);
  }
  const socket = net.connect(parseInt(u.port, 10), u.hostname);
  let buf = Buffer.alloc(0);
  let done = false;
  socket.on('connect', () => socket.write(headers.join('\r\n') + '\r\n\r\n'));
  socket.on('data', (chunk) => {
    if (done) return;
    buf = Buffer.concat([buf, chunk]);
    const idx = buf.indexOf('\r\n\r\n');
    if (idx === -1) return;
    done = true;
    const head = buf.slice(0, idx).toString('latin1');
    const rest = buf.slice(idx + 4);
    if (!/^HTTP\/1\.\d 200/.test(head)) { client.emit('error', new Error(`proxy CONNECT failed: ${head.split('\r\n')[0]}`)); socket.destroy(); return; }
    socket.removeAllListeners('data');
    if (rest.length) socket.unshift(rest);
    client.setSocket(socket); client.emit('connect');
  });
  socket.on('error', (err) => { if (!done) client.emit('error', err); });
}
const options = { host: HOST, port: PORT, username: USERNAME, version: '1.21.4' };
if (PROXY) options.connect = connectViaProxy;
const bot = mineflayer.createBot(options);
const timer = setTimeout(() => { console.log('TEST_TIMEOUT'); process.exit(2); }, 45000);
bot.once('spawn', () => {
  const p = bot.entity.position;
  console.log(`JOIN_OK spawned at ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)} health=${bot.health} food=${bot.food}`);
  setTimeout(() => { bot.quit(); console.log('TEST_PASS'); process.exit(0); }, 3000);
});
bot.once('kicked', (reason) => { console.log('KICKED:', JSON.stringify(reason)); process.exit(1); });
bot.once('error', (err) => { console.log('ERROR:', err.message); process.exit(1); });
bot.once('end', (reason) => { console.log('END:', reason); });
