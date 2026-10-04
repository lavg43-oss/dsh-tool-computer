// Minimal ASAR reader: extract selected subtrees to disk.
// Usage: node asar-extract.js <archive> <outRoot> [prefix...]
const fs = require('fs');
const path = require('path');

const archive = process.argv[2];
const outRoot = process.argv[3];
const prefixes = process.argv.slice(4);

const fd = fs.openSync(archive, 'r');
const head = Buffer.alloc(16);
fs.readSync(fd, head, 0, 16, 0);
// electron asar: [u32 payloadSize][u32 headerStringSize][u32 jsonSize][u32 jsonSize2] then json
const headerSize = head.readUInt32LE(4);
const jsonSize = head.readUInt32LE(8);
const jsonBuf = Buffer.alloc(jsonSize);
fs.readSync(fd, jsonBuf, 0, jsonSize, 16);
const raw = jsonBuf.toString('utf8');
const end = raw.lastIndexOf('}');
const header = JSON.parse(raw.slice(0, end + 1));
const dataOffset = 16 + headerSize;

console.log('archive:', archive);
console.log('headerSize:', headerSize, 'jsonSize:', jsonSize, 'dataOffset:', dataOffset);
console.log('top-level:', Object.keys(header.files).join(', '));

let written = 0;
let bytes = 0;
function walk(node, rel) {
  if (node.files) {
    for (const [name, child] of Object.entries(node.files)) walk(child, rel ? rel + '/' + name : name);
    return;
  }
  if (!prefixes.length || prefixes.some((p) => rel === p || rel.startsWith(p))) {
    const dest = path.join(outRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const buf = Buffer.alloc(Number(node.size));
    fs.readSync(fd, buf, 0, Number(node.size), dataOffset + Number(node.offset));
    fs.writeFileSync(dest, buf);
    written++;
    bytes += Number(node.size);
  }
}
walk(header, '');
fs.closeSync(fd);
console.log('files written:', written, 'bytes:', bytes, '->', outRoot);
