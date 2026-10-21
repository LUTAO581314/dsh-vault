// asar reader v2 — locate the JSON header by scanning for '{"files"', then brace-match.
// usage: node asar2.js <asar> list [max]
//        node asar2.js <asar> dump <path> <outfile>
//        node asar2.js <asar> grep <regex>
const fs = require('fs');

function headerInfo(file) {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16);
  fs.readSync(fd, head, 0, 16, 0);
  // chromium Pickle layout:
  //   [0..3] payload size of outer pickle (=4)
  //   [4..7] headerSize  (size of the inner pickle payload)
  //   [8..11] payload size of inner pickle
  //   [12..15] JSON string length
  //   [16..] JSON
  const headerSize = head.readUInt32LE(4);
  const jsonLen = head.readUInt32LE(12);
  const jsonStart = 16;
  const headerEnd = 8 + headerSize;
  const buf = Buffer.alloc(jsonLen);
  fs.readSync(fd, buf, 0, jsonLen, jsonStart);
  fs.closeSync(fd);
  const json = JSON.parse(buf.toString('utf8'));
  return { header: json, headerEnd };
}

function walk(node, prefix, out) {
  for (const [name, meta] of Object.entries(node.files || {})) {
    const p = prefix ? prefix + '/' + name : name;
    if (meta.files) walk(meta, p, out);
    else out.push({ path: p, size: meta.size || 0, offset: meta.offset, unpacked: !!meta.unpacked });
  }
}

const [file, cmd, a, b] = process.argv.slice(2);
const { header, headerEnd } = headerInfo(file);
const files = [];
walk(header, '', files);

if (cmd === 'list') {
  files.sort((x, y) => y.size - x.size);
  const lim = a ? parseInt(a) : 60;
  console.log(`# files=${files.length} headerEnd=${headerEnd}`);
  for (const f of files.slice(0, lim)) console.log(`${f.size}\t${f.path}`);
} else if (cmd === 'grep') {
  const re = new RegExp(a, 'i');
  for (const f of files) if (re.test(f.path)) console.log(`${f.size}\t${f.path}`);
} else if (cmd === 'dump') {
  const t = files.find((f) => f.path === a);
  if (!t) { console.error('not found: ' + a); process.exit(1); }
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.alloc(t.size);
  fs.readSync(fd, buf, 0, t.size, headerEnd + parseInt(t.offset, 10));
  fs.closeSync(fd);
  fs.writeFileSync(b, buf);
  console.log(`dumped ${t.size} bytes -> ${b}`);
}
