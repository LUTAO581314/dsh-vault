// Minimal asar reader: list files, or extract one file to stdout.
// usage: node asar-list.js <asar> [--grep <regex>] [--dump <path>]
const fs = require('fs');

function readHeader(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // asar: [u32=4][u32 pickleSize][u32 jsonSize][json...]
  let jsonSize = head.readUInt32LE(8);
  let jsonStart = 12;
  let json;
  try {
    const b = Buffer.alloc(jsonSize);
    fs.readSync(fd, b, 0, jsonSize, jsonStart);
    json = JSON.parse(b.toString('utf8'));
  } catch (e) {
    // fallback: pickle layout variants
    jsonSize = head.readUInt32LE(4);
    jsonStart = 8;
    const b = Buffer.alloc(jsonSize);
    fs.readSync(fd, b, 0, jsonSize, jsonStart);
    json = JSON.parse(b.toString('utf8'));
  }
  fs.closeSync(fd);
  return { header: json, base: jsonStart + jsonSize };
}

function walk(node, prefix, out) {
  for (const [name, meta] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (meta.files) walk(meta, p, out);
    else out.push({ path: p, size: meta.size || 0, offset: meta.offset, unpacked: !!meta.unpacked });
  }
}

const file = process.argv[2];
const grepIdx = process.argv.indexOf('--grep');
const dumpIdx = process.argv.indexOf('--dump');
const { header, base } = readHeader(file);
const out = [];
walk(header, '', out);

if (grepIdx > 0) {
  const re = new RegExp(process.argv[grepIdx + 1], 'i');
  for (const f of out) if (re.test(f.path) || re.test(f.path)) console.log(f.size + '\t' + f.path);
  process.exit(0);
}

if (dumpIdx > 0) {
  const target = out.find((f) => f.path === process.argv[dumpIdx + 1]);
  if (!target) { console.error('not found'); process.exit(1); }
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(target.size);
  let off = base + parseInt(target.offset, 10);
  fs.readSync(fd, buf, 0, target.size, off);
  fs.closeSync(fd);
  process.stdout.write(buf);
  process.exit(0);
}

out.sort((a, b) => b.size - a.size);
const total = out.reduce((s, f) => s + f.size, 0);
console.log(`# files=${out.length} total=${(total / 1048576).toFixed(1)}MB base=${base}`);
for (const f of out.slice(0, 80)) console.log(f.size + '\t' + f.path);
